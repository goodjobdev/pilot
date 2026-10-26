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

**Status: Partial — reconnect core built locally; owner acceptance pending.** The server stream works and shutdown now closes it
(`a3c4222`, `src/server/main.ts`). The bounded, heartbeat-aware reconnect client is in
`src/client/stream.ts`. A technical client-retained transcript bound is now implemented in
`src/client/transcript-window.ts`: at most 500 newest rows and 500 question projections. These are
technical view-memory bounds, not accepted retention policy. The server transcript and durable
history remain unchanged. Evidence-based polling fallback is deferred: local loopback stays on
streams, and no tunnel evidence or owner decision has been supplied.

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

**Evidence (reconnect core).**

- `src/client/stream.ts` reads full snapshots only. It treats every complete frame, including
  the server's 20-second keep-alive comment, as transport activity; `lastViewAt` reports useful
  progress and never makes an idle session stale. Parser tests cover fragmentation at every
  boundary, CRLF, multiline frames, two valid frames in one chunk under a per-frame byte cap,
  an aggregate many-short-lines overflow, a UTF-8 byte cap, and an incomplete frame.
- Reconnect is bounded: the server's `retry:` hint is clamped to 1-30 seconds, the delay doubles
  with jitter, and 6 automatic attempts end in a visible `offline` or `stale` state with a manual
  `Reconnect`. The retry budget resets only after 10 seconds of transport-fresh time, so a
  snapshot-then-drop sequence still reaches `offline`. `401` ends in `auth-required` immediately
  and calls the sign-in expiry handler; `403` shows the server's message and code with no retry
  loop, and a hanging refusal body cannot delay either state.
- One generation and one `AbortController` own each project/session selection. A session switch
  aborts the old stream, clears the old view and drops every late status, snapshot or question
  update from the previous generation. A browser test holds the old selection's initial
  `/agents` snapshot, switches sessions, and proves the stale response cannot disable the new
  view. A reconnect is a `GET` only: it sends no input, answer, model change, `resume` or `retry`.
- The server keeps at most one pending snapshot frame and drops intermediate full snapshots under
  backpressure. A frame over 4 MiB is refused with one terminal `STREAM_SNAPSHOT_TOO_LARGE` error
  frame, which waits for the in-flight frame to drain instead of being written behind it. The
  existing drain order is preserved: `end()` clears the timer and pending frame, disposes one
  subscription, and shutdown still waits for it.
- `src/client/transcript-window.ts` caps client-retained rows at 500 and separately caps question
  projections at 500. It retains newest entries with original ids and reports exact omitted counts.
  The UI says omitted rows are hidden only in the client view and durable history is unchanged. If
  the separate question projection reaches its technical bound, the UI names the omitted count and
  warns against treating the current view as a complete question list. The pure projection preserves
  `usage`, working state, inbox, and all other totals as supplied; it never derives them from rows.
  `appendedTranscriptRows()` uses stable-id suffix/prefix overlap to count multiple arrivals in a
  full window. A reorder or a view with no proven overlap is reported as `New activity; count
  unavailable`, not as a guessed exact count. Each stream's first full snapshot establishes a
  baseline, so a reconnect history shift does not create a fabricated activity count. A paused
  reader keeps the first still-visible entry at the same screen offset when a snapshot drops older
  rows. The full snapshot and JSON parse still exist transiently before this client cap. The existing
  4 MiB frame/parser bound is unchanged; this is a retained row-count bound, not a per-row byte,
  wire or transient-payload bound.
- `tests/unit/transcript-window.test.ts` covers 507 rows, exact omission, stable ids, unchanged
  usage, pending-question identities separate from the row window, question projection omissions,
  exact 20-row rolling-window appends, no-overlap and reorder uncertainty, and same-identity streamed
  text updates. `tests/unit/follow.test.ts` covers the honest unknown-count state. Browser fixtures
  feed a synthetic 507-row SSE snapshot and verify 500 rendered rows, the exact gap, unchanged view
  totals, and fresh bounded state after reload. A held-open synthetic SSE fixture pauses over a
  stable row, then adds 20 equal-height rows while the 500-row window evicts 20. It verifies that
  the same row stays within 1 CSS pixel, the window remains 500, the gap rises from 7 to 27, and the
  badge says exactly 20 new activities. A 505-question fixture verifies the omission warning, opens
  an omitted question from the authoritative `Needs me` inbox, reloads the full session projection
  while preserving that exact question inside the 500-item cap, then posts an answer with its
  original id. Neither fixture calls a provider. Unit tests cover exact overlap and focused-question
  preservation. Owner and real-phone acceptance remain pending.
- The 600 ms delayed-first-snapshot browser test proves only that the state remains
  `connecting`; the 45-second stale boundary is covered by the unit test, not by that browser
  test.
- Current transcript-bound verification: TypeScript and Svelte diagnostics pass (0 errors and
  warnings); fresh client and server builds succeed. Independent review reran the final full
  unit/server suite: **597 tests passed**. All **88 browser tests** pass against the fresh build
  in two sequential bounded shards (52 and 36), including all 13 follow scenarios and the
  eviction-anchor and omitted-question inbox cases. Independent review found no code blocker.
  Owner and real-phone acceptance remain pending. No push, deployment or live-data use.

**Risks**

- Retrying an admitted mutation could duplicate a run. Mitigation: reconnect uses GET only;
  the existing `requestId` idempotency remains for real sends.
- A proxy can buffer SSE silently. Mitigation: the settled-snapshot rule and a bounded
  evidence-based fallback, not a timeout that guesses.
- Aggressive reconnects can hold the connection budget. Mitigation: capped backoff, one
  stream per view, `pagehide` close and one in-flight snapshot.

---

### Step 2 — Per-session drafts and attachment recovery rules

**Status: Built locally; owner acceptance pending.** A draft is stored per
project and session (`src/client/drafts.ts`) and restored on switch and reload. Image references
are recovered by server id, and every non-ready state is named. The review removed the
unaccepted attachment-count policy and the age and clock deletion rules: there is **no attachment
count limit** and **no age, clock or count rule that deletes a valid draft**. Only three technical storage bounds remain, each with a visible
refusal or a reported, bounded drop of failure notes. The 18 new unit tests and 12 new browser
tests pass; the step is not done until the owner accepts it.

**Required work**

- Store a draft per project and session, keyed by both. Restore it on switch and reload.
  Clear it only after a send is admitted, never on a transient error.
- Show which session the draft belongs to, so a restored draft is never mistaken for the
  current session's text.
- Attachments have explicit visible states: `uploading`, `checking`, `ready`, `refused`,
  `failed`, `missing`. Only `ready` stored image ids may be sent. `uploading` and `checking`
  block send with a named reason. A removal is an explicit delete of the reference.
- On reconnect or reload, recover attachment references that the server still knows. **Only a
  `404` means the server does not have the object.** A network, sign-in, permission or server
  failure keeps the reference in `checking`, keeps its media id in the saved draft, and offers
  an explicit retry. Never re-upload automatically, never send an image the person did not see
  as ready, and never silently drop one.
- Keep image bytes out of local storage; store only references and metadata. The text itself is
  arbitrary and may contain a secret the person typed; the store adds no credential.
- Keep only technical storage bounds, with a visible honest refusal: 64 KiB of UTF-8 text per
  draft, 2 MiB of drafts per browser profile, and 16 KiB of failure notes per draft. When only
  failure notes exceed their bound, drop notes with a visible count and keep every sendable
  reference. Do not add an attachment count, expiry or clock rule without the owner's decision.
- A send is keyed by its request identity, so a retry after a network failure remains one
  admission, not two.
- If a local save is refused, keep the latest state in memory across switches, warn that it is
  not saved, name the last saved time, and offer copy and download. Write a best-effort warning
  marker for the next load.

**Acceptance criteria**

- Switching sessions and back restores each draft exactly, including text that could not be
  saved.
- Reload restores text and the recoverable attachment reference; a missing reference is
  named, not hidden; a failed lookup is kept and can be retried.
- A failed or refused upload stays visible and removable, and cannot be sent.
- A reconnect neither uploads nor sends anything by itself, and a later send happens once.
- No valid draft is deleted by an age, clock or attachment count rule.
- Exceeding a technical storage bound is refused with a named reason, or drops only bounded
  failure notes and says how many.
- Browser tests cover switch, reload, failed upload, reconnect with a draft and image, a send
  during upload and a refused local save.

**Evidence.**

- `src/client/drafts.ts` is the pure store: versioned records keyed
  `pilot.draft.v1:<projectId>:<sessionKey>` (`root` for the unnamed conversation), a per-project
  `pilot.session.v1:<projectId>` selection preference validated against the server's session list,
  and strict validation on both read and write. UTF-8 byte validation is symmetric on load and
  save, including the send attempt's text. Unknown fields are dropped, so image bytes, object
  URLs, file handles and application credentials cannot be stored even by a future caller. The
  text is whatever the person typed and may itself contain a secret; the store adds none.
- **Nothing deletes a valid draft automatically.** There is no age limit, no clock-skew rule and
  no count rule. A corrupt record is reported and left in place; the next save of the same
  identity replaces it, and an explicit clear removes it. A draft is removed only after an
  admitted send, by **Clear local drafts**, or when a newer save replaces the same key.
- Saves are refusal-only for the three technical bounds, the browser quota, or unavailable
  storage. A text or profile refusal keeps the in-memory draft and shows its own reason; nothing
  is evicted and no other draft is changed. When only failure notes exceed 16 KiB, the save
  succeeds, every sendable reference is kept, and the dropped note count is shown. The profile
  total is measured without parsing every draft, and writes are debounced by 200 ms, so typing
  does not scan the whole store on each keystroke.
- `src/client/AgentsView.svelte` keeps the latest state in memory per project and session, and
  flushes the debounced write before a send, a session or project switch, `pagehide`, and a hidden
  document. A refused save marks the state unsaved, keeps the last successful save time, writes a
  best-effort `pilot.draft.warn.v1:<projectId>:<sessionKey>` marker, and shows **Copy draft** and
  **Download draft**. After a reload the marker's warning distinguishes a last saved version from
  no saved version at all, and says to check the transcript before resending because a message may
  already be admitted. Copying or downloading keeps the text only; it does not prevent a duplicate.
  The interface also offers a confirmed **Clear local drafts** action.
- A send reuses the stored `requestId` only when the trimmed text and the ordered media ids are
  exactly the message that was attempted; an edited message mints a new one. The attempt is saved
  before the request, so a reload during an ambiguous failure retries the same admission. The
  draft is cleared only after `agentInput` resolves; a rejection or a network failure keeps it.
  When the attempt record itself could not be saved, the composer warns before the request that
  admission can still succeed while the reply is lost, and that a reload may not recognise it as
  already sent. Text typed while a send awaits is kept when it no longer equals the submitted text,
  and only the submitted image keys leave the strip. A result that arrives after a project or
  session switch is dropped rather than applied to the new identity.
- Attachments have the six visible states above. On load, a stored id is shown as `checking` until
  a read-only GET of `/api/media/<id>` answers. **A `404` becomes `missing`; any other failure
  stays `checking` with an explicit reason and a Retry lookup control, and the media id stays in
  the saved draft.** Recovery never uploads, re-uploads, sends or starts a model call: a browser
  test records every non-GET request during a reload and asserts none touches `agents/input` or
  `agents/media`. `ImageComposer.svelte` captures the project, session and identity at the start of
  a gesture. An upload still in flight when the session changes is named `missing` in that
  session's own draft rather than shown as forever checking or moved into the new session.
- The image capability travels with the agent view: `GET /api/projects/<id>/agents?sessionId=…`
  returns `vision`, and `POST /api/projects/<id>/agents/model` returns the capability of the model
  now in force, so a model change refreshes it. A model change that arrives in the streamed view
  triggers one guarded capability read through the same view request, once per model key and
  stream run: no model dispatch and no retry loop, and a late answer cannot overwrite a newer
  model reading. `vision` is `null` when it cannot be read, for
  example a named session with no conversation. The query is bounded to 1–200 characters (`422`
  otherwise), and an explicit empty value is rejected on the view and the stream alike. There is
  no separate capability route. The view request already opens the project
  harness, and opening it runs `harness.resume()`, which can continue an existing checkpoint; the
  capability read adds no route and no model call, but the view is not execution-free. The
  composer blocks a send only when the capability is known to be false; the server's admission and
  dispatch checks stay authoritative.
- **Privacy and retention.** Drafts are local working state, not documentation or a transcript.
  They are not encrypted, are readable by scripts on the same origin, and are kept until an
  admitted send, an explicit clear, or replacement by a newer save. There is no application
  sign-out route: hosted mode signs in through Cloudflare Access, whose sign-out is external and
  cannot be observed here. A transient `401` never clears a draft. On a shared device, use
  **Clear local drafts** or clear the browser's site data.
- Tests: `tests/unit/drafts.test.ts` (18) covers round-trip, project/session isolation, the unnamed
  key, the sanitiser dropping bytes, a ready reference without an id, the restore states, a failed
  lookup keeping its media id, corrupt records left in place, the absence of age and clock
  deletion, many attachments stored without a count rule, the failure-metadata bound, the
  technical text and profile bounds, symmetric UTF-8 validation, quota and unavailable storage,
  exact attempt matching, the save-failure marker, `clearAll`, and the selection preference.
  `tests/browser/drafts.spec.ts` (12) covers switch and reload, a rejected send, a network failure
  with one reused request identity, a concurrent edit during a send, an upload finishing after a
  session switch, a restored and a missing image reference, a failed lookup with retry, a refused
  and a failed upload staying visible after a send, the checking state holding a send, capability
  blocking and refreshing after a model change, the bounded view query, a reconnect with a draft
  and image (one upload, one send), a corrupt record, and a refused local save with export and the
  explicit clear. `tests/server/agents.test.ts` also covers the capability in the view, the
  capability returned by a model change, and the 1–200 character bound with an explicit empty
  value rejected on both the view and the stream.
- Passing evidence in this worktree: `pnpm check`; `pnpm test` (440 tests, including 18 draft
  tests); `pnpm test:browser` (46 tests, including 12 draft tests); `pnpm build`. No commit, push,
  deployment or live-data use.

**Technical bounds (not product policy).** 64 KiB of UTF-8 text, 2 MiB per browser profile, and
16 KiB of failure notes in one draft. There is no attachment count, no expiry and no clock rule.
A product limit needs the owner's decision before it is implemented.

**Risks**

- Local drafts can outlive the server's media object. Mitigation: recovery is by server
  reference, not by assuming local state is valid.
- A draft could be restored into the wrong context. Mitigation: key by project and session,
  with a visible session label and a generation guard on every restore.
- An upload accepted by the server after the person switched away is not attached to either
  session: its id is dropped rather than moved, and the old session names it `missing` when
  revisited (the media store has no delete route, so the object remains orphaned). This is
  deliberately the safe side of "no cross-session attachment leak".
- A refused local save can still lose the newest text on a reload, because the browser will not
  store it anywhere. Mitigation: keep it in memory across switches, warn, name the last saved time,
  write a best-effort marker, and offer copy and download. None of that is a persistence guarantee,
  and copying or downloading does not prevent a duplicate admission.
- If storage refuses the attempt record as well, a reload cannot reuse the same request identity
  for an ambiguous send. Mitigation: the warning and the copy and download actions name the risk;
  the server's idempotency still applies whenever the attempt was stored.
- The capability read needs a conversation; for a newly created named session with none it is
  unknown until a message exists. The server's admission and dispatch checks remain authoritative.
- Browser storage is per browser profile and is not synced or backed up. Losing it loses drafts,
  never documentation, a transcript or a sent message.
- Drafts are not encrypted and have no sign-out hook. Mitigation: an explicit local clear action,
  and documentation that a shared device needs that action or a site-data clear.
---

### Step 3 — Measured activity timeline and tool outcomes

**Status: Built locally; automated acceptance criteria pass. Real-phone owner acceptance is not claimed.** `LiveActivity` reports run state, tool invocations and results as two honest
lists with named absences (`src/shared/actions.ts`). Results now carry a protocol-derived outcome
(`ok`, `warned`, `failed`, `interrupted`, `cancelled`) with its certainty and the harness's own
measured duration; a missing instant or duration is null with a named reason. The session view
renders a compact, bounded activity timeline that says what it withholds. Calls and results are
still not paired: the shared view carries no reliable call id, so pairing remains a future
capability.

**Required work**

- Add measured timings only where the harness reports them: started and finished instants
  and a duration. An absent instant stays null with a named reason; never invent one.
- Report each tool result's outcome (`ok`, `warned`, `failed`, `interrupted`, `cancelled`)
  from the diagnostics the harness carries. Do not pair a call with a result unless the data
  carries an identity for it.
- Distinguish an interrupted tool from a failed one, and an uncertain interruption or abort from a
  phase-proven cancellation (`abandoned`, which never ran).
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
  not fabricate pairing; treat pairing as a future capability. Raw transcript messages do
  carry the provider's call id, but exposing it would widen the shared view contract, so it
  is not used here.
- Clock skew can make a duration negative. Mitigation: report only the harness's own measured
  `durationMs`, never a subtraction of two instants; a missing or negative duration is null
  with the named reason `no-duration-reported-by-the-harness`.

### Evidence (Step 3)

- `src/shared/activity.ts` derives the two lists from the transcript. An instant is the entry's
  recorded timestamp, or `null` with `no-instant-recorded-in-the-transcript`; a duration is the
  result message's own `durationMs` when it is finite and non-negative, or `null` with
  `no-duration-reported-by-the-harness`. Two instants are never subtracted. The invocation instant
  is the assistant message's recorded timestamp, not a separately recorded tool start; `abandoned`
  means the call was not started because its caller ended with a restart. An outcome and its
  `certainty` come only from the result's `isError` flag and the harness diagnostic codes:
  `interrupted` is `uncertain` (the effect may be partial); `aborted` is also `uncertain` because
  the harness emits it after a non-restart abort even in the execute phase; only `abandoned` is a
  phase-proven cancellation (`certain`) because the call was not started. An error flag or error
  diagnostic is `failed`, a warning is `warned` (completed, not failed), and a clean result is `ok`.
  Diagnostic messages, tool arguments and tool output are never copied. The lists are capped
  independently and `omitted` reports exactly how many older calls and results were withheld.
- `src/shared/agent.ts` reads only a tool result's own provenance from its message: its tool name,
  `isError` and `durationMs`. It does not expose the call id, and a negative or non-finite
  duration becomes `null`.
- `src/server/state/action-registry.ts` reads the selected session's conversation when
  `/api/actions/activity?projectId=…&sessionId=…` names one, and keeps `no-conversation`,
  `none`, `unavailable` and `failed` distinct. A failed read still reports fixed text, never the
  harness error. The palette and the session timeline both read this one projection.
- `src/client/SessionActivity.svelte` is the compact session timeline: the durable run state of the
  selected session, the newest recorded call or result instant, the last 2 calls and 2 results, and a
  sentence naming the older events it withholds. It clears the old timeline on a session switch
  and discards a late response for the previous session.
- `tests/unit/activity.test.ts` drives a failed tool with its instants and duration, interruption,
  abort and abandoned cancellation, `ok`/`warned`/unclassifiable results, missing instants and durations, a
  negative duration, the two-list bound, a zero bound, invalid bounds and the shared outcome label,
  and asserts that no path, argument or diagnostic message is carried.
- `tests/server/action-registry.test.ts` drives the failed and interrupted outcomes through the
  projection, the session-scoped read, the named `no-conversation` absence, a bad session scope,
  the bounds and the exact contract fields, and asserts a path, argument or message never appears.
  It also drives a zero cap as an empty list, a cap above the maximum as clamped, and a negative,
  fractional or non-numeric cap as refused. `tests/server/http.test.ts` drives the same session
  scope through the authenticated route.
- `tests/browser/activity.spec.ts` runs on a phone-sized viewport: the named absence before any
  tool, one `record_note` call and its `ok` result with the recorded instant and duration, three
  tools over the view bound with the truncation sentence, no argument in the timeline, a session
  switch that clears the root conversation's call, and a held response for the previous session that
  is discarded after the switch.

---

### Step 4 — Follow-scroll and new-activity indication

**Status: Built — awaiting owner acceptance on a phone.** The transcript follows new entries only
while the reader is at or near the bottom. A reader who scrolled up keeps their position, a bounded
count of the entries that arrived meanwhile is shown in a control row with reserved space, and
tapping it returns to the bottom and resumes following. An admitted send returns to the bottom; a
refused send does not move the reader. A project or session switch resets the follow state and the
count. The former unconditional jump (`transcript.scrollTop=transcript.scrollHeight` on every update,
which stole the reader's place) is gone (`src/client/AgentsView.svelte`, `src/client/follow.ts`). On a
390×844 phone the transcript measures 297 CSS px after six turns; on a 390×500 screen it keeps a
160 px floor and the section scrolls in normal flow, so the composer never covers it. The step is not
done until the owner accepts it on a phone.

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

### Evidence (Step 4)

- `src/client/follow.ts` is the whole rule set, and it is pure: it takes the scroller's own
  measurement and the follow state and returns the next state. No DOM, no timer and no estimate is
  involved. The bottom distance is `scrollHeight - clientHeight - scrollTop`, clamped at zero, and a
  measurement that is not finite counts as far from the bottom, so a missing layout reading can never
  scroll a reader by accident. `NEAR_BOTTOM_PX` is 8 and the threshold is inclusive. `readerScrolled`
  resumes at the bottom and clears the count, pauses above it with a new empty count, and keeps a
  pause that stays paused. A count changes only when an entry really arrived or the reader resumed: it
  is not a timer, an age or a progress estimate, and nothing decays.
- The count is exact at 99 and bounded one above it: `activityArrived` stores at most 100, so 99 reads
  `99 new activities` and only a larger count reads `99+ new activities`.
- `readerStillFollowing` compares the scroller's live `scrollTop` with the position this page last
  scrolled to. Content that grows below the reader leaves that position unchanged and still follows; a
  position that moved upward is a reader who left the bottom, whether or not the scroll event has
  been delivered yet. `arrivalAfterFrame` applies that check before counting or following, which is
  the race the transcript used to lose.
- Scroll handling names its own scroll and nothing else. This page marks its scroll before it
  performs it, and that one event is ignored. Every other scroll that moved the position up and away
  from the bottom pauses, including a scroll made by a script or by assistive technology: such a
  scroll is never ignored. A scroll event that leaves the position where this page put it is a layout
  change below the reader, not a move by the reader, so it does not pause; the resize observer then
  decides. A browser clamp that lands at the bottom records the new position as the follow position,
  so the next arrival follows instead of counting. The transcript is a scrollable region with
  `role="region"`, an accessible name and `tabindex="0"`, so it is keyboard-reachable.
- No scroll is ever animated: `showNewest` and the entry and resize follows assign `scrollTop`
  directly. There is no smooth scrolling to suppress and no stale animation target.
- New entries follow only while following, and a `ResizeObserver` on the scroller and its content
  covers what the entry count cannot see (keyboard, rotation, decoded image, rewrapped text). That
  observer scrolls only when the live position still says following, so a paused reader is not moved.
- The indicator is not an overlay. The transcript is a wrapper that holds the scroller and, when the
  reader has paused, a control row in normal flow below it: the row takes its own space and the
  scroller simply becomes shorter, so no text is ever covered. The button is at least 44×44 CSS px.
  A live region that exists from the first frame announces either the bounded count or, at zero,
  `Newer activity is below`; the button itself is outside the live region so it is not re-announced.
  Measured at 390×844 with the row shown: scroller 240 px, row 57 px, no intersection, and the centre
  of the scroller hit-tests to a transcript entry.
- The layout is budgeted from the section's measured size, not a device guess: `compact` below 620 px
  wide or 700 px tall. Nothing secondary is deleted; it is disclosed through native `<details>` at
  every width where it would crowd the conversation: the session's agent picker and scope line
  (`Agent & scopes`), the model identity and its state (`Model & provider`), the activity timeline
  (`Activity`, open by default on a roomy screen), and the local draft actions (`Draft tools`).
  `Session details` remains its own toggle and shows the scopes at every width.
- The transcript wrapper has a 160 px floor. When the floor plus the chrome does not fit, the section
  scrolls in normal flow: nothing is docked, sticky or overlaid, and the composer sits after the
  transcript. Measured: 390×844 after six turns gives a 297 px scroller and a section of 736 px with
  nothing to scroll; expanding the activity timeline gives a 160 px wrapper and a 160 px scroller with
  the section at 751 px of content in 736 px, so it scrolls normally; 390×500 gives a 160 px scroller
  in a 392 px section with 599 px of content, the composer below the transcript and reachable by
  scrolling, and a 1440-wide window keeps the full chrome with a 348 px scroller.
- A project or session switch resets the follow state, the seen-entry count and the view: the stream
  identity now includes the project id, so a project change clears the transcript before the new one
  is read, and the initial scroll runs only for the view that has actually rendered. A resize, scroll
  or stream callback queued for the identity just left is dropped by its generation and key.
- `tests/unit/follow.test.ts` (18 tests) drives the threshold boundary, a non-finite measurement, the
  pause/resume transitions, the cap boundary (99 exact, 100 means 99+), the label and indicator text,
  the identity key, the live-position check for content growth versus a reader move, and the frame
  race, including that a paused reader keeps counting.
- `tests/browser/follow.spec.ts` (10 tests at 390×844 and 390×500, scripted provider only) asserts:
  the phone geometry after six turns (a usable scroller, no overlap and a hit test on the transcript);
  that every condensed control is reachable by expansion and that the expanded activity timeline
  keeps the floor without covering the composer; the control's geometry, its reserved row and its
  live announcements; pause and resume with a real wheel gesture; the frame race with the scroll
  event withheld; an admitted send returning to the bottom and a refused send leaving the position;
  a keyboard-short screen scrolling the section in normal flow; a clamp from a layout change
  continuing to follow; a session switch resetting the count; two projects with equal-length
  conversations resetting between them; and a reload showing no phantom count.
- Validation ran with this worktree's own binaries from
  `/Users/john/dev/.archive/pilot-worktrees/integration-b23730b` (package `pilot` 0.1.0, Node
  26.8.1): `./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json` and
  `./node_modules/.bin/tsc --noEmit` (0 errors, 0 warnings), `./node_modules/.bin/vite build` plus
  `./node_modules/.bin/esbuild …` (fresh build before the browser runs),
  `./node_modules/.bin/tsx --test tests/unit/*.test.ts tests/server/*.test.ts` (466 passed) and
  `./node_modules/.bin/playwright test` (59 passed). `tests/browser/activity.spec.ts` gained one step
  that opens the activity disclosure and hides the phone drawer, because the timeline is now a
  disclosure on a phone.
- Honest limits. The count counts transcript entries, so one message with tool calls can add more
  than one, and it is not a message count. The budget reads the section's size, so an unusually tall
  question panel can still shrink the scroller until the 160 px floor engages, after which the section
  scrolls. A scroll the browser itself performs that leaves the position above the bottom (rather than
  clamping it to the end) pauses following; the reader can resume with the control. The floor belongs
  to the wrapper, so the scroller gives up the control row's height while it is shown. Selecting
  another project leaves the agents view (existing application behaviour), so the two-project test
  reopens it; the component also clears the view when its project changes while mounted. Step 5 owns
  the docked composer and the safe-area work.

---

### Step 5 — Mobile Back stack and bottom controls

**Status: Built locally; automated acceptance criteria pass. Real-phone owner acceptance is not claimed.** The browser Back button now closes the newest
drawer, menu, panel, dialog, document or session before it leaves the app, and Forward restores
the entry. The composer and its primary controls remain in normal flow with safe-area padding;
they are not docked over the transcript.

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

### Evidence (Step 5)

- `src/client/navigation.ts` is the whole shared stack and has no framework dependency. A route
  snapshot is `{project, view, doc, session, layers}`. Each entry this module writes carries that
  snapshot, a per-page-load nonce, a serial and `owned`, the layers that entry itself added above
  its predecessor. The nonce and serial together identify an entry this page load wrote. An entry
  with this module's shape is readable, including one from an earlier page load; anything else in
  `history.state` is another page's state and is never applied. The address carries only the route (`?project=`, `?view=`, `?doc=`, `?session=`); the layer keys live
  in history state. `parseRoute` also accepts a document or a session without a view and implies
  `Wiki` or `Agents`, and ignores an unknown view or an unknown query value.
- The application state is still the truth. One Svelte effect reads the route and the open layers
  and calls `sync`, so no individual button writes history. Each added layer gets its own entry,
  one per layer; a removed layer takes its own entry back off with `history.go(-1)` only when the
  nonce and serial under it are the entry this page wrote for that layer. A layer that was folded into an
  entry by a correction has no entry of its own, so closing it rewrites the current entry and
  never walks into another page. A route change first removes the layers above the route, then
  pushes the route entry and then each layer the new route shows, so every layer stays closable.
  The forward stack is kept until a new push truncates it, which is what lets Forward return to
  its own entry after Back.
- A traversal this module asks for names the nonce and serial it expects. Its popstate is
  suppressed only when both arrive; another entry arriving in the window is handled as the
  person's own move. A traversal that never delivers resolves after 500 ms, re-anchors to the shown route and
  does not retry. An entry this page did not write is re-anchored at the current address when the
  path is still the app's own; a cross-document Back is left to the browser. Each person's Back
  and each Forward produces exactly one popstate in the tests; a marker set on the page survives
  every same-document traversal, and the Back/Forward test asserts no non-GET request.
- Layers are the mobile project drawer (below 650 px), the document tree (below 900 px), the
  question inbox, the board-actions and filter menus, the named-session list, board settings,
  import review, add project, providers and models, the agent manager, repository connection and
  the command palette. The project rail and the document tree are layers only at the widths where
  CSS makes them overlays; on a wide screen they stay in flow and toggle as before. The session
  view is part of the route: choosing a session pushes an entry, and Back returns to the previous
  session. The tree is written as its own entry after the Wiki view's entry, so closing the tree
  lands on Wiki rather than on the view before it.
- A direct link is `/?project=<id>&view=Agents&session=<id>` or
  `/?project=<id>&view=Wiki&doc=docs/page.md`. A reload on a session route shows that session,
  because the session is in the address. A session id the project does not have opens the root
  conversation, shows the refusal and opens the named-session list. The fallback list is a layer
  of its own entry: closing it with its own control keeps the app, and a later Back does not leave
  the page. The bad id is removed from the address. A session id outside the server's documented
  shape is rejected before any request and is never echoed into the interface. A project named by
  the address that is not registered shows an explicit error and selects nothing: the remembered
  project is not opened, so no edit can be sent to the wrong project. The sidebar is the explicit
  selection path, and no write request is sent while the error is shown.
- A direct document link writes its requested path in the first entry, before the document read
  runs, by keeping the requested path separate from the loaded document. The read then fills the
  same route without a second entry, so one Back leaves the app. A path the store refuses keeps
  the requested address and shows its error in a `role="alert"` region until the person
  navigates; this is the safe fallback, not a claim that the document exists.
- A narrow screen still replaces `Dependencies` and `Timeline` with `List`, including a direct
  link to either view. The stored view is the fallback only when the address names no view. Boot
  writes one entry in place with `replaceState`; before boot resolves, the project add actions are
  disabled and the workspace shows `Opening Pilot…`, so an interaction cannot race the first
  route into history. A home-screen app gets one guarded entry under the app only in an installed
  standalone display mode. A desktop fullscreen tab is not guarded; `shouldGuardHomeScreen` has a
  unit test for that distinction.
- Unsaved work is guarded on the way out. The document is dirty when a save is pending or when
  the editor's text differs from the last saved text. A Back that changes the document, the
  project or a board view asks first; a refused answer writes the shown route again above the
  entry Back reached, keeps the editor and its text, and does not retry. A board view with
  unapplied task edits and a board save that is pending or conflicted across a project change ask
  too. A push notification runs the same guard before it changes anything: a refusal keeps the
  draft, the route, the URL and the history length, and performs no request. `beforeunload` uses
  the same document test.
- A layer opened while a Back apply is waiting is kept. The apply records the layers that were
  open when it started, and only closes the ones the target names; a new layer survives the
  project or view change and gets its own entry afterwards. A layer closed during the apply is
  subtracted from the entry's layer list, so it stays closed; the reconciliation is symmetric. A
  sync that arrives during an apply is queued instead of being cleared, so its route or layer
  intent is reconciled once the apply finishes.
- Drafts flush on a new `pilot:navigate` event that the stack dispatches before applying an entry,
  and still on `pagehide`, on `visibilitychange` to hidden, on a session identity change and on
  unmount. The route owns the selected session: the shell resolves the remembered session at boot
  and on a project change, `AgentsView` follows that prop, validates a well-formed id against the
  server's list, and writes the person's choice back through the route. Each session's compose
  text is restored after Back, Forward and reload. The named-session list is controlled by the
  route so Back closes it; a session chosen from the list closes the list in the same step that
  changes the route.
- The composer, Send, Steer, Stop and Add image are not docked. They remain in normal flow at the
  end of the session section; Stop moved from the header into the composer row so the primary
  controls are together. `--safe-bottom` is `env(safe-area-inset-bottom, 0px)` and is added as
  padding to the composer, the status bar and the fixed project drawer; `viewport-fit=cover` and
  `interactive-widget=resizes-content` are in `index.html`. At 390×420 with a 24 px simulated
  inset the section scrolls, the transcript keeps its 160 px floor, the composer's computed
  position is `static`, its bottom padding includes the 24 px inset above its own padding, the
  transcript does not intersect it, and Send, Steer, Stop, Add image and `Needs me` are all inside
  the viewport. Step 4's normal-flow and no-overlap rules are unchanged.
- `tests/unit/navigation.test.ts` (15 tests) covers route parsing and URL building, the narrow
  board-view rule, layer prefixes, entry validation and ownership, the standalone-only home guard,
  open/close push and pop, a person's Back and Forward, a route change that removes layers first,
  a refused traversal that rewrites the shown route, `replaceCurrent`, a correction that shows a
  layer (its own entry, then an in-app close stays in the app), an entry with the same serial but a
  different page-load nonce (its route is read and re-anchored, never owned by this load), a
  foreign entry under a layer that is re-anchored rather than walked past, and a traversal
  timeout. The full unit and server suite is 481 passed.
- `tests/browser/backstack.spec.ts` (12 tests, scripted provider only, phone viewports 390×844 and
  390×420) covers: nested Back from a dialog through a document and the Wiki view to List and then
  out of the app to the page it came from, with no write request on the traversals; the Android
  equivalent with `history.back()`, two Forwards and a popstate count that proves no loop and no
  reload; menus, session selection, documents and Forward; a direct session link, reload, a direct
  document link, an unknown session falling back to a list whose in-app close keeps the app, a
  remembered missing session, a 400-character session id that is not echoed, and an unknown
  project that shows an error and selects nothing; a direct document link whose read is delayed
  (one entry, one Back leaves) and a missing document (address kept, alert shown); a pushed alert
  that refuses to discard unsaved document text and leaves route, URL and history unchanged; a
  layer opened during a delayed Back apply that survives; a foreign history entry under a layer
  that is re-anchored on an in-app close and keeps the app; an entry from an earlier page load
  that is readable after a reload, re-anchored, and safe to close a layer over; the keyboard-short
  controls and safe area; each session's draft across Back, Forward and reload; and a dirty
  document that refuses Back and then accepts it.
- Validation ran with this worktree's own binaries from
  `/Users/john/dev/.archive/pilot-worktrees/integration-b23730b` (package `pilot` 0.1.0, Node
  26.8.1): `./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json` and
  `./node_modules/.bin/tsc --noEmit` (0 errors, 0 warnings), `./node_modules/.bin/vite build` plus
  `./node_modules/.bin/esbuild …` (fresh build before the browser runs),
  `./node_modules/.bin/tsx --test tests/unit/*.test.ts tests/server/*.test.ts` (481 passed) and
  `./node_modules/.bin/playwright test` (71 passed).
- Honest limits. Layers are in history state, not the address, so a reload loses an open drawer,
  menu, panel or dialog; only the route is a deep link. Forward reopens a dialog or panel fresh:
  typed dialog values, including an unsubmitted approval form in the command palette, are not
  restored. Closing the palette with Back performs no approval action, exactly as its close button
  does. A refused Back writes the shown route again with `pushState`, so the browser's forward
  entry now points at the same document; that is how the refusal avoids a traversal loop, and a
  second Back asks again. An in-app close walks back only to an entry this page wrote for that
  layer; if another script changed history, the close stops at that entry, rewrites the state and
  address to what the app shows, and does not leave the page. Entries written by an earlier page
  load are applied as routes and re-anchored with this load's nonce before ownership is granted.
  After a reload or foreign-entry re-anchor, one Back can reach an equivalent base route without
  a visible change; a later Back leaves. The home-screen guard is written only in an installed standalone display mode and is not
  exercised by the normal browser suite; its predicate is unit-tested. The controls are reachable
  by scrolling on a short viewport; they are not permanently pinned above the keyboard, because
  docking the composer would cover the transcript that Step 4 protects. The attention entry stays
  in the application bar, which the session section does not scroll. A missing document path
  keeps its address and shows the store's error until the person navigates. An unknown project in
  a link selects nothing until the person chooses a project; that is deliberate, not a fallback.
  The provider select gained an explicit `aria-label="Provider"` so its accessible name does not
  change when its options load; that is an accessibility fix, not a provider-flow change.

---

### Step 6 — Attention: questions, approvals, failures and interrupted runs

**Status: Built locally; automated acceptance criteria pass. Owner acceptance is pending.** One attention surface
now ranks all four kinds, shows the exact open count apart from the capped list, and offers the
explicit actions each kind allows from a phone. The 20-per-page and 100-listed limits are
implemented as **proposed** defaults (`limits.policy: "proposed"`); they are not accepted policy
and changing them remains an owner decision. See [Attention](ATTENTION.md).

**Required work**

- One attention surface and badge, with four explicit kinds: **question**, **approval**,
  **failure** and **interrupted**. Each shows the project, session, age and one line of
  context.
- Questions: answer once, refuse an already-answered question, keep the dismissal reason.
- Approvals: show kind, exact target, scope, expiry and whether it is pending, consumed,
  revoked or expired. Consuming performs nothing by itself; say so.
- Failures: show the provider or run reason, and offer `retry` only for a failed session.
- Interrupted: show the reason and `uncertain`; offer `resume` only where it is safe. For
  uncertainty, offer explicit owner acknowledgement only after the exact original submission is
  terminal, the conversation is idle, Pi Durable has no queued submissions, and Pilot queue entries
  are all `settled` or `cancelled`. Tell the owner to review the conversation and affected files;
  acknowledgement does not undo or replay the effect.
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
- An uncertain interrupted run offers no replay; it offers acknowledgement after verified terminal,
  idle, queue-free proof. The owner sees that the effect is not undone and that review is required.
- Acknowledgement and all attention reads dispatch no model request. Only explicit `resume` or
  `retry` may dispatch, under their existing lifecycle rules.
- Browser tests cover all four kinds and the deep link.

**Risks**

- An attention surface can become a second inbox with stale counts. Mitigation: derive it
  from the same durable records and refresh it with the same connection state.
- A push link can point at a deleted item. Mitigation: the surface reports "no longer
  present" rather than an empty page.

**Evidence (local).**

- `src/shared/attention.ts` is the pure model: the closed four-kind set, the fixed severity order
  (interrupted, failure, approval, question), the total age-then-id order, the keyset cursor, the
  `20` / `100` **proposed** limits, `countAttentionItems` (which counts every open item rather than
  a page and carries `complete`) and the age label. A missing instant is `at: null`: the label is
  `age unknown`, the order puts it after recorded instants, and no epoch age is invented.
  `tests/unit/attention.test.ts` (9 tests) covers severity/age/id ordering with a non-mutating sort,
  equal-key id ties split across two one-item pages, the exact count above the cap, an incomplete
  count, cursor round-trip, a null-instant item that still pages by keyset, a stale cursor whose
  item was resolved, 100 listed out of 107, and refusals for an unreadable cursor or a limit
  outside 1–100.
- The server projection is read-only. `src/server/state/transcript-questions.ts` opens the project
  transcript with a read-only handle (and SQLite's `immutable=1` URI when no writer sidecar exists),
  so reading questions creates no file and cannot checkpoint; it starts no harness, because opening
  one resumes work. It follows Durable's **active** transcript: the newest `head` marker bounds the
  range, and older hidden history is not listed. `ApprovalStore.records()`,
  `SessionLifecycleStore.attention()` and `SessionRegistry.sessionOwners()` add read-only passes over
  the same durable records the existing routes use. `src/server/state/attention.ts` assembles the
  items and never copies an approval nonce.
- `GET /api/projects/:id/attention` returns one page with the exact count, the page state, the
  source states and `limits.policy`. `GET /api/projects/:id/attention/count` is the separate count
  query the badge uses. Both are `GET` only; another method is `405`.
- `tests/server/attention.test.ts` (11 tests) covers: 105 approvals reported exactly while only 100
  are listed, 20 per page, a deterministic order and a `complete` count; exact project isolation for
  project-scoped and session-scoped approvals, with an operation-only approval attributed to
  neither; two projects that both hold legacy session `1`, where a session-only approval is
  attributed to neither, while a unique UUID session is attributed only to its own project and a
  foreign project's consume is refused; an open question that leaves after an answer and a dismissed
  question whose reason stays in the transcript; a failed session offering `retry`, an uncertain
  interruption offering acknowledgement but no replay action and refusing `resume` with operator
  attention; a fresh
  process reading attention twice with the transcript and its sidecars byte-identical; a stale cursor
  after a consumption; an unreadable transcript reported as `unavailable` with `complete: false`
  rather than as no questions; a synthetic transcript whose head marker hides an older question and
  whose active question has no `askedAt`; a failed registry owner lookup that marks approvals
  unavailable and attributes nothing; and `422` for an invalid cursor or limit.
- A session-only approval is attributed only when the registry proves exactly one owner and that
  owner is the requested project. A project scope, when present, is authoritative. Legacy session
  ids are unchanged: `1` still exists in every project, which is exactly why it proves nothing.
- `tests/browser/attention.spec.ts` (4 tests, 390×844) covers all four kinds in severity order with
  the exact `4 open` count, only `GET` requests while the panel opens, no approval nonce or path in
  the panel, the uncertain item's review prompt and no `Resume`, successful explicit acknowledgement after terminal, idle, queue-free proof, the full exact approval target before an explicit consumption (which says it performs nothing), `Retry`
  for a failure, opening the exact question, Back closing the layer and staying in the app, a
  push-style `&attention=question:<id>` deep link, a 25-approval project paging 20 then 25 with the
  count unchanged and the proposed-defaults note, an unreadable transcript that makes the badge say
  `count incomplete` instead of an exact zero, and a service-worker alert switch to another project
  while the first project's attention response is held: the panel remounts for the new project and
  the released response adds no old target and no approval action. The browser server publishes its disposable data
  root through one random, exclusively created `0600` marker in the ignored `test-results`
  directory; the test discovers it by name and refuses a symlink, a non-file or a non-private file.
  There is no fixed shared path and no production debug route. A runner-side global teardown
  removes the marker and the disposable data root after every test outcome, because the web server
  can be stopped with a signal it cannot catch. An unclean runner kill can still leave both in the
  system temp folder and the ignored output directory, with no credentials in either.
- The panel is keyed by project and also carries a request generation. A project change clears
  items, page, count, sources, review and the missing-item notice at once. Every list, paging and
  action response from the previous generation is discarded, so a delayed response cannot show one
  project's target or consume action under another project.
- The notification link now names the project, the exact session and the exact item for a question,
  and the exact session and failure item for an agent failure; a finished run keeps its project and
  session link. The payload still carries no approval target, path or token.
- Query cost is not cached: each list request builds the projection once (one transcript read, one
  approval pass, one lifecycle pass, one registry lookup per session-only approval); paging rebuilds
  it from durable records so a status change is not hidden by a stale snapshot; the panel uses the
  count its list response already carries, so opening the panel is one projection, and the separate
  count route is for the badge. The registry lookup is a read-only scan by session id, not an
  indexed point read, and the transcript query scans the conversation's entries. No new authority
  or index is added.
- Validation ran with this worktree's own binaries: `./node_modules/.bin/tsc --noEmit` and
  `./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json` (0 errors, 0 warnings), `vite build`
  plus the `esbuild` server bundle, `tsx --test tests/unit/*.test.ts tests/server/*.test.ts`
  (501 passed) and `playwright test` (75 passed).
- Honest limits are listed in [Attention](ATTENTION.md): the transcript read depends on the durable
  SQLite layout and reports `unavailable` rather than guessing; an approval scoped only to an
  operation is not attributable to a project and stays out of that project's list; a session-only
  approval with an ambiguous id such as legacy `1` is not attributed at all; question state is per
  conversation, so a fork child is not merged into its parent; the transcript reader follows the
  active head but does not apply context edits (the harness edits no question entry); a root-session
  question deep link may omit `session` because the root conversation is the default; the panel
  refreshes when it opens and after an action rather than by a background poll; and the action
  surface itself still awaits owner acceptance.

---

### Step 7 — `record_note` cancellation audit (delayed)

**Status: Built locally; automated acceptance criteria pass. Owner acceptance is pending.** `record_note` remains
`replay: 'unsafe'`. Its wait now observes the tool's abort signal, every side effect is guarded by
a signal check, and an abort before the append writes nothing. A cancel after the append is
reported as an uncertain abort and never as a rollback. A resume whose original identity is
already terminal reports `terminal`/`dispatched:false` with a no-additional-work reason and settles
the lifecycle; it never restarts the cancelled work. The model-visible `delayMs` is gone; the
deterministic delays are host-only test seams.

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

**Evidence (local).**

- `src/server/agents/abortable.ts` is the one wait used by the tool (and by the scripted `[pause]`
  response). It rejects with the signal's own reason, clears its timer and abort listener on both
  paths, and rejects without waiting when the signal is already aborted. A 60-second wait that is
  aborted leaves no `Timeout` resource behind; `tests/unit/abortable.test.ts` (3 tests) asserts the
  resolve path, the reason and timer cleanup, and the already-aborted and non-positive cases.
- `record_note` (`src/server/agents/harness-host.ts`) declares only `text` (1–400 characters) and
  keeps `safePath` containment. Its `execute` checks `context.abortSignal` immediately before the
  wait, after the wait, after resolving the contained path, and immediately before `appendFile`.
  An abort in the wait or at the check before `mkdir` returns before any filesystem change; an abort
  at the final check returns before the append.
- **The delay is no longer model-visible.** `delayMs` was removed from the tool's schema and from
  the scripted provider's call. Two host-only seams replace it: `recordNoteDelayMs` opens the
  pre-write window and `recordNoteAfterWriteMs` opens the post-append window
  (`HarnessHostOptions`, wired through `AppOptions` in `src/server/main.ts`); the real-server crash
  test sets `DASHBOARD_AGENT_NOTE_DELAY_MS`. No model, provider or HTTP request can select either
  value, and production wiring leaves them unset or zero.
- **The append is the commit point.** After it, a cancellation is not a rollback: the line stays,
  the transcript result is `aborted`/`interrupted` (the activity model already treats that as
  uncertain), and the call does not claim the line was removed. A cancellation the tool observes
  never returns `Recorded:`. The remaining unsafe window is between the last check and the start of
  `appendFile`: a cancellation or crash there can still append. That is reported as an interrupted,
  uncertain call and is never replayed automatically because the tool is `replay: 'unsafe'`.
- **No duplicate input on resume, and no false dispatch.** `HarnessHost.submit` normalizes an
  empty or absent request id to one generated identity, refuses a malformed non-empty id before
  admission, and records the exact identity in the lifecycle. A `pause` followed by `resume`
  therefore finds the existing submission instead of appending a second user input, which is what
  could otherwise make the model repeat a non-idempotent tool call. If that identity is already
  terminal, the resume response is `outcome: "terminal"`, `dispatched: false` and a fixed
  no-additional-work reason, and the lifecycle settles to `idle` or its existing `failed`; if other
  work in the same conversation is genuinely running, it leaves that running state alone instead of
  writing a false `idle`. It never mints a fresh identity or restarts the cancelled effect. Fresh
  work needs a new message, or the explicit `retry` action for a failed session. This adds no
  authority and no new route.
- Cancel scope is unchanged: `stop` and `pause` cancel only an open harness and only the selected
  conversation; they dispatch no model request. The lock, delivery, approval and replay rules are
  untouched. Startup adoption, the stale-lock refusal and the uncertain-interruption refusal keep
  their existing behaviour.
- Two host-only test seams open the cancellation windows deterministically: `recordNoteDelayMs`
  and `recordNoteAfterWriteMs`. `recordNoteStarted` fires from inside `execute` before the pre-write
  wait, so a test can abort after execution entered the wait rather than merely after the call was
  admitted. The environment delay requires `DASHBOARD_AGENT_TEST_SEAMS=on`; the value must be a
  whole number from 0 to 60000, is validated before the data root is touched, and a bad value fails
  startup. No model, provider, tool argument or HTTP request can set either seam.
- `tests/server/record-note-cancellation.test.ts` (10 tests) covers: a cancel before the write
  creates no `docs/notes.md`, settles in under 2 seconds with one aborted result and one input; a
  cancel after the append keeps the line exactly once and reports an uncertain abort without a
  success claim; `stop` and `pause`/`resume` affect the named session only, the resume response is
  terminal/idle with no dispatch, and resume adds no tool call, input or note; a graceful close
  during the wait writes nothing and the next start reports `interrupted` with no replay; a stream
  disconnect calls no abort and produces one note, one input and one call; an empty request id is
  normalized and a malformed one is refused before admission; a duplicate identity while the first
  run is open is admitted once; a refused busy admission writes no input and starts no run; a
  symlinked `docs/` directory is refused with no outside write; and the delay seam's bound and
  explicit test switch are enforced.
- `tests/server/session-lifecycle.test.ts` adds three service-level terminal outcomes: a resume
  whose port resolves a terminal identity returns `outcome: "terminal"`, `dispatched: false`, the
  settled `idle` record and the unchanged original identity, never a false `running`; a terminal
  resume that reports other work still running leaves the record `running` instead of writing a
  false `idle`; and a settle that loses a compare-and-swap to a concurrent pause or watcher settle
  returns that winner unchanged, without a `500` or an overwrite. The authorising write before the
  port still refuses a stale initial revision with `409`.
- `tests/server/entrypoint.test.ts` starts the real bundle with an invalid test-only note delay and
  proves the start refuses before the data root is created: once without
  `DASHBOARD_AGENT_TEST_SEAMS=on`, and once with an out-of-range value. `createApp` runs the same
  shared validator, so a direct caller cannot bypass the bound.
- `tests/server/recovery.test.ts` keeps the real child-process crash: the server is spawned from
  the real bundle, SIGKILLed while `record_note` holds its execute checkpoint, refused a restart
  while `service.lock` remains, and restarted after the deliberate lock removal. The next start
  reports `interrupted`/`may have partially run`, no note exists, the input appears once, and a
  replay of the same request id adds nothing. The test now sets the delay with
  `DASHBOARD_AGENT_TEST_SEAMS=on` and `DASHBOARD_AGENT_NOTE_DELAY_MS=5000`. The delay boundary and
  the "between delay and append" boundary are the same durable `execute` checkpoint: both are
  before the append and both recover as interrupted, never repeated.
- Validation ran with this worktree's own binaries from
  `/Users/john/dev/.archive/pilot-worktrees/integration-b23730b` (package `pilot` 0.1.0, Node
  26.8.1): `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/svelte-check --tsconfig
  ./tsconfig.json` (0 errors, 0 warnings), `./node_modules/.bin/vite build` plus
  `./node_modules/.bin/esbuild src/server/main.ts --bundle --platform=node --format=esm
  --packages=external --outfile=dist/server.mjs`, and
  `./node_modules/.bin/tsx --test tests/unit/*.test.ts tests/server/*.test.ts` (518 passed, including
  the new cancellation, resume and abortable-wait tests). The standalone
  `./node_modules/.bin/tsx --test tests/server/recovery.test.ts` passed separately (1 test). No
  commit, push, deployment, install or live-data use.

**Remaining crash and cancellation windows (honest limits).**

- A cancellation that lands during `mkdir` can leave an empty `docs/` directory. It cannot create
  the notes file, and the call is reported as cancelled.
- Between the last `throwIfAborted()` and `appendFile` entering the filesystem, cancellation or a
  SIGKILL can still append. The call recovers as `interrupted` (unsafe, uncertain) and is never
  replayed automatically. An operator may need to read `docs/notes.md` to decide whether the line
  landed.
- A crash during `appendFile` can leave a complete or partial line. The same interrupted/uncertain
  rule applies; this build does not add a write-ahead journal, a temporary file swap or an
  automatic reconciliation of note text.
- **A reported post-append replay in Step 10 was a test fault, not a harness window.** The first
  version of that test did not wait for the append (`false` is not `undefined`), so the kill could
  precede it and the restart performed the only append. The corrected test waits for the append,
  kills immediately, and observes `interrupted` and one line. The report is withdrawn; see Step 10's
  *Evidence*.
- SIGKILL still leaves `service.lock`, so the next start fails closed until an operator clears it.
  The test deliberately proves that refusal rather than weakening it.
- A cancellation that lands after the tool's final check but before the harness settles is a race:
  the append may already be committed, so the call may return `Recorded:` or be reported aborted.
  Either way the line is not removed and no rollback is claimed; the owner may need to read
  `docs/notes.md` to know whether it landed.
- The two delay seams are host configuration options. They are not reachable from a model, a
  provider, a tool argument or an HTTP request. The environment variable requires
  `DASHBOARD_AGENT_TEST_SEAMS=on`; setting it on a real deployment would only make every note write
  slower, and an ordinary deployment cannot enable it with one variable.
- A terminal resume writes the authorised `running` revision before it reads the submission
  status, because that write is the serialisation point that stops two racers from dispatching. The
  response and later reads are settled, except when other work is genuinely running: then the record
  stays `running` for that work under the retained terminal identity, and the action reports
  `terminal`/`dispatched:false` without claiming it. The action creates no new attempt and no fresh
  identity. A crash after that write but before the port resolves the identity leaves a `running`
  record that the next start adopts as an uncertain interruption, even though the resume started no
  new work; nothing is replayed automatically. Removing the transient revision would need a terminal
  check before the serialisation point, which would open the harness before the durable write.
- The post-append transcript is the harness's own surface. An aborted `record_note` result says
  only that the call was aborted; it cannot name whether the append landed without changing the
  Durable tool-result protocol. The activity projection marks it uncertain, and the operator must
  read `docs/notes.md` to decide. This build does not add a custom transcript entry for it.

**Risks**

- An append is not idempotent. Mitigation: the unsafe-replay rule and the cancel/crash/restart
  tests above; there is still no automatic retry and no claim that a crash preserved exactly-once
  execution.

---

### Step 8 — Owner-configured models: orchestrator and workers

**Status: Partial — owner worker model policy configured, and enforced for the Step 9 W1
workers.** A model can be chosen per instance, per agent and per conversation. The owner sets an
allowed worker model set and an optional default worker model in the durable control store, and
Step 9's W1 slice now pins and re-checks it at worker creation and run admission (see
[Workers](WORKERS.md)). The existing global default, per-session model and per-agent model remain
the orchestrator controls; this step adds no allowed-orchestrator setting that would look
functional but have no effect. Owner acceptance of the combined step is not claimed.

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

- W1 worker **execution** exists, in the application harness only, for an owner-created worker
  with no queue. The queue still holds no per-worker model, and the runner executes no model at
  all: its jobs are bounded tool execution.
- The owner-defined allowed set and optional default worker model are enforced when W1 creates a
  worker and admits a run: the model is pinned with no fallback and re-checked before dispatch.
  An agent still has one model of its own, not a policy list.
- The pinned worker model never changes the orchestrator. A worker run is a separate conversation
  with its own model; the session model setter refuses a worker conversation.
- Cost is shown per conversation, not per worker run or per tool.
- A queued input has no recorded model. A model change while work is queued changes what
  the queued work runs under, without saying so.
- Unavailable and authentication errors are clear text but not a stable state the UI can
  rank in the attention surface.

**Required work**

- Add an owner-only **worker model policy**: the allowed worker models and an optional default
  worker model. Validate every entry against this instance's offered models. Keep the existing
  global default, per-session model and per-agent model as the orchestrator controls; do not add
  a second orchestrator setting that nothing uses. Worker assignment and enforcement belong to
  Step 9.
- Keep the worker policy separate from the existing orchestrator choices in the interface and
  in the API. Do not derive one from the other. Neither changes what runs in the runner.
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

- The owner can set an allowed worker set and an optional default worker model, and cannot
  save a new model this instance does not offer. The existing orchestrator choices remain
  unchanged.
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

**Evidence (local).**

- `src/shared/model-policy.ts` is the pure record and validation: `allowedWorkerModels` and
  `defaultWorkerModel` only, canonical model order, no duplicates, a new model must be in the
  offered catalog, and a default must be a member of its allowed set. A saved model that later
  leaves the catalog is preserved so it can be inspected and removed; a new unknown model is
  refused. Removing the default from the set without clearing it is refused. No value is cleared
  or replaced silently.
- `src/server/state/model-policy-store.ts` stores the policy in the existing control store as
  one operation per revision. The reserved settings bucket is `projectId='settings'`,
  `sessionId='worker-policy'`, which cannot collide with a real project UUID. Operation kind and
  outbox kind are `settings.worker-model-policy`; the idempotency key is
  `worker-model-policy.r<revision>`; the outbox row is the audit evidence. The control schema
  still has exactly `control_schema`, `operations` and `outboxes`; no table or database was added.
  A stale revision is `409` and writes nothing. The store's own unique index is the CAS.
- `src/server/main.ts` exposes owner-only `GET /api/settings/model-policy` and
  `POST /api/settings/model-policy`. The route derives the owner actor from the authenticated
  session; it accepts no actor in the body. The unchanged Host, owner authentication and
  origin/CSRF checks apply. `GET` reads the credential store and bundled catalog only; it makes
  no provider call. The route never opens the harness and never dispatches a model. A policy
  `CORRUPT` or `STORAGE` failure is `500` for both `GET` and `POST`; any other view failure,
  including a corrupt provider settings file, is also a sanitized `500`. The response carries one
  fixed, path-free sentence and the internal detail is logged only on the server. A readback
  failure after a successful write returns an explicitly ambiguous `500` with the shared machine
  code `WORKER_MODEL_POLICY_READBACK_UNCERTAIN`. The detail of the stored policy is not returned.
- `src/client/ProviderSettings.svelte` shows the existing new-session default and states that an
  existing session or a bound agent may use a different model. The worker policy is separate and
  reserved for future owner-created workers. It states that no worker runs exist in this build
  and that no worker cost is reported. A saved model from an unconnected provider is marked
  unavailable and can be removed. The credential flag is `credentialSaved`, not a health check:
  the interface states that no provider probe is made. Removing the default from the allowed set
  shows the refusal; the owner must clear it explicitly. A stale save preserves the draft and the
  message. The owner can review the latest revision without replacing the draft. The review shows
  the current revision and the difference between the server choices and the draft. Only the
  explicit `Use latest revision and save my choices` confirmation moves the CAS base and saves the
  draft over the newer choices. `Keep my draft` dismisses the choice; a reload discards the draft.
  An uncertain write keeps the draft in the same way, and the UI reads the shared machine code,
  never the English message.
- `tests/unit/model-policy.test.ts` (8 tests), `tests/server/model-policy-store.test.ts`
  (8 tests), `tests/server/model-policy-http.test.ts` (6 tests) and
  `tests/browser/model-policy.spec.ts` (6 tests) cover: separate choices, catalog validation,
  duplicate refusal, default removal refusal and explicit clear, stale CAS (a sequential check),
  a two-connection admission conflict at the store's unique index (no true concurrent interleave
  is claimed), a tampered idempotency key or operation state as corruption, owner-only write, no
  client actor, unavailable saved entry preservation and removal, no new table, unchanged global
  default/agent/session choices during a policy write, a running generation unchanged, a two-tab
  stale save that preserves the draft, an explicit review of the latest revision, the explicit
  `Use latest revision and save my choices` confirmation that saves over the newer choices, a
  third-writer race that conflicts again and preserves the draft, a deliberate reload that
  discards the draft, an uncertain write that preserves it, a `500` without the machine code that
  is not treated as uncertain, a phone layout with no horizontal overflow, generic `500` storage
  failures including corrupt provider settings, an explicitly ambiguous `500` with the shared
  machine code when a successful write cannot be read back, the accurate harness-off reason for a
  saved scripted model, and no worker creation route. No provider is called and no worker runs.
- Local validation in this worktree: `./node_modules/.bin/tsc --noEmit`,
  `./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json` (0 errors, 0 warnings),
  `./node_modules/.bin/vite build` plus `./node_modules/.bin/esbuild src/server/main.ts
  --bundle --platform=node --format=esm --packages=external --outfile=dist/server.mjs`,
  `./node_modules/.bin/tsx --test tests/unit/*.test.ts tests/server/*.test.ts` (540 passed),
  and `./node_modules/.bin/playwright test tests/browser/settings.spec.ts
  tests/browser/agent-manager.spec.ts tests/browser/model-policy.spec.ts` (9 passed). No install,
  remote call, live-data use, commit, push or deployment.
- Still open in this step: the wider Step 9 execution scope (a queue, agent-requested bounded
  work, and owner acceptance of reports), per-worker cost reporting, and a queued input's model.
  The W1 worker record and dispatch path are built; see [Workers](WORKERS.md).

---

### Step 9 — Bounded, owner-created workers (worker model enforcement lives here)

**Status: Partial — W1 accepted as Stop-only at local commit `80b1bea`; the rest of Step 9 is not
built.** The owner accepted the W1 slice in this worktree at local commit `80b1bea`, limited to
**Stop only**: owner-created workers, a pinned model from the Step 8 policy with no fallback, fixed
budgets (3 live workers per project, 1 active run per project, 8 model turns, 4096 output tokens
per turn), owner-only routes, a minimal phone interface, cooperative revocation and stop, a durable
fenced project lease, startup recovery that never replays, and canonical Markdown reports at
`docs/workers/<workerId>/<runId>.md`. Model turns run in the application's Pi Durable harness; the
runner is unchanged. There is no queue, no coding job, no job request, no auto-accept and no
agent-created worker. See [Workers](WORKERS.md) for the exact contract.

The owner also approved proceeding with **tests and hardening only**; this approval adds no new
worker feature. It does **not** claim acceptance on a real phone or through a tunnel, and it is
**not** the whole of Step 9. The remaining scope is stated under *Still open in W1* below.

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

**W1 evidence (local).**

- `src/shared/workers.ts` is the pure record, scope and report model. The worker scope set is
  `record_note` and `read_notes`, each checked against the shared `scopeToolIsInstalled` rule.
  `ask_question` is refused with its own explanation: a worker question has no bounded answer
  path in W1. The worker model is pinned from `allowedWorkerModels` or the policy default; a
  missing policy, an empty set, no default or a model outside the set each refuse with no
  fallback. Budgets are fixed, turns are recorded as measured (never clamped), and the report
  composition is deterministic and marked as untrusted evidence.
- `src/server/workers/worker-store.ts` stores every worker, run, durable conversation binding and
  project lease as one operation per revision in the existing `operations`/`outboxes` tables, in
  the exact project scope and the reserved `workers` session bucket. No table or database was
  added. The lease is durable and fenced; one unique index admits one holder even across two
  store connections. The conversation binding is written before any submit and is the durable
  authority after a restart. Revocation is a revision-checked write, admission is serialised with
  it in the one owning process, and the dispatch path re-checks the worker, policy and model
  immediately before the submission.
- `src/server/agents/harness-host.ts` adds the one worker execution path. The worker role is a
  static extension installed once in the project registry and selected by every conversation; its
  durable `pilot.worker` marker is written in the conversation-creation transaction. No dynamic,
  unregistered extension carries the role. The run is registered for cancellation before the
  conversation is awaited, the abort signal is propagated, and the run/worker/policy/model are
  rechecked before the one submit. At the provider boundary the ninth request is refused before
  the provider call for every provider, the 4096-token limit applies to every provider, and every
  request revalidates the run, worker, policy, model and revocation. Every generic path refuses a
  worker conversation, live and after a restart, using the control binding and the harness marker:
  view, event stream, model setter, input, abort, answer, dismiss, media, session binding,
  lifecycle, queue, fork selection, `hasSession`, conversation creation and adoption. The
  lifecycle/queue/stream routes check before sending their normal response.
- `src/server/workers/report.ts` writes the canonical Markdown through the contained-path helper,
  refuses a symlink or a non-regular file at any component, writes a temporary file and links it
  into place without replacing an existing file. Existing report reads are bounded: a directory,
  symlink or oversize file is refused without reading it. Identical content is idempotent;
  different content is `REPORT_CONFLICT`. Startup settles a running run `completed` from a valid
  existing report, or `interrupted` otherwise, and reports a changed finished report without
  rewriting it. Report content is never stored in SQLite: the run record holds the path, SHA-256
  and byte size only. Only report tracking can be rebuilt from Markdown; worker records, runs,
  leases and bindings are not file-backed.
- `src/server/main.ts` exposes owner-only `GET/POST /api/projects/:id/workers`,
  `POST /api/projects/:id/workers/:workerId/revoke`,
  `POST /api/projects/:id/workers/:workerId/runs`,
  `GET /api/projects/:id/workers/runs/:runId`,
  `POST /api/projects/:id/workers/runs/:runId/stop`, and explicit `pause`/`resume` refusals. The
  actor is derived from the authenticated session. The routes refuse `503` when the control store
  or harness is off. No cross-key transaction is claimed.
- `src/client/WorkersPanel.svelte` is the minimal phone surface: create, run, stop, revoke, read
  the report path and the fixed limits. It is not the enforcement point.
- Tests: `tests/unit/workers.test.ts` (7), `tests/server/workers-store.test.ts` (19),
  `tests/server/workers-http.test.ts` (8) and `tests/browser/workers.spec.ts` (2). They cover
  owner/agent refusal, policy pin/default/mismatch/unavailable zero-submission, the live ceiling
  (including two simultaneous creations for the last slot), duplicate name, concurrent admission,
  a revocation that races a new run, revocation during a run, cancel before and after the effect,
  a cancel inside the open window with zero provider requests, the ninth request refused at the
  real provider boundary with eight measured calls, an offered tool denied by the static guard
  with no write, a revocation after the first request with no further provider call, the
  4096-token synthetic-provider boundary, measured (unclamped) turns, durable conversation
  binding across restart, every generic route refusing a worker alias live and after restart, a
  conversation created before a failed binding refusing adoption after restart, crash restart
  with report-header reconciliation, a manual or foreign report refused as completion, a
  symlinked report rejected, an existing report path read only as a bounded regular file, a
  changed report as an owner-visible integrity warning, cross-instance lease admission, report canonicality, tamper, project isolation, no report content in SQLite, the
  harness-off `503`, the unsupported `ask_question` refusal, the explicit `pause`/`resume`
  refusal, the phone layout and a hostile report that stays inert in the document view.
- Local validation in this worktree: `./node_modules/.bin/tsc --noEmit`,
  `./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json` (0 errors, 0 warnings),
  `./node_modules/.bin/vite build` plus the `esbuild` server bundle,
  `./node_modules/.bin/tsx --test tests/unit/*.test.ts tests/server/*.test.ts` (574 passed), and
  the two worker browser scenarios (phone flow and hostile report). No install, live provider,
  remote call, commit, push or deployment.

**Still open in W1 (not claimed).**

- There is no queue and no owner-supplied task text: a run reviews what its installed tools can
  observe and writes a report. A worker cannot resume after an interruption; the owner starts a new
  run.
- Pause and resume are not implemented. Stop is terminal. A resumable pause would need a semantic
  redesign of the run record and submission identity; that is deferred for owner acceptance.
- The worker ceiling counts live workers; revoked records remain as history. Report content is
  evidence only, and no route accepts it.
- The single-active-run guarantee rests on the durable lease plus serialisation in the one process
  that owns the data root, exactly like the named-session name rule. The control schema has no
  cross-key transaction.
- Worker conversations have no retention or deletion path; they stay in the agent session SQLite
  as durable working state. A crash can leave an orphan `.md.<uuid>.tmp` report file; it is never
  served or renamed, and no automatic external delete is performed.
- Step 9's wider scope — agent-requested work that is still bounded, a coding/job path in the
  contained runner, and owner acceptance of reports — is not built and is not approved here.

**Risks**

- A worker is an execution surface. Mitigation: keep the existing containment and authority
  checks, add no shell and add no agent-created worker.

---

### Step 10 — Disconnect, cancel and crash tests

**Status: Automated local acceptance criteria pass; owner acceptance is pending.** The disconnect,
cancel and crash matrices have test evidence for visible states and durable records. Uncertain-recovery
cases cover a safe-tool execute checkpoint, SIGKILL recovery, input blocking and verified owner
acknowledgement. At baseline `df2e1fe`, the full unit/server batch passed 586 tests, and the browser
suite passed 85 tests in 2 shards (49 and 36). These results do not claim real-phone or tunnel
acceptance. No live-provider or production acceptance is claimed.

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

**Evidence (local).**

- **Disconnect matrix.** `tests/browser/reconnect.spec.ts` keeps the existing drop, `401`, slow
  first snapshot and session-switch cases, and adds two: a reload while the network is down shows
  `server-error`, sends only `GET`, and recovers through the owner's **Reconnect** to one live
  view with no message; two tabs keep exactly one stream request each, one send reaches both
  transcripts once with zero input requests from the second tab, and closing one leaves the other
  live with no second subscription. `tests/unit/stream.test.ts` adds a network-failure case: every
  attempt is a `GET`, the client stops after the initial attempt plus `maxAttempts` retries,
  reports `offline` with the bounded-attempt sentence, and no snapshot is invented. The bounded
  backoff, stable-budget reset and late-generation cases stay in the existing stream tests.
  `tests/server/agents.test.ts` adds the server half: two live streams create two subscriptions,
  closing one disposes exactly one, the survivor receives a new frame with no extra subscription,
  and the transcript holds one input. The existing no-dispatch and late-subscription-disposal
  tests still cover the reconnect path.
- **Cancel matrix.** `tests/browser/agents.spec.ts` still covers the visible side of Stop during a
  working run with a queued steer. `tests/server/record-note-cancellation.test.ts` keeps the
  before-write, after-append, named-session pause/stop and stream-disconnect cases, and adds a
  queued-input case: a follow-up sent while a run works is visible in the inbox and is not a transcript entry;
  the interface's `Stop` route withdraws it, dispatches no further model request, writes no note,
  settles the lifecycle to `idle`, and a closed-and-reopened process still holds one input, an
  empty inbox and `idle`. The existing worker tests already prove Stop is the only supported
  outcome: stop before the effect writes nothing, stop after keeps the report, a second stop is
  `terminal`/`unchanged`, and `pause`/`resume` are `409` with nothing written.
- **Crash matrix.** `tests/server/recovery.test.ts` keeps the real SIGKILL mid-tool test and adds
  two on the same disposable-root, same-bundle harness. The mid-tool case now waits read-only for
  the tool's durable `execute` checkpoint before the kill, so the pre-write window is deterministic:
  - a kill immediately after the append, with no checkpoint wait and no sleep (the pre-write
    checkpoint wait is deliberately not used here). The next start
    refuses the retained lock until it is deliberately removed, adopts the named session as
    `interrupted`/`uncertain` with its reason and identity, refuses `resume` with operator
    attention, reports the tool `interrupted`, and leaves exactly one line. The test's wait uses
    `true`/`undefined`; an earlier version used `false`, which the helper treated as a result, so a
    kill could land before the append and the restarted process performed the only append. That
    looked like a replay but was one execution. The corrected test passed 11 isolated runs and the
    full suites, with one line and `interrupted` every time.
  - a kill between a queue claim and its submission. The restart keeps one `claimed` entry with
    the same stable request identity, records `idle` (no false `running`), dispatches nothing, and
    reconciliation reports `attention`/`submission-not-readable`, then refreshes the same named
    reason. A failed entry is never re-sent.
- **Waiting helpers.** Every test waiting helper now skips a `false` result, so a condition that
  returns `false` keeps waiting instead of ending at once. This is the fault that produced the
  withdrawn replay report.
- **Seam.** `DASHBOARD_AGENT_NOTE_AFTER_WRITE_MS` joins the existing pre-write seam in
  `src/server/agent-test-seams.ts`. Both need `DASHBOARD_AGENT_TEST_SEAMS=on`, are whole
  milliseconds from 0 to 60000, are validated by the entrypoint before the data root is touched
  and again by `createApp`, and are unreachable from a model, provider, tool argument or HTTP
  request. An ordinary deployment leaves them unset. `tests/server/entrypoint.test.ts` proves the
  post-append value refuses a start before the data root exists, both without the test switch and
  out of range.
- **Correction to an earlier report in this worktree.** An unsafe-append replay was reported here
  after a run returned `Recorded:` from the restarted process. That run came from a test wait that
  did not wait: its condition returned `false`, and `false` is not `undefined`, so the helper
  returned immediately and the kill could precede the append. The restarted process then performed
  the only append. The test helpers now skip `false`. The report is withdrawn: no duplicate append
  and no unsafe replay was observed with the corrected condition, and `record_note` remains
  `replay: 'unsafe'`.
- **Recovery gates and actual harness order.** Pi Durable commits a tool call's intent before
  `execute()` runs. `tests/server/uncertain-recovery-gates.test.ts` (3 integration tests) covers
  blocked uncertain admission, SIGKILL after an unsafe append with zero recovery provider calls,
  and SIGKILL at a registered safe `read_notes` execute checkpoint with zero execute-body calls.
  The checkpoint case uses the typed `createApp`-only `readNotesSeam` to observe and delay the real
  safe tool body; `createApp` validates the delay before catalog initialization. Recovery can
  journal and terminalize blocked scheduler work without a model request. These process-kill tests
  do not simulate power loss, and this build makes no exactly-once claim for power loss or torn writes.
- **Uncertain work gate and owner acknowledgement.** Uncertain named and root lifecycle state blocks
  model requests and tool execution. Recovery can journal and terminalize the blocked scheduler task
  without a provider call. A cold acknowledgement check does not open the harness: the owner must
  open the interrupted conversation in Agents and wait until it is idle. The dedicated owner action
  also requires an empty Pi Durable queue and Pilot queue entries only in `settled` or `cancelled`
  states; queued/failed entries need owner resolution, claimed entries need release then cancel, and
  submitted entries need reconciliation. It verifies the original identity is terminal and writes an audited
  lifecycle acknowledgement. It retains the original request identity and unsafe intent, and never
  replays or undoes the effect. These tests do not prove exactly-once behavior under power loss,
  torn writes or other filesystem failures. The owner has not accepted this workflow on a real phone. Automated phone-sized browser tests do not establish real-device acceptance.
- `readFile`/`appendFile` cannot be interrupted deterministically inside `write(2)`, so "mid-write"
  is the post-append, pre-settle window, not a claim about a torn write.
- Fresh local validation: the exact worktree-local TypeScript and Svelte checks pass (0 errors,
  0 warnings); Vite and the server bundle build successfully. The full unit/server batch passes
  **586 tests** and exits normally. All **85 Playwright tests** pass against the fresh build in
  two sequential shards (`--shard=1/2`: 49; `--shard=2/2`: 36). A fresh unsharded browser run hit
  its 120-second bound after 48 passing cases; its leftover disposable test server was terminated,
  and that incomplete run is not passing evidence. Earlier unit/server runs hit their bounded
  timeout while the recovery integration and worker-extension wiring were incomplete; they are
  not passing evidence. The corrected full unit/server batch exits in about 20 seconds. Automated phone-sized scenarios do not claim owner phone or
  tunnel acceptance. No install, live provider, real project, remote call, push or deployment
  was made.

**Risks**

- A crash between the append and the process's own observation of it cannot be reproduced by an
  outside test with absolute precision; the test asserts the documented post-append condition and
  the durable `interrupted` result. The guarantee is for process death (SIGKILL), not power loss.
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
  `tests/server/record-note-cancellation.test.ts`, `tests/unit/stream.test.ts`,
  `tests/browser/reconnect.spec.ts`, `tests/browser/session-ux.spec.ts`,
  `tests/browser/agents.spec.ts` — current coverage, including the Step 10 matrices.

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

Statuses below distinguish local implementation and automated evidence from acceptance by the
owner on a real phone. A browser viewport sized like a phone is not a real phone. No status here
claims tunnel, production or live-provider acceptance.

| Step | Status at `df2e1fe` |
|---|---|
| 1 Reliable reconnect and honest states | Partial — reconnect core built locally and tested. Transcript-row cap remains. Evidence-based polling fallback is deferred until there is tunnel evidence or an owner decision; local loopback uses streams. Owner acceptance pending. |
| 2 Per-session drafts and attachments | Built locally; automated criteria tested. Owner acceptance pending. |
| 3 Measured activity timeline | Built locally; automated criteria tested. Owner acceptance pending. |
| 4 Follow-scroll and new activity | Built locally; automated phone-sized criteria tested. Real-phone owner acceptance pending. |
| 5 Mobile Back stack and bottom controls | Built locally; automated criteria tested. Real-phone owner acceptance pending. |
| 6 Attention surface | Built locally; automated criteria tested. Owner acceptance pending. Proposed paging limits remain unaccepted policy. |
| 7 `record_note` cancellation audit | Built locally; automated criteria tested. Owner acceptance pending. Uncertain effects remain for operator review; no exactly-once claim. |
| 8 Owner-configured orchestrator and worker models | Partial. Worker model policy is built and enforced for Step 9 W1; the remaining gaps above are open. Owner acceptance pending. |
| 9 Bounded owner-created workers | Partial. W1 is owner-approved for **Stop-only** at local commit `80b1bea`, with tests and hardening. This is not whole-step acceptance or real-phone acceptance. Wider worker scope remains unbuilt. |
| 10 Disconnect, cancel and crash tests | Automated local criteria pass: 586 unit/server tests and 85 browser tests in 2 shards at `df2e1fe`. Real-phone owner acceptance pending; no tunnel, live-provider or production acceptance. |
| Shared browser, runnable artifacts, unrestricted extensions, anonymous sharing | Deferred pending a security design. |

### Next manual owner checks

Use a disposable synthetic-data demo only in local mode through the browser panel. The current
preview uses `http://127.0.0.1:4398` while its local server runs; this is not a permanent endpoint.
This loopback browser view is not a real phone, and it does not validate a tunnel.
**Never tunnel or publicly expose local mode:** its page contains a session token. Do not use a
live provider or production data for these checks.

1. **Draft and reload:** enter synthetic text, reload, and confirm the draft returns in the same
   project and session. Do not send it.
2. **Back and follow-scroll:** move up in the transcript during synthetic activity; confirm the
   view does not jump. Use Back and Forward to close and restore a layer. Check that the draft stays.
3. **Uncertain recovery:** review the interrupted conversation and affected synthetic files. Confirm
   the run is terminal, the conversation is idle and queues are clear before acknowledgement. Confirm
   the UI states that acknowledgement does not replay or undo the effect. Do not create an uncertain
   interruption in live data.

Record these as browser-panel checks only. Real-phone acceptance remains a separate owner action.
