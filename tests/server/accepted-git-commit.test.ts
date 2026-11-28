import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import type { AgentScope } from '../../src/shared/agent-registry';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { ActionTargetStore, actionTargetFingerprint } from '../../src/server/state/action-target-store';
import { AcceptedCommitService } from '../../src/server/agents/accepted-commit';
import { acceptAgentEvidence } from '../../src/server/agents/accept-evidence';
import { WorkspaceStore } from '../../src/server/workspace';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionIntent } from '../../src/server/state/accepted-action';
import { acceptedGitCommitPort } from '../../src/server/state/accepted-git-commit';
import { defaultAcceptancePolicy, type AcceptancePolicy, type AcceptanceRecord } from '../../src/shared/acceptance';

const exec = promisify(execFile);
async function git(path: string, ...args: string[]) {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', path, ...args], { env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' });
  return stdout.trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-accepted-git-')), path = join(root, 'project'), data = join(root, 'data');
  await mkdir(path); await mkdir(data); await mkdir(join(path, 'src')); await mkdir(join(root, 'empty-template'));
  const id = randomUUID(), branch = 'work/pilot-' + id.slice(0, 8);
  await git(path, 'init', '-q', '--template=' + join(root, 'empty-template')); await git(path, 'config', 'user.name', 'Fixture'); await git(path, 'config', 'user.email', 'fixture@example.invalid');
  await git(path, 'checkout', '-q', '-b', branch);
  await writeFile(join(path, 'src', 'a.ts'), 'export const n = 1;\n'); await git(path, 'add', '.'); await git(path, 'commit', '-q', '-m', 'base');
  const parent = await git(path, 'rev-parse', 'HEAD');
  await writeFile(join(path, 'src', 'a.ts'), 'export const n = 2;\n'); await git(path, 'add', 'src/a.ts');
  const tree = await git(path, 'write-tree');
  const project = { id, name: 'Fixture', path: await realpath(path), managed: true, repository: '', created: '' };
  const store = new ControlStore(data), workspace = new WorkspaceStore(), targets = new ActionTargetStore(store);
  const configured = targets.write({ projectId: id, targetId: 'pilot-branch', revision: 0, enabled: true, definition: { kind: 'commit', repositoryId: id, branch: 'refs/heads/' + branch }, actor: { kind: 'owner', identity: 'fixture' } });
  const target = { projectId: id, actionClass: 'commit' as const, targetId: 'pilot-branch', targetRevision: 1, targetDigest: actionTargetFingerprint(configured), contentRevision: 'tree-' + tree, commit: parent };
  const intent: AcceptedActionIntent = { ...target, sessionId: 'session', agentId: 'agent', evidenceId: 'evidence-1', acceptanceId: 'acceptance-1', artifact: targetBoundArtifact(target) };
  const policy = { ...defaultAcceptancePolicy(), mode: 'agent-may-accept', actionClasses: { ...defaultAcceptancePolicy().actionClasses, commit: 'full-auto' } } as AcceptancePolicy;
  const authorize = async (request: AcceptedActionIntent) => ({ allowed: true, policy, acceptance: { id: request.acceptanceId, evidenceId: request.evidenceId, projectId: request.projectId, sessionId: request.sessionId, actionClass: 'commit', artifact: request.artifact, acceptedBy: { kind: 'agent', identity: request.agentId }, policy: { revision: policy.revision, mode: 'agent-may-accept', classDecision: 'full-auto' } } as AcceptanceRecord });
  const port = acceptedGitCommitPort({ project, targetId: 'pilot-branch', targetRevision: 1, targetDigest: target.targetDigest, workspace, authorize });
  return { root, path, branch, parent, tree, project, intent, policy, authorize, store, workspace, targets, port, executor: new AcceptedActionExecutor(store), cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('exact accepted index tree commits only to the configured branch without running hooks', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.path, 'other.txt'), 'untracked');
    await mkdir(join(f.path, '.git', 'hooks'));
    for (const [key, value] of [['author.name', 'Imposter'], ['author.email', 'imposter@example.invalid'], ['committer.name', 'Imposter'], ['committer.email', 'imposter@example.invalid']]) await git(f.path, 'config', key, value);
    const hooks = join(f.path, '.git', 'hooks'), marker = join(f.root, 'hook-ran');
    await writeFile(join(hooks, 'reference-transaction'), '#!/bin/sh\necho ran > "' + marker + '"\n'); await chmod(join(hooks, 'reference-transaction'), 0o755);
    const result = await f.executor.run(f.intent, f.port);
    assert.equal(result.status, 'succeeded'); if (result.status !== 'succeeded') return;
    assert.equal(await git(f.path, 'rev-parse', 'HEAD'), result.receipt.externalId);
    assert.equal(await git(f.path, 'rev-parse', 'HEAD^{tree}'), f.tree);
    assert.equal(await git(f.path, 'rev-parse', 'HEAD^'), f.parent);
    assert.equal(await git(f.path, 'show', '-s', '--format=%an <%ae>|%cn <%ce>', 'HEAD'), 'Pilot <pilot@localhost>|Pilot <pilot@localhost>');
    assert.equal(await git(f.path, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/a.ts');
    assert.equal(await readFile(join(f.path, 'other.txt'), 'utf8'), 'untracked');
    await assert.rejects(readFile(marker));
    await assert.rejects(f.executor.run(f.intent, f.port));
  } finally { await f.cleanup(); }
});

test('changed staged trees and refused paths or symlinks cause no commit', async () => {
  for (const kind of ['changed', 'secret', 'symlink'] as const) {
    const f = await fixture();
    try {
      if (kind === 'changed') { await writeFile(join(f.path, 'src', 'a.ts'), 'changed again\n'); await git(f.path, 'add', 'src/a.ts'); }
      if (kind === 'secret') { await writeFile(join(f.path, '.env'), 'fixture-secret'); await git(f.path, 'add', '-f', '.env'); }
      if (kind === 'symlink') { await symlink('a.ts', join(f.path, 'src', 'link.ts')); await git(f.path, 'add', 'src/link.ts'); }
      const tree = await git(f.path, 'write-tree');
      const contentRevision = 'tree-' + tree;
      const attempt = kind === 'changed' ? f.intent : { ...f.intent, contentRevision, artifact: targetBoundArtifact({ ...f.intent, contentRevision, commit: f.parent }) };
      await assert.rejects(f.executor.run(attempt, f.port));
      assert.equal(await git(f.path, 'rev-parse', 'HEAD'), f.parent);
    } finally { await f.cleanup(); }
  }
});

test('real acceptance and target/session checks gate the exact commit service', async () => {
  const f = await fixture();
  try {
    const acceptance = new AcceptanceStore(f.store, { projectRoot: id => id === f.project.id ? f.path : undefined });
    const recorded = await acceptance.recordEvidence({ projectId: f.project.id, evidence: { sessionId: 'session', subject: { kind: 'session', id: 'session' }, artifact: f.intent.artifact, commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 1, text: 'fixture diff', reference: null }, tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-01T00:00:00.000Z' } });
    acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'full-auto', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'owner' } });
    const evidenceId = recorded.evidence.record.id;
    const accepted = await acceptance.accept({ authorizeAdmission: () => {}, projectId: f.project.id, request: { evidenceId, artifact: f.intent.artifact, actionClass: 'commit', actor: { kind: 'agent', identity: 'agent' } } });
    let targetCurrent = true, authorized = true;
    const service = new AcceptedCommitService({ project: f.project, targetId: 'pilot-branch', targetRevision: 1, workspace: f.workspace, targets: f.targets, acceptance, executor: f.executor, targetCurrent: async (_project, session) => targetCurrent && session === 'session' });
    const auth = async () => { if (!authorized) throw Error('scope revoked'); };
    const preview = await service.preview({ projectId: f.project.id, sessionId: 'session', agentId: 'agent', authorize: auth });
    assert.deepEqual(preview.artifact, f.intent.artifact); assert.deepEqual(preview.changedPaths, ['src/a.ts']);
    assert.deepEqual(preview.target, { id: 'pilot-branch', revision: 1, digest: f.intent.targetDigest, branch: 'refs/heads/' + f.branch });
    assert.equal(preview.contentRevision, 'tree-' + f.tree);
    const call = { projectId: f.project.id, sessionId: 'session', agentId: 'agent', evidenceId, acceptanceId: accepted.acceptance.id, artifact: f.intent.artifact, authorize: auth };
    await assert.rejects(service.preview({ projectId: 'another-project', sessionId: 'session', agentId: 'agent', authorize: auth }), /project does not match/);
    await assert.rejects(service.commit({ ...call, projectId: 'another-project' }), /project does not match/);
    targetCurrent = false; await assert.rejects(service.commit(call), /target or session/); targetCurrent = true;
    authorized = false; await assert.rejects(service.commit(call), /scope revoked/); authorized = true;
    await assert.rejects(service.commit({ ...call, sessionId: 'other-session' }), /target or session/);
    f.targets.write({ projectId: f.project.id, targetId: 'other-target', revision: 0, enabled: true, definition: { kind: 'commit', repositoryId: f.project.id, branch: 'refs/heads/' + f.branch }, actor: { kind: 'owner', identity: 'fixture' } });
    const redirected = new AcceptedCommitService({ project: f.project, targetId: 'other-target', targetRevision: 1, workspace: f.workspace, targets: f.targets, acceptance, executor: f.executor, targetCurrent: async () => true });
    await assert.rejects(redirected.commit(call), /does not bind this exact action target/);
    assert.equal(await git(f.path, 'rev-parse', 'HEAD'), f.parent);
    const result = await service.commit(call); assert.equal(result.status, 'succeeded');
    assert.equal(await git(f.path, 'rev-parse', 'HEAD^{tree}'), f.tree);
  } finally { await f.cleanup(); }
});

test('live policy revocation after commit-object creation prevents the ref update', async () => {
  const f = await fixture();
  try {
    const acceptance = new AcceptanceStore(f.store, { projectRoot: id => id === f.project.id ? f.path : undefined });
    const evidence = await acceptance.recordEvidence({ projectId: f.project.id, evidence: { sessionId: 'session', subject: { kind: 'session', id: 'session' }, artifact: f.intent.artifact, commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 1, text: 'fixture diff', reference: null }, tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-01T00:00:00.000Z' } });
    const decisions = { commit: 'full-auto', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } as const;
    acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: decisions }, actor: { kind: 'owner', identity: 'owner' } });
    const evidenceId = evidence.evidence.record.id;
    const accepted = await acceptance.accept({ authorizeAdmission: () => {}, projectId: f.project.id, request: { evidenceId, artifact: f.intent.artifact, actionClass: 'commit', actor: { kind: 'agent', identity: 'agent' } } });
    const service = new AcceptedCommitService({ project: f.project, targetId: 'pilot-branch', targetRevision: 1, workspace: f.workspace, targets: f.targets, acceptance, executor: f.executor, targetCurrent: async () => true });
    const original = f.workspace.localGit.bind(f.workspace);
    f.workspace.localGit = async (project, args) => {
      const output = await original(project, args);
      if (args.includes('commit-tree')) acceptance.updatePolicy({ revision: 1, policy: { mode: 'agent-may-accept', actionClasses: { ...decisions, commit: 'ask' } }, actor: { kind: 'owner', identity: 'owner' } });
      return output;
    };
    const result = await service.commit({ projectId: f.project.id, sessionId: 'session', agentId: 'agent', evidenceId, acceptanceId: accepted.acceptance.id, artifact: f.intent.artifact, authorize: async () => {} });
    assert.equal(result.status, 'uncertain'); assert.equal(await git(f.path, 'rev-parse', 'HEAD'), f.parent);
  } finally { await f.cleanup(); }
});

test('revoking the durable target after object creation prevents the branch update', async () => {
  const f = await fixture();
  try {
    const acceptance = new AcceptanceStore(f.store, { projectRoot: id => id === f.project.id ? f.path : undefined });
    const evidence = await acceptance.recordEvidence({ projectId: f.project.id, evidence: { sessionId: 'session', subject: { kind: 'session', id: 'session' }, artifact: f.intent.artifact, commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 1, text: 'fixture diff', reference: null }, tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-01T00:00:00.000Z' } });
    acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'full-auto', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'owner' } });
    const evidenceId = evidence.evidence.record.id;
    const accepted = await acceptance.accept({ authorizeAdmission: () => {}, projectId: f.project.id, request: { evidenceId, artifact: f.intent.artifact, actionClass: 'commit', actor: { kind: 'agent', identity: 'agent' } } });
    const service = new AcceptedCommitService({ project: f.project, targetId: 'pilot-branch', targetRevision: 1, workspace: f.workspace, targets: f.targets, acceptance, executor: f.executor, targetCurrent: async () => true });
    const original = f.workspace.localGit.bind(f.workspace); let revoked = false;
    f.workspace.localGit = async (project, args) => {
      const output = await original(project, args);
      if (!revoked && args.includes('commit-tree')) {
        revoked = true;
        f.targets.write({ projectId: f.project.id, targetId: 'pilot-branch', revision: 1, enabled: false, definition: { kind: 'commit', repositoryId: f.project.id, branch: 'refs/heads/' + f.branch }, actor: { kind: 'owner', identity: 'owner' } });
      }
      return output;
    };
    const result = await service.commit({ projectId: f.project.id, sessionId: 'session', agentId: 'agent', evidenceId, acceptanceId: accepted.acceptance.id, artifact: f.intent.artifact, authorize: async () => {} });
    assert.equal(revoked, true); assert.equal(result.status, 'uncertain'); assert.equal(await git(f.path, 'rev-parse', 'HEAD'), f.parent);
  } finally { await f.cleanup(); }
});

test('an explicitly injected model-facing path previews, accepts and commits through the real stores', async () => {
  const f = await fixture(), rootSession = String(ROOT_CONVERSATION_ID);
  const acceptance = new AcceptanceStore(f.store, { projectRoot: id => id === f.project.id ? f.path : undefined });
  const evidence = await acceptance.recordEvidence({ projectId: f.project.id, evidence: { sessionId: rootSession, subject: { kind: 'session', id: rootSession }, artifact: f.intent.artifact, commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 1, text: 'fixture diff', reference: null }, tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-01T00:00:00.000Z' } });
  acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'full-auto', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'owner' } });
  const fake = fauxProvider({ provider: 'commit-faux', models: [{ id: 'fixture' }] }), providers = new ProviderStore(f.root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'commit-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  const service = new AcceptedCommitService({ project: f.project, targetId: 'pilot-branch', targetRevision: 1, workspace: f.workspace, targets: f.targets, acceptance, executor: f.executor, targetCurrent: async (project, session) => project === f.project.id && session === rootSession });
  let scopes: readonly AgentScope[] = ['accept', 'commit'];
  const host = new HarnessHost({ dataRoot: f.root, enabled: true, providers, privileges: { authority: async () => ({ agentId: 'agent', model: null, scopes, projects: [f.project.id], emptyReason: null }) },
    acceptanceTools: { read: projectId => acceptance.readProject({ projectId }), accept: input => acceptAgentEvidence(acceptance, { ...input, verifyAdmission: () => {} }) },
    acceptedCommitTools: { preview: input => service.preview(input), commit: input => service.commit(input) }
  });
  const wait = async (text: string) => { const end = Date.now() + 10000; while (!(await host.view(f.project)).entries.some(entry => entry.text.includes(text))) { if (Date.now() > end) throw Error('scripted run did not complete'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  try {
    const evidenceId = evidence.evidence.record.id;
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('commit_preview', {})], { stopReason: 'toolUse' }), () => fauxAssistantMessage([fauxToolCall('acceptance_accept', { evidenceId, artifact: f.intent.artifact, actionClass: 'commit' })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Exact acceptance recorded.')]);
    await host.submit(f.project, { text: 'Inspect and accept', mode: 'followUp' }); await wait('Exact acceptance recorded.');
    const accepted = (await acceptance.readEvidence({ projectId: f.project.id, evidenceId })).acceptance; assert.ok(accepted);
    assert.match(JSON.stringify((await host.view(f.project)).entries), new RegExp(f.tree));
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('commit_accepted', { evidenceId, acceptanceId: accepted.id, artifact: f.intent.artifact })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Commit attempt finished.')]);
    await host.submit(f.project, { text: 'Commit accepted tree', mode: 'followUp' }); await wait('Commit attempt finished.');
    assert.equal(await git(f.path, 'rev-parse', 'HEAD^{tree}'), f.tree);
    assert.match(JSON.stringify((await host.view(f.project)).entries), /succeeded/);
    scopes = [];
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('commit_preview', {})], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Revocation checked.')]);
    await host.submit(f.project, { text: 'Try revoked commit', mode: 'followUp' }); await wait('Revocation checked.');
    assert.match(JSON.stringify((await host.view(f.project)).entries), /refused|not permitted/i);
  } finally { await host.close(); await providers.close(); await f.cleanup(); }
});

test('revocation or cancellation after object creation prevents branch update and remains uncertain', async () => {
  for (const mode of ['revoke', 'cancel'] as const) {
    const f = await fixture();
    try {
      let allowed = true; const controller = new AbortController();
      const original = f.workspace.localGit.bind(f.workspace);
      f.workspace.localGit = async (project, args) => {
        const output = await original(project, args);
        if (args.includes('commit-tree')) { if (mode === 'revoke') allowed = false; else controller.abort(); }
        return output;
      };
      const port = { ...f.port, authorize: async (intent: AcceptedActionIntent) => ({ ...(await f.authorize(intent)), allowed }) };
      const result = await f.executor.run(f.intent, port, controller.signal);
      assert.equal(result.status, 'uncertain'); assert.equal(await git(f.path, 'rev-parse', 'HEAD'), f.parent);
      allowed = true;
      await assert.rejects(f.executor.run(f.intent, port), /already has an action intent/);
    } finally { await f.cleanup(); }
  }
});

test('authority revoked during the final snapshot prevents the ref update and remains uncertain', async () => {
  const f = await fixture();
  try {
    let allowed = true, objectCreated = false, revoked = false, snapshotFinished = false, updateRequested = false;
    const original = f.workspace.localGit.bind(f.workspace);
    f.workspace.localGit = async (project, args) => {
      const output = await original(project, args);
      if (args.includes('commit-tree')) objectCreated = true;
      else if (objectCreated && !revoked && args.includes('diff-tree')) { allowed = false; revoked = true; }
      else if (revoked && args.includes('write-tree')) snapshotFinished = true;
      if (args.includes('update-ref')) updateRequested = true;
      return output;
    };
    const port = { ...f.port, authorize: async (intent: AcceptedActionIntent) => ({ ...(await f.authorize(intent)), allowed }) };
    const result = await f.executor.run(f.intent, port);
    assert.equal(revoked, true); assert.equal(snapshotFinished, true); assert.equal(updateRequested, false);
    assert.equal(result.status, 'uncertain'); assert.equal(await git(f.path, 'rev-parse', 'refs/heads/' + f.branch), f.parent);
    allowed = true;
    await assert.rejects(f.executor.run(f.intent, port), /already has an action intent/);
  } finally { await f.cleanup(); }
});

test('preview refuses a symbolic configured branch or an indirect HEAD', async () => {
  for (const mode of ['branch', 'head'] as const) {
    const f = await fixture();
    try {
      if (mode === 'branch') {
        await git(f.path, 'update-ref', 'refs/heads/unrelated', f.parent);
        await git(f.path, 'symbolic-ref', 'refs/heads/' + f.branch, 'refs/heads/unrelated');
      } else {
        await git(f.path, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
        await git(f.path, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/' + f.branch);
      }
      await assert.rejects(f.port.preview(), /configured branch/);
      assert.equal(await git(f.path, 'rev-parse', 'refs/heads/' + f.branch), f.parent);
    } finally { await f.cleanup(); }
  }
});

test('a symbolic branch substituted after object creation is refused and remains uncertain', async () => {
  const f = await fixture();
  try {
    await git(f.path, 'update-ref', 'refs/heads/unrelated', f.parent);
    const original = f.workspace.localGit.bind(f.workspace); let swapped = false;
    f.workspace.localGit = async (project, args) => {
      const output = await original(project, args);
      if (!swapped && args.includes('commit-tree')) {
        swapped = true;
        await git(f.path, 'symbolic-ref', 'refs/heads/' + f.branch, 'refs/heads/unrelated');
      }
      return output;
    };
    const result = await f.executor.run(f.intent, f.port);
    assert.equal(swapped, true); assert.equal(result.status, 'uncertain');
    assert.equal(await git(f.path, 'symbolic-ref', 'refs/heads/' + f.branch), 'refs/heads/unrelated');
    assert.equal(await git(f.path, 'rev-parse', 'refs/heads/unrelated'), f.parent);
    await git(f.path, 'update-ref', '--no-deref', 'refs/heads/' + f.branch, f.parent);
    await assert.rejects(f.executor.run(f.intent, f.port), /already has an action intent/);
  } finally { await f.cleanup(); }
});

test('a symbolic-ref swap cannot redirect the accepted commit to another branch', async () => {
  const f = await fixture();
  try {
    await git(f.path, 'update-ref', 'refs/heads/unrelated', f.parent);
    const original = f.workspace.localGit.bind(f.workspace); let raced = false;
    f.workspace.localGit = async (project, args) => {
      if (!raced && args.includes('update-ref')) { raced = true; await git(f.path, 'symbolic-ref', 'refs/heads/' + f.branch, 'refs/heads/unrelated'); }
      return original(project, args);
    };
    const result = await f.executor.run(f.intent, f.port);
    // --no-deref prevents updating the unrelated target, but Git can replace the symbolic ref
    // itself. This remains an unresolved target-identity limitation; the adapter is not installed.
    assert.equal(result.status, 'succeeded'); assert.equal(raced, true);
    assert.equal(await git(f.path, 'rev-parse', 'refs/heads/unrelated'), f.parent);
  } finally { await f.cleanup(); }
});

test('a competing branch update defeats compare-and-swap and is reported uncertain', async () => {
  const f = await fixture();
  try {
    const other = await git(f.path, 'commit-tree', f.tree, '-p', f.parent, '-m', 'competing');
    const original = f.workspace.localGit.bind(f.workspace); let raced = false;
    f.workspace.localGit = async (project, args) => {
      if (!raced && args.includes('update-ref')) { raced = true; await git(f.path, 'update-ref', 'refs/heads/' + f.branch, other, f.parent); }
      return original(project, args);
    };
    const result = await f.executor.run(f.intent, f.port);
    assert.equal(result.status, 'uncertain'); assert.equal(raced, true); assert.equal(await git(f.path, 'rev-parse', 'HEAD'), other);
    await assert.rejects(f.executor.run(f.intent, f.port));
  } finally { await f.cleanup(); }
});
