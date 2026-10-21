# Pilot

A self-hosted workspace where **the documentation is the source of work** and durable Pi
agents work from it.

Write the intent first — behaviour, decisions, open questions, diagrams — then let an agent
implement against that page. Pilot keeps the plan, the conversation and the result in one
place, reachable from your phone, with the repositories still owning the truth.

## What it does

- **A documentation wiki.** Browse, edit, search and render any Markdown in a registered
  project: diagrams, images, static HTML mockups, spec links and an open-questions inbox.
  Edits are revision-checked, so a second writer gets a conflict instead of losing work.
- **Durable agents.** One Pi Durable session per project, committed to SQLite as it runs:
  live transcript, steering, stopping, and questions the agent asks that you answer once.
  A run that dies mid-tool resumes from its last checkpoint, and a tool that may have
  partially run is reported as interrupted rather than repeated.
- **Named sessions.** Each project's conversation is adopted as a named, durable session with
  links to the board task, the specification and the workspace it is about. Names are unique
  within a project, every change is revision-checked, and a link is only accepted when the board,
  the documentation or the approved roots actually contain it. See
  [Sessions](docs/SESSIONS.md) and [Migrating the legacy conversation](docs/MIGRATION.md).
- **Repository connections.** Generate a project deploy key in the UI and explicitly connect
  an isolated review worktree; no automatic installs, commits or pushes.
- **Providers and models.** Add API keys or sign in from settings, pick a default for new
  sessions, and star favourites so they appear first. The scripted provider remains the free
  initial default; real calls require explicit opt-in.
- **Phone alerts.** Web Push for questions, finished runs and failures, with a link that
  opens the exact project.
- **A planning board.** The dependency canvas, milestone timeline and task list this app
  started as, with spec links from work items into the wiki.

## How it fits together

```
        phone / browser
              │  owner-only authentication
              ▼
   ┌──────────────────────────────────────────┐
   │ Pilot (one Node process, loopback only)  │
   │                                          │
   │  board  ·  wiki  ·  agents  ·  alerts    │
   └───────┬───────────────────────┬──────────┘
           │                       │
   Markdown in the project   per-project SQLite
   (canonical, in git)       session + task checkpoints
```

Markdown is canonical. The index, the layout, the alerts, the agent sessions and the
named-session registry are all derived or working state — losing them costs you convenience,
never your documentation.

## Quick start

Requires Node 24+ (the first major where `node:sqlite` is unflagged) and pnpm.

```sh
pnpm install
pnpm check && pnpm test && pnpm build
DASHBOARD_MODE=local DASHBOARD_DATA=/tmp/pilot-data PORT=4317 pnpm start
```

Open <http://127.0.0.1:4317>. Local mode embeds a session token in the page it serves and
must never be exposed through a tunnel. A hosted start also requires an immutable release
manifest (`DASHBOARD_RELEASE_MANIFEST`, or `release.json` beside the build) and refuses to start
without one. Startup creates the durable control store (`control.sqlite` in the data root) before
it listens, and refuses to serve if it cannot. `/healthz` is unauthenticated liveness; the
authenticated `/readyz` reports expected-version readiness from the open control store, and
`node dist/server.mjs --doctor` prints a read-only diagnosis without taking the lock. For a real deployment see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); for
what the security model does and does not protect, see [docs/SECURITY.md](docs/SECURITY.md).

Browser tests need Playwright's Chromium once:

```sh
pnpm exec playwright install chromium
pnpm test:browser
```

## Layout

| Path | What lives there |
|---|---|
| `src/shared/` | Pure model: board, documents, agent view mapping, DAG and layout. No Node, no framework |
| `src/server/` | HTTP API, revision-checked stores, agent harness host, alerts, authentication |
| `src/client/` | Svelte 5 interface: canvas, timeline, list, wiki, agents, inbox |
| `deploy/` | systemd user units, tunnel example, and a capped container definition |
| `scripts/` | Offline backup and restore, run with plain Node |
| `tests/` | Unit and server tests (`pnpm test`), browser scenarios (`pnpm test:browser`) |
| `operations/` | Deliberately gitignored: deployment identifiers and progress logs |

## Tests

`pnpm check` (types and Svelte), `pnpm test` (unit and server), `pnpm test:browser`
(Playwright). The suite covers the parts that are easy to get wrong: markdown round-trips,
containment and conflict handling, DAG invariants, the question protocol, alert delivery
through a stubbed transport, multi-project isolation, a 500-task board, and a real
kill-mid-tool recovery run that spawns the server, kills it, and checks what the durable
session recorded. The named-session registry is covered the same way: link refusals for every
kind, a symlink that leads out of the approved roots, stale revisions, idempotent repeats, an
idempotent and dry-runnable migration, and a real start that adopts a project's conversation
exactly once.

## Honest limitations

- **Single owner by design.** One person, one credential, no roles or sharing. It is not
  multi-tenant and there is no rate limiting.
- **The agent harness is code execution.** Agent tools are bounded to a project's workspace,
  but a project you register is a directory the agent may write to. Run it in a container,
  not on a workstation.
- **The backup script covers documentation, not sessions.** Agent transcripts, alert keys and
  credentials are deliberately excluded, so a restore needs a fresh sign-in.
- **An unclean kill leaves a lock.** SIGKILL, OOM or power loss leaves `service.lock` and
  the application refuses to start until an operator confirms no writer remains and clears
  it — fail-closed, but with `restart: unless-stopped` that means a crash-loop until someone
  intervenes.
- **The default provider is a scripted local stand-in.** Real provider adapters are available
  through [Providers & models](docs/PROVIDER-SIGNIN.md); credentials and live sign-in are the
  owner's responsibility. Tests use synthetic providers, not billed acceptance calls. Agent
  tools are still question/note operations, not a complete coding toolchain.
- **Uncommitted code is not a GitHub backup.** Repository worktrees and deployment keys are
  described in [Project connections](docs/PROJECT-CONNECTIONS.md). Review and back up before
  a real migration. Pilot supersedes the earlier dashboard, without automatically importing
  its data or shutting it down.
- **Some internal names keep the historical `DASHBOARD_*` prefix** for environment variables
  and paths. They are stable on purpose; the product name is Pilot.

## Licence and attribution

MIT — see [LICENSE](LICENSE).

Pilot builds on other people's work: [Pi](https://github.com/earendil-works/pi) and
`@earendil-works/pi-durable`/`pi-ai`/`chord` for the agent runtime, Svelte 5 and
`@xyflow/svelte` for the interface, and Marked, DOMPurify and Mermaid for rendering.
Those projects keep their own licences.

The direct dependency licence review found MIT, ISC, and MPL-2.0/Apache-2.0
licences. Dependencies retain their own licences; this is not an exhaustive
transitive licence or legal audit.
