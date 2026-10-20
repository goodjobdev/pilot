# Project repositories and deploy keys

Add a **managed workspace** with its GitHub URL. Pilot creates the planning
folder first, then opens **Repository & deploy key**. Existing projects can
open that panel from **Board actions**.

1. Generate the project's Ed25519 deploy key.
2. Copy the **public** key and add it in GitHub → Repository settings → Deploy
   keys. Tick **Allow write access** only if this project should be push-capable.
3. Check repository access. This is read-only (`git ls-remote`); write access
   is not tested by pushing.
4. Tick the worktree confirmation and choose **Connect repository worktree**.

Pilot never clones merely because a URL was entered. Connection is an explicit,
authenticated, CSRF-protected action. It does not install dependencies, commit,
push or deploy the website.

## Layout and preservation

```
<data>/credentials/projects/<projectId>/id_ed25519      private (0600)
<data>/credentials/projects/<projectId>/id_ed25519.pub  public
<data>/credentials/github_known_hosts                 pinned host key
<data>/repositories/<projectId>/main/                 base checkout
<data>/repositories/<projectId>/agent/                working tree
```

The review branch is `work/pilot-<first-eight-characters-of-project-id>`.
The agent worktree, not main, becomes the project's Wiki/board root.

Existing planning files are copied exclusively, never over existing repository
files. The old planning folder is retained. Conflicts or interrupted attempts
leave both trees for operator review, rather than deleting possible work.
There is no automatic retry/cleanup of a partial clone. A busy agent must stop
before connection; project routes reject new work while provisioning and prior
document/board writes are drained before the path changes.

One writer owns this worktree. Do not check out the same branch on another
machine for concurrent writes. Review/merge through Git independently.
Main is not edited by provisioning.

## Limits and boundary

The initial implementation supports only GitHub HTTPS/SSH repository URLs.
It rejects credential-bearing URLs, alternate hosts, local protocols, option
injection and query strings. Git runs fixed argv, disables repository hooks and
interactive prompts, pins GitHub's Ed25519 host key, and does not initialize
submodules or execute a dependency install.

This is a narrow provisioning service, **not** an arbitrary shell endpoint.
The server image needs `git` and `openssh-client`. Untrusted repository files
and Git itself still require a patched, isolated host/container.

Keys are never returned through the API, included in a project or included in
ordinary backups. Removal deletes Pilot's private/public key files; revoke the
deploy key in GitHub as well. Deploy keys are repository-scoped, **not
branch-scoped**: a write key is not technically limited to the review branch.
Use repository rules for main protection.

Keys are not encrypted at rest. A shell-capable agent in the same container
could read them. The current agent tools remain question/note tools; adding
general coding tools needs an execution-boundary review and is not done by
connecting a repository.

## Backup and rollback

Uncommitted files are **not backed up by GitHub**. A branch is not a backup until
its work is deliberately committed and pushed. Pilot does not do either
automatically.

The ordinary offline backup copies managed-project Markdown (including Wiki and
board files); it excludes image assets, Git history, agent SQLite state, keys
and provider credentials. Back up the full working repository separately for
code, assets and uncommitted changes.

Before a real migration, record the remote/local base SHAs, preserve uncommitted
and untracked files, and make an independent verified backup. Rollback means
unregistering the project and restoring or re-registering its retained prior
workspace. Do not delete a worktree or branch until its changes are safely
preserved. No automatic repository deletion is provided.

Pilot supersedes the earlier dashboard as the product. That does not itself
copy any older host's data, adopt a board, or shut down its services.
