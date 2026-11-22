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

**Read this before enabling it:** the shell runs as the Pilot service user, inherits its environment
(except `DASHBOARD_*` and `CF_ACCESS_*`, which describe the service's own deployment and
authentication and are removed so a project command does not run in the dashboard's hosted mode),
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

# Preview a dev server from the terminal

A preview shows a server you started yourself in this terminal. It is opt-in and separately packaged;
nothing here launches, restarts or supervises your process.

1. Start the server on loopback, for example `pnpm dev --host=127.0.0.1 --port=5173 --strictPort`.
   Bind `127.0.0.1`, not all interfaces: the gateway reaches loopback through the container's network
   namespace, and a wildcard bind would also expose the port to every container on Pilot's networks.
2. Run the gateway from `deploy/experimental/preview-gateway-poc/` with its reviewed configuration: a
   dedicated non-root UID, the dashboard's network namespace, its own enrolled tailnet node, and the
   preview port allowlist.
3. Create a route over the gateway's private socket as the gateway service UID, for example
   `manage.mjs create --port 5173`. The gateway serves it as
   `https://<gateway-node>.<tailnet>.ts.net:<port>/` and the route expires after ten minutes; create
   another when it does, and revoke it early with `manage.mjs revoke --id <uuid>`, which also closes
   any open WebSocket for that route.
4. Optionally set `DASHBOARD_PREVIEW_CONTROL_ORIGIN` to an exact HTTPS origin to show a **Manage
   preview** link in the terminal. The link only opens that external control site; it starts nothing.

Every preview request is owner-authenticated at the gateway (owner login, an explicit allowlist of
stable node IDs, no tags, and not the gateway or host node) and every WebSocket upgrade is checked the
same way. The preview is not a sandbox: the gateway shares Pilot's network namespace, can reach Pilot's
loopback listeners, and same-UID terminal code is not contained.
