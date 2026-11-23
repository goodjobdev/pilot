---
title: "Agents, permissions and evidence"
description: "Understand what a planning agent can actually do."
pilot:
  schema: 1
  id: agents
  kind: explanation
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

The default scripted provider is free and synthetic. Real providers require configuration and explicit opt-in. Tests and examples must not be described as billed-provider acceptance.

## What an agent can do

Every capability is two decisions: an instance switch decides whether the tool exists at all, and
an agent's allowlist decides whether that agent may call it. Nothing else grants a tool.

| Tool | Scope | Needs | Path and policy limits |
| --- | --- | --- | --- |
| Read the project's notes and planning | `read_notes`, `read_docs`, `write_docs` | Nothing extra | Project path checks; see limitation below |
| `read` — read a file | `file_read` | `DASHBOARD_CODING_TOOLS=on` | Worktree path checks; see limitation below |
| `write` — create or replace a file | `file_write` | `DASHBOARD_CODING_TOOLS=on` | Worktree path checks; writes directly |
| `edit` — replace matching text directly | `file_write` | `DASHBOARD_CODING_TOOLS=on` | Worktree path checks; writes directly |
| `file_edit` — propose or apply one edit | `file_edit` | `DASHBOARD_FILE_EDIT=on` | Worktree path checks and acceptance policy |
| `bash` — run a command | `shell` | Both switches, including `DASHBOARD_SHELL=on` | **No** |
| `acceptance_read` and `acceptance_accept` | `accept` | A control store and a named bound agent | Project-scoped; the acceptance policy and exact evidence identity apply |
| `commit_preview` and `commit_accepted` | `commit` | `DASHBOARD_AGENT_COMMIT=on`, a control store, an owner-configured commit target and a `full-auto` commit decision in the policy | Fixed Pilot branch; exact staged tree; never stages and never pushes; not secret scanning |
| `push_preview` and `push_accepted` | `push` | `DASHBOARD_AGENT_PUSH=on`, a control store, an owner-configured push target and a `full-auto` push decision in the policy | One locally configured remote, non-force, no hosted credential integration |
| `fork_context` and `fork_create` | `fork` | A control store and agent harness | The child starts paused, with no inherited agent grants |
| `deploy_preview` and `deploy_accepted` | `deploy` | A control store, a bound agent and `DASHBOARD_DEPLOY=on` | The owner-configured local target; an accepted artifact and a full-auto `deploy` policy |
| `publish_preview` and `publish_accepted` | `publish` | A control store, a bound agent and `DASHBOARD_PUBLISH=on` | The owner-configured local publication root; reviewed files and a full-auto `publish` policy |

**File path checks are not process isolation or a race-safe containment guarantee.** They refuse symlinks observed before a file is opened, but another process with access to the project could replace a path between the check and use. Do not rely on these checks to isolate concurrent processes.

**The shell is not contained.** It runs as the same user as the application, so it can read every
project's files, the durable store and the stored credentials, and it can push if the repository's
deploy key has write access. Grant it only where you accept that. Nothing in Pilot inspects or
filters the commands an agent runs.

**Deploy and publish are local filesystem operations.** The owner configures the exact target
directory and, for publish, the exact publication root under the instance's approved browse roots.
A deploy promotes the project's built artifact through a staged copy and an atomic `current` link
swap, reads the served digest back and keeps the previous generation for manual rollback; a publish
copies a bounded set of reviewed files and never replaces an earlier publication. Neither is a
Cloudflare, CDN or CI deployment, neither makes a network request, and neither serves the result.
Both require an accepted artifact under the current policy; an uncertain result must be inspected and
is never retried automatically. A shell granted to the same agent can reach the same directories.

**Installation is not permission.** Switching a capability on makes the tool exist; the agent still
needs the scope in **Agents & privileges**. A tool without its scope is refused at dispatch with no
effect. Existing conversations add newly granted installed tools before the next request, while explicit tool removals remain in force. A tool that is disabled in Harness settings is refused at dispatch.

**A project with no connected repository has no worktree**, so it gets no coding tool at all:
connect the repository first (see [your first project](./first-project.md)).

In **Harness settings → Acceptance and file edits**, choose whether agents may accept work and whether each action class asks the owner. The setting also changes `file_edit` from proposing changes to applying them. `write`, `edit`, and `bash` are direct tools: their grants, not this policy, govern their effects. Agent acceptance records a decision; it does not itself execute a deployment or a command. A bound agent with the `accept` scope can inspect paged evidence with `acceptance_read` and accept an exact recorded artifact with `acceptance_accept`; the server supplies the agent identity and the current policy still decides whether the action class is allowed.

A project conversation is durable; named sessions add identity and links. An agent binding and its explicit scopes decide tool availability. Granting a vocabulary item does not install an absent tool. Default planning tools read contained Markdown and the board, ask questions, append notes, and apply revision-checked planning batches. They are not a complete coding toolchain or a general shell/Git endpoint.

Use **Agents and privileges** for bindings, scopes and models. Use **Workers** for bounded owner-created runs, whose reports are untrusted evidence rather than accepted work.

## Working tree, history and backups

Coding tools change files in the working tree. Nothing commits or pushes unless a command does it or an
owner has installed the agent commit and push tools, so review **Workspace → Changes**, commit
deliberately, and remember that a local commit is not a remote backup. The commit and push tools are
**off by default** and act only on an exact target the owner configured: commit creates the staged tree
commit on the project's Pilot branch and never pushes, and push sends one accepted commit to one
*locally* configured remote without force. There is no hosted credential integration, so a push to
GitHub or another provider is not part of this build. Staging is not secret scanning, and the checks
before the write are not a guarantee against another writer changing the branch or the remote.

## The transcript and the composer

Each message carries its local time. Two or more consecutive tool results fold into one closed
group — *N tool calls* — which you open to read them; a single tool result stays visible on its own.

### Messages, attachments and long text

One message may hold up to 200,000 characters. Past 8,000 the composer offers **Save as document**:
the text is written into the worktree as `docs/uploads/pasted-….md` and the message names the path,
so an agent reads it from there — the same for any file you attach with **Attach file**. Attachments
land as **uncommitted changes** in the worktree; review them in Workspace → Changes and commit
deliberately. A project with no connected repository has no worktree, so attachments are refused
with that reason rather than stored somewhere unexpected.

### Model and thinking

One control opens both: search the configured models, pick one, and set how hard it should think
(`off` … `max`, or the default). It is the chip beside **Attach**. **Make default** makes the chosen
model the default for new sessions. Both choices are stored per session and take effect on the next
request; neither can be changed while a run is in flight.

Which model governs a session, in order: **the model you chose for that session**, else **the model
the bound agent declares**, else the conversation's own. So binding an agent to a session applies
that agent's model, and choosing a model in the composer overrides it for that session only.

### Attaching anything

**Dictate** appears where the browser implements speech recognition: it appends what it hears to the
message box and sends nothing by itself. **Attach** takes images and any other file in one control, and splits them by what they are: an
image goes to the model as image content, everything else is written into the worktree and named in
the message for the agent to read.

### Output per request

**Most tokens one request may produce** (Harness settings) is the budget for one answer, reasoning
included. The old build capped every request at 4,096, which is below what these models do: at a
higher thinking level the reasoning consumed it and the answer was cut off — shown as
`stopped: length` — and a long tool call could arrive truncated mid-JSON. The default is now 32,000
and the ceiling 128,000.

### One dispatch, many turns

In Harness settings, **Most model requests in a row** defaults to 40. Set it to 0 for a continuous
run with no turn limit, or choose 1–300 to stop at that many requests. A stopped run can continue
from the transcript after another message. An unlimited run can use model credits until it finishes
or an owner stops it. Changes apply on the next model request; worker budgets remain separate.

**Draft tools**, under the composer, is about the *local* draft only: when it was last saved into
this browser, **Copy draft** and **Download draft** while the latest text could not be saved, and
**Clear local drafts** to remove every draft this browser holds. Nothing there touches the server.

## Review work, not just messages

Link tasks to real specification paths. Ask for acceptance evidence. Inspect the saved files and local history. An assistant saying “done” is not proof of a commit, remote push, passing check or deployment.

## Stop and uncertain work

Stop cancels current execution and withdraws queued input where supported; it does not roll back an existing effect. An uncertain interruption blocks further model/tool work until the owner reviews the original conversation and affected files and explicitly acknowledges the settled state. Acknowledgement does not replay or undo the tool. Do not use Retry to guess whether an unsafe action happened.

Repository updates are explicit owner controls, not a newly granted agent Git scope. A running
command or an agent turn in that project blocks a repository update, and an update in progress
blocks new model requests for it, so the two cannot interleave in one worktree.

When direct coding tools are enabled for a forked session, their configured workspace is the child's worktree for `read`, `write`, `edit`, and the initial working directory of `bash`. The experimental action-driven child dispatch waits for its child submission under a lifecycle fence; work that outlives the closed fence can be refused. This is not proof that external effects or detached processes have stopped, and no production fork-dispatch action is installed. The shell remains uncontained. The bounded `file_edit` tool is refused in a fork because it targets the parent project. Fork creation starts a paused child without agent grants; binding and resuming the child are separate owner actions. Parent-rooted note, documentation, planning-board, and acceptance-write tools are refused in fork sessions rather than operating on the parent project’s canonical documents.

### Reusable JSON projections (implemented locally, not released)

An instance owner can set `DASHBOARD_REUSABLE_TOOLS=on` at startup, then use the existing agent
scope controls to grant `reusable_tools` to a named agent and bind it to the project session. Both
are required; an unbound owner dispatch cannot use this capability. Removing the scope prevents
subsequent calls. Restarting without the switch disables the tools but retains their durable records.
Fork sessions cannot use them.

The agent can call `reusable_define` with a name, revision `0` and a list of JSON object field
names; `reusable_list` reads its definitions; `reusable_invoke` applies a named definition to a
JSON object string. To update a definition, supply its current revision; a stale revision is refused.
Only the agent's own definitions in the current project are visible. Definitions select fields only;
they cannot execute code or access a network, Cloudflare, MCP or credentials. Input and output are
limited to 8192 UTF-8 bytes. All input numbers, including nested numbers, must be safe integer
literals; negative zero, decimals and exponent notation are refused to avoid silent rounding. Calls/results may be stored in the transcript: do not supply secrets.
Interrupted writes and invocations are not automatically replayed. Inspect the list and transcript
before acting again. See the [behaviour contract](../specs/reusable-json-tools.md) for limits.
