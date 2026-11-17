import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { ActionTargetStore } from '../../src/server/state/action-target-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { AcceptedPushService, type ExactPushTransport } from '../../src/server/agents/accepted-push';
import { acceptAgentEvidence } from '../../src/server/agents/accept-evidence';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import type { AgentScope } from '../../src/shared/agent-registry';

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-push-fixture-')), source = join(root, 'source'), remote = join(root, 'remote.git'), data = join(root, 'data'), template = join(root, 'empty-template');
  await Promise.all([mkdir(source), mkdir(data), mkdir(template)]);
  const env = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', '-C', cwd, ...args], { env, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
  await git(source, 'init', '-q', '--template=' + template); await git(root, 'init', '--bare', '-q', '--template=' + template, remote);
  await git(remote, 'config', 'core.hooksPath', '/dev/null');
  await git(source, 'config', 'user.name', 'Fixture'); await git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, 'file.txt'), 'base\n'); await git(source, 'add', 'file.txt'); await git(source, 'commit', '-q', '-m', 'base');
  const base = await git(source, 'rev-parse', 'HEAD'), branch = 'refs/heads/pilot';
  await git(source, 'push', '-q', '--no-verify', '--', remote, base + ':' + branch);
  await writeFile(join(source, 'file.txt'), 'updated\n'); await git(source, 'add', 'file.txt'); await git(source, 'commit', '-q', '-m', 'updated');
  const commit = await git(source, 'rev-parse', 'HEAD'), projectId = randomUUID(), repositoryDigest = 'a'.repeat(64);
  const project = { id: projectId, name: 'Push fixture', path: source, managed: true, repository: '', created: '' };
  const control = new ControlStore(data), targets = new ActionTargetStore(control), acceptance = new AcceptanceStore(control, { projectRoot: id => id === projectId ? source : undefined });
  targets.write({ projectId, targetId: 'push-target', revision: 0, enabled: true, definition: { kind: 'push', remoteId: 'fixture-remote', repositoryDigest, branch }, actor: { kind: 'owner', identity: 'fixture' } });
  acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'full-auto', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
  let pushes = 0, competitor: string | null = null;
  const transport: ExactPushTransport = {
    inspect: async input => {
      assert.equal(input.projectId, projectId); assert.equal(input.remoteId, 'fixture-remote'); assert.equal(input.repositoryDigest, repositoryDigest); assert.equal(input.branch, branch);
      await git(source, 'cat-file', '-e', input.commit + '^{commit}');
      const observed = await git(remote, 'rev-parse', '--verify', branch);
      return { repositoryDigest, remoteHead: observed };
    },
    push: async input => {
      pushes++; input.signal?.throwIfAborted(); assert.equal(input.remoteId, 'fixture-remote'); assert.equal(input.repositoryDigest, repositoryDigest); assert.equal(input.branch, branch);
      if (competitor) await git(remote, 'update-ref', branch, competitor);
      // A real Git client against a disposable bare repository, never an external service.
      await git(source, 'push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-signed', '--recurse-submodules=no', '--', remote, input.commit + ':' + branch);
      return { repositoryDigest, observedCommit: await git(remote, 'rev-parse', '--verify', branch) };
    }
  };
  const service = new AcceptedPushService({ projectId, targetId: 'push-target', targetRevision: 1, targets, acceptance, executor: new AcceptedActionExecutor(control), transport, targetCurrent: async (project, session) => project === projectId && session === String(ROOT_CONVERSATION_ID) });
  const caller = { projectId, sessionId: String(ROOT_CONVERSATION_ID), agentId: 'agent', authorize: async () => {} };
  const record = async (using = service) => {
    const preview = await using.preview({ ...caller, commit });
    const evidence = await acceptance.recordEvidence({ projectId, evidence: { sessionId: caller.sessionId, subject: { kind: 'session', id: caller.sessionId }, artifact: preview.artifact, commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 1, text: 'fixture claim', reference: null }, tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-01T00:00:00.000Z' } });
    return { preview, evidenceId: evidence.evidence.record.id };
  };
  return { root, source, remote, project, projectId, repositoryDigest, control, targets, acceptance, service, caller, transport, record, git, base, branch, commit, count: () => pushes, setCompetitor: (sha: string) => { competitor = sha; }, cleanup: async () => { control.close(); await rm(root, { recursive: true, force: true }); } };
}

test('an injected model previews, accepts and non-force pushes exactly one commit to a disposable remote', async () => {
  const f = await fixture(), fake = fauxProvider({ provider: 'push-faux', models: [{ id: 'fixture' }] }), providers = new ProviderStore(f.root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'push-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  let scopes: readonly AgentScope[] = ['accept', 'push'];
  const host = new HarnessHost({ dataRoot: f.root, enabled: true, providers,
    privileges: { authority: async () => ({ agentId: 'agent', model: null, scopes, projects: [f.projectId], emptyReason: null }) },
    acceptanceTools: { read: projectId => f.acceptance.readProject({ projectId }), accept: input => acceptAgentEvidence(f.acceptance, { ...input, verifyAdmission: () => {} }) },
    acceptedPushTools: { preview: input => f.service.preview(input), push: input => f.service.push(input) }
  });
  try {
    const { preview, evidenceId } = await f.record(); assert.equal(preview.remoteHead, f.base); assert.equal(preview.target.branch, f.branch);
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('push_preview', { commit: f.commit })], { stopReason: 'toolUse' }), () => fauxAssistantMessage([fauxToolCall('acceptance_accept', { evidenceId, artifact: preview.artifact, actionClass: 'push' })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Push evidence accepted.')]);
    await host.submit(f.project, { text: 'Inspect and accept', mode: 'followUp' });
    const wait = async (text: string) => { const end = Date.now() + 10000; while (!(await host.view(f.project)).entries.some(entry => entry.text.includes(text))) { if (Date.now() > end) throw Error('run did not finish'); await new Promise(resolve => setTimeout(resolve, 20)); } };
    await wait('Push evidence accepted.');
    const accepted = (await f.acceptance.readEvidence({ projectId: f.projectId, evidenceId })).acceptance; assert.ok(accepted);
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('push_accepted', { evidenceId, acceptanceId: accepted.id, artifact: preview.artifact })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Push finished.')]);
    await host.submit(f.project, { text: 'Push the accepted commit', mode: 'followUp' }); await wait('Push finished.');
    assert.equal(await f.git(f.remote, 'rev-parse', '--verify', f.branch), f.commit); assert.equal(f.count(), 1);
    assert.match(JSON.stringify((await host.view(f.project)).entries), /succeeded/);
    await assert.rejects(f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.id, artifact: preview.artifact }), /already has an action intent/);
    scopes = [];
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('push_preview', { commit: f.commit })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Revoked push checked.')]);
    await host.submit(f.project, { text: 'Try revoked push', mode: 'followUp' }); await wait('Revoked push checked.');
    assert.match(JSON.stringify((await host.view(f.project)).entries), /refused|not permitted/i);
    assert.equal(f.count(), 1);
  } finally { await host.close(); await providers.close(); await f.cleanup(); }
});

test('a racing non-fast-forward remote update is not forced and produces a durable uncertain intent', async () => {
  const f = await fixture();
  try {
    const { preview, evidenceId } = await f.record();
    const accepted = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId, artifact: preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
    await f.git(f.source, 'checkout', '-q', '--detach', f.base); await writeFile(join(f.source, 'file.txt'), 'competitor\n'); await f.git(f.source, 'add', 'file.txt'); await f.git(f.source, 'commit', '-q', '-m', 'competing');
    const competitor = await f.git(f.source, 'rev-parse', 'HEAD');
    await f.git(f.source, 'push', '-q', '--no-verify', '--', f.remote, competitor + ':refs/heads/fixture-competitor'); f.setCompetitor(competitor);
    const result = await f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact });
    assert.equal(result.status, 'uncertain'); assert.equal(await f.git(f.remote, 'rev-parse', f.branch), competitor); assert.equal(f.count(), 1);
    await assert.rejects(f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }), /already has an action intent/);
    const reopened = new ControlStore(join(f.root, 'data'));
    try {
      const service = new AcceptedPushService({ projectId: f.projectId, targetId: 'push-target', targetRevision: 1, targets: new ActionTargetStore(reopened), acceptance: new AcceptanceStore(reopened, { projectRoot: id => id === f.projectId ? f.source : undefined }), executor: new AcceptedActionExecutor(reopened), transport: f.transport, targetCurrent: async () => true });
      await assert.rejects(service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }), /already has an action intent/);
    } finally { reopened.close(); }
    assert.equal(f.count(), 1);
  } finally { await f.cleanup(); }
});

test('revoked scope, changed policy and disabled target refuse before a push', async () => {
  for (const kind of ['scope', 'policy', 'target', 'repository'] as const) {
    const f = await fixture();
    try {
      const { preview, evidenceId } = await f.record();
      const accepted = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId, artifact: preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
      if (kind === 'policy') f.acceptance.updatePolicy({ revision: 1, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
      if (kind === 'target') f.targets.write({ projectId: f.projectId, targetId: 'push-target', revision: 1, enabled: false, definition: { kind: 'push', remoteId: 'fixture-remote', repositoryDigest: f.repositoryDigest, branch: f.branch }, actor: { kind: 'owner', identity: 'fixture' } });
      if (kind === 'repository') { const inspect = f.transport.inspect; f.transport.inspect = async input => ({ ...(await inspect(input)), repositoryDigest: 'b'.repeat(64) }); }
      const authorize = async () => { if (kind === 'scope') throw Error('scope revoked'); };
      await assert.rejects(f.service.push({ ...f.caller, authorize, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }));
      if (kind === 'policy') {
        f.acceptance.updatePolicy({ revision: 2, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'full-auto', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
        await assert.rejects(f.service.push({ ...f.caller, authorize, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }), /does not authorize/);
      }
      assert.equal(f.count(), 0); assert.equal(await f.git(f.remote, 'rev-parse', f.branch), f.base);
    } finally { await f.cleanup(); }
  }
});

test('a lost push response remains uncertain and is not replayed even if the remote changed', async () => {
  const f = await fixture();
  try {
    const { preview, evidenceId } = await f.record();
    const accepted = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId, artifact: preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
    const push = f.transport.push; f.transport.push = async input => { await push(input); throw Error('lost response'); };
    const result = await f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact });
    assert.equal(result.status, 'uncertain'); assert.equal(await f.git(f.remote, 'rev-parse', f.branch), f.commit);
    await assert.rejects(f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }), /already has an action intent/);
    const secondEvidence = await f.acceptance.recordEvidence({ projectId: f.projectId, evidence: { sessionId: f.caller.sessionId, subject: { kind: 'session', id: f.caller.sessionId }, artifact: preview.artifact, commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 1, text: 'another fixture claim', reference: null }, tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-02T00:00:00.000Z' } });
    const secondId = secondEvidence.evidence.record.id;
    const secondAcceptance = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId: secondId, artifact: preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
    await assert.rejects(f.service.push({ ...f.caller, evidenceId: secondId, acceptanceId: secondAcceptance.acceptance.id, artifact: preview.artifact }), /exact accepted effect already has an action intent/);
    assert.equal(f.count(), 1);
  } finally { await f.cleanup(); }
});

test('a successful transport receipt without matching post-effect read-back remains uncertain', async () => {
  const f = await fixture();
  try {
    const { preview, evidenceId } = await f.record();
    const accepted = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId, artifact: preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
    let calls = 0;
    // Simulate a misleading receipt without changing the disposable remote. The independent service
    // read uses the same fixture transport, so this is not an independent remote trust boundary.
    f.transport.push = async () => { calls++; return { repositoryDigest: f.repositoryDigest, observedCommit: f.commit }; };
    const result = await f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact });
    assert.equal(result.status, 'uncertain'); assert.equal(calls, 1);
    assert.equal(await f.git(f.remote, 'rev-parse', f.branch), f.base);
    await assert.rejects(f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }), /already has an action intent/);
    const reopened = new ControlStore(join(f.root, 'data'));
    try {
      const service = new AcceptedPushService({ projectId: f.projectId, targetId: 'push-target', targetRevision: 1, targets: new ActionTargetStore(reopened), acceptance: new AcceptanceStore(reopened, { projectRoot: id => id === f.projectId ? f.source : undefined }), executor: new AcceptedActionExecutor(reopened), transport: f.transport, targetCurrent: async () => true });
      await assert.rejects(service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }), /already has an action intent/);
    } finally { reopened.close(); }
    assert.equal(calls, 1, 'a failed read-back never triggers a replay, including after reopen');
  } finally { await f.cleanup(); }
});

test('an uncertain push fences target aliases and revisions for the same configured repository branch', async () => {
  const f = await fixture();
  try {
    const first = await f.record();
    const accepted = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId: first.evidenceId, artifact: first.preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
    let pushes = 0;
    f.transport.push = async () => { pushes++; throw Error('lost response'); };
    const result = await f.service.push({ ...f.caller, evidenceId: first.evidenceId, acceptanceId: accepted.acceptance.id, artifact: first.preview.artifact });
    assert.equal(result.status, 'uncertain'); assert.equal(pushes, 1);
    const definition = { kind: 'push' as const, remoteId: 'fixture-remote', repositoryDigest: f.repositoryDigest, branch: f.branch };
    f.targets.write({ projectId: f.projectId, targetId: 'push-alias', revision: 0, enabled: true, definition, actor: { kind: 'owner', identity: 'fixture' } });
    const alias = new AcceptedPushService({ projectId: f.projectId, targetId: 'push-alias', targetRevision: 1, targets: f.targets, acceptance: f.acceptance, executor: new AcceptedActionExecutor(f.control), transport: f.transport, targetCurrent: async () => true });
    f.targets.write({ projectId: f.projectId, targetId: 'push-target', revision: 1, enabled: true, definition, actor: { kind: 'owner', identity: 'fixture' } });
    const revised = new AcceptedPushService({ projectId: f.projectId, targetId: 'push-target', targetRevision: 2, targets: f.targets, acceptance: f.acceptance, executor: new AcceptedActionExecutor(f.control), transport: f.transport, targetCurrent: async () => true });
    for (const service of [alias, revised]) {
      const second = await f.record(service);
      const secondAcceptance = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId: second.evidenceId, artifact: second.preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
      await assert.rejects(service.push({ ...f.caller, evidenceId: second.evidenceId, acceptanceId: secondAcceptance.acceptance.id, artifact: second.preview.artifact }), /holds this resource/);
    }
    assert.equal(pushes, 1, 'another accepted alias or target revision cannot start an effect');
  } finally { await f.cleanup(); }
});

test('post-effect read-back failure preserves uncertainty and never replays', async () => {
  const f = await fixture();
  try {
    const { preview, evidenceId } = await f.record();
    const accepted = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId, artifact: preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
    const push = f.transport.push, inspect = f.transport.inspect; let pushed = false;
    f.transport.push = async input => { const result = await push(input); pushed = true; return result; };
    f.transport.inspect = async input => { if (pushed) throw Error('lost read-back'); return inspect(input); };
    const result = await f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact });
    assert.equal(result.status, 'uncertain'); assert.equal(await f.git(f.remote, 'rev-parse', f.branch), f.commit); assert.equal(f.count(), 1);
    f.transport.inspect = inspect;
    await assert.rejects(f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }), /already has an action intent/);
    assert.equal(f.count(), 1);
  } finally { await f.cleanup(); }
});

test('abort or revoked authority during pending post-push inspection remains uncertain', async () => {
  for (const change of ['abort', 'revoke'] as const) {
    const f = await fixture(), controller = new AbortController(); let release: () => void = () => {}, entered: () => void = () => {};
    const pendingInspection = new Promise<void>(resolve => { release = resolve; });
    const inspectionStarted = new Promise<void>(resolve => { entered = resolve; });
    try {
      const { preview, evidenceId } = await f.record();
      const accepted = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId, artifact: preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
      const push = f.transport.push, inspect = f.transport.inspect; let pushed = false, revoked = false;
      f.transport.push = async input => { const result = await push(input); pushed = true; return result; };
      f.transport.inspect = async input => { if (pushed) { entered(); await pendingInspection; } return inspect(input); };
      const authorize = async () => { if (revoked) throw Error('revoked'); };
      const operation = f.service.push({ ...f.caller, authorize, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact, signal: controller.signal });
      await inspectionStarted;
      if (change === 'abort') controller.abort(); else revoked = true;
      release(); const result = await operation;
      assert.equal(result.status, 'uncertain', change);
      assert.equal(await f.git(f.remote, 'rev-parse', f.branch), f.commit); assert.equal(f.count(), 1);
      revoked = false; f.transport.inspect = inspect;
      await assert.rejects(f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }), /already has an action intent/);
      assert.equal(f.count(), 1);
    } finally { release(); await f.cleanup(); }
  }
});

test('cancellation after transport admission is uncertain even when a transport returns a receipt', async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    const { preview, evidenceId } = await f.record();
    const accepted = await f.acceptance.accept({ authorizeAdmission: () => {}, projectId: f.projectId, request: { evidenceId, artifact: preview.artifact, actionClass: 'push', actor: { kind: 'agent', identity: 'agent' } } });
    f.transport.push = async () => { controller.abort(); return { repositoryDigest: f.repositoryDigest, observedCommit: f.commit }; };
    const result = await f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact, signal: controller.signal });
    assert.equal(result.status, 'uncertain'); assert.equal(await f.git(f.remote, 'rev-parse', f.branch), f.base);
    await assert.rejects(f.service.push({ ...f.caller, evidenceId, acceptanceId: accepted.acceptance.id, artifact: preview.artifact }), /already has an action intent/);
  } finally { await f.cleanup(); }
});
