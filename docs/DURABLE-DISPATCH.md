# Durable dispatch guard (pinned Pi adapter)

An isolated adapter component, **not production wiring**. It targets
`@earendil-works/pi-durable` / `@earendil-works/pi-ai` 1.3.0 only; revalidate the public signal
boundary, the option contract and the denial tests before changing versions.

## Exported API

```ts
createGuardedDispatch(models: Models, authorize: DispatchPolicy): GuardedDispatch
```

`GuardedDispatch.models` is a read-only catalog facade with exactly one execution entrypoint,
`streamSimple`. `GuardedDispatch.extension` must be selected by the trusted conversation agent.
`admit(identity)` / `revoke(identity)` are **host-only**; they are not reachable through the
facade, the extension, or any tool.

## Admission, binding and policy

The extension's `GenerationTask.beforeRequest` handler binds the exact `Context.abortSignal`
object to frozen `HookApi.conversationId` / `taskId` strings in a process-local `WeakMap`.
Rebinding one signal with another identity poisons that entry permanently; restoring the original
identity does not revive it (tested while authorization is paused).

Every dispatch requires **all** of:

1. a caller `signal` that is an `AbortSignal` and a non-poisoned binding for it;
2. a current-process positive admission for that exact conversation/task tuple;
3. the host policy callback, resolved at call time and re-checked after it settles.

Hooks are advisory: a binding, or a recovered `beforeRequest` rebind, never authorizes by itself,
and an always-true policy without an admission still transports nothing. Missing and revoked
admissions deny before the policy callback is consulted; policy revocation after a successful
dispatch denies the next attempt. Default is deny.

## Supported request options (closed allowlist)

`signal` (required), `maxTokens` (integer 1..4096) and `sessionId` (non-empty string, <=200
chars). The caller's option bag is validated and then **rebuilt**; nothing from it is forwarded,
including unrecognized, non-enumerable or inherited keys.

`sessionId` is Pi's opaque provider-scope routing/cache hint (affinity headers, prompt-cache key)
and is injected by the durable harness on every ordinary request. It is never an authorization
input, never selects an execution mode and cannot change the token ceiling. A dispatch with a
caller-chosen session id is admitted only through the same binding+admission+policy gates.

Denied before transport, with zero provider calls: deferred submission (`true` and object form),
`reasoning` and `thinkingBudgets`, payload/sampling hooks (`onPayload`, `onResponse`,
`onProviderStreamEvent`, `samplingParams`, `temperature`, `metadata`), `transport`,
`toolChoice`, `cacheRetention`, Pi's retry/transform knobs, over-cap or non-integer
`maxTokens`, and every unknown key.

## Output ceiling and the model object

`Models.streamSimple` is typed `Model<Api>`, whose `type` field is only `"chat" | undefined`
(`types.d.ts`); image and classifier models have no typed path here, so no non-chat comparison is
made. A non-chat shape reaching the method unsafely fails the catalog lookup or the structural
equality check below.

A dispatchable catalog entry must have `reasoning === false`, an integer positive `maxTokens`
and no `samplingParams`, `samplingParamsByThinkingLevel` or `thinkingLevelMap`. Pi 1.3.0 turns
an explicit caller cap into `min(cap + thinkingBudget, modelMaxTokens)`
(`api/simple-options.js` `adjustMaxTokensForThinking`), so budget-expanding reasoning or sampling
knobs would move the real request ceiling above 4096.

The caller must pass an object structurally equal to the catalog entry. The object that crosses to
the provider is a **frozen canonical copy of the catalog entry** with `maxTokens` clamped to 4096,
never the caller's object, so mutating or spoofing a caller model (for example a `toJSON` that
mimics the catalog while carrying a larger cap) cannot redirect or loosen transport settings. The
tests capture the provider-side request envelope and assert the transported cap, the frozen
canonical model and the absence of deferred/reasoning fields.

## Opacity of the facade

The facade is a `Proxy` over a fresh null-prototype target, so the original collection is not a
target, not a prototype and not reachable through own descriptors. The allowlist is
`getModels`, `getModel`, `getModelsOfType`, `getModelOfType`, `getAllModels` and
`streamSimple`; catalog reads return frozen null-prototype copies. Writes, deletes, prototype
writes and unknown properties fail closed, and provider objects (`getProvider`,
`getProviders`) are never exposed because they carry their own `stream`/`streamSimple`/
deferred/image/classification surfaces. The original `Models` implementation is retained as the
method receiver for `streamSimple`, so Pi's internal auth, normalization and provider selection
still run without recursing through the facade.

## Pinned 1.3.0 observations and limits

For an ordinary `GenerationTask` request, the hook's `Context.abortSignal` is the same object the
harness passes as `SimpleStreamOptions.signal` (verified in an offline harness run with a faux
provider). The harness composes the request options from `settings.stream`, `signal`,
`sessionId` and (unless the agent thinking level is `off`) `reasoning`; with default host
settings and `thinkingLevel: "off"` the bag is `{signal, sessionId}` and is supported. Because
the allowlist is closed, a host that configures any `settings.stream` option (for example
`maxRetries`) denies its own ordinary dispatch; that boundary is deliberate and tested, and
widening it needs a separate contract that proves the added key cannot multiply transport or move
the ceiling. An agent with a non-`off` thinking level is likewise denied.

Unfinished ordinary generation: a controlled close mid-stream (`Harness.close`, no outcome
written) leaves the generation task non-terminal with the `request` checkpoint. A reopened
process with a **fresh** guard binds the recovered request afresh, and with no new input and no new
admission it performs zero transport and fails with the guard's denial; granting one new explicit
host admission for the recovered tuple transports exactly once. This is not a claim about
SIGKILL/power-loss behaviour, billing exactly once, or external side-effect reconciliation.

Deliberately blocked and not authorized here: provider-session identity as authority, deferred
fetch/cancel, automatic compaction (`completeSimple`), image generation, classification, refresh,
login/logout and every unknown method. Drift mechanisms are ephemeral: bindings and admissions are
never persisted and are never reused as authorization after a restart. Tests use disposable
file-backed roots and faux providers; no billed provider call and no production harness wiring is
included.
