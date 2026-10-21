import type { Context } from '@earendil-works/chord';
import { defineExtension, hook, GenerationTask, type Extension, type HookApi } from '@earendil-works/pi-durable';
import type { Api, Message, Model, Models, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export interface DispatchIdentity {
  readonly conversationId: string;
  readonly taskId: string;
}
export interface DispatchPolicyRequest {
  readonly identity: DispatchIdentity;
  readonly model: Model<Api>;
}
export type DispatchPolicy = (request: DispatchPolicyRequest) => boolean | Promise<boolean>;
export interface GuardedDispatch {
  /** Fresh, opaque catalog facade plus the one guarded ordinary stream operation. */
  readonly models: Models;
  readonly extension: Extension;
  /** Host-only positive admission for one exact current-process invocation identity. */
  admit(identity: DispatchIdentity): void;
  /** Revoke one exact admission. */
  revoke(identity: DispatchIdentity): void;
}

/** Final output-token ceiling for every accepted dispatch. */
const MAX_OUTPUT_TOKENS = 4096;
/** Longest accepted opaque provider session identifier. */
const MAX_SESSION_ID_LENGTH = 200;
/**
 * The complete set of request options this adapter supports. Everything else — deferred
 * submission, reasoning/thinking levels, payload and sampling hooks, transport transforms and
 * Pi's retry knobs — is denied before transport. `sessionId` is Pi's opaque provider-scope
 * routing/cache hint, injected by the durable harness on every ordinary request; it is never an
 * authorization input, never selects an execution mode and cannot change the token ceiling.
 */
const SUPPORTED_OPTION_KEYS: readonly string[] = ['signal', 'maxTokens', 'sessionId'];
const SUPPORTED_OPTIONS = new Set(SUPPORTED_OPTION_KEYS);
const DENIED = 'Model dispatch is not authorized by the current host policy.';
const ABORTED = 'Model dispatch was cancelled.';
const BLOCKED = 'is blocked by the guarded dispatch adapter.';
const FAILED = 'Model request failed. Check the provider connection, model access and quota.';
const safeError = (message: string) => new Error(message);
const identityKey = (identity: DispatchIdentity) => JSON.stringify([identity.conversationId, identity.taskId]);
function racePolicy(policy: boolean | Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.reject(safeError(ABORTED));
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(safeError(ABORTED)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(policy).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy)) as T;
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) copy[key] = immutableCopy(item);
    return Object.freeze(copy) as T;
  }
  return value;
}
function sameJson(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
/**
 * A catalog entry is dispatchable only when it cannot expand or replace the bounded output
 * budget. Pi 1.3.0 turns an explicit caller cap into `min(cap + thinkingBudget, modelMaxTokens)`
 * (`api/simple-options.js` `adjustMaxTokensForThinking`), so a reasoning model, a sampling
 * override or a thinking-level map would move the real request ceiling above 4096.
 *
 * `Models.streamSimple` is typed `Model<Api>`, whose `type` is only `"chat" | undefined`
 * (`types.d.ts`): image and classifier models have no typed path here, so there is no
 * non-chat comparison to make. A non-chat shape reaching the method unsafely is rejected by the
 * catalog lookup and the structural equality check below, which never forward the caller's object.
 */
function isSafeCatalogModel(model: Model<Api>): boolean {
  return model.reasoning === false
    && Number.isInteger(model.maxTokens) && model.maxTokens > 0
    && model.samplingParams === undefined
    && model.samplingParamsByThinkingLevel === undefined
    && model.thinkingLevelMap === undefined;
}
function readCallerSignal(options: unknown): AbortSignal {
  const signal = options === null || typeof options !== 'object'
    ? undefined
    : (options as { readonly signal?: unknown }).signal;
  if (!(signal instanceof AbortSignal)) throw safeError(DENIED);
  return signal;
}
interface SupportedOptions {
  readonly maxTokens: number;
  readonly sessionId: string | undefined;
}
/**
 * Validate the caller's option bag against the closed allowlist. The bag is never forwarded: only
 * the bounded values read here are rebuilt into the transport options. Unsupported keys are
 * rejected even when non-enumerable or inherited, because they belong to Pi's payload,
 * sampling, reasoning, deferred and retry surfaces.
 */
function readSupportedOptions(options: unknown, signal: AbortSignal): SupportedOptions {
  if (options === null || typeof options !== 'object') throw safeError(DENIED);
  for (const key in options) if (!SUPPORTED_OPTIONS.has(key)) throw safeError(DENIED);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !SUPPORTED_OPTIONS.has(key)) throw safeError(DENIED);
  }
  if ('deferred' in options) throw safeError(DENIED);
  if ((options as { readonly signal?: unknown }).signal !== signal) throw safeError(DENIED);
  const requested = (options as { readonly maxTokens?: unknown }).maxTokens;
  const maxTokens = requested === undefined ? MAX_OUTPUT_TOKENS : requested;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS) {
    throw safeError(DENIED);
  }
  const sessionId = 'sessionId' in options ? (options as { readonly sessionId?: unknown }).sessionId : undefined;
  if (sessionId !== undefined
    && (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH)) {
    throw safeError(DENIED);
  }
  return { maxTokens, sessionId };
}
function safeLabel(model: unknown): { api: string; provider: string; model: string } {
  try {
    const value = (model ?? {}) as { readonly api?: unknown; readonly provider?: unknown; readonly id?: unknown };
    return {
      api: typeof value.api === 'string' ? value.api : 'unknown',
      provider: typeof value.provider === 'string' ? value.provider : 'unknown',
      model: typeof value.id === 'string' ? value.id : 'unknown',
    };
  } catch {
    return { api: 'unknown', provider: 'unknown', model: 'unknown' };
  }
}
export function createGuardedDispatch(models: Models, authorize: DispatchPolicy): GuardedDispatch {
  const bindings = new WeakMap<AbortSignal, DispatchIdentity | null>();
  const admissions = new Set<string>();
  const beforeRequest = (request: { readonly messages: readonly Message[] }, api: HookApi, context: Context) => {
    const signal = context.abortSignal;
    if (!signal) return;
    const identity = Object.freeze({ conversationId: String(api.conversationId), taskId: String(api.taskId) });
    const prior = bindings.get(signal);
    if (bindings.has(signal)) {
      if (prior === null || prior?.conversationId !== identity.conversationId || prior.taskId !== identity.taskId) bindings.set(signal, null);
    } else bindings.set(signal, identity);
    return { messages: request.messages };
  };
  const extension = defineExtension({ name: 'guarded-generation-dispatch', hooks: [hook(GenerationTask, { beforeRequest })] });

  const original = models.streamSimple.bind(models);
  const guardedStreamSimple: Models['streamSimple'] = (requestedModel, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let signal: AbortSignal | undefined;
      try {
        signal = readCallerSignal(options);
        if (signal.aborted) throw safeError(ABORTED);
        const identity = bindings.get(signal);
        // Binding and admission are separate gates: a hook (advisory) is not authority, and a
        // fresh beforeRequest rebind after reopen never carries an admission by itself.
        if (!identity || !admissions.has(identityKey(identity))) throw safeError(DENIED);
        const supported = readSupportedOptions(options, signal);
        const catalogModel = models.getModel(requestedModel.provider, requestedModel.id);
        if (!catalogModel || !isSafeCatalogModel(catalogModel) || !sameJson(requestedModel, catalogModel)) throw safeError(DENIED);
        const boundedModel = immutableCopy({ ...catalogModel, maxTokens: Math.min(catalogModel.maxTokens, MAX_OUTPUT_TOKENS) });
        const allowed = await racePolicy(authorize({ identity, model: boundedModel }), signal);
        const current = bindings.get(signal);
        if (signal.aborted) throw safeError(ABORTED);
        if (!current || current.conversationId !== identity.conversationId || current.taskId !== identity.taskId
          || !admissions.has(identityKey(identity))) throw safeError(DENIED);
        if (!allowed) throw safeError(DENIED);
        // Original Models receiver retained; the caller's model and option bag never cross.
        const bounded: ModelsSimpleStreamOptions = {
          signal, maxTokens: Math.min(supported.maxTokens, MAX_OUTPUT_TOKENS),
          ...(supported.sessionId === undefined ? {} : { sessionId: supported.sessionId }),
        };
        const source = original(boundedModel, context, bounded);
        for await (const event of source) {
          output.push(event.type === 'error' ? { ...event, error: { ...event.error, errorMessage: FAILED } } : event);
        }
        const result = await source.result();
        output.end(result.stopReason === 'error' ? { ...result, errorMessage: FAILED } : result);
      } catch {
        const aborted = signal?.aborted === true;
        const label = safeLabel(requestedModel);
        const message = {
          role: 'assistant' as const, content: [{ type: 'text' as const, text: aborted ? ABORTED : DENIED }],
          api: label.api, provider: label.provider, model: label.model,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: aborted ? 'aborted' as const : 'error' as const, timestamp: Date.now(),
          errorMessage: aborted ? ABORTED : DENIED,
        };
        output.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
        output.end(message);
      }
    })();
    return output;
  };

  const catalog = {
    getModels: (provider?: string) => immutableCopy(models.getModels(provider)),
    getModel: (provider: string, id: string) => {
      const found = models.getModel(provider, id);
      return found ? immutableCopy(found) : undefined;
    },
    getModelsOfType: (type: Parameters<Models['getModelsOfType']>[0], provider?: string) => immutableCopy(models.getModelsOfType(type, provider)),
    getModelOfType: (type: Parameters<Models['getModelOfType']>[0], provider: string, id: string) => {
      const found = models.getModelOfType(type, provider, id);
      return found ? immutableCopy(found) : undefined;
    },
    getAllModels: (provider?: string) => immutableCopy(models.getAllModels(provider)),
    streamSimple: guardedStreamSimple,
  };
  const blocked = (..._args: unknown[]): never => { throw safeError(`Models operation ${BLOCKED}`); };
  const safeMethods = new Set(Object.keys(catalog));
  const facade = new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (typeof property === 'string' && safeMethods.has(property)) return catalog[property as keyof typeof catalog];
      return blocked;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    getPrototypeOf: () => null,
    setPrototypeOf: () => false,
    ownKeys: () => [...safeMethods],
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property !== 'string' || !safeMethods.has(property)) return undefined;
      return { configurable: true, enumerable: true, writable: false, value: catalog[property as keyof typeof catalog] };
    },
  });
  return Object.freeze({
    models: facade as Models,
    extension,
    admit(identity: DispatchIdentity) {
      if (typeof identity?.conversationId !== 'string' || typeof identity?.taskId !== 'string'
        || identity.conversationId.length === 0 || identity.taskId.length === 0) {
        throw new TypeError('A conversation and task identity are required.');
      }
      admissions.add(identityKey(identity));
    },
    revoke(identity: DispatchIdentity) { admissions.delete(identityKey(identity)); },
  });
}
