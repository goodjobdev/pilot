# Session recovery: the durable lifecycle and its owner actions

A named session (see [Sessions](SESSIONS.md)) is a durable record of *what a conversation is about*.
This page is its other half: the **durable execution state** and the five explicit owner actions over
it. The state lives in the same durable control store as the registry, the approvals and the
delivery ledger, so a closed browser, a vanished process and a fresh client all read the same truth
instead of guessing from the running process.

The model is `src/shared/session-lifecycle.ts` (pure states, actions, validation and transitions),
the storage and orchestration is `src/server/state/session-lifecycle.ts`, and the routes are in
`src/server/main.ts`.

## The record

| Field | Meaning |
|---|---|
| `version` | Record format version. It is `1` and is not a runtime knob. |
| `projectId` / `sessionId` | The scope, in the same id form as a session id. |
| `state` | One of the five states below. A closed set. |
| `revision` | The optimistic-concurrency token every action sends back. |
| `attempt` | How many generations the session has started. `0` means none yet. |
| `requestId` | The request identity of the current or last generation, or `null` when there has been none. |
| `reason` | Why the session is not idle. Required for `paused`, `interrupted` and `failed`; absent for `idle` and `running`. |
| `uncertain` | `true` only for an `interrupted` state whose effect cannot be proven idempotent. |
| `activityAt` / `updatedAt` | The last durable activity and the last durable write. |

A session that has no durable lifecycle row yet reads at a deterministic **idle** record with
`revision` `0`, so the first action a client sends (`revision` `0`) is the same compare-and-swap as
every later one. Validation is strict and frozen: an unknown field, an unknown state, a request
identity without an attempt, an attempt without a request identity, a reason on an idle or running
state, a missing reason on a paused, interrupted or failed one, uncertainty outside an interruption,
and a record larger than the 64 KiB payload cap all fail closed with a precise reason.

## The states

| State | Meaning |
|---|---|
| `idle` | No generation is running and nothing is pending. Where a session begins and where a completed or deliberately stopped run ends. |
| `running` | A generation with a request identity is in flight. |
| `paused` | The owner stopped the current generation but kept it resumable under its original request identity. |
| `interrupted` | The owning process went away while the session was running. `uncertain` records whether the effect can be proven idempotent. |
| `failed` | The generation ended in a terminal failure. It is re-run only by an explicit `retry`. |

## The five owner actions

Each action is owner-only, behind the same Host check as everything else, and every write needs the
canonical origin. Each carries the `revision` the client read; a stale revision is a `409` that
changes nothing. An illegal jump is a `409` naming the current state. The table says exactly what
each action does and whether it can cause a model request.

| Action | Meaning | Legal from | Refusals | Dispatches a model request? |
|---|---|---|---|---|
| `reconnect` | Attach a fresh client to an existing session. It starts no generation and changes no execution state; it is a revision-checked read. | any | A stale revision (`409`). | **Never.** |
| `resume` | Continue a paused or interrupted session. The generation is re-dispatched under its **original request identity**, so it can never double-submit. | `paused`; `interrupted` only when `uncertain` is false | `idle`, `running`, `failed` (`409`, "only a paused or interrupted session can be resumed"); an **uncertain** interruption (`409`, needs operator attention) | **Yes**, under the unchanged request identity. |
| `retry` | Re-run a failed generation as a **new attempt**, only when the owner asks, under the request identity `retry:<sessionId>:r<revision>` that is **derived from the revision the attempt is written at** (never minted at random). | `failed` | Any other state (`409`, "only a failed session can be retried"); a derived identity equal to the failed one (`422`) | **Yes**, as a new attempt. |
| `stop` | Cancel the current generation. **Idempotent**: a session that is not running is a no-op, and stopping an already-stopped session changes nothing. | `running` (a real cancel); any other state is a no-op | A stale revision (`409`). | **Never.** |
| `pause` | Request a stop that keeps the session resumable: cancels the current generation and records `paused` with the owner's reason. | `running`; `paused` is an idempotent no-op | `idle`, `interrupted`, `failed` (`409`); an over-long or non-printable reason (`422`) | **Never.** |

There is no action outside these five. In this round nothing but `resume` and `retry` can enter
`running`; there is no "start" action.

### No silent spend, and no uncertain replay

- **Nothing silently spends on a model call.** Only `resume` and `retry` may dispatch a model
  request. `reconnect` performs no effect at all, and `stop` and `pause` only ask a generation that is
  already open to cancel - they never open a harness (opening one resumes unfinished work, which
  would itself be a model request). The tests assert a provider-call count that is `0` for
  `reconnect` and `stop`.
- **One writer per revision, and no dispatch before the write that authorises it.** A dispatching
  action is checked for capability first (a port that cannot dispatch refuses and changes nothing),
  then writes its transition, and only then dispatches. The durable write *is* the compare-and-swap
  and the serialization point: two clients that both read revision R and both retry produce the same
  request identity, one of them wins revision R+1, and the other is refused with a conflict having
  dispatched **nothing**. A second write of a revision that is already written is a second writer and
  a `409`, even when the two writes are byte-identical.
- **An owner's cancel owns the end it causes.** `stop` and `pause` cancel a generation that is
  already open and then write. Cancelling a genuinely running generation makes the harness observe the
  run leave the working state; its own settled hook would otherwise write `idle` at the very revision
  the owner's `paused`/`idle` write is being prepared for, and whichever write landed first would win
  - so the owner's pause could be refused and lost, leaving a durable `idle` from which a resume is
  illegal. The harness therefore suppresses its settled write for the end an owner cancel caused, and
  the owner's action is the single writer at that revision. The owner is still notified the run ended.
- **No uncertain replay.** Where an effect is uncertain - an interrupted generation whose completion
  cannot be proven - `resume` **refuses** and reports **operator attention** instead of replaying it.
  A `retry` starts a brand-new attempt with a brand-new identity precisely so it never has to replay
  the uncertain one. The record is left exactly as it was by a refusal.

**Operator attention** is a refusal that says an automatic decision is not safe and a person must
decide. It is a `409` whose reason names what cannot be proven; nothing is written, nothing is sent
and nothing is replayed. It is deliberately distinct from an ordinary conflict, which only means
"re-read and retry".

## Startup adoption: recovering a session whose process is gone

On start - before the server listens - every session whose **durable state says `running`** but whose
process is gone is marked **`interrupted`**, at its next revision, with the reason

> The owning process stopped while this session was running; the generation's completion cannot be
> proven, so it was not replayed.

and with `uncertain` set to `true`. The adoption:

- works **with no browser attached**, because it reads only the durable store;
- is **deterministic** - sessions are adopted in a fixed order (project id, then session id) - and
  **idempotent**: a second start finds no running session and changes nothing;
- is **distinct from the delivery reconciliation**: it moves no outbox row and re-sends nothing;
- logs **one deterministic summary** (`Session lifecycle adoption: {…}`) only when it adopted
  something, and the summary carries no filesystem path.

A fresh client that later connects reads `interrupted`, the recorded reason and `uncertain: true`
through the read route - never a stuck `running`. Because the adopted record is `uncertain`,
`resume` refuses it with operator attention; the owner may connect (`reconnect`), stop it
(a no-op, since it is not running), or, once a generation has been re-established as `failed`, retry
it as a new attempt.

A live generation is recorded durably only where a named session exists for the conversation, so a
project without a registry writes no lifecycle row at all. A finished or failed run settles the
record back to `idle` or `failed` through the same store, which is why the next start does not adopt
it.

## Where it is stored, and why that way

Every revision is **one durable control-store operation** keyed by `lifecycle.r<revision>` inside the
session's own scope, exactly like a named-session revision. The control store's
`UNIQUE(project_id, session_id, idempotency_key)` index is what makes two writers aiming at the same
revision a conflict rather than two records, so a stale client can never overwrite a newer state, and
no second table or second SQLite file is introduced.

## Routes

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/sessions/:id/lifecycle?projectId=` | - | `{lifecycle}`. `422` without a `projectId`; `404` when the session does not exist |
| `POST /api/sessions/:id/lifecycle/reconnect` | `projectId`, `revision` | `{lifecycle, dispatched, cancelled, unchanged}` |
| `POST /api/sessions/:id/lifecycle/resume` | `projectId`, `revision` | `{lifecycle, dispatched, cancelled, unchanged}` |
| `POST /api/sessions/:id/lifecycle/retry` | `projectId`, `revision` | `{lifecycle, dispatched, cancelled, unchanged}` |
| `POST /api/sessions/:id/lifecycle/stop` | `projectId`, `revision` | `{lifecycle, dispatched, cancelled, unchanged}` |
| `POST /api/sessions/:id/lifecycle/pause` | `projectId`, `revision`, optional `reason` | `{lifecycle, dispatched, cancelled, unchanged}` |

Statuses: `422` for an invalid request (a missing `projectId`, a revision that is not a whole number,
an over-long reason, an unknown field), `404` for a missing session or an unknown lifecycle action,
`409` for an illegal jump, a stale revision, an uncertain interruption that needs operator attention,
or a duplicate write, and `503` when the instance has no durable control store open. The response
flags say what happened: `dispatched` is true only when a model request may have been sent,
`cancelled` only when a generation was asked to stop, and `unchanged` only for a legal no-op. A
refusal never contains a filesystem path.

An invalid body is refused with `422` and a reason in this application's own words (which field is
missing, or that the body carries a field the route does not accept) - never the raw schema-library
message, and never a generic `400`.

## Failure semantics

| Failure | Behaviour |
|---|---|
| Illegal jump (resume a running session, retry a paused one, pause an idle one) | `409` naming the current state; nothing is written and no effect happens |
| Stale revision | `409` naming the current revision; the record is unchanged |
| Uncertain interruption, resumed | `409` operator attention: nothing is written and nothing is replayed |
| Retry with an identity equal to the failed attempt's | `422`; a retry must be a new attempt |
| Stop or pause on a session that is not running | An idempotent no-op (or a pause-specific refusal); no effect |
| A port that cannot dispatch at all (agents disabled, project not registered) | Refused before anything is written: the refusal is returned and the record is unchanged |
| A port (harness) refusal of an already authorised dispatch | The refusal is returned and the attempt the record authorised is closed durably as `failed` with one fixed, path-free reason ("...nothing was sent to a provider and nothing was replayed"), at its own revision. The record never claims a generation that was not dispatched, and the session stays retryable |
| A port refusal of a cancel (`stop`, `pause`) | The refusal is returned and the record is unchanged: it still describes the generation that is still running |
| An owner pause of a genuinely running generation | The owner's `paused` is the single write at that revision; the harness's settled hook writes nothing, so the pause is not overwritten by `idle` and the session stays resumable |
| Two clients retrying the same failed revision | The same derived request identity, one winner at revision R+1, the loser refused with `409` and zero dispatch |
| Crash between a generation starting and the process dying | The next start adopts the `running` session as `interrupted` and `uncertain` |
| Crash between a dispatching action's write and its dispatch | The record is `running` for work that may never have been sent; the next start adopts it as an uncertain interruption (operator attention) rather than replaying it, and while the process lives the owner can pause it (keeping it resumable) or stop it |
| No durable control store open | `503`; the routes refuse rather than invent a lifecycle |
