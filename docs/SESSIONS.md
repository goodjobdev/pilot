# Named sessions

A **session** is a durable, project-scoped record: a stable id, an owner-visible name, created and
updated timestamps, an optional *declared* model choice and links to the work a session is about — a
board task, a documentation path or spec reference, and a workspace directory.

Sessions are **working state**, not documentation. Markdown in the project stays canonical: losing
the registry costs convenience, never a planning fact. A session is also **not** an authorisation:
nothing here grants a commit, a push, a deployment, a spend, a provision or a publish. The execution
state of a session — its durable lifecycle and the five explicit owner actions over it — is a
separate record in the same control store; see [Session recovery](RECOVERY.md).

The model lives in `src/shared/sessions.ts` (pure validation and the record), the storage and the
migration in `src/server/state/session-registry.ts`, the routes in `src/server/main.ts`, and the
legacy adoption in [Migration](MIGRATION.md). The lifecycle lives in
`src/shared/session-lifecycle.ts` and `src/server/state/session-lifecycle.ts`.

## The record

| Field | Meaning |
|---|---|
| `version` | Record format version. It is `1` and is not a runtime knob. |
| `id` | The stable session id: 1–160 characters from `A-Za-z0-9._:-`, first character alphanumeric. A session created through the API gets a UUID; an adopted conversation keeps its conversation id. |
| `projectId` | The project the session belongs to, in the same id form. The registry is project-scoped: two projects can hold same-named sessions and never see each other's. |
| `name` | The owner-visible name. See [Names](#names). |
| `revision` | The optimistic-concurrency token. See [The revision rule](#the-revision-rule). |
| `model` | A declared `{provider, modelId}` choice, or `null`. **Recorded, never applied.** |
| `links` | Zero to **32** links, in one canonical order. See [Link kinds](#link-kinds). |
| `createdAt` / `updatedAt` | ISO instants. `updatedAt` never precedes `createdAt`. |

Validation is strict and frozen. An unknown field, an unknown link kind, a field missing for its
kind, an id outside the rule above, a name outside the name rule, a revision that is not a positive
whole number, a repeated or out-of-order link, and a record larger than the 64 KiB payload cap all
fail closed with a precise reason. A record read back from storage that does not validate is
refused as corruption, never interpreted.

**The declared model choice is a declaration.** It is stored so an owner can record what a session is
for. Nothing in this round applies it: the registry never opens an agent, never reads or writes a
transcript, and never changes a provider, model or thinking selection. Applying a choice to a live
conversation is a separate, explicit action and would need its own review.

## Names

A name is **1–80 characters**: the first character alphanumeric, the rest from letters, digits,
space, `.`, `_`, `:`, `-`. The rule is documented here and frozen in
`SESSION_NAME_PATTERN`.

**Names are unique among the live sessions of one project.** A create or a rename that would give a
second session a name another live session already holds is refused with `DUPLICATE_NAME` and the id
of the session that holds it. The migration follows the same rule rather than inventing a name: see
[Migration](MIGRATION.md).

There is no delete or archive in this round, so *every* record in the registry is live and the rule
applies to all of them.

## Link kinds

A link names one thing outside the session. The kind set is closed and every kind has an exact
shape: an unknown kind, an unknown field, or a field missing for the kind fails closed with
`INVALID`.

| Kind | Fields | Accepted when | Refusals |
|---|---|---|---|
| `task` | `taskId` (UUID) | The linked project's board contains that task id. | `NOT_FOUND` when the board does not contain it (including a project with no readable board, which has no tasks) |
| `document` | `path` (repository-relative Markdown), `anchor` (a heading slug, or `null`) | The documentation store serves that path: `assertEditableDocPath` accepts it and the file exists. A link with an anchor is a spec reference to one heading; one without is a plain path reference. | `NOT_FOUND` when the path is a servable location but no document exists there. `OUTSIDE_ROOTS` when the path is absolute, contains `..`, is not Markdown, or is a generated or app-managed location |
| `workspace` | `path` (absolute) | The existing contained-path helper (`approvedDirectory`) resolves it to a directory inside the approved browse roots. | `NOT_FOUND` when nothing exists at that path. `OUTSIDE_ROOTS` when it resolves outside the approved roots, is not a directory, or cannot be resolved at all |

The two refusals are deliberately different and are reported as different statuses, so "I linked the
wrong path" and "that path is not inside what this instance may touch" are never confused.

A **workspace** link is stored as its **canonical** location. The path and every approved root are
canonicalised and containment is checked on the canonical forms, so a symlink that leads out of the
approved roots is followed to its target, found outside them, and refused — it can never be stored
as a way back in. A symlink that stays inside the roots is accepted, and what is stored is the real
directory it points at. Unlinking matches the stored value exactly and needs no filesystem access,
so a link can always be removed even after a path has disappeared.

Links are kept in one canonical order (by their canonical form) with no repeats, so the same set of
links always produces the same stored record — which is what makes an idempotent re-run of the
migration observable.

## The revision rule

Every change to a session writes exactly one new revision. A caller sends the revision it read:

| Situation | Result |
|---|---|
| Rename to a **different** name at the revision the client read | Written; the record moves to `revision + 1` |
| Rename to the **same** name, any revision | No-op: the record is returned unchanged, so a retry is idempotent |
| Link a link the session **already has**, any revision | No-op: the record is returned unchanged |
| Unlink a link the session **does not have**, any revision | No-op: the record is returned unchanged |
| Rename, link or unlink at a **stale** revision when the record really would change | `CONFLICT`, with what the current revision is; nothing is written and the record is unchanged |

A no-op is checked before the revision, which is what makes retrying a *successful* request
harmless: the second attempt finds the state it already wanted. A change is revision-checked, so a
stale client cannot silently overwrite a newer record.

## Where it is stored, and why

Each revision is **one durable control-store operation**: the record is the operation input, the
operation's outbox row is the evidence that the write happened, and the idempotency key is derived
from the revision the write produces (`session.r<revision>`) inside the session's own scope. The
current record is the highest revision of that session.

Two things follow.

- **The revision is a real compare-and-swap.** The control store's
  `UNIQUE(project_id, session_id, idempotency_key)` index admits exactly one of two writers aiming
  at the same revision, inside the store's own transaction. The loser is refused as a conflict, so
  a race between a check and a write cannot produce two records for one revision.
- **No second persistence.** The reviewed control schema is frozen: the store refuses a database
  that holds any table other than `control_schema`, `operations` and `outboxes`. A companion table
  was therefore not an option without changing the reviewed store, and a second SQLite file was
  explicitly not added. Sessions sit inside the same transaction guarantees as the delivery ledger
  and the approvals that already live there, in the same `control.sqlite` in the data root.

The registry reads only rows of its own kind: another durable record in the same project/session
scope (an agent question's delivery, for instance) is never reported as a session.

Limits: at most **200 sessions per project** and at most **32 links per session**; both are refused
with a precise reason rather than allowed to grow past the payload cap.

## Routes

Every route is owner-only, behind the same Host check as everything else, and every write needs the
canonical origin. The session a write acts on is the one in the path; the body carries only the
fields that change.

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/sessions?projectId=` | — | `{sessions: [...]}`, oldest first. Each entry is the record plus the **session overview**: the durable agent binding (`agent`), the lifecycle state it reads at (`lifecycle`), the linked work (`links`) and the last activity (`updatedAt`). `422` without a `projectId`; there is no unscoped listing, and a project with no sessions lists none |
| `GET /api/sessions/:id/agent?projectId=` | — | `{projectId, sessionId, binding, authority, agents}`: the durable binding (or `null`), the authority it puts in force (`agentId`, `scopes`, `projects`, `emptyReason`) and the live agents to choose from |
| `POST /api/sessions/:id/agent` | `projectId`, `revision`, `agentId` (a string, or `null` to unbind), `actor` | `{binding, authority}`. Revision-checked like every other session write; a stale revision is `409` and writes nothing; an unknown agent is `404`. A session that exists only as a live conversation is adopted first, so the conversation the owner is in is bindable and appears in the list |
| `GET /api/sessions/:id?projectId=` | — | `{session}`, with its links |
| `POST /api/sessions` | `projectId`, `name`, optional `model`, optional `links` | `201` and `{session}`; `404` when the project is not registered, because a session is never created for a project that does not exist |
| `POST /api/sessions/:id/rename` | `projectId`, `name`, `revision` | `{session}` |
| `POST /api/sessions/:id/link` | `projectId`, `link`, `revision` | `{session}` |
| `POST /api/sessions/:id/unlink` | `projectId`, `link`, `revision` | `{session}` |
| `POST /api/sessions/migrate` | `dryRun` (boolean, default `false`) | The migration report. See [Migration](MIGRATION.md) |

Statuses: `422` for an invalid request (an unknown field, a malformed id, a name outside the rule, a
missing revision, no scope), `404` for a missing project or session and for a link target that does
not exist, `403` for a link outside the approved roots, `409` for a duplicate live name or a stale
revision, `405` for a known route with the wrong method, `400` for a body that is not JSON at all,
and `503` when the instance has no durable control store open.

A refusal never contains a filesystem path: every message names ids, kinds and rules, and nothing
else. A session that the owner reads back does carry the workspace path the owner linked, because
that path *is* the link.

## Binding a session to an agent

A session may be **bound to an agent record** (`docs/AGENTS.md`), which is what puts an explicit
privilege allowlist and project set in force for that session's dispatch. The binding is a durable,
revision-checked record with its own audit row (who bound it, when). The semantics, and the explicit
empty case, are stated in `docs/AGENTS.md`; the read is `GET /api/sessions/:id/agent` and the write
`POST /api/sessions/:id/agent`. A session with **no binding** is unmanaged and falls back to the
project-level rule; a session **unbound** (`agentId: null`) has no privileges at all, with a named
reason, rather than a silent refusal. The binding is read on every tool call, so a change takes effect
at the next dispatch with no restart.

## Where the owner manages sessions

The **Agents** view carries a session bar above the transcript:

- it shows the **current session** and lets the owner **choose or change its agent** (including
  "No agent", the explicit unbound state) and see the **agent and scopes actually in effect**,
  including the empty case, in the server's own words;
- **New session** creates a named session for the project with per-field validation (a name outside
  the rule is refused beside the field);
- **Sessions** lists every named session with its agent bound, lifecycle state, last activity and
  linked work, and lets the owner open one;
- **Session details** surfaces what the owner expects from Pi for the current session: the effective
  model, the lifecycle state, the agent and scopes in force, the tokens in and out, the provider's
  cache counters and the cost where the provider reports one. A fact the harness does not report is
  shown as a **named absence** ("not reported"), never as a fabricated zero. The counters come from
  the same usage projection the transcript header already reads.

## Failure semantics

| Failure | Behaviour |
|---|---|
| Unknown field, bad id, name outside the rule | `422` with the field and the rule; nothing is written |
| Duplicate live name in one project | `409` naming the session that holds the name; nothing is written |
| Stale revision on a real change | `409` naming the current revision; the record is unchanged |
| Repeat of a no-op (same name, same link, absent link) | The record is returned unchanged; no revision is written |
| Task not on the board | `404`; the refusal names the project and the task id |
| Document the store does not serve | `404`; a path outside the roots, not Markdown, or generated/app-managed is `403` instead |
| Workspace path outside the approved roots, or a symlink that leads out of them | `403`; the path is never stored |
| Workspace path that does not exist, or is not a directory | `404` and `403` respectively |
| Corrupt or contradictory stored rows (two records sharing a revision, a missing outbox, a record outside its scope) | `500`; nothing is guessed at |
| No durable control store open | `503`; the routes refuse rather than invent a registry |

## Execution state

Beside the record above, each session has a durable **lifecycle**: a closed execution state
(`idle`, `running`, `paused`, `interrupted`, `failed`), a revision, the attempt and request identity
of the current or last generation, the reason it is not idle, and the last durable activity. It is a
second, independent record kind in the same control store — one operation per revision — so a session
and its lifecycle never share a row, and `/api/sessions/:id/lifecycle` is the only thing that reads
or writes it. Creating, renaming, linking or unlinking a session never changes its lifecycle, and the
lifecycle never changes a name or a link. The five owner actions over it — `reconnect`, `resume`,
`retry`, `stop` and `pause` — and the browser-independent startup adoption are defined precisely in
[Session recovery](RECOVERY.md).

## Known limit

Name uniqueness is enforced by reading the committed registry immediately before the one write, and
by the store's own revision compare-and-swap for the record itself. The control schema offers no
unique index over names, and a second table was not an option (see above), so uniqueness rests on
the single owning process: a data root is owned by exactly one Pilot process through
`service.lock`, and within that process the read and the write are not interleaved. Two processes
writing the same data root are prevented by the lock, not by this rule — a future design that
allowed that would need a durable constraint of its own.
