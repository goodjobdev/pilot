---
title: Repository update contract
description: Safe owner-reviewed fetch, fast-forward and merge updates for connected worktrees.
pilot:
  schema: 1
  id: repository-update-contract
  kind: specification
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

## Intent and scope

An owner needs to inspect GitHub changes and update a managed Pilot worktree without asking an agent to run arbitrary Git. Local documentation commits are expected: divergence is a normal case, not permission to rebase or discard history. Existing-folder registrations and arbitrary branch selection are outside this first slice.

## Design contract

**GIT-1 / Idle:** Workspace → Changes offers Check remote changes, with an explanation that Refresh only rereads local files. A failed check shows a sanitized error and never presents an old review as fresh.

**GIT-2 / Checking:** announce busy status, prevent duplicate actions, preserve current file view and drafts. Fetch changes Git objects and one project-owned tracking ref, not the index, working files or Pilot branch. No background network polling.

**GIT-3 / Review:** show checked time, remote default branch, local/remote pinned hashes, ahead/behind counts, incoming subjects, paths/diffs since their common ancestor and total/hidden path counts. Show whether the proposed result is up-to-date, fast-forward, merge, conflict or blocked. Explain that local documentation commits commonly require a merge. A Proposed result comparison shows the exact candidate tree against pinned local HEAD, including clean rename/merge resolutions.

**GIT-4 / Apply:** an explicit review checkbox and confirmation names the action and pinned target. Disable apply for dirty/staged files, active or uncertain work, conflicts, unsupported transitions, expired/stale reviews and pending browser drafts. Apply only an owner-confirmed target. A new check invalidates the prior review.

**GIT-5 / Completion:** report confirmed head and update mode. Refresh clean views and reset stale undo history. A failure/unconfirmed effect requires review, not automatic retry or rollback. Phone layout must remain usable without horizontal page overflow, and controls need accessible names and loading/error announcements.

## Behaviour and security contract

- Use fixed server-side commands and the registered GitHub URL with the project deploy key and pinned host key. A read key is sufficient. Ignore arbitrary client remotes, branch names and commands. Reject unsupported URL rewrites.
- Updates operate only on the exact managed Pilot branch and require exclusive project serialization shared with documentation saves. Refuse active/uncertain sessions and workers, pending Git operations and index locks. No new agent Git scope is installed.
- Disable hooks, signing, fsmonitor, submodule recursion, external diff, textconv, configured content filters and automatic maintenance. Reject configured custom merge drivers. Never execute repository programs.
- A review pins project/repository, local head, fetched remote head and proposed result. It expires after 10 minutes and is one-use for apply. Changed heads, credentials, branch or worktree require another review. Restart loses reviews safely.
- A clean merge preview computes a result tree without changing working files or refs. An approved divergence creates a two-parent local commit and fast-forwards the Pilot branch to that result. Conflicts do not enter the real index/worktree. Fast-forward updates preserve local history; no rebase, stash, reset, branch switch, push or install occurs.
- Reject changed symlinks/submodules and unsafe file/directory transitions. Check changed-path containment and preserve ignored/untracked collision paths. Validate the resulting canonical plan before updating files. If it is removed or malformed, refuse the update.
- External concurrent writers are unsupported. Recheck heads, index/status and relevant paths before apply. Never force an update after interference. A failure during the Git effect is uncertain until reviewed.
- Fetch can transfer objects and refs even if later preview fails. Merge previews can leave unreferenced Git objects. Neither is an applied workspace update. Do not automatically delete evidence.
- Bound output, preview paths and review storage. Do not expose credentials, raw command errors or excluded file content. Hidden paths still count towards the full approved update.

## Acceptance criteria

| ID | Evidence required |
| --- | --- |
| AC-1 | GitHub URL/key checks remain strict; use disposable local transports in tests, never GitHub or paid models. |
| AC-2 | Fetch/check preserves working bytes, index and branch, including dirty work; incoming preview is against common ancestor. |
| AC-3 | Fast-forward applies the reviewed target and leaves the base checkout untouched. |
| AC-4 | Diverged documentation commits remain ancestors of the approved two-parent result; proposed-result diffs correctly follow local renames. |
| AC-5 | Conflicting merges preserve head/index/files and cannot apply. |
| AC-6 | Dirty/staged paths, ignored collisions, symlinks, submodules, invalid/deleted plans, custom drivers and active/uncertain work block apply. |
| AC-7 | Expired/stale/wrong-project/consumed reviews are refused. Unexpected errors do not expose command output or automatically retry. |
| AC-8 | Hooks, filters and merge-driver marker programs never execute. No remote push/branch switch/reset/stash/install command is issued. |
| AC-9 | Authentication/CSRF guard every new API. Lifecycle and ordinary dispatch cannot start work during the update. |
| AC-10 | Browser checks cover review, incoming diff, confirmation, refusals, draft preservation, local refresh and phone overflow. |

## Delivery and user documentation

Update [remote updates](../manual/remote-updates.md), [first project](../manual/first-project.md), [settings](../manual/settings.md), the connection wording and the installed-capability/security boundaries together. Mark this slice implemented only after local evidence exists, and available only after a separately approved release. No production deployment is authorized by implementing this contract.
