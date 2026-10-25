# Plan — Dependable from a phone

This is the tracked plan for the milestone after the original 17 steps. It states what is
already built, what is missing, the order of work, the acceptance tests and the risks. It
contains no deployment identifiers and no operations content.

The 17 steps of the foundation plan are built. The recent reviewed commits are:

- `f278afb` — named-session isolation, recovery and stream cleanup.
- `a3c4222` — drain active streams safely and retain locks when shutdown cannot finish.
- `6550c57` — validate local runner containment with real Docker acceptance checks.

The milestone goal is a Pilot that a person can trust from a phone: a connection that
recovers honestly, a composer that does not lose work, an activity view that reports what
really happened, and controls that stay reachable on a small screen.

## How to read this plan

| Status | Meaning |
|---|---|
| **Built** | Implemented, tested and reviewed in the current baseline. |
| **Partial** | Some behaviour exists, but it does not meet the acceptance criteria here. |
| **Gap** | Not implemented. |
| **Deferred** | Deliberately out of this milestone until its security design exists. |

Each step lists its acceptance criteria. A step is done only when its tests pass and the
owner has accepted it. Nothing in this plan authorises a commit, push or deployment.

## Invariants this milestone must preserve

1. **Markdown stays canonical.** Board and document edits remain revision-checked. Drafts,
   timelines and connection state are derived or local working state; they never become a
   second source of truth.
2. **Runners stay contained, and model calls stay out of them.** The runner remains a bounded
   container with no network and no fallback to this process, the application container or the
   host. Model inference — orchestrator or worker — runs in the application's Pi Durable harness,
   where provider credentials live; only bounded tool jobs run in the runner. The container has no
   provider access and this milestone must not add any. See `docs/RUNNER.md`.
3. **Owner authentication stays the only door.** Every route remains behind the same
   owner-only authentication, CSRF, origin and Host checks. No new anonymous route, no
   share link and no unauthenticated stream.
4. **The agent harness is the only execution surface.** No step here adds a shell, a general
   file API or an agent-created worker.
5. **Durable before visible.** An input, a lifecycle change and a queue transition are
   committed before the interface shows them.

---

## Ordered steps

### Step 1 — Reliable reconnect with bounded backoff and honest states

**Status: Partial.** The server stream works and shutdown now closes it (`a3c4222`,
`src/server/main.ts`). The client starts one stream per project/session
(`src/client/AgentsView.svelte`) and the request layer retries exactly one CSRF rejection
(`src/client/api.ts`). There is no bounded reconnect loop, no stale state, no snapshot
refresh on reconnect and no session race guard.

**Required work**

- Reconnect with bounded exponential backoff: start at about 1 second, double the pause,
  cap it at about 30 seconds, and reset after a successful settled snapshot. Never retry a
  `401` or an expired sign-in; show the authentication state instead.
- A closed set of connection states: `connecting`, `live`, `stale` (no frame within a
  bounded interval), `offline` (network failure), `auth-required` and `server-error`.
  Show the state and the age of the last confirmed snapshot, not only "Connecting…".
- **Fresh snapshot on every reconnect.** A reconnect reads the full view once, and only
  then resumes frames. Frames for an older connection or an older session are discarded.
- **Session race guards.** Each project and session selection carries a generation. A
  response, stream frame or question update from an older generation is ignored. Switching
  session aborts the previous stream; no two subscriptions may write one view.
- **No resubmit, no model dispatch.** Reconnect is read-only. It must never call the input,
  `resume`, `retry` or model routes. The lifecycle `reconnect` action already has this
  property; the browser must not introduce another path that starts work.
- **Bounded buffering.** Cap buffered frames and transcript rows (for example 500 entries,
  the same shape Pocket bounds its chat with). Drop the oldest with a visible gap marker;
  never grow memory without a limit.
- **Polling only after tunnel evidence.** Do not poll by default. Switch a given origin to
  bounded long polling only after the stream is proven not to work there — two failed
  streams, a partial first snapshot behind a proxy, or an explicit operator setting. Show
  the transport in use and try the stream again after a bounded interval. Local loopback
  stays on the stream.

**Acceptance criteria**

- A dropped stream reconnects, shows `offline`/`stale`, then shows one fresh snapshot and
  returns to `live`.
- A `401` stops retrying and shows the sign-in state.
- Switching sessions quickly cannot apply the old session's frames or questions to the new
  one.
- No reconnect, snapshot or poll sends an input, resumes a run or changes a model.
- Buffered state stays under its cap across a long disconnect.
- Polling starts only on the evidence named above and is visible.
- Browser tests cover offline, slow first snapshot, stream close and session switching;
  a server test asserts no dispatch on the reconnect path.

**Risks**

- Retrying an admitted mutation could duplicate a run. Mitigation: reconnect uses GET only;
  the existing `requestId` idempotency remains for real sends.
- A proxy can buffer SSE silently. Mitigation: the settled-snapshot rule and a bounded
  evidence-based fallback, not a timeout that guesses.
- Aggressive reconnects can hold the connection budget. Mitigation: capped backoff, one
  stream per view, `pagehide` close and one in-flight snapshot.

---

### Step 2 — Per-session drafts and attachment recovery rules

**Status: Gap.** The composer keeps one draft per mounted view
(`src/client/AgentsView.svelte`), and images live only in memory. A session switch, reload
or reconnect loses both. A send waits for an upload, which is the one correct rule already
present.

**Required work**

- Store a draft per project and session, keyed by both. Restore it on switch and reload.
  Clear it only after a send is admitted, never on a transient error.
- Show which session the draft belongs to, so a restored draft is never mistaken for the
  current session's text.
- Attachments have explicit states: `uploading`, `ready`, `failed`, `removed`. Only `ready`
  stored image ids may be sent. An upload in flight blocks send with a named reason.
- On reconnect or reload, recover attachment references that the server still knows, and
  offer to remove the rest. Never re-upload automatically, never send an image the person
  did not see as ready, and never silently drop one.
- Keep image bytes out of local storage; store only references and metadata.
- Apply these conservative limits (proposed defaults, not implemented): at most 64 KiB of text
  per session draft, at most 10 pending attachment references per draft, and expiry after 30
  days without an edit. Store at most 2 MiB of drafts per browser profile; when that is reached,
  refuse a new save and tell the person, rather than evicting silently. These values become
  binding only after the owner accepts them.
- A send is keyed by its request identity, so a retry after a network failure remains one
  admission, not two.

**Acceptance criteria**

- Switching sessions and back restores each draft exactly.
- Reload restores text and the recoverable attachment reference; a missing reference is
  named, not hidden.
- A failed upload stays visible and removable, and cannot be sent.
- A reconnect neither uploads nor sends anything by itself.
- Drafts and references respect the limits above, and exceeding one is refused with a named
  reason.
- Browser tests cover switch, reload, failed upload, reconnect and a send during upload.

**Risks**

- Local drafts can outlive the server's media object. Mitigation: recovery is by server
  reference, not by assuming local state is valid.
- A draft could be restored into the wrong context. Mitigation: key by project and session,
  with a visible session label.

---

### Step 3 — Measured activity timeline and tool outcomes

**Status: Partial.** `LiveActivity` already reports run state, tool invocations and results
as two honest lists with named absences (`src/shared/actions.ts`), and the palette renders
them. Durations, per-call outcome pairing, interrupted outcomes and a timeline view are
missing.

**Required work**

- Add measured timings only where the harness reports them: started and finished instants
  and a duration. An absent instant stays null with a named reason; never invent one.
- Report each tool result's outcome (`ok`, `warned`, `failed`, `interrupted`, `cancelled`)
  from the diagnostics the harness carries. Do not pair a call with a result unless the data
  carries an identity for it.
- Distinguish an interrupted tool from a failed one, and an uncertain interruption from a
  known cancellation.
- Render a compact timeline in the session view: newest activity, run state, and the last
  bounded tool events. Say when the list is truncated.
- Keep the projection path-free and token-free.

**Acceptance criteria**

- A run that calls one tool and fails it shows one call, one failed result and a duration
  consistent with the recorded instants.
- A run killed mid-tool shows `interrupted`, never `failed` or `ok`.
- A conversation with no tool activity reports the named absence, not an empty success.
- The view is bounded and states its limits.
- Server tests cover each state; a browser test renders a timeline with a truncation notice.

**Risks**

- The current harness view does not carry call ids. Mitigation: keep the two lists and do
  not fabricate pairing; treat pairing as a future capability.
- Clock skew can make a duration negative. Mitigation: report a non-negative elapsed time
  only when both instants come from the same source, otherwise report `not reported`.

---

### Step 4 — Follow-scroll and new-activity indication

**Status: Gap.** The transcript jumps to the bottom on every update
(`src/client/AgentsView.svelte`), which steals the reader's place while they read earlier
output.

**Required work**

- Follow new activity only while the reader is at or near the bottom (within about 8 px).
- When the reader has scrolled up, keep their position and show a "new activity" control
  with a bounded count. Tapping it returns to the bottom and resumes following.
- A message the person sends always returns to the bottom.
- Session switch resets the follow state and the new-activity count.
- Respect reduced-motion settings; never animate a jump the reader did not ask for.

**Acceptance criteria**

- Scrolling up during a live run stops auto-follow and shows the indicator.
- New frames do not move the reader's viewport while they are reading above the bottom.
- Tapping the indicator shows the newest content and resumes following.
- Sending returns to the bottom.
- Switching sessions never shows the previous session's new-activity count.
- Browser tests cover follow, pause, resume, send and switch.

**Risks**

- A virtualised list can mis-measure the bottom. Mitigation: measure the scroller, not the
  content, and test on a phone-sized viewport.

---

### Step 5 — Mobile Back stack and bottom controls

**Status: Gap.** Pilot's views are component state. The browser Back button leaves the app
instead of closing a drawer, a document or a session. The composer is not anchored as a
bottom control with safe-area handling.

**Required work**

- Give each layer its own history entry: project drawer, document tree, open document,
  settings, agent manager, session view and the question inbox. Back closes the newest layer
  and does not leave the app. Forward restores it.
- Keep routes and layers ordered; an in-app close removes its own entry.
- An installed home-screen app must land on an app surface, not a blank page.
- Bottom controls: composer, send/steer, stop, attach and the attention entry stay reachable
  above the keyboard and the home indicator. Respect safe-area insets and keep the
  conversation above the dock.
- Preserve unsaved draft and conflict warnings when Back would discard them; confirm rather
  than silently lose work.

**Acceptance criteria**

- Back closes exactly the newest layer, one step at a time, then leaves the app.
- Forward returns to the same layer.
- A reload on a session route shows that session.
- The composer and send/stop controls remain usable with a phone keyboard open and a
  safe-area inset.
- A dirty document or draft asks before Back discards it.
- Browser tests run at a phone viewport with Back, Forward, reload and keyboard.

**Risks**

- History and app state can disagree. Mitigation: one small module owns the stack; the app
  state remains the truth and history follows it, as Pocket's `web/back.js` does.
- A frozen page can hold a stream open. Mitigation: close the stream on `pagehide` and
  reconnect on `pageshow`.

---

### Step 6 — Attention: questions, approvals, failures and interrupted runs

**Status: Partial.** Questions appear in the inbox and agents view, alerts open the right
project, and the lifecycle exposes `failed`, `paused` and `interrupted`. There is no single
attention surface that ranks all four kinds, and no approval or interrupted-run action from
the phone.

**Required work**

- One attention surface and badge, with four explicit kinds: **question**, **approval**,
  **failure** and **interrupted**. Each shows the project, session, age and one line of
  context.
- Questions: answer once, refuse an already-answered question, keep the dismissal reason.
- Approvals: show kind, exact target, scope, expiry and whether it is pending, consumed,
  revoked or expired. Consuming performs nothing by itself; say so.
- Failures: show the provider or run reason, and offer `retry` only for a failed session.
- Interrupted: show the reason and `uncertain`; offer `resume` only where it is safe, and
  name the operator-attention case instead of replaying.
- Push notifications deep-link to the exact attention item, not only the project.
- Sort by severity, then age, then a deterministic id tie-break. Page the list with these
  conservative limits (proposed defaults, not implemented): 20 items per page, a stable cursor,
  and at most 100 open items listed. Show the exact open count from a separate count query, not
  from the capped page, and say when the list is capped.

**Acceptance criteria**

- Each kind is reachable, readable and actionable from a phone viewport.
- The list pages at 20 items with a stable cursor and a deterministic id tie-break. A separate
  count query reports the exact open count, including when it is above the 100-item list cap,
  and the list states when it is capped.
- An expired or consumed approval cannot be consumed again and says why.
- An uncertain interrupted run offers no replay; the refusal is visible.
- No attention action dispatches a model request except `resume` or `retry`, as already
  specified.
- Browser tests cover all four kinds and the deep link.

**Risks**

- An attention surface can become a second inbox with stale counts. Mitigation: derive it
  from the same durable records and refresh it with the same connection state.
- A push link can point at a deleted item. Mitigation: the surface reports "no longer
  present" rather than an empty page.

---

### Step 7 — `record_note` cancellation audit (delayed)

**Status: Partial.** `record_note` is declared `replay: 'unsafe'` and appends after an
optional `delayMs` (`src/server/agents/harness-host.ts`). The interruption path is
specified, but cancellation *during the delay* is not audited: it is not proven that a
cancelled call writes nothing, and that a crash during the write is reported as interrupted
rather than replayed.

**Required work**

- Audit the tool's cancellation path: the delay must observe the abort signal, and an abort
  must return a cancelled or interrupted result without touching the file.
- Define the window between the delay and the append. A crash inside that window must leave
  the run resumable with the tool reported as interrupted, not repeated.
- Remove `delayMs` from any path a model can choose in production; keep it only as a test
  seam if it remains at all.
- Record the audit result and the test evidence in this plan or a linked document.

**Acceptance criteria**

- A cancel during the delay writes no byte to `docs/notes.md` and reports cancellation.
- A crash between the delay and the append reports interrupted on the next start.
- The same note is never appended twice after a restart.
- The tool remains bounded in text length and cannot escape the project root.
- Server tests cover cancel, crash and restart.

**Risks**

- An append is not idempotent. Mitigation: rely on the unsafe-replay rule and add the
  missing cancel and crash tests; do not add an automatic retry.

---

### Step 8 — Owner-configured models: orchestrator and workers

**Status: Partial.** A model can be chosen per instance, per agent and per conversation,
but there is no separate worker model, no owner-defined allowed set, and no policy that
keeps a cheaper worker from changing the orchestrator.

**The owner requirement**

The owner must be able to configure, separately:

- the **orchestrator/session model** — the model that runs the session and its turns; and
- the **worker/subagent models** — an allowed set and a default for work that is delegated
  or run in a bounded worker.

The owner chooses the allowed models. The owner may select a cheaper worker model while the
orchestrator stays stronger. The effective model and its cost must be visible.

Both model selections govern **model turns in the application's Pi Durable harness**. They do
not move inference into a container. Only bounded tool jobs run in the contained runner, which
has no network and no provider access. The existing runner cannot reach a provider, and this
milestone does not give it one.

**Existing capabilities (verified in this worktree)**

| Capability | Where |
|---|---|
| A default model for new sessions | `src/server/providers.ts`, `savePreferences`, `defaultModel` |
| A per-agent model, validated against the models this instance offers | `src/shared/agent-registry.ts`, `src/server/state/agent-store.ts` |
| A per-conversation model, refused while the run is working | `setModel` in `src/server/agents/harness-host.ts` |
| Provider usability checked at dispatch: configured credential and explicit real-model opt-in | `assertUsable` in `src/server/providers.ts`, called in `harness-host.ts` |
| No silent fallback: unknown model is `422`, unusable provider is `409` | `src/server/providers.ts`, `harness-host.ts` |
| Effective model, tokens, cache counters and provider-reported cost in the UI | `src/client/SessionDetails.svelte`, `usageDetail` in `harness-host.ts` |
| The image capability of the effective model is checked before dispatch | `visionFor`, `assertVision` in `harness-host.ts` |
| A session's declared model is recorded, never applied | `src/server/state/session-registry.ts`, `docs/SESSIONS.md` |

**Gaps**

- No worker/subagent model exists. The queue holds no per-worker model, and the runner
  executes no model at all: its jobs are bounded tool execution.
- There is no owner-defined allowed set. An agent has one model; the setting is not a
  policy list with a default for workers.
- No default worker model, and no rule that a cheaper worker cannot silently become the
  orchestrator.
- Cost is shown per conversation, not per worker run or per tool.
- A queued input has no recorded model. A model change while work is queued changes what
  the queued work runs under, without saying so.
- Unavailable and authentication errors are clear text but not a stable state the UI can
  rank in the attention surface.

**Required work**

- Add an owner-only model policy: allowed orchestrator models, default orchestrator model,
  and the allowed worker models from which Step 9 chooses a worker default. Validate every
  entry against this instance's offered models. The worker **policy** itself — assignment,
  default and enforcement — belongs to Step 9.
- Separate the two selections in the interface and in the API. Do not derive one from the
  other. Both select a model for harness turns; neither changes what runs in the runner.
- Keep every model request in the application harness. Do not add a provider client, a
  credential, a network route or a proxy to the runner container.
- A model change applies to the next dispatch only. It never changes a running generation.
  A queued input records the model it will use, and the interface shows it before dispatch;
  if that cannot be guaranteed, refuse the change while the queue is non-empty and say why.
- No silent fallback anywhere: a missing credential, a revoked sign-in, an unknown model,
  a quota refusal and a provider outage each produce a named state and a clear message.
- Show the effective orchestrator model, the effective worker model where one is used, and
  the provider-reported cost. Mark an unreported cost as "not reported", never zero.
- A model change must preserve scopes, budgets and authority. It must not widen a tool
  allowlist, a project scope or a budget, and it must not change an existing run.
- Record each dispatch's effective model and attempt identity in the durable record, so the
  cost and the model of a completed run can be read back.

**Acceptance criteria**

- The owner can set an allowed set and a default for orchestrator and worker separately,
  and cannot save a model this instance does not offer.
- A worker's model turns can use a cheaper allowed model in the application harness while
  the orchestrator keeps its stronger one, with both effective models and costs visible.
- The runner container still has no network and no provider access after the change.
- A model change during a run is refused or applies only after the run; it never alters the
  running generation.
- A queued input's model is visible before it dispatches.
- Missing credentials, revoked sign-in, unknown model and quota refusal each show a named,
  actionable error, and no request is sent under a different model.
- Effective model and cost are visible after a run; an unreported value says so.
- Tests cover the policy, the separation, the refusal cases and the no-fallback rule.

**Risks**

- A richer model policy can become an authority path. Mitigation: owner-only policy; agents
  may only select from it, never edit it.
- A per-worker model can drift from the worker's budget. Mitigation: validate both against
  one immutable worker record and show both together.
- A worker model can be mistaken for container configuration. Mitigation: the interface and
  the record name it as a harness model, and the runner contract is unchanged.
- Cost attribution can be wrong if the provider reports per model, not per call. Mitigation:
  report at the granularity the provider supports and name the granularity.

---

### Step 9 — Bounded, owner-created workers (worker model policy lives here)

**Status: Gap.** The runner and queue exist, but there is no bounded worker entity, and no
agent may create one. **The worker model policy belongs to this step**: Step 8 only defines
the owner's allowed set and the orchestrator choice.

**Required work**

- A worker is created only by the owner. It carries an immutable record: name, the worker
  model selected from the owner's allowed worker set (Step 8), a default worker model for
  its runs, budgets, a project scope that is a subset of the owner's, a tool allowlist, and
  a revision. A cheaper worker model never changes the orchestrator's model.
- An agent may request work but can never create a worker, widen a scope, raise a budget or
  change a model policy. No step in this milestone grants agents the power to create agents
  or broaden privileges.
- A worker's **model turns run in the application's Pi Durable harness**, in the application
  process, where the owner's provider credentials already live. Its **bounded tool jobs** run in
  the contained runner with no network. The runner cannot reach a provider, and no provider
  credential, endpoint or proxy is added to it. There is no fallback: a tool job that cannot run
  contained does not run in the application process or on the host. See `docs/RUNNER.md`.
- Every worker run records its model, budget, attempt identity and outcome durably.
- A worker's authority is derived from its owner-created record on every call; a change is
  revision-checked and applies to the next run.

**Acceptance criteria**

- Only an owner request can create, change or delete a worker; an agent attempt is refused
  by name.
- A worker cannot use a model outside the owner's allowed set, or a scope or budget wider
  than its record.
- A worker run with a missing image, a missing credential or an unavailable model fails
  closed with a named reason.
- Every bounded tool job a worker requests runs in the container; no model request, provider
  credential or provider network path enters the container.
- A tool job that cannot start in the container fails closed, with no fallback to the
  application process or the host.
- Tests cover creation authority, scope escalation refusal, budget refusal, model refusal,
  containment and the absence of provider access from the container.

**Risks**

- A worker is an execution surface. Mitigation: keep the existing containment and authority
  checks, add no shell and add no agent-created worker.

---

### Step 10 — Disconnect, cancel and crash tests

**Status: Partial.** There is a real kill-mid-tool recovery test and browser coverage for
sessions and actions. There is no dedicated matrix for disconnect, cancel and crash across
the new UI states.

**Required work**

- A disconnect matrix: stream drop, network loss, `401`, slow first snapshot, session
  switch, reload and two tabs. Assert bounded backoff, fresh snapshot, no duplicate
  subscription and no dispatch.
- A cancel matrix: cancel during a streaming turn, cancel during a tool delay
  (`record_note`), cancel with queued inputs, and pause versus stop. Assert one recorded
  outcome and no resubmission.
- A crash matrix: kill the server mid-tool, mid-write and mid-queue-claim; restart and
  assert the adopted lifecycle, the interrupted result, the queue reconciliation and the
  lock behaviour. Reuse the existing kill-mid-tool harness.
- Every long test runs with a bounded timeout in seconds (60–120), never `timeout: 30000`.

**Acceptance criteria**

- Each matrix case has a passing test that asserts both the visible state and the durable
  record.
- No case produces a second dispatch or a duplicate append.
- No test leaves a server, stream, socket or timer open after it finishes.
- A failure names the state and the reason.

**Risks**

- Timing-based browser tests can flake. Mitigation: assert states and records, not sleeps;
  use Playwright's own waiting.
- A crash test can leave a stale lock. Mitigation: each case uses a disposable root and an
  explicit cleanup step; the lock evidence rule is never weakened for tests.

---

## Deferred until a security design exists

These are out of scope for this milestone. They must not be enabled as a side effect of a
step above.

| Deferred item | Why |
|---|---|
| Shared browser sessions between people | Two identities on one live browser is a new authorisation model; there is no design for who may act, see or take over. |
| Runnable artifacts | Executing a person-supplied page or script beside the owner's authenticated session is a code-execution and exfiltration surface. Static HTML/SVG mockups remain read-only and sandboxed. |
| Unrestricted extensions | Loading arbitrary code into the interface or the harness crosses the containment boundary; the current scope allowlist is the whole capability surface. |
| Anonymous sharing | Every route is owner-only by design. A share link needs its own scope, expiry, revocation and audit design. |

A proposal for any of these must start with a security note covering identity, scope,
containment and revocation, and must not weaken the owner-only door.

---

## Risks to the milestone

| Risk | Effect | Mitigation |
|---|---|---|
| Reconnect logic duplicates a send | A second run or a duplicate note | GET-only reconnect; request-identity idempotency; explicit tests |
| Poll fallback becomes the default | Load and latency on every phone | Evidence-based switch per origin, bounded duration, visible transport |
| Local drafts diverge from server media | A broken attachment or a lost message | Recover by server reference; name a missing item; never auto-upload |
| Timeline invents pairing or timing | False confidence in what ran | Named absences; no fabricated ids or instants |
| Model policy becomes an authority bypass | A cheaper or wider path than the owner chose | Owner-only policy; validate against offered models; preserve scopes and budgets |
| Worker creation by an agent | Privilege escalation | Owner-only creation, refused by name, tested |
| Provider access reaches the container | Credential exposure and an uncontrolled network | Model calls stay in the application harness; the runner stays no-network; a test asserts no provider path is added |
| Back stack and app state disagree | Lost draft or a blank home-screen app | One stack module; app state is the truth; confirm before discard |
| Tests hang or leave resources | A blocked milestone and a stranded root | Bounded timeouts, disposable roots, teardown assertions |

## Evidence paths

Repository evidence in this worktree:

- `src/client/AgentsView.svelte` — stream lifecycle, session selection, draft, image send gate.
- `src/client/api.ts` — request retry rules, stream reader, session-expiry handling.
- `src/server/main.ts` — SSE route, stream drain, lifecycle and model routes.
- `src/server/agents/harness-host.ts` — `setModel`, `dispatchLifecycle`, cancellation and
  unsafe-replay handling, `usageDetail`.
- `src/server/providers.ts` — model catalog, preferences, `assertUsable`, no-fallback errors.
- `src/shared/actions.ts` — `LiveActivity`, tool invocation/result contract, named absences.
- `src/shared/agent-registry.ts` — agent model, budgets, scopes, actor kinds.
- `src/server/state/session-registry.ts` — a declared model is recorded, never applied.
- `src/client/SessionDetails.svelte` — effective model, lifecycle, cost, named absences.
- `docs/ARCHITECTURE.md`, `docs/SESSIONS.md`, `docs/RECOVERY.md`, `docs/QUEUE.md`,
  `docs/RUNNER.md` — invariants and existing acceptance rules.
- `tests/server/agents.test.ts`, `tests/server/recovery.test.ts`,
  `tests/browser/session-ux.spec.ts`, `tests/browser/agents.spec.ts` — current coverage.

Pocket source evidence (paths relative to the Pi Pocket repository):

- `web/store.js` — reconnect, bounded backoff, auth handling, evidence-based polling,
  full-view `hello` after a new session, bounded chat history.
- `web/back.js` — one history entry per layer, Back/Forward order, home-screen entry.
- `web/composer.js` — per-conversation drafts, persisted pastes, inline files.
- `web/pip-attachments.js` — scoped draft with generation and revision guards, attachment
  recovery, unknown auth during reconnect is not an account change.
- `web/transcript.js` — follow/stick scroll, new-activity handling, connection captions.
- `web/dock.js` — bounded dock above the composer, bars that stay whole on a short screen.
- `web/agent-now.js`, `web/subagents.js`, `web/subagents-board.js`, `web/calls.js` —
  current activity text and one-line tool descriptions.
- `web/signin.js` — the sign-in surface for an unauthenticated browser.
- `web/live.js` — delta merging for the message being written.

## Backup statement correction

The README and `docs/SECURITY.md` both said a backup excludes agent sessions. That is wrong
against `scripts/data-tools.mjs` and `docs/BACKUP.md`, and both are corrected in this change.

The archive captures `catalog.json`, the agent session databases and `control.sqlite`
(operations, receipts, outbox, approvals, named sessions and lifecycle), plus boards,
documents, media and `settings/`. For an external project it captures that project's
`docs/dashboard` tree (the board and inert source snapshots); the repository remains its own
backup. It excludes, for the stated reasons:

- `credentials/` — provider keys, sign-ins and project deploy keys;
- `alerts/` — the VAPID signing key and the device endpoints that belong to it;
- `repositories/` — agent git worktrees, derived from the project repository;
- `forks/` — child fork worktrees, also derived; the fork records themselves are rows of
  the captured `control.sqlite`;
- `snapshots/` — the bounded board revision history the application writes, rebuilt as
  boards are edited; and
- `service.lock` — ownership evidence, never part of an archive.

A restore therefore keeps transcripts and durable control state, but it does not restore a
byte-identical working environment. It needs a fresh sign-in, new deploy keys and alerts
enabled again, and the derived worktrees and snapshots must be recreated. Treat the archive
and its passphrase as the only key to the captured state.

## Status summary

| Step | Status |
|---|---|
| 1 Reliable reconnect and honest states | Partial |
| 2 Per-session drafts and attachments | Gap |
| 3 Measured activity timeline | Partial |
| 4 Follow-scroll and new activity | Gap |
| 5 Mobile Back stack and bottom controls | Gap |
| 6 Attention surface | Partial |
| 7 `record_note` cancellation audit | Partial |
| 8 Owner-configured orchestrator and worker models | Partial |
| 9 Bounded owner-created workers | Gap |
| 10 Disconnect, cancel and crash tests | Partial |
| Shared browser, runnable artifacts, unrestricted extensions, anonymous sharing | Deferred |
