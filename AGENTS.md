# Pilot — working rules for agents

Read `README.md` first, then `docs/ARCHITECTURE.md` for the invariants and
`docs/DEPLOYMENT.md` for running it. Run `pnpm` commands here, never at a parent root.

## Execution surface

- **The agent harness is the only execution surface.** There is no general-purpose shell,
  command or file API. Agent tools run inside a registered project's own workspace and
  nowhere else. The current tools are question/note operations, not a general coding suite.
- Repository connection is a narrow provisioning exception: fixed Git/SSH-keygen operations,
  explicit owner action, one managed worktree, no hooks/install/commit/push. There is still no
  arbitrary command endpoint. See `docs/PROJECT-CONNECTIONS.md` before changing it.
- Provider and deploy-key secrets live outside project roots under `<data>/credentials/`;
  do not return them in views or logs. Same-UID shell execution would be able to read them:
  do not claim this is per-agent isolation or enable coding tools by accident.
- Documentation assets are read-only and limited to images and static HTML/SVG mockups,
  served with `nosniff` and, for HTML/SVG, a sandboxing Content-Security-Policy with no
  script source. Never add a route that serves arbitrary file types.
- Every route stays behind the same owner-only authentication, session CSRF and
  loopback-only binding. Never expose the application, an agent or a container runtime
  without authentication, and never grant the container host privileges.

## Data rules

- Markdown in the project is canonical. Board and document edits are revision-checked:
  a conflict preserves the draft instead of overwriting it.
- Symlinks are never followed. Generated folders and app-managed paths are never served or
  edited, and reads and writes are size-capped.
- Agent session databases are derived working state, not a source of truth for the
  documentation itself.

## Never publish

`operations/` is gitignored on purpose: it holds deployment identifiers, hostnames and
progress logs. Do not add it, force-add it, or copy its contents into tracked files.
Check for hostnames, account identifiers, email addresses and tokens before any push.

## Tests

Use disposable roots; never a live project or a real planning document. No automatic
commits, pushes or publication, and no synchronisation between machines.
