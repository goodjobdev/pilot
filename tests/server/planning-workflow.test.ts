import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import { BoardStore, hash } from '../../src/server/board-store';
import { emptyBoard, newTask, type Project } from '../../src/shared/model';
import { serializeBoard } from '../../src/shared/markdown';
import { applyOperation } from '../../src/shared/schema';
import type { AgentScope } from '../../src/shared/agent-registry';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw Error('Faux run timed out'); await pause(20); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-planning-flow-'));
  const project: Project = { id: randomUUID(), name: 'Fixture', path: join(root, 'project'), managed: true, repository: '', created: '' };
  await mkdir(join(project.path, 'docs/dashboard'), { recursive: true });
  await writeFile(join(project.path, 'docs/plan.md'), '# Plan\nBuild the API before the client.\n');
  await writeFile(join(project.path, 'docs/dashboard/board.md'), serializeBoard(emptyBoard()));
  const fake = fauxProvider({ provider: 'planning-faux', models: [{ id: 'fixture' }] });
  const providers = new ProviderStore(root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'planning-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  return { root, project, fake, providers, boards: new BoardStore(root) };
}

test('Faux reads evidence and populates milestones, tasks and dependency with checked revisions', async () => {
  const f = await fixture();
  const host = new HarnessHost({ dataRoot: f.root, enabled: true, providers: f.providers, boards: f.boards });
  try {
    const first = newTask(randomUUID(), 'Build API'), second = newTask(randomUUID(), 'Build client');
    first.milestone = second.milestone = 'phase-one';
    first.specs = second.specs = [{ path: 'docs/plan.md', anchor: 'plan' }];
    const edge = { id: randomUUID(), source: first.id, target: second.id, kind: 'blocks' as const };
    let board = emptyBoard(), revision = hash(serializeBoard(board));
    const calls: { name: string; args: Record<string, unknown> }[] = [
      { name: 'list_docs', args: {} }, { name: 'read_doc', args: { path: 'docs/plan.md' } }, { name: 'read_board', args: {} }
    ];
    const operations = [
      { op: 'metadata', domains: board.domains, milestones: [{ id: 'phase-one', name: 'Phase one', order: 0 }] },
      { op: 'putTask', task: first }, { op: 'putTask', task: second }, { op: 'putEdge', edge }
    ];
    calls.push({ name: 'write_board', args: { revision, operations } });
    for (const operation of operations) board = applyOperation(board, operation);
    revision = hash(serializeBoard(board));
    f.fake.setResponses([...calls.map(call => () => fauxAssistantMessage([fauxToolCall(call.name, call.args as never)], { stopReason: 'toolUse' })), () => fauxAssistantMessage('Planning complete.')]);
    await host.submit(f.project, { text: 'Populate the board from the plan', mode: 'followUp' });
    await until(async () => (await host.view(f.project)).entries.some(entry => entry.text.includes('Planning complete.')));
    const actual = await f.boards.read(f.project);
    assert.deepEqual(actual.board, board);
    assert.equal(actual.revision, revision);
    assert.equal(f.fake.state.callCount, 5);
  } finally { await host.close(); await f.providers.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('existing root and named selections migrate durably and a live scope revocation blocks the write', async () => {
  const f = await fixture();
  const bindings = new Map<string, number>();
  let scopes: readonly AgentScope[] = ['read_docs', 'write_docs'];
  const options = {
    dataRoot: f.root, enabled: true, providers: f.providers, boards: f.boards,
    privileges: { authority: async () => ({ model: null, agentId: 'fixture-agent', scopes, projects: [f.project.id], emptyReason: null }) },
    conversationBinding: {
      list: () => [...bindings].map(([sessionId, conversationId]) => ({ sessionId, conversationId })),
      read: (_projectId: string, sessionId: string) => bindings.has(sessionId) ? { conversationId: bindings.get(sessionId)!, revision: 1 } : null,
      record: (input: { sessionId: string; conversationId: number }) => { bindings.set(input.sessionId, input.conversationId); }
    }
  };
  let host = new HarnessHost(options);
  const raw = async (conversation: any) => { const view = await conversation.viewState(BACKGROUND_CONTEXT); try { return structuredClone(view.value.docs['pi.agent']); } finally { view.dispose(); } };
  try {
    const namedId = await host.ensureSessionConversation(f.project, 'named');
    const opened = await (host as any).open(f.project);
    const named = await opened.harness.conversation(namedId, BACKGROUND_CONTEXT);
    for (const conversation of [opened.conversation, named]) {
      const agent = await conversation.agent(BACKGROUND_CONTEXT);
      await conversation.configure({ extensions: agent.extensions.filter((extension: { name: string }) => !['planning', 'agent-privileges', 'uncertain-recovery-guard'].includes(extension.name)), tools: [], instructions: 'preserve draft instructions' }, BACKGROUND_CONTEXT);
      await conversation.submit({ type: 'write', entry: { kind: 'app.fixture', data: { text: 'preserve transcript' } } }, BACKGROUND_CONTEXT);
    }
    await host.close();
    host = new HarnessHost(options);
    const reopened = await (host as any).open(f.project);
    const restored = await reopened.harness.conversation(namedId, BACKGROUND_CONTEXT);
    for (const conversation of [reopened.conversation, restored]) {
      const state = await raw(conversation);
      assert.equal(state.model.provider, 'planning-faux');
      assert.equal(state.instructions, 'preserve draft instructions');
      assert.ok(state.extensions.includes('planning'));
      assert.ok(state.extensions.includes('agent-privileges'));
      assert.ok(state.extensions.includes('uncertain-recovery-guard'));
      assert.ok(state.tools.includes('read_doc') && state.tools.includes('write_board'));
      assert.ok(!state.tools.includes('record_note'));
      const view = await conversation.viewState(BACKGROUND_CONTEXT);
      try { assert.ok(view.value.entries.some((entry: { kind: string }) => entry.kind === 'app.fixture')); } finally { view.dispose(); }
    }
    const revision = (await f.boards.read(f.project)).revision;
    const task = newTask(randomUUID(), 'must not be written');
    f.fake.setResponses([
      () => { scopes = []; return fauxAssistantMessage([fauxToolCall('write_board', JSON.parse(JSON.stringify({ revision, operation: { op: 'putTask', task } })))], { stopReason: 'toolUse' }); },
      () => fauxAssistantMessage('Revocation observed.')
    ]);
    await host.submit(f.project, { sessionId: 'named', text: 'Attempt a write', mode: 'followUp' });
    await until(async () => (await host.sessionView(f.project, 'named'))?.entries.some(entry => entry.text.includes('Revocation observed.')) ?? false);
    assert.equal((await f.boards.read(f.project)).revision, revision);
    assert.ok((await host.sessionView(f.project, 'named'))?.entries.some(entry => /refused|privilege/i.test(entry.text)));
    scopes = ['read_docs'];
    f.fake.setResponses([
      () => { scopes = []; return fauxAssistantMessage([fauxToolCall('read_doc', { path: 'docs/plan.md' })], { stopReason: 'toolUse' }); },
      () => fauxAssistantMessage('Read revocation observed.')
    ]);
    await host.submit(f.project, { sessionId: 'named', text: 'Attempt a read', mode: 'followUp' });
    await until(async () => (await host.sessionView(f.project, 'named'))?.entries.some(entry => entry.text.includes('Read revocation observed.')) ?? false);
    assert.ok(!(await host.sessionView(f.project, 'named'))?.entries.some(entry => entry.text.includes('Build the API before the client.')));
  } finally { await host.close(); await f.providers.close(); await rm(f.root, { recursive: true, force: true }); }
});
