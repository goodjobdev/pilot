# Commands and the action registry

The **palette's** command surface is one registry, not a set of routes the interface happens to
know about.

Everything the palette can ask for is declared once, in `src/shared/actions.ts`, and bound to the
handler that really performs it in `src/server/state/action-registry.ts`. The palette
(`src/client/ActionPalette.svelte`), the registry routes and the tests all read that one
declaration, so the surface the owner sees and the capabilities the server has cannot drift apart.

### What the registry does not cover — and why this file says so

The claim above is about the palette, not about the whole HTTP API. Consolidating the rest is
follow-up work, and until it is done, these surfaces keep their own handlers:

- **The older per-route commands.** `/api/sessions` and `/api/sessions/:id/(rename|link|unlink)`,
  `/api/sessions/migrate`, `/api/sessions/:id/lifecycle/:action` and `/api/approvals*` perform the
  same effects as `session.create`, `session.rename`, `session.link`, `session.unlink`,
  `session.migration.apply`, the five `session.lifecycle.*` actions and the three `approval.*`
  actions. They parse their own bodies, keep their own shapes, and are driven by their own tests.
  The palette writes through `/api/actions/execute` only, and the client calls none of those write
  routes — it reads the session list and nothing else from them. They are kept because other callers
  and the route tests read them; routing them through the registry is follow-up work.
- **Capabilities with no declared action at all.** Editing the board, writing a document, aborting
  agent input, sending a message through the shell's own agent-input route, alerts, provider settings,
  the repository connection, import/export and unregistering a project are offered by the shell with
  their own handlers. No action id describes them, so they are absent from the registry rather than
  represented by a placeholder — and their buttons are not part of this command surface. (The queue's
  own dispatch *is* a declared action, `queue.submit`; the shell's
  `/api/projects/:id/agents/input` route keeps its own handler. See *Queued inputs*.)
- **A per-action button.** None exists yet, so nothing declares one (see *Surfaces*). (The composer's
  slash surface described below is implemented, but it is driven by the registry rather than by a
  declared `'slash'` surface in this build — see *Surfaces*.)

So: every action the palette offers is declared exactly once and has a handler; several older routes
and several shell controls still use their own handlers; and no button or shortcut is claimed to
route through the registry until it really does.

## The registry contract

An action is declared as:

| Field | Meaning |
|---|---|
| `id` | A stable id from the closed set `ACTION_IDS`. The id is the only thing a caller may use to ask for the action. |
| `label`, `description` | What the owner sees: one short label and one line that says what it does. |
| `surfaces` | Which surfaces offer it. The closed set is `slash`, `palette`, `button`. |
| `requires` | The scope dimensions the caller must supply: `project`, `session`, or none. |
| `parameters` | A strict list: name, type, whether it is required, what the type means, and — for a nested payload — which model parses it. A `revision` parameter also declares the read its value comes from (`revisionSource`). |
| `preconditions` | What the handler really refuses, each with a code from the closed vocabulary `ACTION_PRECONDITION_CODES`. |
| `noops` | Requests the handler answers with "nothing changed" rather than a refusal. |
| `writes` | Whether the handler can write durable state. `false` means it only reads or reports. |
| `effect` | One line describing what the handler does. |

Three rules make this honest, and each is checked rather than asserted:

1. **No action without a handler, and no handler without an action.** The handler map is built from
   the declared ids; `assertActionRegistryConsistent()` and `assertHandlerSet()` refuse a registry
   where the two sets differ, and the unit test compares them.
2. **The published parameter schema is the validated one.** `actionParamSchema()` builds one strict
   object from the descriptor's own parameter list, and `ActionRegistry.run()` validates with that
   object before the handler is reached. An unknown field is refused by the very schema the registry
   publishes, and a declared `required` field really is required.
3. **The declared preconditions are the handler's own refusals.** The registry adds no second,
   divergent check: the handler decides, and the HTTP layer only maps its typed refusal to a status.
   Every precondition code is either driven by the tests or explicitly recorded there as undriven.

An action whose capability this instance lacks is **not offered**: availability is part of the list,
and asking for such an action anyway is refused with a precise reason rather than attempted.

## The implemented actions

Forty-seven actions exist in this build. Nothing else is declared, and none of them commits, pushes,
deploys, spends, provisions or publishes.

Five of them are the **bounded coding runner**, and they are **disabled by default** behind an explicit
environment switch (`docs/RUNNER.md`). A capability this instance lacks is not offered: with the runner
disabled its five actions are absent from the list below and from `/api/actions`, rather than present
and failing, and asking for one anyway is refused with the named reason. The same rule applies to the
two **bounded file-edit** actions, which are disabled by default behind their own explicit switch, and
to the five **agent registry** actions, which need a durable control store.

### Session lifecycle — scope: `project` + `session`

| id | effect | writes |
|---|---|---|
| `session.lifecycle.reconnect` | reads the durable lifecycle record and returns it unchanged | no |
| `session.lifecycle.resume` | writes the running transition, then dispatches under the record's original request identity | yes |
| `session.lifecycle.retry` | writes a new attempt, then dispatches under an identity derived from the revision | yes |
| `session.lifecycle.stop` | asks the harness to cancel, then writes the idle transition | yes |
| `session.lifecycle.pause` | asks the harness to cancel, then writes the paused transition with its reason | yes |

Parameters: `revision` (required, the revision the caller read) and an optional `reason`.

A revision is the one value a caller cannot work out for itself, so each revision parameter declares
the read its value comes from (`revisionSource`): the five lifecycle actions read
`session-lifecycle-revision`, and `session.rename`, `session.link` and `session.unlink` read
`session-record-revision`. The palette pre-fills exactly the value of that read — the live projection
for a lifecycle action, the session list for a session-record action, re-read immediately before the
form is shown — and leaves the field empty for the caller to fill when that read fails. It never
falls back to `0`, because `0` is a real revision of a freshly recorded session and not a default.

### Session records

| id | scope | effect | writes |
|---|---|---|---|
| `session.create` | `project` | writes one new session record | yes |
| `session.rename` | `project` + `session` | writes one new revision with the new name | yes |
| `session.link` | `project` + `session` | writes one new revision with the resolved link | yes |
| `session.unlink` | `project` + `session` | writes one new revision with the link removed | yes |

### Legacy conversation migration — scope: none

| id | effect | writes |
|---|---|---|
| `session.migration.plan` | reads the projects and returns the deterministic plan | no |
| `session.migration.apply` | adopts each unregistered conversation as one named session | yes |

### Approvals — scope: none (the approval's own scope is a parameter)

| id | effect | writes |
|---|---|---|
| `approval.create` | writes one pending approval and returns it with its single-use nonce | yes |
| `approval.consume` | records the consumption and returns the exact target it authorised | yes |
| `approval.revoke` | writes the revocation receipt | yes |

### Reports — scope: none, read-only

| id | effect | writes |
|---|---|---|
| `doctor.report` | runs the read-only doctor and returns the report the CLI prints | no |
| `delivery.reconciliation.report` | reads the delivery ledger's reconciliation report | no |

### Queued inputs — scope: `project` + `session`

The durable queue of pending inputs (see `docs/QUEUE.md`): an ordered, revisioned list per named
session, with dispatcher claims and reconciliation against the durable transcript. The queue records
intent; the transcript stays authoritative for what was really submitted.

| id | effect | writes |
|---|---|---|
| `queue.read` | reads the queue with its revision, its entries and the bounds; dispatches nothing | no |
| `queue.append` | appends one input (text, images or both) at the tail | yes |
| `queue.edit` | replaces the text of one queued entry under a revision check | yes |
| `queue.reorder` | moves one entry to another position inside the queue | yes |
| `queue.remove` | removes one entry that is not in flight | yes |
| `queue.clear` | removes every settled and failed entry | yes |
| `queue.cancel` | withdraws one entry so it can never dispatch | yes |
| `queue.claim` | claims the queue's head entry for a named dispatcher, with a lease | yes |
| `queue.release` | gives a claimed entry back to the queue | yes |
| `queue.submit` | submits a claimed entry under its stable request identity | yes |
| `queue.reconcile` | compares one entry against the durable transcript, by that identity | yes |

`queue.claim` and `queue.submit` are the only queue actions that can cause a model request, exactly
as `session.lifecycle.resume` and `session.lifecycle.retry` do; `queue.claim` itself dispatches
nothing, and neither action commits, pushes, deploys, spends, provisions or publishes. Every other
queue action writes durable state and sends nothing anywhere.

### The bounded coding runner — scope: `project`

One typed job per submission: a fixed recipe from a closed allowlist, a workspace that must resolve
inside the registered project's own root, and bounded limits. Jobs are durable in the control store, one
operation per revision, and the store's unique index is the compare-and-swap that decides the claim race.
**This is containment, not a shell**: no command text, no arguments, no environment. See
[docs/RUNNER.md](RUNNER.md) for the container properties, the fail-closed rules and the honest limits.

| id | effect | writes |
|---|---|---|
| `runner.read` | reads one project's jobs, oldest first, with the allowlist and the bounds | no |
| `runner.submit` | writes one pending job from a validated request | yes |
| `runner.claim` | claims the oldest unclaimed job for a named owner, with a lease; establishes containment first | yes |
| `runner.run` | writes `running`, runs the job in one container, writes the bounded result and settles it | yes |
| `runner.settle` | settles one job from what the durable record proves, and executes nothing | yes |

`runner.run` is the only action in this registry that starts a process anywhere, and the only thing it
can start is one recipe's own argv inside a container the broker creates. It commits, pushes, deploys,
spends, provisions and publishes nothing.

### The acceptance record — scope: `project` (and `none` for the policy)

The durable completion record and the single-use, revision-bound acceptance of an artifact
(see [docs/ACCEPTANCE.md](ACCEPTANCE.md)): one frozen record per unit of work, its Markdown rendering
written inside the project's own tree, and the policy that decides who may accept which action class.

| id | effect | writes |
|---|---|---|
| `acceptance.read` | reads the policy in force and the project's completion records with their Markdown state and their acceptances | no |
| `acceptance.evidence.record` | validates and freezes one completion record, and renders it to Markdown inside the project | yes |
| `acceptance.accept` | writes one durable, single-use, revision-bound acceptance under the policy in force | yes |
| `acceptance.policy.update` | writes the next revision of the acceptance policy: the mode and one ask-or-full-auto decision per action class | yes |

`acceptance.accept` performs no commit, push, deploy, spend, provision or publish: it records the
decision and returns it. Nothing in this registry performs the thing an acceptance is about.

### Forks — scope: `project`, and `project` + `session` for the fork itself

A **fork** is one child session branched from a parent transcript at an exact cutoff entry, with its
own git worktree created from a recorded base commit (see [docs/FORKS.md](FORKS.md)). The child is
created **paused**, inherits nothing, and refuses to dispatch anything until an explicit resume.
These actions need the agent harness as well as the durable store: with the harness off they are
**absent** from the list below rather than present and failing.

| id | scope | effect | writes |
|---|---|---|---|
| `fork.create` | `project` + `session` (the **parent**) | creates the child transcript conversation up to the cutoff, adopts the child as a paused named session with no link, and creates the child worktree from the recorded base commit by one fixed `git worktree add` | yes |
| `fork.list` | `project` | reads the project's forks with the cutoff, worktree and paused-child rules and the bounds in force | no |
| `fork.resume` | `project` + `session` (the **child**, which is the fork's identity) | lifts the pause so the child may be dispatched into; it dispatches nothing itself | yes |
| `fork.discard` | `project` + `session` (the **child**) | removes the child worktree by one `git worktree remove` and closes the fork | yes |

None of the four commits, pushes, deploys, spends, provisions or publishes. `fork.create` never reads
the parent's working tree, never copies an uncommitted or staged change and never runs `git stash`;
`fork.resume` makes no model request and grants nothing. Whether an *active* child is dispatched into
is not an action of this registry in this build: the guarded dispatch lives in the fork store, and the
owner surface offers creation, listing, resume and discard. See `docs/FORKS.md` for the model, the
bounds and the honest limits.

### The agent registry and its privilege scopes — scope: none

An **agent** is a durable, revision-checked record with an explicit scope allowlist; see
`docs/AGENTS.md` for the model, the closed vocabulary and the governance rules. These five actions
create, read, change and archive one, and the enforcement the allowlist drives happens at **dispatch**,
not through any of them.

| id | effect | writes |
|---|---|---|
| `agent.list` | reads every agent with its revision and allowlist, the closed vocabulary with each description, the models this instance offers and the file-edit switch | no |
| `agent.read` | reads one agent and its durable audit trail: who changed it, what changed and when | no |
| `agent.create` | writes revision 1 of one agent from a validated draft | yes |
| `agent.update` | writes the next revision of one agent under a revision check | yes |
| `agent.archive` | closes one agent so it is never in force again, keeping every field it held | yes |

None of the five commits, pushes, deploys, spends, provisions or publishes, and none of them changes
what any running generation may do: an allowlist is read by the dispatch path on every tool call, and a
change takes effect there rather than here.

### The bounded file-edit capability — scope: `project`

Two actions expose the capability the `file_edit` scope governs. Both are **disabled by default**
behind an explicit environment switch, and while it is disabled they are **absent from the list below
and from `/api/actions`** rather than present and failing, exactly as the coding runner's are.

| id | effect | writes |
|---|---|---|
| `file-edit.read` | reads one project's proposed and applied changes, each with its diff, beside the mode in force | no |
| `file-edit.write` | records one bounded change inside the project's connected repository worktree, and writes the file only where the acceptance policy permits | yes |

`file-edit.write` in **propose-only** mode records the change and its diff and writes **no file at
all**; in **auto-apply** it writes the file atomically. The mode in force comes from the acceptance
policy rather than from an assumption. Neither action commits, pushes, deploys, spends, provisions or
publishes, and neither ever edits outside the connected worktree. See `docs/AGENTS.md`.

## Preconditions, action by action

Every code below is from the closed vocabulary. A request that trips one of them changes nothing.

**`session.lifecycle.reconnect`** — `SESSION_EXISTS` (the session is a live session of that
project), `REVISION_MATCHES` (a stale revision is a conflict). No-op: a reconnect always attaches
and changes nothing.

**`session.lifecycle.resume`** — `SESSION_EXISTS`, `REVISION_MATCHES`, `STATE_PAUSED_OR_INTERRUPTED`
("Only a paused or interrupted session can be resumed"), `INTERRUPTION_CERTAIN` (an interruption
whose effect cannot be proven idempotent is refused, and nothing is replayed), `DISPATCH_AVAILABLE`
(this instance can dispatch at all — otherwise the request is refused before any revision is
claimed).

**`session.lifecycle.retry`** — `SESSION_EXISTS`, `REVISION_MATCHES`, `STATE_FAILED` ("Only a
failed session can be retried"), `DISPATCH_AVAILABLE`.

**`session.lifecycle.stop`** — `SESSION_EXISTS`, `REVISION_MATCHES`. No-op: stopping a session that
is not running cancels nothing and returns the record unchanged.

**`session.lifecycle.pause`** — `SESSION_EXISTS`, `REVISION_MATCHES`, `STATE_RUNNING` ("Only a
running session can be paused"), `REASON_BOUNDED` (enforced by the parameter schema: 1-240
printable characters). No-op: pausing an already paused session changes nothing.

**`session.create`** — `PROJECT_REGISTERED`, `NAME_VALID` (schema-enforced: 1-80 characters, first
alphanumeric, letters, digits, space and `.`:-`), `NAME_UNIQUE`, `LINK_TARGET_RESOLVES`,
`SESSION_LIMIT` (fewer than 200 sessions per project).

**`session.rename`** — `SESSION_EXISTS`, `REVISION_MATCHES`, `NAME_VALID`, `NAME_UNIQUE`. No-op:
renaming to the name it already has.

**`session.link`** — `SESSION_EXISTS`, `REVISION_MATCHES`, `LINK_TARGET_RESOLVES` (the board holds
the task, the documentation store serves the path inside the roots, the workspace exists inside the
roots), `LINK_LIMIT` (fewer than 32 links). No-op: linking a link the session already has.

**`session.unlink`** — `SESSION_EXISTS`, `REVISION_MATCHES`. No-op: unlinking an absent link.

**`session.migration.plan` / `session.migration.apply`** — no precondition beyond the schema: a
project with no conversation and an already adopted session are no-ops, and a refusal is reported in
the report rather than thrown.

**`approval.create`** — `REQUEST_KIND_VALID`, `REQUEST_SCOPE_NAMED` (at least one dimension),
`REQUEST_TARGET_VALID` (exactly the fields its kind requires), `EXPIRY_IN_THE_FUTURE` (strictly in
the future, at most 60 minutes away).

**`approval.consume`** — `APPROVAL_EXISTS`, `SCOPE_EXACT` (dimension for dimension, not by
intersection), `KIND_MATCHES`, `TARGET_EXACT` (field for field), `APPROVAL_PENDING` (pending and
unexpired; revoked, consumed and expired are all refused).

**`approval.revoke`** — `APPROVAL_EXISTS`, `SCOPE_EXACT`, `APPROVAL_NOT_CONSUMED`. No-op: revoking
an already revoked approval.

**`runner.read`** — `PROJECT_REGISTERED`. No-op: a project with no coding jobs reads as an empty
list at the documented bounds.

**`runner.submit`** — `PROJECT_REGISTERED`, `RECIPE_ALLOWED` (one of the fixed allowlist: `test-run`,
`noop-probe`; an unknown one is refused by the published schema before the handler runs, so no command
line is composed from caller text), `WORKSPACE_IN_ROOT` (a relative path that resolves to an existing
directory inside the registered project root, with no symlink at any component; an absolute path, a
parent segment or a symlink is refused rather than resolved and rewritten), `LIMITS_BOUNDED` (every
limit inside its documented bound, refused rather than reduced), `RUNNER_JOB_LIMIT` (fewer than 50 jobs
per project).

**`runner.claim`** — `PROJECT_REGISTERED`, `JOB_CLAIMABLE` (the oldest job that is not terminal is
pending, or is claimed with an expired lease and so is reclaimable; a claim whose lease is live is never
stolen, and a running, settled or attention job is never claimed), `RUNNER_ENABLED` (the container
properties are established **before** the claim is written, so an instance that cannot contain a job
leaves it unclaimed and executes nothing anywhere).

**`runner.run`** — `PROJECT_REGISTERED`, `JOB_EXISTS`, `TRANSITION_LEGAL` (the job is claimed, so it can
run), `CLAIM_OWNED` (only the owner of the claim may run it), `LEASE_LIVE` (never on an expired lease),
`WORKSPACE_IN_ROOT` (resolved again at the moment it is mounted), `RUNNER_ENABLED` (the properties are
established and exact before the `running` state is written), `LIMITS_BOUNDED` (the runtime reports it
can enforce the job's limits). A conflict on the `running` write — a settle or another claim that got
there first — executes nothing at all.

**`runner.settle`** — `PROJECT_REGISTERED`, `JOB_EXISTS`, `TRANSITION_LEGAL` (the job is claimed or
running). No-op: a settled or attention job is returned unchanged at its own revision, and settling a
running job with no recorded result always answers with the named operator-attention state rather than a
refusal.

**`doctor.report`, `delivery.reconciliation.report`** — no precondition beyond the schema. A
diagnosis always answers: an invalid configuration or an unreadable lock is reported as data, not as
a refusal of the action.

**`fork.create`** — `PROJECT_REGISTERED` (with its own folder, which is the repository the child
worktree is added to), `SESSION_EXISTS` (the parent), `CUTOFF_EXISTS` (the parent transcript really
holds that entry id), `BASE_COMMIT_REAL` (a real commit of that repository; a value that is not one is
refused and no worktree is created), `TARGET_IN_FORK_ROOT` (a target that is one path component inside
the designated fork root, with no symlink and no parent segment), `TARGET_FREE` (nothing already
occupies it), `FORK_LIMIT` (fewer than 20 forks). A creation whose worktree or child session could not
be created after the transcript fork is recorded as a **named operator-attention state** in the
`failed` state rather than reported as a success or hidden.

**`fork.list`** — `PROJECT_REGISTERED`. No-op: a project with no live fork reads as an empty list at
the documented bounds.

**`fork.resume`** — `PROJECT_REGISTERED`, `FORK_EXISTS`, `REVISION_MATCHES`, `TRANSITION_LEGAL` (only
a paused fork can become active; a discarded fork is terminal and a failed one has to be resolved and
discarded first). No-op: resuming an already active fork returns the record unchanged at its own
revision.

**`fork.discard`** — `PROJECT_REGISTERED`, `FORK_EXISTS`, `REVISION_MATCHES`,
`TARGET_IN_FORK_ROOT` (the worktree path the *record* carries is still inside the designated fork
root; a record that says otherwise is refused as an escape and nothing is removed), `WORKTREE_CLEAN`
(the child worktree holds no uncommitted or untracked change, or the caller explicitly forces it — a
dirty worktree becomes the named operator-attention state `worktree-dirty` and is left exactly where
it is), `TRANSITION_LEGAL`. A worktree git will not remove or cannot report becomes
`worktree-remove-refused` or `worktree-unreadable`; nothing is ever forced implicitly. No-op:
discarding a fork whose worktree is already gone completes the discard and removes nothing.

**`agent.list`** — no precondition beyond the schema. No-op: a registry with no agent reads as an
empty list beside the full scope vocabulary.

**`agent.read`** — `AGENT_EXISTS` (the id names an agent this registry holds; an unknown one is
refused as not found).

**`agent.create`** — `AGENT_SCOPE_KNOWN` (every scope is one of the closed vocabulary and none is
repeated), `AGENT_MODEL_OFFERED` (the declared model is one this instance really offers), `AGENT_WORKSPACE_IN_PROJECT`
(the project scope is `{kind:'all'}` or a non-empty, duplicate-free set of registered project ids, with a subpath that cannot escape any allowed root), `AGENT_BUDGETS_BOUNDED`
(every budget is null or inside its documented bound), `AGENT_NAME_UNIQUE` (no live agent already carries
this name), `AGENT_CHANGE_PERMITTED` (the owner may create any agent, and an agent may not create one at
all).

**`agent.update`** — `AGENT_EXISTS`, `REVISION_MATCHES` (a stale revision is a conflict that writes
nothing), `AGENT_SCOPE_KNOWN`, `AGENT_MODEL_OFFERED`, `AGENT_WORKSPACE_IN_PROJECT`, `AGENT_BUDGETS_BOUNDED`,
`AGENT_NAME_UNIQUE`, `AGENT_CHANGE_PERMITTED` (the owner may change any scope; an agent may neither edit
its own record nor give another agent a scope it does not hold itself — checked against the allowlist the
change would leave in force, so widening in two steps is refused at the step that widens). An archived
agent is refused as a conflict: it is never changed again.

**`agent.archive`** — `AGENT_EXISTS`, `REVISION_MATCHES`, `AGENT_CHANGE_PERMITTED`. Archiving an
archived agent is a conflict.

**`file-edit.read`** — `PROJECT_REGISTERED`, `FILE_EDIT_ENABLED`. No-op: a project with no recorded
change reads as an empty list at the documented bounds.

**`file-edit.write`** — `PROJECT_REGISTERED` (with its own folder, which is the connected repository
worktree the change is contained to), `FILE_EDIT_ENABLED`, `FILE_EDIT_MODE_PERMITTED` (propose-only is
always permitted; auto-apply is refused while the acceptance policy in force is propose-only, because the
mode comes from that policy rather than being assumed), `FILE_EDIT_PATH_IN_WORKTREE` (relative, no
absolute prefix, no backslash, no empty, current or parent segment, no symlink at any component, no
generated or app-managed directory, and nowhere near the data root), `FILE_EDIT_BOUNDED` (the change,
and the file it would replace, are inside the documented byte cap; an oversize change is refused rather
than truncated). No-op: the same change recorded again is the same record, and it writes no second record
and no second file.

**`queue.read`** — `SESSION_EXISTS`. No-op: a session whose queue was never written reads at
revision 0 with no entries, which is the queue itself rather than an absence of one.

**`queue.append`, `queue.edit`, `queue.reorder`, `queue.remove`, `queue.clear`, `queue.cancel`** —
`SESSION_EXISTS`, `REVISION_MATCHES` (a stale revision is a conflict that writes nothing), plus
their own rule. `queue.append` — `QUEUE_BOUNDED` (fewer than 50 entries, and the record inside its
64 KiB bound). `queue.edit` — `ENTRY_EXISTS`, `ENTRY_EDITABLE` (only a queued entry's text is
editable). `queue.reorder` — `ENTRY_EXISTS`, `POSITION_IN_QUEUE` (0 to the number of entries minus
one), `IN_FLIGHT_PRESERVED` (an entry that is claimed or submitted is the queue's effective head
until it settles or is explicitly reconciled, so a move that would put a later input ahead of it is
refused). `queue.remove` — `ENTRY_EXISTS`, `ENTRY_REMOVABLE` (queued, cancelled or failed: removing
an entry in flight could lose a claim or a submission; a claimed entry is released first).
`queue.clear` — no rule beyond the revision; a queue with nothing settled or failed is a no-op at the
same revision. `queue.cancel` — `ENTRY_EXISTS`, `TRANSITION_LEGAL` (a queued or failed entry can be
cancelled. A claimed entry cannot: a submission of it may be in flight, so its claim is released
first. A submitted entry cannot either, because its input may already be in the transcript; settled
and cancelled are terminal). A cancel can therefore never withdraw an entry whose submission the
transcript already holds.

**`queue.claim`** — `SESSION_EXISTS`, `HEAD_CLAIMABLE` (the head is waiting, or this owner already
holds it, or its lease has expired so it is reclaimable; a claim whose lease is live is never stolen
— the lease is the only liveness evidence this build has — and a head awaiting reconciliation is
never skipped over), `DISPATCH_AVAILABLE` (the harness is enabled and the project is registered —
asked before any claim is written). The claim records the intent and the stable request identity it
authorises in one revision, before any submission starts.

**`queue.release`** — `SESSION_EXISTS`, `ENTRY_EXISTS`, `CLAIM_OWNED` (only the claim's owner may
give it back), `TRANSITION_LEGAL` (the entry is claimed).

**`queue.submit`** — `SESSION_EXISTS`, `ENTRY_EXISTS`, `CLAIM_OWNED`, `LEASE_LIVE` (the queue never
submits on an expired lease), `TRANSITION_LEGAL` (the entry is claimed), `DISPATCH_AVAILABLE`. The
submission is made under the stable identity the claim recorded. A submission the dispatcher does
not report back is resolved from the durable transcript, never recorded as a refusal: it settles the
entry on a match, and the transcript's own answer (absent, mismatched or unreadable) otherwise.

**`queue.reconcile`** — `SESSION_EXISTS`, `ENTRY_EXISTS`, `TRANSITION_LEGAL` (the entry is claimed,
submitted or failed). No-op: a reconciliation always answers — an entry the transcript cannot be
matched against becomes a named operator-attention state rather than a refusal, and nothing is
re-sent. It reads by the identity the record holds, and that same read is what decides a submission
the port did not report back.


**`acceptance.read`** — `PROJECT_REGISTERED`. No-op: a project with no completion record and no
written policy reads as an empty list of evidence with the documented default policy (owner-only,
every class asking) at revision 0, which is that project's acceptance state rather than an absence of
one.

**`acceptance.evidence.record`** — `PROJECT_REGISTERED`, `SESSION_EXISTS` (a record that names a
session must name a live session of that project), `EVIDENCE_SOURCE_READABLE` (a claimed count has a
recorded output to be checked against: present and inside the documented 8192 byte bound. An output
that is absent or carries no count line becomes a named absence instead — the reason is stored, never
a zero), `EVIDENCE_HONEST` (every result names a command the record says was run, no claimed count
contradicts the count lines of its own recorded output, no result claims a pass or fail count for a
command it also says was not run, the outcome agrees with the counts its own output carries — `passed`
beside a failure and `failed` beside a run with no failure are refused — and a `not-run` command stores
the named absence `command-not-run` instead of counts no run of it produced), `DIFF_BOUNDED` (the diff carries a complete summary and the full
diff either inlined inside its 16384 byte bound or referenced by a contained relative reference). No-op:
recording the same evidence again is the same record, and it rewrites that record's Markdown, which is
how a file a crash never wrote is repaired.

**`acceptance.accept`** — `PROJECT_REGISTERED`, `EVIDENCE_EXISTS` (the evidence id names a
completion record of that project; an unknown one is 404), `ARTIFACT_UNCHANGED` (the revision and
commit the request accepts are exactly the ones the evidence was produced from, so accepting an
artifact that has changed since the evidence was produced is refused and needs new evidence),
`ARTIFACT_NOT_ACCEPTED` (single use: a second acceptance, in this process, from another handle, or
after a crash and reopen, is refused and names the acceptance that already exists),
`ACCEPTOR_PERMITTED` (under `owner-only` an agent acceptance is refused outright, and the owner
accepts instead), `ACTION_CLASS_DECIDED` (the owner may always decide a class; an agent only where
the policy sets that class to `full-auto`, so a class set to `ask` needs the owner's decision).

**`acceptance.policy.update`** — `REVISION_MATCHES` (the revision the caller read is the policy
revision in force), `POLICY_OWNER_ONLY` (the actor is the owner: the policy that decides what an agent
may accept is not something an agent may set).

## Surfaces

The closed set of surfaces is `slash`, `palette`, `button`. In this build the **palette** is the
only declared surface, so every action declares `['palette']` and nothing declares a surface that is
not declared by the registry.

The composer nonetheless offers a **slash surface**, and it is driven by this same registry rather
than by a second list:

- the composer asks `/api/actions` for the actions the current project and session scope may use and
  offers the ones whose declared `surfaces` include `'slash'`; because this build declares none, the
  documented fallback is **every action the server offered in scope**, which is still the registry's
  own list. When a later build adds `'slash'` to an action, the composer picks it up with no client
  change. See `src/client/slash.ts`.
- typing `/` opens the list; the text after `/` filters it by the descriptor's `id` and `label`;
  the chosen action runs through the same `/api/actions/execute` path the palette calls, in the
  composer's own scope, and the server's own result or refusal is shown in its own words.
- only implemented actions appear, because only implemented actions are in the registry at all.

A per-action **button** surface can be added later; when it is, the action that it really offers
declares it.

## What is deliberately absent

A capability that is planned but not implemented is **absent from the registry**, not present and
failing. There is no placeholder, no TODO and no "coming soon" entry, and there is no action that
would refuse because its handler is a stub. Concretely, this build has no action for a commit, a
push, a deploy, a spend, a provision, a publish, a release, a preview, an import, a board edit or a
fork — even though several of those have supporting storage already. They are absent because no handler
implements them.

The bounded coding runner is the one capability that *is* declared but is not offered by default: its
five actions exist because their handlers exist, and they are withheld from every instance that has not
explicitly enabled the runner. That is an availability decision, not a stub — with the switch on the
same handlers really submit, claim, run and settle jobs.

Approvals record an authorisation and never perform the thing authorised: `approval.consume` returns
the exact target it spent the grant on. Performing a commit, push, deploy, spend, provision or
publish stays a separate, explicit step that no action in this registry takes.

## The live projection

`GET /api/actions/activity?projectId=<uuid>` answers what is actually happening, read-only. Its
contract is declared in `src/shared/actions.ts` beside the registry, so the producer and the reader
cannot disagree about a field.

- **Run state per session comes from the durable lifecycle — and an absent row is reported as an
  absence.** A session the store holds a lifecycle row for reports that record: state, attempt,
  revision, reason and uncertainty, so a fresh client reads the same truth as any other. A session
  with **no** durable row is reported with `recorded: false`, a named `absenceReason`
  (`no-durable-lifecycle-record-yet`), its `absenceDetail` sentence, `state: null` and no instant.
  The store *reads* such a session at its deterministic initial record (`idle` at revision 0), but that
  is a legal value to write *at*, not a fact about a generation, so it is never reported as the state
  `idle`. `revision` is `0` there because a first write must claim revision 0, not because one
  happened.
- **Tool activity is only ever what the harness reports.** The projection reads the project's
  conversation view and reports the tool calls it carries and the diagnostic counts each result
  carries. Nothing is invented to fill the view.
- **A call and a result are not paired.** The view this build can read does not carry the call id, so
  calls and results are reported as two ordered lists. No outcome is attributed to a call the data
  does not attribute it to.
- **Not knowing is a state, not an absence**, and the three non-answers are distinct:

  | `state` | means | `reason` |
  |---|---|---|
  | `reported` | the harness reported tool activity | `null` |
  | `none` | the harness reported a conversation whose view carries no tool activity yet | `no-tool-activity-reported-yet` |
  | `no-conversation` | the harness reported no conversation at all, so there was nothing to read | `no-conversation-reported` |
  | `unavailable` | this instance cannot read the harness at all | `agents-disabled-on-this-instance` |
  | `failed` | the read was attempted and failed | `harness-could-not-be-read` |

  The first two absences are deliberately different states: "there is no conversation" is not
  "the conversation has nothing in it yet", and neither is reported as the other. Reported activity
  is reported whatever else is true, so a view that carries tool calls is never described as an
  absence.

  A failed read reports fixed text: a harness error may name a filesystem path, so it is never echoed
  into the payload.
- **The payload is bounded and carries no path, token, request identity or conversation text.** A
  call is a name and an instant (never its arguments), a result is its diagnostic counts and the
  outcome they imply, and the two caps (200 sessions, 50 tool events per list) are echoed in
  `limits` with a `truncated` flag when they bite.
- **The owner can see it.** The palette renders this projection under *Live projection*: the run state
  of the chosen session (or of the first few registered ones), and the tool activity or the named
  absence the payload carries. It shows only what the payload contains — it adds no row for a session
  the projection reports nothing about, and it presents an absence as the named absence it is.

One honest caveat: reading the conversation view **attaches** that conversation exactly as the
Agents view does, because this build exposes no other surface for reading tool activity. The
projection writes no record of its own, replays nothing and acknowledges nothing; the payload names
its source (`harness-conversation-view`) so the reader knows what was read. With the harness off,
nothing is attached at all.

## The routes

| Route | Method | What it does |
|---|---|---|
| `/api/actions` | GET | the implemented actions the caller can use in its scope (`?projectId=`, `?sessionId=`). Read-only. |
| `/api/actions/activity` | GET | the live projection for one project (`?projectId=<uuid>`, required). Read-only. |
| `/api/actions/execute` | POST | executes one action: `{ "id": "...", "params": {...}, "scope": {"projectId": "...", "sessionId": "..."} }`. |
| `/api/sessions/:id/queue` | GET | the session's queue with its revision, entries and bounds (`?projectId=` required). Read-only. |
| `/api/sessions/:id/queue/:operation` | POST | the ten queue writes — `append`, `edit`, `reorder`, `remove`, `clear`, `cancel`, `claim`, `release`, `submit`, `reconcile` — each with its own body, statuses and refusals (`docs/QUEUE.md`). |
| `/api/projects/:id/runner/jobs` | GET | the project's coding jobs, the recipe allowlist and the documented bounds. Read-only, and refused while the runner is disabled. |
| `/api/projects/:id/runner/jobs` | POST | submits one coding job: `{ "recipe": "...", "workspace": "...", "limits": { ... } }`. |
| `/api/projects/:id/runner/jobs/claim` | POST | claims the next coding job for one owner: `{ "owner": "..." }`. |
| `/api/projects/:id/runner/jobs/:jobId/run` | POST | runs the coding job that owner holds: `{ "owner": "..." }`. |
| `/api/projects/:id/runner/jobs/:jobId/settle` | POST | settles one coding job from its durable record. |
| `/api/acceptance` | GET | the policy in force and one project's completion records, each with its Markdown state and its acceptance (`?projectId=`, required). Read-only. |
| `/api/acceptance/policy` | GET | the acceptance policy in force, with its revision and whether it is a stored row or the documented default. Read-only. |
| `/api/acceptance/policy` | POST | writes the next policy revision: `{ "revision": n, "policy": { "mode": "...", "actionClasses": { ... } } }`. Owner only. |
| `/api/acceptance/evidence` | POST | records one completion record and writes its Markdown: `{ "projectId": "...", "evidence": { ... } }`. |
| `/api/acceptance/accept` | POST | accepts one artifact exactly once: `{ "projectId": "...", "request": { ... }, "actor": { ... } }`. The actor may be declared beside the request or inside it (`request.actor`), which is the shape the registry publishes; both are honoured, two that disagree are refused 422, and only a body that declares none is the authenticated owner. |
| `/api/projects/:id/forks` | GET | the project's forks, with the cutoff, worktree and paused-child rules and the bounds in force. Read-only, and refused (503) while the instance has no fork capability. |
| `/api/projects/:id/forks` | POST | creates one fork: `{ "parentSessionId": "...", "baseCommit": "<40 hex>", "cutoffEntryId": n, "target": "..." }`. The parent session is named in the body because the fork is created *from* it; a 201 means the fork really exists, and a 200 with `created: false` carries the named operator-attention state instead. |
| `/api/projects/:id/forks/:childSessionId/resume` | POST | lifts the pause on one fork: `{ "revision": n }`. The child session in the path **is** the fork's identity, so a caller addresses a fork and never a path. |
| `/api/projects/:id/forks/:childSessionId/discard` | POST | removes one fork's worktree and closes it: `{ "revision": n, "force": false }`. The worktree is the one the durable record carries, re-checked against the designated fork root; without `force` a dirty worktree is never removed. |
| `/api/agents` | GET | the agent registry: every agent with its revision and allowlist, the closed scope vocabulary with each description, the models this instance offers and the file-edit switch with the mode in force. Read-only. |
| `/api/agents` | POST | creates one agent: `{ "draft": { ... }, "actor": { "kind": "owner", "identity": "..." } }`. A 201 carries the record at revision 1. |
| `/api/agents/:id` | GET | one agent and its durable audit trail: who changed it, what changed and when. Read-only. |
| `/api/agents/:id/update` | POST | writes the next revision of one agent: `{ "revision": n, "patch": { ... }, "actor": { ... } }`. |
| `/api/agents/:id/archive` | POST | closes one agent so it is never in force again: `{ "revision": n, "actor": { ... } }`. |
| `/api/projects/:id/file-edits` | GET | one project's proposed and applied file edits, each with its diff, beside the mode in force. Read-only, and refused (503) while the capability is disabled. |
| `/api/projects/:id/file-edits` | POST | records one bounded change: `{ "request": { "agentId": null, "path": "...", "content": "...", "mode": "propose-only" }, "actor": { ... } }`. The path must stay inside the project's connected repository worktree; `written` in the answer says whether a file was really written. |

All three sit behind the same owner-only authentication as every other route, behind the unchanged
Host check, and the write carries the same origin and CSRF enforcement. The scope may be supplied in
the query for the two reads and in the body for the execution; a scope dimension an action requires
and the request omits is a **scope violation**, refused before any parameter is looked at.

Execution refuses in order — an id that does not exist, an action this instance cannot perform, a
scope the request does not satisfy, parameters the published schema does not accept — and then runs
the handler:

| Refusal | Status | `code` |
|---|---|---|
| an unknown action id | 404 | `UNKNOWN` |
| an action this instance cannot perform (no durable control store) | 503 | `UNAVAILABLE` |
| a scope violation (a required dimension is missing) | 403 | `SCOPE` |
| a scope or parameter an identifier/type does not accept | 422 | `INVALID` |
| the handler's own refusal | the status it has everywhere else (404 not found, 409 conflict, 422 invalid, 403 outside the roots or scope) | — |

A handler's refusal keeps its own words and its own status: a stale revision is still
`409 ... is at revision 1, not 99`, a duplicate name is still `409 ... already has a live session
named ...`, a queue at its documented bound is still `409 ... its documented maximum of 50 entries`,
and an unknown session is still `404`. The registry never rewrites them.

The runner routes are the same shape for the coding runner: they call the same broker methods the
`runner.*` handlers call, so the two cannot disagree about what an operation does. While the runner is
disabled the routes refuse with a named reason (503) — and the actions are absent from the registry
rather than listed and failing.

The queue routes are the second surface over the same store methods the `queue.*` handlers call, so
the two cannot disagree about what an operation does: the registry is where the palette finds them,
and the routes are what a script or a dispatcher calls directly.

The fork routes are the same shape one more time: they call the same store methods the `fork.*`
handlers call, so the two cannot disagree about what an operation does. The fork a write acts on is the
one in the path — its child session, which is the fork's identity — so a caller addresses a fork and
never a path, and the worktree it removes is the one the durable record carries. While the instance has
no fork capability (the agent harness is off) the routes refuse with a named reason (503) and the
actions are absent from the registry rather than listed and failing. The queue's own claim and submit
routes refuse a **fork child** (409) rather than dispatching its input into the project's root
conversation: this project's queue dispatcher submits into the root conversation, so a child's queued
input would reach the wrong transcript entirely. See `docs/FORKS.md`.

The acceptance routes are the same shape again: they call the same store methods the `acceptance.*`
handlers call. The policy write always acts as the authenticated owner. The acceptance write takes the
actor the body **declares** — beside the request or inside it (`request.actor`), the shape the registry
publishes for `acceptance.accept` — and takes the authenticated owner only when the body declares no
actor at all; a body that declares both and disagrees is refused 422, so which identity is accepting is
never ambiguous and a declared agent is never silently recorded as the owner. The completion record's
Markdown is written inside the project the scope names, and the state the answer reports is the file
read back rather than assumed.

The agent routes and the file-edit routes are the same shape as the rest: they call the same store
methods the `agent.*` and `file-edit.*` handlers call, so the two cannot disagree about what an
operation does. The registry route is the one the management view reads, and it serves the vocabulary,
the offered models and the projects so the view offers exactly what the server would accept. The
management view is **not** the enforcement point: it can be bypassed with a direct request, and the
allowlist is enforced at dispatch. While the bounded file-edit capability is disabled the routes refuse
with a named reason (503) and the actions are absent from the registry rather than listed and failing.
See `docs/AGENTS.md`.

## The palette

The palette is opened with **⌘K** (or **Ctrl K**) from the shell, or from *Board actions →
Commands…*. It is driven entirely by the registry: it asks the server which actions the
authenticated caller may use in its scope and renders exactly those, with their ids, descriptions,
parameters and preconditions. Nothing in the client lists a capability of its own.

- While a text field, select or contenteditable element has focus, the shortcut does **not** open the
  palette: typing in a document, a task or the search field is never swallowed.
- The list filters by label and by id, the highlighted entry is moved with the arrow keys and chosen
  with Enter, and Escape closes the palette.
- An action with no parameters runs immediately; one with parameters shows its form first. Nothing is
  pre-filled with a value the caller did not type — only the revision, and only with the value the
  server reported for the read the descriptor names (the live projection or the session list, re-read
  as the form opens). When that read fails, the field stays empty and a required field left empty is
  refused in the palette with the parameter's own description: the palette sends no number it did not
  read.
- A nested payload — a link, a list of links, a declared model choice, an approval scope or an
  approval target — is entered as JSON text and parsed in the palette before the call, so the value
  the registry publishes is the value the handler receives; an unparsable one is refused here.
- The handler's result is shown as the JSON it returned; a refusal is shown as the server's own words
  with its status. Nothing is swallowed and nothing is retried silently.

## Tests

- `tests/server/agent-store.test.ts` — the agent registry itself, over a disposable root and its
  own control store: the closed scope vocabulary with one description per scope; **default deny**, with
  a tool this build declares no scope for refused for every agent; strict validation refusing an unknown
  field, an unknown scope, a repeated scope and a malformed actor; a duplicate live name, a model this
  instance does not offer and an unregistered workspace each refused with nothing written; a subpath that
  could escape the project root and a budget outside its bound refused rather than normalised or
  reduced; **an agent may not widen its own scopes, may not create another agent, and may not give
  another agent a scope it does not hold itself**, while the owner may widen to any scope; one operation
  per revision with a stale revision refused and the durable audit trail naming who changed what and
  when; archiving closing an agent, freeing its name and taking it out of force; and the scopes in force
  for a project when more than one enabled agent names it.
- `tests/server/file-edit-tool.test.ts` — the bounded file-edit capability, over a disposable root,
  its own worktree and its own data root: **propose-only records the change and its diff and writes no
  file at all**; auto-apply writes the file and records the same diff, and an explicit auto-apply is
  refused while the acceptance policy in force is propose-only; traversal, an absolute path, a
  backslash, an empty, current or parent segment, **a symlink at a parent or a final component** and a
  generated directory are each refused with nothing written; an oversize change and a file already over
  the cap are refused rather than truncated; a project with no connected worktree is refused; the tool
  is disabled by default and refuses everything while recording nothing; the diff is deterministic,
  bounded and states its own truncation; and every recorded change is one durable operation with the
  actor it names.
- `tests/browser/agent-manager.spec.ts` — the management view: it is reachable from the existing
  navigation, creates an agent with two assigned scopes beside their descriptions, shows the enabled
  state and the scope summary in the list, confirms through the registry route that the record is
  durable, and shows the server's own refusal **beside the field it names** when a duplicate live name
  is submitted — with the registry still holding exactly one agent. It also shows the honest note that
  the bounded file-edit capability is disabled on that instance.

- `tests/server/action-registry.test.ts` — the registry and its handlers are the same closed set;
  every declared action is driven through the registry and really acts; the published schema rejects
  an unknown field and enforces every required parameter; every revision parameter declares the read
  it comes from; the declared scope is enforced; an unknown id and an unavailable action are refused;
  every precondition code matches a refusal the handlers really produce; the declared model choice is
  recorded when it is sent in its declared shape and refused when it is sent as a bare string; every
  one of the eleven `queue.*` actions is driven through the registry and really acts, its queue
  revision parameter declares the queue read it comes from, and a claim is refused before the instance
  that cannot dispatch is asked to; the live projection distinguishes `none`, `no-conversation`,
  `unavailable` and `failed`, reports a session with no lifecycle row as an absence rather than as
  `idle`, never invents an entry and declares exactly the contract fields; all four `fork.*`
  actions are driven through the registry against synthetic ports, with a paused child refusing a
  dispatch the port never sees; and all seven new actions are driven through the registry, with the
  eleven new precondition codes each matching a refusal a handler really produces.
- `tests/server/http.test.ts` — the routes are owner-only, behind the Host check and the origin
  check; the registry lists only what the instance implements; executing a real action really writes;
  an unknown id and a scope violation are both refused; the projection is path-free and names an
  absent lifecycle row as an absence; the queue routes are owner-only, behind the Host check and the
  origin check, with precise statuses for a stale revision, an unknown entry, a position outside the
  queue, an empty entry, an unknown field, an image the media store does not hold and a dispatcher that
  cannot dispatch; and the flow the palette really performs is driven end to end: the revision is read
  from `/api/actions/activity` and a lifecycle write at that revision succeeds, while the revision a
  client would have assumed is refused as a conflict. The fork routes are driven end to end against a
  real disposable repository and the instance's own harness: the child worktree is created from the
  recorded commit and does not carry the parent's dirty sentinel, the cutoff holds, a paused child
  refuses, a dirty worktree needs an explicit `force`, and a stale revision or an escaping target
  changes nothing.
- `tests/server/queue.test.ts` — the durable queue itself, over a disposable root and a synthetic
  dispatcher: persistence across a close and reopen with the same order and revision; a stale revision
  refused with the record unchanged; unknown fields, empty entries, positions outside the queue and
  illegal transitions refused; two concurrent claims with exactly one winner, a claim whose lease is
  live never stolen and one whose lease has expired reclaimed; every crash window reconciling to
  exactly one submission without re-sending; a cancel raced against a submission in flight, and a
  release raced against one; a reorder that would skip an entry in flight, refused by the reorder and
  by the stored record; a mismatched, absent or unreadable transcript becoming a named
  operator-attention state that never asserts a refusal; a cancelled entry never dispatching and a
  settled entry never being re-dispatched; and the documented bounds. See `docs/QUEUE.md`.
- `tests/server/runner-broker.test.ts` — the durable coding runner over a disposable root and a
  synthetic port: validation refusals, a claim race with exactly one winner, a crash mid-run reconciling
  to a named operator-attention state without a rerun, a settled job that is never run again, output
  truncated at the byte cap, the wall clock enforced by the broker, a job refused — and left unclaimed —
  when the container properties cannot be established (with the port's execute never called), durability
  across a close and reopen, and the real port's command line asserted flag by flag against a fake
  binary. **No container is started in this suite.** See `docs/RUNNER.md`.
- `tests/server/acceptance-store.test.ts` — the durable acceptance record over a disposable root: the
  default policy reported as a default, policy validation against closed sets, the policy changeable
  only by the owner and revision-checked, contradictory counts refused with the numbers named, an
  outcome that contradicts the counts its own output carries refused in both directions, a not-run
  command stored as the named absence `command-not-run` instead of counts, an unreadable count stored
  as a named absence, the diff bound, the same evidence recording once and a
  changed revision recording a different record, an agent acceptance refused under owner-only and
  permitted under agent-may-accept with the permitting rule recorded, a class set to ask needing the
  owner's decision, an artifact that changed since its evidence refused, single use enforced after a
  crash and reopen and from a second handle, and the Markdown record written with the expected fields
  and reported rather than trusted after a hand edit, and a write whose file cannot be rendered
  reporting the real, non-current state instead of a state it never verified. See `docs/ACCEPTANCE.md`.
- `tests/server/fork-store.test.ts` — the forks themselves, over a disposable root, a real disposable
  git repository and the application's own harness with its synthetic provider: the strict fork record
  and every figure it refuses; the cutoff rule (the child sees the parent context up to and including
  the cutoff entry and nothing the parent recorded after it, proved against the real transcript fork);
  the sentinel proof (an untracked, unstaged file and a staged change left in the parent worktree are
  absent from the child, the parent is untouched, `git stash list` is empty, the child is clean and at
  the recorded base commit); a paused child refusing to dispatch with the transcript port never called;
  an explicit resume dispatching nothing; no inherited approval, accepted artifact, link, declared model
  or queue, with the parent's approval still pending and the parent's queue untouched and unclaimed; a
  discard refusing a dirty worktree, succeeding with `force`, refusing a stale revision without
  mutating anything, completing when the worktree is already gone, and refusing a record whose path is
  outside the fork root with nothing removed; every creation refusal (an unreal base commit, an absent
  cutoff, an unknown parent, an escaping or symlinked target, a taken target) creating nothing; the
  documented fork bound; and a stored record that does not validate read as corruption. **No real
  provider is called and no container is started in this suite.** See `docs/FORKS.md`.
- `tests/browser/actions.spec.ts` — the palette opens from the keyboard, lists exactly the registry's
  actions for its scope, executes real actions, shows the handler's results and shows a refusal;
  a declared model choice is parsed in the palette and recorded by the handler; a revision-bound action
  on a session that already holds a revision above zero succeeds; the live projection is rendered with
  the server's own named reasons, including the absence of a lifecycle row; and with the projection
  unreadable the palette leaves the revision empty and refuses to send one.
