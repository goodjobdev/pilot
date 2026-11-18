# Preview gateway packaging POC

Source-only, opt-in packaging experiment. It is not part of Pilot's normal container image or
service, and no Compose overlay is installed. Do not build, enroll, or deploy it, and do not
use it against a live tailnet as part of ordinary Pilot operation.

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
- Node: 41 tests pass offline in a network-disabled `node:24-bookworm-slim` container as a
  non-root UID (`gateway`, `gateway-ui`, `assertion`, `private-socket`, `boundary`,
  `preflight`).
- Container: the gateway image builds for linux/arm64 from digest-pinned Go/Node
  bases and fails closed when started without configuration or without its
  assertion key (supervisor starts both children, preflight refuses, container
  exits 1).
- These runs prove source behavior only. Live tailnet identity, certificate issuance,
  enrollment, DNS (none is required), and real browser flows remain unverified until the
  owner supplies an auth key and node IDs.

See `docs/specs/terminal-preview-design.md` and `../README.md`; independent security review
and owner approval are prerequisites to any use.
