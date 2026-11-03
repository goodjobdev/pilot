---
title: "Documents, plans and task boards"
description: "Use one canonical plan without silently rewriting source specifications."
pilot:
  schema: 1
  id: planning
  kind: how-to
  doc_status: accepted
  feature_status: available
  verified_release: fd3fa6f
---

## One canonical plan

Canvas, timeline, task list, agent planning tools and Wiki plan source use the same `docs/dashboard/board.md`. Board operations validate the version-1 schema and revision. Wiki source edits use that same validation; a conflict retains the draft.

Use **Open plan document** to inspect the readable task summary or edit YAML source. Preserve IDs and references. The plan’s Markdown body is its summary; it is not a second plan database.

## Sync plan

1. Select up to 100 repository Markdown documents, excluding the canonical plan itself.
2. Choose **Preview sync**.
3. Review proposed tasks, statuses and dependencies. New tasks are selected by default; changed tasks and suggested edges require review.
4. Apply the selected batch. A changed source or board revision requires a new preview.

Structured checklists work without a model call:

```markdown
# Foundation checklist
- [ ] Store records <!-- pilot:task STORE -->
- [ ] Show records <!-- pilot:task VIEW --> <!-- pilot:depends STORE -->
```

Stable IDs start with a letter and contain at most 80 letters, digits, underscores, hyphens, dots or colons. Use commas to list multiple dependency IDs. Duplicate IDs and self-dependencies are errors; missing dependencies produce warnings.

A document headed `# M1 — Name` can declare a milestone deliverable, with optional `Status:` and `Depends:` lines. General section headings do not create milestones. Fenced/commented examples are not work. Ordinary prose needs interpretation by a person or the scoped planning agent.

## What is not synchronized

A board edit does not rewrite source-specification prose or checkboxes. For immediate two-way plan editing use the canonical plan file. External edits refresh clean views but never replace an unsaved editor draft. Undo history is reset when external changes are adopted.

Applied batches retain inert source snapshots and attempt one local commit for the plan and evidence together. This is not a push or a remote backup.
