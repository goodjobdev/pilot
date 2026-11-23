import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { SpendBudget } from '../../src/server/state/spend-budget';
import { AcceptedProvisionService, ProvisionStore, PROVISION_MANIFEST_FILE } from '../../src/server/agents/accepted-provision';
import { AcceptedSpendService, HttpBillingTransport, readSpendBillingToken } from '../../src/server/agents/accepted-spend';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import type { AgentScope } from '../../src/shared/agent-registry';

const targetId = 'pilot-provision', spendTargetId = 'pilot-spend', accountId = 'fixture-account', token = 'fixture_billing_token_not_real_1234', sessionId = String(ROOT_CONVERSATION_ID);

async function billingStub() {
  const requests: unknown[] = [];
  let charges = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      charges += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ chargeId: 'ch_' + charges }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/charge', requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}

test('the harness installs the provisioning and spend tools and refuses them without the live scope', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pilot-action-tools-')), source = join(base, 'source'), data = join(base, 'data'), approved = join(base, 'approved');
  await Promise.all([mkdir(source), mkdir(data), mkdir(approved)]);
  await mkdir(join(data, 'credentials'), { mode: 0o700 });
  await writeFile(join(data, 'credentials', 'spend-billing.json'), JSON.stringify({ version: 1, token }), { mode: 0o600 });
  const billing = await billingStub(), projectId = randomUUID(), project = { id: projectId, name: 'Action tools fixture', path: source, managed: true, repository: '', created: '' };
  const fake = fauxProvider({ provider: 'action-faux', models: [{ id: 'fixture' }] }), control = new ControlStore(data), acceptance = new AcceptanceStore(control, { projectRoot: id => id === projectId ? source : undefined });
  acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'ask', deploy: 'ask', spend: 'full-auto', provision: 'full-auto', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
  const executor = new AcceptedActionExecutor(control);
  const provision = new AcceptedProvisionService({ projectId, targetId, targetRevision: 1, root: approved, store: new ProvisionStore({ root: approved, targetId }), acceptance, executor });
  const spend = new AcceptedSpendService({ projectId, targetId: spendTargetId, targetRevision: 1, endpoint: billing.endpoint, accountId, currency: 'USD', acceptance, executor, budget: new SpendBudget(control, { projectCapMinor: 1000, chargeCapMinor: 500 }), transport: new HttpBillingTransport({ endpoint: billing.endpoint, accountId, token: () => readSpendBillingToken(data), timeoutMs: 500 }) });
  const accepted = async (artifact: { revision: string; commit: string | null }, actionClass: 'provision' | 'spend') => {
    const evidence = await acceptance.recordEvidence({ projectId, evidence: { sessionId, subject: { kind: 'session', id: sessionId }, artifact, commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: 'claim', reference: null }, tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }], review: null, producedAt: '2026-01-01T00:00:00.000Z' } });
    return { evidenceId: evidence.evidence.record.id, acceptanceId: (await acceptance.accept({ authorizeAdmission: () => {}, projectId, request: { evidenceId: evidence.evidence.record.id, artifact, actionClass, actor: { kind: 'agent', identity: 'agent' } } })).acceptance.id };
  };
  const hosts: { host: HarnessHost; providers: ProviderStore; root: string }[] = [];
  const openHost = async (scopes: readonly AgentScope[]) => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-action-harness-')), providers = new ProviderStore(root, [fake.provider]);
    await providers.savePreferences({ defaultModel: { provider: 'action-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
    const host = new HarnessHost({ dataRoot: root, enabled: true, providers,
      privileges: { authority: async () => ({ agentId: 'agent', model: null, scopes, projects: [projectId], emptyReason: null }) },
      acceptedProvisionTools: { preview: input => provision.preview(input), provision: input => provision.provision(input) },
      acceptedSpendTools: { preview: input => spend.preview(input), spend: input => spend.spend(input) }
    });
    hosts.push({ host, providers, root });
    return host;
  };
  const wait = async (host: HarnessHost, text: string) => { const end = Date.now() + 10000; while (!(await host.view(project)).entries.some(entry => entry.text.includes(text))) { if (Date.now() > end) throw Error('run did not finish'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  try {
    const provisionPreview = await provision.preview({ projectId, sessionId, agentId: 'agent', authorize: async () => {}, resource: 'fixture-resource', version: '1.0.0' });
    const provisionAcceptance = await accepted(provisionPreview.artifact, 'provision');
    const spendPreview = await spend.preview({ projectId, sessionId, agentId: 'agent', authorize: async () => {}, amountMinor: 200 });
    const spendAcceptance = await accepted(spendPreview.artifact, 'spend');

    // A fresh conversation whose agent holds only `accept`: the installed tool is refused by dispatch.
    const refusedHost = await openHost(['accept']);
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('provision_accepted', { resource: 'fixture-resource', version: '1.0.0', ...provisionAcceptance, artifact: provisionPreview.artifact })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Provision refused.')]);
    await refusedHost.submit(project, { text: 'Try to provision', mode: 'followUp' }); await wait(refusedHost, 'Provision refused.');
    assert.match(JSON.stringify((await refusedHost.view(project)).entries), /refused|not permitted/i);
    await assert.rejects(readFile(join(approved, projectId, targetId, PROVISION_MANIFEST_FILE), 'utf8'));

    // A conversation created with the scopes granted: the same tool creates the resource.
    const host = await openHost(['accept', 'provision', 'spend']);
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('provision_accepted', { resource: 'fixture-resource', version: '1.0.0', ...provisionAcceptance, artifact: provisionPreview.artifact })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Provision created.')]);
    await host.submit(project, { text: 'Provision it', mode: 'followUp' }); await wait(host, 'Provision created.');
    const manifest = JSON.parse(await readFile(join(approved, projectId, targetId, PROVISION_MANIFEST_FILE), 'utf8'));
    assert.equal(manifest.resource, 'fixture-resource');
    assert.match(JSON.stringify((await host.view(project)).entries), /succeeded/);

    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('spend_accepted', { amountMinor: 200, ...spendAcceptance, artifact: spendPreview.artifact })], { stopReason: 'toolUse' }), () => fauxAssistantMessage('Charge sent.')]);
    await host.submit(project, { text: 'Spend it', mode: 'followUp' }); await wait(host, 'Charge sent.');
    assert.equal(billing.requests.length, 1);
    assert.match(JSON.stringify((await host.view(project)).entries), /succeeded/);
    assert.doesNotMatch(JSON.stringify((await host.view(project)).entries), new RegExp(token + '|' + billing.endpoint));
  } finally {
    for (const entry of hosts) { await entry.host.close(); await entry.providers.close(); await rm(entry.root, { recursive: true, force: true }); }
    control.close(); await billing.close(); await rm(base, { recursive: true, force: true });
  }
});
