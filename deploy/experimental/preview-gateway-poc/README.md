# Preview gateway packaging POC

Opt-in packaging for the preview that ships in this repository and is deployed for this owner. It is
not part of Pilot's normal container image or Compose project: the gateway runs as its own service on
a dedicated tailnet node, and a deployment that does not run it is unchanged. The owner procedure is in
`docs/manual/terminal.md`.

This Go + Node gateway serves a separately authenticated preview of a dev server the owner
already started in Pilot's terminal. It is not the dashboard identity proxy in
`../tailnet-dashboard-proxy-poc/`. There is no `TS_AUTHKEY`, owner identity, node ID,
hostname, certificate, or key material in this source: enrollment, node identity, and
persistent state provisioning are owner steps and are not solved here.

## Addressing (tailnet name, one port per preview)

Previews are served on the gateway **node's own tailnet name**, with one listener port per
preview: `https://<gateway-node>.<tailnet>.ts.net:<port>/`.

- No public DNS record, no owner-supplied wildcard certificate, and no Funnel are needed.
  Tailscale issues and renews the certificate for the node name; the ingress re-validates it
  per handshake and refuses any other SNI.
- `PREVIEW_DOMAIN` is the exact node name (must end in `.ts.net`). The ingress compares it
  with the name reported by the tailnet status at startup and refuses a mismatch.
- `PREVIEW_PORTS` is the reviewed listener-port set (unprivileged, at most 32, excluding
  443/22/4319). Each active preview takes one free port; `Host` must carry that exact port.
- The preview host is a different browser site from Pilot (`goodjob.dev`). There is no
  browser control site: routes are managed by the owner as the gateway service UID over
  the private Unix socket (`gateway/manage.mjs`).
- Because the node name is covered by a publicly trusted certificate, the exact
  `<node>.<tailnet>.ts.net` string is observable in Certificate Transparency logs. That
  discloses a tailnet identifier, not access: the name resolves only inside the tailnet and
  every request is still owner-authenticated.

## Boundaries and limits

- The source expects explicit site/port/node/UID configuration, protected key/state paths, a
  dedicated non-root gateway UID, and independently reviewed network policy.
- Sharing the dashboard network namespace reaches localhost-only dev servers; it is **not**
  process isolation. Pilot terminal code can access everything the Pilot UID can.
- No enrollment, certificate, gateway startup, browser boundary, upstream server,
  resource/recovery behavior, or deployment is asserted as verified here.

## Verification (this worktree)

- Go: `go vet ./... && go test -count=1 ./...` passes offline in a network-disabled
  `golang:1.27.4-bookworm` container as UID 10001, including HTTP/WebSocket forwarding and
  the tsnet shutdown lifecycle tests.
- Cross-process lane: `TAILNET_BRIDGE_E2E=1` passes offline with the real
  `SO_PEERCRED` addon in a network-disabled `node:24-bookworm` container as UID 10002 —
  Go ingress ↔ Node core over the private socket, management route creation, HTTP and
  WebSocket upgrade forwarding, and header stripping.
- Node: 41 tests pass offline in a network-disabled `node:24-bookworm-slim` container as a
  non-root UID (`gateway`, `gateway-ui`, `assertion`, `private-socket`, `boundary`,
  `preflight`).
- Container: the gateway image builds for linux/arm64 from digest-pinned Go/Node
  bases and fails closed when started without configuration or without its
  assertion key (supervisor starts both children, preflight refuses, container
  exits 1).
- Live, on the owner's deployment: gateway node `pilot-preview.<tailnet>.ts.net` serving
  `:8443` → the dashboard's loopback dev server, HTTPS 200 with a valid certificate, Vite HMR
  WebSocket upgrade 101, foreign `Host` 421, foreign `Origin` 403, an unapproved tailnet peer
  refused at the request gate, and route revocation closing a held upgrade. The dev server binds
  loopback only, so the preview is the sole authenticated path to it.

## Recreating the gateway after a dashboard release

The gateway shares the dashboard container's network namespace, so replacing the dashboard (every
release) strands it: the old gateway container must be removed and rebuilt against the new one, and
any routes it held are gone. `recreate-gateway.sh` does that in one step and verifies the result
instead of trusting it.

Every deployment-specific value comes from the environment, so the script carries no hostname, node
id, owner login or image id. Keep those in a private file outside the repository, for example:

```sh
# ~/.config/pilot/preview-gateway.env  (0600, never committed)
export DASHBOARD_CONTAINER=...        # the running dashboard container name or id
export GATEWAY_IMAGE=sha256:...       # digest-pinned gateway image
export TAILNET_GATEWAY_NODE_ID=n...   # stable node id the gateway enrolls as
export TAILNET_HOST_NODE_ID=n...      # node id serving the preview
export TAILNET_ALLOWED_REMOTE_NODE_IDS=n...
export TAILNET_OWNER_LOGIN=owner@example.test
export PREVIEW_DOMAIN=preview.<tailnet>.ts.net
export DASHBOARD_ORIGIN=https://dashboard.example.test
```

Then, after a dashboard release:

```sh
set -a; . ~/.config/pilot/preview-gateway.env; set +a
REPLACE=1 ./recreate-gateway.sh            # prints {"gateway": ..., "ready": true}
docker exec --user 10002:10002 "$(docker ps -q --filter name=pi-workspace-pilot-preview)" \
    node /opt/preview/gateway/manage.mjs create --port 5173
```

It refuses to run when the dashboard is not running and healthy, when `DASHBOARD_ORIGIN` disagrees
with the dashboard's own environment, when the state or key directories are not `0700`/owned by the
gateway uid or the key files are not `0600`, and when a container of that name already exists without
`REPLACE=1`. After starting it checks the readiness marker, the shared network namespace, the
read-only root filesystem, the absence of published ports, dropped capabilities and the `0600` private
socket before printing the ids.

The dev server itself is not restarted by this script: it belongs to the terminal session the owner
started, and the release that replaced the container also ended that session. Start it again in the
new container's terminal (`pnpm dev --host=127.0.0.1 --port=5173 --strictPort`) before expecting a
preview response.

See `docs/specs/terminal-preview-design.md` and `../README.md`; independent security review
and owner approval are prerequisites to any use.
