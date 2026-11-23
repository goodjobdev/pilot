import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import type { Provider } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

test('concurrent project sessions share one bound-agent provider request reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-agent-budget-concurrency-'));
  const security = localConfig('http://127.0.0.1:0'), control = new ControlStore(root);
  const fake = fauxProvider({ provider: 'concurrency-faux', models: [{ id: 'fixture' }] });
  let providerInvocations = 0, releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  fake.setResponses([() => fauxAssistantMessage('one admitted request')]);
  const provider: Provider = {
    ...fake.provider,
    streamSimple: (model, context, options) => {
      // Invoke the real faux provider synchronously, then gate delivery from its actual event
      // stream. This preserves Provider's synchronous return contract while keeping the app's
      // first generation in flight until the competing request records its durable refusal.
      const source = fake.provider.streamSimple(model, context, options);
      providerInvocations++;
      const gated = createAssistantMessageEventStream();
      void (async () => {
        try {
          for await (const event of source) {
            await providerGate;
            gated.push(event);
          }
          gated.end(await source.result());
        } catch (error) {
          const message = fauxAssistantMessage('Faux provider stream forwarding failed.', {
            stopReason: 'error', errorMessage: error instanceof Error ? error.message : String(error)
          });
          gated.push({ type: 'error', reason: 'error', error: message });
          gated.end(message);
        }
      })();
      return gated;
    }
  };
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', control, agentPauseMs: 0 });
    app.providers.models.setProvider(provider);
    await app.providers.savePreferences({ defaultModel: { provider: 'concurrency-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
    await new Promise<void>(resolve => app!.server.listen(0, '127.0.0.1', resolve));
    security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
    const auth = { 'x-dashboard-token': security.token };
    const writes = { ...auth, origin: security.origin, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) => fetch(security.origin + '/api' + path, { method: 'POST', headers: writes, body: JSON.stringify(body) });
    const read = (path: string) => fetch(security.origin + '/api' + path, { headers: auth });
    const createProject = async (name: string) => (await (await post('/projects', { name, managed: true, confirm: true })).json() as { id: string }).id;
    const projectIds = await Promise.all([createProject('Concurrency project A'), createProject('Concurrency project B')]);
    const actor = { kind: 'owner' as const, identity: 'local' };
    const agent = app.agentStore!.create({ actor, draft: {
      name: 'Shared request budget', description: '', enabled: true,
      model: { provider: 'concurrency-faux', modelId: 'fixture' },
      workspace: { scope: { kind: 'projects', projectIds }, subpath: '' },
      budgets: { maxRequests: 1, maxOutputTokens: null, maxJobsPerHour: null }, scopes: ['read_notes']
    } });
    const paths = await Promise.all(projectIds.map(async projectId => {
      const base = '/projects/' + projectId + '/agents';
      const initial = await (await read(base)).json() as { view: { conversationId: string } };
      const bound = await post('/sessions/' + initial.view.conversationId + '/agent', { projectId, revision: 0, agentId: agent.id, actor });
      assert.equal(bound.status, 200);
      return base;
    }));

    // Hold the first actual provider stream open. The second project's distinct session is
    // submitted and allowed to reach a terminal state before the first provider is released.
    assert.equal((await post(paths[0] + '/input', { text: 'first concurrent session', mode: 'followUp' })).status, 200);
    const deadline = Date.now() + 10000;
    while (providerInvocations === 0) {
      if (Date.now() > deadline) throw new Error('first request did not reach the faux provider stream');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(providerInvocations, 1, 'the first request is paused inside its provider stream');
    assert.equal(fake.state.callCount, 1, 'the real faux provider stream function was invoked before delivery was gated');
    assert.equal((await post(paths[1] + '/input', { text: 'second concurrent session', mode: 'followUp' })).status, 200);
    let secondRefused = false;
    while (!secondRefused) {
      const result = await (await read(paths[1])).json() as { view: { working: boolean; entries: { text: string; error: string | null; stopReason: string | null }[] } };
      // The exact budget error and error stop reason are the durable assistant result for this
      // submission. Input visibility or an idle poll alone would not establish terminal refusal.
      secondRefused = !result.view.working && result.view.entries.some(entry => entry.stopReason === 'error' &&
        entry.error === 'The agent has exhausted its lifetime request budget.' &&
        entry.text.includes('The agent has exhausted its lifetime request budget.'));
      if (Date.now() > deadline) throw new Error('second project request did not record a durable budget refusal while first provider stream was held');
      if (!secondRefused) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(providerInvocations, 1, 'the overlapping second request did not start a provider stream');
    const reservations = control.db.prepare("SELECT COUNT(*) AS total FROM operations WHERE kind='agent.budget-request'").get() as { total: number };
    assert.equal(reservations.total, 1, 'only one durable request reservation exists for the shared agent');

    releaseProvider();
    for (;;) {
      const first = await (await read(paths[0])).json() as { view: { working: boolean; entries: { text: string }[] } };
      if (!first.view.working && first.view.entries.some(entry => entry.text.includes('first concurrent session'))) break;
      if (Date.now() > deadline) throw new Error('first project request did not settle after releasing the faux provider');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(providerInvocations, 1);
    assert.equal(fake.state.callCount, 1, 'exactly one faux provider stream was actually invoked');
    const finalReservations = control.db.prepare("SELECT COUNT(*) AS total FROM operations WHERE kind='agent.budget-request'").get() as { total: number };
    assert.equal(finalReservations.total, 1, 'the durable ledger retains exactly one request reservation');
  } finally {
    releaseProvider?.();
    if (app) await app.close();
    control.close();
    await rm(root, { recursive: true, force: true });
  }
});
