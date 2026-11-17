import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionPort } from '../../src/server/state/accepted-action';
import { defaultAcceptancePolicy, type AcceptanceRecord, type AcceptancePolicy } from '../../src/shared/acceptance';

const target = { projectId: 'project', actionClass: 'commit' as const, targetId: 'owner-target', targetRevision: 1, targetDigest: 'b'.repeat(64), contentRevision: 'tree-123', commit: 'a'.repeat(40) };
const artifact = targetBoundArtifact(target);
const intent = { projectId: target.projectId, sessionId: 'session', agentId: 'agent', evidenceId: 'evidence-1', acceptanceId: 'acceptance-1', actionClass: target.actionClass, artifact, contentRevision: target.contentRevision, targetId: target.targetId, targetRevision: target.targetRevision, targetDigest: target.targetDigest };
const policy = { ...defaultAcceptancePolicy(), mode: 'agent-may-accept', actionClasses: { ...defaultAcceptancePolicy().actionClasses, commit: 'full-auto' } } as AcceptancePolicy;
const acceptance = { id: intent.acceptanceId, evidenceId: intent.evidenceId, projectId: intent.projectId, sessionId: intent.sessionId, actionClass: 'commit', artifact, acceptedBy: { kind: 'agent', identity: 'agent', policyRule: 'agent-may-accept:commit=full-auto' }, policy: { revision: policy.revision, mode: 'agent-may-accept', classDecision: 'full-auto' } } as AcceptanceRecord;
function stub() {
  let checks = 0, executions = 0, allow = true;
  const port: AcceptedActionPort = {
    authorize: async () => ({ acceptance, policy, allowed: allow }),
    check: async () => { checks++; },
    execute: async input => { executions++; return { targetId: input.targetId, artifact: input.artifact, externalId: 'receipt-1' }; }
  };
  return { port, counts: () => ({ checks, executions }), revoke: () => { allow = false; } };
}
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'pilot-accepted-action-')), store = new ControlStore(root); return { root, store, executor: new AcceptedActionExecutor(store), cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } }; }

test('an accepted action binds class, agent, artifact and target and admits its acceptance only once', async () => {
  const f = await fixture(), fake = stub();
  try {
    const result = await f.executor.run(intent, fake.port);
    assert.equal(result.status, 'succeeded'); assert.deepEqual(fake.counts(), { checks: 2, executions: 1 });
    assert.equal(f.store.getOperation(result.operationId, { projectId: intent.projectId, sessionId: 'accepted-actions' }).state, 'succeeded');
    await assert.rejects(f.executor.run(intent, fake.port), /already has an action intent/);
    await assert.rejects(f.executor.run({ ...intent, targetId: 'another-target' }, fake.port), /does not bind this exact action target/);
    assert.equal(fake.counts().executions, 1);
  } finally { await f.cleanup(); }
});

test('revocation before effect records a refusal and executes nothing', async () => {
  const f = await fixture(), fake = stub(); let checks = 0;
  const port = { ...fake.port, check: async () => { if (++checks === 1) fake.revoke(); } };
  try {
    const result = await f.executor.run(intent, port);
    assert.equal(result.status, 'refused'); assert.equal(fake.counts().executions, 0);
    assert.equal(f.store.getOperation(result.operationId, { projectId: intent.projectId, sessionId: 'accepted-actions' }).state, 'failed');
  } finally { await f.cleanup(); }
});

test('concurrent requests consume one acceptance and start only one effect', async () => {
  const f = await fixture(), fake = stub();
  try {
    const results = await Promise.allSettled([f.executor.run(intent, fake.port), f.executor.run(intent, fake.port)]);
    assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.status === 'succeeded').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(fake.counts().executions, 1);
  } finally { await f.cleanup(); }
});

test('cancellation after effect admission stays uncertain and cannot replay after reopen', async () => {
  const f = await fixture(), fake = stub(), controller = new AbortController();
  try {
    const port: AcceptedActionPort = { ...fake.port, execute: async input => { controller.abort(); return { targetId: input.targetId, artifact: input.artifact, externalId: 'receipt-1' }; } };
    const result = await f.executor.run(intent, port, controller.signal);
    assert.equal(result.status, 'uncertain');
    assert.equal(f.store.getOperation(result.operationId, { projectId: intent.projectId, sessionId: 'accepted-actions' }).state, 'unknown');
    f.store.close(); const reopened = new ControlStore(f.root);
    try { await assert.rejects(new AcceptedActionExecutor(reopened).run(intent, fake.port), /already has an action intent/); }
    finally { reopened.close(); }
    assert.equal(fake.counts().executions, 0);
  } finally { await f.cleanup(); }
});

test('abort returns uncertainty for an unresponsive effect and late settlement cannot rewrite it', async () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    const f = await fixture(), fake = stub(), controller = new AbortController();
    let release: () => void = () => {}, entered: () => void = () => {}, executions = 0, lateEffects = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const port: AcceptedActionPort = { ...fake.port, execute: async input => {
      executions++; entered(); await gate; lateEffects++;
      if (outcome === 'reject') throw Error('late adapter failure');
      return { targetId: input.targetId, artifact: input.artifact, externalId: 'late-receipt' };
    } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = f.executor.run(intent, port, controller.signal);
      await started; controller.abort();
      const result = await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('abort did not stop the wait')), 1000); })]);
      if (timer) clearTimeout(timer);
      assert.equal(result.status, 'uncertain', outcome);
      const scope = { projectId: intent.projectId, sessionId: 'accepted-actions' };
      assert.equal(f.store.getOperation(result.operationId, scope).state, 'unknown');
      assert.equal(lateEffects, 0, 'the adapter is still pending when uncertainty is returned');
      const reopened = new ControlStore(f.root);
      try { await assert.rejects(new AcceptedActionExecutor(reopened).run(intent, fake.port), /already has an action intent/); }
      finally { reopened.close(); }
      release(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.store.getOperation(result.operationId, scope).state, 'unknown', 'late adapter completion cannot rewrite uncertainty');
      assert.equal(lateEffects, 1, 'uncertainty is not a guarantee that effects stopped');
      assert.equal(executions, 1);
    } finally { if (timer) clearTimeout(timer); release(); await f.cleanup(); }
  }
});

test('pre-aborted and pre-effect cancellation never start an adapter', async () => {
  for (const phase of ['before-run', 'post-admission-check'] as const) {
    const f = await fixture(), fake = stub(), controller = new AbortController(); let checks = 0;
    try {
      if (phase === 'before-run') controller.abort();
      const port: AcceptedActionPort = { ...fake.port, check: async () => { if (++checks === 2) controller.abort(); } };
      if (phase === 'before-run') await assert.rejects(f.executor.run(intent, port, controller.signal));
      else {
        const result = await f.executor.run(intent, port, controller.signal);
        assert.equal(result.status, 'refused');
        assert.equal(f.store.getOperation(result.operationId, { projectId: intent.projectId, sessionId: 'accepted-actions' }).state, 'failed');
      }
      assert.equal(fake.counts().executions, 0);
    } finally { await f.cleanup(); }
  }
});

test('the effect cancellation listener is removed on success and abort', async () => {
  for (const abort of [false, true]) {
    const f = await fixture(), fake = stub(), controller = new AbortController();
    const signal = controller.signal, add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    let added = 0, removed = 0;
    signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => { if (type === 'abort') added++; add(type, listener, options); }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => { if (type === 'abort') removed++; remove(type, listener, options); }) as typeof signal.removeEventListener;
    try {
      const port: AcceptedActionPort = { ...fake.port, execute: async input => { if (abort) controller.abort(); return { targetId: input.targetId, artifact: input.artifact, externalId: 'receipt' }; } };
      const result = await f.executor.run(intent, port, signal);
      assert.equal(result.status, abort ? 'uncertain' : 'succeeded');
      assert.deepEqual([added, removed], [1, 1]);
    } finally { await f.cleanup(); }
  }
});

test('an interrupted pending intent survives reopen and is never dispatched again', async () => {
  const f = await fixture(), fake = stub();
  try {
    const scope = { projectId: intent.projectId, sessionId: 'accepted-actions' };
    const key = 'accepted-action.' + createHash('sha256').update(intent.artifact.revision).digest('hex');
    const admitted = f.store.admit({ scope, idempotencyKey: key, kind: 'accepted.action', input: intent, outbox: { kind: 'accepted.action', payload: { version: 1, acceptanceId: intent.acceptanceId } } });
    f.store.close(); const reopened = new ControlStore(f.root);
    try {
      assert.equal(reopened.getOperation(admitted.operation.id, scope).state, 'pending');
      await assert.rejects(new AcceptedActionExecutor(reopened).run(intent, fake.port), /already has an action intent/);
      assert.equal(fake.counts().executions, 0);
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});

test('wrong policy, artifact or target verification fails before durable admission', async () => {
  const f = await fixture(), fake = stub();
  try {
    await assert.rejects(f.executor.run({ ...intent, artifact: { ...artifact, revision: 'different' } }, fake.port), /does not bind this exact action target/);
    for (const changed of [{ targetId: 'other' }, { targetRevision: 2 }, { targetDigest: 'c'.repeat(64) }, { contentRevision: 'tree-456' }, { projectId: 'other-project' }])
      await assert.rejects(f.executor.run({ ...intent, ...changed }, fake.port), /does not bind this exact action target/);
    await assert.rejects(f.executor.run({ ...intent, actionClass: 'push' }, fake.port), /resource key is unavailable/);
    const changedTarget = { ...intent, targetId: 'other-target' };
    await assert.rejects(f.executor.run({ ...changedTarget, artifact: targetBoundArtifact({ ...changedTarget, commit: artifact.commit }) }, fake.port), /does not authorize this exact action/);
    const wrongPolicy: AcceptedActionPort = { ...fake.port, authorize: async () => ({ acceptance, policy: { ...policy, actionClasses: { ...policy.actionClasses, commit: 'ask' } }, allowed: true }) };
    await assert.rejects(f.executor.run(intent, wrongPolicy), /does not authorize/);
    const reenabledPolicy: AcceptedActionPort = { ...fake.port, authorize: async () => ({ acceptance, policy: { ...policy, revision: policy.revision + 2 }, allowed: true }) };
    await assert.rejects(f.executor.run(intent, reenabledPolicy), /does not authorize/);
    await assert.rejects(f.executor.run(intent, { ...fake.port, check: async () => { throw Error('target changed'); } }), /target changed/);
    assert.equal(fake.counts().executions, 0);
  } finally { await f.cleanup(); }
});
