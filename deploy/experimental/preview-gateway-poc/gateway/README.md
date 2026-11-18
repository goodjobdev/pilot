# Node preview core

This Node core is part of the isolated preview bridge. Its private entry point is
Linux-only and requires protected service-UID-owned parent directories, a non-root
gateway UID distinct from Pilot, a mode-0600 Unix socket, and the
`peercred-linux.node` addon to enforce `SO_PEERCRED` on each accepted
request/upgrade. Missing credentials or unsupported platforms fail closed; it never
infers identity from an empty remote address.

## Route model

Previews are addressed by **port on the gateway node's own tailnet name**:

- `previewDomain` is the exact node FQDN (for example
  `pilot-preview.<tailnet>.ts.net`), not a wildcard domain.
- `previewPorts` is the explicit, bounded set of listener ports; each route takes
  one free port, so at most one preview per port and `Host` is always
  `<node>:<port>`.
- `allowedPorts` remains the set of *upstream* dev-server ports the owner may
  choose; it is unrelated to the listener ports.
- The preview site must still be a different PSL site from both the control host
  and the Pilot origin.

## Managing routes

There is no browser control site in this design. Previews are the only
browser-facing surface; routes are created and revoked by the owner as the
gateway service UID over the mode-0600 socket:

```sh
docker exec -u <gateway-uid> <gateway-container> node /app/manage.mjs create --port 5173
docker exec -u <gateway-uid> <gateway-container> node /app/manage.mjs revoke --id <uuid>
```

The management request still carries the management `Host`, `Origin` and CSRF
header, so the same host/origin/CSRF checks apply. Because the socket is 0600 and
its peer UID is checked, a Pilot-UID process cannot use it.

## Verification

`gateway.test.js`, `gateway-ui.test.js`, `assertion.test.js`,
`private-socket.test.js`, `boundary.test.js`, `config.test.js` and `supervisor.test.mjs` — **41 tests, 0
failures**, run offline in a network-disabled `node:24-bookworm-slim` container as
a non-root UID.

The Go suite (`go vet ./... && go test -count=1 ./...`) also passes offline in a
network-disabled `golang:1.27.4-bookworm` container as UID 10001. The skip-gated
cross-process lane (`TAILNET_BRIDGE_E2E=1`, real `SO_PEERCRED` addon) passes offline
in a `node:24-bookworm` container as UID 10002.

No deployment, certificate, DNS, or live-tailnet claim is made.
