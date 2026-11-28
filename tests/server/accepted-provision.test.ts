import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { AcceptedProvisionService, ProvisionStore, PROVISION_MANIFEST_FILE, type ProvisionFilesystem } from '../../src/server/agents/accepted-provision';
import type { AgentScope } from '../../src/shared/agent-registry';

const targetId = 'pilot-provision';

async function fixture(options: { features?: { readonly opens?: boolean } } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pilot-provision-fixture-')), source = join(base, 'source'), data = join(base, 'data'), approved = join(base, 'approved');
  await Promise.all([mkdir(source), mkdir(data), mkdir(approved)]);
  const projectId = randomUUID(), control = new ControlStore(data);
  const acceptance = new AcceptanceStore(control, { projectRoot: id => id === projectId ? source : undefined });
  acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'full-auto', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
  let scopes: readonly AgentScope[] = ['accept', 'provision'];
  const caller = {
    projectId,
    sessionId: randomUUID(),
    agentId: 'agent',
    authorize: async () => { if (!scopes.includes('provision')) throw new Error('scope revoked'); }
  };
  const store = options.features?.opens === true ? { inspect: () => { throw new Error('unused'); }, publish: () => { throw new Error('unused'); } } as ProvisionFilesystem : new ProvisionStore({ root: approved, targetId });
  const service = new AcceptedProvisionService({ projectId, targetId, targetRevision: 1, root: approved, store, acceptance, executor: new AcceptedActionExecutor(control) });
  const record = async (resource: string, version: string) => {
    const preview = await service.preview({ ...caller, resource, version });
    const evidence = await acceptance.recordEvidence({
      projectId,
      evidence: {
        sessionId: caller.sessionId, subject: { kind: 'session', id: caller.sessionId }, artifact: preview.artifact,
        commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: 'fixture claim', reference: null },
        tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }],
        review: null, producedAt: '2026-01-01T00:00:00.000Z'
      }
    });
    const accepted = (await acceptance.accept({ authorizeAdmission: () => {}, projectId, request: { evidenceId: evidence.evidence.record.id, artifact: preview.artifact, actionClass: 'provision', actor: { kind: 'agent', identity: 'agent' } } })).acceptance;
    return { preview, evidenceId: evidence.evidence.record.id, acceptanceId: accepted.id };
  };
  const resourceDirectory = join(approved, projectId, targetId);
  return {
    base, source, data, approved, projectId, control, acceptance, caller, service, record, resourceDirectory,
    setScopes: (value: readonly AgentScope[]) => { scopes = value; },
    cleanup: async () => { control.close(); await rm(base, { recursive: true, force: true }); }
  };
}

test('provision creates exactly one Pilot-owned resource and repeats idempotently from its durable receipt', async () => {
  const f = await fixture();
  try {
    const first = await f.record('fixture-resource', '1.0.0');
    assert.equal(first.preview.state, 'absent');
    const created = await f.service.provision({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact });
    assert.equal(created.status, 'succeeded');
    if (created.status !== 'succeeded') return;
    assert.equal(created.repeated, false);
    assert.match(created.receipt.externalId, /^provision-[a-f0-9]{64}$/);
    const manifest = JSON.parse(await readFile(join(f.resourceDirectory, PROVISION_MANIFEST_FILE), 'utf8'));
    assert.deepEqual({ projectId: manifest.projectId, targetId: manifest.targetId, resource: manifest.resource, version: manifest.version }, { projectId: f.projectId, targetId, resource: 'fixture-resource', version: '1.0.0' });
    assert.deepEqual((await readdir(join(f.approved, f.projectId))).sort(), [targetId], 'no staging directory is left behind');
    assert.equal((await lstat(f.resourceDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(f.resourceDirectory, PROVISION_MANIFEST_FILE))).mode & 0o777, 0o600);

    const repeated = await f.service.provision({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact });
    assert.equal(repeated.status, 'succeeded');
    if (repeated.status !== 'succeeded') return;
    assert.equal(repeated.repeated, true);
    assert.equal(repeated.operationId, created.operationId);
    assert.equal(repeated.receipt.externalId, created.receipt.externalId);
    assert.equal((await f.service.preview({ ...f.caller, resource: 'fixture-resource', version: '1.0.0' })).state, 'present');
  } finally { await f.cleanup(); }
});

test('changed content conflicts with the existing resource instead of replacing it', async () => {
  const f = await fixture();
  try {
    const first = await f.record('fixture-resource', '1.0.0');
    assert.equal((await f.service.provision({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact })).status, 'succeeded');
    const second = await f.record('fixture-resource', '2.0.0');
    assert.equal(second.preview.state, 'conflict');
    assert.deepEqual(second.preview.existing, { resource: 'fixture-resource', version: '1.0.0' });
    assert.equal(second.preview.artifact.revision === first.preview.artifact.revision, false);
    await assert.rejects(f.service.provision({ ...f.caller, resource: 'fixture-resource', version: '2.0.0', evidenceId: second.evidenceId, acceptanceId: second.acceptanceId, artifact: second.preview.artifact }), /already holds a different resource/);
    const manifest = JSON.parse(await readFile(join(f.resourceDirectory, PROVISION_MANIFEST_FILE), 'utf8'));
    assert.equal(manifest.version, '1.0.0');
  } finally { await f.cleanup(); }
});

test('path escapes, symlinks, unowned targets and oversize input are refused before anything is published', async () => {
  const f = await fixture();
  try {
    assert.throws(() => new ProvisionStore({ root: relative(process.cwd(), f.approved), targetId }), /absolute path/);
    assert.throws(() => new ProvisionStore({ root: f.approved, targetId: '../escape' }), /target id is invalid/);
    assert.throws(() => new AcceptedProvisionService({ projectId: f.projectId, targetId: '../escape', targetRevision: 1, root: f.approved, store: new ProvisionStore({ root: f.approved, targetId }), acceptance: f.acceptance, executor: new AcceptedActionExecutor(f.control) }), /Invalid provisioning target/);

    const first = await f.record('fixture-resource', '1.0.0');
    const attempt = () => f.service.provision({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact });

    // A symlinked resource target is not read or written, even if it points at a valid directory.
    const elsewhere = join(f.base, 'elsewhere');
    await mkdir(elsewhere);
    await mkdir(join(f.approved, f.projectId));
    await symlink(elsewhere, f.resourceDirectory);
    await assert.rejects(attempt(), /symbolic link/);
    assert.deepEqual(await readdir(elsewhere), []);
    await rm(f.resourceDirectory);

    // A symlinked project directory is refused for the same reason.
    await rm(join(f.approved, f.projectId), { recursive: true });
    await symlink(elsewhere, join(f.approved, f.projectId));
    await assert.rejects(attempt(), /project directory is not a real directory/);
    await rm(join(f.approved, f.projectId));

    // A non-empty directory that no Pilot manifest owns is refused and left untouched.
    await mkdir(f.resourceDirectory, { recursive: true });
    await writeFile(join(f.resourceDirectory, 'unrelated.txt'), 'not mine');
    await assert.rejects(attempt(), /not a Pilot-owned resource/);
    assert.deepEqual(await readdir(f.resourceDirectory), ['unrelated.txt']);
    await rm(join(f.approved, f.projectId), { recursive: true });

    // An unparseable Pilot-shaped manifest is unowned, and an oversized description is refused.
    await mkdir(f.resourceDirectory, { recursive: true });
    await writeFile(join(f.resourceDirectory, PROVISION_MANIFEST_FILE), '{"schema":1}');
    await assert.rejects(attempt(), /does not recognize/);
    await rm(join(f.approved, f.projectId), { recursive: true });
    await assert.rejects(f.service.preview({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', description: 'x'.repeat(201) }), /at most 200 characters/);
    await assert.rejects(f.service.preview({ ...f.caller, resource: 'Not A Slug', version: '1.0.0' }), /resource name/);
  } finally { await f.cleanup(); }
});

test('a revoked scope or a policy that no longer permits provision refuses with no resource', async () => {
  const f = await fixture();
  try {
    const first = await f.record('fixture-resource', '1.0.0');
    f.setScopes(['accept']);
    await assert.rejects(f.service.provision({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact }), /scope revoked/);
    assert.deepEqual(await readdir(f.approved), []);

    f.setScopes(['accept', 'provision']);
    f.acceptance.updatePolicy({ revision: 1, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
    await assert.rejects(f.service.provision({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact }), /does not authorize|policy/);
    assert.deepEqual(await readdir(f.approved), []);
  } finally { await f.cleanup(); }
});

test('an interruption after publication is uncertain, and the durable intent is never replayed', async () => {
  const f = await fixture();
  try {
    const first = await f.record('fixture-resource', '1.0.0');
    const real = new ProvisionStore({ root: f.approved, targetId });
    let publications = 0;
    const interrupting: ProvisionFilesystem = {
      inspect: input => real.inspect(input),
      publish: async input => { publications++; const published = await real.publish(input); throw new Error('interrupted after publication'); }
    };
    const service = new AcceptedProvisionService({ projectId: f.projectId, targetId, targetRevision: 1, root: f.approved, store: interrupting, acceptance: f.acceptance, executor: new AcceptedActionExecutor(f.control) });
    const uncertain = await service.provision({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact });
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(publications, 1);
    assert.ok(JSON.parse(await readFile(join(f.resourceDirectory, PROVISION_MANIFEST_FILE), 'utf8')).digest);

    const replay = await service.provision({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact });
    assert.equal(replay.status, 'uncertain');
    assert.equal(publications, 1, 'the interrupted attempt is not published again');

    const reopened = new ControlStore(f.data);
    try {
      const afterRestart = new AcceptedProvisionService({ projectId: f.projectId, targetId, targetRevision: 1, root: f.approved, store: interrupting, acceptance: new AcceptanceStore(reopened, { projectRoot: id => id === f.projectId ? f.source : undefined }), executor: new AcceptedActionExecutor(reopened) });
      assert.equal((await afterRestart.provision({ ...f.caller, resource: 'fixture-resource', version: '1.0.0', evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact })).status, 'uncertain');
      assert.equal(publications, 1);
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});
