# Pilot — working rules for agents

Read `README.md` first, then `docs/ARCHITECTURE.md` for the invariants and
`docs/DEPLOYMENT.md` for running it. Run `pnpm` commands here, never at a parent root.

## Product direction and execution surface

The owner has directed Pilot toward opt-in, policy-controlled full-auto operation. The active
integration worktree records this milestone and its incomplete capabilities in
`docs/specs/autonomy-milestone.md`. This is a change of product direction, not proof that any action is
implemented, safe to replay, or deployed. Implement separate capabilities only with explicit owner
configuration, scoped authority, durable evidence and honest failure and recovery semantics.

- **The agent harness is the model execution surface.** Do not add a general-purpose HTTP command
  or file API. The main-branch harness currently provides question/note tools, not a general coding
  suite. Work on optional coding and shell tools belongs in the integration worktree and must be
  opt-in, accurately disclosed, and independently tested. A same-UID shell is not contained to a
  project and can reach credentials; never represent a scope, working directory or acceptance policy
  as sandboxing it.
- Repository connection is a narrow provisioning exception: fixed Git/SSH-keygen operations,
  explicit owner action, one managed worktree, no hooks/install/commit/push. There is still no
  arbitrary command endpoint. See `docs/PROJECT-CONNECTIONS.md` before changing it.
- Provider and deploy-key secrets live outside project roots under `<data>/credentials/`;
  do not return them in views or logs. Same-UID shell execution can read them: do not claim this
  is per-agent isolation or enable coding tools by accident. A separate action scope is not enforced
  against arbitrary shell commands; do not advertise it as such.
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
