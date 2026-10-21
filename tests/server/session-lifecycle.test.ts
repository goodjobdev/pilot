import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { SessionLifecycleStore, SessionLifecycleService, adoptRunningSessions, type SessionLifecyclePort } from '../../src/server/state/session-lifecycle';
import {
  SessionLifecycleError, initialSessionLifecycle, validateSessionLifecycleRecord, planSessionLifecycleAction, retryRequestId,
  SESSION_LIFECYCLE_ADOPTION_REASON, SESSION_LIFECYCLE_DISPATCH_REFUSED_REASON,
  type SessionLifecycleErrorCode, type SessionLifecycleRecord
} from '../../src/shared/session-lifecycle';

/**
 * The durable session lifecycle and its five owner actions, over disposable roots only. Every fixture
 * is a fresh temporary directory with its own control store; no live project, planning document,
 * agent store or provider is read or written, and every model effect is a synthetic port call.
 */

const CLOCK = () => new Date('2026-01-01T00:00:00.000Z');
const PROJECT = 'project-a';
const SESSION = '1';

/** A synthetic port: it performs no model work and counts exactly what the service asked it to do. */
function syntheticPort() {
  const seen = {
    cancel: 0,
    authorisations: 0,
    dispatched: [] as { action: 'resume' | 'retry'; requestId: string }[],
    get providerCalls(): number { return seen.dispatched.length; }
  };
  const port: SessionLifecyclePort = {
    authoriseDispatch: async () => { seen.authorisations += 1; },
    resume: async ({ requestId }) => { seen.dispatched.push({ action: 'resume', requestId }); },
    retry: async ({ requestId }) => { seen.dispatched.push({ action: 'retry', requestId }); },
    cancel: async () => { seen.cancel += 1; }
  };
  return { seen, port };
}

type Fixture = {
  root: string;
  store: ControlStore;
  lifecycle: SessionLifecycleStore;
  service: SessionLifecycleService;
  seen: ReturnType<typeof syntheticPort>['seen'];
  cleanup(): Promise<void>;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-lifecycle-'));
  const store = new ControlStore(root);
  const lifecycle = new SessionLifecycleStore(store, { clock: CLOCK });
  const { seen, port } = syntheticPort();
  const service = new SessionLifecycleService(lifecycle, port, { clock: CLOCK });
  return { root, store, lifecycle, service, seen, cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

async function refusal(promise: Promise<unknown>, code: SessionLifecycleErrorCode): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof SessionLifecycleError) { assert.equal(error.code, code); return error.message; }
    throw error;
  }
  throw new Error('expected a refusal, but the call succeeded');
}
const read = (f: Fixture) => f.lifecycle.read(PROJECT, SESSION);

test('lifecycle: a strict, frozen record model refuses impossible states and non-idle states without a reason', () => {
  const base = initialSessionLifecycle(PROJECT, SESSION);
  assert.equal(base.state, 'idle');
  assert.equal(base.revision, 0);
  assert.equal(base.attempt, 0);
  assert.equal(base.requestId, null);
  assert.equal(base.reason, null);
  assert.equal(base.uncertain, false);
  assert.ok(Object.isFrozen(base));
  // A non-idle state without a reason, a reason on an idle state, a request identity with no attempt
  // and uncertainty outside an interruption are all refused as invalid rather than interpreted.
  const shape = (over: Record<string, unknown> = {}) => ({
    version: 1, projectId: PROJECT, sessionId: SESSION, state: 'running', revision: 1, attempt: 1,
    requestId: 'r1', reason: null, uncertain: false,
    activityAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over
  });
  const unchanged = (over: Record<string, unknown>) => validateSessionLifecycleRecord(shape(over));
  assert.equal(unchanged({}).state, 'running');
  assert.equal(unchanged({ state: 'idle' }).state, 'idle', 'an idle record may keep the attempt and identity of the generation that just ended');
  assert.throws(() => unchanged({ state: 'failed' }), /must carry the reason/);
  assert.throws(() => unchanged({ reason: 'why', state: 'idle', attempt: 0, requestId: null }), /must not carry a reason/);
  assert.throws(() => unchanged({ requestId: null }), /no request identity/);
  assert.throws(() => unchanged({ attempt: 0 }), /but no attempt/);
  assert.throws(() => unchanged({ uncertain: true }), /uncertain/);
  assert.throws(() => unchanged({ state: 'banana' }), (error: unknown) => error instanceof SessionLifecycleError && error.code === 'INVALID');
  assert.throws(() => unchanged({ surprise: true }), /surprise/);
  // An interrupted record may be uncertain, and a failed one may not.
  assert.equal(unchanged({ state: 'interrupted', reason: 'gone', uncertain: true }).uncertain, true);
  assert.throws(() => unchanged({ state: 'failed', reason: 'bad', uncertain: true }), /uncertain/);
});

test('lifecycle: every illegal transition is refused with a reason and changes nothing', async () => {
  const f = await fixture();
  try {
    // From idle: only stop is legal (as an idempotent no-op); resume, retry and pause are illegal.
    assert.match(await refusal(f.service.run(PROJECT, SESSION, 'resume', { revision: 0 }), 'ILLEGAL'), /paused or interrupted/);
    assert.match(await refusal(f.service.run(PROJECT, SESSION, 'retry', { revision: 0 }), 'ILLEGAL'), /failed/);
    assert.match(await refusal(f.service.run(PROJECT, SESSION, 'pause', { revision: 0 }), 'ILLEGAL'), /running/);
    assert.equal(f.seen.providerCalls, 0, 'an illegal action spends nothing');
    assert.deepEqual(read(f), initialSessionLifecycle(PROJECT, SESSION), 'an illegal action changes nothing');
    const stopped = await f.service.run(PROJECT, SESSION, 'stop', { revision: 0 });
    assert.equal(stopped.unchanged, true, 'stopping a session that is not running is an idempotent no-op');
    assert.equal(f.seen.cancel, 0, 'a no-op stop does not even ask to cancel');
    // Now a real generation: running, then a pause, then a resume, then a stop.
    const running = f.lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'r1' });
    assert.equal(running.state, 'running');
    assert.equal(running.revision, 1);
    assert.equal(running.attempt, 1);
    assert.match(await refusal(f.service.run(PROJECT, SESSION, 'resume', { revision: 1 }), 'ILLEGAL'), /paused or interrupted/);
    assert.match(await refusal(f.service.run(PROJECT, SESSION, 'retry', { revision: 1 }), 'ILLEGAL'), /failed/);
    const paused = await f.service.run(PROJECT, SESSION, 'pause', { revision: 1, reason: 'owner paused it' });
    assert.equal(paused.record.state, 'paused');
    assert.equal(paused.record.reason, 'owner paused it');
    assert.equal(f.seen.cancel, 1, 'a pause asks the current generation to stop');
    assert.match(await refusal(f.service.run(PROJECT, SESSION, 'retry', { revision: 2 }), 'ILLEGAL'), /failed/);
    const resumed = await f.service.run(PROJECT, SESSION, 'resume', { revision: 2 });
    assert.equal(resumed.record.state, 'running');
    assert.equal(resumed.dispatched, true);
    // A failed generation is retryable; a running one is not.
    f.lifecycle.markSettled({ projectId: PROJECT, sessionId: SESSION, outcome: 'failed', reason: 'the generation failed' });
    const failed = read(f);
    assert.equal(failed.state, 'failed');
    assert.match(await refusal(f.service.run(PROJECT, SESSION, 'resume', { revision: failed.revision }), 'ILLEGAL'), /failed/);
    assert.equal(f.seen.dispatched.length, 1, 'no refused action dispatched');
  } finally { await f.cleanup(); }
});

test('lifecycle: a stale revision is a conflict that leaves the record unchanged', async () => {
  const f = await fixture();
  try {
    f.lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'r1' });
    const before = read(f);
    const stale = await refusal(f.service.run(PROJECT, SESSION, 'pause', { revision: 0 }), 'CONFLICT');
    assert.match(stale, /is at lifecycle revision 1, not 0/);
    assert.match(stale, /wrote nothing and the record is unchanged/);
    assert.equal(f.seen.cancel, 0, 'the stale pause never reached the port');
    assert.deepEqual(read(f), before, 'a stale revision changes nothing');
    // The correct revision is accepted; a second stale request changes nothing again.
    const paused = await f.service.run(PROJECT, SESSION, 'pause', { revision: 1 });
    assert.equal(paused.record.revision, 2);
    const staleStop = await refusal(f.service.run(PROJECT, SESSION, 'stop', { revision: 1 }), 'CONFLICT');
    assert.match(staleStop, /is at lifecycle revision 2, not 1/);
    assert.match(staleStop, /the stop wrote nothing/);
    assert.deepEqual(read(f), paused.record, 'the stale stop left the paused record alone');
  } finally { await f.cleanup(); }
});

test('lifecycle: reconnect and stop perform zero provider calls, and stopping an already-stopped session is idempotent', async () => {
  const f = await fixture();
  try {
    f.lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'r1' });
    const attached = await f.service.run(PROJECT, SESSION, 'reconnect', { revision: 1 });
    assert.equal(attached.unchanged, true, 'reconnect only attaches: it changes no execution state');
    assert.equal(attached.dispatched, false);
    assert.equal(attached.cancelled, false);
    assert.equal(f.seen.cancel, 0, 'reconnect never even asks to cancel');
    assert.deepEqual(read(f).requestId, 'r1', 'reconnect leaves the running generation exactly as it was');
    const stopped = await f.service.run(PROJECT, SESSION, 'stop', { revision: 1 });
    assert.equal(stopped.record.state, 'idle');
    assert.equal(stopped.record.revision, 2);
    assert.equal(stopped.cancelled, true);
    assert.equal(f.seen.cancel, 1, 'stop asked the current generation to stop');
    // Nothing dispatched a model request, in any of the three calls above.
    assert.equal(f.seen.providerCalls, 0, 'reconnect and stop dispatch nothing');
    assert.deepEqual(f.seen.dispatched, []);
    // Stopping again is an idempotent no-op, and it does not even ask the port a second time.
    const again = await f.service.run(PROJECT, SESSION, 'stop', { revision: 2 });
    assert.equal(again.unchanged, true);
    assert.equal(f.seen.cancel, 1, 'the second stop is a no-op and calls nothing');
    assert.deepEqual(read(f), stopped.record, 'the second stop changes nothing');
    // Reconnecting again, at the stopped record's revision, is still just an attach.
    const reattached = await f.service.run(PROJECT, SESSION, 'reconnect', { revision: 2 });
    assert.equal(reattached.unchanged, true);
    assert.equal(f.seen.providerCalls, 0);
  } finally { await f.cleanup(); }
});

test('lifecycle: resume reuses the original request identity and retry names a new one', async () => {
  const f = await fixture();
  try {
    f.lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'original-request' });
    const paused = await f.service.run(PROJECT, SESSION, 'pause', { revision: 1 });
    assert.equal(paused.record.state, 'paused');
    assert.equal(paused.record.requestId, 'original-request', 'a pause keeps the request identity it must resume under');
    const resumed = await f.service.run(PROJECT, SESSION, 'resume', { revision: 2 });
    assert.equal(resumed.record.state, 'running');
    assert.equal(resumed.record.requestId, 'original-request', 'resume reuses the original request identity');
    assert.equal(resumed.record.attempt, paused.record.attempt, 'resume continues the same attempt');
    assert.deepEqual(f.seen.dispatched, [{ action: 'resume', requestId: 'original-request' }], 'the submitted request id is unchanged');
    // A failed attempt is re-run only by an explicit retry, under a brand-new identity.
    f.lifecycle.markSettled({ projectId: PROJECT, sessionId: SESSION, outcome: 'failed', reason: 'the generation failed' });
    const failed = read(f);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.requestId, 'original-request');
    const retried = await f.service.run(PROJECT, SESSION, 'retry', { revision: failed.revision });
    assert.equal(retried.record.state, 'running');
    assert.equal(retried.record.attempt, failed.attempt + 1, 'a retry is a new attempt');
    assert.notEqual(retried.record.requestId, failed.requestId, 'a retry never reuses the failed request identity');
    assert.equal(retried.record.requestId, retryRequestId(SESSION, failed.revision + 1), 'the retry identity is derived from the revision the attempt is written at');
    assert.deepEqual(f.seen.dispatched.at(-1), { action: 'retry', requestId: retried.record.requestId! });
  } finally { await f.cleanup(); }
});

test('lifecycle: an uncertain interruption is refused with operator attention instead of being replayed', async () => {
  const f = await fixture();
  try {
    f.lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'r1' });
    // The startup adoption of a running record that outlived its process: interrupted and uncertain.
    const adoption = adoptRunningSessions(f.lifecycle, CLOCK());
    assert.equal(adoption.adopted, 1);
    assert.deepEqual(adoption.entries, [{ projectId: PROJECT, sessionId: SESSION, revision: 2 }]);
    const interrupted = read(f);
    assert.equal(interrupted.state, 'interrupted');
    assert.equal(interrupted.uncertain, true);
    assert.equal(interrupted.reason, SESSION_LIFECYCLE_ADOPTION_REASON);
    const before = JSON.stringify(interrupted);
    const refused = await refusal(f.service.run(PROJECT, SESSION, 'resume', { revision: 2 }), 'NEEDS_ATTENTION');
    assert.match(refused, /cannot be proven idempotent/);
    assert.equal(f.seen.providerCalls, 0, 'an uncertain interruption is never replayed');
    assert.equal(JSON.stringify(read(f)), before, 'the refusal changes nothing');
    // Connecting a fresh client to an interrupted session is allowed and dispatches nothing.
    const attached = await f.service.run(PROJECT, SESSION, 'reconnect', { revision: 2 });
    assert.equal(attached.unchanged, true);
    assert.equal(f.seen.providerCalls, 0);
    // An interruption that *is* provably safe resumes under the original identity.
    const safe: SessionLifecycleRecord = f.lifecycle.write({
      version: 1, projectId: PROJECT, sessionId: SESSION, state: 'interrupted', revision: 3, attempt: 1,
      requestId: 'r1', reason: 'the generation was provably never dispatched', uncertain: false,
      activityAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });
    const resumed = await f.service.run(PROJECT, SESSION, 'resume', { revision: safe.revision });
    assert.equal(resumed.record.state, 'running');
    assert.equal(resumed.record.requestId, 'r1');
    assert.deepEqual(f.seen.dispatched, [{ action: 'resume', requestId: 'r1' }]);
  } finally { await f.cleanup(); }
});

test('lifecycle: startup adoption is deterministic and idempotent, and a settled session is not adopted', async () => {
  const f = await fixture();
  try {
    // Two running sessions and one running session that then settles: only the running ones are adopted.
    f.lifecycle.markRunning({ projectId: PROJECT, sessionId: 'b', requestId: 'rb' });
    f.lifecycle.markRunning({ projectId: PROJECT, sessionId: 'a', requestId: 'ra' });
    f.lifecycle.markRunning({ projectId: 'project-b', sessionId: 'a', requestId: 'rc' });
    f.lifecycle.markSettled({ projectId: 'project-b', sessionId: 'a', outcome: 'idle' });
    const first = adoptRunningSessions(f.lifecycle, CLOCK());
    // A deterministic order: sorted by project id, then session id.
    assert.deepEqual(first.entries.map((entry) => entry.projectId + '/' + entry.sessionId), ['project-a/a', 'project-a/b']);
    assert.equal(first.adopted, 2);
    // A second adoption finds nothing running and changes nothing.
    const second = adoptRunningSessions(f.lifecycle, CLOCK());
    assert.equal(second.adopted, 0);
    assert.deepEqual(second.entries, []);
    const a = f.lifecycle.read(PROJECT, 'a');
    assert.equal(a.state, 'interrupted');
    assert.equal(a.uncertain, true);
    assert.equal(f.lifecycle.read(PROJECT, 'b').reason, SESSION_LIFECYCLE_ADOPTION_REASON);
    // The settled session is idle, never interrupted: a finished generation is not adopted.
    assert.equal(f.lifecycle.read('project-b', 'a').state, 'idle');
    assert.deepEqual(adoptRunningSessions(f.lifecycle, CLOCK()), second, 'adoption is deterministic');
  } finally { await f.cleanup(); }
});

test('lifecycle: records survive a reopen and the store reads only its own operations', async () => {
  const f = await fixture();
  try {
    f.lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'r1' });
    const paused = await f.service.run(PROJECT, SESSION, 'pause', { revision: 1 });
    // A durable record of another kind in the very same scope is not a lifecycle record.
    f.store.admit({
      scope: { projectId: PROJECT, sessionId: SESSION },
      idempotencyKey: 'session.r1',
      kind: 'session.record',
      input: { version: 1, id: SESSION, projectId: PROJECT, name: 'A session', revision: 1, model: null, links: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      outbox: { kind: 'session.registry', payload: { version: 1, sessionId: SESSION, revision: 1 } }
    });
    f.store.close();
    const reopened = new ControlStore(f.root);
    try {
      const lifecycle = new SessionLifecycleStore(reopened, { clock: CLOCK });
      assert.deepEqual(lifecycle.read(PROJECT, SESSION), paused.record, 'the lifecycle record survives a reopen');
      assert.equal(lifecycle.running().length, 0, 'a paused session is not running work');
      assert.equal(lifecycle.read(PROJECT, 'absent').state, 'idle', 'a session with no lifecycle row reads at idle');
      assert.equal(lifecycle.has(PROJECT, 'absent'), false);
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});

/** A failed record at revision 2 with a named failed attempt: the state a retry is legal from. */
function seedFailed(lifecycle: SessionLifecycleStore): SessionLifecycleRecord {
  lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'failed-attempt' });
  return lifecycle.markSettled({ projectId: PROJECT, sessionId: SESSION, outcome: 'failed', reason: 'the generation failed' });
}

test('lifecycle: two racers at one failed revision plan the identical retry identity, and the durable write picks the winner', async () => {
  const f = await fixture();
  try {
    const failed = seedFailed(f.lifecycle);
    // Two racers that both read the failed revision plan the *same* identity: a duplicate submission
    // that did reach the harness would therefore collapse onto one instead of dispatching a second.
    const first = planSessionLifecycleAction(failed, 'retry', { revision: failed.revision, now: new Date('2026-01-01T00:00:01.000Z') });
    const second = planSessionLifecycleAction(failed, 'retry', { revision: failed.revision, now: new Date('2026-01-01T00:00:02.000Z') });
    if (first.kind !== 'transition' || second.kind !== 'transition') throw new Error('a retry plans exactly one transition');
    assert.equal(first.next.requestId, retryRequestId(SESSION, failed.revision + 1));
    assert.equal(first.next.requestId, second.next.requestId, 'two racers submit the identical request identity');
    assert.notEqual(first.next.requestId, failed.requestId, 'and it is still not the failed attempt\'s own identity');
    // The durable write is the serialization point: the revision is written once, and the racer that
    // lost it is refused with a conflict rather than quietly writing a second record.
    f.lifecycle.write(first.next);
    assert.throws(
      () => f.lifecycle.write(second.next),
      (error: unknown) => error instanceof SessionLifecycleError && error.code === 'CONFLICT',
      'the second writer at the same revision is a conflict'
    );
    const after = read(f);
    assert.equal(after.revision, failed.revision + 1, 'exactly one writer at that revision');
    assert.equal(after.state, 'running');
    assert.equal(after.attempt, failed.attempt + 1);
    assert.equal(f.seen.providerCalls, 0, 'the write decides the winner before any port is asked to dispatch');
  } finally { await f.cleanup(); }
});

test('lifecycle: two concurrent retries at one revision dispatch exactly once, record one attempt, and refuse the loser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-lifecycle-race-'));
  const store = new ControlStore(root);
  const lifecycle = new SessionLifecycleStore(store, { clock: CLOCK });
  const dispatched: string[] = [];
  // The rendezvous is what makes the race deterministic: neither racer reaches its durable write
  // before both have read the same revision, exactly as two real requests can interleave.
  let arrived = 0, release: () => void = () => {};
  const both = new Promise<void>((resolve) => { release = resolve; });
  const port: SessionLifecyclePort = {
    authoriseDispatch: async () => { arrived += 1; if (arrived === 2) release(); await both; },
    resume: async ({ requestId }) => { dispatched.push('resume:' + requestId); },
    retry: async ({ requestId }) => { dispatched.push('retry:' + requestId); },
    cancel: async () => {}
  };
  const service = new SessionLifecycleService(lifecycle, port, { clock: CLOCK });
  try {
    const failed = seedFailed(lifecycle);
    const results = await Promise.allSettled([
      service.run(PROJECT, SESSION, 'retry', { revision: failed.revision }),
      service.run(PROJECT, SESSION, 'retry', { revision: failed.revision })
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1, 'exactly one racer wins the revision');
    assert.equal(rejected.length, 1, 'exactly one racer is refused');
    assert.ok(rejected[0].reason instanceof SessionLifecycleError && rejected[0].reason.code === 'CONFLICT', 'the loser is told the revision is already written: ' + String((rejected[0].reason as Error).message));
    assert.equal(dispatched.length, 1, 'exactly one provider dispatch happened, in either interleaving');
    const after = lifecycle.read(PROJECT, SESSION);
    assert.equal(after.state, 'running');
    assert.equal(after.revision, failed.revision + 1, 'exactly one revision was written');
    assert.equal(after.attempt, failed.attempt + 1, 'exactly one attempt was recorded');
    assert.equal(after.requestId, retryRequestId(SESSION, failed.revision + 1));
    assert.deepEqual(dispatched, ['retry:' + after.requestId], 'the winner dispatched the derived identity, and only it');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('lifecycle: a refused dispatch closes the authorised attempt as failed, never leaving a phantom running generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-lifecycle-refusal-'));
  const store = new ControlStore(root);
  const lifecycle = new SessionLifecycleStore(store, { clock: CLOCK });
  let attempts = 0;
  const port: SessionLifecyclePort = {
    authoriseDispatch: async () => {},
    resume: async () => {},
    retry: async () => { attempts += 1; if (attempts === 1) throw new Error('The harness refused the dispatch at /private/tmp/agent-session.sqlite'); },
    cancel: async () => {}
  };
  const service = new SessionLifecycleService(lifecycle, port, { clock: CLOCK });
  try {
    const failed = seedFailed(lifecycle);
    await assert.rejects(
      service.run(PROJECT, SESSION, 'retry', { revision: failed.revision }),
      /refused the dispatch/,
      'the port\'s refusal is returned to the caller'
    );
    const after = lifecycle.read(PROJECT, SESSION);
    assert.equal(after.state, 'failed', 'the authorised attempt is closed as failed, not left running');
    assert.equal(after.reason, SESSION_LIFECYCLE_DISPATCH_REFUSED_REASON);
    assert.ok(!(after.reason ?? '').includes('sqlite'), 'no port text, and so no path, is ever stored in the record: ' + String(after.reason));
    assert.equal(after.revision, failed.revision + 2, 'the failed attempt is recorded at its own revision');
    assert.equal(after.attempt, failed.attempt + 1, 'one attempt was authorised and recorded');
    assert.notEqual(after.requestId, failed.requestId);
    // The session stays retryable, so a refusal never costs the owner the session.
    const retried = await service.run(PROJECT, SESSION, 'retry', { revision: after.revision });
    assert.equal(retried.record.state, 'running');
    assert.equal(retried.dispatched, true);
    assert.equal(attempts, 2, 'the retry really reached the port');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('lifecycle: a paused session is resumable, and the harness\'s own settled hook cannot overwrite it', async () => {
  const f = await fixture();
  try {
    f.lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'live-generation' });
    const paused = await f.service.run(PROJECT, SESSION, 'pause', { revision: 1, reason: 'the owner paused the live generation' });
    assert.equal(paused.record.state, 'paused');
    assert.equal(paused.record.revision, 2, 'the owner\'s pause wrote exactly one revision');
    assert.deepEqual([paused.dispatched, paused.cancelled], [false, true]);
    // The watcher observes the cancelled generation leave the working state and reports a settle at
    // the same revision: it must write nothing, because the paused state is the owner\'s now.
    const settled = f.lifecycle.markSettled({ projectId: PROJECT, sessionId: SESSION, outcome: 'idle' });
    assert.equal(settled.state, 'paused');
    assert.equal(settled.revision, paused.record.revision, 'the settled hook wrote no competing revision');
    assert.equal(f.seen.providerCalls, 0, 'a pause dispatches nothing');
    const resumed = await f.service.run(PROJECT, SESSION, 'resume', { revision: paused.record.revision });
    assert.equal(resumed.record.state, 'running');
    assert.equal(resumed.record.requestId, 'live-generation', 'resume continued under the original request identity');
    assert.equal(resumed.record.attempt, paused.record.attempt, 'resume continues the same attempt');
  } finally { await f.cleanup(); }
});
