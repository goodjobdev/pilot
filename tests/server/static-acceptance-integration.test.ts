import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createStaticArtifact } from '../../prototypes/static-artifact.mjs';
import { StaticLifecycleExperiment } from '../../prototypes/static-lifecycle.mjs';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { ActionTargetStore, actionTargetFingerprint } from '../../src/server/state/action-target-store';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionPort } from '../../src/server/state/accepted-action';

// Test-only composition. Synthetic resource names are not host identities; no network or real helper exists.
// Acceptance admission is deliberately a no-op; session and scope revocation are simulated locally,
// not evidence that the production session/scope admission path is wired correctly. The thrown stage
// failure models a post-handoff error, not proof that a remote effect occurred or a reply was lost.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-static-integration-'));
  const source = join(root, 'source'), data = join(root, 'data');
  await mkdir(source); await mkdir(data);
  const control = new ControlStore(data), targets = new ActionTargetStore(control);
  const acceptance = new AcceptanceStore(control, { projectRoot: id => id === 'project' ? source : undefined });
  const definition = { kind: 'deploy' as const, integrationId: 'fake', serviceId: 'fake', environmentId: 'fake', resourceDigest: 'a'.repeat(64) };
  targets.write({ projectId: 'project', targetId: 'target', revision: 0, enabled: true, definition, actor: { kind: 'owner', identity: 'owner' } });
  const policy = { mode: 'agent-may-accept' as const, actionClasses: { commit: 'ask' as const, push: 'ask' as const, deploy: 'full-auto' as const, spend: 'ask' as const, provision: 'ask' as const, publish: 'ask' as const } };
  acceptance.updatePolicy({ revision: 0, policy, actor: { kind: 'owner', identity: 'owner' } });
  const snapshot = createStaticArtifact([{ path: 'index.html', type: 'file', bytes: Buffer.from('fixture') }]);
  const target = targets.resolve('project', 'target', 1, 'deploy'), targetDigest = actionTargetFingerprint(target);
  const active = 'b'.repeat(64), generation = 4;
  // Bind expected synthetic prior state too, not only the canonical manifest digest.
  const contentRevision = 'static-' + createHash('sha256').update(JSON.stringify(['test-static-v1', snapshot.releaseId, active, generation])).digest('hex');
  const artifact = targetBoundArtifact({ projectId: 'project', actionClass: 'deploy', targetId: 'target', targetRevision: 1, targetDigest, contentRevision, commit: null });
  const evidence = await acceptance.recordEvidence({ projectId: 'project', evidence: { sessionId: 'session', subject: { kind: 'session', id: 'session' }, artifact, commands: ['test'], diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: 'synthetic claim', reference: null }, tests: [{ command: 'test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-01T00:00:00.000Z' } });
  const accepted = (await acceptance.accept({ authorizeAdmission: () => {}, projectId: 'project', request: { evidenceId: evidence.evidence.record.id, artifact, actionClass: 'deploy', actor: { kind: 'agent', identity: 'agent' } } })).acceptance;
  const intent = { projectId: 'project', sessionId: 'session', agentId: 'agent', evidenceId: evidence.evidence.record.id, acceptanceId: accepted.id, actionClass: 'deploy' as const, artifact, contentRevision, targetId: 'target', targetRevision: 1, targetDigest, resourceKey: 'resource-' + definition.resourceDigest };
  let allowed = true, session = 'session', stages = 0, activations = 0, onStage = () => {}, lose = false;
  let revalidate = async () => {}; let signal: AbortSignal | undefined;
  const lifecycle = new StaticLifecycleExperiment(join(root, 'lifecycle.sqlite'), {
    stage: async (binding: any) => {
      stages++;
      assert.equal(binding.artifact, snapshot.releaseId);
      assert.equal(createStaticArtifact(snapshot.readFiles().map((file: any) => ({ ...file, type: 'file' }))).releaseId, binding.artifact);
      onStage(); if (lose) throw Error('lost synthetic reply');
      await revalidate(); signal?.throwIfAborted();
      return { fingerprint: binding.fingerprint, artifact: binding.artifact, operation: binding.operation };
    },
    activate: async (binding: any) => { activations++; assert.equal(binding.active, active); assert.equal(binding.generation, generation); return { fingerprint: binding.fingerprint, operation: binding.operation, active: binding.artifact, generation: generation + 1 }; }
  }, () => {
    const current = targets.resolve('project', 'target', 1, 'deploy');
    return { target: 'target', revision: current.revision, targetDigest: actionTargetFingerprint(current), resource: 'fixture' };
  });
  const authority = async () => {
    if (!allowed || session !== intent.sessionId || actionTargetFingerprint(targets.resolve('project', 'target', 1, 'deploy')) !== targetDigest) throw Error('authority revoked');
  };
  const port: AcceptedActionPort = {
    authorize: async i => { await authority(); const view = await acceptance.readEvidence({ projectId: i.projectId, evidenceId: i.evidenceId }); await authority(); if (!view.acceptance) throw Error('no acceptance'); return { allowed, acceptance: view.acceptance, policy: acceptance.readPolicy() }; },
    check: async i => { await authority(); if (i.contentRevision !== contentRevision || i.resourceKey !== intent.resourceKey || i.artifact.revision !== artifact.revision) throw Error('binding changed'); },
    execute: async (i, abort, validate) => {
      await authority(); await validate(); abort?.throwIfAborted(); revalidate = async () => { await authority(); await validate(); }; signal = abort;
      const status = await lifecycle.run({ operation: 'operation', resource: 'fixture', target: 'target', revision: 1, targetDigest, artifact: snapshot.releaseId, active, generation });
      if (status !== 'activated') throw Error('synthetic lifecycle not confirmed');
      return { targetId: i.targetId, artifact: i.artifact, externalId: 'fake-receipt' };
    }
  };
  return { root, data, control, targets, acceptance, definition, policy, intent, port, lifecycle, snapshot,
    run: (abort?: AbortSignal) => new AcceptedActionExecutor(control).run(intent, port, abort),
    revoke: () => { allowed = false; }, restore: () => { allowed = true; }, changeSession: () => { session = 'other'; }, onStage: (fn: () => void) => { onStage = fn; }, lose: () => { lose = true; }, counts: () => [stages, activations],
    cleanup: async () => { lifecycle.close(); control.close(); await rm(root, { recursive: true, force: true }); } };
}

test('canonical static snapshot, target and real acceptance policy admit one synthetic lifecycle', async () => {
  const f = await fixture();
  try {
    const altered = createStaticArtifact([{ path: 'index.html', type: 'file', bytes: Buffer.from('changed') }]);
    assert.notEqual(altered.releaseId, f.snapshot.releaseId);
    await assert.rejects(new AcceptedActionExecutor(f.control).run({ ...f.intent, contentRevision: 'static-' + altered.releaseId }, f.port), /does not bind/);
    await assert.rejects(new AcceptedActionExecutor(f.control).run({ ...f.intent, targetRevision: 2 }, f.port), /does not bind/);
    const result = await f.run(); assert.equal(result.status, 'succeeded'); assert.deepEqual(f.counts(), [1, 1]);
    await assert.rejects(f.run(), /already has an action intent/);
  } finally { await f.cleanup(); }
});

test('simulated session and scope revocation, and real policy or target changes, deny before synthetic effects', async () => {
  for (const kind of ['session', 'scope', 'policy', 'target'] as const) {
    const f = await fixture();
    try {
      if (kind === 'session') f.changeSession();
      if (kind === 'scope') f.revoke();
      if (kind === 'policy') f.acceptance.updatePolicy({ revision: 1, policy: { ...f.policy, actionClasses: { ...f.policy.actionClasses, deploy: 'ask' } }, actor: { kind: 'owner', identity: 'owner' } });
      if (kind === 'target') f.targets.write({ projectId: 'project', targetId: 'target', revision: 1, enabled: false, definition: f.definition, actor: { kind: 'owner', identity: 'owner' } });
      await assert.rejects(f.run()); assert.deepEqual(f.counts(), [0, 0]);
    } finally { await f.cleanup(); }
  }
});

test('synthetic post-handoff error, cancellation and revocation remain uncertain and cannot replay on reopen', async () => {
  for (const kind of ['lost', 'abort', 'revoked'] as const) {
    const f = await fixture(), controller = new AbortController();
    try {
      if (kind === 'lost') f.lose();
      if (kind === 'abort') f.onStage(() => controller.abort());
      if (kind === 'revoked') f.onStage(() => f.revoke());
      const result = await f.run(controller.signal); assert.equal(result.status, 'uncertain');
      assert.equal(f.control.getOperation(result.operationId, { projectId: 'project', sessionId: 'accepted-actions' }).state, 'unknown');
      assert.equal(f.lifecycle.inspect('operation')?.state, 'stage-unknown');
      assert.deepEqual(f.counts(), [1, 0]);
      // Restore authority only to show the durable fence, not revocation, stops replay.
      f.restore();
      const reopened = new ControlStore(f.data);
      try { await assert.rejects(new AcceptedActionExecutor(reopened).run(f.intent, f.port), /already has an action intent/); }
      finally { reopened.close(); }
      assert.deepEqual(f.counts(), [1, 0]);
    } finally { await f.cleanup(); }
  }
});
