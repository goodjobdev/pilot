# Tailnet dashboard proxy (opt-in alternative to Cloudflare Access)

This is the gateway half of Pilot's optional `DASHBOARD_IDENTITY_PROVIDER=tailnet-gateway` mode. It
is shipped in the repository and built on request, but it is **not** part of Pilot's normal image,
Compose stack, or request path, and no deployment enables it. Cloudflare Access remains the hosted
default.

## What it does

The proxy joins the tailnet as its own node and terminates TLS on that node's `:443` with the
Tailscale-issued certificate. For every request it:

1. strips any client-supplied identity, assertion, forwarding and authorization headers;
2. resolves the calling node with `WhoIs` and accepts it only when the login is the configured owner,
   the stable node ID is in the explicit allowlist, the node carries no tags, and the ID is neither
   the proxy node nor the Pilot host node;
3. enforces the exact dashboard `Host`, and requires an exact `Origin` for WebSocket upgrades and for
   every non-`GET`/`HEAD` request;
4. dials one fixed private `IP:port` (loopback or private range only) and forwards the request with a
   fresh Ed25519 assertion (`iss`, `aud`, `sub`, `owner`, `iat`, `exp` ≤ 30 s, random `jti`).

Pilot verifies that assertion against `TAILNET_GATEWAY_PUBLIC_KEY`, requires the configured owner as
both `sub` and `owner`, bounds `iat`/`exp`, rejects a repeated `jti`, rejects a Cloudflare assertion in
this mode, and keeps its own exact-`Host`, session-cookie and CSRF checks. A tailnet address or a
client-supplied header is never accepted as identity.

## Packaging

`compose.example.yaml` shows the intended shape: dedicated non-root UID, read-only root, all
capabilities dropped, `no-new-privileges`, resource limits, no published ports, no Docker or Tailscale
socket, no host privileges, protected `0700` state and a `0600` signing key mounted read-only. It shares
the dashboard's network namespace only because the dashboard binds loopback.

## Verification status

- Offline: `go vet ./...` and `go test ./...` cover the fixed destination, Host/Origin enforcement,
  identity-header stripping, node-policy denial, assertion shape and uniqueness, and an authenticated
  WebSocket upgrade.
- End to end (disposable, no live tailnet): the real dashboard in `tailnet-gateway` mode behind this
  proxy with an injected `WhoIs` — see `docs/specs/tailnet-owner-access.md` for the recorded result.
- Still operator work before enabling it anywhere: enrolling a dedicated tagged proxy node, the
  tailnet ACL that limits the dashboard port to the owner's device, certificate/key custody, protected
  state provisioning, and an owner decision to switch identity providers. Switching changes
  `DASHBOARD_ORIGIN` to the proxy node's origin and disables the Cloudflare path for that deployment.
