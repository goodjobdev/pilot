import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnchorModel, FakeAuthority } from '../../prototypes/runner-external-anchor-model.mjs';

function setup() { const authority = new FakeAuthority(); const model = new AnchorModel(authority, 'runner'); model.provision(); model.ownerEnable({ syntheticPredecessorFenced: true }); return { authority, model }; }
function gate() { let release, entered; return { wait: new Promise(r => entered = r), release: () => release(), pause: () => { entered(); return new Promise(r => release = r); } }; }

test('provision is separate, single-use, and interruptions preserve evidence', () => {
  for (const point of ['after-journal', 'after-allocation']) {
    const authority = new FakeAuthority(), model = new AnchorModel(authority, 'r');
    assert.throws(() => model.provision({ interrupt: point }));
    assert.throws(() => model.provision());
    assert.equal(model.inspect().matches, point === 'after-allocation');
    assert.equal(authority.audit.length, point === 'after-allocation' ? 1 : 0);
    assert.throws(() => model.ownerEnable());
  }
  const authority = new FakeAuthority(), model = new AnchorModel(authority, 'r');
  authority.readFault = 'unavailable'; assert.throws(() => model.provision()); assert.equal(model.journal, null);
});

test('journal-first faults and unknown CAS outcomes latch closed without events', async () => {
  for (const fault of ['journal-write', 'after-journal', 'after-cas', 'cas-before', 'cas-after']) {
    const { authority, model } = setup();
    if (fault.startsWith('cas-')) authority.casFault = fault.slice(4);
    await assert.rejects(model.transition('dispatch', 'a', 'payload', { fault }));
    assert.equal(model.enabled, false); assert.deepEqual(model.events, []);
    assert.equal(model.inspect().matches, ['journal-write', 'after-cas', 'cas-after'].includes(fault));
    await assert.rejects(model.transition('dispatch', 'a', 'payload'));
  }
});

test('restart and inspection never replay dispatch; close retains uncertainty and tombstone', async () => {
  const { model } = setup();
  await model.transition('dispatch', 'a', 'x'); model.restart();
  assert.equal(model.inspect().matches, true); assert.equal(model.events.length, 1);
  model.ownerEnable({ syntheticPredecessorFenced: true });
  assert.equal(await model.transition('dispatch', 'a', 'x'), 'duplicate');
  await model.transition('close', 'a', 'x');
  assert.deepEqual(model.journal.requests[0], { id: 'a', request: 'x', dispatchPossible: true, closed: true });
  assert.equal(await model.transition('dispatch', 'a', 'x'), 'duplicate');
  await assert.rejects(model.transition('dispatch', 'a', 'changed'));
});

test('local rollback mismatches; coordinated rollback is an explicit counterexample', async () => {
  const { authority, model } = setup(); const old = structuredClone(model.journal); const oldRecord = authority.read('runner').record;
  await model.transition('close', 'a', 'x'); model.restart(); model.journal = old;
  assert.equal(model.inspect().matches, false); assert.throws(() => model.ownerEnable({ syntheticPredecessorFenced: true }));
  // Violates the independent non-rollbackable authority assumption.
  authority.records.set('runner', oldRecord);
  assert.equal(model.inspect().matches, true);
});

test('unavailable, invalid or wrong authority observations and invalid journal fail closed', async () => {
  for (const fault of ['unavailable', 'stale', 'malformed', 'unauthorized', 'equivocal']) {
    const { authority, model } = setup(); authority.readFault = fault;
    await assert.rejects(model.transition('dispatch', 'a', 'x')); assert.deepEqual(model.events, []);
  }
  for (const mutation of [m => m.journal = null, m => m.journal.runner = 'other', m => m.journal.epoch = 'other', m => m.journal.sequence++]) {
    const { model } = setup(); mutation(model); await assert.rejects(model.transition('dispatch', 'a', 'x')); assert.deepEqual(model.events, []);
  }
});

test('restart fences a held synthetic transition after a concurrent busy refusal', async () => {
  for (const kind of ['dispatch', 'close']) for (const stage of ['after-journal', 'after-cas']) {
    const { model } = setup(); const barrier = gate();
    const pending = model.transition(kind, 'a', 'x', { pause: s => s === stage ? barrier.pause() : undefined });
    await barrier.wait; await assert.rejects(model.transition('close', 'b', 'x'));
    model.restart(); barrier.release(); await assert.rejects(pending, /continuation-fenced/);
    assert.deepEqual(model.events, []); assert.equal(model.inspect().matches, stage === 'after-cas');
  }
});

test('busy rejection alone does not stop a held transition', async () => {
  const { model } = setup(); const barrier = gate();
  const pending = model.transition('dispatch', 'a', 'x', { pause: s => s === 'after-cas' ? barrier.pause() : undefined });
  await barrier.wait;
  await assert.rejects(model.transition('close', 'b', 'x'), /closed/);
  barrier.release();
  assert.equal(await pending, 'committed');
  assert.deepEqual(model.events, [{ kind: 'dispatch', id: 'a' }]);
});

test('authority rejects competing successors and identity or sequence changes', () => {
  const { authority, model } = setup(); const a = authority.read('runner').record;
  const b = { ...a, sequence: a.sequence + 1, digest: 'successor' };
  assert.throws(() => authority.cas('runner', a, { ...b, runner: 'other' }));
  assert.throws(() => authority.cas('runner', a, { ...b, sequence: a.sequence + 2 }));
  authority.cas('runner', a, b);
  assert.throws(() => authority.cas('runner', a, { ...b, digest: 'competitor' }));
  assert.equal(model.inspect().matches, false);
});

test('a mismatched authority record never authorizes a transition', async () => {
  for (const change of [r => r.runner = 'other', r => r.epoch = 'other', r => r.sequence++, r => r.digest = 'wrong']) {
    const { authority, model } = setup(); change(authority.records.get('runner'));
    await assert.rejects(model.transition('close', 'a', 'x')); assert.deepEqual(model.events, []);
  }
});
