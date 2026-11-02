# Pilot — working rules for agents

Read `README.md` first, then `docs/ARCHITECTURE.md` for the invariants and
`docs/DEPLOYMENT.md` for running it. Run `pnpm` commands here, never at a parent root.

## Execution surface

- **The agent harness is the only execution surface.** There is no general-purpose shell,
  command or file API. Agent tools run inside a registered project's own workspace and
  nowhere else. Tools include questions/notes, contained documentation reads and revision-checked
  planning board updates, not a general coding suite.
- Repository connection is a narrow provisioning exception: fixed Git/SSH-keygen operations,
  explicit owner action, one managed worktree, no hooks/install/commit/push. There is still no
  arbitrary command endpoint. See `docs/PROJECT-CONNECTIONS.md` before changing it.
- Documentation saves have a separate, narrow local-history exception: fixed, path-scoped
  commits on the project Pilot branch, with hooks/filters/network disabled. Never push, merge,
  switch branches or sweep unrelated staged files. See `docs/PLAN-SYNC.md`.
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
- Symlinks are never followed. Generated folders and app-managed paths are not ordinary
  document/file-viewer paths. The canonical plan is a validated Wiki exception; source
  snapshots remain read-only through the existing source-reference route. All reads and
  writes are size-capped.
- Agent session databases are derived working state, not a source of truth for the
  documentation itself.

## Never publish

`operations/` is gitignored on purpose: it holds deployment identifiers, hostnames and
progress logs. Do not add it, force-add it, or copy its contents into tracked files.
Check for hostnames, account identifiers, email addresses and tokens before any push.

## Tests

Use disposable roots; never a live project or a real planning document. Git acceptance
tests commit only inside disposable repositories. Never push, publish or synchronise
between machines as part of a test.

## Bounded execution and progress

- The Bash tool's `timeout` is in **seconds**. Use 60–120 seconds for test commands,
  never `timeout: 30000`. Node's `--test-timeout=30000` is in milliseconds and is a
  separate limit; it does not reliably bound process shutdown.
- If assertions pass but Node does not exit, investigate open streams, sockets,
  servers, timers, and teardown. Do not repeat the same hanging command unchanged.
- After a timeout, report the blocker and change the diagnostic approach before retrying.
- Run long checks in a background subagent and keep the owner informed. Do not leave
  the conversation silently waiting on a foreground tool for extended periods.
- Pilot's stopped session incurred at least 3 waits of about 8 hours 20 minutes
  because `timeout: 30000` was used for a test process that did not exit. Preserve
  this regression lesson when changing the test harness.
