---
title: "Terminal sessions"
description: "Start and use an opt-in interactive terminal in Pilot."
pilot:
  schema: 1
  id: terminal-sessions
  kind: how-to
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

# Before you start

The operator must set `DASHBOARD_TERMINAL=on` for the Pilot service and restart it. The default is
off. This is separate from the agent coding-tool switches; it does not enable an agent shell.

**Read this before enabling it:** the shell runs as the Pilot service user, inherits its environment,
and may access every file, credential and service available to that user. The selected project is
only its starting directory; this is not a sandbox. Do not enable the terminal on a service identity
that should not have broad command access.

# Start a session

1. Open a registered project and choose **Terminal** in the workspace view switch.
2. Choose **New terminal**. Pilot starts the configured login shell in that project's directory.
3. Type commands in the terminal. **Run pnpm check** and **Run pnpm test** are shortcuts that submit
those ordinary commands to the same shell; they do not add safety restrictions.
4. Choose an existing terminal to reconnect its browser, or choose **Stop session** to terminate it.
   A terminal may have one browser attached at a time. At most eight sessions may be live.

Terminal sessions and output exist only in memory. They stop when closed or when Pilot shuts down;
there is no command history or process recovery provided by Pilot. A detached child may outlive its
interactive shell, as it would in a same-user process environment.

## Troubleshooting

- If the terminal is unavailable, verify `DASHBOARD_TERMINAL=on` on the service and restart Pilot.
- If eight sessions are already live, stop one before creating another.
- If a session is attached in another browser, detach or stop it there before reconnecting.
- A browser disconnect does not automatically stop the command; reconnect to the existing session or
  stop it explicitly.
- In the Pilot container, pnpm resolves a repository's `packageManager` version and stores that
  downloaded package manager under `/data/pnpm` on the writable data volume. The first use of a
  version needs registry access; if it fails, check container network access and that the mounted
  `/data` volume is writable by UID 10001. The root filesystem remains read-only.

Pilot does not serve active terminal preview content. A pending design covers only an already-running
dev server started from an owner terminal session—not a disposable manager—and still requires a
separate security/advisor review before implementation. Any future preview must use a separately
reviewed, owner-authenticated origin; preview behavior is not available in Pilot today.
