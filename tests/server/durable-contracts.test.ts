import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createModels } from '@earendil-works/pi-ai/models';
import { defineDoc } from '@earendil-works/pi-durable';
import { GenerationTask, Harness, createRegistry, defineExtension, defineTool, hook } from '@earendil-works/pi-durable';
import type { ConversationId, EntryId, ToolExecutionApi } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { agentViewFrom } from '../../src/shared/agent.js';

const sleep = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep();
  }
  throw new Error('condition was not met in time');
}
async function disposable() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-durable-contract-'));
  const path = join(root, 'agents/session.sqlite');
  await mkdir(join(root, 'agents'), { recursive: true });
  return { path, remove: () => rm(root, { recursive: true, force: true }) };
}
const currentDoc = defineDoc({
  kind: 'canary.current-document',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({ value: '' }),
  checkpointWhen: () => true
});
const requestLedgerDoc = defineDoc({
  kind: 'canary.request-ledger',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ requests: [] as string[], entryIds: [] as number[] }),
  checkpointWhen: () => true
});
const initialDoc = defineDoc({
  kind: 'canary.initial-document',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ value: '' }),
  checkpointWhen: () => true
});
async function open(path: string, extensions: unknown[] = [], requireBinding?: WeakMap<AbortSignal, Readonly<{ conversationId: string; taskId: string }>>, tokensPerSecond?: number) {
  const provider = fauxProvider(tokensPerSecond === undefined ? {} : { tokensPerSecond });
  provider.setResponses([fauxAssistantMessage('synthetic response')]);
  const models = createModels();
  models.setProvider(provider.provider);
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension as never);
  const dispatches: { signal?: AbortSignal; sessionId?: string }[] = [];
  const nativeStream = models.streamSimple.bind(models);
  models.streamSimple = ((model, context, options) => {
    dispatches.push({ signal: options?.signal, sessionId: options?.sessionId });
    if (requireBinding && (!options?.signal || !requireBinding.has(options.signal))) {
      const denied = createAssistantMessageEventStream();
      denied.end(fauxAssistantMessage('Dispatch denied: identity binding unavailable', { stopReason: 'error', errorMessage: 'identity binding unavailable' }));
      return denied;
    }
    return nativeStream(model, context, options);
  }) as typeof models.streamSimple;
  const storage = await openNodeSqliteStorage(path);
  const harness = await Harness.open(storage, {
    models,
    registry,
    settings: { retry: { enabled: false }, stream: { maxRetries: 0 }, compaction: { enabled: false } }
  }, BACKGROUND_CONTEXT);
  harness.resume();
  return { harness, storage, provider, dispatches };
}
async function close(value: Awaited<ReturnType<typeof open>>) {
  await value.harness.close(BACKGROUND_CONTEXT);
  await value.storage.close(BACKGROUND_CONTEXT);
}
async function readState(conversation: any) {
  const state = await conversation.viewState(BACKGROUND_CONTEXT);
  try { return state.value; } finally { await state.dispose(); }
}
type DispatchIdentity = Readonly<{ conversationId: string; taskId: string }>;
/** Advisory hook: binds the exact invocation abort signal to immutable public conversation/task identity. */
function recoveryIdentityGuard(bindings: WeakMap<AbortSignal, DispatchIdentity>, captures: { value?: DispatchIdentity } = {}) {
  return defineExtension({
    name: 'recovery-identity-guard',
    hooks: [hook(GenerationTask, { beforeRequest: (_request, api, context) => {
      const identity: DispatchIdentity = Object.freeze({ conversationId: String(api.conversationId), taskId: String(api.taskId) });
      captures.value = identity;
      if (context.abortSignal) bindings.set(context.abortSignal, identity);
      return undefined;
    } })]
  });
}
/** A faux response whose message resolves only on abort: the entered provider stream stays genuinely unfinished. */
function holdAtProviderEntry(entered: { resolve: () => void }) {
  return async (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
    entered.resolve();
    const signal = options?.signal;
    if (!signal) throw new Error('synthetic provider entry received no abort signal');
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return fauxAssistantMessage('unfinished provider entry', { stopReason: 'aborted' });
  };
}
/** Submit an ordinary generation, hold the entered faux provider stream unfinished, then clean-close it. */
async function holdUnfinishedGenerationAtProviderEntry(path: string) {
  const entered = deferred<void>();
  const bindings = new WeakMap<AbortSignal, DispatchIdentity>();
  const captures: { value?: DispatchIdentity } = {};
  const guard = recoveryIdentityGuard(bindings, captures);
  const runtime = await open(path, [guard], bindings);
  let closed = false;
  try {
    runtime.provider.setResponses([holdAtProviderEntry(entered)]);
    const conversation = await runtime.harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: runtime.provider.getModel().id }, extensions: [guard] }
    });
    await conversation.submit({ type: 'input', content: 'unfinished recovery generation' }, BACKGROUND_CONTEXT);
    await Promise.race([
      entered.promise,
      sleep(5000).then(() => { throw new Error('the ordinary faux provider stream was not entered in time'); })
    ]);
    const identity = captures.value;
    assert.ok(identity, 'the identity hook observed the original public conversation/task identity');
    assert.equal(runtime.provider.state.callCount, 1, 'the ordinary faux provider stream was entered before clean close');
    const signal = runtime.dispatches.at(-1)?.signal;
    assert.ok(signal, 'the entered provider stream carries an invocation abort signal');
    assert.deepEqual(bindings.get(signal), identity, 'the entered provider stream signal carries the trusted hook binding');
    const originalTask = await runtime.harness.getTask(identity.taskId as never, BACKGROUND_CONTEXT);
    assert.ok(originalTask, 'the original task is publicly addressable while unfinished');
    assert.equal(String(originalTask.conversationId), identity.conversationId);
    const beforeClose = await readState(conversation);
    assert.ok(beforeClose.docs['pi.live']?.generation, 'the generation checkpoint exists before clean close');
    assert.equal(beforeClose.entries.some((entry: any) => entry.kind === 'pi.assistant'), false, 'no assistant content settled while the provider stream was held');
    closed = true;
    await close(runtime);
    return { conversationId: conversation.id, identity, signal };
  } finally {
    if (!closed) await close(runtime);
  }
}

test('custom input-entry payload and request lookup are conversation-scoped and survive clean reopen', async () => {
  const db = await disposable();
  let runtime = await open(db.path);
  let firstId!: ConversationId;
  try {
    const first = await runtime.harness.root(BACKGROUND_CONTEXT);
    const second = await runtime.harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    const input = (text: string) => ({
      type: 'input' as const,
      content: text,
      requestId: 'same-key',
      entry: { kind: 'app.request', data: { source: 'synthetic', version: 1 } }
    });
    const one = await first.submit(input('first payload'), BACKGROUND_CONTEXT);
    const retry = await first.submit(input('changed retry body'), BACKGROUND_CONTEXT);
    const other = await second.submit(input('second conversation'), BACKGROUND_CONTEXT);
    assert.equal(one.id, retry.id, 'duplicate request resolves to the original submission');
    assert.notEqual(one.id, other.id, 'request IDs are scoped to conversation identity');
    const state = await readState(first);
    const custom = state.entries.find((entry: any) => entry.kind === 'app.request');
    assert.ok(custom);
    assert.deepEqual(custom.data, { source: 'synthetic', version: 1 });
    assert.equal(state.entries.filter((entry: any) => entry.kind === 'app.request').length, 1);
    assert.ok(!state.entries.some((entry: any) => entry.kind === 'pi.user'), 'custom entry replaces default user-entry kind');
    firstId = first.id;
    await close(runtime);
    runtime = await open(db.path);
    const restored = await runtime.harness.conversation(firstId, BACKGROUND_CONTEXT);
    assert.ok(restored);
    const reopened = await readState(restored);
    assert.ok(reopened.entries.some((entry: any) => entry.kind === 'app.request' && entry.data?.source === 'synthetic'));
  } finally {
    await close(runtime);
    await db.remove();
  }
});

test('transaction can atomically deduplicate an application document receipt and transcript entry', async () => {
  const db = await disposable();
  const runtime = await open(db.path);
  try {
    const conversation = await runtime.harness.root(BACKGROUND_CONTEXT);
    const applyOnce = () => conversation.commit(async tx => {
      const ledger = await tx.doc(requestLedgerDoc, conversation.id);
      const prior = ledger.requests.indexOf('stable-operation');
      if (prior >= 0) return ledger.entryIds[prior];
      const entry = await tx.appendEntry(conversation.id, { kind: 'app.operation', data: { requestId: 'stable-operation' } });
      ledger.requests.push('stable-operation');
      ledger.entryIds.push(entry.id);
      return entry.id;
    }, BACKGROUND_CONTEXT);
    const first = await applyOnce();
    const retry = await applyOnce();
    assert.equal(retry, first);
    const state = await readState(conversation);
    assert.equal(state.entries.filter((entry: any) => entry.kind === 'app.operation').length, 1);
    const stored = await conversation.commit(async tx => {
      const ledger = await tx.doc(requestLedgerDoc, conversation.id);
      return { requests: [...ledger.requests], entryIds: [...ledger.entryIds] };
    }, BACKGROUND_CONTEXT);
    assert.deepEqual(stored, { requests: ['stable-operation'], entryIds: [first] });
  } finally {
    await close(runtime);
    await db.remove();
  }
});

test('fork lineage uses entry cutoff and configured conversation-document fork policy', async () => {
  const db = await disposable();
  const runtime = await open(db.path);
  try {
    const parent = await runtime.harness.root(BACKGROUND_CONTEXT);
    let cutoff!: EntryId;
    await parent.commit(async tx => {
      (await tx.doc(currentDoc, parent.id)).value = 'current at cutoff';
      (await tx.doc(initialDoc, parent.id)).value = 'initial at cutoff';
      cutoff = (await tx.appendEntry(parent.id, { kind: 'app.fork-point', data: { name: 'baseline' } })).id;
    }, BACKGROUND_CONTEXT);
    await parent.commit(async tx => {
      (await tx.doc(currentDoc, parent.id)).value = 'current after cutoff';
      (await tx.doc(initialDoc, parent.id)).value = 'initial after cutoff';
    }, BACKGROUND_CONTEXT);
    const child = await parent.fork(cutoff, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    assert.notEqual(String(child.id), String(parent.id));
    const parentState = await readState(parent);
    const childState = await readState(child);
    assert.equal(String(childState.conversation.parent?.conversationId), String(parent.id));
    assert.equal(childState.conversation.parent?.at, cutoff);
    assert.ok(childState.entries.some((entry: any) => entry.kind === 'app.fork-point'));
    assert.equal(childState.entries.some((entry: any) => entry.kind === 'app.fork-point' && entry.data?.name !== 'baseline'), false);
    const current = await child.commit(async tx => (await tx.doc(currentDoc, child.id)).value, BACKGROUND_CONTEXT);
    const initial = await child.commit(async tx => (await tx.doc(initialDoc, child.id)).value, BACKGROUND_CONTEXT);
    assert.equal(current, 'current after cutoff', 'fork=current follows latest parent state at fork commit');
    assert.equal(initial, '', 'fork=initial initializes the child from the definition default rather than copying source state');
    const parentCurrent = await parent.commit(async tx => (await tx.doc(currentDoc, parent.id)).value, BACKGROUND_CONTEXT);
    assert.equal(parentCurrent, 'current after cutoff');
    assert.notEqual(parentState.conversation.id, childState.conversation.id);
  } finally {
    await close(runtime);
    await db.remove();
  }
});

test('generation beforeRequest context and streamSimple signal are identical for concurrent conversations', async () => {
  const db = await disposable();
  const hooks: { signal: AbortSignal | undefined; conversationId: string; taskId: string }[] = [];
  const identities = new WeakMap<AbortSignal, Readonly<{ conversationId: string; taskId: string }>>();
  const guard = defineExtension({
    name: 'signal-identity-canary',
    hooks: [hook(GenerationTask, {
      beforeRequest: (_request, api, context) => {
        const identity = Object.freeze({ conversationId: String(api.conversationId), taskId: String(api.taskId) });
        hooks.push({ signal: context.abortSignal, ...identity });
        if (context.abortSignal) identities.set(context.abortSignal, identity);
        return undefined;
      }
    })]
  });
  let runtime = await open(db.path, [guard]);
  const native = runtime.harness;
  const model = runtime.provider.getModel();
  let firstId!: ConversationId;
  let secondId!: ConversationId;
  try {
    const first = await native.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: model.id }, extensions: [guard] }
    });
    const second = await native.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { model: { provider: 'faux', modelId: model.id }, extensions: [guard] }
    }, BACKGROUND_CONTEXT);
    await first.submit({ type: 'input', content: 'first request fixture' }, BACKGROUND_CONTEXT);
    await second.submit({ type: 'input', content: 'second request fixture' }, BACKGROUND_CONTEXT);
    await native.waitForIdle(BACKGROUND_CONTEXT);
    firstId = first.id;
    secondId = second.id;
    assert.equal(hooks.length, 2, 'each conversation ran the trusted beforeRequest hook');
    assert.deepEqual(new Set(hooks.map(item => item.conversationId)), new Set([String(first.id), String(second.id)]));
    assert.equal(new Set(hooks.map(item => item.taskId)).size, 2);
    assert.ok(hooks.every(item => item.signal instanceof AbortSignal));
    assert.equal(runtime.dispatches.length, 2);
    assert.deepEqual(new Set(hooks.map(item => item.signal)), new Set(runtime.dispatches.map(item => item.signal)), 'the exact AbortSignal object reaches hook Context and provider dispatch');
    assert.notEqual(runtime.dispatches[0].signal, runtime.dispatches[1].signal, 'concurrent conversation invocations have distinct signals');
    assert.ok(runtime.dispatches.every(item => item.sessionId), 'dispatch receives persisted opaque provider session IDs');
    const initialSessionByConversation = new Map(runtime.dispatches.map(item => {
      const identity = item.signal && identities.get(item.signal);
      assert.ok(identity, 'a wrapper can deny dispatch when its trusted signal binding is absent');
      return [identity.conversationId, item.sessionId!];
    }));
    assert.equal(new Set(initialSessionByConversation.values()).size, 2, 'the observed persisted session IDs differ, but are not self-describing');
    await close(runtime);
    runtime = await open(db.path, [guard]);
    const reopenedFirst = await runtime.harness.conversation(firstId, BACKGROUND_CONTEXT);
    const reopenedSecond = await runtime.harness.conversation(secondId, BACKGROUND_CONTEXT);
    assert.ok(reopenedFirst && reopenedSecond);
    await reopenedFirst.submit({ type: 'input', content: 'first after clean reopen' }, BACKGROUND_CONTEXT);
    await reopenedSecond.submit({ type: 'input', content: 'second after clean reopen' }, BACKGROUND_CONTEXT);
    await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
    const reopenedSessionByConversation = new Map(runtime.dispatches.map(item => {
      const identity = item.signal && identities.get(item.signal);
      assert.ok(identity);
      return [identity.conversationId, item.sessionId!];
    }));
    assert.deepEqual(reopenedSessionByConversation, initialSessionByConversation, 'same conversations keep their opaque session IDs across clean reopen');
  } finally {
    await close(runtime);
    await db.remove();
  }
});

test('unfinished ordinary generation clean-close recovery rebuilds identity before enforced dispatch', async () => {
  const db = await disposable();
  try {
    // The entered ordinary faux provider stream is genuinely unfinished at clean close.
    const original = await holdUnfinishedGenerationAtProviderEntry(db.path);
    const bindings = new WeakMap<AbortSignal, DispatchIdentity>();
    const recoveredCaptures: { value?: DispatchIdentity } = {};
    const guard = recoveryIdentityGuard(bindings, recoveredCaptures);
    const runtime = await open(db.path, [guard], bindings);
    try {
      const recovered = await runtime.harness.conversation(original.conversationId, BACKGROUND_CONTEXT);
      assert.ok(recovered);
      await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
      const state = await readState(recovered);
      const task = await runtime.harness.getTask(original.identity.taskId as never, BACKGROUND_CONTEXT);
      assert.ok(task, 'original task remains publicly addressable after clean reopen');
      assert.equal(String(task.conversationId), original.identity.conversationId, 'recovered work stays owned by the original conversation');
      assert.deepEqual(recoveredCaptures.value, original.identity, 'recovered dispatch hook observes the exact original conversation/task identity');
      assert.equal(runtime.dispatches.length, 1, 'resumed unfinished work dispatches exactly one request without replacement input');
      const signal = runtime.dispatches[0].signal;
      assert.ok(signal, 'recovery dispatch received an invocation signal');
      assert.deepEqual(bindings.get(signal), original.identity, 'the enforcing wrapper sees a freshly rebuilt binding for the recovery signal');
      assert.notEqual(signal, original.signal, 'recovery runs under a newly constructed invocation signal, not the aborted one');
      assert.ok(runtime.provider.state.callCount > 0, 'recovered task reached the synthetic faux provider');
      const settled = agentViewFrom(state).entries.filter(entry => entry.kind === 'assistant').at(-1);
      assert.equal(settled?.text, 'synthetic response', 'recovered generation settled on the scripted successful completion');
      assert.equal(settled?.stopReason, 'stop', 'the recovered completion is a successful response, not an error or exhaustion path');
      assert.equal(settled?.error, null);
    } finally {
      await close(runtime);
    }
  } finally {
    await db.remove();
  }
});

test('unfinished ordinary generation recovery without a binding is denied before faux transport', async () => {
  const db = await disposable();
  try {
    const original = await holdUnfinishedGenerationAtProviderEntry(db.path);
    // Reopen with the enforcing wrapper and no installed identity hook: no binding can exist.
    const bindings = new WeakMap<AbortSignal, DispatchIdentity>();
    const runtime = await open(db.path, [], bindings);
    try {
      const recovered = await runtime.harness.conversation(original.conversationId, BACKGROUND_CONTEXT);
      assert.ok(recovered);
      await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
      assert.equal(runtime.dispatches.length, 1, 'the resumed unfinished request is offered to the enforcing wrapper');
      const signal = runtime.dispatches[0].signal;
      assert.ok(signal, 'the resumed dispatch carries an invocation signal');
      assert.equal(bindings.has(signal), false, 'reopening without the identity hook leaves no binding');
      assert.equal(runtime.provider.state.callCount, 0, 'an unavailable binding is denied before faux transport');
      const settled = agentViewFrom(await readState(recovered)).entries.filter(entry => entry.kind === 'assistant').at(-1);
      assert.equal(settled?.stopReason, 'error', 'denied recovery appended the synthetic denial, not a successful completion');
      assert.equal(settled?.error, 'identity binding unavailable');
    } finally {
      await close(runtime);
    }
  } finally {
    await db.remove();
  }
});

test('absent or throwing advisory hook leaves dispatch identity unknown and the wrapper denies it', async () => {
  for (const throwing of [false, true]) {
    const db = await disposable();
    const bindings = new WeakMap<AbortSignal, Readonly<{ conversationId: string; taskId: string }>>();
    const guard = defineExtension({
      name: throwing ? 'throwing-identity-hook' : 'absent-identity-hook',
      hooks: throwing ? [hook(GenerationTask, { beforeRequest: () => { throw new Error('synthetic advisory hook failure'); } })] : []
    });
    const runtime = await open(db.path, [guard], bindings);
    try {
      const conversation = await runtime.harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: 'faux', modelId: runtime.provider.getModel().id }, extensions: [guard] }
      });
      await conversation.submit({ type: 'input', content: 'unknown identity fixture' }, BACKGROUND_CONTEXT);
      await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
      assert.equal(runtime.dispatches.length, 1);
      assert.equal(runtime.dispatches[0].signal && bindings.has(runtime.dispatches[0].signal), false);
      assert.equal(runtime.provider.state.callCount, 0, 'the synthetic wrapper denied before transport/provider dispatch');
    } finally {
      await close(runtime);
      await db.remove();
    }
  }
});

test('executed tool receives exact marker/conversation/task/call tuples, including repeated call IDs across conversations', async () => {
  const db = await disposable();
  const identities: { marker: string; conversationId: string; taskId: string; callId: string }[] = [];
  const tool = defineExtension({
    name: 'invocation-identity',
    tools: [defineTool({
      name: 'capture_identity',
      description: 'Capture invocation IDs for this test only.',
      parameters: Type.Object({ marker: Type.String() }),
      replay: 'safe',
      execute: async (_args, api) => {
        identities.push({ marker: _args.marker, conversationId: String(api.conversationId), taskId: String(api.taskId), callId: api.callId });
        return { output: [{ type: 'text', text: 'captured' }] };
      }
    })]
  });
  const runtime = await open(db.path, [tool]);
  const responseForContext = (context: any) => {
    const messages = context.messages ?? [];
    const input = messages.map((message: any) => message.content ?? '').flat().map((part: any) => typeof part === 'string' ? part : part.text ?? '').join(' ');
    const marker = input.includes('invoke first') ? 'marker-first' : input.includes('invoke second') ? 'marker-second' : undefined;
    if (marker && !messages.some((message: any) => message.role === 'toolResult')) {
      return fauxAssistantMessage([fauxToolCall('capture_identity', { marker }, { id: 'fixture-call-shared' })], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('synthetic complete');
  };
  runtime.provider.setResponses([responseForContext, responseForContext, responseForContext, responseForContext]);
  try {
    const model = runtime.provider.getModel();
    const first = await runtime.harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: model.id }, extensions: [tool] }
    });
    const second = await runtime.harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { model: { provider: 'faux', modelId: model.id }, extensions: [tool] }
    }, BACKGROUND_CONTEXT);
    await first.submit({ type: 'input', content: 'invoke first' }, BACKGROUND_CONTEXT);
    await second.submit({ type: 'input', content: 'invoke second' }, BACKGROUND_CONTEXT);
    await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal(identities.length, 2);
    const tuples = identities.map(item => [item.marker, item.conversationId, item.callId]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepEqual(tuples, [
      ['marker-first', String(first.id), 'fixture-call-shared'],
      ['marker-second', String(second.id), 'fixture-call-shared']
    ]);
    assert.equal(new Set(identities.map(item => item.taskId)).size, 2, 'separate tool invocations have separate tasks despite repeated model call IDs');
    for (const identity of identities) {
      const task = await runtime.harness.getTask(identity.taskId as never, BACKGROUND_CONTEXT);
      assert.ok(task, `public task lookup contains ${identity.taskId}`);
      assert.equal(String(task.conversationId), identity.conversationId, 'the public task record is owned by the expected conversation');
    }

  } finally {
    await close(runtime);
    await db.remove();
  }
});

test('generation commits streamed partial assistant content before the faux response completes', async () => {
  const db = await disposable();
  const runtime = await open(db.path, [], undefined, 60);
  runtime.provider.setResponses([() => fauxAssistantMessage('partial-visible-'.repeat(20))]);
  try {
    const conversation = await runtime.harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: runtime.provider.getModel().id } }
    });
    await conversation.submit({ type: 'input', content: 'partial visibility fixture' }, BACKGROUND_CONTEXT);
    const partial = await until(async () => {
      const state = await readState(conversation);
      const message = state.docs['pi.live']?.generation?.message;
      const text = message?.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
      return typeof text === 'string' && text.length > 0 && text.length < 'partial-visible-'.repeat(20).length ? text : undefined;
    });
    assert.ok(partial.length > 0);
    assert.ok(partial.length < 'partial-visible-'.repeat(20).length);
    await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
    const settled = await readState(conversation);
    assert.ok(settled.entries.some((entry: any) => entry.kind === 'pi.assistant'));
  } finally {
    await close(runtime);
    await db.remove();
  }
});

test('public ToolExecutionApi exposes invocation-bound identity fields (declaration-level only)', () => {
  const identity = (api: ToolExecutionApi) => ({
    conversationId: String(api.conversationId),
    taskId: String(api.taskId),
    callId: api.callId
  });
  // This compile-time surface canary intentionally does not fabricate a tool invocation.
  assert.equal(typeof identity, 'function');
});

test('fork exposes Pilot question projection and queued inbox behavior without implying workspace or authorization copying', async () => {
  const db = await disposable();
  const runtime = await open(db.path);
  try {
    const parent = await runtime.harness.root(BACKGROUND_CONTEXT);
    const questionEntry = await parent.commit(tx => tx.appendEntry(parent.id, { kind: 'app.question', data: { questionId: 'question-q1', text: 'Synthetic question', askedAt: 1700000000000 } }), BACKGROUND_CONTEXT);
    const answerEntry = await parent.commit(tx => tx.appendEntry(parent.id, { kind: 'app.answer', data: { questionId: 'question-q1', text: 'Synthetic answer', answeredAt: 1700000001000 } }), BACKGROUND_CONTEXT);
    const child = await parent.fork(answerEntry.id, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    assert.notEqual(String(child.id), String(parent.id));
    const childState = await readState(child);
    const childView = agentViewFrom(childState);
    assert.deepEqual(childView.questions, [{ id: 'question-q1', text: 'Synthetic question', askedAt: 1700000000000, answer: { text: 'Synthetic answer', answeredAt: 1700000001000 } }]);
    const beforeQuestion = await parent.fork(questionEntry.id, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    assert.deepEqual(agentViewFrom(await readState(beforeQuestion)).questions, [{ id: 'question-q1', text: 'Synthetic question', askedAt: 1700000000000, answer: null }], 'cutoff before answer exposes open question only');
    // Public submission API queues input while the parent is busy; the inbox is fork-initial.
    const queuedDb = await disposable();
    const block = deferred<void>();
    const toolEntered = deferred<void>();
    const identityBySignal = new WeakMap<AbortSignal, string>();
    const providerCalls: { conversationId: string | undefined; intent: string }[] = [];
    const blocker = defineExtension({
      name: 'queue-cutoff-blocker',
      tools: [defineTool({
        name: 'hold', description: 'controlled synthetic wait', parameters: Type.Object({}), replay: 'safe',
        execute: async () => { toolEntered.resolve(); await block.promise; return { output: [{ type: 'text', text: 'released' }] }; }
      })],
      hooks: [hook(GenerationTask, { beforeRequest: (_request, api, context) => {
        if (context.abortSignal) identityBySignal.set(context.abortSignal, String(api.conversationId));
        return undefined;
      } })]
    });
    const queuedRuntime = await open(queuedDb.path, [blocker]);
    // Context-derived responses: each request receives the completion its own synthetic input asks for, so an
    // exhaustion or error path cannot stand in for a successful conversation outcome.
    const respondForContext = (context: any, options: any) => {
      const messages = context.messages ?? [];
      const parts = messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [message.content]);
      const text = parts.map((part: any) => typeof part === 'string' ? part : part?.text ?? '').join(' ');
      const conversationId = options?.signal ? identityBySignal.get(options.signal) : undefined;
      const record = (intent: string) => { providerCalls.push({ conversationId, intent }); };
      if (text.includes('child independent synthetic work')) { record('child'); return fauxAssistantMessage('child synthetic completion'); }
      if (text.includes('queued-parent-input')) { record('queued-parent'); return fauxAssistantMessage('queued-parent synthetic completion'); }
      if (text.includes('start controlled busy run') && messages.some((message: any) => message.role === 'toolResult')) { record('parent-tool-followup'); return fauxAssistantMessage('parent synthetic completion'); }
      if (text.includes('start controlled busy run')) { record('parent-tool-call'); return fauxAssistantMessage([fauxToolCall('hold', {}, { id: 'hold-call' })], { stopReason: 'toolUse' }); }
      record('unexpected');
      return fauxAssistantMessage('unexpected synthetic prompt', { stopReason: 'error', errorMessage: 'unexpected synthetic prompt' });
    };
    try {
      queuedRuntime.provider.setResponses(Array.from({ length: 8 }, () => respondForContext));
      const busy = await queuedRuntime.harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: 'faux', modelId: queuedRuntime.provider.getModel().id }, extensions: [blocker] }
      });
      await busy.submit({ type: 'input', content: 'start controlled busy run' }, BACKGROUND_CONTEXT);
      await toolEntered.promise;
      await busy.submit({ type: 'input', content: 'queued-parent-input' }, BACKGROUND_CONTEXT);
      const busyState = await readState(busy);
      const queuedView = agentViewFrom(busyState);
      assert.deepEqual(queuedView.inbox.map(item => item.text), ['queued-parent-input']);
      const cutoff = busyState.entries.at(-1)?.id;
      assert.ok(cutoff);
      const busyChild = await busy.fork(cutoff, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
      const busyChildView = agentViewFrom(await readState(busyChild));
      assert.deepEqual(busyChildView.inbox, [], 'fork-initial inbox does not copy queued parent input');
      block.resolve();
      await queuedRuntime.harness.waitForIdle(BACKGROUND_CONTEXT);
      const parentSettled = await until(async () => {
        const view = agentViewFrom(await readState(busy));
        return view.entries.some(entry => entry.kind === 'assistant' && entry.text === 'queued-parent synthetic completion') ? view : undefined;
      });
      // Settled child state, inspected before the child's own submission: the parent's queued work never ran here.
      const childBefore = agentViewFrom(await readState(busyChild));
      assert.deepEqual(childBefore.inbox, []);
      assert.equal(childBefore.entries.some(entry => entry.text.includes('queued-parent')), false, 'the child transcript holds none of the parent queued input or its completion');
      assert.deepEqual(providerCalls.filter(call => call.conversationId === String(busyChild.id)), [], 'the forked child made no provider call before its independent submission');
      await busyChild.submit({ type: 'input', content: 'child independent synthetic work' }, BACKGROUND_CONTEXT);
      const childSettled = await until(async () => {
        const view = agentViewFrom(await readState(busyChild));
        return view.entries.some(entry => entry.kind === 'assistant' && entry.text === 'child synthetic completion') ? view : undefined;
      });
      // Provider behaviour per conversation, attributed through the hook-bound public identity.
      assert.deepEqual(providerCalls.filter(call => call.conversationId === String(busy.id)).map(call => call.intent),
        ['parent-tool-call', 'parent-tool-followup', 'queued-parent'], 'the parent conversation made exactly its three intended provider requests');
      assert.deepEqual(providerCalls.filter(call => call.conversationId === String(busyChild.id)).map(call => call.intent),
        ['child'], 'the child conversation made exactly its one independent provider request');
      assert.equal(providerCalls.filter(call => call.conversationId === undefined).length, 0, 'every provider entry carried a hook-bound conversation identity');
      assert.equal(providerCalls.length, 4, 'four provider entries ran in total');
      assert.equal(queuedRuntime.provider.state.callCount, 4, 'no request beyond the four intended entries was attempted');
      assert.equal(queuedRuntime.provider.getPendingResponseCount(), 4, 'scripted responses remained, so no request hit response exhaustion');
      const parentAssistants = parentSettled.entries.filter(entry => entry.kind === 'assistant');
      assert.deepEqual(parentAssistants.map(entry => [entry.text, entry.stopReason]),
        [['', 'toolUse'], ['parent synthetic completion', 'stop'], ['queued-parent synthetic completion', 'stop']],
        'the parent settled its tool round and its own queued input successfully');
      assert.ok(parentSettled.entries.some(entry => entry.kind === 'user' && entry.text === 'queued-parent-input'), 'the parent dispatched its own queued input');
      const childAssistants = childSettled.entries.filter(entry => entry.kind === 'assistant');
      assert.equal(childAssistants.length, childBefore.entries.filter(entry => entry.kind === 'assistant').length + 1, 'the child appended exactly one assistant entry');
      const childCompletion = childAssistants.at(-1);
      assert.equal(childCompletion?.text, 'child synthetic completion');
      assert.equal(childCompletion?.stopReason, 'stop');
      assert.equal(childCompletion?.error, null);
      assert.ok(childSettled.entries.some(entry => entry.kind === 'user' && entry.text === 'child independent synthetic work'), 'the independent input is in the child transcript');
      assert.deepEqual(childSettled.inbox, []);
    } finally {
      block.resolve();
      await close(queuedRuntime);
      await queuedDb.remove();
    }
    // The harness has no filesystem workspace or Pilot grant registry in this test.
    assert.equal(runtime.provider.state.callCount, 0, 'transcript fork caused no model provider call');
  } finally {
    await close(runtime);
    await db.remove();
  }
});
