import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,rm,stat,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 10000, label = 'condition was not met in time'): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw Error(label);
    await sleep(25);
  }
}

/**
 * A disposable instance with a durable control store when `durable` is true. The cancellation
 * seams are test-only harness options: the tool's own parameters never carry a delay.
 */
async function instance(root: string, options: { durable?: boolean; beforeWriteMs?: number; afterWriteMs?: number; onExecute?: () => void; pauseMs?: number } = {}) {
  const security = localConfig('http://127.0.0.1:0');
  const control = options.durable ? new ControlStore(root) : undefined;
  const created = await createApp({
    dataRoot: root, browseRoots: [], security, agents: 'on', agentPauseMs: options.pauseMs ?? 100,
    ...(options.beforeWriteMs === undefined ? {} : { recordNoteDelayMs: options.beforeWriteMs }),
    ...(options.afterWriteMs === undefined ? {} : { recordNoteAfterWriteMs: options.afterWriteMs }),
    ...(options.onExecute === undefined ? {} : { recordNoteStarted: options.onExecute }),
    ...(control ? { control } : {})
  });
  if (control) {
    const close = created.close.bind(created);
    created.close = async () => { await close(); control.close(); };
  }
  await new Promise<void>(ok => created.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (created.server.address() as { port: number }).port;
  const token = { 'x-dashboard-token': security.token };
  const writes = { ...token, 'content-type': 'application/json', origin: security.origin };
  const listed = await (await fetch(security.origin + '/api/projects', { headers: token })).json() as { id: string; path: string }[];
  const project = listed[0] ?? await (await fetch(security.origin + '/api/projects', { method: 'POST', headers: writes, body: JSON.stringify({ name: 'Cancellation', managed: true, confirm: true }) })).json() as { id: string; path: string };
  const base = security.origin + '/api/projects/' + project.id + '/agents';
  const view = async (sessionId?: string) => (await (await fetch(base + (sessionId ? '?sessionId=' + sessionId : ''), { headers: token })).json()) as { view: any };
  const send = (body: unknown) => fetch(base + '/input', { method: 'POST', headers: writes, body: JSON.stringify(body) });
  const action = (sessionId: string, name: string, revision: number, extra: object = {}) => fetch(security.origin + '/api/sessions/' + sessionId + '/lifecycle/' + name, {
    method: 'POST', headers: writes, body: JSON.stringify({ projectId: project.id, revision, ...extra })
  });
  const notesFile = join(project.path, 'docs', 'notes.md');
  const notes = () => readFile(notesFile, 'utf8').then(text => text, () => undefined);
  return { created, security, token, writes, project, base, view, send, action, notesFile, notes, control };
}

const toolCalls = (view: any) => (view.entries as any[]).filter(entry => entry.tools?.some((tool: any) => tool.name === 'record_note'));
const toolResults = (view: any) => (view.entries as any[]).filter(entry => entry.kind === 'tool');
const users = (view: any) => (view.entries as any[]).filter(entry => entry.kind === 'user');
const settled = (app: Awaited<ReturnType<typeof instance>>, sessionId?: string) => waitFor(async () => {
  const current = await app.view(sessionId);
  return current.view.working ? undefined : current.view;
}, 10000, 'the run did not settle');
const hasToolCall = async (app: Awaited<ReturnType<typeof instance>>, sessionId?: string) => {
  const current = await app.view(sessionId);
  return toolCalls(current.view).length > 0 ? true : undefined;
};

test('a cancel during the record_note wait writes no note and records one aborted result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-before-write-'));
  let enteredFlag = false;
  const app = await instance(root, { beforeWriteMs: 30000, onExecute: () => { enteredFlag = true; } });
  try {
    assert.equal((await app.send({ text: '[slow-note a cancelled line]', mode: 'followUp' })).status, 200);
    // The host-only seam fires from inside execute, so the abort below lands after execution
    // entered its wait, not merely after the call was admitted.
    await waitFor(async () => enteredFlag ? true : undefined, 5000, 'record_note did not enter execution');
    const started = Date.now();
    assert.equal((await fetch(app.base + '/abort', { method: 'POST', headers: app.writes, body: '{}' })).status, 200);
    const view = await settled(app);
    assert.ok(Date.now() - started < 2000, 'the abort settled promptly instead of waiting out the delay');
    assert.equal(await stat(app.notesFile).then(() => true, () => false), false, 'a cancel before the write creates no notes file');
    assert.equal(toolResults(view).length, 1);
    assert.match(toolResults(view)[0].text, /aborted|interrupted/i);
    assert.doesNotMatch(toolResults(view).map((entry: any) => entry.text).join('\n'), /Recorded:/);
    assert.equal(users(view).length, 1, 'the input was not duplicated');
    assert.equal(toolCalls(view).length, 1, 'the tool was called once');
  } finally {
    await app.created.close();
  }
});

test('a cancel after the note was appended keeps the note and reports an uncertain abort, not a rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-after-write-'));
  const app = await instance(root, { afterWriteMs: 30000 });
  try {
    assert.equal((await app.send({ text: '[slow-note a committed line]', mode: 'followUp' })).status, 200);
    // The append is the observable commit point; the harness seam holds the call open after it.
    await waitFor(async () => (await app.notes()) === 'a committed line\n' ? true : undefined, 10000, 'the note was not appended');
    assert.equal((await fetch(app.base + '/abort', { method: 'POST', headers: app.writes, body: '{}' })).status, 200);
    const view = await settled(app);
    assert.equal(await app.notes(), 'a committed line\n', 'a committed effect is never removed or claimed absent');
    assert.equal(toolResults(view).length, 1);
    assert.match(toolResults(view)[0].text, /aborted|interrupted/i, 'the call is reported as a cancellation, whose effect is uncertain');
    assert.doesNotMatch(toolResults(view).map((entry: any) => entry.text).join('\n'), /Recorded:/, 'a cancelled call does not claim success');
    assert.equal((await app.notes())?.match(/a committed line/g)?.length, 1, 'the line was appended exactly once');
  } finally {
    await app.created.close();
  }
});

test('stop and pause/resume act on the selected named session only, and resume never replays the append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-named-'));
  const app = await instance(root, { durable: true, beforeWriteMs: 1500 });
  try {
    const named = await app.created.sessions!.create({ projectId: app.project.id, name: 'Cancelled named session' });
    assert.equal((await app.send({ sessionId: named.id, text: '[slow-note named line]', mode: 'followUp' })).status, 200);
    assert.equal((await app.send({ text: '[slow-note root line]', mode: 'followUp' })).status, 200);
    await waitFor(() => hasToolCall(app, named.id));
    await waitFor(() => hasToolCall(app));
    await waitFor(async () => app.created.lifecycle!.read(app.project.id, named.id).state === 'running' ? true : undefined, 5000, 'the named lifecycle did not become running');

    const revision = app.created.lifecycle!.read(app.project.id, named.id).revision;
    assert.equal((await app.action(named.id, 'stop', revision)).status, 200);
    const namedView = await settled(app, named.id);
    assert.equal(app.created.lifecycle!.read(app.project.id, named.id).state, 'idle');
    const rootView = await settled(app);
    const rootText = await app.notes();
    assert.equal(rootText, 'root line\n', 'the root run completed and the stopped named run wrote nothing');
    assert.match(toolResults(namedView)[0].text, /aborted|interrupted/i);
    assert.match(toolResults(rootView)[0].text, /Recorded:/);
    assert.equal(users(namedView).length, 1);
    assert.equal(users(rootView).length, 1);

    // A pause is a resumable cancel. Resume reuses the original request identity, so it cannot
    // dispatch the note again: the append never happened and never happens on resume.
    const paused = await app.created.sessions!.create({ projectId: app.project.id, name: 'Paused named session' });
    assert.equal((await app.send({ sessionId: paused.id, text: '[slow-note paused line]', mode: 'followUp' })).status, 200);
    await waitFor(async () => {
      const current = await app.view(paused.id);
      return app.created.lifecycle!.read(app.project.id, paused.id).state === 'running' && toolCalls(current.view).length === 1 ? true : undefined;
    }, 5000, 'the paused run did not start');
    const pausedAt = app.created.lifecycle!.read(app.project.id, paused.id).revision;
    assert.equal((await app.action(paused.id, 'pause', pausedAt, { reason: 'test pause' })).status, 200);
    assert.equal(app.created.lifecycle!.read(app.project.id, paused.id).state, 'paused');
    assert.equal(await app.notes(), rootText, 'a paused write has not landed');
    const resumeAt = app.created.lifecycle!.read(app.project.id, paused.id).revision;
    const resumed = await app.action(paused.id, 'resume', resumeAt);
    assert.equal(resumed.status, 200);
    const resumedBody = await resumed.json() as { lifecycle: { state: string; revision: number; requestId: string | null }; dispatched: boolean; cancelled: boolean; unchanged: boolean; outcome: string; reason: string | null };
    assert.equal(resumedBody.outcome, 'terminal', 'a resume that finds a terminal original request names the terminal outcome');
    assert.equal(resumedBody.dispatched, false, 'a terminal resume claims no dispatch and no new work');
    assert.equal(resumedBody.cancelled, false);
    assert.equal(resumedBody.unchanged, false);
    assert.equal(resumedBody.lifecycle.state, 'idle', 'the response settles the record instead of leaving a false running');
    assert.match(resumedBody.reason ?? '', /No additional work was started/);
    assert.equal(app.created.lifecycle!.read(app.project.id, paused.id).state, 'idle', 'the durable record matches the response');
    assert.equal(app.created.lifecycle!.read(app.project.id, paused.id).requestId, resumedBody.lifecycle.requestId, 'the terminal identity is not replaced by a fresh one');
    assert.equal(await app.notes(), rootText, 'a resume never appends the cancelled note');
    const after = await app.view(paused.id);
    assert.equal(toolCalls(after.view).length, 1, 'resume added no second call for the paused input');
    assert.equal(users(after.view).length, 1, 'resume added no duplicate input');
  } finally {
    await app.created.close();
  }
});

test('a graceful close during the wait writes nothing and the next start reports interrupted, not a replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-close-'));
  let app = await instance(root, { beforeWriteMs: 30000 });
  try {
    assert.equal((await app.send({ text: '[slow-note a closed line]', mode: 'followUp' })).status, 200);
    await waitFor(() => hasToolCall(app), 10000, 'the tool call was not admitted');
    await app.created.close();
    assert.equal(await stat(app.notesFile).then(() => true, () => false), false, 'closing during the wait writes no note');

    app = await instance(root, { beforeWriteMs: 30000 });
    const view = await waitFor(async () => {
      const current = await app.view();
      return toolResults(current.view).length > 0 ? current.view : undefined;
    }, 10000, 'the next start did not report the interrupted call');
    assert.match(toolResults(view)[0].text, /interrupted/i, 'the unsafe tool is reported interrupted after a close, not rerun');
    assert.match(toolResults(view)[0].text, /may have partially run/);
    assert.equal(await stat(app.notesFile).then(() => true, () => false), false, 'the restart did not replay the append');
    assert.equal(users(view).length, 1, 'the restart did not duplicate the input');
    assert.equal(toolCalls(view).length, 1);
  } finally {
    await app.created.close();
  }
});

test('a stream disconnect neither cancels the run nor duplicates the work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-disconnect-'));
  const app = await instance(root, { beforeWriteMs: 800 });
  const originalAbort = app.created.agents.abort.bind(app.created.agents);
  let aborts = 0;
  app.created.agents.abort = async (...args: Parameters<typeof originalAbort>) => { aborts += 1; return originalAbort(...args); };
  try {
    assert.equal((await app.send({ text: '[slow-note a connected line]', mode: 'followUp' })).status, 200);
    const stream = await fetch(app.base + '/stream', { headers: app.token });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    await reader.read();
    await reader.cancel();
    const view = await settled(app);
    assert.equal(aborts, 0, 'dropping the stream performs no stop');
    assert.equal(await app.notes(), 'a connected line\n', 'the run completed once');
    assert.equal((await app.notes())?.match(/a connected line/g)?.length, 1);
    assert.equal(users(view).length, 1, 'the disconnect admitted no second input');
    assert.equal(toolCalls(view).length, 1);
  } finally {
    await app.created.close();
  }
});

test('an empty request identity becomes one durable identity, and a malformed one is refused before admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-request-id-'));
  const app = await instance(root, { durable: true });
  try {
    const named = await app.created.sessions!.create({ projectId: app.project.id, name: 'Identity rules' });
    const project = app.created.catalog.get(app.project.id);
    await app.created.agents.submit(project, { sessionId: named.id, text: '[note empty identity]', mode: 'followUp', requestId: '' });
    const recorded = await waitFor(async () => {
      const record = app.created.lifecycle!.read(app.project.id, named.id);
      return record.requestId === null ? undefined : record;
    }, 5000, 'the lifecycle did not record a generated identity');
    assert.match(recorded.requestId ?? '', /^\S{1,200}$/, 'the empty identity was normalized to a generated, printable identity');
    const before = await app.view(named.id);
    assert.equal(users(before.view).length, 1);

    await assert.rejects(
      app.created.agents.submit(project, { sessionId: named.id, text: '[note malformed identity]', mode: 'followUp', requestId: 'x'.repeat(201) }),
      (error: any) => error?.status === 422 && /requestId/.test(error.message)
    );
    const after = await app.view(named.id);
    assert.equal(users(after.view).length, 1, 'a refused identity admits no input');
    assert.ok(!after.view.entries.some((entry: any) => String(entry.text).includes('malformed identity')));
  } finally {
    await app.created.close();
  }
});

test('a duplicate identity while the first run is open is admitted once and starts no second run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-duplicate-running-'));
  const app = await instance(root, { beforeWriteMs: 30000 });
  try {
    const first = await app.send({ text: '[slow-note duplicate while open]', mode: 'followUp', requestId: 'same-open-request' });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { submissionId: string };
    await waitFor(() => hasToolCall(app), 10000, 'the first run did not start');
    const second = await app.send({ text: '[slow-note duplicate while open]', mode: 'followUp', requestId: 'same-open-request' });
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { submissionId: string }).submissionId, firstBody.submissionId, 'the duplicate resolves to the same submission');
    assert.equal((await fetch(app.base + '/abort', { method: 'POST', headers: app.writes, body: '{}' })).status, 200);
    const view = await settled(app);
    assert.equal(users(view).length, 1, 'the duplicate admitted no second input');
    assert.equal(toolCalls(view).length, 1, 'the duplicate started no second run');
    assert.equal(await stat(app.notesFile).then(() => true, () => false), false, 'the aborted duplicate wrote nothing');
  } finally {
    await app.created.close();
  }
});

test('a refused admission during a busy run writes no input and starts no second run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-admission-refused-'));
  const app = await instance(root, { pauseMs: 5000 });
  try {
    assert.equal((await app.send({ text: '[pause] hold this run', mode: 'followUp' })).status, 200);
    await waitFor(async () => (await app.view()).view.working ? true : undefined, 5000, 'the run did not start');
    const refused = await app.send({ text: '[note must not be admitted]', mode: 'reject' });
    assert.equal(refused.status, 409);
    assert.match((await refused.json() as { error: string }).error, /already working/);
    const view = (await app.view()).view;
    assert.equal(users(view).length, 1, 'the refused admission appended nothing');
    assert.equal(toolCalls(view).length, 0, 'the refused admission started no tool');
    assert.equal(await stat(app.notesFile).then(() => true, () => false), false);
    assert.equal((await fetch(app.base + '/abort', { method: 'POST', headers: app.writes, body: '{}' })).status, 200);
  } finally {
    await app.created.close();
  }
});

test('record_note refuses a symlinked documentation directory and writes nothing outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-symlink-'));
  const app = await instance(root);
  try {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await rm(join(app.project.path, 'docs'), { recursive: true, force: true });
    await symlink(outside, join(app.project.path, 'docs'), 'dir');
    assert.equal((await app.send({ text: '[note symlink escape]', mode: 'followUp' })).status, 200);
    const view = await settled(app);
    assert.equal(toolResults(view).length, 1);
    assert.match(toolResults(view)[0].text, /symlink/i, 'the tool reports the containment refusal');
    assert.doesNotMatch(toolResults(view)[0].text, /Recorded:/);
    assert.equal(await stat(join(outside, 'notes.md')).then(() => true, () => false), false, 'nothing was written through the symlink');
  } finally {
    await app.created.close();
  }
});

test('the test-only note delay is bounded, whole, and needs the explicit test seam for the environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cancel-delay-rules-'));
  const security = localConfig('http://127.0.0.1:0');
  const base = { dataRoot: root, browseRoots: [], security, agents: 'on' as const };
  const saved = { seams: process.env.DASHBOARD_AGENT_TEST_SEAMS, delay: process.env.DASHBOARD_AGENT_NOTE_DELAY_MS };
  try {
    await assert.rejects(createApp({ ...base, recordNoteDelayMs: 1.5 }), /whole number/);
    await assert.rejects(createApp({ ...base, recordNoteDelayMs: 60001 }), /whole number/);
    await assert.rejects(createApp({ ...base, recordNoteAfterWriteMs: -1 }), /whole number/);
    delete process.env.DASHBOARD_AGENT_TEST_SEAMS;
    process.env.DASHBOARD_AGENT_NOTE_DELAY_MS = '10';
    await assert.rejects(createApp({ ...base }), /test-only seam/);
    process.env.DASHBOARD_AGENT_TEST_SEAMS = 'on';
    process.env.DASHBOARD_AGENT_NOTE_DELAY_MS = '1.5';
    await assert.rejects(createApp({ ...base }), /whole number/);
    process.env.DASHBOARD_AGENT_NOTE_DELAY_MS = '60001';
    await assert.rejects(createApp({ ...base }), /whole number/);
  } finally {
    if (saved.seams === undefined) delete process.env.DASHBOARD_AGENT_TEST_SEAMS; else process.env.DASHBOARD_AGENT_TEST_SEAMS = saved.seams;
    if (saved.delay === undefined) delete process.env.DASHBOARD_AGENT_NOTE_DELAY_MS; else process.env.DASHBOARD_AGENT_NOTE_DELAY_MS = saved.delay;
    await rm(root, { recursive: true, force: true });
  }
});
