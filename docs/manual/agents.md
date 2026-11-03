---
title: "Agents, permissions and evidence"
description: "Understand what a planning agent can actually do."
pilot:
  schema: 1
  id: agents
  kind: explanation
  doc_status: accepted
  feature_status: available
  verified_release: fd3fa6f
---

The default scripted provider is free and synthetic. Real providers require configuration and explicit opt-in. Tests and examples must not be described as billed-provider acceptance.

## What an agent can do

Every capability is two decisions: an instance switch decides whether the tool exists at all, and
an agent's allowlist decides whether that agent may call it. Nothing else grants a tool.

| Tool | Scope | Needs | Contained? |
| --- | --- | --- | --- |
| Read the project's notes and planning | `read_notes`, `read_docs`, `write_docs` | Nothing extra | Yes: Markdown and the board only |
| `read` — read a file | `file_read` | `DASHBOARD_CODING_TOOLS=on` | Yes: inside the connected worktree |
| `write` — create or replace a file | `file_write` | `DASHBOARD_CODING_TOOLS=on` | Yes: same, and it writes directly |
| `edit` — propose or apply one edit | `file_edit` | `DASHBOARD_FILE_EDIT=on` | Yes, and governed by the acceptance policy |
| `bash` — run a command | `shell` | Both switches, including `DASHBOARD_SHELL=on` | **No** |

**The shell is not contained.** It runs as the same user as the application, so it can read every
project's files, the durable store and the stored credentials, and it can push if the repository's
deploy key has write access. Grant it only where you accept that. Nothing in Pilot inspects or
filters the commands an agent runs.

**Installation is not permission.** Switching a capability on makes the tool exist; the agent still
needs the scope in **Agents & privileges**. A tool without its scope is refused at dispatch with no
effect. A conversation created before a capability was installed can keep its earlier tool
selection, so start a fresh session after changing a switch or a grant.

**A project with no connected repository has no worktree**, so it gets no coding tool at all:
connect the repository first (see [your first project](./first-project.md)).

A project conversation is durable; named sessions add identity and links. An agent binding and its explicit scopes decide tool availability. Granting a vocabulary item does not install an absent tool. Default planning tools read contained Markdown and the board, ask questions, append notes, and apply revision-checked planning batches. They are not a complete coding toolchain or a general shell/Git endpoint.

Use **Agents and privileges** for bindings, scopes and models. Use **Workers** for bounded owner-created runs, whose reports are untrusted evidence rather than accepted work.

## Working tree, history and backups

Coding tools change files in the working tree. Nothing commits or pushes unless a command does it,
so review **Workspace → Changes**, commit deliberately, and remember that a local commit is not a
remote backup.

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

### Thinking level

**Thinking** beside the model picker sets how much reasoning the model is asked for for that session
(`off` … `max`, or the host default). It is stored per session and takes effect on the next request;
it cannot be changed while a run is in flight.

### One dispatch, many turns

One message may make up to `DASHBOARD_MAX_MODEL_TURNS` model requests in a row (default 40). It is a
runaway guard, not a conversation limit: when it is reached the run stops, the refusal names the
bound, and sending another message continues from the transcript. An operator can raise it.

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
