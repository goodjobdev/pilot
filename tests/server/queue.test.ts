import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { QueueStore, type QueueDispatchPort, type QueueSubmissionRecord } from '../../src/server/state/queue-store';
import {
  QUEUE_ATTENTION_DETAILS, QUEUE_ATTENTION_REASONS, QUEUE_MAX_ENTRIES, QUEUE_MAX_IMAGES_PER_ENTRY, QUEUE_MAX_TEXT_LENGTH,
  QUEUE_STATES, QueueError, queueRequestId, validateQueueRecord, type QueueImageRef, type QueueRecord
} from '../../src/shared/queue';

/**
 * The durable queue of pending inputs, its dispatcher claims and its stable submission reconciliation.
 *
 * Everything here runs over a disposable root with its own control store and a **synthetic** ledger:
 * no harness is opened, no provider is contacted and no model call is made. The ledger is the
 * authority on what was submitted, and the port's own idempotency by request identity — the contract
 * the durable harness implements with Pi's conversation-scoped request lookup — is what makes a
 * repeat collapse onto the submission that already exists.
 */

const T0 = Date.parse('2025-01-01T00:00:00.000Z');
const IMAGE: QueueImageRef = Object.freeze({ id: 'a'.repeat(64), mimeType: 'image/png', bytes: 128, width: 8, height: 8 });

type Clock = { now: number };
type PortState = {
  /** A dispatcher that cannot dispatch at all (the harness is off, the project is gone). */
  refusal: Error | null;
  /** A dispatcher that can dispatch, but whose submission itself failed. */
  submitRefusal: Error | null;
  /** The transcript records the submission and then the process goes away before the queue is told. */
  crashAfterWrite: boolean;
  /** The transcript cannot be read back by request identity. */
  lookupFails: boolean;
  /**
   * A submission that is really in flight: the transcript has already recorded it and the call has
   * not returned, which is exactly the window a cancel could race.
   */
  hold: (() => Promise<void>) | null;
};
type Synthetic = {
  readonly port: QueueDispatchPort;
  readonly ledger: Map<string, QueueSubmissionRecord>;
  readonly calls: string[];
  readonly state: PortState;
};
/** A synthetic dispatcher over an in-memory transcript, idempotent by request identity. */
function synthetic(clock: Clock, options: { lookup?: boolean } = {}): Synthetic {
  const ledger = new Map<string, QueueSubmissionRecord>(), calls: string[] = [];
  const state: PortState = { refusal: null, submitRefusal: null, crashAfterWrite: false, lookupFails: false, hold: null };
  const port: QueueDispatchPort = {
    authorise() { calls.push('authorise'); if (state.refusal) throw state.refusal; },
    async submit({ requestId, entryId }) {
      calls.push('submit:' + requestId);
      if (state.refusal) throw state.refusal;
      if (state.submitRefusal) throw state.submitRefusal;
      // A found request identity returns the submission the transcript already holds: this is the
      // contract that makes two attempts at one entry one submission rather than two.
      const existing = ledger.get(requestId);
      if (existing) {
        if (state.hold) await state.hold();
        return existing;
      }
      const record: QueueSubmissionRecord = Object.freeze({ requestId, entryId, submissionId: 'submission-' + (ledger.size + 1), acceptedAt: new Date(clock.now).toISOString() });
      ledger.set(requestId, record);
      if (state.hold) await state.hold();
      if (state.crashAfterWrite) throw new Error('the process went away after the transcript recorded the submission at ' + join(tmpdir(), 'not-a-payload'));
      return record;
    }
  };
  if (options.lookup !== false) {
    port.lookup = async ({ requestId }) => {
      calls.push('lookup:' + requestId);
      if (state.lookupFails) throw new Error('the transcript could not be read');
      return ledger.get(requestId) ?? null;
    };
  }
  return { port, ledger, calls, state };
}

type Fixture = {
  readonly root: string; readonly data: string; readonly control: ControlStore; readonly store: QueueStore;
  readonly clock: Clock; readonly synthetic: Synthetic;
  /** Close the store and open it again on the same root: the process goes away and comes back. */
  reopen(): Promise<void>;
  cleanup(): Promise<void>;
};
async function fixture(options: { lookup?: boolean; leaseMs?: number } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-queue-')), data = join(root, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const clock: Clock = { now: T0 };
  const dispatch = synthetic(clock, { lookup: options.lookup });
  let control = new ControlStore(data);
  let store = new QueueStore(control, dispatch.port, {
    clock: () => new Date(clock.now),
    leaseMs: options.leaseMs ?? 60_000
  });
  return {
    root, data, clock, synthetic: dispatch,
    get control() { return control; },
    get store() { return store; },
    async reopen() {
      control.close();
      control = new ControlStore(data);
      store = new QueueStore(control, dispatch.port, {
        clock: () => new Date(clock.now),
        leaseMs: options.leaseMs ?? 60_000
      });
    },
    async cleanup() { try { control.close(); } catch { /* an already closed store holds nothing */ } await rm(root, { recursive: true, force: true }); }
  };
}
const scopeOf = (f: Fixture) => ({ projectId: randomUUID(), sessionId: randomUUID() });
async function refusal(promise: Promise<unknown>): Promise<QueueError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof QueueError, 'expected a queue refusal, got ' + String(error));
    return error;
  }
  throw new Error('expected a refusal, but the call succeeded');
}
/** The refusal of a port (a dispatcher that cannot dispatch), which is not this application's own. */
async function rawRefusal(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error('expected a refusal, but the call succeeded');
}
/**
 * Let pending tasks run until a condition holds, so a test can observe a submission that is really in
 * flight (the transcript already holds it and the call has not returned) rather than a submission
 * that happens to have finished.
 */
async function until(condition: () => boolean, why: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), why);
}
/** A gate one submission is held inside, so a test can race another operation against it. */
function gateNow(): { hold: () => Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = () => resolve(); });
  return { hold: () => promise, open };
}

/** Append one input and return the entry id, at the revision the store now holds. */
async function append(f: Fixture, scope: { projectId: string; sessionId: string }, text: string): Promise<{ id: string; revision: number }> {
  const before = f.store.read(scope.projectId, scope.sessionId);
  const result = await f.store.append({ ...scope, revision: before.revision, text });
  return { id: result.entry!.id, revision: result.record.revision };
}

test('a queue survives a close and reopen, in order and at its revision', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    // A session whose queue was never written reads at revision 0 with no entries: that is the
    // queue itself, not an absence of one, and it is a real revision to claim.
    const unwritten = f.store.read(scope.projectId, scope.sessionId);
    assert.deepEqual([unwritten.revision, unwritten.entries.length, f.store.has(scope.projectId, scope.sessionId)], [0, 0, false]);

    const first = await append(f, scope, 'first');
    const second = await append(f, scope, 'second');
    const third = await append(f, scope, 'third');
    assert.deepEqual([first.revision, second.revision, third.revision], [1, 2, 3]);
    const edited = await f.store.edit({ ...scope, revision: 3, entryId: second.id, text: 'second, edited' });
    assert.equal(edited.record.revision, 4);
    const reordered = await f.store.reorder({ ...scope, revision: 4, entryId: third.id, position: 0 });
    assert.equal(reordered.record.revision, 5);
    assert.deepEqual(reordered.record.entries.map((entry) => entry.position), [0, 1, 2]);
    assert.deepEqual(reordered.record.entries.map((entry) => entry.text), ['third', 'first', 'second, edited']);
    assert.ok(reordered.record.entries.every((entry) => entry.state === 'queued'));

    await f.reopen();
    const reopened = f.store.read(scope.projectId, scope.sessionId);
    assert.deepEqual(reopened, reordered.record, 'the same order, the same texts and the same revision after a restart');
    assert.deepEqual(reopened.entries.map((entry) => entry.id), [third.id, first.id, second.id]);
    assert.equal(f.store.has(scope.projectId, scope.sessionId), true);
    // A second session has its own queue: nothing here is global.
    assert.equal(f.store.read(scope.projectId, randomUUID()).revision, 0);
  } finally { await f.cleanup(); }
});

test('a stale revision is a conflict that leaves the record exactly as it was', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    const first = await append(f, scope, 'only entry');
    const stale = await refusal(f.store.edit({ ...scope, revision: 0, entryId: first.id, text: 'overwritten' }));
    assert.equal(stale.code, 'CONFLICT');
    assert.match(stale.message, /is at revision 1, not 0/);
    assert.match(stale.message, /the record is unchanged/);
    const current = f.store.read(scope.projectId, scope.sessionId);
    assert.deepEqual([current.revision, current.entries[0].text], [1, 'only entry'], 'the stale write changed nothing');
    // Every revision-checked operation refuses the same way, and none of them writes.
    for (const call of [
      f.store.append({ ...scope, revision: 0, text: 'appended anyway' }),
      f.store.reorder({ ...scope, revision: 0, entryId: first.id, position: 0 }),
      f.store.remove({ ...scope, revision: 0, entryId: first.id }),
      f.store.clear({ ...scope, revision: 0 }),
      f.store.cancel({ ...scope, revision: 0, entryId: first.id })
    ]) {
      const error = await refusal(call);
      assert.equal(error.code, 'CONFLICT');
    }
    assert.deepEqual(f.store.read(scope.projectId, scope.sessionId), current, 'no stale request wrote anything');
  } finally { await f.cleanup(); }
});

test('unknown fields, empty entries, positions outside the queue and illegal transitions all fail closed', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    // An entry with neither text nor an image is not an input.
    const empty = await refusal(f.store.append({ ...scope, revision: 0, text: '' }));
    assert.equal(empty.code, 'INVALID');
    assert.match(empty.message, /needs text or an image/);
    assert.equal(f.store.read(scope.projectId, scope.sessionId).revision, 0, 'a refused append wrote nothing');
    const blank = await refusal(f.store.append({ ...scope, revision: 0 }));
    assert.equal(blank.code, 'INVALID');
    // An unknown field fails closed, on the record and on one entry inside it.
    const one = await append(f, scope, 'one');
    const two = await append(f, scope, 'two');
    const record = f.store.read(scope.projectId, scope.sessionId);
    assert.throws(() => validateQueueRecord({ ...record, surprise: true }), (error: Error) => error instanceof QueueError && error.code === 'INVALID');
    assert.throws(() => validateQueueRecord({ ...record, entries: [{ ...record.entries[0], surprise: true }, record.entries[1]] }), (error: Error) => error instanceof QueueError && error.code === 'INVALID');
    // A position outside the queue, and a position that is not a whole number.
    const outside = await refusal(f.store.reorder({ ...scope, revision: 2, entryId: one.id, position: 5 }));
    assert.equal(outside.code, 'INVALID');
    assert.match(outside.message, /Position 5 is outside the queue/);
    assert.equal((await refusal(f.store.reorder({ ...scope, revision: 2, entryId: one.id, position: 1.5 }))).code, 'INVALID');
    // Positions are the queue's own order: a record that places one outside it is corrupt, not read.
    assert.throws(() => validateQueueRecord({ ...record, entries: [{ ...record.entries[0], position: 3 }, record.entries[1]] }), (error: Error) => error instanceof QueueError);
    assert.throws(() => validateQueueRecord({ ...record, entries: [record.entries[0], { ...record.entries[1], id: record.entries[0].id }] }), (error: Error) => /two entries share the id/.test((error as Error).message));
    // An entry whose claim, submission or attention does not match its own state is corrupt.
    assert.throws(() => validateQueueRecord({ ...record, entries: [{ ...record.entries[0], state: 'queued', claim: { owner: 'dispatcher-1', claimedAt: new Date(T0).toISOString(), leaseExpiresAt: new Date(T0 + 1000).toISOString(), requestId: queueRequestId(one.id) } }, record.entries[1]] }), (error: Error) => /must not carry a claim/.test((error as Error).message));
    assert.throws(() => validateQueueRecord({ ...record, entries: [{ ...record.entries[0], state: 'settled' }, record.entries[1]] }), (error: Error) => /must carry the submission/.test((error as Error).message));
    // The illegal transitions, one by one, each refused with the transition the table does not hold.
    const notClaimed = await refusal(f.store.submit({ ...scope, entryId: one.id, owner: 'dispatcher-1' }));
    assert.equal(notClaimed.code, 'ILLEGAL');
    assert.match(notClaimed.message, /a queued entry can only become claimed, cancelled/);
    assert.equal((await refusal(f.store.release({ ...scope, entryId: one.id, owner: 'dispatcher-1' }))).code, 'ILLEGAL');
    assert.equal((await refusal(f.store.reconcile({ ...scope, entryId: one.id }))).code, 'ILLEGAL');
    const claimed = await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    assert.equal(claimed.entry!.state, 'claimed');
    const editedClaimed = await refusal(f.store.edit({ ...scope, revision: claimed.record.revision, entryId: one.id, text: 'edited while claimed' }));
    assert.equal(editedClaimed.code, 'ILLEGAL');
    assert.match(editedClaimed.message, /Only a queued entry's text can be edited/);
    const removedClaimed = await refusal(f.store.remove({ ...scope, revision: claimed.record.revision, entryId: one.id }));
    assert.equal(removedClaimed.code, 'ILLEGAL');
    assert.match(removedClaimed.message, /release its claim and then cancel it/);
    // A released entry is queued again, and a cancelled entry is terminal.
    const released = await f.store.release({ ...scope, entryId: one.id, owner: 'dispatcher-1' });
    assert.deepEqual([released.entry!.state, released.entry!.claim], ['queued', null]);
    const cancelled = await f.store.cancel({ ...scope, revision: released.record.revision, entryId: one.id });
    assert.equal(cancelled.entry!.state, 'cancelled');
    const terminal = await refusal(f.store.cancel({ ...scope, revision: cancelled.record.revision, entryId: one.id }));
    assert.equal(terminal.code, 'ILLEGAL');
    assert.match(terminal.message, /cancelled is terminal/);
    assert.equal((await refusal(f.store.reconcile({ ...scope, entryId: one.id }))).code, 'ILLEGAL');
    // An entry the queue does not hold is not found, and nothing is written.
    assert.equal((await refusal(f.store.edit({ ...scope, revision: cancelled.record.revision, entryId: randomUUID(), text: 'x' }))).code, 'NOT_FOUND');
    assert.deepEqual(QUEUE_STATES, ['queued', 'claimed', 'submitted', 'settled', 'failed', 'cancelled']);
    void two;
  } finally { await f.cleanup(); }
});

test('two concurrent claims produce exactly one winner, and a live claim is never stolen', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    await append(f, scope, 'first');
    await append(f, scope, 'second');
    // Both dispatchers read the same revision and plan the same claim. Nothing here decides between
    // them: the durable store's own transaction does, and one of them is refused.
    const [left, right] = await Promise.allSettled([
      f.store.claim({ ...scope, owner: 'dispatcher-a' }),
      f.store.claim({ ...scope, owner: 'dispatcher-b' })
    ]);
    const winners = [left, right].filter((result) => result.status === 'fulfilled');
    const losers = [right, left].filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1, 'exactly one claimant won');
    assert.equal(losers.length, 1);
    assert.ok(losers[0].status === 'rejected' && losers[0].reason instanceof QueueError && losers[0].reason.code === 'CONFLICT', 'the loser is refused with a conflict, not a second claim');
    assert.match((losers[0] as PromiseRejectedResult).reason.message, /was already written/);
    const record = f.store.read(scope.projectId, scope.sessionId);
    assert.equal(record.revision, 3, 'the race advanced the queue by exactly one revision');
    assert.equal(record.entries.filter((entry) => entry.state === 'claimed').length, 1, 'exactly one entry is claimed');
    const winner = record.entries.find((entry) => entry.state === 'claimed')!;
    assert.equal(winner.id, record.entries[0].id, 'the claim went to the head entry, in order');
    // A live claim is never stolen, by any other owner, and the refusal names the holder and its lease.
    assert.equal(winner.claim!.requestId, queueRequestId(winner.id), 'the claim records the stable identity it authorises');
    const stolen = await refusal(f.store.claim({ ...scope, owner: 'dispatcher-c' }));
    assert.equal(stolen.code, 'CONFLICT');
    assert.match(stolen.message, new RegExp('claimed by ' + winner.claim!.owner + ' until ' + winner.claim!.leaseExpiresAt));
    assert.match(stolen.message, /a live claim is never stolen/);
    assert.deepEqual(f.store.read(scope.projectId, scope.sessionId), record, 'the refused claim changed nothing');
    // The holder renews its own claim rather than losing it, and the head stays the same entry.
    f.clock.now = T0 + 30_000;
    const renewed = await f.store.claim({ ...scope, owner: winner.claim!.owner });
    assert.equal(renewed.outcome, 'renewed');
    assert.equal(renewed.entry!.id, winner.id);
    assert.equal(renewed.entry!.claim!.claimedAt, winner.claim!.claimedAt, 'a renewal keeps the claim it extends');
    assert.equal(renewed.entry!.claim!.leaseExpiresAt, new Date(T0 + 30_000 + 60_000).toISOString());
    // A claimed head is never skipped over: the second entry waits behind it.
    assert.equal(f.store.read(scope.projectId, scope.sessionId).entries[1].state, 'queued');
  } finally { await f.cleanup(); }
});

test('a claim has one expiry: it is reclaimed once its lease expires and never before', async () => {
  const f = await fixture({ leaseMs: 1_000 });
  try {
    const scope = scopeOf(f);
    const first = await append(f, scope, 'first');
    const claim = await f.store.claim({ ...scope, owner: 'dispatcher-slow' });
    const head = claim.entry!;
    assert.equal(head.claim!.leaseExpiresAt, new Date(T0 + 1_000).toISOString());
    // There is one expiry and no second liveness field: the claim that reached the durable store holds
    // exactly the owner, the instants and the stable request identity it authorises.
    assert.deepEqual(Object.keys(head.claim!).sort(), ['claimedAt', 'leaseExpiresAt', 'owner', 'requestId']);
    assert.equal(head.claim!.requestId, queueRequestId(first.id), 'the claim records the stable identity it authorises');

    // A live lease is the only liveness evidence this build has, and it is enough: the claim is not
    // stolen, and the refusal says what it is based on rather than claiming to know the owner is alive.
    const held = await refusal(f.store.claim({ ...scope, owner: 'dispatcher-next' }));
    assert.equal(held.code, 'CONFLICT');
    assert.match(held.message, new RegExp('until ' + head.claim!.leaseExpiresAt));
    assert.match(held.message, /a live claim is never stolen/);
    assert.match(held.message, /a live lease is the only liveness evidence there is/);
    assert.equal(f.store.read(scope.projectId, scope.sessionId).entries[0].claim!.owner, 'dispatcher-slow');

    // A dispatcher that needs longer renews its own claim: claiming the head again extends the lease
    // without losing the claim it already held.
    f.clock.now = T0 + 700;
    const renewed = await f.store.claim({ ...scope, owner: 'dispatcher-slow' });
    assert.equal(renewed.outcome, 'renewed');
    assert.deepEqual([renewed.entry!.claim!.claimedAt, renewed.entry!.claim!.leaseExpiresAt], [head.claim!.claimedAt, new Date(T0 + 1_700).toISOString()]);

    // Past that lease the claim is reclaimable — and the reclaim asserts nothing about whether the
    // previous owner is gone, which is exactly why the identity, not the claim, is what prevents a
    // second submission.
    f.clock.now = T0 + 2_500;
    const reclaimed = await f.store.claim({ ...scope, owner: 'dispatcher-next' });
    assert.equal(reclaimed.outcome, 'reclaimed');
    assert.equal(reclaimed.entry!.id, first.id);
    assert.deepEqual(
      [reclaimed.entry!.claim!.owner, reclaimed.entry!.claim!.claimedAt, reclaimed.entry!.claim!.requestId],
      ['dispatcher-next', new Date(T0 + 2_500).toISOString(), queueRequestId(first.id)]
    );
  } finally { await f.cleanup(); }
});

test('the claim is durable before the submission, so every crash window accounts for one submission', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    // (1) Interrupted between the claim and the submission: the claim is durable with the intent and
    // the stable request identity, and the transcript holds nothing at all.
    const first = await append(f, scope, 'the input that was never submitted');
    const claim = await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    assert.equal(claim.entry!.state, 'claimed');
    await f.reopen();
    assert.equal(f.synthetic.ledger.size, 0, 'nothing reached the transcript before the process went away');
    const afterRestart = f.store.read(scope.projectId, scope.sessionId).entries[0];
    assert.deepEqual([afterRestart.id, afterRestart.state], [first.id, 'claimed']);
    assert.equal(afterRestart.claim!.requestId, queueRequestId(first.id), 'the durable claim names the identity the submission will be made under');
    assert.equal(afterRestart.text, 'the input that was never submitted', 'the intent is durable in the same record as the claim');
    // Resumed by the same owner under the same identity: renew the claim, then submit.
    const resumed = await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    assert.equal(resumed.outcome, 'renewed');
    f.synthetic.calls.length = 0;
    const submitted = await f.store.submit({ ...scope, entryId: first.id, owner: 'dispatcher-1' });
    assert.deepEqual([submitted.outcome, submitted.entry!.submission!.requestId], ['submitted', queueRequestId(first.id)]);
    assert.deepEqual(f.synthetic.calls.filter((call) => call.startsWith('submit:')), ['submit:' + queueRequestId(first.id)]);
    assert.equal(f.synthetic.ledger.size, 1, 'exactly one submission');
    const settled = await f.store.reconcile({ ...scope, entryId: first.id });
    assert.equal(settled.outcome, 'settled');
    assert.equal(settled.entry!.submission!.submissionId, f.synthetic.ledger.get(queueRequestId(first.id))!.submissionId);
    assert.deepEqual(f.synthetic.calls.filter((call) => call.startsWith('submit:')), ['submit:' + queueRequestId(first.id)], 'the settled entry was never re-sent');

    // (2) The same window, taken over by another dispatcher after the vanished owner's lease expired:
    // the reclaim names the same identity, so the two dispatchers produce one submission, never two,
    // and the entry is never silently lost.
    const second = await append(f, scope, 'the input a second dispatcher took over');
    await f.store.claim({ ...scope, owner: 'dispatcher-gone' });
    await f.reopen();
    f.clock.now = T0 + 90_000;
    const taken = await f.store.claim({ ...scope, owner: 'dispatcher-next' });
    assert.equal(taken.outcome, 'reclaimed');
    assert.equal(taken.entry!.claim!.requestId, queueRequestId(second.id), 'the reclaim names the same identity the original claim recorded');
    await f.store.submit({ ...scope, entryId: second.id, owner: 'dispatcher-next' });
    assert.equal(f.synthetic.ledger.size, 2, 'one submission for the taken-over entry');
    assert.deepEqual([...f.synthetic.ledger.keys()].sort(), [queueRequestId(first.id), queueRequestId(second.id)].sort());
    const takenSettled = await f.store.reconcile({ ...scope, entryId: second.id });
    assert.equal(takenSettled.entry!.submission!.submissionId, f.synthetic.ledger.get(queueRequestId(second.id))!.submissionId);

    // (3) Interrupted in the middle: the transcript wrote the submission and the port never returned.
    // The queue resolves that from the transcript instead of asserting that the dispatcher refused.
    const third = await append(f, scope, 'the input interrupted around the write');
    await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    f.synthetic.calls.length = 0;
    f.synthetic.state.crashAfterWrite = true;
    const interrupted = await rawRefusal(f.store.submit({ ...scope, entryId: third.id, owner: 'dispatcher-1' }));
    f.synthetic.state.crashAfterWrite = false;
    assert.match(interrupted.message, /the process went away after the transcript recorded the submission/);
    assert.equal(f.synthetic.ledger.size, 3, 'the transcript holds exactly one submission for that entry');
    const resolved = f.store.read(scope.projectId, scope.sessionId).entries.find((entry) => entry.id === third.id)!;
    assert.deepEqual(
      [resolved.state, resolved.submission!.submissionId, resolved.attention],
      ['settled', f.synthetic.ledger.get(queueRequestId(third.id))!.submissionId, null],
      'the failure path settled it from the transcript: no operator, no second submission'
    );
    assert.deepEqual(f.synthetic.calls.filter((call) => call.startsWith('submit:')), ['submit:' + queueRequestId(third.id)], 'the port was asked exactly once');
    assert.equal(f.synthetic.calls.filter((call) => call.startsWith('lookup:')).length, 1, 'and the transcript was read back once');

    // (4) The same interruption on an instance that cannot read the transcript back: the entry is an
    // explicit uncertain outcome that needs an operator, and never a claim that nothing was sent.
    const blind = await fixture({ lookup: false });
    try {
      const blindScope = scopeOf(blind);
      const blindEntry = await append(blind, blindScope, 'the input interrupted on an instance that cannot read back');
      await blind.store.claim({ ...blindScope, owner: 'dispatcher-1' });
      blind.synthetic.state.crashAfterWrite = true;
      await assert.rejects(blind.store.submit({ ...blindScope, entryId: blindEntry.id, owner: 'dispatcher-1' }));
      blind.synthetic.state.crashAfterWrite = false;
      const uncertain = blind.store.read(blindScope.projectId, blindScope.sessionId).entries[0];
      assert.deepEqual([uncertain.state, uncertain.attention!.reason], ['failed', 'submission-not-readable']);
      assert.equal(uncertain.attention!.detail, QUEUE_ATTENTION_DETAILS['submission-not-readable']);
      assert.equal(blind.synthetic.ledger.size, 1, 'the submission is in the transcript; only the read-back is missing');
      assert.equal(blind.synthetic.calls.filter((call) => call.startsWith('submit:')).length, 1, 'it was never re-sent');
      const again = await blind.store.reconcile({ ...blindScope, entryId: blindEntry.id });
      assert.deepEqual([again.outcome, again.entry!.attention!.reason], ['attention', 'submission-not-readable']);
      assert.equal(blind.synthetic.ledger.size, 1, 'a reconciliation on a blind instance re-sends nothing');
    } finally { await blind.cleanup(); }

    // (5) Two attempts at one entry under its stable request identity are one submission, even when
    // both reach the transcript: the identity, not the queue's bookkeeping, collapses them.
    const before = f.synthetic.ledger.size;
    const fourth = await append(f, scope, 'the input two dispatchers raced to submit');
    await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    f.synthetic.calls.length = 0;
    const raced = await Promise.allSettled([
      f.store.submit({ ...scope, entryId: fourth.id, owner: 'dispatcher-1' }),
      f.store.submit({ ...scope, entryId: fourth.id, owner: 'dispatcher-1' })
    ]);
    assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1, 'exactly one submit won the queue revision');
    const submitCalls = f.synthetic.calls.filter((call) => call.startsWith('submit:'));
    assert.equal(submitCalls.length, 2, 'both attempts reached the transcript');
    assert.deepEqual([...new Set(submitCalls)], ['submit:' + queueRequestId(fourth.id)], 'and both named the same stable request identity');
    assert.equal(f.synthetic.ledger.size, before + 1, 'the transcript holds one submission for that identity');
    const racedEntry = f.store.read(scope.projectId, scope.sessionId).entries.find((entry) => entry.id === fourth.id)!;
    const reconciledRace = await f.store.reconcile({ ...scope, entryId: fourth.id });
    assert.equal(reconciledRace.outcome, 'settled');
    assert.equal(reconciledRace.entry!.submission!.submissionId, f.synthetic.ledger.get(queueRequestId(fourth.id))!.submissionId);
    assert.equal(racedEntry.state === 'submitted' || racedEntry.state === 'settled', true, 'the loser wrote nothing of its own');
    // An entry needing an operator is not pending: it can never be claimed again.
    const stuck = await refusal(f.store.claim({ ...scope, owner: 'dispatcher-1' }));
    assert.equal(stuck.code, 'ILLEGAL');
    assert.match(stuck.message, /holds no pending input to claim/);
  } finally { await f.cleanup(); }
});

test('an entry in flight stays the effective head, and a reorder can never move a later input ahead of it', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    const first = await append(f, scope, 'the input that goes first');
    const second = await append(f, scope, 'the input that must wait');
    const claimed = await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    assert.deepEqual([claimed.entry!.id, claimed.record.revision], [first.id, 3]);
    const readNow = () => f.store.read(scope.projectId, scope.sessionId);
    // Moving the later input ahead of a claimed entry is refused: it would let later intent dispatch
    // before earlier intent, which is the whole point of claiming the head in order.
    const skip = await refusal(f.store.reorder({ ...scope, revision: 3, entryId: second.id, position: 0 }));
    assert.equal(skip.code, 'ILLEGAL');
    assert.match(skip.message, new RegExp('entry ' + second.id + ' is pending ahead of entry ' + first.id));
    assert.match(skip.message, /effective head until it settles or is explicitly reconciled/);
    assert.deepEqual(readNow().entries.map((entry) => entry.id), [first.id, second.id], 'the refused reorder changed nothing');
    assert.equal(readNow().revision, 3, 'and raised no revision');
    // Moving the in-flight entry itself behind a later input is refused for the same reason.
    const pushedBack = await refusal(f.store.reorder({ ...scope, revision: 3, entryId: first.id, position: 1 }));
    assert.equal(pushedBack.code, 'ILLEGAL');
    assert.match(pushedBack.message, /effective head until it settles or is explicitly reconciled/);
    assert.equal(readNow().revision, 3);
    // A submitted entry is in flight in exactly the same way.
    const submitted = await f.store.submit({ ...scope, entryId: first.id, owner: 'dispatcher-1' });
    assert.equal(submitted.entry!.state, 'submitted');
    const afterSubmit = await refusal(f.store.reorder({ ...scope, revision: submitted.record.revision, entryId: second.id, position: 0 }));
    assert.equal(afterSubmit.code, 'ILLEGAL');
    // The invariant belongs to the durable record, not to the operation: an order that put a pending
    // entry ahead of the in-flight one is refused on the way in and on the way out of storage.
    const record = submitted.record;
    assert.throws(() => validateQueueRecord({
      ...record,
      entries: [{ ...record.entries[1], position: 0 }, { ...record.entries[0], position: 1 }]
    }), (error: Error) => error instanceof QueueError && error.code === 'INVALID' && /effective head until it settles or is explicitly reconciled/.test((error as Error).message));
    assert.throws(() => validateQueueRecord({
      ...record,
      entries: [
        { ...record.entries[0], position: 0 },
        { ...record.entries[1], position: 1, state: 'claimed' as const, claim: Object.freeze({ ...record.entries[0].claim!, requestId: queueRequestId(second.id) }) }
      ]
    }), (error: Error) => error instanceof QueueError && /more than one dispatcher in flight at once/.test((error as Error).message));
    // Once the entry settles it is no longer the effective head, and the order is the owner's again.
    const settled = await f.store.reconcile({ ...scope, entryId: first.id });
    assert.equal(settled.outcome, 'settled');
    const moved = await f.store.reorder({ ...scope, revision: settled.record.revision, entryId: second.id, position: 0 });
    assert.deepEqual([moved.outcome, moved.record.entries.map((entry) => entry.id)], ['reordered', [second.id, first.id]]);
    const backDown = await f.store.reorder({ ...scope, revision: moved.record.revision, entryId: first.id, position: 0 });
    assert.deepEqual(
      [backDown.outcome, backDown.record.entries.map((entry) => entry.id)],
      ['reordered', [first.id, second.id]],
      'a settled entry is never dispatched, so moving it around a pending one is free'
    );
  } finally { await f.cleanup(); }
});

test('a cancel can never make an in-flight submission invisible', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    const readNow = () => f.store.read(scope.projectId, scope.sessionId);
    const entry = await append(f, scope, 'the input a cancel and a submit raced over');
    await append(f, scope, 'the input behind it');
    const claimed = await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    // The submission is really in flight: the transcript already holds it and the call has not returned.
    const gate = gateNow();
    f.synthetic.state.hold = gate.hold;
    f.synthetic.calls.length = 0;
    const inFlight = f.store.submit({ ...scope, entryId: entry.id, owner: 'dispatcher-1' });
    await until(() => f.synthetic.ledger.has(queueRequestId(entry.id)), 'the submission reached the transcript before the cancel was attempted');
    // The cancel races it, and is refused rather than applied: cancelling the entry here would drop the
    // claim and leave the submission in the transcript with nothing that could reconcile it.
    const raced = await refusal(f.store.cancel({ ...scope, revision: claimed.record.revision, entryId: entry.id }));
    assert.equal(raced.code, 'ILLEGAL');
    assert.match(raced.message, /may be in flight under the identity queue:/);
    assert.match(raced.message, /release the claim first/);
    assert.deepEqual([readNow().revision, readNow().entries[0].state], [claimed.record.revision, 'claimed'], 'the refused cancel wrote nothing');
    gate.open();
    f.synthetic.state.hold = null;
    const submitted = await inFlight;
    assert.deepEqual([submitted.outcome, submitted.entry!.state], ['submitted', 'submitted']);
    // A submitted entry cannot be cancelled either, and the refusal names what can happen to it.
    const afterSubmit = await refusal(f.store.cancel({ ...scope, revision: submitted.record.revision, entryId: entry.id }));
    assert.equal(afterSubmit.code, 'ILLEGAL');
    assert.match(afterSubmit.message, /a submitted entry can only become settled, failed/);
    // The durable record accounts for the submission: reconciliation settles it against the
    // transcript's own submission, and exactly one submission exists for that input.
    const settled = await f.store.reconcile({ ...scope, entryId: entry.id });
    assert.equal(settled.outcome, 'settled');
    assert.equal(settled.entry!.submission!.submissionId, f.synthetic.ledger.get(queueRequestId(entry.id))!.submissionId);
    assert.equal(f.synthetic.ledger.size, 1, 'exactly one submission exists for the raced input');
    // Cancelling an entry that is still queued is what a cancel is for.
    const behind = readNow().entries[1];
    const cancelled = await f.store.cancel({ ...scope, revision: settled.record.revision, entryId: behind.id });
    assert.deepEqual([cancelled.entry!.state, cancelled.entry!.claim, cancelled.entry!.submission], ['cancelled', null, null]);

    // The other window one submission can race: a release while the port is holding the submission.
    // The release wins the revision; the submission must not become invisible, so the entry is queued
    // again under the same stable identity and the record still accounts for what was sent.
    const fourth = await append(f, scope, 'the input a release raced a submit over');
    assert.equal(readNow().entries[2].id, fourth.id);
    f.synthetic.calls.length = 0;
    const gate2 = gateNow();
    f.synthetic.state.hold = gate2.hold;
    const claimedAgain = await f.store.claim({ ...scope, owner: 'dispatcher-2' });
    assert.equal(claimedAgain.entry!.id, fourth.id);
    const racing = f.store.submit({ ...scope, entryId: fourth.id, owner: 'dispatcher-2' });
    await until(() => f.synthetic.ledger.has(queueRequestId(fourth.id)), 'the released-over submission reached the transcript');
    const released = await f.store.release({ ...scope, entryId: fourth.id, owner: 'dispatcher-2' });
    assert.equal(released.entry!.state, 'queued', 'the release won the revision');
    gate2.open();
    f.synthetic.state.hold = null;
    const lostRevision = await rawRefusal(racing);
    assert.ok(lostRevision instanceof QueueError && lostRevision.code === 'CONFLICT', 'the raced submission lost the revision to the release');
    assert.match(lostRevision.message, /was already written/);
    const requeued = readNow().entries.find((candidate) => candidate.id === fourth.id)!;
    assert.equal(requeued.state, 'queued', 'the record says the entry is back in the queue, not cancelled and not lost');
    // It is recoverable under the identity it already used: submitting it again is the same submission,
    // and reconciling it settles the entry on what the transcript really holds.
    const reclaimed = await f.store.claim({ ...scope, owner: 'dispatcher-2' });
    assert.equal(reclaimed.entry!.claim!.requestId, queueRequestId(fourth.id), 'the same stable identity: it is derived from the entry id');
    const resubmitted = await f.store.submit({ ...scope, entryId: fourth.id, owner: 'dispatcher-2' });
    assert.equal(resubmitted.entry!.state, 'submitted');
    assert.equal(f.synthetic.ledger.size, 2, 'the transcript holds one submission per entry, never two for one');
    assert.deepEqual([...new Set(f.synthetic.calls.filter((call) => call.startsWith('submit:')))], ['submit:' + queueRequestId(fourth.id)], 'both attempts named the same identity');
    const settledAgain = await f.store.reconcile({ ...scope, entryId: fourth.id });
    assert.equal(settledAgain.outcome, 'settled');
    assert.equal(settledAgain.entry!.submission!.submissionId, f.synthetic.ledger.get(queueRequestId(fourth.id))!.submissionId, 'the durable record accounts for the submission that was already made');
    assert.equal(f.synthetic.calls.filter((call) => call.startsWith('submit:')).length, 2, 'the settled entry was not submitted again');
  } finally { await f.cleanup(); }
});

test('a submission the transcript does not match becomes operator attention, and is never re-sent', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    // The closed set holds no refusal at all: a refused submission and one interrupted around the
    // transcript write cannot be told apart from the queue's side, so no reason may name one, and each
    // reason states which durable record it is based on.
    assert.deepEqual(QUEUE_ATTENTION_REASONS, ['submission-absent', 'submission-mismatched', 'submission-not-readable']);
    for (const reason of QUEUE_ATTENTION_REASONS) {
      assert.ok(!/refus/i.test(reason), reason + ' names a refusal the queue cannot establish');
      assert.match(QUEUE_ATTENTION_DETAILS[reason], /transcript/, reason + ' says which durable record it is based on');
    }
    const entry = await append(f, scope, 'an input whose submission the transcript attributes elsewhere');
    await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    const submitted = await f.store.submit({ ...scope, entryId: entry.id, owner: 'dispatcher-1' });
    assert.deepEqual([submitted.outcome, submitted.entry!.state], ['submitted', 'submitted']);
    assert.equal(submitted.entry!.claim!.owner, 'dispatcher-1', 'a submitted entry keeps the claim that dispatched it');
    assert.equal(f.synthetic.ledger.size, 1);
    // The transcript answers for that request identity with a submission that is not this entry's.
    const requestId = queueRequestId(entry.id);
    f.synthetic.ledger.set(requestId, Object.freeze({ ...f.synthetic.ledger.get(requestId)!, entryId: 'some-other-entry' }));
    f.synthetic.calls.length = 0;
    const mismatched = await f.store.reconcile({ ...scope, entryId: entry.id });
    assert.deepEqual([mismatched.outcome, mismatched.entry!.state, mismatched.entry!.attention!.reason], ['attention', 'failed', 'submission-mismatched']);
    assert.equal(mismatched.entry!.attention!.detail, QUEUE_ATTENTION_DETAILS['submission-mismatched']);
    assert.deepEqual(f.synthetic.calls.filter((call) => call.startsWith('submit:')), [], 'a mismatch is never re-sent');
    assert.equal(f.synthetic.ledger.size, 1, 'and the transcript is never overwritten');
    assert.ok(!JSON.stringify(mismatched).includes(f.root), 'no payload carries a filesystem path');
    // A submission the transcript holds under the same identity, but with a different submission id
    // than the one the port reported, is a mismatch too: the queue does not overwrite either record.
    f.synthetic.ledger.set(requestId, Object.freeze({ ...f.synthetic.ledger.get(requestId)!, entryId: entry.id, submissionId: 'submission-somewhere-else' }));
    const second = await f.store.reconcile({ ...scope, entryId: entry.id });
    assert.equal(second.entry!.attention!.reason, 'submission-mismatched');
    // A transcript that cannot be read is its own answer, never an absence and never a re-send.
    f.synthetic.state.lookupFails = true;
    const unreadable = await f.store.reconcile({ ...scope, entryId: entry.id });
    assert.deepEqual([unreadable.outcome, unreadable.entry!.attention!.reason], ['attention', 'submission-not-readable']);
    assert.equal(unreadable.entry!.attention!.detail, QUEUE_ATTENTION_DETAILS['submission-not-readable']);
    f.synthetic.state.lookupFails = false;
    // An instance with no read-back at all says so by name rather than guessing.
    const blind = await fixture({ lookup: false });
    try {
      const blindScope = scopeOf(blind);
      const blindEntry = await append(blind, blindScope, 'an input on an instance that cannot read back');
      await blind.store.claim({ ...blindScope, owner: 'dispatcher-1' });
      await blind.store.submit({ ...blindScope, entryId: blindEntry.id, owner: 'dispatcher-1' });
      const blindResult = await blind.store.reconcile({ ...blindScope, entryId: blindEntry.id });
      assert.deepEqual([blindResult.outcome, blindResult.entry!.attention!.reason], ['attention', 'submission-not-readable']);
      assert.equal(blind.synthetic.ledger.size, 1, 'the submission is recorded; only the read-back is missing');
      // A matched submission settles the entry, which is the one outcome the queue may call settled.
      const readable = await f.store.reconcile({ ...scope, entryId: entry.id });
      assert.equal(readable.outcome, 'attention', 'the transcript still holds a mismatched record');
    } finally { await blind.cleanup(); }
  } finally { await f.cleanup(); }
});

test('a settled entry settles on a match, and a cancelled or settled entry never dispatches again', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    const cancelled = await append(f, scope, 'the input the owner withdrew');
    const kept = await append(f, scope, 'the input that really runs');
    const withdrawal = await f.store.cancel({ ...scope, revision: 2, entryId: cancelled.id });
    assert.equal(withdrawal.entry!.state, 'cancelled');
    // A cancelled entry is not part of the pending order, so the head moves to the entry behind it.
    const claimed = await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    assert.equal(claimed.entry!.id, kept.id, 'a cancelled entry never dispatches');
    assert.equal(claimed.entry!.state, 'claimed');
    const submitted = await f.store.submit({ ...scope, entryId: kept.id, owner: 'dispatcher-1' });
    assert.equal(submitted.entry!.state, 'submitted');
    const settled = await f.store.reconcile({ ...scope, entryId: kept.id });
    assert.equal(settled.outcome, 'settled');
    assert.equal(settled.entry!.state, 'settled');
    // A settled entry is terminal and is never re-dispatched: there is nothing left to claim.
    f.synthetic.calls.length = 0;
    const nothing = await refusal(f.store.claim({ ...scope, owner: 'dispatcher-2' }));
    assert.equal(nothing.code, 'ILLEGAL');
    assert.match(nothing.message, /holds no pending input to claim/);
    assert.deepEqual(f.synthetic.calls, [], 'nothing was authorised and nothing was submitted');
    assert.equal((await refusal(f.store.submit({ ...scope, entryId: kept.id, owner: 'dispatcher-1' }))).code, 'ILLEGAL');
    assert.equal((await refusal(f.store.cancel({ ...scope, revision: settled.record.revision, entryId: kept.id }))).code, 'ILLEGAL');
    // Clearing removes exactly the finished entries, and clearing nothing is a legal no-op.
    const cleared = await f.store.clear({ ...scope, revision: settled.record.revision });
    assert.deepEqual([cleared.outcome, cleared.removed, cleared.record.entries.map((entry) => entry.state)], ['cleared', 1, ['cancelled']], 'the settled entry is cleared; a cancelled one is not settled or failed');
    const again = await f.store.clear({ ...scope, revision: cleared.record.revision });
    assert.deepEqual([again.changed, again.outcome, again.record.revision], [false, 'unchanged', cleared.record.revision], 'clearing nothing writes nothing and raises no revision');
    // Removing a cancelled entry is allowed; removing a settled one is not, and neither is removing a
    // claimed one.
    const removed = await f.store.remove({ ...scope, revision: again.record.revision, entryId: cancelled.id });
    assert.deepEqual([removed.outcome, removed.removed, removed.record.entries.length], ['removed', 1, 0]);
  } finally { await f.cleanup(); }
});

test('the queue stays inside its documented bounds, and refuses what would leave them', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    // The count bound, reached with small entries so the byte bound is not what bites first.
    for (let index = 0; index < QUEUE_MAX_ENTRIES; index++) {
      const current = f.store.read(scope.projectId, scope.sessionId);
      const result = await f.store.append({ ...scope, revision: current.revision, text: 'entry ' + index });
      assert.equal(result.record.revision, index + 1);
    }
    const full = f.store.read(scope.projectId, scope.sessionId);
    assert.equal(full.entries.length, QUEUE_MAX_ENTRIES);
    const overfull = await refusal(f.store.append({ ...scope, revision: full.revision, text: 'one too many' }));
    assert.equal(overfull.code, 'BOUNDED');
    assert.match(overfull.message, new RegExp('documented maximum of ' + QUEUE_MAX_ENTRIES + ' entries'));
    assert.deepEqual(f.store.read(scope.projectId, scope.sessionId), full, 'the refused append changed nothing');
    // More images than one entry may carry.
    const tooManyImages = await refusal(f.store.append({ ...scope, revision: full.revision, images: Array.from({ length: QUEUE_MAX_IMAGES_PER_ENTRY + 1 }, () => IMAGE) }));
    assert.equal(tooManyImages.code, 'INVALID');
    // Text over the documented length, and text that is not printable.
    assert.equal((await refusal(f.store.append({ ...scope, revision: full.revision, text: 'x'.repeat(QUEUE_MAX_TEXT_LENGTH + 1) }))).code, 'INVALID');
    assert.equal((await refusal(f.store.append({ ...scope, revision: full.revision, text: 'line\u0000break' }))).code, 'INVALID');
    assert.deepEqual(f.store.read(scope.projectId, scope.sessionId), full);
  } finally { await f.cleanup(); }

  // The byte bound: a record that would leave the store's own 64 KiB payload cap is refused before it
  // is written, so the queue can never grow past what the store can hold.
  const long = await fixture();
  try {
    const scope = scopeOf(long);
    let accepted = 0;
    let refusalError: QueueError | null = null;
    for (let index = 0; index < QUEUE_MAX_ENTRIES; index++) {
      const current = long.store.read(scope.projectId, scope.sessionId);
      try {
        await long.store.append({ ...scope, revision: current.revision, text: 'y'.repeat(QUEUE_MAX_TEXT_LENGTH) });
        accepted += 1;
      } catch (error) {
        refusalError = error as QueueError;
        break;
      }
    }
    assert.ok(refusalError !== null, 'the byte bound refused an append');
    assert.equal(refusalError!.code, 'BOUNDED');
    assert.match(refusalError!.message, /exceeds the documented \d+ byte bound/);
    assert.ok(accepted < QUEUE_MAX_ENTRIES, 'the byte bound bit before the entry bound: ' + accepted + ' entries');
    const record: QueueRecord = long.store.read(scope.projectId, scope.sessionId);
    assert.equal(record.entries.length, accepted);
    assert.equal(record.revision, accepted, 'the refused append raised no revision');
    // An entry with an image reference is accepted, and the reference is the stored facts, not a path.
    const withImage = await long.store.append({ ...scope, revision: record.revision, images: [IMAGE] });
    assert.deepEqual([withImage.entry!.text, withImage.entry!.images], ['', [IMAGE]]);
    assert.equal(withImage.entry!.images[0].mimeType, 'image/png');
  } finally { await long.cleanup(); }
});

test('a claim on an instance that cannot dispatch is refused before anything is claimed', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    const entry = await append(f, scope, 'the input nobody can dispatch');
    f.synthetic.state.refusal = new Error('Agents are disabled on this instance');
    const refused = await rawRefusal(f.store.claim({ ...scope, owner: 'dispatcher-1' }));
    assert.ok(!(refused instanceof QueueError), 'the port refusal is not a queue refusal');
    assert.match(refused.message, /Agents are disabled/);
    assert.deepEqual([f.store.read(scope.projectId, scope.sessionId).revision, f.store.read(scope.projectId, scope.sessionId).entries[0].state], [1, 'queued'], 'a refused claim claimed no revision');
    assert.equal(f.synthetic.calls.filter((call) => call === 'authorise').length, 1);
    f.synthetic.state.refusal = null;
    const claimed = await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    // The same before a submission: a dispatcher that cannot dispatch refuses before anything is
    // written, and the entry stays claimed so a dispatcher that can dispatch may still take it.
    f.synthetic.state.refusal = new Error('Agents are disabled on this instance');
    assert.equal(claimed.entry!.id, entry.id);
    const refusedSubmit = await rawRefusal(f.store.submit({ ...scope, entryId: entry.id, owner: 'dispatcher-1' }));
    assert.match(refusedSubmit.message, /Agents are disabled/);
    assert.deepEqual([f.store.read(scope.projectId, scope.sessionId).entries[0].state, f.synthetic.ledger.size], ['claimed', 0], 'a refused dispatch wrote nothing');
    // A port that can dispatch but whose submission fails leaves the entry needing an operator, with
    // fixed path-free text, and the port's own refusal is what the caller sees.
    f.synthetic.state.refusal = null;
    f.synthetic.state.submitRefusal = new Error('the provider is unreachable at /Users/private/keys');
    const submitRefusal = await rawRefusal(f.store.submit({ ...scope, entryId: entry.id, owner: 'dispatcher-1' }));
    assert.match(submitRefusal.message, /provider is unreachable/);
    // What the queue records is what the durable transcript can be shown to hold — here, that it was
    // read back and holds nothing under the entry's identity. It never asserts that the dispatcher
    // refused, because a refusal and an interrupted submission are the same thing from this side.
    const attention = f.store.read(scope.projectId, scope.sessionId).entries[0];
    assert.deepEqual([attention.state, attention.attention!.reason], ['failed', 'submission-absent']);
    assert.equal(attention.attention!.detail, QUEUE_ATTENTION_DETAILS['submission-absent']);
    assert.ok(!JSON.stringify(attention).includes('/Users/private'), 'a dispatcher error is never stored');
    assert.equal(f.synthetic.ledger.size, 0, 'a refused submission recorded no submission');
    assert.equal(f.synthetic.calls.filter((call) => call.startsWith('submit:')).length, 1, 'the port was asked exactly once');
    assert.equal(f.synthetic.calls.filter((call) => call.startsWith('lookup:')).length, 1, 'the transcript was read back once, and only after the port did not report a submission');
  } finally { await f.cleanup(); }
});

test('a stored claim that names another submission, and a port that answers for another entry, are both faults', async () => {
  const f = await fixture();
  try {
    const scope = scopeOf(f);
    // The durable record is the second line of defence: a claim whose recorded identity is not its own
    // entry's is corrupt, so a stored claim can never name a second submission.
    const one = await append(f, scope, 'the input whose claim was tampered with');
    const stored = f.store.read(scope.projectId, scope.sessionId);
    const claimedRecord = {
      ...stored,
      revision: 2,
      entries: [{
        ...stored.entries[0],
        state: 'claimed' as const,
        claim: Object.freeze({ owner: 'dispatcher-1', claimedAt: new Date(T0).toISOString(), leaseExpiresAt: new Date(T0 + 60_000).toISOString(), requestId: 'queue:another-entry' })
      }]
    };
    assert.throws(() => validateQueueRecord(claimedRecord), (error: Error) => error instanceof QueueError && error.code === 'INVALID' && /a claim that named another submission could submit the input twice/.test((error as Error).message));
    // A port that reports a submission under some other request identity is a fault, not a submission:
    // nothing is recorded and the entry stays claimed for reconciliation.
    assert.equal(stored.entries[0].id, one.id);
    await f.store.claim({ ...scope, owner: 'dispatcher-1' });
    f.synthetic.ledger.set(queueRequestId(one.id), Object.freeze({ requestId: 'queue:someone-else', entryId: one.id, submissionId: 'submission-x', acceptedAt: new Date(T0).toISOString() }));
    const confused = await refusal(f.store.submit({ ...scope, entryId: one.id, owner: 'dispatcher-1' }));
    assert.equal(confused.code, 'CORRUPT');
    assert.match(confused.message, /is not entry .* own/);
    const after = f.store.read(scope.projectId, scope.sessionId);
    assert.deepEqual([after.entries[0].state, after.entries[0].submission], ['claimed', null]);
  } finally { await f.cleanup(); }
});
