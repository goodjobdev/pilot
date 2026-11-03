# Security model

Pilot is built for one owner on a private host. This page states what it protects, what it
assumes, and what it does not protect, so you can decide whether that fits.

## Assumptions

- The host, its filesystem and the operator are trusted. Root on the host is game over.
- The projects you register are yours, and their content is trusted enough to render.
- Authentication is provided by an identity-aware proxy in front of the application, or by
  local mode on a loopback interface you control.

## What is protected

| Concern | How |
|---|---|
| Access | The application verifies the signed assertion itself — signature, issuer, audience, expiry and the allowed owner — rather than trusting identity headers. No bypass mode, no anonymous route |
| Cross-site writes | Session-bound CSRF plus same-origin and JSON content-type checks |
| Host confusion | The Host header must match the configured origin |
| Exposure | `host-loopback` — the default, and the only profile local mode allows — binds `127.0.0.1`. A container may bind its own interface only with hosted mode plus `container-private-interface`, which serves the published port inside its private network namespace; the host still publishes on `127.0.0.1` only, and the surrounding network stays an operator-attested fact |
| Path escape | One containment helper refuses absolute paths, `..` and symlinks; generated and app-managed paths are excluded from ordinary browsing; the canonical plan uses a validated Wiki bridge and source snapshots use their existing read-only source-reference route |
| Resource abuse | Read and write size caps, a document-count cap, a bounded subscription list, and bounded search/inbox scans |
| Untrusted rendering | Markdown is sanitised; assets are limited to images and static HTML/SVG; mockups render in a sandboxed frame with no scripts and no same-origin access; a strict Content-Security-Policy covers the application |
| Agent execution | No HTTP route runs a command. Agent tools are the bounded documentation/planning operations by default. The coding tools are opt-in twice — an instance switch (`DASHBOARD_CODING_TOOLS`, then `DASHBOARD_SHELL`) and the agent's own scope (`file_read`, `file_write`, `shell`) — and `read`/`write` stay inside the connected worktree. The shell is **not** contained and reaches everything the application user can reach. Fixed Git/SSH-keygen provisioning installs or pushes nothing. Documentation saves separately attempt path-scoped local commits only on the project Pilot branch, with hooks, filters, signing and network disabled; no branch switch, push or merge |
| Owner-reviewed remote updates (unreleased) | Explicit deploy-key fetch and exact incoming/result review, followed by a one-use confirmed update of the managed Pilot branch. Refuses active/uncertain work, dirty/staged paths, ignored collisions, unsafe transitions and invalid plans. No agent Git scope, push, rebase, stash, reset or install; restart invalidates transient reviews |
| Credentials | Provider credentials and project deploy keys live outside project roots in 0600 files/0700 folders, excluded from ordinary backups; settings reads return status/public keys only. Login and Git failures do not echo raw credential response bodies or command output |
| Host escape | The container drops all capabilities, runs non-root with a read-only root filesystem, has no Docker socket and no host mounts |

## What is not protected

- **A compromised host.** Anything with root or the data directory can read every project and
  every session.
- **Agent behaviour inside a project.** An agent may write to the workspace you registered.
  Bounded tools are not a sandbox: register directories you are willing to have modified, and
  run the application in a container rather than on a workstation.
- **Same-container shell access.** Secrets are not encrypted at rest. Code running as the
  application user can read provider credentials and deploy keys; these are not per-agent
  sandboxes. **The agent's shell tool is exactly that code**: with `DASHBOARD_SHELL=on` and the
  `shell` scope granted, a model can read the credentials directory, every other project's files
  and the durable control store, and it can run `git push` if the repository's deploy key has write
  access. Grant it only where you accept that, keep write deploy keys off unless pushing is
  intended, and use provider budgets and GitHub repository rules. Write deploy keys are
  repository-scoped, not branch-scoped. The contained alternative is the bounded runner, which is
  network-free and mount-limited but is not an interactive shell.
- **Multi-user abuse.** There is one owner, no roles, no quotas and no rate limiting. It is not
  multi-tenant.
- **Backups.** An archive captures `catalog.json`, the documentation, media, settings, agent
  session databases and `control.sqlite` (operations, receipts, outbox, approvals, named
  sessions and lifecycle). For an external project it captures that project's
  `docs/dashboard` tree only; the repository is its own backup. It deliberately excludes
  `credentials/` (provider keys, sign-ins and project deploy keys), `alerts/` (the VAPID
  signing key and device endpoints), `repositories/` and
  `forks/` (derived git worktrees; the fork records themselves are rows of the captured
  `control.sqlite`), `snapshots/` (the bounded board revision history the application
  rebuilds) and `service.lock`. A restore therefore keeps transcripts and durable
  control state, but it needs a fresh sign-in, new deploy keys and alerts enabled again, and
  the derived worktrees and snapshots must be recreated. Treat the archive and its passphrase
  as the only key to the captured state.
- **The proxy in front.** If you use a third-party tunnel or proxy, that operator sees the
  traffic it forwards. Self-host the relay or keep it on a network you control.
- **A stolen unlocked device** with an active session, and any credential you paste into a
  chat, log or image.

## Static documentation boundary

The separate Starlight build publishes only the reviewed Markdown paths in
`docs-site/pages.json`. Never include runtime plans, registered projects, operations,
credentials or private design artifacts by glob. Draft/sidebar flags do not protect data.
The static site has no application session, server API or deployment configured here.
Publishing it is a separate reviewed operation. Existing engineering/operations documents
remain in Git but are not copied wholesale into the public site.

## Reporting

This is a personal project without a security team. If you find a problem, open an issue that
describes the impact without including live credentials or private data.
