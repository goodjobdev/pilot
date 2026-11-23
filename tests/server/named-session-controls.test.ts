import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessHost, type AgentSessionView } from '../../src/server/agents/harness-host';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentStore } from '../../src/server/state/agent-store';
import { SessionLifecycleStore, adoptRunningSessions } from '../../src/server/state/session-lifecycle';
import type { AgentScope } from '../../src/shared/agent-registry';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 7000;
  while (!await check()) { if (Date.now() > end) throw Error('named session condition timed out'); await sleep(15); }
}

test('named controls, authority revocation, questions, completion and recovery stay conversation-scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-named-controls-'));
  const project = { id: '1039aabc-69bc-45fa-9253-6932123cdbda', name: 'Disposable', path: join(root, 'project'), managed: true, repository: '', created: new Date().toISOString() };
  await mkdir(project.path);
  const control = new ControlStore(root);
  const store = new AgentStore(control, { models: () => [], projectKnown: id => id === project.id });
  const lifecycle = new SessionLifecycleStore(control);
  const a = 'named-a', b = 'named-b';
  let scopes: readonly AgentScope[] = ['record_note', 'ask_question'];
  // The owner root and numeric aliases have deliberately different authority.
  const authorityReads: string[] = [];
  const settled: string[] = [], began: string[] = [], surfaced: string[] = [], answered: string[] = [];
  const options = {
    dataRoot: root, enabled: true, pauseMs: 350,
    conversationBinding: {
      read: (projectId: string, sessionId: string) => store.conversation(projectId, sessionId),
      list: (projectId: string) => store.conversations(projectId),
      record: (input: { projectId: string; sessionId: string; conversationId: number }) => { store.recordConversation({ ...input, actor: { kind: 'owner', identity: 'test' } }); }
    },
    privileges: { authority: async ({ sessionId }: { projectId: string; sessionId?: string }) => {
      authorityReads.push(sessionId!);
      return { model: null, agentId: sessionId === a ? 'agent-a' : null, scopes: sessionId === a ? scopes : null, projects: null, emptyReason: null };
    } },
    lifecycle: {
      began: ({ sessionId, requestId }: { sessionId: string; requestId: string }) => {
        began.push(sessionId);
        lifecycle.markRunning({ projectId: project.id, sessionId, requestId });
      },
      settled: ({ sessionId, outcome }: { sessionId: string; outcome: 'idle' | 'failed' }) => {
        settled.push(sessionId);
        lifecycle.markSettled({ projectId: project.id, sessionId, outcome });
      }
    },
    delivery: {
      questionSurfaced: async ({ sessionId }: { sessionId: string }) => { surfaced.push(sessionId); },
      answerRecorded: async ({ sessionId }: { sessionId: string }) => { answered.push(sessionId); },
      answerDelivered: async () => {}, ledgerView: () => ({})
    }
  };
  let host = new HarnessHost(options);
  const view = async (id: string) => (await host.sessionView(project, id)) as AgentSessionView;
  try {
    await host.submit(project, { text: 'DISTINCT ROOT INPUT', mode: 'followUp' });
    await until(async () => !(await host.view(project)).working);
    const aid = await host.ensureSessionConversation(project, a);
    await host.ensureSessionConversation(project, b);
    // Revoke after the allowed tool set was captured. A numeric alias must not restore owner tools.
    scopes = [];
    await host.submit(project, { sessionId: String(aid), text: '[note forbidden]', mode: 'followUp' });
    await until(async () => !(await view(a)).working);
    assert.ok(authorityReads.includes(a));
    assert.ok(!authorityReads.includes(String(aid)), 'hooks must resolve the named authority, not the numeric alias');
    await assert.rejects(readFile(join(project.path, 'docs/notes.md')), { code: 'ENOENT' });
    assert.ok((await view(a)).entries.some(entry => /refused|privilege/i.test(entry.text)));
    scopes = ['ask_question'];
    await host.submit(project, { sessionId: a, text: '[ask] named question', mode: 'followUp' });
    await until(async () => !(await view(a)).working && (await view(a)).questions.length === 1);
    const question = (await view(a)).questions[0];
    assert.ok(surfaced.includes(a), 'named question delivery records the authoritative identity');
    await assert.rejects(host.answer(project, { sessionId: b, questionId: question.id, text: 'wrong session' }), /Unknown question/);
    await host.answer(project, { sessionId: a, questionId: question.id, text: 'named answer' });
    await until(async () => !(await view(a)).working);
    assert.deepEqual(answered, [a]);
    const completedInput = { sessionId: a, text: 'REPEAT COMPLETED INPUT', requestId: 'completed-input', mode: 'followUp' as const };
    const initialSubmission = await host.submit(project, completedInput);
    await until(async () => !(await view(a)).working && lifecycle.read(project.id, a).state === 'idle');
    const completedLifecycle = lifecycle.read(project.id, a);
    const completedEntryCount = (await view(a)).entries.length;
    const repeatedSubmission = await host.submit(project, completedInput);
    assert.deepEqual(repeatedSubmission, initialSubmission);
    assert.equal((await view(a)).working, false);
    assert.equal((await view(a)).entries.length, completedEntryCount);
    assert.deepEqual(lifecycle.read(project.id, a), completedLifecycle, 'a completed request repeat creates no lifecycle attempt or revision');
    const cutoff = Number((await view(a)).entries.at(-1)!.id);
    const firstReceipt = await host.redeliverAnswer(project, question.id, undefined, a);
    const repeatReceipt = await host.redeliverAnswer(project, question.id, undefined, a);
    assert.deepEqual(repeatReceipt, firstReceipt, 'answer reconciliation is idempotent');
    assert.equal((await host.view(project)).questions.length, 0);
    await host.submit(project, { sessionId: a, text: '[pause] ONLY A', requestId: 'original-a', mode: 'followUp' });
    await host.submit(project, { sessionId: b, text: '[pause] ONLY B', requestId: 'original-b', mode: 'followUp' });
    await until(async () => (await view(a)).working && (await view(b)).working);
    const activeLifecycle = lifecycle.read(project.id, a);
    await host.submit(project, completedInput);
    assert.equal((await view(a)).working, true);
    assert.deepEqual(lifecycle.read(project.id, a), activeLifecycle, 'a terminal repeat must not replace another active request');
    await host.cancelLifecycle(project, a);
    // The owner service owns this write when it invokes the cancellation port.
    lifecycle.markSettled({ projectId: project.id, sessionId: a, outcome: 'idle' });
    assert.equal((await view(a)).working, false);
    assert.equal((await view(b)).working, true, 'a named pause must not stop the other conversation');
    await until(async () => !(await view(b)).working);
    assert.ok(settled.includes(b));
    assert.ok(began.includes(a) && began.includes(b));
    await host.close();
    host = new HarnessHost(options);
    // Resolve the named parent's durable binding with an empty in-process cache.
    assert.equal(await host.hasEntry(project, a, cutoff, 1000), true);
    assert.equal(await host.hasEntry(project, a, cutoff, 1), false, 'the bounded scan must not guess at a later cutoff');
    assert.equal(await host.hasEntry(project, b, cutoff, 1000), false, 'a foreign conversation cannot supply the cutoff');
    const child = await host.forkTranscript(project, a, cutoff);
    const forked = await view(child.childSessionId);
    assert.ok(forked.entries.some(entry => entry.text.includes('REPEAT COMPLETED INPUT')));
    assert.ok(forked.entries.some(entry => Number(entry.id) === cutoff), 'the fork includes its cutoff');
    assert.ok(!forked.entries.some(entry => entry.text.includes('ONLY A') || entry.text.includes('ONLY B') || entry.text.includes('DISTINCT ROOT INPUT')), 'the fork excludes later parent entries and other conversations');
    assert.equal((await view(a)).conversationId, String(aid));
    const beforeRepeatAfterRestart = lifecycle.read(project.id, a);
    await host.submit(project, completedInput);
    assert.deepEqual(lifecycle.read(project.id, a), beforeRepeatAfterRestart, 'a completed repeat after restart also leaves the lifecycle unchanged');
    assert.equal(adoptRunningSessions(lifecycle, new Date()).adopted, 0, 'a completed repeat must not create a false uncertain interruption');
    await host.dispatchLifecycle(project, 'retry-a', a);
    await until(async () => !(await view(a)).working);
    const replay = await view(a);
    assert.equal(replay.entries.filter(entry => entry.rawKind === 'pi.user' && entry.text.includes('ONLY A')).length, 2);
    assert.ok(!replay.entries.some(entry => entry.text.includes('DISTINCT ROOT INPUT') || entry.text.includes('ONLY B')));
    const count = replay.entries.length;
    await host.dispatchLifecycle(project, 'retry-a', a);
    await sleep(40);
    assert.equal((await view(a)).entries.length, count, 'recovery request identity prevents duplicate replay');
    assert.ok(settled.filter(id => id === a).length >= 2, 'named completion remains watched after restart');
    await host.setModel(project, null, a);
    await host.abort(project, a);
  } finally {
    await host.close(); control.close(); await rm(root, { recursive: true, force: true });
  }
});
