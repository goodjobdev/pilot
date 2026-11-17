# Agents and privileges

An **agent** is a durable record: a stable id, an owner-visible name, a description, an enabled flag,
a declared model, a workspace scope, bounded budgets and an explicit **scope allowlist**. The allowlist
is what the agent may do, and everything it does not name is refused.

The record lives in `src/shared/agent-registry.ts` (the pure model and the closed vocabulary), the
durable half is `src/server/state/agent-store.ts`, the capability `file_edit` governs is
`src/server/state/file-edit-tool.ts`, and the management view is `src/client/AgentManager.svelte`.

## The record

| Field | Meaning |
|---|---|
| `id` | The stable id. Generated once, never changed. |
| `name` | 1-80 characters, first character alphanumeric. Unique among the **live** agents; an archived agent's name is free again. |
| `description` | Up to 400 characters of printable text. May be empty. |
| `enabled` | Whether the agent is in force at all. A disabled agent grants nothing. |
| `model` | `{provider, modelId}`, and it must be **one of the models this instance really offers**. A model outside that set is refused, so an agent can never declare a model that cannot run here. |
| `workspace` | `{scope, subpath}`, where `scope` is one of two explicit shapes: `{kind:'all'}` (every registered project) or `{kind:'projects', projectIds}` (an explicit, non-empty set). Every named project must be registered, and the subpath is relative inside **each** allowed project's own root: an absolute path, a backslash, an empty, current or parent segment is refused rather than normalised. An empty set is refused, never widened to `all`, and a duplicate project id is refused. |
| `budgets` | `maxRequests`, `maxOutputTokens` and `maxJobsPerHour`, each `null` or a whole number inside its documented bound. A value outside its bound is refused, never reduced. |
| `scopes` | The allowlist: a subset of the closed vocabulary below, canonicalised into the vocabulary's own order. |
| `revision` | The optimistic-concurrency token. Every change is one revision, and a stale revision is a conflict that writes nothing. |
| `archived` | Set once by `agent.archive`. An archived agent keeps every field it held, is never in force, and is never changed again. |
| `updatedBy`, `updatedAt` | Who made the last change, and when. |

Every write is **one control-store operation per revision**, keyed `agent.r<revision>` inside the
agent's own bucket, with the operation's outbox row as the evidence of the write. That is what makes
the revision a real compare-and-swap: two writers at the same revision race, and the loser is refused
by the store's own unique index rather than merging. No second persistence is introduced.

## The scope vocabulary

The vocabulary is **closed**. A value outside it is refused rather than ignored, and each scope has
exactly one description, which is the description the interface shows beside its checkbox.

| Scope | What granting it allows |
|---|---|
| `read_notes` | Read this project's notes file back. |
| `record_note` | Append one line to this project's notes file. |
| `ask_question` | Ask the owner one question and end the turn until it is answered. |
| `read_docs` | Browse project Markdown documents and read the planning board. |
| `write_docs` | Create or update planning tasks, dependencies and milestones. |
| `file_read` | Read a file inside the project's connected repository worktree. |
| `file_edit` | Propose or apply one bounded edit to a file inside the project's connected repository worktree. |
| `file_write` | Directly write or edit files through the coding tools. |
| `shell` | Run commands as the application user through the coding shell. |
| `run_tests` | Run this project's fixed `node --test` recipe as the application user. It is not a sandbox: the tests can read stored credentials and every project and can modify this project. |
| `fork` | Branch a transcript, create a paused child worktree, and send one input into an active child that this conversation parented. |
| `accept` | Accept a completion record under the acceptance policy in force. |
| `commit` | Commit the exact staged tree to the project's fixed Pilot branch, under the acceptance policy. Never pushes. |
| `push` | Push one accepted commit to the project's owner-configured local remote, without force. |
| `deploy` | Promote the project's built artifact into the owner-configured local deployment directory, retaining the previous generation. |
| `spend` | Charge one metered amount against the owner-configured billing endpoint, within its caps. This build has no live billing target configured. |
| `provision` | Create one Pilot-owned local resource directory with a bounded manifest under the owner-approved root. This build provisions no infrastructure. |
| `publish` | Copy reviewed files into the owner-configured local publication root. |

The authoritative tool-to-scope mapping is `AGENT_TOOL_SCOPES`. A scope can be granted only for
an installed capability; a declaration alone does not install an action. Installation also depends
on the instance switches and control store.

## Tool installation status

| Scope | Model-facing tools | Availability |
|---|---|---|
| `ask_question`, `record_note`, `read_notes` | Question and note tools | Installed |
| `read_docs`, `write_docs` | Planning and board tools | Installed |
| `file_read`, `file_write` | `read`, `write`, `edit` | When coding tools are enabled |
| `shell` | `bash` | When the coding shell is enabled |
| `file_edit` | `file_edit` | When bounded file editing is enabled |
| `accept` | `acceptance_read`, `acceptance_accept`; optionally `acceptance_record` | With a control store; requires a named bound agent. Evidence recording requires the default-off deployment switch. |

| `fork` | `fork_context`, `fork_create`, `fork_dispatch` | With a control store and enabled agent harness |
| `run_tests` | `run_tests` | When the local test runner is enabled (`DASHBOARD_TEST_RUNNER=on`). Requires a named agent bound to the session, the `run_tests` scope and the project in its project grant. |
| `deploy` | `deploy_preview`, `deploy_accepted` | Default off (`DASHBOARD_DEPLOY=on`). Promotes the project's configured built artifact into the owner-configured local directory; requires a bound named agent, the `deploy` grant and evidence accepted for `deploy` under `full-auto`. |
| `publish` | `publish_preview`, `publish_accepted` | Default off (`DASHBOARD_PUBLISH=on`). Copies reviewed files into the owner-configured publication root; same authority and policy requirements. |
| `provision` | `provision_preview`, `provision_accepted` | Default off. Installed only with a control store, `DASHBOARD_PROVISION_ACTIONS=on` and an owner-approved root; requires a bound named agent, the `provision` grant, and evidence accepted for `provision` under `full-auto`. |
| `spend` | `spend_preview`, `spend_accepted` | Default off. Installed only with a control store, `DASHBOARD_SPEND_ACTIONS=on`, an owner-configured billing endpoint and credential, one fixed currency and both caps; requires a bound named agent, the `spend` grant, and evidence accepted for `spend` under `full-auto`. |
| `commit` | `commit_preview`, `commit_accepted` | Default off (`DASHBOARD_AGENT_COMMIT=on`). Commits the exact staged tree to the project's fixed Pilot branch after evidence accepted for `commit` under `full-auto`; never stages or pushes. |
| `push` | `push_preview`, `push_accepted` | Default off (`DASHBOARD_AGENT_PUSH=on`). Pushes one accepted commit, without force, to the owner-configured local remote; no hosted credential integration. |


The shell runs as the application user without a per-agent sandbox; it can reach same-user
credentials and may perform actions outside these separately named scopes. Grant it only when that
access is intended. The `run_tests` tool runs the fixed recipe the same way: a child process of the
application with no container, no cgroup memory or PID limit, and a best-effort process-group stop.
It can read `<data>/credentials/`, the durable store and every project. Grant it only where that is
intended. The acceptance tools record decisions; they do not perform the accepted action.

A scope whose tool is not installed remains in the vocabulary, but the agent cannot call it.
Settings disable new unavailable grants and preserve existing ones unless the owner removes them.
The UI and prompt distinguish a grant from an installed tool. Planning does not require enabling
`file_edit`; see [Agent planning tools](PLANNING-TOOLS.md) for the bounded document/board workflow.

An agent whose granted scopes include uninstalled-tool scopes is told which ones are usable and
which ones are unavailable, with the reason.

## Default deny, and exactly where it is enforced

**An agent has only what its allowlist names, in only the projects its project scope names.**
`authorizeToolUse` decides the scopes, and the dispatch path decides the projects; together they are
default-deny on both axes. `authorizeToolUse` decides two things:

- a tool this build declares **no** scope for is refused for every agent, so a tool added later is
  unreachable until it is named in `AGENT_TOOL_SCOPES` and granted;
- a tool whose scope is not in the allowlist is refused, and the refusal names the scope and says what
  granting it would allow.

Enforcement happens in the **authoritative dispatch path**, never in the interface:

1. **The offered tool list is filtered.** When a project's harness is opened, the scopes in force for
   its root session are read and only the permitted tools are enabled for that conversation, so the
   model is not offered a tool its scopes forbid.
2. **Every tool call is re-checked server-side, per session.** A `beforeTool` hook on the durable
   harness's own tool task reads the **session's** authority **again on every call** — model-issued and
   nested — and refuses, with a precise reason, *before the call's intent is recorded*: first a tool the
   scopes forbid, then a call that would act on a project outside the authority's own project set. A
   call refused at this hook produces no tool effect. The offered list is a courtesy, not the authority.
   A later revocation cannot retract an effect already in flight: asynchronous checks and filesystem
   mutations are not one atomic transaction.

A session with no active governing agent is refused before a provider request, rather than sent to
an unrestricted owner context. For bounded `file_edit`, the current binding, scope and capability
are checked again during execution and immediately before rename; an admitted auto-apply without a
durable write confirmation has an **unknown** outcome and is never automatically replayed. These
checks include production agent/binding revisions, acceptance-policy revisions and the live harness
settings revision, so a revoke-and-restore during a call is not treated as unchanged. File edits
through one tool instance are serialized by resolved target; this is not a lock across processes,
separate tool instances, path aliases or external writers. These checks do not make revocation atomic
with a filesystem write, prevent same-user path replacement, or stop detached processes. The same ticket-and-recheck approach covers `record_note`
and `write_board` before their effects; it does not stop an append or rename already in flight. Board
revision hashes are rechecked immediately before rename, but the check and rename are not atomic
against independent external writers: concurrent filesystem edits can still be overwritten. Inspect
uncertain outcomes before taking further action.
Authenticated owner HTTP routes derive their audit actor from the owner session, not a submitted agent
label; they cannot create agent-attributed decisions or file edits. The Agent Manager's project-scoped
**Action history** pages through durable accepted-action intents, 50 at a time, and reports uncertain,
not-started or receipt-recorded states. It does not verify a remote target, expose arbitrary external
receipt IDs, clear a barrier or retry an action. An owner can record a revision-bound observation
using fixed choices; it is an unverified statement of what the owner saw, not a reconciliation, a
confirmation that an effect stopped or authority to retry. Observations do not release any barrier.
An empty list does not establish that no external activity occurred; older releases, other stores and
external writers are outside this view.

The **project set** is enforced against the project the harness acts on, so a session bound to a
multi-project agent works in any project the agent allows and is refused — server-side, with no side
effect — in one it does not. Enforcement follows the target, never the agent's name.

## Binding a session to an agent

The scopes above are per **record**, but a dispatch happens in a **session**, so the two are joined by
a durable **session binding**:

| Field | Meaning |
|---|---|
| `projectId`, `sessionId` | The session the binding governs. The root conversation's id is the legacy named session's id, so binding that session governs a project's default conversation. |
| `agentId` | The agent whose scopes and project set govern the session — or `null` for a deliberate **unbind**. |
| `revision` | The optimistic-concurrency token; a stale binding write is a conflict that writes nothing. |
| `boundBy`, `boundAt` | Who bound it and when: the binding's own audit row, beside every other durable write. |

The semantics are explicit and fail closed:

- **No binding record at all** — the project-level legacy rule applies: the intersection of enabled
  agents whose project scope allows the project. A project with no agent history has owner dispatch;
  once any agent has governed the project, disabling, archiving or moving the last one away instead
  leaves an empty allowlist. Bind or enable an agent rather than silently restoring owner privileges.
- **A binding naming no agent (an unbind)** — an empty allowlist, so **every tool is refused**, with the
  named reason. This is deliberate, never the result of an accident.
- **A binding naming a disabled or archived agent** — the same refusal, naming that agent.
- **A binding naming a live agent** — exactly that agent's scopes and project set are in force.

Only the owner can change a session binding; only the owner-controlled harness records conversation
bindings. The binding is read **per session, on every tool call**, so a binding or a scope change takes effect at
the next dispatch with **no restart**. It is written through `POST /api/sessions/:id/agent` and read
through the matching `GET`; the session bar in the Agents view is the owner's way to choose or change
the agent, and it shows the agent and the scopes actually in effect, including the empty case, rather
than leaving "no privileges" a mystery.

The management view (`AgentManager.svelte`) reads the same records and sends the same authenticated
requests as everything else. **It is not the enforcement point**: it can be bypassed entirely with a
direct HTTP request, and nothing about it is load-bearing. It offers only what the server published —
the closed vocabulary, the offered models and the registered projects — and it shows the server's own
refusal beside the field the server named.

## Governance

| Who | May do |
|---|---|
| The **owner** (the authenticated session) | Change any scope, create any agent, change or archive any agent. |
| An **agent** | Nothing on its own record and no creation. It may change another agent's scopes only within its own scopes, or archive a permitted agent. Workspace, budgets, model, enabled state and other fields remain owner-only. |

Three refusals are explicit, and none of them is merely a hidden button:

- an agent **may not edit its own record** — editing the record that holds its own allowlist would let it
  widen itself;
- an agent **may not create another agent**;
- an agent **may not give another agent a scope it does not hold itself**. The rule is checked against
  the allowlist the change would *leave in force*, not against the request alone, so widening in two
  steps is refused at the step that widens. A disabled or archived agent cannot govern another agent;
  actor authority and target revision are checked again inside the durable write transaction.

Every change is recorded durably, with the actor, the action and the instant, in the audit row beside
the record; `agent.read` serves that trail and the view renders it.

## Answering, dismissing and the composer

Two distinct owner decisions resolve an agent's question, and they mean different things:

- **Answering** (`POST /api/projects/:id/agents/answer`) records the answer in the delivery ledger,
  writes it to the transcript and sends it to the agent. A question can be answered exactly once.
- **Dismissing** (`POST /api/projects/:id/agents/dismiss`) carries a **reason** and is recorded as its
  own durable transcript entry — who dismissed it, when and why — then the agent is **told** the
  question was dismissed rather than silently ignored, so a resumed run sees the decision instead of
  re-asking. A dismissed question cannot be answered afterwards and does not reappear as open.

The composer in the Agents view is a single surface: **Enter sends**, **Shift+Enter (and Cmd/Ctrl+Enter)
inserts a newline**, an in-progress IME composition is never interrupted, and typing `/` opens the
**slash** list of registry actions (`docs/ACTIONS.md`, *Surfaces*). The behaviour of every other editor
and dialog is unchanged.

## The bounded file-edit capability

`file_edit` governs one tool, and it is **disabled by default**: while `DASHBOARD_FILE_EDIT` is
not `on`, the tool does not exist at all and the two `file-edit.*` actions are **absent from the
typed registry** rather than present-and-failing. When the scope is granted but the switch is off,
the agent's prompt section reports that the `file_edit` scope is granted but the tool is disabled
and names the environment variable the operator must set to enable it.

To enable file editing:

1. Set `DASHBOARD_FILE_EDIT=on` in the environment (or in the instance's configuration).
2. Restart the process. The tool will appear and agents with the `file_edit` scope can call it.
3. The default mode is **propose-only**: the change and its diff are recorded but **no file is
   written**. To allow auto-apply, set the acceptance policy to `agent-may-accept`; see the
   acceptance policy documentation.

When it is enabled, one change is contained like this:

- the path is **relative**, with no absolute prefix, no backslash and no empty, current or parent
  segment, resolved through the existing containment helper — which also refuses a **symlink at any
  component**, so a symlink that leads out of the worktree is never followed;
- it edits **only inside the project's connected repository worktree**: the registered project's own
  folder. It never reads a general browse root, never writes under the application data root, and never
  touches a generated or app-managed directory (`node_modules`, `dist`, `.git`, and the
  rest of `FILE_EDIT_REFUSED_DIRECTORIES`);
- a **size cap** applies to the change and to the file it would replace, and the diff is capped too; an
  oversize change is refused rather than truncated;
- writes are **atomic** (`atomicWrite`: write to a temporary file, fsync, rename, fsync the
  directory);
- **every proposed or applied change is recorded durably with its diff**, so it can be reviewed and
  accepted through the existing acceptance machinery.

Two modes, and **the mode in force is read from the acceptance policy rather than assumed**:

- **propose-only is the default.** The change and its diff are recorded and **no file is written**. It
  is always permitted, whatever the policy says.
- **auto-apply writes the file.** It requires an explicit request *and* an acceptance policy that permits
  it: while the policy in force is `owner-only` (the documented default) the mode in force is
  propose-only and an auto-apply request is refused. The one owner switch is therefore the acceptance
  policy: set it to `agent-may-accept` to permit auto-apply, and it returns to propose-only when
  that policy is restored.


## The local deploy and publish capabilities

`deploy` and `publish` now each install one real, model-facing pair of tools, and both are **disabled
by default**. The switch decides whether the tools exist at all; the agent scope of the same name
decides who may call them; a bound named agent and the acceptance policy decide whether an effect is
authorized. A scope granted without its switch is reported to the model as granted but unavailable.

| Tool | Scope | Instance switch |
| --- | --- | --- |
| `deploy_preview`, `deploy_accepted` | `deploy` | `DASHBOARD_DEPLOY=on` |
| `publish_preview`, `publish_accepted` | `publish` | `DASHBOARD_PUBLISH=on` |

These are **local filesystem targets**, not Cloudflare, a CDN, a CI pipeline or any other provider.
Nothing here makes a network request or handles a provider credential.

### Configuring the destination (owner only)

The exact destination is the owner's, never the model's:

- `POST /api/projects/:id/action-destinations/deploy` with
  `{ revision, enabled, artifactPath, targetDirectory }`, where `artifactPath` is a relative path
  inside the project's connected worktree (for example `dist`) and `targetDirectory` is an existing
  **real** directory under the instance's configured browse roots.
- `POST /api/projects/:id/action-destinations/publish` with
  `{ revision, enabled, publicationRoot }`, where `publicationRoot` is also an existing real
  directory under the configured browse roots.

Both writes are owner-only, revision-checked and audited like the other action targets. They execute
nothing; a configured destination is not a performed action. The route refuses a directory reached
through a link, a directory outside the approved roots and a relative or escaping artifact path.

### What a deploy really does

`deploy_preview` reads the configured artifact directory, refuses anything that is not a regular
file, and returns a sorted SHA-256 manifest digest, the file count and the bound artifact identity.
`deploy_accepted` then requires that the session holds an acceptance for exactly that target-bound
artifact, under `agent-may-accept` with the `deploy` class set to `full-auto`. With the authority and
policy in force it:

1. copies the artifact into an owned staging directory inside the configured target and reads the
   staged digest back;
2. renames the staging directory to an immutable `generations/gen-<digest-prefix>` directory;
3. replaces the stable `current` link atomically by renaming a temporary link over it;
4. reads the served content back through `current` and requires the same digest;
5. records the generation and the **previous generation** in a durable outcome.

The previous generation directory is retained, never removed. To roll back, an operator points the
`current` link at the retained previous generation; Pilot never rolls back automatically and never
deletes a generation. If the artifact digest changed after the preview, the target revision changed,
the target is not a real directory under the approved roots, or `current` exists but is not a link
this tool created, the deploy is refused before any copy.

### What a publish really does

`publish_preview` accepts 1–500 paths relative to the project's connected worktree and returns each
file's digest beside the target-bound artifact identity. `publish_accepted` requires the same
acceptance form and then copies exactly those files into a staging directory inside the configured
publication root, reads the staged digests back, and renames the staging directory to
`publish-<digest-prefix>` with one atomic rename. It reads the published digests back once more. An
earlier publication is never replaced or removed, so a publish is additive and has no rollback
pointer; rolling publication back is an operator decision about what the server reads.

A path that escapes the worktree, a symlink at any component, a non-regular file, a file over 2 MiB
or a total over 16 MiB is refused before any copy. The same caps apply to a deploy artifact (500
files, 2 MiB each, 16 MiB total).

### Uncertainty, duplication and concurrency

Both effects run through the existing accepted-action executor: a durable intent is written before
the effect, a confirmed effect records a receipt, and an interruption or an unreadable result is
reported as **uncertain** with the intent and its barrier retained. That intent is never replayed
automatically; inspect the target and the durable intent first. A duplicate invocation is refused
rather than performed twice.

The durable resource key binds the configured directory **and** the promoted content. A later
generation of the same target is therefore admissible, while replaying the same accepted content is
refused. It does **not** serialize two different contents targeting one directory at the same time:
concurrent deployments to the same target can interleave, and the last swap wins. This is a local,
same-UID design; it is not a transactional deployment system or a lease.

### Honest limits

- These tools do not serve anything. A separate web server or process must read the configured
  target directory; Pilot neither starts it nor checks that it is healthy.
- A digest proves the bytes this process read and copied, not who produced them or that serving them
  is safe. Evidence and acceptance remain claims about the artifact.
- A staging directory is briefly visible under the configured target (dot-prefixed
  `.pilot-staging-…`). Old staging directories left by a hard crash are not removed automatically.
- The same-UID shell can read and write the same directories, so enabling `shell` is not contained
  by these tools.
- Both tools are refused in a fork session, because they would write a parent-owned target.

## The bounded commit and push capability

`commit` and `push` govern four tools, and each is **disabled by default behind its own deployment
switch**. While `DASHBOARD_AGENT_COMMIT` is not `on`, `commit_preview` and `commit_accepted` do not
exist at all; the same is true of `push_preview` and `push_accepted` and `DASHBOARD_AGENT_PUSH`. A
scope grant alone installs nothing, and configuring a target grants nothing. Both need the durable
control store.

To enable them:

1. Set `DASHBOARD_AGENT_COMMIT=on` and/or `DASHBOARD_AGENT_PUSH=on` in the environment and restart.
2. Configure the target for each project through the authenticated owner interface:
   `/api/projects/:id/action-targets/commit` (a fixed target; the request carries only a revision and
   an enabled flag) and `/api/projects/:id/action-targets/push` (a revision, an enabled flag and the
   name of one remote already configured in the project's Git repository). The server derives the
   branch, repository and — for push — the digest of the remote's canonical local path. No model and
   no client supplies a path, remote URL, branch or command.
3. Set the acceptance policy to `agent-may-accept` with the `commit`/`push` class decision
   `full-auto`, and grant the scope to a bound named agent. A class decision other than `full-auto`
   refuses the action even when evidence was already accepted.

What the tools do, and what they do not:

- `commit_preview` inspects the exact staged tree and its parent on the project's fixed Pilot branch
  (`refs/heads/work/pilot-<id prefix>`) and returns the artifact the evidence must bind. It stages
  nothing, and a preview writes Git tree objects even though it updates no branch.
- `commit_accepted` re-verifies the staged tree, parent, branch, target revision, acceptance, policy
  and session, then creates one immutable commit object for **exactly** that tree and moves only that
  branch with a compare-and-swap. It runs no hooks or filters, sets its own author and committer, and
  **never pushes**.
- `push_preview` inspects one commit and the configured push target, reporting the remote branch head.
  That observation is not a reservation: the remote can change afterwards.
- `push_accepted` pushes exactly the accepted commit to exactly the configured branch of the
  configured remote, **without force**. It refuses when the remote branch is not at that commit's
  parent (so it cannot be a fast-forward), re-checks the remote identity immediately before the write,
  and reads the branch back afterwards. The transport can reach only a local filesystem repository;
  there is no hosted credential integration and no network transport in this build.

Limits, stated plainly:

- **Staging is not secret scanning.** Refused paths and symlinks are checked, and the change is
  bounded in size, but nothing decides that the committed content is safe or free of secrets.
- **These checks are not external-writer compare-and-swap.** The branch and remote are verified
  around the write, not atomically with it, so another process or writer can still change either
  between the last check and the update. A detected substitution is refused; an undetected one is not.
- **Outcomes are durable and single-use.** One acceptance reserves one action intent. A pending or
  uncertain intent is inspectable and never replayed automatically: inspect the branch, the remote
  and the action history before doing anything else. The push adapter's post-push read-back is an
  observation, not independent proof.
- **The commit target is per project, not per agent.** The target fixes the repository and branch;
  the agent's project scope decides which projects it can act in, and the branch is never `main`.


## Honest limits

- **Conversation selections are durable.** Planning tools are added to existing root and named
  conversations before recovery and checked before new input. The migration preserves the model,
  transcript and explicit removal filters, and never widens grants. Other optional tools can retain
  their previous selection. The live per-call check remains authoritative for every tool.
- **A session's binding is per session.** The scopes in force for a session are its bound agent's, or
  — for an unmanaged session — the project-level rule described above. When more than one enabled agent
  allows a project, only the scopes **every one of them allows** are in force, the safe direction, never
  a widening.
- **The project scope is a set of project ids, or every project.** A tool call against a project outside
  the authority's set is refused at dispatch; the refusal names the project's id, never a filesystem
  path. The recorded workspace subpath is not enforced by the direct coding tools. Shell access is not
  confined to the project or the subpath and can reach other files and same-user credentials.
- **The mode switch is the acceptance policy's mode.** This build reuses that one owner-set switch rather
  than adding a second, dedicated file-edit class; a dedicated class is follow-up work.
- **Agent budget enforcement is partial.** For an attributable named-agent session, each direct provider request
  reserves a durable request slot before sending, shared across projects; owner-created worker runs
  are separate, are not attributable to that agent, and are not counted in its ledger; `maxRequests` caps the slots
  recorded since accounting was installed, not historical requests from earlier releases. The owner may
  revise that threshold, including raising it after exhaustion; doing so does not reset the count, and
  lowering it below the count refuses further requests. Agents cannot change budget fields. Failed or
  uncertain attempts are not refunded. The application checks the final output-token field produced by
  the locked, supported provider adapters against the instance, agent and worker limits before a model
  request. Transports whose payload cannot be checked (including OpenAI Codex), missing fields, and
  adapter-expanded limits are refused; some models or thinking settings may therefore be unavailable.
  Automatic adapter retries and a second payload fallback are disabled. This is a requested bound, not
  proof the provider honored it or a spending limit. Authentication can refresh credentials separately,
  before a model request is admitted, and a started refresh cannot necessarily be cancelled. A session governed by several agents refuses a request
  if any of them has a configured budget, until a single agent is bound. `maxJobsPerHour` is enforced
  for the installed `run_tests` capability only: each invocation reserves one rolling-hour job through
  the durable ledger before its intent is written, the reservation is never refunded, and the limit
  is not a spending limit. No other application job path is wired to it. Instance-wide harness settings and
  the separate worker limits still apply; a zero instance turn limit is unlimited. A rollback to an
  older build bypasses this ledger; release and rollback review must explicitly preserve budget
  enforcement and must not assume older binaries understand these reservations. Changes after the
  last authority check cannot retract an already-issued provider request.
- **A refusal carries no path.** Every message the registry and the tool produce is path-free, so a
  refusal shown in the interface or written to a log names a field or a scope and never a filesystem
  location.
- **The registry is working state, not documentation.** Markdown in the project stays canonical, so
  losing the registry costs convenience and never a planning fact.


## The installed `run_tests` capability

When the instance sets `DASHBOARD_TEST_RUNNER=on` (default off), a named agent bound to a session can
call `run_tests`. The tool runs one constant command — `node --test` with no arguments — in the
registered project root, as a child process of this application.

It is enabled only together with a durable control store and the agent registry, and every call is
checked on the installed path:

1. The privilege hook issues a one-use ticket for the exact call; the owner's own dispatch (no bound
   agent) is refused.
2. The session must be bound to that agent, the agent must hold `run_tests`, the project must be in its
   project grant, and the versioned authority snapshot must still match. A change refuses the call
   before anything is reserved or started.
3. One rolling-hour job is reserved through the durable agent budget ledger before the intent is
   written; a second invocation beyond the limit is refused.
4. The durable intent is keyed by a stable job id derived from the project, the conversation and the
   task identity. A duplicate invocation returns the existing record and cannot start a second job.
5. The authority is re-read in the intent's write transaction and once more immediately before the
   process starts. A revocation in that window records `not-started`, so the record says nothing ran.
6. A fork is refused: the fixed recipe's working directory is the registered project root.

The receipt records the exit code, a bounded prefix of stdout and stderr with truncation flags and
counted bytes, the duration and the exact command. A timeout or cancellation is recorded `unknown` or
`interrupted`, never as success, and is never retried automatically. After a restart, an intent left
pending becomes `unknown` once and is not re-run. The tool is **not a sandbox**: see
[the runner page](RUNNER.md) for exactly what it can reach.

## Installed `spend` and `provision` tools

These two are the first model-facing tools that really perform a consequential class. Each is
**default off** and needs all of the following, in this order: the deployment switch, a durable
control store, a bound named agent holding the scope, a project inside that agent's project scope,
self-reported evidence for the exact artifact, an acceptance by that agent for the class, and an
`agent-may-accept` policy whose decision for the class is `full-auto`. The tool rechecks the live
scope, project and policy around the effect; a refusal before the effect leaves nothing done.

- `spend_preview` and `spend_accepted` charge one metered amount (minor units, owner-fixed currency)
  against one owner-configured billing endpoint. The endpoint, the bearer credential (a private file
  under `<data>/credentials/`, never a project root), the account, the currency and the caps are
  deployment configuration, never model arguments and never returned to the model. The amount is
  bounded by a per-charge cap and by a durable per-project cap; both are checked before any request.
  A reservation is never refunded: an admitted amount keeps counting even if the charge is later
  refused, fails or stays unknown, so releasing it is the owner's decision, not an automatic retry.
  The charge identity is the project, the target and the amount, so **one charge per amount per
  project** is admitted for the life of the durable store: a second accepted charge of the same
  amount is refused rather than sent. There is no release path for a reservation in this build — an
  amount that was reserved keeps counting even after a refusal or an unknown outcome — so an owner
  who needs the same amount again must use a different amount or a reviewed change to the ledger.
  An unusable credential is refused at startup and again before any reservation, but a credential
  that becomes unusable after startup leaves an uncertain outcome with the cap consumed.
  The `Idempotency-Key` is derived from the accepted artifact. A repeat of the same accepted charge is
  refused from its durable intent rather than sent again. Redirects are refused, the JSON media type
  and a provider charge id are required, and the response is bounded. A non-2xx status, redirect,
  timeout, lost response or unverifiable body is an **unknown** outcome: the durable intent and the
  cap reservation remain and nothing replays automatically. This is **not provider-side
  exactly-once** — the provider decides whether it honours the key — and **not a global spending
  cap**: it bounds only Pilot's own charges through this one target. Revocation cannot cancel a
  request that is already in flight.
- `provision_preview` and `provision_accepted` create exactly one **Pilot-owned local directory** with
  one bounded `manifest.json` at `<approved root>/<projectId>/<targetId>`, written in a staging
  directory and published with one atomic `rename`. That is the whole capability: no infrastructure,
  no template, no credential and no provider call. A repeat of the same content is idempotent and
  returns the recorded receipt; different content is a conflict and leaves the existing resource
  untouched. Path escapes, symlinked roots, parents, targets or manifests, an existing target that no
  Pilot manifest owns, and oversized input are refused before anything is published. The approved root
  must be a real directory that overlaps neither the data root nor a registered project. Check-then-use
  on a filesystem is not atomic, so a same-user process can still substitute a path between calls.

Both classes are excluded from forks, like the other parent-project action tools.


## Agent-facing acceptance tools

A named agent with the `accept` scope can call `acceptance_read` to inspect its session's paged summaries, `acceptance_record` to record its own session's self-reported evidence only when `DASHBOARD_AGENT_EVIDENCE_RECORDING=on` is explicitly set at deployment, and `acceptance_accept` to accept a specific evidence record and exact artifact. The server supplies the bound agent identity; a model cannot assert an owner identity. Evidence is a claim, not independent proof of tests or diffs. The control store enforces the instance acceptance policy, scope, artifact revision and single-use rule. These tools do not execute the action class named by the record. With no control store, they are not installed. `commit_accepted` and `push_accepted` are separate tools that do perform the named class, and only where their own deployment switch, target, scope and `full-auto` class decision are all in force (see above).
