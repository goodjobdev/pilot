import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProvisionConfiguration, resolveSpendConfiguration } from '../../src/server/agents/action-config';

async function roots() {
  const base = await mkdtemp(join(tmpdir(), 'pilot-action-config-')), data = join(base, 'data'), project = join(base, 'project'), approved = join(base, 'approved');
  await Promise.all([mkdir(data), mkdir(project), mkdir(approved)]);
  return { base, data, project, approved };
}

test('provisioning config is absent when off and refuses every unsafe approved root', async () => {
  const f = await roots();
  try {
    assert.equal(await resolveProvisionConfiguration({ enabled: false, configured: undefined, hasControlStore: false, dataRoot: f.data, projectRoots: [] }), undefined);
    const resolve = (configured: unknown, projectRoots: readonly string[] = []) => resolveProvisionConfiguration({ enabled: true, configured, hasControlStore: true, dataRoot: f.data, projectRoots });
    await assert.rejects(resolve(undefined), /absolute owner-approved root/);
    await assert.rejects(resolve('relative/root'), /absolute owner-approved root/);
    await assert.rejects(resolve(join(f.base, 'missing')), /existing real directory/);
    const linked = join(f.base, 'linked');
    await symlink(f.approved, linked);
    await assert.rejects(resolve(linked), /symbolic link/);
    await assert.rejects(resolve(f.data), /must not overlap the data root/);
    assert.deepEqual(await resolve(f.approved), { root: await realpath(f.approved) });
  } finally { await rm(f.base, { recursive: true, force: true }); }
  await assert.rejects(resolveProvisionConfiguration({ enabled: true, configured: '/tmp', hasControlStore: false, dataRoot: '/tmp', projectRoots: [] }), /durable control store/);
});

test('provisioning refuses a root that contains a project or the data root', async () => {
  const f = await roots();
  try {
    const config = (configured: string) => resolveProvisionConfiguration({ enabled: true, configured, hasControlStore: true, dataRoot: f.data, projectRoots: [f.project] });
    await assert.rejects(config(f.base), /overlap the data root/);
    const container = join(f.base, 'container');
    await mkdir(container);
    const project = join(container, 'project');
    await mkdir(project);
    await assert.rejects(resolveProvisionConfiguration({ enabled: true, configured: container, hasControlStore: true, dataRoot: f.data, projectRoots: [project] }), /overlap a registered project root/);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('spending config is absent when off and needs one endpoint, account, currency and both caps', async () => {
  const base = {
    enabled: true, hasControlStore: true, endpoint: 'https://billing.example.test/charge', accountId: 'fixture-account', currency: 'USD',
    projectCapMinor: 1000, chargeCapMinor: 500, timeoutMs: 10000
  };
  assert.equal(await resolveSpendConfiguration({ ...base, enabled: false }), undefined);
  await assert.rejects(resolveSpendConfiguration({ ...base, endpoint: 'http://billing.example.test/charge' }), /HTTPS/);
  assert.equal((await resolveSpendConfiguration({ ...base, endpoint: 'http://127.0.0.1:8080/charge' }))?.endpoint, 'http://127.0.0.1:8080/charge');
  await assert.rejects(resolveSpendConfiguration({ ...base, accountId: '' }), /billing account/);
  await assert.rejects(resolveSpendConfiguration({ ...base, currency: 'usd' }), /three-letter currency/);
  await assert.rejects(resolveSpendConfiguration({ ...base, projectCapMinor: 0 }), /PROJECT_CAP_MINOR/);
  await assert.rejects(resolveSpendConfiguration({ ...base, chargeCapMinor: 1.5 }), /CHARGE_CAP_MINOR/);
  await assert.rejects(resolveSpendConfiguration({ ...base, timeoutMs: 0 }), /TIMEOUT_MS/);
  await assert.rejects(resolveSpendConfiguration({ ...base, hasControlStore: false }), /durable control store/);
  assert.deepEqual(await resolveSpendConfiguration(base), { endpoint: 'https://billing.example.test/charge', accountId: 'fixture-account', currency: 'USD', projectCapMinor: 1000, chargeCapMinor: 500, timeoutMs: 10000 });
});
