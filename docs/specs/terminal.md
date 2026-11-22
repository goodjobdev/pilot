---
title: "Interactive terminal"
description: "Opt-in owner terminal sessions and their same-user access contract."
pilot:
  schema: 1
  id: interactive-terminal
  kind: specification
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

# Intent

An owner can operate the selected project in an interactive terminal from Pilot. This is a separate
owner-facing session, not a new model tool, general command API or project sandbox.

# Behaviour and authority

- The terminal is absent unless the operator sets `DASHBOARD_TERMINAL=on` and restarts Pilot. It is
a separate switch from the existing agent coding tools (`DASHBOARD_CODING_TOOLS` and
`DASHBOARD_SHELL`) and does not install, replace, or change the existing agent `bash` tool or its
scope checks.
- Terminal API operations use the same authenticated owner, Host, origin and CSRF protections as
other mutations. A stream is attached only with a short-lived, single-use ticket issued through the
authenticated API and an exact same-origin WebSocket upgrade. Tickets are scoped to one session.
- Commands run as the Pilot service user. The chosen project is only the shell's initial working
directory. Its environment and filesystem access are not contained: a command may reach other
projects, application data, credentials and services available to the same user. The terminal is an
explicit privilege grant, not a sandbox.
- The service allows at most eight live terminals, bounds dimensions, input frames, scrollback and
backpressure, and closes sessions on shutdown. Terminal sessions and output are in-memory and are
not durable or replayed after a restart.
- Terminal command shortcuts are ordinary keystrokes sent to the shell, not constrained actions.
They have the same broad privileges as commands typed by the owner.
- Preview is a separate, opt-in gateway on its own tailnet origin
(`deploy/experimental/preview-gateway-poc/`), not a route on Pilot's origin. It forwards only to an
explicit loopback port of a server the owner started, and authenticates the owner on every request and
WebSocket upgrade. It is not a sandbox.

# Acceptance criteria

| ID | Evidence |
| --- | --- |
| TERM-1 | With `DASHBOARD_TERMINAL` unset, terminal API requests refuse and do not start a shell. |
| TERM-2 | An authenticated owner can start, list, attach to, and stop a terminal for a registered project. |
| TERM-3 | Tickets are short-lived, single-use, bound to a terminal, and streams reject a foreign origin. |
| TERM-4 | Sessions are bounded and terminate during application shutdown. |
| TERM-5 | Existing agent `bash` installation and scope policy remain controlled only by `DASHBOARD_CODING_TOOLS`, `DASHBOARD_SHELL`, and the existing agent allowlist. |
| TERM-6 | No active preview content is served from Pilot's origin; the separate gateway serves it on its own tailnet origin with per-request owner authentication. |

The owner guide is [Terminal sessions](../manual/terminal.md). This capability is implemented and
deployed; the preview runs on the separate gateway origin described above.
