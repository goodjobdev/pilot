# Pi Durable 1.3.0 contract canaries

This document records only the contracts exercised by `tests/server/durable-contracts.test.ts`
and narrowly inspected public installed declarations/implementation. The tests use disposable
file-backed SQLite and faux providers; they make no real provider calls. Dependencies remain
pinned at 1.3.0. No private Pi tables or `ProviderDoc` state are read by the canaries.

## Canary results

Focused command:

```sh
node_modules/.bin/tsx --test tests/server/durable-contracts.test.ts
```

**11 passed, 0 failed, 0 skipped** (eleven executable canary cases; latest local run).

| Canary | Result and contract |
|---|---|
| `custom input-entry payload and request lookup are conversation-scoped and survive clean reopen` | **Proven.** Public `Conversation.submit({type:"input", content, requestId, entry:{kind,data}})` stores the supplied `app.request` entry and payload rather than `pi.user`; the same request key in one conversation resolves to the same submission, while the same key in another conversation is independent. The transcript survives a clean close/reopen of the same disposable SQLite file. |
| `transaction can atomically deduplicate an application document receipt and transcript entry` | **Proven as an application pattern, limited to local logical idempotency.** A conversation-scoped request-ledger document and its corresponding transcript entry are updated in one public `Conversation.commit()` transaction. Repeating the key returns the original entry and leaves one entry. This does not prove exactly-once delivery to an external system. |
| `fork lineage uses entry cutoff and configured conversation-document fork policy` | **Proven.** `Conversation.fork(at,...)` creates a different conversation with parent/cutoff lineage and the selected transcript prefix. A document with `fork:"current"` receives source state current at fork creation; `fork:"initial"` initializes from its definition's default, not the parent's current or as-of-cutoff value. |
| `generation beforeRequest context and streamSimple signal are identical for concurrent conversations` | **Proven for the observed ordinary GenerationTask request path on this pinned implementation.** Two simultaneous conversations have different task/conversation identities and different signals. The exact `Context.abortSignal` passed to `beforeRequest` is the exact `options.signal` received at `models.streamSimple`. After clean reopen, each conversation's provider `sessionId` is observed stable and distinct, while each request obtains a fresh hook/dispatch signal binding. This is an implementation canary, not a blanket guarantee for every provider operation. |
| `unfinished ordinary generation clean-close recovery rebuilds identity before enforced dispatch` | **Proven for the controlled faux ordinary-generation path.** The test enters the ordinary faux provider stream — a scripted response whose message resolves only on abort — and holds it genuinely unfinished at an explicit entered barrier, asserting provider `callCount` 1 with no assistant content settled. It captures the public task/conversation identity from the retained identity hook, clean-closes that entered stream, then opens a new harness with a newly constructed extension, WeakMap and enforcing wrapper. Without replacement input, resumed dispatch obtains a fresh invocation signal bound to an identity equal to the original, public `getTask` still attributes the exact original task to the conversation, and the work settles on the scripted successful completion (`stopReason` `stop`), not an error path. This is a clean close/reopen experiment, not SIGKILL evidence and not coverage for deferred or compaction paths. |
| `unfinished ordinary generation recovery without a binding is denied before faux transport` | **Proven for the synthetic wrapper.** The same unfinished provider-entered clean close is reopened with the enforcing wrapper and no installed identity hook, so no binding can exist. The resumed request reaches the wrapper and is denied before faux transport (`callCount` 0), and the transcript gains the synthetic denial with `stopReason` `error` rather than a successful completion. |
| `absent or throwing advisory hook leaves dispatch identity unknown and the wrapper denies it` | **Proven for the synthetic wrapper.** When the hook is missing or throws, Pi reports/ignores the ordinary hook failure and still reaches the wrapper; a test-only `WeakMap<AbortSignal, identity>` lookup has no binding, so the faux transport is not called. The deny decision is in the wrapper, not the hook exception. This is not a shipped adapter. |
| `executed tool receives exact marker/conversation/task/call tuples, including repeated call IDs across conversations` | **Proven for the fixture.** Request-context response factories derive each marker from that conversation's synthetic input, return completion after the matching tool result, and tuples are normalized by marker before comparison. Public task lookup correlates the exact conversation and task. Both conversations deliberately use the same model call ID. Replay identity across recovery is not tested and is not claimed. |
| `generation commits streamed partial assistant content before the faux response completes` | **Proven for normal generation streaming.** The test observes non-empty, incomplete text in the committed `pi.live.generation.message` document before the faux stream finishes, then confirms a settled assistant entry. |
| `fork exposes Pilot question projection and queued inbox behavior without implying workspace or authorization copying` | **Proven for public state projections and synthetic work.** Forks at question/answer cutoffs project the actual payload. The queued fixture installs its blocker (tool plus identity hook) before runtime open, configures a faux model, awaits tool entry before queueing, and observes the parent's queued item with the child's empty initial inbox. Responses are derived from each request's own context, and each provider entry is attributed through the hook-bound conversation identity: the parent conversation makes exactly three provider requests — its staged tool call, its tool follow-up and its own queued input — with both text completions settling `stopReason` `stop`; scripted responses remain, so no request hit exhaustion. The settled child, inspected before its own submission, made no provider call and holds none of the parent queued input or its completion. Only then does the child submit independent work, appending exactly one new assistant entry: the exact successful completion (`stopReason` `stop`) derived from that input. This does not claim that the child receives or dispatches the parent's queued input, nor any filesystem/worktree or application-grant behavior. |

The `public ToolExecutionApi exposes invocation-bound identity fields (declaration-level only)`
test is an additional declaration-surface sanity check; the preceding executed-tool canary is
the runtime evidence.

### Public APIs and installed evidence

- `@earendil-works/pi-durable/dist/harness/types.d.ts`: `InputEntry`, `SubmissionDraft`,
  `Conversation.submit/commit/fork`, and `ToolExecutionApi` (including readonly
  `conversationId`, `taskId`, and `callId`).
- `dist/harness/submissions.js`: `admitSubmission` performs conversation-scoped
  `submissionByRequest(conversationId, requestId)`; a found ID returns its original
  submission. `dist/harness/inbox.js` places custom input as `kind/data` plus the user
  model message.
- `dist/session/transaction.js` `forkConversation` and `dist/session/forks.js`
  `prepareForkDocumentCopies`: fork transcript parent/cutoff and conversation-document
  copy selection. `dist/session/forks.js` selects `fork:"initial"` from the definition's
  initial semantics and `fork:"current"` from current source state; the canary verifies
  their observable values.
- `dist/harness/tool.js` resolves model tool calls by the assistant entry and call ID, then
  constructs the tool task; `dist/harness/types.d.ts` binds execution identity on
  `ToolExecutionApi`. These are invocation identities, not a security grant by themselves.
- `dist/harness/generation.js` `request` invokes `beforeRequest`, constructs
  `options.signal = runtime.signal` and the persisted `sessionId`, then calls
  `streamSimple`. Its `streamResponse` flushes partials through runtime commits (default
  interval 100ms).
- `dist/harness/provider.js` defines the built-in `pi.provider` conversation document;
  its initial `sessionId` is `uuidv7()`, persisted and reused. The canaries do not access
  this document. It is an opaque provider-session identity, not a conversation ID.
- `@earendil-works/chord/dist/context/index.d.ts` declares `Context.abortSignal`.
  In `pi-durable/dist/harness/scheduler.js`, `#createInvocation` constructs one
  `controller`, uses `withAbortSignal(controller.signal, this.#context)` for the hook
  context, and exposes `controller.signal` as the runtime signal. The exact-object equality
  canary observes the resulting normal-request behavior under `BACKGROUND_CONTEXT`.

## Provider-dispatch identity: bounded result and gate

### What the signal canary establishes

For a normal `GenerationTask.request` that reaches `models.streamSimple`, a trusted
`beforeRequest(request, HookApi, Context)` handler can associate the current abort-signal
object with immutable `{conversationId, taskId}`. The synthetic dispatch wrapper receives
the identical signal object and can perform a fail-closed WeakMap lookup. It need not use
message content or a global “last hook” value. A missing mapping is denied; a throwing hook
does not authorize dispatch. Concurrency isolation and provider-session-ID continuity for
new requests after clean reopen are covered. A separate controlled experiment enters the ordinary faux
provider stream, holds it genuinely unfinished at an explicit entered barrier that responds
to abort, clean-closes it, and resumes with a newly constructed hook/WeakMap/enforcing
wrapper and no replacement input. It observes the same public task/conversation identity, a
new valid binding on a fresh invocation signal, and a scripted successful completion on the
resumed request. This is not SIGKILL evidence and does not cover deferred or compaction paths.

This is evidence for a **narrow normal-generation path**, not approval for a production
adapter. A real wrapper must also deny if the signal is aborted, if an existing binding
conflicts, if no binding exists, or if the provider/model/request policy check fails. It must
never serialize or persist AbortSignal objects. The canary did not race cancellation against
dispatch or inject a conflicting binding.

### Uncovered dispatch paths remain blocked

The installed implementation confirms the candidate does not cover all model operations:

- `generation.js` `poll` calls `runtime.models.fetchDeferred(model, handle,
  {signal:runtime.signal})` directly. `abort` can call
  `cancelDeferred(model, handle, {signal:runtime.signal})`. Neither path runs
  `beforeRequest`; the per-invocation signal is not proven to have a WeakMap identity.
  The deferred options do not carry the generation's `sessionId` either. **A wrapper must
  deny these paths unless a separately reviewed identity-binding mechanism is designed and
  canaried.**
- `compaction.js` `summarize` calls `runtime.models.completeSimple` with a new task
  invocation's signal and persisted provider `sessionId`. Its earlier `beforeCompact`
  hook is a different hook/phase; the GenerationTask `beforeRequest` map does not bind the
  compaction signal. No compaction dispatch binding is tested. **Block compaction model
  dispatch pending a specific reviewed and tested binding.**
- A request type or provider dispatch not shown to pass through the canaried
  `beforeRequest -> streamSimple` path is **unknown and denied**, not implicitly authorized.

Thus the result is: **normal GenerationTask streaming has a public-hook/signal identity
candidate worth a revised design; full provider-dispatch authorization remains BLOCKED.** The
adapter must provide separate coverage for ordinary generation, deferred polls/cancels,
compaction, cancellation/aborted signals, hook absence/failure, and any additional model
operation. Its contract must test two or more concurrent conversations, task ownership,
clean restart and recovery, session-ID continuity, and fail-closed conflict/missing cases
before multi-session privileged/provider policy is enabled.

## Durability, forks and exactly-once limits

A clean SQLite close/reopen is exercised by the canaries and is not a hard process kill.
Existing `tests/server/recovery.test.ts` separately tests a **SIGKILL** during an unsafe tool:
the stale service lock remains, the operator clears it in the disposable fixture, recovery
records an interrupted tool rather than replaying it, and the request ID still finds the
original submission. SIGKILL recovery is not the same as clean close, and neither establishes
cross-system exactly-once effects.

Pilot's existing `HarnessHost` creates a session per project, resumes the harness on open,
and bounds notes tools to the captured project path; those app seams are outside this canary
file's exclusive production scope. The fork tests exercise Pi's own conversation transcript
and documents only. A fork does not provision or copy a filesystem, Git worktree, Pilot task
link, provider grant, runner lease, or authority. A separate canary submits while busy through
`Conversation.submit()`, observes the queued item through the shared `agentViewFrom` projection,
and verifies a child fork at that cutoff has an empty inbox under Pi's `fork:"initial"`
semantics. The parent's own queued input is observed reaching the provider as its own
request; this is a public transcript/inbox projection and does not imply that a fork inherits
or dispatches the parent's queued input, nor Pilot task/workspace/authorization copying. Markdown remains canonical; the SQLite canaries
are derived working state only.

## Explicit gaps

- No safe all-operation provider-dispatch gate is proven; provider polling/cancellation and
  compaction remain denied pending revised design.
- No runtime canary asserts signal-abort races or conflicting WeakMap bindings.
- Tool replay identity across a crash/reopen is not tested; exact initial tool tuples and public task ownership only are proven.
- Tool replay identity across a crash/reopen is not tested; the canary proves initial exact
  invocation tuples and public task ownership only.
- The standalone app-document ledger canary demonstrates local transactional logical
  deduplication only. It does not make an external effect exactly once; effect/outbox
  reconciliation requires a separately designed adapter.
- Partial visibility is proven during a live faux stream, but hard-kill partial retention
  beyond the existing recovery test's checkpoint assertions is not newly certified.
- Fork question projection, queued parent inbox, empty child initial inbox, per-conversation provider attribution and one exact successful child completion are tested through public APIs. The experiment shows the parent dispatching its own queued item and the child starting no provider call before its own submission; it does not demonstrate dispatch of the parent's queued item by the child. Fork filesystem/worktree, grant and task-link consequences remain outside this public conversation contract and are not claimed.
