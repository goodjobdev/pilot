import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { ApprovalStore } from '../../src/server/state/approval-store';
import { SessionLifecycleStore, adoptRunningSessions } from '../../src/server/state/session-lifecycle';
import { buildAttention } from '../../src/server/state/attention';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 10000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw Error('condition was not met in time');
    await sleep(50);
  }
}

async function instance(root: string) {
  const security = localConfig('http://127.0.0.1:0');
  const control = new ControlStore(root);
  const created = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', agentPauseMs: 150, control });
  const closeApp = created.close.bind(created);
  created.close = async () => { await closeApp(); control.close(); };
  await new Promise<void>(ok => created.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (created.server.address() as { port: number }).port;
  const token = { 'x-dashboard-token': security.token };
  const writes = { ...token, 'content-type': 'application/json', origin: security.origin };
  const project = async (name: string) => await (await fetch(security.origin + '/api/projects', { method: 'POST', headers: writes, body: JSON.stringify({ name, managed: true, confirm: true }) })).json() as { id: string; name: string };
  const attention = async (projectId: string, query = '') => {
    const response = await fetch(security.origin + '/api/projects/' + projectId + '/attention' + query, { headers: token });
    return { status: response.status, body: await response.json() as any };
  };
  return { created, security, token, writes, control, project, attention };
}

function approvalStore(control: ControlStore, start: Date) {
  let tick = 0;
  return new ApprovalStore(control, {
    clock: () => new Date(start.getTime() + tick * 1000),
    nonce: () => String(++tick).padStart(64, '0')
  });
}

function spend(projectId: string, store: ApprovalStore, expiresAt: Date) {
  return store.create({ kind: 'spend', scope: { projectId }, target: { amountMinor: 100, currency: 'AUD' }, expiresAt: expiresAt.toISOString() });
}

test('attention reports the exact count, caps the list at 100 and pages with a stable cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-count-'));
  const app = await instance(root);
  try {
    const alpha = await app.project('Alpha attention');
    const beta = await app.project('Beta attention');
    const start = new Date(Date.now() - 60 * 1000);
    const expires = new Date(Date.now() + 30 * 60 * 1000);
    const store = approvalStore(app.control, start);
    for (let index = 0; index < 105; index += 1) spend(alpha.id, store, expires);
    for (let index = 0; index < 3; index += 1) spend(beta.id, store, expires);

    const first = await app.attention(alpha.id, '?limit=20');
    assert.equal(first.status, 200);
    assert.equal(first.body.count.open, 105, 'the exact count is not the capped page');
    assert.equal(first.body.count.capped, true);
    assert.equal(first.body.count.complete, true);
    assert.equal(first.body.count.byKind.approval, 105);
    assert.equal(first.body.page.capped, true);
    assert.equal(first.body.page.listedCap, 100);
    assert.equal(first.body.page.returned, 20);
    assert.equal(first.body.limits.policy, 'proposed');
    assert.equal(first.body.limits.perPage, 20);
    assert.ok(first.body.items.every((item: any) => item.projectId === alpha.id), 'no foreign project leaks in');
    assert.ok(first.body.items.every((item: any) => item.kind === 'approval'));
    assert.ok(first.body.items.every((item: any) => !('nonce' in item)), 'an approval nonce is never returned');
    assert.ok(!JSON.stringify(first.body).includes('nonce'), 'no nonce field anywhere in the response');

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response = await app.attention(alpha.id, '?limit=20' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)));
      assert.equal(response.status, 200);
      seen.push(...response.body.items.map((item: any) => item.id));
      cursor = response.body.page.nextCursor;
      if (cursor === null) break;
    }
    assert.equal(seen.length, 100, 'at most 100 open items are listed');
    assert.equal(new Set(seen).size, 100);
    const instants = first.body.items.map((item: any) => item.at);
    assert.deepEqual(instants, [...instants].sort(), 'equal severities are oldest-first');
    const again = await app.attention(alpha.id, '?limit=20');
    assert.deepEqual(again.body.items.map((item: any) => item.id), first.body.items.map((item: any) => item.id), 'two reads over unchanged storage return the same page');

    const count = await (await fetch(app.security.origin + '/api/projects/' + alpha.id + '/attention/count', { headers: app.token })).json() as any;
    assert.equal(count.count.open, 105);
    assert.equal(count.count.capped, true);
    assert.equal(count.count.complete, true);

    const other = await app.attention(beta.id);
    assert.equal(other.body.count.open, 3);
    assert.ok(other.body.items.every((item: any) => item.projectId === beta.id));

    const post = await fetch(app.security.origin + '/api/projects/' + alpha.id + '/attention', { method: 'POST', headers: app.writes, body: '{}' });
    assert.equal(post.status, 405, 'reading attention is a GET route only');
  } finally {
    await app.created.close();
  }
});

test('attention is scoped exactly: a session-scoped approval appears only in its own project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-scope-'));
  const app = await instance(root);
  try {
    const alpha = await app.project('Scope alpha');
    const beta = await app.project('Scope beta');
    const sessions = async (projectId: string) => await (await fetch(app.security.origin + '/api/sessions', { method: 'POST', headers: app.writes, body: JSON.stringify({ projectId, name: 'Scoped session' }) })).json() as any;
    const alphaSession = await sessions(alpha.id);
    const betaSession = await sessions(beta.id);
    const start = new Date(Date.now() - 1000);
    const expires = new Date(Date.now() + 20 * 60 * 1000);
    const store = approvalStore(app.control, start);
    store.create({ kind: 'deploy', scope: { sessionId: alphaSession.session.id }, target: { endpoint: 'https://deploy.example.test/alpha', releaseId: 'rel-alpha' }, expiresAt: expires.toISOString() });
    store.create({ kind: 'deploy', scope: { sessionId: betaSession.session.id }, target: { endpoint: 'https://deploy.example.test/beta', releaseId: 'rel-beta' }, expiresAt: expires.toISOString() });
    // An approval whose scope names neither a project nor a known session cannot be attributed:
    // it stays in the approvals store and is not guessed into either project's attention.
    store.create({ kind: 'publish', scope: { operation: 'nightly' }, target: { channel: 'docs', artifact: 'site' }, expiresAt: expires.toISOString() });

    const alphaView = await app.attention(alpha.id);
    const betaView = await app.attention(beta.id);
    assert.equal(alphaView.body.count.open, 1);
    assert.equal(betaView.body.count.open, 1);
    assert.equal(alphaView.body.items[0].sessionId, alphaSession.session.id);
    assert.equal(alphaView.body.items[0].target.releaseId, 'rel-alpha');
    assert.equal(betaView.body.items[0].target.releaseId, 'rel-beta');
    assert.ok(!JSON.stringify(alphaView.body).includes('rel-beta'));
  } finally {
    await app.created.close();
  }
});

test('a question appears while open, leaves after it is answered, and a dismissal is not an open question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-question-'));
  const app = await instance(root);
  try {
    // A scripted conversation asks once. The dismissal case therefore gets its own project, so the
    // second `[ask]` really asks instead of being treated as the already-recorded question.
    const dismissedProject = await app.project('Dismissed question attention');
    const dismissedBase = app.security.origin + '/api/projects/' + dismissedProject.id + '/agents';
    const send = async (base: string, text: string) => await fetch(base + '/input', { method: 'POST', headers: app.writes, body: JSON.stringify({ text, mode: 'followUp' }) });
    assert.equal((await send(dismissedBase, '[ask] should I archive the old export?')).status, 200);
    const second = await waitFor(async () => {
      const view = await (await fetch(dismissedBase, { headers: app.token })).json() as any;
      return view.view.questions.find((candidate: any) => !candidate.answer && candidate.text.includes('archive the old export'));
    });
    const openDismissed = await app.attention(dismissedProject.id);
    assert.equal(openDismissed.body.count.byKind.question, 1);
    const dismissed = await fetch(dismissedBase + '/dismiss', { method: 'POST', headers: app.writes, body: JSON.stringify({ questionId: second.id, reason: 'Not now; the export is still in use.' }) });
    assert.equal(dismissed.status, 200, await dismissed.text());
    const afterDismiss = await app.attention(dismissedProject.id);
    assert.equal(afterDismiss.body.count.byKind.question, 0, 'a dismissal is not an open question');
    const view = await (await fetch(dismissedBase, { headers: app.token })).json() as any;
    assert.equal(view.view.dismissals[second.id].reason, 'Not now; the export is still in use.', 'the dismissal reason stays durable in the transcript');

    const project = await app.project('Question attention');
    const base = app.security.origin + '/api/projects/' + project.id + '/agents';
    assert.equal((await send(base, '[ask] add the invoice export')).status, 200);
    const asked = await waitFor(async () => {
      const agentView = await (await fetch(base, { headers: app.token })).json() as any;
      return agentView.view.questions.find((candidate: any) => !candidate.answer && candidate.text.includes('invoice export'));
    });

    const open = await app.attention(project.id);
    const item = open.body.items.find((candidate: any) => candidate.kind === 'question');
    assert.ok(item, 'the open question is an attention item: ' + JSON.stringify(open.body));
    assert.equal(item.questionId, asked.id);
    assert.equal(item.sessionId, '1');
    assert.match(item.context, /invoice export/);
    assert.deepEqual(item.actions, ['open']);

    const answered = await fetch(base + '/answer', { method: 'POST', headers: app.writes, body: JSON.stringify({ questionId: asked.id, text: 'Yes, use CSV' }) });
    assert.equal(answered.status, 200, await answered.text());
    const afterAnswer = await app.attention(project.id);
    assert.equal(afterAnswer.body.count.byKind.question, 0, 'an answered question is resolved by evidence, not by viewing');
  } finally {
    await app.created.close();
  }
});

test('a failed run offers retry, and an uncertain interruption offers no replay and refuses resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-lifecycle-'));
  const app = await instance(root);
  try {
    const project = await app.project('Lifecycle attention');
    const createSession = async (name: string) => await (await fetch(app.security.origin + '/api/sessions', { method: 'POST', headers: app.writes, body: JSON.stringify({ projectId: project.id, name }) })).json() as any;
    const failedSession = (await createSession('Failed run')).session;
    const interruptedSession = (await createSession('Interrupted run')).session;
    // Retry dispatches into the session's own conversation, so the conversation must exist first.
    // This is the ordinary named-session path, not a shortcut in the attention surface.
    const namedBase = app.security.origin + '/api/projects/' + project.id + '/agents';
    await fetch(namedBase + '/input', { method: 'POST', headers: app.writes, body: JSON.stringify({ text: 'first attempt', mode: 'followUp', sessionId: failedSession.id }) });
    await waitFor(async () => {
      const view = await (await fetch(namedBase + '?sessionId=' + encodeURIComponent(failedSession.id), { headers: app.token })).json() as any;
      return view.view.entries.length > 0 && !view.view.working ? view : undefined;
    });
    const lifecycle = new SessionLifecycleStore(app.control);
    lifecycle.markRunning({ projectId: project.id, sessionId: failedSession.id, requestId: 'request-failed' });
    lifecycle.markSettled({ projectId: project.id, sessionId: failedSession.id, outcome: 'failed', reason: 'The provider refused the request.' });
    lifecycle.markRunning({ projectId: project.id, sessionId: interruptedSession.id, requestId: 'request-interrupted' });
    adoptRunningSessions(lifecycle, new Date());

    const view = await app.attention(project.id);
    assert.equal(view.body.count.byKind.failure, 1);
    assert.equal(view.body.count.byKind.interrupted, 1);
    const failure = view.body.items.find((item: any) => item.kind === 'failure');
    const interruptedItem = view.body.items.find((item: any) => item.kind === 'interrupted');
    assert.deepEqual(failure.actions, ['retry']);
    assert.match(failure.context, /provider refused/);
    assert.equal(interruptedItem.uncertain, true);
    assert.deepEqual(interruptedItem.actions, [], 'an uncertain interruption offers no replay');

    const resume = await fetch(app.security.origin + '/api/sessions/' + interruptedSession.id + '/lifecycle/resume', { method: 'POST', headers: app.writes, body: JSON.stringify({ projectId: project.id, revision: interruptedItem.lifecycleRevision }) });
    assert.equal(resume.status, 409);
    assert.match((await resume.json() as any).error, /operator must decide|not be proven idempotent/i);
    const stillThere = await app.attention(project.id);
    assert.equal(stillThere.body.count.byKind.interrupted, 1, 'a refused resume changes nothing');

    // Retry is the one offered action for a failure, and it is explicit: the request only happens
    // when the owner sends it, never while reading the surface.
    const retry = await fetch(app.security.origin + '/api/sessions/' + failedSession.id + '/lifecycle/retry', { method: 'POST', headers: app.writes, body: JSON.stringify({ projectId: project.id, revision: failure.lifecycleRevision }) });
    const retried = await retry.text();
    assert.equal(retry.status, 200, retried);
    assert.equal((JSON.parse(retried) as any).dispatched, true);
  } finally {
    await app.created.close();
  }
});

test('reading attention opens no harness: the transcript and its conversations are unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-readonly-'));
  let app = await instance(root);
  let projectId = '';
  try {
    const project = await app.project('Read-only attention');
    projectId = project.id;
    const base = app.security.origin + '/api/projects/' + project.id + '/agents';
    await fetch(base + '/input', { method: 'POST', headers: app.writes, body: JSON.stringify({ text: '[ask] is the transcript untouched?', mode: 'followUp' }) });
    await waitFor(async () => {
      const view = await (await fetch(base, { headers: app.token })).json() as any;
      return view.view.questions.length > 0 ? view : undefined;
    });
    await app.created.close();
    const directory = join(root, 'agents', projectId);
    const files = ['session.sqlite', 'session.sqlite-wal', 'session.sqlite-shm'];
    const before: Record<string, string | null> = {};
    for (const file of files) before[file] = await readFile(join(directory, file)).then(bytes => bytes.toString('base64')).catch(() => null);
    const beforeStat = await stat(join(directory, 'session.sqlite'));

    // A fresh process reads attention twice. Nothing in that path may open the harness.
    app = await instance(root);
    const first = await app.attention(projectId);
    const second = await app.attention(projectId);
    assert.equal(first.status, 200);
    assert.equal(first.body.count.byKind.question, 1);
    assert.deepEqual(first.body.items, second.body.items, 'two reads over unchanged storage are deep-equal');

    const after: Record<string, string | null> = {};
    for (const file of files) after[file] = await readFile(join(directory, file)).then(bytes => bytes.toString('base64')).catch(() => null);
    assert.deepEqual(after, before, 'the transcript and its sidecars are byte-identical after a read');
    const afterStat = await stat(join(directory, 'session.sqlite'));
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  } finally {
    await app.created.close();
  }
});

test('a cursor stays a keyset position after the item it named is consumed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-stale-'));
  const app = await instance(root);
  try {
    const project = await app.project('Stale cursor');
    const expires = new Date(Date.now() + 30 * 60 * 1000);
    const store = approvalStore(app.control, new Date(Date.now() - 5000));
    for (let index = 0; index < 4; index += 1) spend(project.id, store, expires);
    const first = await app.attention(project.id, '?limit=2');
    assert.equal(first.body.items.length, 2);
    const cursorItem = first.body.items[1];
    const consumed = await fetch(app.security.origin + '/api/approvals/' + cursorItem.approvalId + '/consume', {
      method: 'POST', headers: app.writes,
      body: JSON.stringify({ scope: cursorItem.scope, kind: cursorItem.approvalKind, target: cursorItem.target, consumedBy: 'owner' })
    });
    assert.equal(consumed.status, 200, await consumed.text());
    const next = await app.attention(project.id, '?limit=2&cursor=' + encodeURIComponent(first.body.page.nextCursor));
    assert.equal(next.status, 200);
    assert.equal(next.body.items.length, 2);
    assert.ok(!next.body.items.some((item: any) => item.id === cursorItem.id), 'the consumed item is not repeated');
    // The four approvals were issued one second apart, so the remaining page is the third and fourth.
    assert.deepEqual(next.body.items.map((item: any) => item.at), [...next.body.items.map((item: any) => item.at)].sort());
    assert.equal(next.body.count.open, 3, 'the exact count reflects the durable consumption');
    const again = await fetch(app.security.origin + '/api/approvals/' + cursorItem.approvalId + '/consume', {
      method: 'POST', headers: app.writes,
      body: JSON.stringify({ scope: cursorItem.scope, kind: cursorItem.approvalKind, target: cursorItem.target, consumedBy: 'owner' })
    });
    assert.equal(again.status, 409, 'a consumed approval cannot be consumed twice');
    assert.match((await again.json() as any).error, /already consumed/);
  } finally {
    await app.created.close();
  }
});

test('an unreadable transcript is reported as unavailable rather than as no questions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-unreadable-'));
  const app = await instance(root);
  try {
    const project = await app.project('Unreadable transcript');
    // A directory where the transcript file belongs makes the read-only open fail.
    await mkdir(join(root, 'agents', project.id, 'session.sqlite'), { recursive: true });
    await writeFile(join(root, 'agents', project.id, 'note.txt'), 'not a transcript');
    const view = await app.attention(project.id);
    assert.equal(view.status, 200);
    assert.equal(view.body.sources.questions, 'unavailable');
    assert.equal(view.body.count.open, 0);
    assert.equal(view.body.count.complete, false, 'an unreadable source makes the count incomplete, not an exact zero');
    const onlyCount = await (await fetch(app.security.origin + '/api/projects/' + project.id + '/attention/count', { headers: app.token })).json() as any;
    assert.equal(onlyCount.count.complete, false);
    assert.equal(onlyCount.sources.questions, 'unavailable');
  } finally {
    await app.created.close();
  }
});

test('a session-only approval is attributed only when the registry proves one global owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-session-scope-'));
  let app = await instance(root);
  try {
    const alpha = await app.project('Legacy session alpha');
    const beta = await app.project('Legacy session beta');
    // Give both projects a root conversation, so the next start adopts the legacy session `1` into
    // each project's own registry. The same id in two projects is the ambiguity under test.
    for (const projectId of [alpha.id, beta.id]) {
      const input = await fetch(app.security.origin + '/api/projects/' + projectId + '/agents/input', { method: 'POST', headers: app.writes, body: JSON.stringify({ text: 'root conversation', mode: 'followUp' }) });
      assert.equal(input.status, 200, await input.text());
    }
    await app.created.close();
    app = await instance(root);

    const sessionsOf = async (projectId: string) => (await (await fetch(app.security.origin + '/api/sessions?projectId=' + projectId, { headers: app.token })).json() as any).sessions as { id: string }[];
    assert.ok((await sessionsOf(alpha.id)).some(session => session.id === '1'), 'alpha adopted the legacy session 1');
    assert.ok((await sessionsOf(beta.id)).some(session => session.id === '1'), 'beta adopted the legacy session 1');

    const expires = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const legacy = await (await fetch(app.security.origin + '/api/approvals', {
      method: 'POST', headers: app.writes,
      body: JSON.stringify({ kind: 'publish', scope: { sessionId: '1' }, target: { channel: 'docs', artifact: 'legacy-one' }, expiresAt: expires })
    })).json() as any;
    assert.ok(legacy.approval?.id);

    // The legacy id `1` belongs to both registries, so it is not proof of either project.
    assert.equal((await app.attention(alpha.id)).body.count.byKind.approval, 0);
    assert.equal((await app.attention(beta.id)).body.count.byKind.approval, 0);
    assert.ok(!JSON.stringify((await app.attention(alpha.id)).body).includes('legacy-one'));
    assert.ok(!JSON.stringify((await app.attention(beta.id)).body).includes('legacy-one'));

    // A unique session id in alpha is proof for alpha and for no other project.
    const unique = (await (await fetch(app.security.origin + '/api/sessions', { method: 'POST', headers: app.writes, body: JSON.stringify({ projectId: alpha.id, name: 'Unique scoped session' }) })).json() as any).session;
    const scoped = await (await fetch(app.security.origin + '/api/approvals', {
      method: 'POST', headers: app.writes,
      body: JSON.stringify({ kind: 'deploy', scope: { sessionId: unique.id }, target: { endpoint: 'https://deploy.example.test/unique', releaseId: 'rel-unique' }, expiresAt: expires })
    })).json() as any;
    const alphaView = await app.attention(alpha.id);
    const betaView = await app.attention(beta.id);
    assert.equal(alphaView.body.count.byKind.approval, 1);
    assert.equal(alphaView.body.items.find((item: any) => item.kind === 'approval').approvalId, scoped.approval.id);
    assert.equal(betaView.body.count.byKind.approval, 0);
    assert.ok(!JSON.stringify(betaView.body).includes('rel-unique'));

    // Project scope stays authoritative: a project-scoped approval is not reachable from another
    // project's projection, and a consumption with that other project's scope is refused.
    const projectScoped = await (await fetch(app.security.origin + '/api/approvals', {
      method: 'POST', headers: app.writes,
      body: JSON.stringify({ kind: 'spend', scope: { projectId: alpha.id }, target: { amountMinor: 500, currency: 'AUD' }, expiresAt: expires })
    })).json() as any;
    assert.equal((await app.attention(alpha.id)).body.count.byKind.approval, 2);
    assert.equal((await app.attention(beta.id)).body.count.byKind.approval, 0);
    const foreignConsume = await fetch(app.security.origin + '/api/approvals/' + projectScoped.approval.id + '/consume', {
      method: 'POST', headers: app.writes,
      body: JSON.stringify({ scope: { projectId: beta.id }, kind: 'spend', target: { amountMinor: 500, currency: 'AUD' }, consumedBy: 'owner' })
    });
    assert.equal(foreignConsume.status, 403, 'a foreign project scope cannot consume the grant');
    const ownConsume = await fetch(app.security.origin + '/api/approvals/' + projectScoped.approval.id + '/consume', {
      method: 'POST', headers: app.writes,
      body: JSON.stringify({ scope: { projectId: alpha.id }, kind: 'spend', target: { amountMinor: 500, currency: 'AUD' }, consumedBy: 'owner' })
    });
    assert.equal(ownConsume.status, 200, await ownConsume.text());
  } finally {
    await app.created.close();
  }
});

test('a failed registry owner lookup marks approvals unavailable and attributes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-owner-failure-'));
  const now = new Date();
  const record = {
    version: 1, id: randomUUID(), kind: 'deploy', scope: { sessionId: 'some-session' },
    target: { endpoint: 'https://deploy.example.test/unproven', releaseId: 'rel-unproven' },
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 20 * 60 * 1000).toISOString(),
    nonce: '0'.repeat(64), state: 'pending', consumedAt: null, consumedBy: null, revokedAt: null
  };
  const built = buildAttention({
    projectId: randomUUID(), dataRoot: root, now, bindings: [],
    sessionOwners: () => { throw new Error('the registry could not be read'); },
    approvals: { records: () => [record as any] }
  });
  assert.equal(built.sources.approvals, 'unavailable');
  assert.equal(built.items.filter(item => item.kind === 'approval').length, 0, 'attribution fails closed');
  assert.ok(!JSON.stringify(built.items).includes('rel-unproven'));
});

test('the question reader follows the active transcript head and reports a missing instant as unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-head-'));
  const app = await instance(root);
  try {
    const project = await app.project('Head marker attention');
    const directory = join(root, 'agents', project.id);
    await mkdir(directory, { recursive: true });
    const database = new DatabaseSync(join(directory, 'session.sqlite'));
    try {
      database.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)))');
      const insert = database.prepare('INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)');
      insert.run(10, 1, null, 1, JSON.stringify({ id: 10, conversationId: 1, kind: 'app.question', data: { questionId: 'hidden-question', text: 'Hidden before the reset', askedAt: 1700000000000 } }));
      insert.run(20, 1, 20, 2, JSON.stringify({ id: 20, conversationId: 1, kind: 'pi.reset', head: 20 }));
      insert.run(30, 1, null, 3, JSON.stringify({ id: 30, conversationId: 1, kind: 'app.question', data: { questionId: 'active-question', text: 'Active after the reset' } }));
    } finally {
      database.close();
    }
    const view = await app.attention(project.id);
    assert.equal(view.status, 200);
    assert.equal(view.body.sources.questions, 'read');
    assert.equal(view.body.count.byKind.question, 1, 'only the active question is listed');
    const item = view.body.items.find((candidate: any) => candidate.kind === 'question');
    assert.equal(item.questionId, 'active-question');
    assert.equal(item.at, null, 'a missing askedAt is unknown, not the epoch');
    assert.ok(!JSON.stringify(view.body).includes('Hidden before the reset'), 'hidden history is not returned');
  } finally {
    await app.created.close();
  }
});

test('an invalid cursor or page size is refused with 422, not treated as page one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-attention-invalid-'));
  const app = await instance(root);
  try {
    const project = await app.project('Invalid cursor');
    assert.equal((await app.attention(project.id, '?cursor=not-a-cursor')).status, 422);
    assert.equal((await app.attention(project.id, '?limit=0')).status, 422);
    assert.equal((await app.attention(project.id, '?limit=101')).status, 422);
  } finally {
    await app.created.close();
  }
});
