import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat,mkdir,mkdtemp,readdir,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { LocalReleaseStore } from '../../src/server/state/local-release-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { LocalPublishService } from '../../src/server/agents/local-publish';
import type { LocalReleaseSeam } from '../../src/server/agents/local-deploy';
import { LOCAL_RELEASE_MAX_FILE_BYTES } from '../../src/server/agents/local-release';
import { acceptAgentEvidence } from '../../src/server/agents/accept-evidence';
import { authorizeToolUse,scopeToolIsInstalled } from '../../src/shared/agent-registry';

/**
 * The installed local publish capability: an exact, bounded set of reviewed files copied into an
 * owner-configured local publication root through a staged copy and one atomic rename.
 *
 * Everything runs over a disposable root. There is no provider, no network and no live project.
 */

const OWNER = Object.freeze({ kind: 'owner' as const, identity: 'fixture-owner' });
const POLICY = (publish: 'ask' | 'full-auto') => ({ mode: 'agent-may-accept' as const, actionClasses: { commit: 'ask' as const, push: 'ask' as const, deploy: 'ask' as const, spend: 'ask' as const, provision: 'ask' as const, publish } });

async function fixture(options: { seam?: LocalReleaseSeam } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-local-publish-'));
  const project = join(root, 'project'), publicRoot = join(root, 'public'), elsewhere = join(root, 'elsewhere'), data = join(root, 'data');
  await mkdir(join(project, 'docs'), { recursive: true, mode: 0o755 });
  await mkdir(publicRoot, { recursive: true, mode: 0o755 });
  await mkdir(elsewhere, { recursive: true, mode: 0o755 });
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(project, 'README.md'), '# Reviewed readme\n');
  await writeFile(join(project, 'docs', 'index.html'), '<h1>Reviewed</h1>');
  const projectId = randomUUID(), sessionId = randomUUID(), agentId = 'agent-publisher';
  const control = new ControlStore(data);
  const acceptance = new AcceptanceStore(control, { projectRoot: (id) => (id === projectId ? project : undefined) });
  const store = new LocalReleaseStore(control);
  store.writeDestination({ projectId, kind: 'publish', revision: 0, enabled: true, definition: { kind: 'publish-local', publicationRoot: publicRoot }, actor: OWNER });
  acceptance.updatePolicy({ revision: 0, policy: POLICY('full-auto'), actor: OWNER });
  const service = new LocalPublishService({
    store, acceptance, executor: new AcceptedActionExecutor(control),
    projectRoot: (id) => (id === projectId ? project : undefined),
    approvedRoots: [publicRoot], seam: options.seam
  });
  const caller = { projectId, sessionId, agentId, authorize: async () => {} };
  const files = ['README.md', 'docs/index.html'];
  const prepare = async (selected: readonly string[] = files) => {
    const preview = await service.preview({ ...caller, files: selected }) as { artifact: { revision: string; commit: string | null }; contentDigest: string };
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
      actionClass: 'publish', agentId, authorize: async () => {}, verifyAdmission: () => {}
    });
    return { preview, files: selected, evidenceId: evidence.evidence.record.id, acceptanceId: accepted.acceptance.id };
  };
  const publish = (prepared: Awaited<ReturnType<typeof prepare>>, over: Record<string, unknown> = {}) => service.publish({ ...caller, files: prepared.files, evidenceId: prepared.evidenceId, acceptanceId: prepared.acceptanceId, artifact: prepared.preview.artifact, ...over });
  const published = async () => (await readdir(publicRoot).catch(() => [] as string[])).filter((name) => name.startsWith('publish-')).sort();
  const cleanup = async () => { control.close(); await rm(root, { recursive: true, force: true }); };
  return { root, project, publicRoot, elsewhere, data, projectId, sessionId, agentId, control, acceptance, store, service, caller, files, prepare, publish, published, cleanup };
}

const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true).catch(() => false);

test('publish copies exactly the reviewed files into the configured root and reads their digests back', async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare();
    const result = await f.publish(prepared) as { status: string; contentDigest: string; publication: string | null; receipt: { externalId: string } };
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.contentDigest, prepared.preview.contentDigest);
    assert.deepEqual(await f.published(), [result.publication]);
    const directory = join(f.publicRoot, result.publication!);
    assert.equal(await readFile(join(directory, 'README.md'), 'utf8'), '# Reviewed readme\n');
    assert.equal(await readFile(join(directory, 'docs', 'index.html'), 'utf8'), '<h1>Reviewed</h1>');
    assert.equal(result.receipt.externalId, result.publication);
    const outcomes = f.store.outcomes(f.projectId);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].externalId, result.publication);
    assert.equal(outcomes[0].previousGeneration, null);
  } finally { await f.cleanup(); }
});

test('a path escape, a symlink, a non-regular file and an oversize file are refused before any copy', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.preview({ ...f.caller, files: ['../secret.txt'] }), /empty, current or parent segment|relative path/);
    await assert.rejects(f.service.preview({ ...f.caller, files: ['/etc/passwd'] }), /relative path/);

    await writeFile(join(f.root, 'outside.md'), 'outside');
    await symlink(join(f.root, 'outside.md'), join(f.project, 'link.md'));
    await assert.rejects(f.service.preview({ ...f.caller, files: ['link.md'] }), /symbolic link/);
    await rm(join(f.project, 'link.md'));

    await mkdir(join(f.project, 'folder.md'), { recursive: true });
    await assert.rejects(f.service.preview({ ...f.caller, files: ['folder.md'] }), /not a regular file/);
    await rm(join(f.project, 'folder.md'), { recursive: true });

    await writeFile(join(f.project, 'big.bin'), Buffer.alloc(LOCAL_RELEASE_MAX_FILE_BYTES + 1));
    await assert.rejects(f.service.preview({ ...f.caller, files: ['big.bin'] }), /outside the documented release bounds/);

    await assert.rejects(f.service.preview({ ...f.caller, files: ['missing.md'] }), /does not exist/);
    assert.equal((await f.published()).length, 0);
  } finally { await f.cleanup(); }
});

test('a changed file, an unapproved root and a revoked policy each refuse with no publication', async () => {
  const f = await fixture();
  try {
    // A real directory that is not one of this instance's approved roots is refused.
    const outsideRoot = join(f.elsewhere, 'public');
    await mkdir(outsideRoot, { recursive: true });
    f.store.writeDestination({ projectId: f.projectId, kind: 'publish', revision: 1, enabled: true, definition: { kind: 'publish-local', publicationRoot: outsideRoot }, actor: OWNER });
    await assert.rejects(f.service.preview({ ...f.caller, files: f.files }), /outside the approved roots/);
    f.store.writeDestination({ projectId: f.projectId, kind: 'publish', revision: 2, enabled: true, definition: { kind: 'publish-local', publicationRoot: f.publicRoot }, actor: OWNER });

    const prepared = await f.prepare();
    await writeFile(join(f.project, 'README.md'), '# changed after review\n');
    await assert.rejects(f.publish(prepared), /does not bind|changed since/);
    assert.equal((await f.published()).length, 0);

    await writeFile(join(f.project, 'README.md'), '# Reviewed readme\n');
    // The acceptance exists under full-auto, but the policy in force no longer decides publish full-auto.
    f.acceptance.updatePolicy({ revision: 1, policy: POLICY('ask'), actor: OWNER });
    await assert.rejects(f.publish(prepared), /does not authorize/);
    assert.equal((await f.published()).length, 0);
  } finally { await f.cleanup(); }
});

test('scope and agent authority refuse a publish with no effect', async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare();
    assert.equal(authorizeToolUse({ scopes: ['accept', 'deploy'], tool: 'publish_accepted' }).permitted, false);
    assert.equal(authorizeToolUse({ scopes: ['accept', 'publish'], tool: 'publish_accepted' }).permitted, true);
    assert.equal(authorizeToolUse({ scopes: ['publish'], tool: 'publish_preview' }).permitted, true);
    assert.equal(scopeToolIsInstalled('publish', { localPublish: true }), true);
    assert.equal(scopeToolIsInstalled('publish', {}), false, 'the publish scope has no installed tool unless the instance installs one');
    await assert.rejects(f.service.publish({ ...f.caller, files: prepared.files, evidenceId: prepared.evidenceId, acceptanceId: prepared.acceptanceId, artifact: prepared.preview.artifact, authorize: async () => { throw new Error('scope revoked'); } }), /scope revoked/);
    assert.equal(f.store.outcomes(f.projectId).length, 0);
  } finally { await f.cleanup(); }
});

test('a duplicate publication invocation is refused without a second copy', async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare();
    assert.equal((await f.publish(prepared) as { status: string }).status, 'succeeded');
    const before = await f.published();
    await assert.rejects(f.publish(prepared), /already has an action intent/);
    assert.deepEqual(await f.published(), before);
    assert.equal(f.store.outcomes(f.projectId).length, 1);
  } finally { await f.cleanup(); }
});

test('an interruption before the rename is uncertain, publishes nothing and keeps the barrier', async () => {
  const controller = new AbortController();
  const f = await fixture({ seam: { beforeSwap: async () => { controller.abort(); } } });
  try {
    const prepared = await f.prepare();
    const result = await f.publish(prepared, { signal: controller.signal }) as { status: string };
    assert.equal(result.status, 'uncertain');
    assert.equal((await f.published()).length, 0);
    await assert.rejects(f.publish(prepared), /already has an action intent/);
    assert.equal((await f.published()).length, 0);
  } finally { await f.cleanup(); }
});
