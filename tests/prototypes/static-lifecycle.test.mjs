import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StaticLifecycleExperiment } from '../../prototypes/static-lifecycle.mjs';

const artifact = 'a'.repeat(64), active = 'b'.repeat(64), targetDigest = 'c'.repeat(64);
const input = { operation: 'op1', resource: 'synthetic-root', target: 'target', revision: 1, targetDigest, artifact, active, generation: 4 };
const target = () => ({ target: 'target', revision: 1, targetDigest, resource: 'synthetic-root' });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'static-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store.sqlite');
}
function fake() {
  const calls = [];
  return { calls, async stage(b) { calls.push('stage'); return { operation: b.operation, fingerprint: b.fingerprint, artifact: b.artifact }; },
    async activate(b) { calls.push('activate'); assert.equal(b.active, active); assert.equal(b.generation, 4); return { operation: b.operation, fingerprint: b.fingerprint, active: b.artifact, generation: 5 }; } };
}
test('exact binding, unique operation and permanent resource arbitration survive reopen', async (t) => {
  const path = fixture(t), helper = fake();
  let store = new StaticLifecycleExperiment(path, helper, target);
  assert.equal(await store.run(input), 'activated');
  assert.equal(JSON.parse(store.inspect('op1').binding).artifact, artifact);
  store.close(); store = new StaticLifecycleExperiment(path, helper, target);
  await assert.rejects(store.run({ ...input, operation: 'op2' }));
  await assert.rejects(store.run({ ...input, resource: 'other' }));
  assert.deepEqual(helper.calls, ['stage', 'activate']); store.close();
});
test('lost effect reply stays uncertain across reopen; no replay or rollback', async (t) => {
  const path = fixture(t), helper = fake(); let effects = 0;
  helper.activate = async () => { effects++; throw new Error('lost reply'); };
  let store = new StaticLifecycleExperiment(path, helper, target);
  assert.equal(await store.run(input), 'activate-unknown'); store.close();
  store = new StaticLifecycleExperiment(path, helper, target);
  assert.equal(store.inspect('op1').state, 'activate-unknown');
  await assert.rejects(store.run(input)); await assert.rejects(store.run({ ...input, operation: 'op2' }));
  assert.equal(effects, 1); store.close();
});
test('target revision change after stage cannot activate', async (t) => {
  const path = fixture(t), helper = fake(); let revision = 1;
  helper.stage = async (b) => { revision++; return { operation: b.operation, fingerprint: b.fingerprint, artifact: b.artifact }; };
  const store = new StaticLifecycleExperiment(path, helper, () => ({ ...target(), revision }));
  assert.equal(await store.run(input), 'staged-target-changed');
  assert.deepEqual(helper.calls, []); store.close();
});
test('malformed stage and activation receipts remain uncertain', async (t) => {
  const path = fixture(t), helper = fake(); helper.stage = async () => ({});
  let store = new StaticLifecycleExperiment(path, helper, target);
  assert.equal(await store.run(input), 'stage-unknown'); store.close();
  const helper2 = fake(); helper2.activate = async () => ({ active: artifact });
  store = new StaticLifecycleExperiment(path, helper2, () => ({ ...target(), resource: 'another' }));
  assert.equal(await store.run({ ...input, resource: 'another', operation: 'op2' }), 'activate-unknown'); store.close();
});
test('two independent connections cannot dispatch for one resource concurrently', async (t) => {
  const path = fixture(t), helper = fake(); let release;
  helper.stage = (b) => new Promise(resolve => { release = () => resolve({ operation: b.operation, fingerprint: b.fingerprint, artifact: b.artifact }); });
  const one = new StaticLifecycleExperiment(path, helper, target), two = new StaticLifecycleExperiment(path, helper, target);
  const first = one.run(input);
  await assert.rejects(two.run({ ...input, operation: 'op2' }));
  release(); assert.equal(await first, 'activated'); one.close(); two.close();
});

test('stale synthetic active state cannot activate and is not retried', async (t) => {
  const path = fixture(t), helper = fake(); let attempts = 0;
  helper.activate = async (b) => {
    attempts++;
    const observedActive = 'd'.repeat(64);
    if (b.active !== observedActive) throw new Error('fake CAS conflict');
    throw new Error('unexpected effect');
  };
  const store = new StaticLifecycleExperiment(path, helper, target);
  assert.equal(await store.run(input), 'activate-unknown');
  await assert.rejects(store.run({ ...input, operation: 'op2' }));
  assert.equal(attempts, 1); store.close();
});
test('invalid binding and target swap refuse before fake effects', async (t) => {
  const path = fixture(t), helper = fake();
  const store = new StaticLifecycleExperiment(path, helper, () => ({ ...target(), targetDigest: 'd'.repeat(64) }));
  await assert.rejects(store.run({ ...input, artifact: 'not-a-digest' }));
  assert.equal(await store.run(input), 'refused');
  assert.deepEqual(helper.calls, []); store.close();
});

test('generation requires a safe integer successor', async (t) => {
  const path = fixture(t), helper = fake();
  const store = new StaticLifecycleExperiment(path, helper, target);
  await assert.rejects(store.run({ ...input, generation: Number.MAX_SAFE_INTEGER }), /invalid binding/);
  assert.equal(store.inspect('op1'), undefined);
  helper.activate = async (b) => ({ operation: b.operation, fingerprint: b.fingerprint,
    active: b.artifact, generation: b.generation + 1 });
  assert.equal(await store.run({ ...input, generation: Number.MAX_SAFE_INTEGER - 1 }), 'activated');
  store.close();
});

test('stateful synthetic CAS changes active and generation only on a match', async (t) => {
  const path = fixture(t);
  let state = { active, generation: 4 };
  const helper = {
    async stage(b) { return { operation: b.operation, fingerprint: b.fingerprint, artifact: b.artifact }; },
    async activate(b) {
      if (state.active !== b.active || state.generation !== b.generation) throw new Error('CAS conflict');
      state = { active: b.artifact, generation: b.generation + 1 };
      return { operation: b.operation, fingerprint: b.fingerprint, ...state };
    }
  };
  let resource = input.resource;
  const store = new StaticLifecycleExperiment(path, helper, () => ({ ...target(), resource }));
  assert.equal(await store.run(input), 'activated');
  assert.deepEqual(state, { active: artifact, generation: 5 });
  resource = 'other';
  assert.equal(await store.run({ ...input, operation: 'op2', resource }), 'activate-unknown');
  assert.deepEqual(state, { active: artifact, generation: 5 });
  store.close();
});

function child(t, path, effects, operation, gate) {
  const proc = fork(fileURLToPath(new URL('./fixtures/static-lifecycle-child.mjs', import.meta.url)),
    [path, effects, operation, gate], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', pending, queue = [];
  proc.stderr.setEncoding('utf8'); proc.stderr.on('data', data => { stderr += data; });
  proc.on('message', message => { if (pending) { const resolve = pending; pending = undefined; resolve(message); } else queue.push(message); });
  const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
  proc.on('error', error => { stderr += error.message; });
  const next = async () => {
    let timer;
    try {
      return await Promise.race([
        queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { pending = resolve; }),
        exited.then(result => { throw new Error(`child exited early ${JSON.stringify(result)}: ${stderr}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`child message deadline: ${stderr}`)), 5000); })
      ]);
    } finally { clearTimeout(timer); }
  };
  const reap = async () => {
    let timer;
    try { return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('child exit deadline')), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await reap(); });
  return { proc, next, reap };
}

test('independent processes contend for the same resource before either stage completes', async (t) => {
  const path = fixture(t), effects = `${path}.effects`;
  // Initialize schema before the race; both processes then wait at the same start gate.
  new StaticLifecycleExperiment(path, fake(), target).close();
  const a = child(t, path, effects, 'op1', 'stage'), b = child(t, path, effects, 'op2', 'stage');
  assert.deepEqual(await Promise.all([a.next(), b.next()]), ['ready', 'ready']);
  a.proc.send('go'); b.proc.send('go');
  const results = await Promise.all([a.next(), b.next()]);
  assert.equal(results.filter(x => x === 'stage-effect').length, 1);
  assert.equal(results.filter(x => typeof x === 'object').length, 1);
  const loser = results.find(x => typeof x === 'object');
  assert.match(loser.error, /UNIQUE constraint failed/);
  const winner = results[0] === 'stage-effect' ? a : b;
  winner.proc.send('continue');
  assert.deepEqual(await winner.next(), { result: 'activated' });
  assert.equal((await a.reap()).code, 0); assert.equal((await b.reap()).code, 0);
  assert.deepEqual(readFileSync(effects, 'utf8').trim().split('\n').map(line => line.split(':')[1]), ['stage', 'activate']);
});

for (const phase of ['stage', 'activate']) {
  test(`kill after synthetic ${phase} effect preserves unknown state and barrier on reopen`, async (t) => {
    const path = fixture(t), effects = `${path}.effects`;
    const worker = child(t, path, effects, 'op1', phase);
    assert.equal(await worker.next(), 'ready'); worker.proc.send('go');
    assert.equal(await worker.next(), `${phase}-effect`);
    worker.proc.kill('SIGKILL');
    assert.equal((await worker.reap()).signal, 'SIGKILL');
    const helper = fake(), store = new StaticLifecycleExperiment(path, helper, target);
    assert.equal(store.inspect('op1').state, `${phase}-unknown`);
    await assert.rejects(store.run(input));
    await assert.rejects(store.run({ ...input, operation: 'op2' }));
    assert.deepEqual(helper.calls, []);
    assert.deepEqual(readFileSync(effects, 'utf8').trim().split('\n'),
      phase === 'stage' ? ['op1:stage'] : ['op1:stage', 'op1:activate']);
    store.close();
  });
}
