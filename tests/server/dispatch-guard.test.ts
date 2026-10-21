import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, type FauxModelDefinition, type FauxProviderHandle, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, GenerationTask, Harness, hook } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createGuardedDispatch, type DispatchIdentity, type DispatchPolicyRequest, type GuardedDispatch } from '../../src/server/agents/dispatch-guard';

const DENIED = 'Model dispatch is not authorized by the current host policy.';
const ABORTED = 'Model dispatch was cancelled.';
const BLOCKED = 'is blocked by the guarded dispatch adapter.';

interface Witness {
  readonly identity: DispatchIdentity;
  readonly signal: AbortSignal;
}
interface TransportEnvelope {
  readonly keys: readonly string[];
  readonly maxTokens: number | undefined;
  readonly sessionId: string | undefined;
  readonly hasDeferred: boolean;
  readonly reasoning: unknown;
  readonly modelId: string;
  readonly modelMaxTokens: number;
  readonly frozen: boolean;
  readonly sameAsCaller: boolean;
}
interface FixtureOptions {
  readonly rootPath?: string;
  readonly cleanup?: boolean;
  readonly responses?: readonly FauxResponseStep[];
  readonly fauxModels?: readonly FauxModelDefinition[];
  readonly tokensPerSecond?: number;
  readonly streamSettings?: { readonly maxRetries?: number };
  readonly hostExtensionName?: string;
  readonly policy?: (request: DispatchPolicyRequest) => boolean | Promise<boolean>;
}

/** One disposable-root fixture: guarded Models facade, faux provider, real durable Harness and a host hook. */
async function openFixture(options: FixtureOptions = {}) {
  const root = options.rootPath ?? await mkdtemp(join(tmpdir(), 'pilot-dispatch-guard-'));
  const provider = fauxProvider({
    ...(options.fauxModels === undefined ? {} : { models: [...options.fauxModels] }),
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });
  const envelopes: TransportEnvelope[] = [];
  const transportWaiters: Array<{ count: number; resolve: () => void }> = [];
  const callerModel = provider.getModel();
  const respond = (step: FauxResponseStep): FauxResponseStep => (context, streamOptions, state, requestModel) => {
    envelopes.push({
      keys: Object.keys(streamOptions ?? {}).sort(),
      maxTokens: streamOptions?.maxTokens,
      sessionId: typeof streamOptions?.sessionId === 'string' ? streamOptions.sessionId : undefined,
      hasDeferred: streamOptions !== undefined && 'deferred' in streamOptions,
      reasoning: streamOptions?.reasoning,
      modelId: requestModel.id,
      modelMaxTokens: requestModel.maxTokens,
      frozen: Object.isFrozen(requestModel),
      sameAsCaller: requestModel === callerModel,
    });
    for (const waiter of [...transportWaiters]) {
      if (envelopes.length >= waiter.count) { transportWaiters.splice(transportWaiters.indexOf(waiter), 1); waiter.resolve(); }
    }
    return typeof step === 'function' ? step(context, streamOptions, state, requestModel) : step;
  };
  provider.setResponses((options.responses ?? [fauxAssistantMessage('synthetic answer')]).map(respond));

  const raw = createModels();
  raw.setProvider(provider.provider);
  const model = provider.getModel();
  const policyCalls: DispatchPolicyRequest[] = [];
  const guard = createGuardedDispatch(raw, async (request) => {
    policyCalls.push(request);
    return options.policy ? await options.policy(request) : true;
  });

  const witnesses: Witness[] = [];
  const witnessWaiters: Array<{ count: number; resolve: () => void }> = [];
  const openGates = new Set<() => void>();
  const host: { onDispatch?: (witness: Witness) => void | Promise<void> } = {};
  const hostExtension = defineExtension({
    name: options.hostExtensionName ?? 'host-dispatch-spy',
    hooks: [hook(GenerationTask, {
      beforeRequest(request, api, context) {
        const signal = context.abortSignal;
        const identity = Object.freeze({ conversationId: String(api.conversationId), taskId: String(api.taskId) });
        const witness: Witness | undefined = signal === undefined ? undefined : { identity, signal };
        if (witness !== undefined) {
          witnesses.push(witness);
          for (const waiter of [...witnessWaiters]) {
            if (witnesses.length >= waiter.count) { witnessWaiters.splice(witnessWaiters.indexOf(waiter), 1); waiter.resolve(); }
          }
        }
        const gate = witness === undefined ? undefined : host.onDispatch?.(witness);
        const finish = () => ({ messages: request.messages });
        return gate === undefined ? finish() : Promise.resolve(gate).then(finish);
      },
    })],
  });

  const storage = await openNodeSqliteStorage(join(root, 'session.sqlite'));
  const registry = createRegistry();
  registry.install(guard.extension);
  registry.install(hostExtension);
  const harness = await Harness.open(storage, {
    models: guard.models,
    registry,
    settings: {
      retry: { enabled: false },
      compaction: { enabled: false },
      ...(options.streamSettings === undefined ? {} : { stream: { ...options.streamSettings } }),
    },
  }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: provider.provider.id, modelId: model.id }, extensions: [guard.extension, hostExtension] },
  });

  return {
    root, provider, raw, model, callerModel, guard, host, witnesses, envelopes, policyCalls,
    harness, conversation, extension: guard.extension,
    /** A host gate that pauses the generation inside beforeRequest until released or the fixture closes. */
    openGate() {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      openGates.add(release);
      return {
        gate,
        release: () => { openGates.delete(release); release(); },
      };
    },
    awaitWitnesses(count: number) {
      if (witnesses.length >= count) return Promise.resolve();
      return new Promise<void>(resolve => witnessWaiters.push({ count, resolve }));
    },
    awaitTransport(count: number) {
      if (envelopes.length >= count) return Promise.resolve();
      return new Promise<void>(resolve => transportWaiters.push({ count, resolve }));
    },
    async close(cleanup = options.cleanup !== false) {
      for (const release of [...openGates]) release(); // never leave a paused invocation behind
      await withTimeout(harness.close(BACKGROUND_CONTEXT).catch(() => { }), 'harness close').catch(() => { });
      await withTimeout(storage.close(BACKGROUND_CONTEXT).catch(() => { }), 'storage close').catch(() => { });
      if (cleanup) await rm(root, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof openFixture>>;

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
  });
  try { return await Promise.race([promise, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Invoke the registered public hook handler exactly as the harness does: `hook(request, api, context)`. */
function rebind(fixture: Fixture, signal: AbortSignal, identity: DispatchIdentity) {
  const handlers = fixture.guard.extension.hooks?.[0]?.handlers as unknown as {
    beforeRequest(request: { messages: readonly unknown[] }, api: DispatchIdentity, context: { abortSignal: AbortSignal }): unknown;
  };
  handlers.beforeRequest({ messages: [] }, identity, { abortSignal: signal });
}

/** One guarded ordinary dispatch at the public boundary, exactly the shape an admitted host request carries. */
function dispatch(fixture: Fixture, options: unknown, model: unknown = fixture.model) {
  return fixture.guard.models.streamSimple(model as never, { messages: [] } as never, options as never);
}
async function dispatchResult(fixture: Fixture, options: unknown, model: unknown = fixture.model) {
  return dispatch(fixture, options, model).result();
}

/**
 * Pause a real durable generation inside its beforeRequest hook, after the guard bound the
 * invocation signal. The invocation stays alive, so the returned signal is the live object the
 * harness itself passes to `Models.streamSimple` and the identity is a real durable tuple.
 */
async function pausedGeneration(fixture: Fixture) {
  const gate = fixture.openGate();
  fixture.host.onDispatch = () => gate.gate;
  await fixture.conversation.submit({ type: 'input', content: 'paused dispatch' }, BACKGROUND_CONTEXT);
  await withTimeout(fixture.awaitWitnesses(1), 'harness beforeRequest');
  return { witness: fixture.witnesses[0], release: gate.release };
}

async function taskState(fixture: Fixture, taskId: string) {
  const record = await fixture.harness.getTask(taskId as never, BACKGROUND_CONTEXT) as unknown as {
    readonly id: unknown;
    readonly conversationId: unknown;
    readonly kind?: string;
    readonly state: { readonly status: string; readonly checkpoint?: { readonly phase?: string }; readonly outcome?: { readonly status?: string; readonly error?: { readonly message?: string } } };
  } | undefined;
  return record;
}

test('ordinary durable transport requires a host admission bound to the exact conversation/task identity', async () => {
  const f = await openFixture({ responses: [fauxAssistantMessage('first answer')] });
  try {
    f.host.onDispatch = (witness) => f.guard.admit(witness.identity); // explicit host action; the guard never self-admits
    const submission = await f.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
    await withTimeout(submission.wait(BACKGROUND_CONTEXT), 'submission');
    assert.equal(f.provider.state.callCount, 1);
    const witness = f.witnesses[0];
    assert.deepEqual(f.policyCalls.map(call => call.identity), [witness.identity]);
    const record = await taskState(f, witness.identity.taskId);
    assert.equal(record?.kind, 'pi.generation');
    assert.equal(String(record?.conversationId), witness.identity.conversationId);
    assert.equal(String(record?.id), witness.identity.taskId);
    // The transport envelope proves the final ceiling and the canonical frozen model reached the provider.
    const envelope = f.envelopes[0];
    assert.equal(envelope.maxTokens, 4096);
    assert.equal(envelope.modelMaxTokens, 4096);
    assert.equal(envelope.frozen, true);
    assert.equal(envelope.sameAsCaller, false);
    assert.equal(envelope.hasDeferred, false);
    assert.equal(envelope.reasoning, undefined);
    assert.ok(envelope.sessionId !== undefined);
    assert.deepEqual([...envelope.keys].filter(key => !['apiKey', 'env', 'headers'].includes(key)).sort(), ['maxTokens', 'sessionId', 'signal']);
    assert.equal(f.model.maxTokens, 16384); // the caller's catalog model is untouched by the clamp
  } finally { await f.close(); }
});

test('hook binding and a true policy callback are not authority: an unadmitted durable request transports nothing', async () => {
  const f = await openFixture({ responses: [fauxAssistantMessage('denied'), fauxAssistantMessage('admitted')] });
  try {
    const first = await f.conversation.submit({ type: 'input', content: 'no admission' }, BACKGROUND_CONTEXT);
    await withTimeout(first.wait(BACKGROUND_CONTEXT), 'first submission');
    await withTimeout(f.conversation.waitForIdle(BACKGROUND_CONTEXT), 'idle after denial');
    assert.equal(f.provider.state.callCount, 0); // zero transport without a positive admission
    assert.equal(f.policyCalls.length, 0); // the admission gate is checked before the host policy
    assert.equal(f.witnesses.length, 1); // the hook did bind: this is not an unbound denial
    const deniedIdentity = f.witnesses[0].identity;
    const denied = await taskState(f, deniedIdentity.taskId);
    assert.equal(denied?.state.outcome?.status, 'failed');
    assert.equal(denied?.state.outcome?.error?.message, DENIED);
    // Positive control on the same harness: one explicit host admission lets the same request shape transport.
    f.host.onDispatch = (witness) => f.guard.admit(witness.identity);
    const second = await f.conversation.submit({ type: 'input', content: 'admitted' }, BACKGROUND_CONTEXT);
    await withTimeout(second.wait(BACKGROUND_CONTEXT), 'second submission');
    assert.equal(f.provider.state.callCount, 1);
    assert.notEqual(f.witnesses[1].identity.taskId, deniedIdentity.taskId);
    assert.deepEqual(f.policyCalls.map(call => call.identity), [f.witnesses[1].identity]);
  } finally { await f.close(); }
});

test('the Models facade denies provider objects, alternate APIs, reflection, prototype and mutation', async () => {
  const f = await openFixture({ responses: [fauxAssistantMessage('admitted')] });
  try {
    const view = f.guard.models as unknown as Record<string, unknown>;
    for (const name of ['getProvider', 'getProviders', 'stream', 'complete', 'completeSimple', 'streamDeferred', 'fetchDeferred', 'cancelDeferred', 'generateImages', 'classify', 'refresh', 'checkAuth', 'getAvailable', 'getAvailableOfType', 'getAllAvailable', 'getAuth', 'login', 'logout', 'admit', 'revoke', 'unknownDispatch']) {
      assert.throws(() => (view[name] as () => unknown)(), new RegExp(BLOCKED), name);
    }
    assert.equal(Object.getPrototypeOf(view), null);
    assert.equal(Reflect.getPrototypeOf(view), null);
    assert.equal(Object.getOwnPropertyDescriptor(view, 'providers'), undefined);
    assert.deepEqual([...Reflect.ownKeys(view)].sort(), ['getAllModels', 'getModel', 'getModelOfType', 'getModels', 'getModelsOfType', 'streamSimple']);
    assert.throws(() => Object.setPrototypeOf(view, { leak: true }), TypeError);
    assert.throws(() => Object.defineProperty(view, 'providers', { value: {} }), TypeError);
    assert.throws(() => { delete (view as { getModel?: unknown }).getModel; }, TypeError);
    assert.equal(f.provider.state.callCount, 0);
    // Catalog reads are frozen copies, never the original collection's provider or model objects.
    const listed = (view.getModels as (provider?: string) => readonly Record<string, unknown>[])(f.provider.provider.id);
    assert.ok(listed.length > 0);
    assert.equal(Object.isFrozen(listed[0]), true);
    assert.equal(Object.getPrototypeOf(listed[0]), null);
    assert.notEqual(listed[0], f.raw.getModel(f.provider.provider.id, f.model.id));
    assert.equal((view.getModels as (provider?: string) => readonly unknown[])().length >= listed.length, true);
    // The one guarded entrypoint still runs the original implementation for an admitted identity.
    f.host.onDispatch = (witness) => f.guard.admit(witness.identity);
    const submission = await f.conversation.submit({ type: 'input', content: 'through the facade' }, BACKGROUND_CONTEXT);
    await withTimeout(submission.wait(BACKGROUND_CONTEXT), 'facade submission');
    assert.equal(f.provider.state.callCount, 1);
  } finally { await f.close(); }
});

test('unsupported option overrides are rejected before transport while the supported bag transports', async () => {
  const f = await openFixture({ responses: [fauxAssistantMessage('a'), fauxAssistantMessage('b'), fauxAssistantMessage('c')] });
  try {
    const paused = await pausedGeneration(f);
    const identity = paused.witness.identity;
    f.guard.admit(identity);
    assert.deepEqual(identity, { conversationId: String(f.conversation.id), taskId: identity.taskId });
    const durable = await taskState(f, identity.taskId);
    assert.equal(durable?.kind, 'pi.generation'); // the tuple is a real durable task, confirmed through public getTask
    assert.equal(String(durable?.conversationId), identity.conversationId);
    // Control: the bound and admitted identity transports with the supported bag.
    assert.equal((await dispatchResult(f, { signal: paused.witness.signal })).stopReason, 'stop');
    assert.equal(f.provider.state.callCount, 1);
    const callsAfterControl = f.policyCalls.length;
    const overrides: readonly unknown[] = [
      { deferred: true }, { deferred: { window: '1h' } }, { deferred: undefined },
      { onPayload: () => ({ max_tokens: 99999 }) }, { onResponse: () => { } }, { onProviderStreamEvent: () => { } },
      { samplingParams: { temperature: 1 } }, { reasoning: 'high' }, { thinkingBudgets: { high: 4096 } },
      { temperature: 1 }, { metadata: { user_id: 'x' } }, { transport: 'websocket' }, { toolChoice: 'auto' },
      { cacheRetention: 'none' }, { maxRetries: 0 }, { unknownOption: true },
      { sessionId: '' }, { sessionId: 42 },
      { maxTokens: 4097 }, { maxTokens: 0 }, { maxTokens: 4096.5 }, { maxTokens: '4096' },
    ];
    for (const override of overrides) {
      const result = await dispatchResult(f, { signal: paused.witness.signal, ...(override as object) });
      assert.equal(result.stopReason, 'error', JSON.stringify(override));
      assert.equal(result.errorMessage, DENIED, JSON.stringify(override));
    }
    assert.equal(f.provider.state.callCount, 1); // zero ADDITIONAL transport for every unsupported override
    assert.equal(f.policyCalls.length, callsAfterControl); // rejected before the host authority point
    paused.release();
    await withTimeout(f.harness.waitForIdle(BACKGROUND_CONTEXT), 'harness run to settle');
    assert.equal(f.provider.state.callCount, 2); // the paused real request itself still transports
  } finally { await f.close(); }
});

test('options are validated by value and the caller bag is never forwarded', async () => {
  const f = await openFixture({ responses: [fauxAssistantMessage('a'), fauxAssistantMessage('b')] });
  try {
    const paused = await pausedGeneration(f);
    f.guard.admit(paused.witness.identity);
    const signal = paused.witness.signal;
    // A proxy that hides an unsupported key from the key walk is still denied: the key exists.
    const hiddenSource: Record<string, unknown> = { signal, maxTokens: 4096, deferred: true };
    const hidden = new Proxy(hiddenSource, {
      ownKeys: () => ['signal', 'maxTokens'],
      getOwnPropertyDescriptor: (_target, key) => ({ configurable: true, enumerable: true, value: hiddenSource[String(key)] }),
    });
    assert.equal((await dispatchResult(f, hidden)).stopReason, 'error');
    assert.equal(f.provider.state.callCount, 0);
    // A proxy that reports only supported keys but a hostile maxTokens value is denied by the value check.
    const lying = new Proxy({ signal, maxTokens: 99999 } as Record<string, unknown>, { ownKeys: () => ['signal', 'maxTokens'] });
    assert.equal((await dispatchResult(f, lying)).stopReason, 'error');
    assert.equal(f.provider.state.callCount, 0);
    // A proxy that lies about `deferred` cannot smuggle it: the transport options are rebuilt, not forwarded.
    const smuggling = new Proxy({ signal, maxTokens: 4096, deferred: true } as Record<string, unknown>, {
      ownKeys: () => ['signal', 'maxTokens'], has: () => false,
    });
    assert.equal((await dispatchResult(f, smuggling)).stopReason, 'stop');
    assert.equal(f.provider.state.callCount, 1);
    assert.equal(f.envelopes[0].hasDeferred, false);
    assert.deepEqual([...f.envelopes[0].keys].filter(key => !['apiKey', 'env', 'headers'].includes(key)).sort(), ['maxTokens', 'signal']);
  } finally { await f.close(); }
});

test('the accepted transport ceiling is proven: canonical catalog model, 4096 cap, caller lies ignored', async () => {
  const f = await openFixture({
    fauxModels: [{ id: 'faux-plain', maxTokens: 16384 }, { id: 'faux-reasoning', reasoning: true, maxTokens: 16384 }, { id: 'faux-knobs', maxTokens: 16384 }],
    responses: [fauxAssistantMessage('a'), fauxAssistantMessage('b')],
  });
  try {
    const paused = await pausedGeneration(f);
    f.guard.admit(paused.witness.identity);
    const signal = paused.witness.signal;
    // Default (no caller budget): the catalog model's 16384 is clamped to 4096 for the real request.
    assert.equal((await dispatchResult(f, { signal })).stopReason, 'stop');
    assert.deepEqual({ cap: f.envelopes[0].maxTokens, modelCap: f.envelopes[0].modelMaxTokens, frozen: f.envelopes[0].frozen }, { cap: 4096, modelCap: 4096, frozen: true });
    assert.equal(f.provider.state.callCount, 1);
    // A fingerprint-equal object that lies about its own cap cannot move the ceiling: the catalog copy crosses.
    const spoofer = { ...f.model, maxTokens: 99999, toJSON: () => f.model };
    assert.equal((await dispatchResult(f, { signal }, spoofer)).stopReason, 'stop');
    assert.deepEqual({ cap: f.envelopes[1].maxTokens, modelCap: f.envelopes[1].modelMaxTokens, caller: f.envelopes[1].sameAsCaller }, { cap: 4096, modelCap: 4096, caller: false });
    assert.equal(f.provider.state.callCount, 2);
    // Caller mutation, redirection and budget expansion are denied without transport.
    const denied: readonly { label: string; model?: unknown; options?: unknown }[] = [
      { label: 'mutated cap', model: { ...f.model, maxTokens: 99999 } },
      { label: 'redirected provider', model: { ...f.model, provider: 'nowhere' } },
      { label: 'unknown model id', model: { ...f.model, id: 'no-such-model' } },
      { label: 'reasoning catalog model', model: f.provider.getModel('faux-reasoning') },
      { label: 'explicit over-cap option', options: { signal, maxTokens: 4097 } },
    ];
    for (const entry of denied) {
      const result = await dispatchResult(f, entry.options ?? { signal }, entry.model ?? f.model);
      assert.equal(result.stopReason, 'error', entry.label);
      assert.equal(result.errorMessage, DENIED, entry.label);
    }
    assert.equal(f.provider.state.callCount, 2);
    // Catalog entries whose knobs could expand or replace the payload stay denied too.
    for (const knob of ['samplingParams', 'thinkingLevelMap', 'samplingParamsByThinkingLevel'] as const) {
      const model = f.provider.getModel('faux-knobs') as unknown as Record<string, unknown>;
      model[knob] = { temperature: 1 };
      assert.equal((await dispatchResult(f, { signal }, model)).stopReason, 'error', knob);
      delete model[knob];
    }
    assert.equal(f.provider.state.callCount, 2);
  } finally { await f.close(); }
});

test('mutable policy and admission revocation after a successful dispatch block additional transport', async () => {
  let permit = true;
  const f = await openFixture({ policy: () => permit, responses: [fauxAssistantMessage('a'), fauxAssistantMessage('b'), fauxAssistantMessage('c')] });
  try {
    const paused = await pausedGeneration(f);
    const identity = paused.witness.identity;
    f.guard.admit(identity);
    const durable = await taskState(f, identity.taskId);
    assert.equal(durable?.kind, 'pi.generation'); // real durable tuple, confirmed through public getTask
    assert.equal(String(durable?.conversationId), identity.conversationId);
    assert.equal((await dispatchResult(f, { signal: paused.witness.signal, maxTokens: 4096 })).stopReason, 'stop');
    assert.equal(f.provider.state.callCount, 1);
    assert.deepEqual(f.policyCalls.map(call => call.identity), [identity]);
    // Scope/policy revocation after a successful dispatch: the same live binding and admission are refused.
    permit = false;
    const revokedPolicy = await dispatchResult(f, { signal: paused.witness.signal, maxTokens: 4096 });
    assert.equal(revokedPolicy.stopReason, 'error');
    assert.equal(revokedPolicy.errorMessage, DENIED);
    assert.equal(f.provider.state.callCount, 1);
    assert.equal(f.policyCalls.length, 2); // the revoked policy was consulted and refused
    // Admission revocation: refused before the host authority point.
    permit = true;
    f.guard.revoke(identity);
    const revokedAdmission = await dispatchResult(f, { signal: paused.witness.signal, maxTokens: 4096 });
    assert.equal(revokedAdmission.stopReason, 'error');
    assert.equal(f.provider.state.callCount, 1);
    assert.equal(f.policyCalls.length, 2);
    // Re-admission restores exactly one transport.
    f.guard.admit(identity);
    assert.equal((await dispatchResult(f, { signal: paused.witness.signal, maxTokens: 4096 })).stopReason, 'stop');
    assert.equal(f.provider.state.callCount, 2);
    assert.deepEqual(f.policyCalls.map(call => call.identity), [identity, identity, identity]);
    paused.release();
    await withTimeout(f.harness.waitForIdle(BACKGROUND_CONTEXT), 'harness run to settle');
    assert.equal(f.provider.state.callCount, 3);
  } finally { await f.close(); }
});

test('abort while the authorization promise is unresolved refuses transport', async () => {
  let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  let releasePolicy!: (value: boolean) => void;
  const unresolved = new Promise<boolean>(resolve => { releasePolicy = resolve; });
  let policySettled = false;
  const f = await openFixture({ policy: () => { entered(); return unresolved.then(value => { policySettled = true; return value; }); } });
  let releaseGate: (() => void) | undefined;
  let aborting: Promise<unknown> | undefined;
  try {
    const paused = await pausedGeneration(f);
    releaseGate = paused.release;
    const identity = paused.witness.identity;
    f.guard.admit(identity);
    const stream = dispatch(f, { signal: paused.witness.signal });
    await withTimeout(entry, 'authorization entry');
    aborting = f.harness.abortTask(identity.taskId as never, BACKGROUND_CONTEXT);
    const result = await withTimeout(stream.result(), 'aborted stream');
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.errorMessage, ABORTED);
    assert.equal(policySettled, false); // transport was refused while the authorization was still pending
    assert.equal(f.provider.state.callCount, 0);
    releasePolicy(true); // a later resolution grants nothing
    assert.equal((await withTimeout(aborting, 'abort join')), 'marked');
    assert.equal(policySettled, true);
    assert.equal(f.provider.state.callCount, 0);
  } finally {
    if (releaseGate !== undefined) releaseGate();
    if (aborting !== undefined) await aborting.catch(() => { });
    await f.close();
  }
});

test('a conflicting rebind while authorization is paused permanently poisons the binding', async () => {
  let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  let releasePolicy!: (value: boolean) => void;
  const unresolved = new Promise<boolean>(resolve => { releasePolicy = resolve; });
  const f = await openFixture({ policy: () => { entered(); return unresolved; } });
  let releaseGate: (() => void) | undefined;
  try {
    const paused = await pausedGeneration(f);
    releaseGate = paused.release;
    const identity = paused.witness.identity;
    f.guard.admit(identity);
    const stream = dispatch(f, { signal: paused.witness.signal });
    await withTimeout(entry, 'authorization entry');
    rebind(f, paused.witness.signal, { conversationId: identity.conversationId, taskId: 'conflicting-task' });
    rebind(f, paused.witness.signal, identity); // attempted restoration of the original identity
    releasePolicy(true);
    const result = await withTimeout(stream.result(), 'conflicted stream');
    assert.equal(result.stopReason, 'error');
    assert.equal(result.errorMessage, DENIED);
    assert.equal(f.provider.state.callCount, 0);
    // Permanent: a fresh admission on the same signal cannot move the poisoned binding.
    f.guard.admit(identity);
    assert.equal((await dispatchResult(f, { signal: paused.witness.signal })).stopReason, 'error');
    assert.equal(f.provider.state.callCount, 0);
  } finally {
    if (releaseGate !== undefined) releaseGate();
    releasePolicy(false);
    await f.close();
  }
});

test('unfinished generation reopened with a fresh guard transports nothing without a new admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-dispatch-unfinished-'));
  let conversationId = '';
  let taskId = '';
  try {
    const first = await openFixture({
      rootPath: root, cleanup: false, tokensPerSecond: 5,
      responses: [fauxAssistantMessage('x'.repeat(400)), fauxAssistantMessage('recovered answer')],
    });
    try {
      first.host.onDispatch = (witness) => first.guard.admit(witness.identity);
      await first.conversation.submit({ type: 'input', content: 'leave unfinished' }, BACKGROUND_CONTEXT);
      await withTimeout(first.awaitTransport(1), 'first transport');
      await withTimeout(first.awaitWitnesses(1), 'first beforeRequest');
      conversationId = String(first.conversation.id);
      taskId = first.witnesses[0].identity.taskId;
      const running = await taskState(first, taskId);
      assert.equal(running?.state.status, 'running'); // genuinely unfinished: the generation is mid-stream
      assert.equal(running?.state.checkpoint?.phase, 'request');
      assert.equal(first.provider.state.callCount, 1);
    } finally {
      await first.close(false); // controlled close: signals and joins the invocation mid-stream, writes no outcome
    }
    // A fresh guard: new WeakMap, new admissions, and no new input submitted in this phase.
    const second = await openFixture({ rootPath: root, cleanup: false, responses: [fauxAssistantMessage('recovered answer')] });
    try {
      const before = second.provider.state.callCount;
      await withTimeout(second.harness.conversation(conversationId as never, BACKGROUND_CONTEXT), 'reacquire conversation');
      second.harness.resume(); // reacquiring by read does not enable scheduling; the recovered run resumes here
      await withTimeout(second.awaitWitnesses(1), 'recovered beforeRequest');
      await withTimeout(second.harness.waitForIdle(BACKGROUND_CONTEXT), 'recovered run to settle');
      assert.deepEqual(second.witnesses[0].identity, { conversationId, taskId });
      assert.notEqual(second.witnesses[0].signal, first.witnesses[0].signal); // a fresh binding, not a reused one
      assert.equal(second.provider.state.callCount - before, 0); // zero transport without a new admission
      assert.equal(second.policyCalls.length, 0);
      const recovered = await taskState(second, taskId);
      assert.equal(recovered?.state.status, 'terminal');
      assert.equal(recovered?.state.outcome?.status, 'failed');
      assert.equal(recovered?.state.outcome?.error?.message, DENIED);
    } finally { await second.close(false); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the recovered attempt transports exactly once when the host grants a new positive admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-dispatch-recovered-'));
  let conversationId = '';
  let taskId = '';
  try {
    const first = await openFixture({
      rootPath: root, cleanup: false, tokensPerSecond: 5,
      responses: [fauxAssistantMessage('x'.repeat(400)), fauxAssistantMessage('recovered answer')],
    });
    try {
      first.host.onDispatch = (witness) => first.guard.admit(witness.identity);
      await first.conversation.submit({ type: 'input', content: 'leave unfinished' }, BACKGROUND_CONTEXT);
      await withTimeout(first.awaitTransport(1), 'first transport');
      await withTimeout(first.awaitWitnesses(1), 'first beforeRequest');
      conversationId = String(first.conversation.id);
      taskId = first.witnesses[0].identity.taskId;
    } finally {
      await first.close(false);
    }
    const second = await openFixture({ rootPath: root, cleanup: false, responses: [fauxAssistantMessage('recovered answer')] });
    try {
      const before = second.provider.state.callCount;
      second.host.onDispatch = (witness) => second.guard.admit(witness.identity); // new explicit host admission
      await withTimeout(second.harness.conversation(conversationId as never, BACKGROUND_CONTEXT), 'reacquire conversation');
      second.harness.resume();
      await withTimeout(second.awaitWitnesses(1), 'recovered beforeRequest');
      await withTimeout(second.harness.waitForIdle(BACKGROUND_CONTEXT), 'recovered run to settle');
      assert.deepEqual(second.witnesses[0].identity, { conversationId, taskId });
      assert.equal(second.provider.state.callCount - before, 1);
      assert.deepEqual(second.policyCalls.map(call => call.identity), [{ conversationId, taskId }]);
      const recovered = await taskState(second, taskId);
      assert.equal(recovered?.state.status, 'terminal');
      assert.notEqual(recovered?.state.outcome?.status, 'failed');
    } finally { await second.close(false); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider session identity, the admission surface and configured stream options stay non-authoritative', async () => {
  const f = await openFixture({ responses: [fauxAssistantMessage('a'), fauxAssistantMessage('b')] });
  try {
    // An unbound signal carrying a provider session identifier is denied: session identity is not authority.
    const unbound = await dispatchResult(f, { signal: new AbortController().signal, sessionId: 'session-of-a-durable-conversation' });
    assert.equal(unbound.stopReason, 'error');
    assert.equal(f.provider.state.callCount, 0);
    // Bound and admitted, the identifier is a routing value only: a different one still transports.
    const paused = await pausedGeneration(f);
    f.guard.admit(paused.witness.identity);
    assert.equal((await dispatchResult(f, { signal: paused.witness.signal, sessionId: 'caller-chosen-routing-value' })).stopReason, 'stop');
    assert.equal(f.provider.state.callCount, 1);
    assert.equal(f.envelopes[0].sessionId, 'caller-chosen-routing-value');
    // Admission is host-only: not reachable through the Models facade or the extension surface.
    assert.throws(() => (f.guard.models as unknown as Record<string, (identity: DispatchIdentity) => void>).admit(paused.witness.identity), new RegExp(BLOCKED));
    assert.equal(Object.keys(f.guard.extension).includes('admit'), false);
    assert.equal(Object.keys(f.guard.extension).includes('models'), false);
    assert.throws(() => f.guard.admit({ conversationId: '', taskId: 'task' }), TypeError);
    assert.throws(() => f.guard.admit({ conversationId: 'conversation', taskId: '' }), TypeError);
    assert.equal((await dispatchResult(f, { signal: paused.witness.signal })).stopReason, 'stop'); // invalid identities never admitted anything
    assert.equal(f.provider.state.callCount, 2);
    paused.release();
    await withTimeout(f.harness.waitForIdle(BACKGROUND_CONTEXT), 'harness run to settle');
  } finally { await f.close(); }
});

test('configured harness stream options are outside the supported bag and deny ordinary dispatch', async () => {
  const f = await openFixture({ streamSettings: { maxRetries: 0 }, responses: [fauxAssistantMessage('never sent')] });
  try {
    f.host.onDispatch = (witness) => f.guard.admit(witness.identity); // admission is present, so only the option gate blocks
    const submission = await f.conversation.submit({ type: 'input', content: 'with host stream options' }, BACKGROUND_CONTEXT);
    await withTimeout(submission.wait(BACKGROUND_CONTEXT), 'submission');
    await withTimeout(f.conversation.waitForIdle(BACKGROUND_CONTEXT), 'idle');
    assert.equal(f.provider.state.callCount, 0);
    const record = await taskState(f, f.witnesses[0].identity.taskId);
    assert.equal(record?.state.outcome?.error?.message, DENIED);
  } finally { await f.close(); }
});
