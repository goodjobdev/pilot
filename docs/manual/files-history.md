---
title: "Files, changes and local history"
description: "Preview repository files and understand saved versus committed work."
pilot:
  schema: 1
  id: files-history
  kind: how-to
  doc_status: accepted
  feature_status: partial
  verified_release: null
---

The **Files** tab is a folder tree: folders sort before files, a folder shows how many files and
how much it holds, and clicking it opens or collapses it. Searching replaces the tree with one flat
list of matches, because a match inside a closed folder would otherwise be invisible. A file still
opens by its full path, and its preview is unchanged.

Use the header’s **Files and changes** button. It is a right sidebar on wide screens and an overlay on phones. Closing it preserves the chat draft. Doc **Collapse all / Expand all** controls folder groups.

## Files and changes

**Files** previews escaped text and supported raster images. Markdown can open in the Doc view. **Changes** shows real local Git patches and recent local commits. Select a commit and a path to inspect its patch; merge patches compare with their first parent.

The listing deliberately omits credentials, secret-like names, generated folders, Git metadata and managed evidence snapshots. It is not a complete Git status. A capped list identifies itself as incomplete; search searches that list only. Text previews are limited to 2 MiB and listings to 5,000 entries. Unsupported/binary text is refused. Image assets use their own bounded authenticated route. Ordinary Wiki document body and image/static-mockup asset reads use a Linux `/proc` descriptor-relative reader and fail closed if Linux procfs support is unavailable; these reads do not fall back to pathname access. The canonical plan's board-backed Wiki bridge uses a separate pathname-based read. Other application filesystem operations are not thereby contained.

## Save results

| Result | Meaning |
| --- | --- |
| Committed + hash | File saved and local Git commit confirmed. |
| Saved · no new changes | No empty commit was created. |
| Saved · Git unavailable | Bytes are saved, but there is no usable Git history. |
| Saved, not committed | Commit preparation failed; saved bytes remain. |
| Saved · commit unconfirmed | Inspect history before retrying. No automatic retry occurred. |

Documentation saves, notes, board changes and worker reports attempt narrow local commits only on the project’s Pilot branch. Optional applied Markdown file edits can do so too; proposed edits and general code do not gain automatic commits. On Linux with procfs available, creating an ordinary non-plan document exclusively opens it and creates missing parent folders relative to pinned directory descriptors; unsupported systems fail closed rather than using a pathname fallback. Existing documents still return a conflict, and normal size, file-mode, snapshot and local-history behaviour is preserved. A failure after exclusive creation returns `DOC_CREATE_UNCERTAIN` (503): the file may be empty or partial and may be elsewhere if the filesystem changed. It is never automatically removed, retried or reconciled. Inspect the project files and filesystem state, locate and manually reconcile the created file, and retry only after review. This narrow create path does not make subsequent Git history operations descriptor-relative or protect project-root identity, mount crossings, same-UID mutation, partial writes/crashes or external writer races.

Commits include whole saved action-owned files, not a hunk-level split of prior edits in the same file. Unrelated staged/working files are preserved. An already staged action target is refused. **Commit saved file** is an explicit, revision-checked Markdown retry after reviewing its current contents.

No save initializes a repository, changes branch, pushes, rebases or merges. Hooks, configured filters, signing and network are disabled for local saves. Canceling an agent does not undo a file already written. Git history in a server worktree is not an independent backup.
