---
title: "Project and board settings"
description: "Every current project and board menu action, with its effects and limits."
pilot:
  schema: 1
  id: settings
  kind: reference
  doc_status: accepted
  feature_status: partial
  verified_release: fd3fa6f
---

## Adding a project

| Field | Meaning |
| --- | --- |
| Project name | Display name, required at creation. |
| Repository URL | Optional GitHub HTTPS or SCP-style SSH URL; not a trigger to clone. |
| Managed workspace | Persistent server planning folder; supports the explicit connection flow. |
| Existing server folder | Register a directory under approved server roots; preview the folder first. |
| Workspace inventory | Optional suggestion for name and URL; does not copy the source path from your workstation. |

There is no general post-creation name/repository editor today. Do not unregister a project merely to rename it without understanding its session identity.

## Board actions menu

The unreleased update groups actions under **Project**, **Planning**, **Workspace**, and **Project Registry**. The groups distinguish repository setup, task planning, local utilities, and unregistration.

| Action | Effect |
| --- | --- |
| Repository & deploy key | Generate/copy/remove a project key, check read access, explicitly connect a checkout. Removing the local key does not revoke it on GitHub. |
| Sync plan | Preview repository documents and apply selected planning changes. Not Git synchronization. |
| Open plan document | Open the canonical `docs/dashboard/board.md` in the Wiki. |
| Import documents | Preview selected uploaded Markdown/MDX or supported legacy HTML planning documents; never execute them. |
| Areas & milestones | Edit area names/colours and milestone names/order. Referenced entries cannot be removed. Order is not an automatic dependency or a date. |
| Export board | Download `board.md`, or an unsaved board draft when applicable. Not a complete project backup. |
| Commands | Open the command palette; shortcut is Command/Ctrl K. |
| Reload | Reread the server’s project state, with draft/conflict guards. Does not fetch Git. |
| Adopt board | Available for mirrored boards. Accept it as the task-planning source; source specifications remain authoritative. |
| Agents & privileges (Agents & privileges in the header) | One allowlist per agent, with **Select all available** and **Clear all**; an unavailable scope is never newly granted. The title, close control and Done button stay in view while the form scrolls. |
| Unregister project | Remove the registry entry. Files are not deleted. Existing identities/history are not a new project’s identities. |

## Separate controls

**Agents and privileges** controls bindings and permissions; **Workers** controls bounded owner-created runs; **Providers & models** controls credentials and model choices. They are not board settings. **Needs me** collects attention items. The theme control changes presentation only.

**Workspace → Files / Changes** previews repository files, local changes and history. [Remote changes](./remote-updates.md) adds a separate, explicitly initiated network operation in the unreleased update.

## Task inspector: every field and action

| Control | Meaning |
| --- | --- |
| Task title | Required, up to 500 characters. |
| Status | `todo`, `doing`, `done`, or `blocked`. A stored work status, separate from computed readiness. |
| Scope | `active`, `deferred`, `design-only`, or `historical`. Planning classification, not an agent permission. Only active, non-archived tasks participate in ready/waiting classification. |
| Primary area | One configured area used for grouping and colour. |
| Milestone | A configured milestone, or independent/unassigned. |
| Secondary area tags | Comma-separated labels; they do not create dependencies or privileges. |
| Description | Up to 20,000 characters; Markdown is stored but shown safely as text in the inspector. |
| Acceptance / evidence note | Up to 20,000 characters. A note, not automatic proof of acceptance or a test runner. |
| Specification links | Repository Markdown path and optional `#anchor`. Missing/broken links are advisory warnings, not execution gates. |
| External gates | Label, `open`/`satisfied` state and evidence text. An open gate makes an otherwise eligible task wait. |
| Archive task | Retain the task and its relationships as history. Different from deletion. |
| Save task | Apply the current draft with revision checking and a local commit attempt. |
| Export draft | Download the inspector draft as JSON; it is not an automatic save. |
| Relationships | Select another task, direction and `blocks`/`related`; add, reconnect or remove an edge. Save task edits first. Blocking cycles and dangling references are rejected. |
| Source snapshots | Read inert imported evidence; not a live source editor. |
| Remove task | Confirm removal of the task and its incident relationships. Archive instead to retain them. |

**Readiness** is computed, in order: completed tasks are `done`; archived/non-active tasks are `out-of-scope`; in-progress tasks are `doing`; blocked tasks, open gates or unfinished incoming blocking prerequisites mean `waiting`; otherwise `ready`. A related link never blocks. A task being ready does not prove its design or acceptance is complete.

**Areas & milestones** edits are a dialog draft: **Save configuration** applies the batch, **Cancel** leaves the stored configuration unchanged. Area accent is a colour, milestone order is a number from 0 to 10,000. Removing referenced entries is refused instead of silently reassigning tasks.

## Board presentation

Dependencies, Timeline and List are views of the same plan. Search, area, status (`todo`/`doing`/`done`/`blocked`) and scope filters change presentation, not the underlying task definitions. **Reset** clears the area/status/scope selections, not the search text. Hidden prerequisites still affect readiness. Layout/trace controls do not create prerequisites. Undo/redo are local board-edit conveniences, not Git reset; adopting a changed external board clears stale undo history. None of these controls fetches remote files or deploys a project.

## Recovery-only controls

When the project folder or board is missing, Pilot can offer **Locate folder** or **Confirm & initialize board**. Initialization creates a new file exclusively; it is not a repair that overwrites an existing board. Export retained drafts before changing location or reloading a conflicting edit.
