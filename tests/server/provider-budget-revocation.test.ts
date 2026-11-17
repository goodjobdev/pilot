import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { Provider } from '@earendil-works/pi-ai';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';

test('production agent budget authority revoked at OpenAI payload dispatch prevents fetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-provider-budget-revocation-'));
  const control = new ControlStore(root), security = localConfig('http://127.0.0.1:0');
  let payloadDispatches = 0, fetches = 0, revoked = false;
  const actual = openaiProvider();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let agent: ReturnType<NonNullable<Awaited<ReturnType<typeof createApp>>['agentStore']>['create']>;
  const wrapped: Provider = {
    ...actual,
    streamSimple: ((model, context, options) => actual.streamSimple(model, context, {
      ...options,
      fetch: async () => { fetches++; throw new Error('stub fetch must not be reached'); },
      onPayload: async (payload, active) => {
        payloadDispatches++;
        // This runs inside the real adapter's pre-fetch payload callback, not at the harness's
        // earlier onModelRequest observation seam. The original production callback then rechecks
        // the durable agent authority and must reject before the adapter calls fetch.
        if (!revoked) {
          const current = app!.agentStore!.read(agent.id);
          app!.agentStore!.update({ agentId: agent.id, revision: current.revision,
            patch: { budgets: { maxRequests: 1, maxOutputTokens: 321, maxJobsPerHour: null } },
            actor: { kind: 'owner', identity: 'local' } });
          revoked = true;
        }
        return options?.onPayload?.(payload, active);
      }
    })) as typeof actual.streamSimple
  };
  try {
    app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', control, agentPauseMs: 0 });
    app!.providers.models.setProvider(wrapped);
    await app!.providers.saveKey('openai', { key: 'sk-fixture-not-a-real-key' });
    await app!.providers.savePreferences({ defaultModel: { provider: 'openai', modelId: 'gpt-4.1-mini' }, favourites: [], allowRealModels: true });
    await new Promise<void>(resolve => app!.server.listen(0, '127.0.0.1', resolve));
    security.origin = 'http://127.0.0.1:' + (app!.server.address() as { port: number }).port;
    const writes = { 'x-dashboard-token': security.token, origin: security.origin, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) => fetch(security.origin + '/api' + path, { method: 'POST', headers: writes, body: JSON.stringify(body) });
    const project = await (await post('/projects', { name: 'Real adapter budget fixture', managed: true, confirm: true })).json() as { id: string };
    const actor = { kind: 'owner' as const, identity: 'local' };
    agent = app!.agentStore!.create({ actor, draft: {
      name: 'Budgeted OpenAI fixture', description: '', enabled: true,
      model: { provider: 'openai', modelId: 'gpt-4.1-mini' },
      workspace: { scope: { kind: 'projects', projectIds: [project.id] }, subpath: '' },
      budgets: { maxRequests: 2, maxOutputTokens: 321, maxJobsPerHour: null }, scopes: ['read_notes']
    } });
    const base = '/projects/' + project.id + '/agents';
    const initial = await (await fetch(security.origin + '/api' + base, { headers: { 'x-dashboard-token': security.token } })).json() as { view: { conversationId: string } };
    const binding = await post('/sessions/' + initial.view.conversationId + '/agent', { projectId: project.id, revision: 0, agentId: agent.id, actor });
    assert.equal(binding.status, 200);
    assert.equal((await post(base + '/input', { text: 'controlled pre-fetch revocation', mode: 'followUp' })).status, 200);
    const deadline = Date.now() + 10000;
    let settled = false;
    while (payloadDispatches === 0 || !settled) {
      const view = await (await fetch(security.origin + '/api' + base, { headers: { 'x-dashboard-token': security.token } })).json() as { view: { working: boolean } };
      settled = !view.view.working;
      if (payloadDispatches > 0 && settled) break;
      if (Date.now() > deadline) throw new Error('real-adapter revocation request did not settle');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(revoked, true);
    assert.equal(payloadDispatches, 1, 'the supported OpenAI adapter reached its pre-fetch onPayload hook');
    assert.equal(fetches, 0, 'authority recheck refused payload dispatch before any fetch');
    assert.equal(control.db.prepare("SELECT COUNT(*) AS total FROM operations WHERE kind='agent.budget-request'").get()?.total, 1,
      'the production request reservation remains charged even though payload dispatch was refused');
  } finally {
    try {
      if (app) await app.close();
    } finally {
      try { control.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
});
