import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat,mkdir,mkdtemp,readdir,readFile,realpath,rm,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { LocalReleaseStore } from '../../src/server/state/local-release-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { LocalDeployService, type LocalReleaseSeam } from '../../src/server/agents/local-deploy';
import { LOCAL_RELEASE_MAX_FILE_BYTES } from '../../src/server/agents/local-release';
import { acceptAgentEvidence } from '../../src/server/agents/accept-evidence';
import { authorizeToolUse,scopeToolIsInstalled } from '../../src/shared/agent-registry';

/**
 * The installed local deploy capability: an exact artifact promoted to an owner-configured local
 * directory, with a real staging copy, an atomic current-link swap, a read-back digest and a retained
 * previous generation.
 *
 * Everything runs over a disposable root with its own control store, project worktree and served
 * directory. There is no provider, no network, no container and no live project.
 */

const OWNER = Object.freeze({ kind: 'owner' as const, identity: 'fixture-owner' });
const POLICY = (deploy: 'ask' | 'full-auto') => ({ mode: 'agent-may-accept' as const, actionClasses: { commit: 'ask' as const, push: 'ask' as const, deploy, spend: 'ask' as const, provision: 'ask' as const, publish: 'ask' as const } });

async function fixture(options: { seam?: LocalReleaseSeam; approvedRoots?: readonly string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-local-deploy-'));
  const project = join(root, 'project'), served = join(root, 'served'), elsewhere = join(root, 'elsewhere'), data = join(root, 'data');
  await mkdir(join(project, 'dist', 'assets'), { recursive: true, mode: 0o755 });
  await mkdir(join(served, 'site'), { recursive: true, mode: 0o755 });
  await mkdir(join(elsewhere, 'site'), { recursive: true, mode: 0o755 });
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(project, 'dist', 'index.html'), '<h1>one</h1>');
  await writeFile(join(project, 'dist', 'assets', 'app.js'), 'console.log(1);');
  const projectId = randomUUID(), sessionId = randomUUID(), agentId = 'agent-deployer';
  const control = new ControlStore(data);
  const acceptance = new AcceptanceStore(control, { projectRoot: (id) => (id === projectId ? project : undefined) });
  const store = new LocalReleaseStore(control);
  const targetDirectory = join(served, 'site');
  store.writeDestination({
    projectId, kind: 'deploy', revision: 0, enabled: true,
    definition: { kind: 'deploy-local', artifactPath: 'dist', targetDirectory }, actor: OWNER
  });
  acceptance.updatePolicy({ revision: 0, policy: POLICY('full-auto'), actor: OWNER });
  const service = new LocalDeployService({
    store, acceptance, executor: new AcceptedActionExecutor(control),
    projectRoot: (id) => (id === projectId ? project : undefined),
    approvedRoots: options.approvedRoots ?? [served], seam: options.seam
  });
  const caller = { projectId, sessionId, agentId, authorize: async () => {} };
  const prepare = async () => {
    const preview = await service.preview(caller) as { artifact: { revision: string; commit: string | null }; contentDigest: string; files: number };
    const evidence = await acceptance.recordEvidence({
      projectId,
      evidence: {
        sessionId, subject: { kind: 'session', id: sessionId }, artifact: preview.artifact, commands: ['npm run build'],
        diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: 'fixture claim', reference: null },
        tests: [{ command: 'npm run build', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }],
        review: null, producedAt: '2026-01-01T00:00:00.000Z'
      }
    });
    const accepted = await acceptAgentEvidence(acceptance, {
      projectId, sessionId, evidenceId: evidence.evidence.record.id, artifact: preview.artifact,
      actionClass: 'deploy', agentId, authorize: async () => {}, verifyAdmission: () => {}
    });
    return { preview, evidenceId: evidence.evidence.record.id, acceptanceId: accepted.acceptance.id };
  };
  const deploy = (prepared: Awaited<ReturnType<typeof prepare>>, over: Record<string, unknown> = {}) => service.deploy({ ...caller, evidenceId: prepared.evidenceId, acceptanceId: prepared.acceptanceId, artifact: prepared.preview.artifact, ...over });
  const generations = async () => (await readdir(join(targetDirectory, 'generations'))).sort();
  const cleanup = async () => { control.close(); await rm(root, { recursive: true, force: true }); };
  return { root, project, served, elsewhere, data, projectId, sessionId, agentId, control, acceptance, store, service, caller, targetDirectory, prepare, deploy, generations, cleanup };
}

const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true).catch(() => false);

test('deploy promotes the exact built artifact, swaps the current link atomically and reads the served digest back', async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare();
    assert.equal(prepared.preview.files, 2);
    const result = await f.deploy(prepared) as { status: string; contentDigest: string; generation: string | null; previousGeneration: string | null; receipt: { externalId: string } };
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.contentDigest, prepared.preview.contentDigest);
    const link = join(f.targetDirectory, 'current');
    const info = await lstat(link);
    assert.ok(info.isSymbolicLink(), 'the stable current path is a link this tool created');
    const served = await realpath(link);
    assert.equal(basename(served), result.generation);
    assert.equal(await readFile(join(link, 'index.html'), 'utf8'), '<h1>one</h1>');
    assert.equal(await readFile(join(link, 'assets', 'app.js'), 'utf8'), 'console.log(1);');
    assert.deepEqual(await f.generations(), [result.generation]);
    assert.equal(result.previousGeneration, null);
    const outcomes = f.store.outcomes(f.projectId);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].externalId, 'deploy-' + result.generation);
    assert.equal(outcomes[0].previousGeneration, null);
    assert.equal(result.receipt.externalId, outcomes[0].externalId);
  } finally { await f.cleanup(); }
});

test('a second deploy retains the previous generation for manual rollback and records it', async () => {
  const f = await fixture();
  try {
    const first = await f.deploy(await f.prepare()) as { generation: string; previousGeneration: string | null; status: string };
    assert.equal(first.status, 'succeeded');
    await writeFile(join(f.project, 'dist', 'index.html'), '<h1>two</h1>');
    const second = await f.deploy(await f.prepare()) as { generation: string; previousGeneration: string | null; status: string };
    assert.equal(second.status, 'succeeded');
    assert.notEqual(second.generation, first.generation);
    assert.equal(second.previousGeneration, first.generation);
    assert.deepEqual(await f.generations(), [first.generation, second.generation].sort());
    assert.equal(await readFile(join(f.targetDirectory, 'current', 'index.html'), 'utf8'), '<h1>two</h1>');
    const outcomes = f.store.outcomes(f.projectId);
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[1].previousGeneration, first.generation);
    assert.equal(await readFile(join(f.targetDirectory, 'generations', first.generation, 'index.html'), 'utf8'), '<h1>one</h1>', 'the previous generation is retained unchanged');
  } finally { await f.cleanup(); }
});

test('a changed artifact or a reconfigured target is refused before any effect', async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare();
    await writeFile(join(f.project, 'dist', 'index.html'), '<h1>changed</h1>');
    await assert.rejects(f.deploy(prepared), /does not bind|changed since/);
    assert.equal(await exists(join(f.targetDirectory, 'current')), false);
    assert.equal(await exists(join(f.targetDirectory, 'generations')), false);

    await writeFile(join(f.project, 'dist', 'index.html'), '<h1>one</h1>');
    const second = join(f.served, 'second-site');
    await mkdir(second, { recursive: true });
    f.store.writeDestination({ projectId: f.projectId, kind: 'deploy', revision: 1, enabled: true, definition: { kind: 'deploy-local', artifactPath: 'dist', targetDirectory: second }, actor: OWNER });
    await assert.rejects(f.deploy(prepared), /does not bind|changed/);
    assert.equal(await exists(join(f.targetDirectory, 'current')), false);
  } finally { await f.cleanup(); }
});

test('an unconfigured or disabled destination, a missing artifact, a symlink and an oversize file are each refused', async () => {
  const f = await fixture();
  try {
    // A symlinked file inside the artifact is refused rather than followed.
    await symlink(join(f.root, 'outside.txt'), join(f.project, 'dist', 'linked.txt'));
    await assert.rejects(f.service.preview(f.caller), /symbolic link/);
    await rm(join(f.project, 'dist', 'linked.txt'));

    // An artifact path that is not a real directory is refused.
    f.store.writeDestination({ projectId: f.projectId, kind: 'deploy', revision: 1, enabled: true, definition: { kind: 'deploy-local', artifactPath: 'missing', targetDirectory: f.targetDirectory }, actor: OWNER });
    await assert.rejects(f.service.preview(f.caller), /does not exist/);

    // A target outside the approved roots is refused, even though it is a real directory.
    f.store.writeDestination({ projectId: f.projectId, kind: 'deploy', revision: 2, enabled: true, definition: { kind: 'deploy-local', artifactPath: 'dist', targetDirectory: join(f.elsewhere, 'site') }, actor: OWNER });
    await assert.rejects(f.service.preview(f.caller), /outside the approved roots/);

    // A disabled destination is unavailable.
    f.store.writeDestination({ projectId: f.projectId, kind: 'deploy', revision: 3, enabled: false, definition: { kind: 'deploy-local', artifactPath: 'dist', targetDirectory: f.targetDirectory }, actor: OWNER });
    await assert.rejects(f.service.preview(f.caller), /No enabled local deployment target/);

    // An oversize file is refused rather than truncated.
    f.store.writeDestination({ projectId: f.projectId, kind: 'deploy', revision: 4, enabled: true, definition: { kind: 'deploy-local', artifactPath: 'dist', targetDirectory: f.targetDirectory }, actor: OWNER });
    await writeFile(join(f.project, 'dist', 'big.bin'), Buffer.alloc(LOCAL_RELEASE_MAX_FILE_BYTES + 1));
    await assert.rejects(f.service.preview(f.caller), /outside the documented release bounds/);
  } finally { await f.cleanup(); }
});

test('scope, agent authority and acceptance policy each refuse a deploy with no effect', async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare();
    // The model has no deploy scope: the dispatch authority refuses before the service is reached.
    assert.equal(authorizeToolUse({ scopes: ['accept'], tool: 'deploy_accepted' }).permitted, false);
    assert.equal(authorizeToolUse({ scopes: ['accept', 'deploy'], tool: 'deploy_accepted' }).permitted, true);
    assert.equal(scopeToolIsInstalled('deploy', { acceptedDeploy: true }), true);
    assert.equal(scopeToolIsInstalled('deploy', {}), false, 'the deploy scope has no installed tool unless the instance installs one');

    // An authority check that throws is not caught: nothing is admitted.
    await assert.rejects(f.service.deploy({ ...f.caller, evidenceId: prepared.evidenceId, acceptanceId: prepared.acceptanceId, artifact: prepared.preview.artifact, authorize: async () => { throw new Error('scope revoked'); } }), /scope revoked/);
    assert.equal(f.store.outcomes(f.projectId).length, 0);

    // The acceptance exists, but the policy in force no longer decides deploy full-auto.
    f.acceptance.updatePolicy({ revision: 1, policy: POLICY('ask'), actor: OWNER });
    await assert.rejects(f.deploy(prepared), /does not authorize/);
    assert.equal(f.store.outcomes(f.projectId).length, 0);
    assert.equal(await exists(join(f.targetDirectory, 'current')), false);
  } finally { await f.cleanup(); }
});

test('a duplicate invocation is refused without a second promotion', async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare();
    assert.equal((await f.deploy(prepared) as { status: string }).status, 'succeeded');
    const before = await f.generations();
    await assert.rejects(f.deploy(prepared), /already has an action intent/);
    assert.deepEqual(await f.generations(), before);
    assert.equal(f.store.outcomes(f.projectId).length, 1);
  } finally { await f.cleanup(); }
});

test('an interruption before the swap is uncertain, leaves the served content unchanged and keeps the barrier', async () => {
  const controller = new AbortController();
  const f = await fixture({ seam: { beforeSwap: async () => { controller.abort(); } } });
  try {
    const prepared = await f.prepare();
    const result = await f.deploy(prepared, { signal: controller.signal }) as { status: string; message: string };
    assert.equal(result.status, 'uncertain');
    assert.match(result.message, /may have happened/);
    assert.equal(await exists(join(f.targetDirectory, 'current')), false, 'the swap never started');
    await assert.rejects(f.deploy(prepared), /already has an action intent/);
    assert.equal(await exists(join(f.targetDirectory, 'current')), false);
  } finally { await f.cleanup(); }
});

test('an interruption after the swap is uncertain, never replays, and its effect is visible for inspection', async () => {
  const f = await fixture({ seam: { afterSwap: () => { throw new Error('fixture interruption'); } } });
  try {
    const prepared = await f.prepare();
    const result = await f.deploy(prepared) as { status: string };
    assert.equal(result.status, 'uncertain');
    const link = join(f.targetDirectory, 'current');
    assert.equal(await exists(link), true, 'the swap completed before the interruption');
    assert.equal(await readFile(join(link, 'index.html'), 'utf8'), '<h1>one</h1>');
    const before = await f.generations();
    await assert.rejects(f.deploy(prepared), /already has an action intent/);
    assert.deepEqual(await f.generations(), before, 'no automatic replay');
  } finally { await f.cleanup(); }
});

test('a current node this tool did not create, or one pointing outside generations, is refused untouched', async () => {
  for (const shape of ['file', 'escaping-link'] as const) {
    const f = await fixture();
    try {
      const current = join(f.targetDirectory, 'current');
      if (shape === 'file') await writeFile(current, 'not a link this tool created');
      else await symlink(f.elsewhere, current);
      await assert.rejects(f.service.preview(f.caller), /not a link this build created|outside/);
      const info = await lstat(current);
      assert.equal(info.isSymbolicLink(), shape === 'escaping-link', shape + ': the foreign node is unchanged');
      if (shape === 'escaping-link') assert.equal(await realpath(current), await realpath(f.elsewhere), 'the foreign link still points where it did');
    } finally { await f.cleanup(); }
  }
});

test('a fork refuses both the preview and the effect before anything is read or written', async () => {
  const f = await fixture();
  try {
    const forkService = new LocalDeployService({
      store: f.store, acceptance: f.acceptance, executor: new AcceptedActionExecutor(f.control),
      projectRoot: () => f.project, approvedRoots: [f.served],
      sessionGate: () => { throw new Error('unavailable in a fork'); }
    });
    await assert.rejects(forkService.preview(f.caller), /unavailable in a fork/);
    assert.equal(await exists(join(f.targetDirectory, 'current')), false, 'no deployment state was created');
  } finally { await f.cleanup(); }
});
