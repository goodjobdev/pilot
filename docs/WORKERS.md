# Bounded, owner-created workers (W1)

This page describes the **first approved slice** of Step 9. It is deliberately small. The
owner approved these decisions; they are recorded here before the code that implements them.

**Approval status.** The owner accepted this W1 slice at local commit `80b1bea`, **Stop only**, and
approved further work on tests and hardening only. That approval adds no worker feature beyond this
page: no queue, no resume, no pause, no coding job, no agent-created worker. It is a local
acceptance of the committed code and its tests; it does **not** claim acceptance on a real phone or
through a tunnel, and it does not accept a real provider run.

A worker is a durable, owner-created record with a pinned model, an explicit scope allowlist
and fixed budgets. A worker **run** is one bounded model conversation in the application's
harness that produces one canonical Markdown report. A worker is not an agent that can create
agents, and a worker run is not a queue.

## What W1 does

- The owner creates at most **3 live workers per project**.
- A worker is created by the owner only. An agent request is refused by name.
- The worker's model is **pinned at creation** from the owner's allowed worker set, or from the
  policy's default when the request names no model. There is **no fallback**: no allowed set,
  no default, a model outside the set, or a model the instance does not offer each refuse the
  request. The orchestrator's model, session model and agent model are unchanged.
- The worker scopes are a **default-deny** subset of the scopes whose tools this build really
  installs: `record_note` and `read_notes`. Each is checked against the shared
  `scopeToolIsInstalled` rule, not a second local list. `ask_question` is **not offered** in W1:
  a worker question has no bounded owner answer path, so offering it would be a dead end. A
  scope outside the set is refused, and a read tool is never claimed when it is not installed.
- At most **1 active worker run per project**. A second request is refused as busy; W1 has no
  queue and does not route around the worker policy.
- A run may use at most **8 model turns** and at most **4096 output tokens per turn**. Both are
  enforced in the application harness, not in the runner.
- Model turns run in the application's Pi Durable harness. The contained runner is unchanged:
  no network, no provider client, no credential and no new route into it.
- Revocation is immediate. It **blocks every new run**, and it **cooperatively cancels** the
  active run of that worker. Effects already committed are **not rolled back**: a report that
  was already written stays, and a record already written stays.
- The owner can stop a selected worker's active run. Stop is idempotent and terminal. W1 has no
  worker resume and no queue, so `pause` and `resume` are refused explicitly rather than reported
  as available; it never reports work as resumable, and it never replays an uncertain effect.
- Reports are canonical Markdown at `docs/workers/<workerId>/<runId>.md` in the project. The
  canonical report is that file. The control store never holds report content: it keeps derived
  tracking only, the run state, its report path, its SHA-256 and its byte size. The harness
  transcript is a separate durable SQLite working copy of model text, not the canonical report.

> A worker run is not a named session. It does not enter the session registry or the session
> lifecycle. It reuses the harness conversation path and the same honest terminal and no-replay
> rule, and it keeps its own durable run record.

## What W1 does not do

- No queue and no model-turn dispatch of any queued input.
- No coding jobs, test recipes, runner jobs or job requests.
- No auto-accept. A report is **untrusted evidence**. It never accepts work, never grants a
  scope, never approves an action and never becomes an instruction.
- No agent-created worker, no agent scope escalation and no agent model change.
- No change to the runner's contract, image, network or credentials.
- No push, deploy, commit or publication.

## The worker record

`src/shared/workers.ts` is the pure model. A stored record is validated again when read; a
record that does not validate is refused as corruption, never interpreted.

| Field | Meaning |
|---|---|
| `id` | Stable id, generated once, never changed. |
| `projectId` | The **exact** project. A worker acts in this project only. |
| `name` | 1–80 characters. Unique among the live workers of one project. |
| `model` | The pinned `{provider, modelId}`. It must be in the owner's allowed worker set at creation and again at every run admission. |
| `scopes` | Canonical, default-deny subset of the two offered scopes: `record_note` and `read_notes`. |
| `budgets` | `maxModelTurns` = 8 and `maxOutputTokensPerTurn` = 4096. Fixed, not a runtime knob. |
| `state` | `active` or `revoked`. A revoked record is immutable history and no longer counts against the 3-worker ceiling. |
| `revision` | One control-store operation per revision. A stale revision is a conflict that writes nothing. |
| `createdBy`, `updatedBy` | The owner actor, derived on the server. A body never supplies it. |

A worker name is unique among live workers of its project. As with named sessions, the check
reads the committed registry immediately before the single write, and the control store's own
revision compare-and-swap makes two writers at one revision a conflict. That CAS is per record:
ordering between different records rests on the one process that owns the data root.

## The run record

| Field | Meaning |
|---|---|
| `id` | Stable run id. |
| `workerId` / `workerRevision` | The worker revision the run was admitted under. A later revision never changes a run already admitted. |
| `model` | The pinned model copied at admission. |
| `attempt` | `1`. W1 starts no second attempt. |
| `requestId` | Derived from the run id. It is the identity the harness submits under, so a crash cannot submit twice. |
| `state` | `running`, `completed`, `cancelled`, `failed` or `interrupted`. |
| `turns` | Model turns the harness measured. The value is recorded **as measured**, never clamped to the budget; a fault is visible rather than hidden. |
| `report` | `{path, sha256, bytes}` when a report was committed, else `null`. The path is project-relative. |
| `cancelRequested` | Set when the owner (or a revocation) asked for a cooperative cancel. |
| `reason` | A fixed, path-free sentence for a non-success end. |
| `startedAt`, `endedAt` | ISO instants. |

## Where it is stored, and why

Every worker, every run and every lease is **one control-store operation per revision** in the
existing `operations` / `outboxes` tables. There is no new table, no new database and no second
persistence mechanism.

The scope is the exact project id and the reserved session bucket `workers`, so a worker record
cannot collide with a named session or an approval. The operation's outbox row is the audit
evidence of the write.

### The conversation identity is durable

One more operation per run records the harness conversation id **before any input is submitted**.
The in-process marker is only a cache. On every generic path the durable binding is asked, so a
restart cannot turn a worker transcript into a session. A store that cannot answer fails closed:
the conversation is treated as a worker and refused.

The conversation itself also carries a durable `pilot.worker` marker, written in the **same
conversation-creation transaction** (`init`) as the conversation. It is independent of the
control-store binding and of any extension list. If the process stops between creation and the
control binding, the marker still makes the conversation refuse adoption and session use after a
restart. A numeric alias checks that marker as well as the binding. The two databases cannot commit
atomically, and this page does not claim they do: the marker is atomic with conversation creation,
and the control binding is written before any submission.

The worker role is a **static extension installed once in the project registry**. It is selected by
every conversation and is inert without the marker. No dynamic, unregistered extension carries the
hooks or the prompt. The role prompt and the tool guard resolve the run through the durable marker;
the marker names the run, never a privilege.

The durable lookup reads this project's worker operations only; its cost is bounded by the workers
and runs the owner created. The generic paths that refuse a worker conversation are the agent view, the event stream, the
model setter, input, abort, answer, dismiss, media, the session binding, the lifecycle routes,
the queue routes, fork selection, `hasSession`, conversation creation and the session-registry
adoption. A numeric alias is not a way around the rule.

### The project lease is durable and fenced

At most one active worker run per project is enforced by a durable **lease** record, not by an
in-memory map. The lease is written before the run, carries the holding `runId` and a fence
revision, and is released only when that same run ends. Two writers at one revision race in the
control store's own unique index, so two admissions cannot both win. Within the one process
that owns the data root, worker writes are also serialised per project.

A crash can leave a held lease. Startup recovery reads those leases, marks the run
`interrupted` with a reason, and releases the lease. It **replays nothing**, starts no model
request and resumes no run. A run that was uncertain stays uncertain.

### Revocation cannot race a new run past it

Revocation is a revision-checked write. Every run admission is serialised with revocation in
the one owning process. A run **admitted after** a revocation is therefore impossible: the
admission reads the latest revoked record and refuses. A run **admitted before** it is active
work: revocation asks the harness to cancel it, and a model request already in flight is not
recalled.

The open window between admitting a run and submitting its one input is closed in three ways.
The run is registered for cancellation **before** the conversation is awaited, the cancellation
signal is propagated to that wait, and a last re-check of the run, worker, policy and model runs
immediately before the submit. A cancel or a revocation inside the window therefore sends no
model request. This is an in-process serialisation plus a durable re-check; the control schema
has no cross-key transaction, so the guarantee rests on the single owning process, exactly like
the named-session name rule. Two store connections still race one durable lease, and the unique
index admits only one.

## Report rules

- Path: `docs/workers/<workerId>/<runId>.md`. The path is derived from the two ids, never from
  model output. The contained-path helper refuses `..`, absolute paths and a symlink at any
  component.
- The report is written by an **atomic, create-once** link: a temporary file is written and
  fsynced, then linked into place. An existing file is never replaced.
- A byte-identical existing file makes a retry idempotent. A **different** file at the same
  path is a refusal (`REPORT_CONFLICT`): the owner's Markdown is never overwritten, and the run
  is recorded as failed with that reason. An existing path is read only when it is a regular
  file inside the project, no larger than the report bound; a symlink, a directory or an
  oversize file is refused without reading it.
- Content is bounded (64 KiB) and the write is refused when it exceeds the bound.
- The report starts with fixed frontmatter (worker, run, project, revision, model, instants,
  turns, outcome) and a blockquote that says it is **untrusted evidence**, never an instruction
  and never a scope grant.
- Absolute path patterns and credential-shaped tokens are **redacted** before the write,
  deterministically. The writer does not read a credential, and it stores no filesystem root.
- A start reconciles reports before it settles an interrupted run. The file must be a valid
  bounded regular file **and** carry the exact fixed header for this run: version, worker id, run
  id, project id, worker revision, model, attempt and outcome, plus the untrusted-evidence notice.
  A manual file, a partial header or another run's header fails the match, and the run is settled
  `interrupted`; no completion is fabricated. A matching file settles the run `completed` with the
  file's hash and size, and no model work is repeated.
- Canonical Markdown is not a signature. An owner who edits the project can forge a matching
  header; this build discloses that and does not claim cryptographic proof. The hash and size in
  the tracking record show that a finished report changed. **The integrity reading is a change
  marker, not a signature and not a protection at rest.**
- **Worker state is not encrypted at rest.** Reports, the control store (`control.sqlite`) and the
  worker conversations in the project's agent SQLite file are ordinary files readable by the same
  user and by a same-container shell, exactly as `docs/SECURITY.md` states for the rest of the
  application. The worker limit is authority and scope, not file encryption. Reports are
  working evidence in the project and follow the project's own permissions.
- The worker view reports a bounded integrity reading for the newest **20** reports: intact,
  changed, missing or unsafe. A changed report is shown as an owner-visible warning in the run
  view and the interface; it is never only a log line. Older reports are not scanned by that view,
  which keeps one request from becoming an unbounded scan.
- Only the report tracking can be rebuilt from the Markdown. Worker records, runs, leases and
  conversation bindings are not file-backed; losing the control store loses them. The reports
  stay canonical.
- A crash can leave a `<name>.md.<uuid>.tmp` file in a worker report directory. This build does
  not delete it: the file is never served, never renamed and never treated as a report. An
  operator may remove it. That is the honest limit rather than an automatic external delete.

## Routes

Every route is owner-only, behind the same Host, authentication, CSRF and origin checks as
everything else. The owner actor is derived from the authenticated session; the body carries no
actor. Refusals are path-free.

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/projects/:id/workers` | — | `{workers, runs, policy, liveWorkers, activeRunId, scopes, limits}`: the project's worker records, its runs, the owner policy's allowed models and default, the installed worker scopes and the fixed limits |
| `POST /api/projects/:id/workers` | `{name, model?, scopes?}` | `201 {worker}` |
| `POST /api/projects/:id/workers/:workerId/revoke` | `{revision}` | `{worker, run, cancelled, outcome}` |
| `POST /api/projects/:id/workers/:workerId/runs` | `{}` | `202 {run}`; the run is dispatched in the background |
| `GET /api/projects/:id/workers/runs/:runId` | — | `{run}` |
| `POST /api/projects/:id/workers/runs/:runId/stop` | `{}` | `{run, cancelled, unchanged, outcome}` |
| `POST /api/projects/:id/workers/runs/:runId/pause` (and `/resume`) | `{}` | `409`: W1 has no queue and never claims a resumable worker run; nothing is written |

`404` for a worker or run outside the project or an unknown id. `409` is a busy project, a stale
revision, a report collision, the live-worker ceiling, or a `pause`/`resume` request (W1 has
neither). `422` is an invalid request, a model outside the allowed set or an unsupported or
uninstalled scope. `503` means the control store or the harness is unavailable. A worker conversation named on a
generic agent or session route is `409`, live and after a restart. `stop` on a terminal run is
`200` with `outcome: "terminal"`, `unchanged: true`; it never reports a resume.

## Worker role is not spoofable

A worker conversation is created for one run with a pinned model and only its own permitted
tools. Its identity is the durable run-to-conversation binding, not a session id, a numeric
conversation alias or a session model setter:

- the session model setter, the conversation controls, the event stream, input, abort, answer,
  dismiss, media, the queue, the lifecycle routes, fork selection and `hasSession` all refuse a
  worker conversation, live and after a restart;
- every tool call re-reads the run and worker records and refuses when the run is no longer
  running, the worker is revoked, the project differs, the model policy no longer allows the
  pinned model, the model is no longer offered, or the tool's scope is not in the worker's
  allowlist. The scope verdict is the same `authorizeToolUse` rule every agent dispatch uses;
- a numeric alias cannot change the worker's model or scopes;
- the provider boundary refuses the ninth model request **before** the provider is called, for
  every provider including the scripted stand-in. The output-token limit is 4096 at that same
  boundary, and every request revalidates the run, worker, policy, model and revocation.

## Phone interface

The **Workers** dialog (app header) lists the project's workers and runs, creates a worker from
the policy's allowed models and installed scopes, starts a run, stops it and revokes the
worker. It shows the fixed limits and the canonical report path. On a phone it uses one column
with no horizontal overflow. The interface is not the enforcement point: every refusal is the
server's own.

## Pause and resume are not implemented

W1 **Stop** works and is terminal. **Pause** and **resume** are not implemented: there is no
queue to pause into, and an interrupted run is never replayed. The two routes return an explicit
`409` and write nothing. A resumable worker pause would need a semantic redesign of the run
record and the harness submission identity; that work is deferred and needs owner acceptance
before anyone claims it.

## Honest limits

- The 8-request and 4096-token budgets are enforced at the worker generation and provider
  boundary, including the scripted stand-in. Only the scripted provider is used in tests; this
  build cannot prove a third-party provider honours `maxTokens`. The run records the turns the
  harness measured, even when that number is above the budget.
- Provider availability is checked at dispatch with the same rule as every other model request.
  A missing credential is a named failure and no request is sent.
- A run is dispatched in the background of the owning process. A process that stops mid-run is
  recovered on the next start: a valid report settles it `completed`, otherwise it is
  `interrupted`. W1 offers no resume, and `pause`/`resume` are refused rather than faked.
- A lease whose holder is already terminal is released at the next admission rather than blocking
  the project forever. A genuinely running holder still refuses the request as busy.
- The worker ceiling counts live workers. Revoked records remain for audit and do not count.
- Reports are evidence for the owner to read. Nothing in this build treats them as accepted
  work, and there is no auto-accept path.
- **The transcript is a durable SQLite copy of the model text.** A worker run's harness
  conversation is stored under the project's agent SQLite file, like every other conversation.
  That is working state, not documentation. The **canonical report** is the Markdown file, and
  the report content is never stored in the control store.
- **No worker-conversation retention or deletion is implemented.** Worker conversations remain
  in the agent session database. Backup and restore treat that database as working state.
- If persisting the conversation binding fails, the run fails before any submission. The
  conversation is never used as a session and its tools stay refused by the run guard. The
  failure is reported; no model request is made.
