import { test } from 'node:test';
import { MAX_OUTPUT_TOKENS_DEFAULT } from '../../src/shared/harness-settings';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { ACCEPTANCE_FAUX_WORKER_DELAY_MAX_MS, acceptanceFauxWorkerDelayFromEnvironment, selectWorkerPreSubmitDelay } from '../../src/server/agent-test-seams';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { modelKey, type ModelChoice } from '../../src/shared/settings';

/**
 * The owner routes for bounded, owner-created workers (W1).
 *
 * Disposable root and control store, a real server and the scripted provider already installed for
 * tests. No live provider call, no install, no live project and no remote access. The unavailability
 * case uses a catalog model with no saved credential, so the dispatch refusal happens before a
 * provider request.
 */

async function instance(extra: { workerOpenDelayMs?: number; acceptanceFauxWorkerDelayMs?: number; onModelRequest?: (input: { provider: string; modelId: string; maxTokens: number }) => void; workerProbe?: { tool: string; args: Record<string, string | number | boolean | null> }; workerProbeDelayMs?: number; onWorkerGuard?: (input: { tool: string; refusal: string | null }) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-workers-api-'));
  const store = new ControlStore(root);
  const security = localConfig('http://127.0.0.1:0');
  const app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', agentPauseMs: 200, control: store, ...extra });
  await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  const base = security.origin;
  const token = { 'x-dashboard-token': security.token };
  const headers = { ...token, origin: base, 'content-type': 'application/json' };
  const post = (path: string, body: unknown, h = headers) => fetch(base + '/api' + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const get = (path: string, h: Record<string, string> = token) => fetch(base + '/api' + path, { headers: h });
  const close = async () => { await app.close(); store.close(); await rm(root, { recursive: true, force: true }); };
  return { root, store, app, base, token, headers, post, get, close };
}

test('acceptance Faux worker delay parses strictly, defaults to zero, and has a bounded range', () => {
  assert.equal(acceptanceFauxWorkerDelayFromEnvironment({}), 0);
  assert.equal(acceptanceFauxWorkerDelayFromEnvironment({ DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS: '0' }), 0);
  assert.equal(acceptanceFauxWorkerDelayFromEnvironment({ DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS: String(ACCEPTANCE_FAUX_WORKER_DELAY_MAX_MS) }), ACCEPTANCE_FAUX_WORKER_DELAY_MAX_MS);
  for (const value of ['', ' 1', '1 ', '1\n', '1\r\n', '+1', '1.0', '1e2', 'NaN', 'Infinity', '-1', '15001', '999999999999999999999'])
    assert.throws(() => acceptanceFauxWorkerDelayFromEnvironment({ DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS: value }), /integer/);
  assert.throws(() => acceptanceFauxWorkerDelayFromEnvironment({ DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS: '' }), /integer/);
});

test('worker pre-submit delay selects only Faux faux-1 and preserves legacy seam precedence', () => {
  assert.equal(selectWorkerPreSubmitDelay({ provider: 'faux', modelId: 'faux-1' }, undefined, 5000), 5000);
  assert.equal(selectWorkerPreSubmitDelay({ provider: 'openai', modelId: 'gpt' }, undefined, 5000), 0);
  assert.equal(selectWorkerPreSubmitDelay({ provider: 'faux', modelId: 'other' }, undefined, 5000), 0);
  assert.equal(selectWorkerPreSubmitDelay({ provider: 'faux', modelId: 'faux-1' }, 17, 5000), 17);
  assert.equal(selectWorkerPreSubmitDelay({ provider: 'faux', modelId: 'faux-1' }, 0, 5000), 0);
});

test('createApp rejects invalid direct acceptance-delay options and reads the environment setting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-worker-delay-config-'));
  const store = new ControlStore(root);
  const security = localConfig('http://127.0.0.1:0');
  for (const value of [-1, 1.5, Number.NaN, 15001]) {
    await assert.rejects(createApp({ dataRoot: root, browseRoots: [], security, control: store, acceptanceFauxWorkerDelayMs: value }), /integer/);
  }
  const previous = process.env.DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS;
  try {
    process.env.DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS = '15000';
    const app = await createApp({ dataRoot: root, browseRoots: [], security, control: store });
    await app.close();
    process.env.DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS = '';
    await assert.rejects(createApp({ dataRoot: root, browseRoots: [], security, control: store }), /integer/);
  } finally {
    if (previous === undefined) delete process.env.DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS;
    else process.env.DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS = previous;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function project(f: Awaited<ReturnType<typeof instance>>) {
  const created = await f.post('/projects', { name: 'Worker fixture', managed: true, confirm: true });
  assert.equal(created.status, 201);
  return await created.json() as { id: string; path: string };
}

async function waitForRun(f: Awaited<ReturnType<typeof instance>>, projectId: string, runId: string, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const response = await f.get('/projects/' + projectId + '/workers/runs/' + runId);
    assert.equal(response.status, 200);
    const { run } = await response.json() as { run: { state: string; report: { path: string; sha256: string; bytes: number } | null; reason: string | null; turns: number } };
    if (run.state !== 'running' || Date.now() - started > timeoutMs) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('workers: owner routes list, pin, run, report, revoke and refuse an unavailable model', async () => {
  const f = await instance();
  try {
    const projectRecord = await project(f);
    // Owner-only authentication.
    assert.equal((await f.get('/projects/' + projectRecord.id + '/workers', {})).status, 401);
    const empty = await f.get('/projects/' + projectRecord.id + '/workers');
    assert.equal(empty.status, 200);
    const emptyView = await empty.json() as { workers: unknown[]; runs: unknown[]; limits: { maxModelTurnsPerRun: number; maxOutputTokensPerTurn: number; maxLiveWorkersPerProject: number; maxActiveRunsPerProject: number }; scopes: string[]; policy: unknown };
    assert.deepEqual(emptyView.workers, []);
    assert.equal(emptyView.limits.maxModelTurnsPerRun, 8);
    assert.equal(emptyView.limits.maxOutputTokensPerTurn, 4096);
    assert.equal(emptyView.limits.maxLiveWorkersPerProject, 3);
    assert.equal(emptyView.limits.maxActiveRunsPerProject, 1);
    assert.deepEqual(emptyView.scopes, ['record_note', 'read_notes']);
    assert.equal(emptyView.policy, null);

    // Read the catalog and save an allowed worker set. The scripted model is the free stand-in.
    const policyView = await (await f.get('/settings/model-policy')).json() as { models: { provider: string; modelId: string; known: boolean; available: boolean }[] };
    const scriptedOption = policyView.models.find((model) => model.provider === 'faux' && model.available);
    assert.ok(scriptedOption);
    const realOption = policyView.models.find((model) => model.provider !== 'faux' && model.known);
    assert.ok(realOption);
    const scripted: ModelChoice = { provider: scriptedOption.provider, modelId: scriptedOption.modelId };
    const real: ModelChoice = { provider: realOption.provider, modelId: realOption.modelId };
    const saved = await f.post('/settings/model-policy', { revision: 0, policy: { allowedWorkerModels: [scripted, real], defaultWorkerModel: scripted } });
    assert.equal(saved.status, 200);

    // No actor in the body: the route derives the owner, and an agent actor is not accepted.
    const actorInBody = await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Sneaky', actor: { kind: 'agent', identity: 'x' } });
    assert.equal(actorInBody.status, 422);
    // A model outside the allowed set is refused and creates nothing.
    const outside = await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Outside', model: { provider: 'faux', modelId: 'not-allowed' } });
    assert.equal(outside.status, 422);
    assert.match((await outside.json()).error, /not in the owner’s allowed worker set/);
    // An uninstalled scope is refused by name.
    const uninstalled = await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Docs', scopes: ['read_docs'] });
    assert.equal(uninstalled.status, 422);
    assert.match((await uninstalled.json()).error, /read_docs/);
    const question = await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Question', scopes: ['ask_question'] });
    assert.equal(question.status, 422);
    assert.match((await question.json()).error, /no bounded owner answer path/);

    const created = await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Reviewer', scopes: ['read_notes'] });
    assert.equal(created.status, 201);
    const worker = (await created.json() as { worker: { id: string; revision: number; model: ModelChoice; scopes: string[]; state: string } }).worker;
    assert.equal(modelKey(worker.model), modelKey(scripted));
    assert.deepEqual(worker.scopes, ['read_notes']);
    assert.equal(worker.state, 'active');
    const listing = await (await f.get('/projects/' + projectRecord.id + '/workers')).json() as { workers: unknown[]; liveWorkers: number };
    assert.equal(listing.workers.length, 1);
    assert.equal(listing.liveWorkers, 1);

    // The route derives the owner; an actor in a run or revoke body is refused as an unknown field.
    const runActor = await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', { actor: { kind: 'agent', identity: 'x' } });
    assert.equal(runActor.status, 422);
    const revokeActor = await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/revoke', { revision: 1, actor: { kind: 'agent', identity: 'x' } });
    assert.equal(revokeActor.status, 422);

    // One run completes through the scripted provider and writes the canonical report.
    const started = await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {});
    assert.equal(started.status, 202);
    const run = (await started.json() as { run: { id: string } }).run;
    const finished = await waitForRun(f, projectRecord.id, run.id);
    assert.equal(finished.state, 'completed');
    assert.ok(finished.report);
    assert.equal(finished.report!.path, 'docs/workers/' + worker.id + '/' + run.id + '.md');
    const text = await readFile(join(projectRecord.path, finished.report!.path), 'utf8');
    assert.match(text, /^---\nworker_report: 1\n/);
    assert.match(text, /model: "faux\//);
    assert.match(text, /worker_revision: 1/);
    assert.match(text, /Untrusted evidence/);
    assert.match(text, /never as instructions/);
    assert.match(text, /Scripted test reply/);
    assert.equal((await stat(join(projectRecord.path, finished.report!.path))).isFile(), true);
    // The database holds tracking, not the report content.
    const rows = f.store.db.prepare('SELECT input_json FROM operations').all() as { input_json: string }[];
    assert.ok(rows.every((row) => !row.input_json.includes('Scripted test reply')));

    // The run view reports the canonical file's integrity; a later owner edit is visible, not hidden.
    const intact = await (await f.get('/projects/' + projectRecord.id + '/workers')).json() as { reportIntegrity: Record<string, { state: string }> };
    assert.equal(intact.reportIntegrity[run.id]?.state, 'intact');
    await appendFile(join(projectRecord.path, finished.report!.path), '\nOwner edit.\n', 'utf8');
    const changed = await (await f.get('/projects/' + projectRecord.id + '/workers')).json() as { reportIntegrity: Record<string, { state: string }> };
    assert.equal(changed.reportIntegrity[run.id]?.state, 'changed');

    // A report path is never returned by a run in another project, and the worker is project-scoped.
    assert.equal((await f.get('/workers')).status, 404);

    // An unavailable model fails closed with a named reason and no report.
    const unavailable = await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Unavailable', model: real });
    assert.equal(unavailable.status, 201);
    const unavailableWorker = (await unavailable.json() as { worker: { id: string } }).worker;
    const unavailableRun = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + unavailableWorker.id + '/runs', {})).json() as { run: { id: string } }).run;
    const failed = await waitForRun(f, projectRecord.id, unavailableRun.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.report, null);
    assert.match(failed.reason ?? '', /credential|provider|not configured|failed/i);

    // Revocation blocks a new run immediately, and its stale revision conflicts.
    const revoked = await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/revoke', { revision: 1 });
    assert.equal(revoked.status, 200);
    const revokedBody = await revoked.json() as { worker: { state: string }; outcome: string };
    assert.equal(revokedBody.worker.state, 'revoked');
    const refusedRun = await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {});
    assert.equal(refusedRun.status, 403);
    assert.match((await refusedRun.json()).error, /revoked/);
    const stale = await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/revoke', { revision: 1 });
    assert.equal(stale.status, 200, 'revoking an already revoked worker is an honest no-op');
    assert.equal((await stale.json()).worker.state, 'revoked');

    // Pause and resume are refused explicitly: W1 has no queue and never claims a resumable run.
    const paused = await f.post('/projects/' + projectRecord.id + '/workers/runs/' + run.id + '/pause', {});
    assert.equal(paused.status, 409);
    assert.match((await paused.json()).error, /cannot be paused or resumed/);
    const resumed = await f.post('/projects/' + projectRecord.id + '/workers/runs/' + run.id + '/resume', {});
    assert.equal(resumed.status, 409);

    // A worker conversation is not a session: a numeric alias cannot change its model, so the
    // worker role cannot be spoofed by the session model setter.
    const workerConversations = f.app.workerStore!.workerConversationIds(projectRecord.id);
    assert.equal(workerConversations.length >= 1, true);
    const alias = await f.post('/projects/' + projectRecord.id + '/agents/model', { sessionId: String(workerConversations[0]), model: null });
    assert.equal(alias.status, 409);
    assert.match((await alias.json()).error, /belongs to a worker run/);

    // No report body ever returns through the run view.
    const runView = await (await f.get('/projects/' + projectRecord.id + '/workers/runs/' + run.id)).json() as { run: Record<string, unknown> };
    const serialized = JSON.stringify(runView);
    assert.doesNotMatch(serialized, /Scripted test reply/);
    assert.doesNotMatch(serialized, new RegExp(projectRecord.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { await f.close(); }
});


test('workers: the harness being off makes the routes refuse with 503 rather than invent a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-workers-off-'));
  const store = new ControlStore(root);
  const security = localConfig('http://127.0.0.1:0');
  const app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'off', control: store });
  await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  const token = { 'x-dashboard-token': security.token };
  try {
    const created = await fetch(security.origin + '/api/projects', { method: 'POST', headers: { ...token, origin: security.origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Off fixture', managed: true, confirm: true }) });
    assert.equal(created.status, 201);
    const projectRecord = await created.json() as { id: string };
    const response = await fetch(security.origin + '/api/projects/' + projectRecord.id + '/workers', { headers: token });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Workers are unavailable/);
  } finally { await app.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

async function restart(f: Awaited<ReturnType<typeof instance>>) {
  await f.app.close();
  const security = localConfig('http://127.0.0.1:0');
  const app = await createApp({ dataRoot: f.root, browseRoots: [], security, agents: 'on', agentPauseMs: 200, control: f.store });
  await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  const token = { 'x-dashboard-token': security.token };
  const headers = { ...token, origin: security.origin, 'content-type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(security.origin + '/api' + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = (path: string) => fetch(security.origin + '/api' + path, { headers: token });
  return { app, security, token, headers, post, get };
}

/** Every generic route that can name a session or a numeric conversation alias. */
async function assertAliasRefused(input: {
  base: string;
  token: Record<string, string>;
  headers: Record<string, string>;
  projectId: string;
  conversationId: number;
}) {
  const id = String(input.conversationId);
  const get = (path: string) => fetch(input.base + '/api' + path, { headers: input.token });
  const post = (path: string, body: unknown) => fetch(input.base + '/api' + path, { method: 'POST', headers: input.headers, body: JSON.stringify(body) });
  const expected = [
    ['GET agent view', await get('/projects/' + input.projectId + '/agents?sessionId=' + id)],
    ['GET agent stream', await get('/projects/' + input.projectId + '/agents/stream?sessionId=' + id)],
    ['POST model', await post('/projects/' + input.projectId + '/agents/model', { sessionId: id, model: null })],
    ['POST input', await post('/projects/' + input.projectId + '/agents/input', { sessionId: id, text: 'hello' })],
    ['POST abort', await post('/projects/' + input.projectId + '/agents/abort', { sessionId: id })],
    ['POST answer', await post('/projects/' + input.projectId + '/agents/answer', { sessionId: id, questionId: 'q', text: 'x' })],
    ['POST dismiss', await post('/projects/' + input.projectId + '/agents/dismiss', { sessionId: id, questionId: 'q', reason: 'x' })],
    ['POST media', await post('/projects/' + input.projectId + '/agents/media', { sessionId: id, data: 'AAAA' })],
    ['GET lifecycle', await get('/sessions/' + id + '/lifecycle?projectId=' + input.projectId)],
    ['POST lifecycle resume', await post('/sessions/' + id + '/lifecycle/resume', { projectId: input.projectId, revision: 0 })],
    ['GET queue', await get('/sessions/' + id + '/queue?projectId=' + input.projectId)],
    ['POST queue append', await post('/sessions/' + id + '/queue/append', { projectId: input.projectId, revision: 0, text: 'x' })],
    ['POST session agent binding', await post('/sessions/' + id + '/agent', { projectId: input.projectId, revision: 0, agentId: null, actor: { kind: 'owner', identity: 'local' } })]
  ] as const;
  for (const [label, response] of expected) {
    assert.equal(response.status, 409, label + ' must refuse a worker conversation alias');
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? '', /worker run|worker conversation/i, label + ' names the worker reason');
  }
}

test('workers: every generic agent/session route refuses a worker conversation alias, live and after restart', async () => {
  const f = await instance();
  try {
    const projectRecord = await project(f);
    const policyView = await (await f.get('/settings/model-policy')).json() as { revision: number; models: { provider: string; modelId: string; available: boolean }[] };
    const scripted = policyView.models.find((model) => model.provider === 'faux' && model.available)!;
    const saved = await f.post('/settings/model-policy', { revision: policyView.revision, policy: { allowedWorkerModels: [{ provider: scripted.provider, modelId: scripted.modelId }], defaultWorkerModel: { provider: scripted.provider, modelId: scripted.modelId } } });
    assert.equal(saved.status, 200);
    const worker = (await (await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Alias reviewer', scopes: ['read_notes'] })).json() as { worker: { id: string } }).worker;
    const run = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {})).json() as { run: { id: string } }).run;
    assert.equal((await waitForRun(f, projectRecord.id, run.id)).state, 'completed');
    const conversations = f.app.workerStore!.workerConversationIds(projectRecord.id);
    assert.equal(conversations.length, 1);
    await assertAliasRefused({ base: f.base, token: f.token, headers: f.headers, projectId: projectRecord.id, conversationId: conversations[0] });

    // Restart the server on the same control store. The in-process marker is gone; the durable
    // binding must still refuse every alias, and the adoption must not create a session for it.
    const restarted = await restart(f);
    try {
      const conversationsAfter = restarted.app.workerStore!.workerConversationIds(projectRecord.id);
      assert.deepEqual(conversationsAfter, conversations);
      await assertAliasRefused({ base: restarted.security.origin, token: restarted.token, headers: restarted.headers, projectId: projectRecord.id, conversationId: conversationsAfter[0] });
      const sessions = await (await restarted.get('/sessions?projectId=' + projectRecord.id)).json() as { sessions: { id: string }[] };
      assert.equal(sessions.sessions.some((session) => session.id === String(conversationsAfter[0])), false);
      const migration = await (await restarted.post('/sessions/migrate', { dryRun: true })).json() as { actions: { sessionId: string | null }[] };
      assert.equal(migration.actions.some((action) => action.sessionId === String(conversationsAfter[0])), false);
    } finally {
      await restarted.app.close();
    }
  } finally { await f.close(); }
});

test('workers: the legacy open-window seam cancels before a request, and Faux provider budget remains intact', async () => {
  const requests: { provider: string; modelId: string; maxTokens: number }[] = [];
  const f = await instance({ workerOpenDelayMs: 250, onModelRequest: (input) => { requests.push(input); } });
  try {
    const projectRecord = await project(f);
    const policyView = await (await f.get('/settings/model-policy')).json() as { revision: number; models: { provider: string; modelId: string; available: boolean }[] };
    const scripted = policyView.models.find((model) => model.provider === 'faux' && model.available)!;
    const model = { provider: scripted.provider, modelId: scripted.modelId };
    await f.post('/settings/model-policy', { revision: policyView.revision, policy: { allowedWorkerModels: [model], defaultWorkerModel: model } });
    const worker = (await (await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Legacy window worker', scopes: ['read_notes'] })).json() as { worker: { id: string } }).worker;
    const run = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {})).json() as { run: { id: string } }).run;
    const stopped = await f.post('/projects/' + projectRecord.id + '/workers/runs/' + run.id + '/stop', {});
    assert.equal(stopped.status, 200);
    const settled = await waitForRun(f, projectRecord.id, run.id);
    assert.equal(settled.state, 'cancelled');
    assert.equal(settled.report, null);
    assert.equal(requests.length, 0);
    assert.ok(f.app.workerStore!.workerConversationIds(projectRecord.id).length <= 1);
    assert.equal(f.app.workerStore!.view(projectRecord.id).activeRunId, null);

    const second = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {})).json() as { run: { id: string } }).run;
    const finished = await waitForRun(f, projectRecord.id, second.id);
    assert.equal(finished.state, 'completed');
    assert.ok(requests.length >= 1);
    assert.ok(requests.every((request) => request.maxTokens === MAX_OUTPUT_TOKENS_DEFAULT));
    assert.equal(requests[0].provider, 'faux');
  } finally { await f.close(); }
});

test('workers: configured Faux acceptance delay is cancellable after durable binding; provider budget remains intact', async () => {
  const requests: { provider: string; modelId: string; maxTokens: number }[] = [];
  const f = await instance({ acceptanceFauxWorkerDelayMs: 5000, onModelRequest: (input) => { requests.push(input); } });
  try {
    const projectRecord = await project(f);
    const policyView = await (await f.get('/settings/model-policy')).json() as { revision: number; models: { provider: string; modelId: string; available: boolean }[] };
    const scripted = policyView.models.find((model) => model.provider === 'faux' && model.available)!;
    const model = { provider: scripted.provider, modelId: scripted.modelId };
    await f.post('/settings/model-policy', { revision: policyView.revision, policy: { allowedWorkerModels: [model], defaultWorkerModel: model } });
    const worker = (await (await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Window worker', scopes: ['read_notes'] })).json() as { worker: { id: string } }).worker;

    const run = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {})).json() as { run: { id: string } }).run;
    const bindingDeadline = Date.now() + 3000;
    while (f.app.workerStore!.workerConversationIds(projectRecord.id).length === 0 && Date.now() < bindingDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.app.workerStore!.workerConversationIds(projectRecord.id).length, 1, 'durable conversation binding exists before stop');
    assert.equal(requests.length, 0, 'no provider request has started during the configured window');
    const stopped = await f.post('/projects/' + projectRecord.id + '/workers/runs/' + run.id + '/stop', {});
    assert.equal(stopped.status, 200);
    const settled = await waitForRun(f, projectRecord.id, run.id);
    assert.equal(settled.state, 'cancelled');
    assert.equal(settled.report, null);
    assert.equal(requests.length, 0, 'a cancel during the configured window sends no provider request');
    assert.equal(f.app.workerStore!.workerConversationIds(projectRecord.id).length, 1, 'conversation was durably bound before cancellation');
    assert.equal(f.app.workerStore!.view(projectRecord.id).activeRunId, null, 'cancellation releases the project lease');

    // A normal worker run through the synthetic provider reaches the provider boundary with the
    // worker budget, including its output-token limit.
    requests.length = 0;
    const second = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {})).json() as { run: { id: string } }).run;
    const finished = await waitForRun(f, projectRecord.id, second.id);
    assert.equal(finished.state, 'completed');
    assert.equal(requests.length >= 1, true);
    assert.ok(requests.every((request) => request.maxTokens === MAX_OUTPUT_TOKENS_DEFAULT), 'the synthetic provider is bounded to the instance default');
    assert.equal(requests[0].provider, 'faux');
  } finally { await f.close(); }
});

test('workers: the real harness guard denies an offered tool and writes nothing', async () => {
  const requests: { maxTokens: number }[] = [];
  const guardCalls: { tool: string; refusal: string | null }[] = [];
  let firstRequest: () => void = () => {};
  const firstSeen = new Promise<void>((resolve) => { firstRequest = resolve; });
  const f = await instance({
    workerProbe: { tool: 'record_note', args: { text: 'must not be written' } },
    workerProbeDelayMs: 250,
    onModelRequest: (input) => { requests.push({ maxTokens: input.maxTokens }); firstRequest(); },
    onWorkerGuard: (input) => { guardCalls.push(input); }
  });
  try {
    const projectRecord = await project(f);
    const policyView = await (await f.get('/settings/model-policy')).json() as { revision: number; models: { provider: string; modelId: string; available: boolean }[] };
    const scripted = policyView.models.find((model) => model.provider === 'faux' && model.available)!;
    const workerModel = { provider: scripted.provider, modelId: scripted.modelId };
    await f.post('/settings/model-policy', { revision: policyView.revision, policy: { allowedWorkerModels: [workerModel], defaultWorkerModel: workerModel } });
    // record_note is offered to this worker, so the static guard is the authority that refuses it.
    const worker = (await (await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Guarded worker', scopes: ['record_note'] })).json() as { worker: { id: string } }).worker;
    const run = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {})).json() as { run: { id: string } }).run;
    // While the provider is answering the first request, remove the pinned model from the policy.
    await firstSeen;
    const current = await (await f.get('/settings/model-policy')).json() as { revision: number };
    const removed = await f.post('/settings/model-policy', { revision: current.revision, policy: { allowedWorkerModels: [], defaultWorkerModel: null } });
    assert.equal(removed.status, 200);
    const settled = await waitForRun(f, projectRecord.id, run.id, 20_000);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.report, null);
    assert.equal(requests.length, 1, 'the first request was paid; the second was refused before the provider');
    assert.ok(guardCalls.some((call) => call.tool === 'record_note' && call.refusal !== null), 'the static worker guard was called and denied record_note');
    // The denied tool produced no effect at all: no notes file was created.
    await assert.rejects(readFile(join(projectRecord.path, 'docs/notes.md'), 'utf8'), /ENOENT/);
  } finally { await f.close(); }
});

test('workers: the ninth model request is refused at the real provider boundary', async () => {
  const requests: { maxTokens: number }[] = [];
  const f = await instance({
    workerProbe: { tool: 'read_notes', args: {} },
    workerProbeDelayMs: 2,
    onModelRequest: (input) => { requests.push({ maxTokens: input.maxTokens }); }
  });
  try {
    const projectRecord = await project(f);
    const policyView = await (await f.get('/settings/model-policy')).json() as { revision: number; models: { provider: string; modelId: string; available: boolean }[] };
    const scripted = policyView.models.find((model) => model.provider === 'faux' && model.available)!;
    const model = { provider: scripted.provider, modelId: scripted.modelId };
    await f.post('/settings/model-policy', { revision: policyView.revision, policy: { allowedWorkerModels: [model], defaultWorkerModel: model } });
    const worker = (await (await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Budget worker', scopes: ['read_notes'] })).json() as { worker: { id: string } }).worker;
    const run = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {})).json() as { run: { id: string } }).run;
    const settled = await waitForRun(f, projectRecord.id, run.id, 20_000);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.report, null);
    assert.match(settled.reason ?? '', /eight-model-request budget/);
    assert.equal(requests.length, 8, 'exactly eight provider requests were made; the ninth was refused before the call');
    assert.ok(requests.every((request) => request.maxTokens === MAX_OUTPUT_TOKENS_DEFAULT));
  } finally { await f.close(); }
});

test('workers: a revocation after the first request allows no further provider request in the real harness', async () => {
  const requests: number[] = [];
  const f = await instance({
    workerProbe: { tool: 'read_notes', args: {} },
    workerProbeDelayMs: 120,
    onModelRequest: () => { requests.push(Date.now()); }
  });
  try {
    const projectRecord = await project(f);
    const policyView = await (await f.get('/settings/model-policy')).json() as { revision: number; models: { provider: string; modelId: string; available: boolean }[] };
    const scripted = policyView.models.find((model) => model.provider === 'faux' && model.available)!;
    const model = { provider: scripted.provider, modelId: scripted.modelId };
    await f.post('/settings/model-policy', { revision: policyView.revision, policy: { allowedWorkerModels: [model], defaultWorkerModel: model } });
    const worker = (await (await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Revoked worker', scopes: ['read_notes'] })).json() as { worker: { id: string; revision: number } }).worker;
    const run = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {})).json() as { run: { id: string } }).run;
    // Wait for the first paid request, then revoke. The next beforeRequest revalidates and refuses.
    const started = Date.now();
    while (requests.length === 0 && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.length, 1, 'the first request reached the provider');
    const revoked = await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/revoke', { revision: worker.revision });
    assert.equal(revoked.status, 200);
    const settled = await waitForRun(f, projectRecord.id, run.id, 20_000);
    assert.equal(settled.state, 'cancelled');
    assert.equal(requests.length, 1, 'no provider request happened after the revocation');
  } finally { await f.close(); }
});

test('workers: a conversation created before a failed binding still refuses adoption after restart', async () => {
  const f = await instance();
  try {
    const projectRecord = await project(f);
    const policyView = await (await f.get('/settings/model-policy')).json() as { revision: number; models: { provider: string; modelId: string; available: boolean }[] };
    const scripted = policyView.models.find((model) => model.provider === 'faux' && model.available)!;
    const model = { provider: scripted.provider, modelId: scripted.modelId };
    await f.post('/settings/model-policy', { revision: policyView.revision, policy: { allowedWorkerModels: [model], defaultWorkerModel: model } });
    const worker = (await (await f.post('/projects/' + projectRecord.id + '/workers', { name: 'Crash window worker', scopes: ['read_notes'] })).json() as { worker: { id: string } }).worker;
    const run = (await (await f.post('/projects/' + projectRecord.id + '/workers/' + worker.id + '/runs', {})).json() as { run: { id: string } }).run;
    assert.equal((await waitForRun(f, projectRecord.id, run.id)).state, 'completed');
    const conversationId = f.app.workerStore!.workerConversationIds(projectRecord.id)[0];
    // Simulate the crash window: the harness conversation (and its init marker) exists, but the
    // control-store binding was never written. Close the app, remove only that binding, reopen.
    await f.app.close();
    const operations = f.store.db.prepare("SELECT id FROM operations WHERE project_id=? AND session_id='workers' AND kind='workers.conversation'").all(projectRecord.id) as { id: string }[];
    assert.equal(operations.length, 1);
    for (const operation of operations) {
      f.store.db.prepare('DELETE FROM outboxes WHERE operation_id=?').run(operation.id);
      f.store.db.prepare('DELETE FROM operations WHERE id=?').run(operation.id);
    }
    const reopened = await restart(f);
    try {
      assert.equal(reopened.app.workerStore!.workerConversationIds(projectRecord.id).length, 0, 'no control binding remains');
      const projectRecordAfter = reopened.app.catalog.get(projectRecord.id);
      assert.equal(await reopened.app.agents.hasSession(projectRecordAfter, String(conversationId)), false);
      await assert.rejects(reopened.app.agents.sessionView(projectRecordAfter, String(conversationId)), (error: unknown) => (error as { status?: number }).status === 409);
      await assert.rejects(reopened.app.agents.assertSessionAliasAvailable(projectRecordAfter, String(conversationId)), (error: unknown) => (error as { status?: number }).status === 409);
      const migration = await (await reopened.post('/sessions/migrate', { dryRun: true })).json() as { actions: { sessionId: string | null }[] };
      assert.equal(migration.actions.some((action) => action.sessionId === String(conversationId)), false);
    } finally {
      await reopened.app.close();
    }
  } finally { await f.close(); }
});
