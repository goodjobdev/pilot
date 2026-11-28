# Plan, files and local history

## One plan, two views

`docs/dashboard/board.md` is the canonical plan. The canvas, timeline, list, agent
planning tools and Wiki plan document read and write **that same file**. There is no
second plan database or model-generated reconciliation step.

Use **Board actions → Open plan document** to read the task summary or edit its YAML
source. The source uses the existing version-1 board schema: domains, milestones,
tasks, relationships, sources and layout. Keep task IDs and valid references. Invalid
source is rejected with the draft retained; an externally damaged plan remains readable
in the Wiki so its source can be repaired. Successful edits use the same revision check
and bounded backup history as board operations.

Clean board and document views refresh periodically and on return from chat. An editor's
unsaved draft is never replaced by a refresh. A conflicting save requires a reload and
review, not a forced overwrite. External edits refresh the views but are **not automatically
committed**.

## Sync plan from repository documents

Choose **Sync plan**, select up to 100 Markdown documents and choose **Preview sync**.
Review the proposed tasks, status changes and dependencies before applying a selection.
The canonical plan itself is not a source candidate.

This is structured extraction, not a model call. Checklist items, supported milestone
headings and explicit dependency markers provide the inputs. Fenced and commented
examples are ignored. Ordinary prose remains prose: ask the planning agent to interpret
it and use the revision-checked planning tools when interpretation is needed.

Optional stable identifiers make a checklist task survive a title change or file move:

```markdown
# Foundation checklist
- [ ] Store the records <!-- pilot:task STORE -->
- [ ] Show the records <!-- pilot:task VIEW --> <!-- pilot:depends STORE -->
```

Use a unique ID of 1–80 characters, starting with a letter. Later characters can be
letters, digits, `_`, `-`, `.` or `:`. Dependency IDs use the same syntax; separate multiple IDs
with commas or spaces.
Duplicate IDs and self-dependencies are rejected. Missing dependencies are warnings,
not invented tasks. The existing milestone format is a top-level `# M1 — Name` heading
for a document, with optional `Status:` and `Depends:` lines. It produces a milestone
deliverable task and assigns that document's checklist items to the milestone. Ordinary
section headings do not automatically create milestones. Without IDs, the existing text-based import identity still applies.

A preview pins the current board revision and every selected source document revision.
A changed board or source requires a new preview. Apply writes one validated canonical
plan and retains bounded, inert source snapshots for evidence. Tasks from one document
share its content-addressed snapshot; source text is not copied once per task.

**Source specifications are not another live status database.** Sync does not rewrite
source prose or checkboxes after a board edit. A later source preview can propose a
status change, which the owner must review. For immediate two-way plan editing, edit
`docs/dashboard/board.md` or its board views.

## Files / Changes inside Pilot

Use the header's **Files and changes** button. On a wide screen it opens a right sidebar;
on a phone it opens a full-width overlay that can be closed without losing a chat draft.
The Wiki has **Collapse all** and **Expand all** folder controls.

- **Files** lists previewable repository files, including code, Markdown, common text
  configuration files and raster images. Text is escaped, not executed. Image previews
  use the existing authenticated, bounded asset route. Markdown can open in the Wiki.
- **Changes** shows visible uncommitted paths and real Git patches, including staged
  content in the comparison with `HEAD`. Untracked text has an explicitly labelled
  new-file patch. New images have an explicit no-text-diff message.
- **Recent commits** shows local subjects and hashes. Select a commit, then a path, to
  inspect its actual patch. Deleted files can still have a patch without a current file.

The view omits credentials, secret-like filenames, generated directories, Git metadata
and managed source snapshots. It is **not a complete Git status**. A bounded listing
reports when it is incomplete; search searches the listed files only. Text previews
are limited to 2 MiB, images use the asset limit, listings to 5,000 entries and Git command
output to 4 MiB. Binary or non-UTF-8 text is refused rather than silently decoded.

## Local commit boundaries

Pilot documentation saves, notes, applied board changes, applied Sync plan batches and
worker reports attempt local Git commits. The optional, separately enabled `file_edit`
tool does this only for applied Markdown edits, not proposed edits or general code.
No new agent scope or general Git execution tool is installed.

- The project must already be a usable Git worktree on exactly
  `work/pilot-<first-eight-characters-of-project-id>`. Pilot does not initialize a repository,
  switch branches, push, merge or install dependencies as part of a save.
- One meaningful document save or board operation produces one commit. An applied Sync
  batch commits the plan and its source snapshots together. A byte-identical save produces
  no empty commit.
- Commits include only the action's paths. Unrelated staged and working files stay untouched.
  A staged action target is refused rather than changing another Git operation's staging.
  Within an action-owned file, the commit records its **whole saved contents**; it is not
  a line-level split of older edits in that same file. Review the current document before
  saving it.
- Git hooks, signing, configured content filters, filesystem monitors, external diff,
  text conversion, lazy fetches and network protocols are disabled for these fixed local
  operations. They do not run arbitrary commands supplied by the client.
- Disk save happens first. A commit preparation failure retains the bytes and reports
  **Saved, not committed**. An unconfirmed commit reports **Saved · commit unconfirmed**;
  inspect history before retrying. There is no automatic retry or rollback.
- Non-Git projects report **Git unavailable**, without inventing history. Connect a repository
  explicitly to use local history. Files can still be previewed without Git.
- **Commit saved file** is an explicit Markdown-only retry after reviewing its current
  content. Its revision must still match. It cannot publish code or commit an arbitrary
  client-supplied path list.

Cancellation does not undo an already saved file or its history record. A queued agent
write checks cancellation again before writing. Existing uncertain-session recovery gates
remain in force; Git commit uncertainty does not authorize a replay of the agent tool.

Local history is **not a remote backup**. Existing backup exclusions still apply; derived
repository worktrees and their Git objects need an independent backup or a separately
reviewed push. This feature does not deploy anything or change providers, keys or models.
