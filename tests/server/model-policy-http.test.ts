import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { modelKey, type ModelChoice } from '../../src/shared/settings';
import { WORKER_MODEL_POLICY_READBACK_UNCERTAIN } from '../../src/shared/model-policy-codes';

/**
 * The worker model policy routes.
 *
 * These tests use a disposable root and a real control store. They make no provider call, start
 * no worker and open no live sign-in. Policy writes never open the harness by themselves; the
 * one running-work scenario uses the scripted provider already installed for tests.
 */

async function instance(agentPauseMs = 200) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-worker-policy-api-'));
  const store = new ControlStore(root);
  const security = localConfig('http://127.0.0.1:0');
  const app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', agentPauseMs, control: store });
  await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  const base = security.origin;
  const token = { 'x-dashboard-token': security.token };
  const headers = { ...token, origin: base, 'content-type': 'application/json' };
  const post = (path: string, body: unknown, h = headers) => fetch(base + '/api' + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const get = (path: string, h: Record<string, string> = token) => fetch(base + '/api' + path, { headers: h });
  const close = async () => { await app.close(); store.close(); await rm(root, { recursive: true, force: true }); };
  return { root, store, security, app, base, token, headers, post, get, close };
}

async function project(f: Awaited<ReturnType<typeof instance>>) {
  const created = await f.post('/projects', { name: 'Worker policy fixture', managed: true, confirm: true });
  assert.equal(created.status, 201);
  return await created.json() as { id: string; path: string };
}

function pick(models: { provider: string; modelId: string; known: boolean; available: boolean }[], predicate: (model: { provider: string; modelId: string; known: boolean; available: boolean }) => boolean): ModelChoice {
  const found = models.find(predicate);
  assert.ok(found, 'the fixture catalog has a model for this predicate');
  return { provider: found.provider, modelId: found.modelId };
}

test('the policy route derives the owner, enforces revision CAS, and leaves orchestrator choices unchanged', async () => {
  const f = await instance();
  try {
    // Owner-only authentication and the same origin/CSRF rule as every other write.
    assert.equal((await f.get('/settings/model-policy', {})).status, 401);
    assert.equal((await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [], defaultWorkerModel: null } }, { ...f.headers, origin: 'https://evil.example' })).status, 403);
    const source = await (await f.get('/settings/providers')).json() as { models: { provider: string; modelId: string; name: string; configured: boolean }[]; preferences: { defaultModel: ModelChoice | null; favourites: ModelChoice[]; allowRealModels: boolean } };
    const initial = await (await f.get('/settings/model-policy')).json() as { policy: unknown; revision: number; models: { provider: string; modelId: string; known: boolean; available: boolean; credentialSaved: boolean; credentialNote: string; unavailableReason: string | null }[] };
    assert.equal(initial.policy, null);
    assert.equal(initial.revision, 0);
    const scripted = pick(initial.models, (model) => model.provider === 'faux' && model.available);
    const real = pick(initial.models, (model) => model.provider !== 'faux' && model.known);
    const realView = initial.models.find((model) => modelKey(model) === modelKey(real))!;
    assert.ok(initial.models.some((model) => model.known), 'the catalog is reported');

    // The existing orchestrator choices are established before the policy write.
    const defaultSaved = await f.post('/settings/models', { ...source.preferences, defaultModel: real });
    assert.equal(defaultSaved.status, 200);
    const projectRecord = await project(f);
    const agentDraft = {
      name: 'Policy facade agent',
      description: '',
      enabled: true,
      model: real,
      workspace: { scope: { kind: 'projects', projectIds: [projectRecord.id] }, subpath: '' },
      budgets: { maxRequests: null, maxOutputTokens: null, maxJobsPerHour: null },
      scopes: ['read_notes']
    };
    const agentCreated = await f.post('/agents', { draft: agentDraft, actor: { kind: 'owner', identity: 'local' } });
    assert.equal(agentCreated.status, 201);
    const agent = (await agentCreated.json() as { agent: { id: string; model: ModelChoice; revision: number } }).agent;
    const sessionCreated = await f.post('/sessions', { projectId: projectRecord.id, name: 'Policy session', model: real });
    assert.equal(sessionCreated.status, 201);
    const session = (await sessionCreated.json() as { session: { id: string; model: ModelChoice | null; revision: number } }).session;

    // The route accepts no client-supplied actor.
    const actorInBody = await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [scripted], defaultWorkerModel: scripted }, actor: { kind: 'owner', identity: 'browser' } });
    assert.equal(actorInBody.status, 422);
    // A new unknown model is refused and writes nothing.
    const unknown = await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [{ provider: 'unknown', modelId: 'nope' }], defaultWorkerModel: null } });
    assert.equal(unknown.status, 422);
    assert.match((await unknown.json()).error, /not one this instance offers/);
    // A default outside the allowed set is refused; it is never cleared or replaced.
    const outside = await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [scripted], defaultWorkerModel: real } });
    assert.equal(outside.status, 422);
    assert.match((await outside.json()).error, /clear defaultWorkerModel explicitly/);

    const created = await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [scripted, real], defaultWorkerModel: scripted } });
    assert.equal(created.status, 200);
    const createdView = await created.json() as { policy: { revision: number; allowedWorkerModels: ModelChoice[]; defaultWorkerModel: ModelChoice | null }; revision: number; models: { provider: string; modelId: string; known: boolean; available: boolean; credentialSaved: boolean; credentialNote: string; unavailableReason: string | null }[] };
    assert.equal(createdView.revision, 1);
    assert.deepEqual(createdView.policy.allowedWorkerModels.map(modelKey).sort(), [modelKey(scripted), modelKey(real)].sort());
    assert.equal(modelKey(createdView.policy.defaultWorkerModel!), modelKey(scripted));
    // A known but unconnected model is kept and labelled, never replaced. The disposable root has
    // no provider credentials, so every real model is unconfigured while the scripted one is available.
    assert.equal(realView.available, false);
    assert.equal(realView.credentialSaved, false);
    assert.match(realView.credentialNote, /No credential is saved/);
    assert.ok(realView.unavailableReason && realView.unavailableReason.length > 10);
    const savedReal = createdView.models.find((model) => modelKey(model) === modelKey(real))!;
    assert.equal(savedReal.available, false);
    assert.ok(savedReal.unavailableReason && savedReal.unavailableReason.length > 10);
    // Stale CAS writes nothing.
    const stale = await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [scripted], defaultWorkerModel: scripted } });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /revision 1, not 0/);
    // The policy does not change the existing global default, agent model or session model.
    const afterSettings = await (await f.get('/settings/providers')).json() as { preferences: { defaultModel: ModelChoice | null } };
    assert.equal(modelKey(afterSettings.preferences.defaultModel!), modelKey(real));
    const afterAgent = await (await f.get('/agents/' + agent.id)).json() as { agent: { model: ModelChoice; revision: number } };
    assert.equal(modelKey(afterAgent.agent.model), modelKey(real));
    assert.equal(afterAgent.agent.revision, agent.revision);
    const afterSession = await (await f.get('/sessions/' + session.id + '?projectId=' + projectRecord.id)).json() as { session: { model: ModelChoice | null; revision: number } };
    assert.equal(modelKey(afterSession.session.model!), modelKey(real));
    assert.equal(afterSession.session.revision, session.revision);
    // No worker creation or dispatch route exists.
    assert.equal((await f.post('/workers', {})).status, 404);
    // Removing the unconnected saved model is accepted; no worker starts.
    const removed = await f.post('/settings/model-policy', { revision: 1, policy: { allowedWorkerModels: [scripted], defaultWorkerModel: scripted } });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json() as { revision: number }).revision, 2);
  } finally {
    await f.close();
  }
});

test('saving the policy during a run changes neither the running generation nor its model', async () => {
  const f = await instance(5000);
  try {
    const projectRecord = await project(f);
    const started = await f.post('/projects/' + projectRecord.id + '/agents/input', { text: '[pause] hold this run open', mode: 'followUp' });
    assert.equal(started.status, 200);
    let before: { working: boolean; model: ModelChoice | null } | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const view = await (await f.get('/projects/' + projectRecord.id + '/agents')).json() as { view: { working: boolean; model: ModelChoice | null } };
      if (view.view.working) { before = view.view; break; }
      await new Promise((ok) => setTimeout(ok, 50));
    }
    assert.ok(before?.working, 'the scripted run is working');
    const initial = await (await f.get('/settings/model-policy')).json() as { models: { provider: string; modelId: string; known: boolean; available: boolean }[] };
    const scripted = pick(initial.models, (model) => model.provider === 'faux' && model.available);
    const saved = await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [scripted], defaultWorkerModel: scripted } });
    assert.equal(saved.status, 200);
    const after = await (await f.get('/projects/' + projectRecord.id + '/agents')).json() as { view: { working: boolean; model: ModelChoice | null } };
    assert.equal(after.view.working, true);
    assert.equal(modelKey(after.view.model!), modelKey(before.model!));
    await f.post('/projects/' + projectRecord.id + '/agents/abort', {});
  } finally {
    await f.close();
  }
});

test('stored policy corruption is a generic 500 for GET and POST, with no internal detail', async () => {
  const f = await instance();
  try {
    const initial = await (await f.get('/settings/model-policy')).json() as { models: { provider: string; modelId: string; known: boolean; available: boolean }[] };
    const chosen = pick(initial.models, (model) => model.known);
    const created = await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [chosen], defaultWorkerModel: chosen } });
    assert.equal(created.status, 200);
    // Tamper the stored operation state while the process is running. Reading it is now corruption.
    f.store.db.prepare("UPDATE operations SET state='succeeded' WHERE project_id='settings' AND session_id='worker-policy'").run();
    const read = await f.get('/settings/model-policy');
    assert.equal(read.status, 500);
    const readBody = await read.json() as { error: string };
    assert.match(readBody.error, /unreadable or corrupt/);
    assert.doesNotMatch(readBody.error, /succeeded|idempotency|sqlite|operation/i);
    const write = await f.post('/settings/model-policy', { revision: 1, policy: { allowedWorkerModels: [], defaultWorkerModel: null } });
    assert.equal(write.status, 500);
    const writeBody = await write.json() as { error: string };
    assert.match(writeBody.error, /unreadable or corrupt/);
    assert.doesNotMatch(writeBody.error, /succeeded|idempotency|sqlite|operation/i);
  } finally {
    await f.close();
  }
});

test('a readback failure after a successful write is an ambiguous 500', async () => {
  const f = await instance();
  try {
    const initial = await (await f.get('/settings/model-policy')).json() as { models: { provider: string; modelId: string; known: boolean; available: boolean }[] };
    const chosen = pick(initial.models, (model) => model.known);
    // A disposable trigger makes the admitted row unreadable to the policy decoder after the
    // insert. The write itself succeeds. The route must report an ambiguous result, not a lost
    // write, and must not leak the trigger or the stored state.
    f.store.db.exec("CREATE TRIGGER policy_readback_break AFTER INSERT ON operations WHEN NEW.kind='settings.worker-model-policy' BEGIN UPDATE operations SET state='succeeded' WHERE id=NEW.id; END");
    const response = await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [chosen], defaultWorkerModel: chosen } });
    assert.equal(response.status, 500);
    const body = await response.json() as { error: string; code?: string };
    assert.match(body.error, /was written, but the current policy could not be read back/);
    assert.equal(body.code, WORKER_MODEL_POLICY_READBACK_UNCERTAIN);
    assert.doesNotMatch(body.error, /succeeded|trigger|sqlite|operation/i);
    const row = f.store.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE kind='settings.worker-model-policy'").get() as { count: number };
    assert.equal(row.count, 1, 'the write was admitted before the readback failed');
  } finally {
    await f.close();
  }
});

test('a corrupt provider settings view is a sanitized 500 for GET', async () => {
  const f = await instance();
  try {
    await mkdir(join(f.root, 'settings'), { recursive: true, mode: 0o700 });
    await writeFile(join(f.root, 'settings', 'models.json'), 'not json', { mode: 0o600 });
    const response = await f.get('/settings/model-policy');
    assert.equal(response.status, 500);
    const body = await response.json() as { error: string; code?: string };
    assert.match(body.error, /view could not be read/);
    assert.equal(body.code, undefined);
    assert.doesNotMatch(body.error, /models\.json|JSON|sqlite|provider/i);
  } finally {
    await f.close();
  }
});

test('a saved scripted model reports the harness-off reason, not catalog removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-worker-policy-faux-'));
  const store = new ControlStore(root);
  const security = localConfig('http://127.0.0.1:0');
  const on = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', control: store });
  await new Promise<void>((ok) => on.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (on.server.address() as { port: number }).port;
  const baseOn = security.origin;
  const tokenOn = { 'x-dashboard-token': security.token };
  const headersOn = { ...tokenOn, origin: baseOn, 'content-type': 'application/json' };
  try {
    const initial = await (await fetch(baseOn + '/api/settings/model-policy', { headers: tokenOn })).json() as { models: { provider: string; modelId: string; known: boolean }[] };
    const faux = initial.models.find((model) => model.provider === 'faux' && model.known);
    assert.ok(faux, 'the scripted model is offered while the harness is on');
    const saved = await fetch(baseOn + '/api/settings/model-policy', {
      method: 'POST',
      headers: headersOn,
      body: JSON.stringify({ revision: 0, policy: { allowedWorkerModels: [{ provider: faux.provider, modelId: faux.modelId }], defaultWorkerModel: { provider: faux.provider, modelId: faux.modelId } } })
    });
    assert.equal(saved.status, 200);
  } finally {
    await on.close();
  }
  // Reopen with the harness off on the same control store. The saved scripted entry must say the
  // harness is off, not that the model left the catalog.
  security.origin = 'http://127.0.0.1:0';
  const off = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'off', control: store });
  await new Promise<void>((ok) => off.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (off.server.address() as { port: number }).port;
  try {
    const view = await (await fetch(security.origin + '/api/settings/model-policy', { headers: { 'x-dashboard-token': security.token } })).json() as { models: { provider: string; modelId: string; known: boolean; available: boolean; credentialNote: string }[] };
    const saved = view.models.find((model) => model.provider === 'faux' && model.modelId === 'faux-1');
    assert.ok(saved, 'the saved scripted model is preserved');
    assert.equal(saved.known, true);
    assert.equal(saved.available, false);
    assert.match(saved.credentialNote, /agent harness is off/);
    assert.doesNotMatch(saved.credentialNote, /no longer in the offered catalog/);
  } finally {
    await off.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
