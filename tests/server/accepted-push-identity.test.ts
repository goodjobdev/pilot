import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { ActionTargetStore } from '../../src/server/state/action-target-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { AcceptedPushService, type ExactPushTransport } from '../../src/server/agents/accepted-push';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-push-identity-'));
  const projectId = randomUUID(), commit = 'a'.repeat(40), repositoryDigest = 'b'.repeat(64);
  const control = new ControlStore(root), targets = new ActionTargetStore(control);
  const acceptance = new AcceptanceStore(control, { projectRoot: () => root });
  targets.write({ projectId, targetId: 'target', revision: 0, enabled: true, definition: { kind: 'push', remoteId: 'fixture', repositoryDigest, branch: 'refs/heads/main' }, actor: { kind: 'owner', identity: 'fixture' } });
  acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'full-auto', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
  let head: unknown = null, effects = 0;
  const transport: ExactPushTransport = {
    inspect: async () => ({ repositoryDigest, remoteHead: head as string | null }),
    push: async () => { effects++; head = commit + '\n'; return { repositoryDigest, observedCommit: commit }; }
  };
  const service = new AcceptedPushService({ projectId, targetId: 'target', targetRevision: 1, targets, acceptance, executor: new AcceptedActionExecutor(control), transport, targetCurrent: async () => true });
  const caller = { projectId, sessionId: 'session', agentId: 'agent', authorize: async () => {} };
  return { root, projectId, commit, control, acceptance, service, caller, setHead: (value: unknown) => { head = value; }, effects: () => effects, cleanup: async () => { control.close(); await rm(root, { recursive: true, force: true }); } };
}

test('push preview requires exact primitive commit and remote head identities', async () => {
  const f = await fixture();
  try {
    for (const value of [f.commit + '\n', new String(f.commit), { toString: () => f.commit }]) {
      await assert.rejects(f.service.preview({ ...f.caller, commit: value as string }), /Invalid push project or commit/);
      f.setHead(value);
      await assert.rejects(f.service.preview({ ...f.caller, commit: f.commit }), /remote state is unavailable/);
    }
    f.setHead(null);
    assert.equal((await f.service.preview({ ...f.caller, commit: f.commit })).remoteHead, null);
    await assert.rejects(f.service.preview({ ...f.caller, authorize: async () => { throw Error('revoked'); }, commit: f.commit }), /revoked/);
    assert.equal(f.effects(), 0);
  } finally { await f.cleanup(); }
});

test('malformed post-effect identity remains uncertain and cannot be replayed', async () => {
  const f = await fixture();
  try {
    const preview = await f.service.preview({ ...f.caller, commit: f.commit });
    const evidence = await f.acceptance.recordEvidence({ projectId: f.projectId, evidence: { sessionId: f.caller.sessionId, subject: { kind: 'session', id: f.caller.sessionId }, artifact: preview.artifact, commands: ['test'], diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: 'synthetic', reference: null }, tests: [{ command: 'test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-01T00:00:00.000Z' } });
    const evidenceId = evidence.evidence.record.id;
    const accepted = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId, artifact: preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: f.caller.agentId } } });
    const request = { ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact };
    assert.equal((await f.service.push(request)).status, 'uncertain');
    f.setHead(f.commit);
    await assert.rejects(f.service.push(request), /already has an action intent/);
    assert.equal(f.effects(), 1);
  } finally { await f.cleanup(); }
});
