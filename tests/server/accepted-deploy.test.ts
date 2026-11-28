import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { ActionTargetStore } from '../../src/server/state/action-target-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { AcceptedDeployService } from '../../src/server/agents/accepted-deploy';
import { CloudflareWorkerDeployTransport, cloudflareWorkerResourceDigest } from '../../src/server/agents/cloudflare-worker-deploy';
import { acceptAgentEvidence } from '../../src/server/agents/accept-evidence';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import type { AgentScope } from '../../src/shared/agent-registry';

const accountId = 'a'.repeat(32), workerName = 'fixture-worker', versionId = '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f', deploymentId = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e', token = 'fixture_token_not_real';
const resourceDigest = cloudflareWorkerResourceDigest(accountId, workerName);
const version = () => ({ success: true, result: { id: versionId, resources: { bindings: [], script_runtime: { exports: {} } } } });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-deploy-fixture-')), source = join(root, 'source'), data = join(root, 'data');
  await Promise.all([mkdir(source), mkdir(data)]);
  const projectId = randomUUID(), project = { id: projectId, name: 'Deploy fixture', path: source, managed: true, repository: '', created: '' };
  const control = new ControlStore(data), targets = new ActionTargetStore(control), acceptance = new AcceptanceStore(control, { projectRoot: id => id === projectId ? source : undefined });
  const definition = { kind: 'deploy' as const, integrationId: 'fixture-cloudflare', serviceId: 'fixture-worker', environmentId: 'production', resourceDigest };
  targets.write({ projectId, targetId: 'deploy-target', revision: 0, enabled: true, definition, actor: { kind: 'owner', identity: 'fixture' } });
  acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'ask', deploy: 'full-auto', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
  let posts = 0, behavior: 'ok' | 'lost' | 'abort' = 'ok', onPost = () => {};
  const requests: { url: string; method: string; body?: string; redirect?: RequestRedirect; auth: string | null }[] = [];
  // Every fetch is intercepted: this fixture never reaches Cloudflare or any external service.
  const fakeFetch: typeof fetch = async (url, init) => {
    const method = init?.method ?? 'GET', headers = new Headers(init?.headers);
    requests.push({ url: String(url), method, body: init?.body as string | undefined, redirect: init?.redirect, auth: headers.get('authorization') });
    assert.equal(method, 'GET'); return response(version());
  };
  const inspector = new CloudflareWorkerDeployTransport({ accountId, workerName, token: async () => token, fetch: fakeFetch });
  // Synthetic effect only: the real Cloudflare transport refuses every deployment.
  const transport = {
    inspect: (input: Parameters<typeof inspector.inspect>[0]) => inspector.inspect(input),
    deploy: async (input: { resourceDigest: string; versionId: string; signal?: AbortSignal }) => {
      posts++; onPost(); if (behavior === 'lost') throw Error('fixture lost reply ' + token);
      return { resourceDigest: input.resourceDigest, versionId: input.versionId, deploymentId };
    }
  };
  const service = new AcceptedDeployService({ projectId, targetId: 'deploy-target', targetRevision: 1, targets, acceptance, executor: new AcceptedActionExecutor(control), transport, targetCurrent: async (project, session) => project === projectId && session === String(ROOT_CONVERSATION_ID) });
  const caller = { projectId, sessionId: String(ROOT_CONVERSATION_ID), agentId: 'agent', authorize: async () => {} };
  const record = async () => {
    const preview = await service.preview({ ...caller, versionId });
    const evidence = await acceptance.recordEvidence({ projectId, evidence: { sessionId: caller.sessionId, subject: { kind: 'session', id: caller.sessionId }, artifact: preview.artifact, commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: 'fixture claim', reference: null }, tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-01T00:00:00.000Z' } });
    return { preview, evidenceId: evidence.evidence.record.id };
  };
  const accept = async (evidenceId: string, artifact: Awaited<ReturnType<typeof record>>['preview']['artifact']) => (await acceptance.accept({ authorizeAdmission: () => {}, projectId, request: { evidenceId, artifact, actionClass: 'deploy', actor: { kind: 'agent', identity: 'agent' } } })).acceptance;
  return { root, source, data, projectId, project, control, targets, acceptance, definition, service, transport, caller, record, accept, requests, count: () => posts, setBehavior: (value: typeof behavior) => { behavior = value; }, setOnPost: (fn: () => void) => { onPost = fn; }, cleanup: async () => { control.close(); await rm(root, { recursive: true, force: true }); } };
}

test('an injected model previews, accepts and requests an exact Worker version through a synthetic deployment effect', async () => {
  const f = await fixture(), fake = fauxProvider({ provider: 'deploy-faux', models: [{ id: 'fixture' }] }), providers = new ProviderStore(f.root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'deploy-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  let scopes: readonly AgentScope[] = ['accept', 'deploy'];
  const host = new HarnessHost({ dataRoot: f.root, enabled: true, providers,
    privileges: { authority: async () => ({ agentId: 'agent', model: null, scopes, projects: [f.projectId], emptyReason: null }) },
    acceptanceTools: { read: projectId => f.acceptance.readProject({ projectId }), accept: input => acceptAgentEvidence(f.acceptance, { ...input, verifyAdmission: () => {} }) },
    acceptedDeployTools: { preview: input => f.service.preview(input), deploy: input => f.service.deploy(input) }
  });
  try {
    const { preview, evidenceId } = await f.record();
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('deploy_preview', { versionId })], { stopReason: 'toolUse' }), () => fauxAssistantMessage([fauxToolCall('acceptance_accept', { evidenceId, artifact: preview.artifact, actionClass: 'deploy' })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Deploy evidence accepted.')]);
    const wait = async (text: string) => { const end = Date.now() + 10000; while (!(await host.view(f.project)).entries.some(entry => entry.text.includes(text))) { if (Date.now() > end) throw Error('run did not finish'); await new Promise(resolve => setTimeout(resolve, 20)); } };
    await host.submit(f.project, { text: 'Inspect and accept', mode: 'followUp' }); await wait('Deploy evidence accepted.');
    const accepted = (await f.acceptance.readEvidence({ projectId: f.projectId, evidenceId })).acceptance; assert.ok(accepted);
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('deploy_accepted', { versionId, evidenceId, acceptanceId: accepted.id, artifact: preview.artifact })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Deploy finished.')]);
    await host.submit(f.project, { text: 'Deploy the accepted version', mode: 'followUp' }); await wait('Deploy finished.');
    assert.equal(f.count(), 1); assert.match(JSON.stringify((await host.view(f.project)).entries), /succeeded/);
    const inspected = f.requests[0]; assert.ok(inspected);
    assert.equal(inspected.url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/versions/${versionId}`);
    assert.equal(inspected.redirect, 'error'); assert.equal(inspected.auth, 'Bearer ' + token);
    assert.ok(f.requests.every(item => item.method === 'GET'));
    assert.doesNotMatch(JSON.stringify((await host.view(f.project)).entries), new RegExp(token));
    await assert.rejects(f.service.deploy({ ...f.caller, versionId, evidenceId, acceptanceId: accepted.id, artifact: preview.artifact }), /already has an action intent/);
    scopes = []; fake.setResponses([() => fauxAssistantMessage([fauxToolCall('deploy_preview', { versionId })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Revoked deploy checked.')]);
    await host.submit(f.project, { text: 'Try revoked deploy', mode: 'followUp' }); await wait('Revoked deploy checked.');
    assert.match(JSON.stringify((await host.view(f.project)).entries), /refused|not permitted/i); assert.equal(f.count(), 1);
  } finally { await host.close(); await providers.close(); await f.cleanup(); }
});

test('lost deployment response or post-admission cancellation is uncertain and not replayed after reopen', async () => {
  for (const kind of ['lost', 'abort'] as const) {
    const f = await fixture(), controller = new AbortController();
    try {
      const { preview, evidenceId } = await f.record(), accepted = await f.accept(evidenceId, preview.artifact);
      if (kind === 'lost') f.setBehavior('lost'); else f.setOnPost(() => controller.abort());
      const result = await f.service.deploy({ ...f.caller, versionId, evidenceId, acceptanceId: accepted.id, artifact: preview.artifact, signal: controller.signal });
      assert.equal(result.status, 'uncertain'); assert.equal(f.count(), 1); assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
      const reopened = new ControlStore(f.data);
      try {
        const service = new AcceptedDeployService({ projectId: f.projectId, targetId: 'deploy-target', targetRevision: 1, targets: new ActionTargetStore(reopened), acceptance: new AcceptanceStore(reopened, { projectRoot: id => id === f.projectId ? f.source : undefined }), executor: new AcceptedActionExecutor(reopened), transport: f.transport, targetCurrent: async () => true });
        await assert.rejects(service.deploy({ ...f.caller, versionId, evidenceId, acceptanceId: accepted.id, artifact: preview.artifact }), /already has an action intent/);
      } finally { reopened.close(); }
      assert.equal(f.count(), 1);
    } finally { await f.cleanup(); }
  }
});

test('revoked scope, changed policy, target, version or resource refuse before the deployment effect', async () => {
  for (const kind of ['scope', 'policy', 'target', 'version', 'resource'] as const) {
    const f = await fixture();
    try {
      const { preview, evidenceId } = await f.record(), accepted = await f.accept(evidenceId, preview.artifact);
      if (kind === 'policy') f.acceptance.updatePolicy({ revision: 1, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
      if (kind === 'target') f.targets.write({ projectId: f.projectId, targetId: 'deploy-target', revision: 1, enabled: false, definition: f.definition, actor: { kind: 'owner', identity: 'fixture' } });
      if (kind === 'resource') f.transport.inspect = async input => ({ resourceDigest: 'b'.repeat(64), versionId: input.versionId });
      const authorize = async () => { if (kind === 'scope') throw Error('scope revoked'); };
      await assert.rejects(f.service.deploy({ ...f.caller, authorize, versionId: kind === 'version' ? randomUUID() : versionId, evidenceId, acceptanceId: accepted.id, artifact: preview.artifact }));
      assert.equal(f.count(), 0);
    } finally { await f.cleanup(); }
  }
});

test('Cloudflare inspection rejects unknown metadata and deploy fails closed even when tombstones are omitted', async () => {
  for (const payload of [
    { success: true, result: { id: versionId } },
    { success: true, result: { id: versionId, resources: { bindings: [{ type: 'secret_text' }], script_runtime: { exports: {} } } } },
    { success: true, result: { id: versionId, resources: { bindings: [], script_runtime: { exports: { Example: { type: 'durable-object', state: 'deleted' } } } } } },
    { success: true, result: { id: versionId, resources: { bindings: [], script_runtime: { exports: { Example: { type: 'future-kind' } } } } } }
  ]) {
    const transport = new CloudflareWorkerDeployTransport({ accountId, workerName, token: async () => token, fetch: async () => response(payload) });
    await assert.rejects(transport.inspect({ resourceDigest, versionId }), /unverified/);
  }
  let calls = 0;
  const omittedTombstone = new CloudflareWorkerDeployTransport({ accountId, workerName, token: async () => token, fetch: async (_url, init) => { calls++; assert.equal(init?.method, 'GET'); return response(version()); } });
  await omittedTombstone.inspect({ resourceDigest, versionId });
  await assert.rejects(omittedTombstone.deploy({ resourceDigest, versionId }), /migration transition cannot be verified/);
  assert.equal(calls, 1); // No POST even though the observed export map is empty.
  const oversize = new CloudflareWorkerDeployTransport({ accountId, workerName, token: async () => token, fetch: async () => response({ text: 'x'.repeat(300000) }) });
  await assert.rejects(oversize.inspect({ resourceDigest, versionId }), /unavailable or unverified/);
  const failing = new CloudflareWorkerDeployTransport({ accountId, workerName, token: async () => token, fetch: async () => { throw Error('secret ' + token); } });
  await assert.rejects(failing.inspect({ resourceDigest, versionId }), (error: Error) => !error.message.includes(token));
  await assert.rejects(failing.deploy({ resourceDigest: '0'.repeat(64), versionId }), /does not match/);
  assert.throws(() => cloudflareWorkerResourceDigest(accountId, '../fixture'), /Invalid/);
});
