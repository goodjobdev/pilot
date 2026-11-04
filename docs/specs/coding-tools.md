---
title: Coding tools contract
description: How an agent gets read, write and shell tools, what contains them and what does not.
pilot:
  schema: 1
  id: coding-tools-contract
  kind: specification
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

# Intent

An owner wants an agent to work the way a person does at a terminal running Pi: read the code,
change files, run the tests. That must be a deliberate, per-instance and per-agent decision, and the
documentation must say plainly which parts are contained and which are not.

# The tools

| Tool | Scope | Installed when | Contained? |
| --- | --- | --- | --- |
| `read` | `file_read` | `DASHBOARD_CODING_TOOLS=on` | Yes: paths resolve inside the connected worktree |
| `write` | `file_write` | `DASHBOARD_CODING_TOOLS=on` | Yes: same resolution, and a direct write |
| `edit` | `file_edit` | `DASHBOARD_FILE_EDIT=on` | Yes: bounded, and proposed or applied per the acceptance policy |
| `bash` | `shell` | `DASHBOARD_CODING_TOOLS=on` **and** `DASHBOARD_SHELL=on` | **No.** Runs as the application user |

Two switches and an allowlist decide everything: the instance switches decide which tools exist at
all, and an agent's scopes decide which of the existing tools that agent may call. A tool not
granted is refused at dispatch with no effect, and a tool not installed is not offered at all. The
vocabulary the interface reads reports both facts per scope.

# Behaviour contract

- The tools are installed for a project only when its repository is **connected**: `read` and `write`
  are rooted at `repositories/<projectId>/agent`, and a project with no worktree gets none of them,
  because there is no root to bound a path to.
- `read` and `write` check every model-supplied path before the tool body runs: a path that resolves
  outside the worktree, an absolute path outside it, an empty path and a path containing a NUL are
  refused with 403 and no effect. A symlink inside the worktree that resolves inside it is read
  normally; a symlink that leaves the worktree cannot be read through the tool.
- `write` writes directly. The acceptance policy in force does **not** gate it — that policy governs
  the bounded `edit` tool — so granting `file_write` is the decision to let an agent change files
  without a proposal step.
- `bash` runs through the environment's shell with the worktree as its working directory. The
  command is not inspected, rewritten or blacklisted: this build makes no claim to filter commands,
  and a pattern list would be a guarantee it could not keep. Its output is bounded and streamed by
  the harness, a timeout applies, and the command is recorded in the durable transcript like any
  other tool call.
- The shell reaches everything the application user reaches: every project's files under the data
  volume, the durable control store and the unencrypted `credentials/` directory (provider keys and
  project deploy keys). With a write-capable deploy key it can push. This is stated, not mitigated.
- An interrupted `write` or `bash` is not replayed: both are replay-unsafe by default, so recovery
  reports the interruption instead of repeating the effect.
- Owner-reviewed repository updates and runs refuse to start while a session of that project is
  working, so a shell command and an update of the same worktree cannot interleave; new model
  requests are refused while an update owns the project. The shell writes the working tree, not
  history: nothing commits or pushes unless a command does it.
- The switches are read at startup; installing a capability needs a restart. A conversation created
  before a capability was installed may keep its earlier tool selection, so a fresh session is the
  reliable way to see the new tools. The vocabulary and the agent's own prompt section state which
  of its granted scopes has no installed tool.

# Acceptance criteria

| ID | Evidence |
| --- | --- |
| AC-1 | With the switches off, the vocabulary reports `file_read`, `file_write` and `shell` as uninstalled, and the tools are absent from the registry. |
| AC-2 | With `DASHBOARD_CODING_TOOLS=on` only, `read` and `write` exist and `bash` does not. |
| AC-3 | With both switches on, `bash` exists and its commands run with the worktree as the working directory. |
| AC-4 | A path outside the worktree is refused by `read` and `write` with 403 and no effect; the file outside is unchanged. |
| AC-5 | A symlink that leaves the worktree cannot be read; one that stays inside it can. |
| AC-6 | A project without a connected worktree installs no coding tool. |
| AC-7 | The interface reports the capability per scope, and the shell's own description says it is not contained. |
| AC-8 | A dispatch whose allowlist lacks the scope is refused at dispatch even though the tool is installed. |
| AC-9 | A connected worktree under the data root is writable; a project rooted in the application's own state is refused, naming the area. |
| AC-10 | The output bound is stored, bounded 1–128,000, read per request, and named in the transcript when a response stops at it. |

# Documentation and delivery

The user-facing statement is [Agents, permissions and evidence](../manual/agents.md). The operator
statement is in `docs/DEPLOYMENT.md`, the security posture in `docs/SECURITY.md`, and the workspace
rules in `AGENTS.md`; those three are operator documents and are deliberately not published here.
This contract is implemented and locally verified; it is not a release until an approved deployment
says so.
