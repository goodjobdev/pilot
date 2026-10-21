# Architecture and invariants

Three surfaces over one project's own files, plus derived state that can be rebuilt.

## The surfaces

| Surface | Owns | Stored as |
|---|---|---|
| Board | Work items, dependencies, milestones | `docs/dashboard/board.md` in the project |
| Wiki | Intent, behaviour, decisions, open questions | any Markdown in the project |
| Agents | Conversations, questions, tool calls, checkpoints | `<data>/agents/<projectId>/session.sqlite` |
| Sessions | Named sessions and their links to a task, a document and a workspace | the durable control store, `<data>/control.sqlite` (operations and outboxes) |

## Invariants

1. **Markdown is canonical.** Every planning fact lives in a file inside the project, in git.
   The SQLite index, the canvas layout, the alert subscriptions, the agent sessions and the
   named-session registry are derived or working state. Deleting them loses convenience, never
   documentation.
2. **Writes are revision-checked.** A client sends the revision it read; a mismatch is a
   conflict that preserves the draft. The application never overwrites a newer file.
3. **Paths are contained.** Every read and write resolves through one containment helper that
   refuses absolute paths, `..`, and symlinks. Generated folders (`node_modules`, `dist`, …)
   and app-managed paths are never served or edited. Reads and writes are size-capped.
4. **The agent harness is the only execution surface.** There is no shell endpoint and no
   general file API. Agent tools resolve their paths through the same containment helper, so a
   registered project root is the boundary for the current question/note tools. Repository
   setup is a separate fixed-operation provisioning path (keygen, access check, clone and
   worktree): no arbitrary commands, hooks, installs, commits or pushes. See
   [Project connections](PROJECT-CONNECTIONS.md).
5. **Everything is behind the same door.** Every route — documents, agents, alerts, assets —
   passes the same authentication, session CSRF, origin and Host checks. There is no bypass
   mode, no anonymous route, and the process binds loopback by default — the only interface
   local mode allows. A container's `container-private-interface` bind is its own network
   namespace serving the loopback-published port, not a public listener.
6. **Work is admitted durably before it is shown.** An agent input is committed to storage
   first; the interface reads committed state, so a closed browser cannot lose a run.
7. **Release identity is explicit, and readiness differs from liveness.** An immutable manifest
   names the running build and the storage schema it expects; that identity is what the service
   lock records, and hosted mode refuses to start without it. `/healthz` is unauthenticated
   liveness (the process is responding); `/readyz` is authenticated expected-version readiness and
   is `200` only when the stores are open, this process holds the lock, the data root is writable,
   the manifest is valid and the storage schema observed from the open control store matches the
   expected `schemaId`. Neither endpoint exposes a secret or a filesystem path, and the read-only
   `--doctor` diagnostic acquires nothing.
8. **Authorisation is explicit, scoped and single-use.** A consequential action is not a generic
   confirmation: it is an approval record with a kind from a closed set, an exact target for that
   kind, a scope and a short lifetime. Consuming it is a checked durable transaction that records
   who consumed it and returns the exact target — and performs nothing. A delivery is a receipt:
   re-sending is allowed only where the effect is idempotent and is marked as such, and anything
   uncertain is reported for an operator instead of replayed. See [Approvals](APPROVALS.md).

## The agent model

One harness per project, opened lazily, over its own SQLite file with its own provider
collection — so two projects share no conversation state. A conversation is a transcript of
immutable entries plus built-in documents (the running generation, the queued inbox, usage,
the agent's own choices).

- **Turns and runs.** An input starts a run; a run is one or more model turns with tool calls.
  Partial text and tool output are committed as they stream, which is why the transcript
  updates live and why a crash loses at most the last commit interval.
- **Steering and queueing.** Submitting while busy queues a follow-up by default; `steer`
  places the message after the current tool round, `reject` refuses it. Stopping withdraws
  queued inputs and aborts the run.
- **Questions.** The agent asks through a tool that records a question entry and ends its
  turn. The question is answered once: the answer record and the input that carries it both
  use a request id derived from the question, so a retry cannot answer twice, and an
  already-answered question is refused.
- **Interruption.** A tool is either safe to replay or not. After a crash, an unsafe tool
  returns an interrupted result to the model instead of running again; a safe tool may rerun.
- **Resumption.** Opening a harness resumes unfinished work from its checkpoint, which is how
  a run survives the process that started it.
- **Named sessions.** Each project's conversation is adopted into a durable, project-scoped
  session registry: a stable id, an owner-visible name, created and updated times, an optional
  *declared* model choice, and links to a board task, a documentation path or spec reference, and a
  workspace directory. Name uniqueness is per project, link validation reuses the board store, the
  documentation store and the contained-path helper, and a workspace link is stored canonically so a
  symlink that leads out of the approved roots is refused rather than followed. The record is
  working state in the same control store as the approvals and the delivery ledger — one operation
  per revision, so the revision is a real compare-and-swap and no second database is introduced — and
  a rename, link or unlink with a stale revision is a conflict that changes nothing. The declared
  model choice is recorded, never applied: the registry opens no harness and changes no selection.
  See [Sessions](SESSIONS.md) and [Migrating the legacy conversation](MIGRATION.md).
- **Durable execution state.** Each session also carries a durable **lifecycle** — a closed state
  (`idle`, `running`, `paused`, `interrupted`, `failed`), a revision, the attempt and request
  identity of the current or last generation, the reason it is not idle, and the last durable
  activity — in the same control store, one operation per revision. The five owner actions over it
  are explicit and revision-checked: `reconnect` attaches without starting anything, `resume`
  continues a paused or interrupted session under its **original request identity** (so it can never
  double-submit), `retry` starts a **new attempt with a new identity** only for a failed session,
  `stop` cancels idempotently, and `pause` cancels but keeps the session resumable. Only `resume`
  and `retry` may dispatch a model request; an uncertain interruption is refused with operator
  attention rather than replayed. See [Session recovery](RECOVERY.md).

## The alert model

Each project's conversation is watched on the server, not by a browser, so questions,
finished runs and failures are reported with no client attached. Alerts hold a VAPID key pair
and a bounded subscription list, throttle repeats of the same kind of event per project, and
drop endpoints the push service reports as gone. Payloads carry a title, one line of context
and a link — never document text.

## The approval and delivery model

An approval is one control-store operation: its immutable definition is the operation input and its
lifecycle is the operation's state and receipt (`pending`, `succeeded` with a consumption receipt,
`failed` with a revocation receipt). No new table or file is introduced. Validation is strict and
frozen — unknown fields, unknown kinds, a missing target field, an already-dead expiry and a
lifetime beyond the documented maximum all fail closed — and every read, consumption, revocation and
listing must name the approval's exact scope. Single use is the store's own checked transaction, so a
replay after a crash and reopen is refused just like a replay in the same process. The nonce makes a
record unique; it is not a credential, and only the create response returns it.

The delivery ledger records agent questions and answers as durable operations keyed by the question
id. It is a receipt and idempotency ledger, not the source of truth for question text: the transcript
stays canonical and no report returns that text. The running application writes it: a surfaced question
is admitted before its owner notification is sent, that notification is the delivery's outbox step and
is acknowledged with the receipt the alert store reports, and an answer is recorded before anything
reaches the agent — a ledger refusal refuses the answer — with the agent's submission as its outbox
step. `reconcileOnStartup()` reports pending operations and undelivered outbox rows read-only and
deterministically. A start then acts on that report and only on what it licenses: it re-validates each
stored payload against its delivery before claiming any idempotent re-send, re-sends the ones it can
prove, acknowledges each with the receipt the channel reported, completes a half-written
acknowledgement without re-sending anything, and reports every uncertain effect for an operator rather
than replaying it. The authenticated agent view carries that ledger for one project and session
(identities, states and receipts, never text). Neither an approval nor a delivery performs a commit,
push, deploy, spend, provision or publish.

## Isolation

Documents are scoped by project root, agent sessions by project id, and the only application-
level secrets are the VAPID key pair and the session secret, neither of which is exposed to
an agent or to the interface. The test suite asserts this directly: a document written in one
project is a 404 in another, the other project's transcript stays empty, and no key material
appears in an agent view.

## Failure semantics

| Failure | Behaviour |
|---|---|
| Two writers | Conflict, draft preserved, file untouched |
| Unreadable or malformed board | Served read-only rather than guessed at |
| Crash mid-tool | Run resumes; unsafe tool reports interrupted; no duplicate submission |
| Unclean process kill | `service.lock` remains and startup fails closed until an operator clears it |
| Push endpoint gone | Subscription pruned on 404/410 |
| Notification channel sends nothing | The delivery stays outstanding; the next start re-sends it under the same question tag |
| Delivery row that cannot be proven idempotent | Reported for an operator; never replayed |
| Missing or forged identity | 401; wrong Host 403; the application verifies signatures itself |
| Missing hosted release manifest | Startup refused; local mode runs as the explicit `unreleased-local` identity |
| Control store cannot be opened | Startup refused with a clear message, the lock is released, nothing serves |
| Not ready (`/readyz`) | 503 with machine-readable reasons; liveness `/healthz` stays `200` |
| Duplicate question or answer | The existing operation is returned unchanged (no second outbox row); different content under the same key is a conflict |
| Crash mid-delivery | Reconciled on the next start: an idempotent tagged notification is marked as safe to re-send, everything uncertain is reported, and nothing is replayed automatically |
| Approval consumed twice | Refused with `already consumed` — in the same process, after a crash and reopen, or from another process |
| Expired or revoked approval | Refused with the exact reason; no action is performed and the record is unchanged |
| Approvals without a control store | 503 `Approvals are unavailable`; nothing is guessed at and no unscoped view is served |
| Stale session revision | 409 naming the current revision; nothing is written and the record is unchanged |
| Duplicate live session name in a project | 409 naming the session that holds the name; nothing is written |
| Session link outside the approved roots, including a symlink that leads out of them | 403; the path is never stored |
| Legacy conversation migration | Idempotent and dry-runnable: a conversation is adopted exactly once, a project without one is untouched, and no provider, model or thinking selection changes |
| Sessions without a control store | 503 `Sessions are unavailable`; the routes refuse rather than invent a registry |
| Illegal session lifecycle jump | 409 naming the current state; nothing is written and no effect happens |
| Stale session lifecycle revision | 409 naming the current revision; the record is unchanged |
| Uncertain interrupted session, resumed | 409 operator attention; the uncertain effect is never replayed, and `retry` starts a new attempt instead |
| Reconnect, stop or pause | No model request is ever dispatched; `stop` and `pause` cancel only a harness that is already open |
| Running session whose process is gone | Adopted at startup as `interrupted` with a reason, deterministically and idempotently, with no browser attached |
| Sessions without a control store (lifecycle) | 503 `Session lifecycle is unavailable`; the routes refuse rather than invent a lifecycle |

## Startup and the data-root lock

Startup validates every environment value first, before it touches the data root or opens a
store. It resolves the immutable release identity from the manifest — refusing to start in hosted
mode when it is missing or invalid — before the data root is touched. It then creates the data
root (0700) and takes an exclusive `<data root>/service.lock`
before listening; that lock is the single authority for owning a data root. The manifest's
`releaseId`/`schemaId` become the lock record's values when it is present. Existing evidence
always fails the start closed with one diagnostic that names the path, performs no automatic
recovery and does not change the evidence. An ordinary shutdown releases the lock after the
application has closed, within a bounded deadline; a shutdown that cannot finish retains the
lock deliberately, so the next start refuses instead of racing a half-closed writer. A start
that never listened still closes and releases the lock it created and then fails with the
original error, so a bind failure cannot strand a data root.

Before anything listens, startup also opens the durable control store at
`<data root>/control.sqlite` — creating it with its schema on a fresh root — and keeps that handle
for the life of the process. Opening it after the lock means a store is never written without
ownership, and closing it before the lock is released means the lock outlives every writer. If the
store cannot be opened, or its schema version is not the one the release manifest's `schemaId`
names, the start fails closed: the message names the cause, the lock is released, the exit is
non-zero and nothing serves. Readiness asks that live handle, so it describes the database this
process is actually using instead of opening a second connection beside it.

Before anything listens, startup also **adopts** every session whose durable lifecycle says `running`
but whose process is gone, marking it `interrupted` with a reason and `uncertain`, in a deterministically
ordered and idempotent pass that moves no outbox row and re-sends nothing — distinct from the delivery
reconciliation. A fresh client then reads the interrupted state and the reason, never a stuck `running`.
A live generation is recorded durably only where a named session exists for the conversation.
