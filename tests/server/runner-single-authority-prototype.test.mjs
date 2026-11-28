import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntheticAuthority } from './fixtures/runner-single-authority-prototype.mjs';

const request = (jobId = 'one') => ({ jobId, policyRevision: 'rev1', snapshotDigest: 'snapshot1' });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-authority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'journal');
  return { file, authority: SyntheticAuthority.provision(file) };
}
function deferred() {
  let resolve; const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('close-first is durable and fences delayed and duplicate dispatch', async t => {
  const { file, authority } = setup(t); const events = [];
  assert.equal(authority.closeRequest(request()), 'closed-before-dispatch');
  authority.dispose();
  const reopened = new SyntheticAuthority(file); t.after(() => reopened.dispose());
  assert.equal(await reopened.dispatch(request(), events), 'closed-before-dispatch');
  assert.equal(await reopened.dispatch(request(), events), 'closed-before-dispatch');
  assert.equal(reopened.closeRequest(request()), 'closed-before-dispatch');
  await assert.rejects(reopened.dispatch({...request(), snapshotDigest: 'other'}, events), /mismatch/);
  assert.throws(() => reopened.closeRequest({...request(), policyRevision: 'other'}), /mismatch/);
  assert.deepEqual(events, []);
});

test('stateful jobId accessor is refused without invoking the getter', async t => {
  const { authority } = setup(t); t.after(() => authority.dispose());
  let reads = 0;
  const input = { ...request(), get jobId() { return ++reads <= 3 ? 'one' : 'two'; } };
  assert.throws(() => authority.closeRequest(input), /Invalid synthetic request/);
  await assert.rejects(authority.dispatch(input, []), /Invalid synthetic request/);
  assert.equal(reads, 0);
  assert.equal(authority.closeRequest(request()), 'closed-before-dispatch');
  const events = [];
  assert.equal(await authority.dispatch(request(), events), 'closed-before-dispatch');
  assert.deepEqual(events, []);
});

test('dispatch continuation uses the validated snapshot after caller mutation', async t => {
  const { authority } = setup(t); t.after(() => authority.dispose());
  const input = request(), events = [];
  assert.equal(await authority.dispatch(input, events, async stage => {
    if (stage === 'admitted') { input.jobId = 'two'; input.snapshotDigest = 'changed'; }
  }), 'dispatch-possible');
  assert.deepEqual(events, ['create', 'start']);
  assert.equal(authority.closeRequest(request()), 'dispatch-possible');
  assert.equal(authority.closeRequest(request('two')), 'closed-before-dispatch');
});

test('winner paused after admission can resume after close; duplicates cannot continue', async t => {
  const { file, authority } = setup(t); t.after(() => authority.dispose());
  const second = new SyntheticAuthority(file); t.after(() => second.dispose());
  const entered = deferred(), release = deferred(), events = [];
  const winner = authority.dispatch(request(), events, async stage => {
    if (stage === 'admitted') { entered.resolve(); await release.promise; }
  });
  await entered.promise;
  assert.equal(second.closeRequest(request()), 'dispatch-possible');
  assert.equal(await second.dispatch(request(), events), 'dispatch-possible');
  await assert.rejects(second.dispatch(request('two'), events), /barrier/);
  assert.equal(second.closeRequest(request('two')), 'closed-before-dispatch');
  release.resolve(); assert.equal(await winner, 'dispatch-possible');
  assert.deepEqual(events, ['create', 'start']);
});

test('interruption at every synthetic continuation stage is never replayed on reopen', async t => {
  for (const point of ['admitted', 'create-intent', 'created', 'start-intent', 'started']) {
    await t.test(point, async t => {
      const { file, authority } = setup(t); const events = [];
      await assert.rejects(authority.dispatch(request(), events, async stage => { if (stage === point) throw Error('crash'); }), /crash/);
      authority.dispose();
      const reopened = new SyntheticAuthority(file); t.after(() => reopened.dispose());
      const before = [...events];
      assert.equal(reopened.closeRequest(request()), 'dispatch-possible');
      assert.equal(await reopened.dispatch(request(), events), 'dispatch-possible');
      await assert.rejects(reopened.dispatch(request('two'), events), /barrier/);
      assert.deepEqual(events, before);
      assert.deepEqual(events, point === 'admitted' || point === 'create-intent' ? [] : point === 'created' || point === 'start-intent' ? ['create'] : ['create', 'start']);
    });
  }
});

import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('./fixtures/runner-single-authority-worker.mjs', import.meta.url));
function spawnWorker(t, file, mode, point = '') {
  const child = fork(worker, [file, mode, point], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  });
  return child;
}

test('cross-process delayed dispatch sees close after journal reopen', async t => {
  const { file, authority } = setup(t); t.after(() => authority.dispose());
  const child = spawnWorker(t, file, 'delay');
  assert.equal((await once(child, 'message'))[0], 'ready');
  assert.equal(authority.closeRequest(request()), 'closed-before-dispatch');
  const reply = once(child, 'message'); child.send('continue');
  assert.deepEqual((await reply)[0], { result: 'closed-before-dispatch', events: [] });
  await once(child, 'exit');
});

test('process death after durable admission and around synthetic effects never replays', async t => {
  for (const point of ['admitted', 'create-intent', 'created', 'start-intent', 'started']) {
    await t.test(point, async t => {
      const { file, authority } = setup(t); authority.dispose();
      const child = spawnWorker(t, file, 'dispatch', point);
      const [observed] = await once(child, 'message');
      assert.equal(observed.stage, point);
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      const reopened = new SyntheticAuthority(file); t.after(() => reopened.dispose());
      const replay = [];
      assert.equal(reopened.closeRequest(request()), 'dispatch-possible');
      assert.equal(await reopened.dispatch(request(), replay), 'dispatch-possible');
      assert.deepEqual(replay, []);
      await assert.rejects(reopened.dispatch(request('two'), replay), /barrier/);
    });
  }
});
