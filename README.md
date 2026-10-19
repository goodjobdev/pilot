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

Markdown is canonical. The index, the layout, the alerts and the agent sessions are all
derived or working state — losing them costs you convenience, never your documentation.

## Quick start

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm check && pnpm test && pnpm build
DASHBOARD_MODE=local DASHBOARD_DATA=/tmp/pilot-data PORT=4317 pnpm start
```

Open <http://127.0.0.1:4317>. Local mode embeds a session token in the page it serves and
must never be exposed through a tunnel. For a real deployment see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); for what the security model does and does not
protect, see [docs/SECURITY.md](docs/SECURITY.md).

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
session recorded.

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
- **The shipped agent provider is a scripted local stand-in.** It makes the whole path
  testable and free; it is not a model. [docs/PROVIDER-SIGNIN.md](docs/PROVIDER-SIGNIN.md)
  sets out what adopting a real provider takes.
- **Some internal names keep the historical `DASHBOARD_*` prefix** for environment variables
  and paths. They are stable on purpose; the product name is Pilot.

## Licence and attribution

MIT — see [LICENSE](LICENSE).

Pilot builds on other people's work: [Pi](https://github.com/earendil-works/pi) and
`@earendil-works/pi-durable`/`pi-ai`/`chord` for the agent runtime, Svelte 5 and
`@xyflow/svelte` for the interface, and Marked, DOMPurify and Mermaid for rendering.
Those projects keep their own licences.

Every direct dependency is MIT, ISC, or MPL-2.0 (Mozilla's file-level licence, which
applies to those files rather than to code that uses them). There is no GPL, AGPL or
non-commercial dependency, which is why this project can be MIT.
