import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { adoptRunningSessions } from '../../src/server/state/session-lifecycle';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    await sleep(50);
  }
  throw new Error('condition was not met in time');
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

const DEPLOYMENT_VARIABLES = [
  'DASHBOARD_MODE', 'DASHBOARD_EXPOSURE', 'DASHBOARD_BIND', 'DASHBOARD_ALLOWED_HOSTS', 'DASHBOARD_RELEASE',
  'DASHBOARD_ROOT_ID', 'DASHBOARD_SHUTDOWN_DEADLINE_MS', 'DASHBOARD_ORIGIN', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD',
  'DASHBOARD_OWNER', 'DASHBOARD_DATA', 'DASHBOARD_ROOTS', 'DASHBOARD_REGISTRY', 'DASHBOARD_AGENT_NOTE_DELAY_MS',
  'DASHBOARD_AGENT_NOTE_AFTER_WRITE_MS', 'DASHBOARD_AGENT_TEST_SEAMS', 'PORT'
];

interface Fixture {
  readonly root: string;
  readonly data: string;
  readonly counter: string;
  readonly readToolCounter: string;
  readonly base: string;
  start(): { child: ChildProcess; ready: Promise<{ token: string }> };
  kill(child: ChildProcess): Promise<void>;
  unlock(): Promise<void>;
  cleanup(): Promise<void>;
}

/** A real child process runs createApp with the faux provider and observes its true request boundary. */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-uncertain-integration-'));
  const data = join(root, 'data');
  const counter = join(root, 'provider-requests.log');
  const readToolCounter = join(root, 'read-tool-body.log');
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const mainUrl = pathToFileURL(resolve('src/server/main.ts')).href;
  const securityUrl = pathToFileURL(resolve('src/server/security.ts')).href;
  const storeUrl = pathToFileURL(resolve('src/server/state/control-store.ts')).href;
  const driver = `
    import { appendFileSync } from 'node:fs';
    const [{createApp},{localConfig},{ControlStore}] = await Promise.all([
      import(${JSON.stringify(mainUrl)}), import(${JSON.stringify(securityUrl)}), import(${JSON.stringify(storeUrl)})
    ]);
    const security=localConfig('http://127.0.0.1:0');
    const control=new ControlStore(process.env.DASHBOARD_DATA);
    const app=await createApp({dataRoot:process.env.DASHBOARD_DATA,browseRoots:[],security,agents:'on',agentPauseMs:100,recordNoteAfterWriteMs:2000,readNotesSeam:{delayMs:5000,onExecute:()=>appendFileSync(process.env.PILOT_TEST_READ_TOOL_LOG,'entered\\n')},control,onModelRequest:()=>appendFileSync(process.env.PILOT_TEST_PROVIDER_LOG,'request\\n')});
    await new Promise(resolve=>app.server.listen(Number(process.env.PORT),'127.0.0.1',resolve));
    security.origin='http://127.0.0.1:'+process.env.PORT;
    console.log('PILOT_READY '+JSON.stringify({token:security.token}));
  `;
  return {
    root, data, counter, readToolCounter, base,
    start() {
      const env: Record<string, string | undefined> = { ...process.env };
      for (const name of DEPLOYMENT_VARIABLES) delete env[name];
      Object.assign(env, {
        DASHBOARD_DATA: data, DASHBOARD_AGENT_TEST_SEAMS: 'on', DASHBOARD_AGENTS: 'on', DASHBOARD_ROOTS: '',
        DASHBOARD_REGISTRY: '', PORT: String(port), PILOT_TEST_PROVIDER_LOG: counter, PILOT_TEST_READ_TOOL_LOG: readToolCounter
      });
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', driver], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr += String(chunk); });
      const ready = new Promise<{ token: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not become ready: ' + stderr)), 10000);
        child.stdout!.on('data', chunk => {
          const line = String(chunk).split(/\r?\n/).find(value => value.startsWith('PILOT_READY '));
          if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('PILOT_READY '.length))); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Error('server exited with ' + code + ': ' + stderr)); });
      });
      return { child, ready };
    },
    async kill(child) { child.kill('SIGKILL'); await once(child, 'exit'); },
    async unlock() {
      const lock = join(data, 'service.lock');
      if (await stat(lock).then(() => true).catch(() => false)) await unlink(lock);
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); }
  };
}

async function waitForToolCheckpoint(sessionFile: string, replay: 'safe' | 'unsafe'): Promise<void> {
  await waitFor(async () => {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(sessionFile, { readOnly: true });
      const rows = db.prepare('SELECT record FROM tasks').all() as { record: string }[];
      return rows.some(({ record: text }) => {
        try {
          const record = JSON.parse(text) as { kind?: string; state?: { checkpoint?: { phase?: string; replay?: string } } };
          return record.kind === 'pi.tool' && record.state?.checkpoint?.phase === 'execute' && record.state.checkpoint.replay === replay;
        } catch { return false; }
      }) ? true : undefined;
    } catch { return undefined; }
    finally { db?.close(); }
  }, 10000);
}

async function createProject(base: string, token: string) {
  const headers = { 'x-dashboard-token': token, 'content-type': 'application/json', origin: base };
  const response = await fetch(base + '/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'Uncertain recovery fixture', managed: true, confirm: true }) });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text) as { id: string; path: string };
}

test('uncertain submission admission is blocked and ordinary conversation work remains available', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-uncertain-admission-'));
  const security = localConfig('http://127.0.0.1:0');
  const control = new ControlStore(root);
  let requests = 0;
  const app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', control, onModelRequest: () => { requests++; } });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
    const token = { 'x-dashboard-token': security.token };
    const headers = { ...token, origin: security.origin, 'content-type': 'application/json' };
    const project = await app.catalog.register({ name: 'Admission gate fixture', managed: true, confirm: true });
    const sessions = app.sessions!;
    const uncertain = await sessions.create({ projectId: project.id, name: 'Interrupted conversation' });
    app.lifecycle!.markRunning({ projectId: project.id, sessionId: uncertain.id, requestId: 'old-request' });
    adoptRunningSessions(app.lifecycle!, new Date());
    assert.equal(app.lifecycle!.read(project.id, uncertain.id).uncertain, true);
    assert.throws(() => app.lifecycle!.markRunning({ projectId: project.id, sessionId: uncertain.id, requestId: 'new-request' }), /uncertain/i);
    const base = security.origin + '/api/projects/' + project.id + '/agents';
    const denied = await fetch(base + '/input', { method: 'POST', headers, body: JSON.stringify({ sessionId: uncertain.id, text: 'must not run', mode: 'followUp', requestId: 'new-request' }) });
    assert.equal(denied.status, 409);
    assert.equal(requests, 0, 'the synthetic provider boundary saw no request');
    const allowed = await sessions.create({ projectId: project.id, name: 'Independent conversation' });
    const accepted = await fetch(base + '/input', { method: 'POST', headers, body: JSON.stringify({ sessionId: allowed.id, text: 'normal work', mode: 'followUp', requestId: 'safe-request' }) });
    assert.equal(accepted.status, 200);
    await waitFor(async () => requests > 0 ? true : undefined);
  } finally { await app.close(); control.close(); await rm(root, { recursive: true, force: true }); }
});

test('SIGKILL recovery of an appended unsafe tool blocks continuation at the actual provider boundary', { timeout: 30_000 }, async () => {
  const f = await fixture();
  let child: ChildProcess | undefined;
  try {
    const first = f.start(); child = first.child;
    const started = await first.ready;
    const headers = { 'x-dashboard-token': started.token, 'content-type': 'application/json', origin: f.base };
    const project = await createProject(f.base, started.token);
    const sessionResponse = await fetch(f.base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, name: 'Crash session' }) });
    assert.equal(sessionResponse.status, 201);
    const session = (await sessionResponse.json() as { session: { id: string } }).session;
    const agents = f.base + '/api/projects/' + project.id + '/agents';
    const lifeUrl = f.base + '/api/sessions/' + session.id + '/lifecycle?projectId=' + project.id;
    const input = await fetch(agents + '/input', { method: 'POST', headers, body: JSON.stringify({ sessionId: session.id, text: '[slow-note gate-post-append]', mode: 'followUp', requestId: 'uncertain-request' }) });
    assert.equal(input.status, 200);
    const noteFile = join(project.path, 'docs', 'notes.md');
    await waitFor(async () => await readFile(noteFile, 'utf8').then(text => text.includes('gate-post-append') ? true : undefined).catch(() => undefined));
    const beforeCrash = (await (await fetch(lifeUrl, { headers })).json() as { lifecycle: { state: string; requestId: string | null } }).lifecycle;
    assert.equal(beforeCrash.state, 'running'); assert.ok(beforeCrash.requestId);
    const initialCount = (await readFile(f.counter, 'utf8')).trim().split('\n').filter(Boolean).length;
    assert.ok(initialCount > 0, 'the faux provider crossed its observed request boundary');
    await f.kill(child); child = undefined;
    await f.unlock();

    const restarted = f.start(); child = restarted.child;
    const ready = await restarted.ready;
    const restartedHeaders = { 'x-dashboard-token': ready.token, 'content-type': 'application/json', origin: f.base };
    const adopted = (await (await fetch(lifeUrl, { headers: restartedHeaders })).json() as { lifecycle: { state: string; uncertain: boolean; revision: number; requestId: string | null } }).lifecycle;
    assert.equal(adopted.state, 'interrupted'); assert.equal(adopted.uncertain, true);
    assert.equal(adopted.requestId, beforeCrash.requestId);

    const view = await fetch(agents + '?sessionId=' + session.id, { headers: { 'x-dashboard-token': ready.token } });
    assert.equal(view.status, 200);
    const settled = await waitFor(async () => {
      const response = await fetch(agents + '?sessionId=' + session.id, { headers: { 'x-dashboard-token': ready.token }, signal: AbortSignal.timeout(5000) });
      const data = await response.json() as { view: { working: boolean } };
      return data.view.working === false ? true : undefined;
    }, 10000);
    assert.equal(settled, true);
    const finalCount = (await readFile(f.counter, 'utf8')).trim().split('\n').filter(Boolean).length;
    assert.equal(finalCount, initialCount, 'recovered continuation did not cross the actual synthetic provider boundary');
    assert.equal(await readFile(noteFile, 'utf8'), 'gate-post-append\n', 'the unsafe tool effect remains exactly once');
    const denied = await fetch(agents + '/input', { method: 'POST', headers: restartedHeaders, body: JSON.stringify({ sessionId: session.id, text: 'must stay blocked', mode: 'followUp', requestId: 'later-request' }) });
    assert.equal(denied.status, 409);
    assert.equal((await readFile(f.counter, 'utf8')).trim().split('\n').filter(Boolean).length, initialCount);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
    await f.cleanup();
  }
});

test('SIGKILL recovery blocks the registered safe read_notes execute body at its checkpoint', { timeout: 30_000 }, async () => {
  const f = await fixture();
  let child: ChildProcess | undefined;
  try {
    const first = f.start(); child = first.child;
    const started = await first.ready;
    const headers = { 'x-dashboard-token': started.token, 'content-type': 'application/json', origin: f.base };
    const project = await createProject(f.base, started.token);
    const sessionResponse = await fetch(f.base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, name: 'Safe execute crash session' }) });
    assert.equal(sessionResponse.status, 201);
    const session = (await sessionResponse.json() as { session: { id: string } }).session;
    const agents = f.base + '/api/projects/' + project.id + '/agents';
    const lifeUrl = f.base + '/api/sessions/' + session.id + '/lifecycle?projectId=' + project.id;
    const input = await fetch(agents + '/input', { method: 'POST', headers, body: JSON.stringify({ sessionId: session.id, text: '[read-notes]', mode: 'followUp', requestId: 'safe-tool-request' }) });
    assert.equal(input.status, 200);
    const sessionDb = join(f.data, 'agents', project.id, 'session.sqlite');
    await waitForToolCheckpoint(sessionDb, 'safe');
    await waitFor(async () => await readFile(f.readToolCounter, 'utf8').then(value => value.includes('entered') ? true : undefined).catch(() => undefined));
    const initialBodyCount = (await readFile(f.readToolCounter, 'utf8')).trim().split('\n').filter(Boolean).length;
    const initialRequestCount = (await readFile(f.counter, 'utf8')).trim().split('\n').filter(Boolean).length;
    assert.equal(initialBodyCount, 1, 'the actual registered safe execute body entered once before the kill');
    assert.equal(initialRequestCount, 1, 'the faux provider produced the safe tool call once');

    await f.kill(child); child = undefined;
    await f.unlock();
    const restarted = f.start(); child = restarted.child;
    const ready = await restarted.ready;
    const restartedHeaders = { 'x-dashboard-token': ready.token };
    const lifecycle = (await (await fetch(lifeUrl, { headers: restartedHeaders })).json() as { lifecycle: { state: string; uncertain: boolean } }).lifecycle;
    assert.equal(lifecycle.state, 'interrupted'); assert.equal(lifecycle.uncertain, true);

    // The real safe execute checkpoint would replay on restart. Its registered wrapper must refuse
    // before the inner execute seam, so the body counter stays at its pre-crash value.
    const settled = await waitFor(async () => {
      const response = await fetch(agents + '?sessionId=' + session.id, { headers: restartedHeaders, signal: AbortSignal.timeout(5000) });
      const data = await response.json() as { view: { working: boolean; entries: { kind: string; text: string }[] } };
      return !data.view.working && data.view.entries.some(entry => entry.kind === 'tool') ? data.view : undefined;
    }, 10000);
    const toolResult = settled.entries.find(entry => entry.kind === 'tool')!;
    assert.match(toolResult.text, /interrupted|uncertain|operator/i, 'recovery returned a guard refusal rather than the notes content');
    const finalBodyCount = (await readFile(f.readToolCounter, 'utf8')).trim().split('\n').filter(Boolean).length;
    assert.equal(finalBodyCount, initialBodyCount, 'the wrapped safe execute body did not run during recovery');
    assert.equal((await readFile(f.counter, 'utf8')).trim().split('\n').filter(Boolean).length, initialRequestCount, 'no continuation request crossed the provider boundary');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
    await f.cleanup();
  }
});
