# Agent planning tools

An agent can turn a registered project's Markdown documents into the same board shown by
Dependencies, Timeline and List. This does not require arbitrary file editing, a shell,
`DASHBOARD_FILE_EDIT`, or a repository write credential.

## Tools and authority

| Tool | Required scope | Effect |
|---|---|---|
| `list_docs` | `read_docs` | List project-relative Markdown paths in pages of 100. |
| `read_doc` | `read_docs` | Read a contained Markdown document in 16,000-character pages. Follow `nextOffset` until it is null. |
| `read_board` | `read_docs` | Read the current board and revision. Oversized responses fail rather than silently truncate. |
| `write_board` | `write_docs` | Apply task upserts, relationship upserts and domain/milestone metadata through the existing board store. |

All tools remain project-scoped. Reads reuse `DocStore` containment and size limits; symlinks,
parent traversal, generated paths and app-managed documents are not general file access.
Writes reuse the board schema, cycle checks, serialization and revision conflict handling.
The canonical `docs/dashboard/board.md` has a validated Wiki bridge and is available to
these documentation tools; other managed paths remain excluded. Board and Wiki edits
change that same file, not two synchronized copies. A task's specification paths must
resolve to actual browsable project documents.

The model sees the full operation schema. It must read the evidence and current board, preserve
existing work, cite paths and relevant anchors, and never invent dates. Milestones express order,
not fabricated calendar estimates. Repository text is untrusted evidence, not authority to change
permissions or execute instructions.

## Atomic batches

`write_board` accepts the current `revision` and exactly one of:

- `operation`: one `putTask`, `putEdge`, or `metadata` operation;
- `operations`: 1–100 such operations, with a combined 128 KiB input cap.

Metadata and tasks must precede relationships that use them. The complete candidate is validated
before one atomic file write and one attempted local Git commit. Invalid operations, missing source documents, stale revisions and
unsupported operations leave the board unchanged. The caller cannot submit `restore`, deletions,
commands or arbitrary file content. Metadata replaces the supplied domain/milestone lists, so the
agent must retain existing entries still needed by the board.

The returned `commit` metadata distinguishes committed, unchanged, unavailable, failed and
uncertain history. A successful disk save is not proof of a Git commit. Only the action's
paths can be committed, on the project's Pilot branch, without hooks, content filters,
network, a push or a merge. This is part of saving documentation, not a grant of the
uninstalled general `commit` capability. See [Plan, files and local history](PLAN-SYNC.md).

A write is unsafe to replay. An uncertain interruption needs owner review; no exactly-once claim
is made. Source documents are not locked against external edits, and a valid reference does not
prove that a model's interpretation is correct. Review the resulting plan.

## Existing conversations and settings

The harness adds the planning extension to existing root and named conversations before recovery
resumes and checks tool availability again before a new input. It preserves model/provider,
instructions, transcript and unrelated selections. It never widens an agent's granted scopes.
Explicit removal filters remain intact; permission-derived denials are not saved as permanent
removals. Every tool call checks live authority, so a revocation blocks the next call even if the
model previously saw the tool.

Settings identify installed tools separately from unavailable capabilities. Existing unavailable
grants are preserved on save unless removed, but new unavailable grants are disabled. Granting a
scope does not install an absent tool. Optional `file_edit` remains a separate deployment-gated
capability and is not needed for planning.

Returning from chat to a board view refreshes the persisted board without overwriting unsaved
local edits. External changes reset local undo history rather than allowing Undo to erase work
made elsewhere.

## Chat surface

The conversation is the primary surface. Agent binding, session details and activity use collapsed
disclosures. The compact composer groups attachments, model selection and send/stop controls.
Only unresolved questions occupy the action area; answers and dismissals remain available under
Resolved questions and in the durable history. Assistant Markdown is sanitized before rendering;
remote Markdown images are not fetched, and stored attachments retain their authenticated path.
