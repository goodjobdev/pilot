---
title: "Review and apply remote updates"
description: "Fetch remote changes separately from updating the Pilot branch."
pilot:
  schema: 1
  id: remote-updates
  kind: how-to
  doc_status: review
  feature_status: implemented
  verified_release: null
---

> Implemented and locally verified, but **not yet released**: these controls are not in the deployed workspace release based on fd3fa6f. The instructions below describe the reviewed build awaiting an approved deployment.

## Prerequisites

Connect a managed GitHub worktree and configure its deploy key. Private repositories work with the same read-only key; no account-wide sign-in or token is needed. Durable session state must be available on the server. The target is the repository’s current remote default branch, displayed in the review. This is not a general branch picker. Existing-folder registrations can use local previews but do not gain this credential-managed update path.

## Check remote changes

Open **Workspace → Changes → Check remote changes**. This is an explicit network operation: it fetches objects and a Pilot-owned tracking ref. It does not change your working files, index or Pilot branch, install dependencies, push, or make a model call.

The review shows the remote branch and pinned commit, local HEAD, last check, ahead/behind counts, incoming commits and previewable paths/diffs. Changes since the common ancestor identify incoming work rather than presenting your local documentation commits as remote changes. Some paths cannot be previewed; the total still includes them. Select **Proposed result** to compare the pinned local HEAD with the exact resulting tree. This matters when a clean merge follows a local rename: the incoming and resulting paths can differ.

## Update workspace

Resolve dirty/staged files and stop active work first. Browser drafts must be saved or explicitly left before applying an update.

- **Up to date:** there is nothing to apply.
- **Fast-forward:** review the pinned update and explicitly confirm it.
- **Diverged:** local documentation commits are normal. Review the proposed merge and explicitly approve it. Pilot preserves both parents; it never rebases your local history.
- **Conflict or unsupported update:** no working files or branch are changed. Review externally; there is no automatic conflict resolution.

A review expires and must still match the project, local HEAD and fetched target. A new check invalidates its previous review. A failed/unconfirmed apply is not automatically retried: inspect current history and working files before making a fresh review.

## Safety and limitations

No automatic stash, hard reset, branch switch, push or discarded edit. No hooks, configured content filters, custom merge drivers, submodule update or dependency install. Symlink/submodule transitions and unsafe file/directory changes are refused. Ignored untracked files must not be overwritten. The resulting canonical plan must remain valid. Configured filters are disabled; Git LFS objects are not materialized by this workflow. Unresolved runner interruptions or a truncated runner history require operator review and cannot be bypassed here.

A merge preview may write temporary Git objects but not branch refs or working files. Applying an approved merge creates local history. External concurrent Git writers are unsupported; unexpected interference requires operator review, not forced repair.

After a successful update, clean Wiki/board views reread disk and reset stale undo history. **Sync plan** remains a separate reviewed action for interpreting changed source documents.
