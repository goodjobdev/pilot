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
| `read_docs` | Read the project's documentation. |
| `write_docs` | Write the project's documentation. |
| `file_read` | Read a file inside the project's connected repository worktree. |
| `file_edit` | Propose or apply one bounded edit to a file inside the project's connected repository worktree. |
| `run_tests` | Submit a bounded coding job from the fixed recipe allowlist. |
| `fork` | Branch a transcript and create a child worktree. |
| `accept` | Accept a completion record under the acceptance policy in force. |
| `commit` | Commit work in the project's repository. |
| `push` | Push a commit to a remote. |
| `deploy` | Deploy a release. |
| `spend` | Incur a cost through a provider or a paid service. |
| `provision` | Create infrastructure or another resource. |
| `publish` | Publish an artifact to a channel. |

The scopes that govern a tool this build exposes to a model are declared in `AGENT_TOOL_SCOPES`
(`ask_question`, `record_note`, `read_notes`, `read_docs`, `write_docs`,
`file_read`, `file_edit`, `run_tests`). The rest are capabilities the command surface and
the acceptance record name; nothing in the vocabulary is a label with nothing behind it.

## Tool installation status

Not every scope with a declared tool-scope mapping actually has a running tool in all builds.
Only the following scopes correspond to a tool this instance installs:

| Scope | Tool installed | Default |
|---|---|---|
| `ask_question` | Yes, always | On |
| `record_note` | Yes, always | On |
| `read_notes` | Yes, always | On |
| `file_edit` | Conditional — see below | Off (behind switch) |
| `read_docs` | **No** — not installed | N/A |
| `write_docs` | **No** — not installed | N/A |
| `file_read` | **No** — not installed | N/A |
| `run_tests` | **No** — not installed | N/A |

A scope whose tool is not installed is listed in the vocabulary and can be granted to an agent,
but the agent cannot call the tool: the tool simply does not exist in the running instance. The
UI and the agent's prompt section report this explicitly, so an owner is never told a capability
is in effect when the agent cannot use it.

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
   forbidden call therefore produces **no side effect at all**, however it was crafted: a scope revoked,
   a binding changed, or a project removed from the set after the offered list was built is still
   refused, because the re-check is the authority and the offered list is a courtesy.

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

- **No binding record at all** — the session is unmanaged, and the project-level rule that predates the
  binding still applies: the scopes of the enabled agents whose project scope allows the project.
- **A binding naming no agent (an unbind)** — an empty allowlist, so **every tool is refused**, with the
  named reason. This is deliberate, never the result of an accident.
- **A binding naming a disabled or archived agent** — the same refusal, naming that agent.
- **A binding naming a live agent** — exactly that agent's scopes and project set are in force.

The binding is read **per session, on every tool call**, so a binding or a scope change takes effect at
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
| An **agent** | Nothing at all on its own record; nothing that creates an agent; and only a change that stays **inside the scopes it holds itself**. |

Three refusals are explicit, and none of them is merely a hidden button:

- an agent **may not edit its own record** — editing the record that holds its own allowlist would let it
  widen itself;
- an agent **may not create another agent**;
- an agent **may not give another agent a scope it does not hold itself**. The rule is checked against
  the allowlist the change would *leave in force*, not against the request alone, so widening in two
  steps is refused at the step that widens.

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

## Honest limits

- **The offered tool list is computed when a project's harness is opened**, and the conversation's stored
  agent state keeps it for the life of that conversation. The authoritative check is the per-call
  re-check, so a scope change takes effect at dispatch immediately; the offered list is rebuilt the next
  time the project's harness is opened.
- **A session's binding is per session.** The scopes in force for a session are its bound agent's, or
  — for an unmanaged session — the project-level rule described above. When more than one enabled agent
  allows a project, only the scopes **every one of them allows** are in force, the safe direction, never
  a widening.
- **The project scope is a set of project ids, or every project.** A tool call against a project outside
  the authority's set is refused at dispatch; the refusal names the project's id, never a filesystem
  path.
- **The mode switch is the acceptance policy's mode.** This build reuses that one owner-set switch rather
  than adding a second, dedicated file-edit class; a dedicated class is follow-up work.
- **The budgets are declarations.** They are validated and recorded, and the interface shows them, but
  nothing in this round enforces a per-agent request, token or job count at dispatch; the harness's own
  4,096-token and eight-turn ceilings are what actually bound a run. Enforcing a per-agent budget is
  follow-up work, and it is stated here rather than implied.
- **A refusal carries no path.** Every message the registry and the tool produce is path-free, so a
  refusal shown in the interface or written to a log names a field or a scope and never a filesystem
  location.
- **The registry is working state, not documentation.** Markdown in the project stays canonical, so
  losing the registry costs convenience and never a planning fact.
