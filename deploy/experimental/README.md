# Experimental gateway source only

Both directories here are opt-in components, not part of Pilot's standard image, Compose project,
startup path, or service units. The dashboard-side verifier for `tailnet-gateway` mode is part of the
application, and this owner's deployment runs the preview gateway as a separate enrolled service; no
identity provider is switched by this repository. Do not copy live hostnames, node identifiers, credentials, assertion keys, certificates,
or prior operator evidence into tracked files.

- `preview-gateway-poc/` is the Go + Node isolated terminal-dev-server preview gateway packaging
  source. It has a separate gateway/preview-site purpose and must not be treated as the Pilot
  dashboard authentication proxy.
- `tailnet-dashboard-proxy-poc/` is the Go gateway for Pilot's opt-in `tailnet-gateway` identity mode,
  with a committed `go.sum`, an offline `go vet`/`go test` pass, a Dockerfile, a compose example and a
  disposable end-to-end harness in its `cmd/e2e` directory.
  Its owner/stable-node checks produce short-lived Ed25519 assertions that Pilot verifies only when
  `DASHBOARD_IDENTITY_PROVIDER=tailnet-gateway` is explicitly selected; Cloudflare remains the default
  and its verifier behavior is unchanged. `compose.example.yaml` shows the intended packaging.

The POCs have separate browser/site roles and must not be chained or conflated. The terminal UI's
optional `DASHBOARD_PREVIEW_CONTROL_ORIGIN` value is only a link to a separately authenticated control
site; it does not activate either implementation. Their source and example entrypoints are retained
for review and for an opt-in rollout. Offline and disposable end-to-end tests exist for both the
application verifier and the proxy (forged headers, non-owner and unapproved nodes, replay, HTTP and
WebSocket forwarding); the application verifier ships in the dashboard image and the proxy does not.
The preview gateway is enrolled and serving in this owner's deployment (verified: HTTPS with a valid
certificate, WebSocket upgrade, foreign Origin/Host refusal, an unapproved tailnet peer refused, and
revocation closing a held upgrade). The tailnet identity proxy is not deployed, so no readiness claim
is made for a switched dashboard provider, live ACL policy beyond the preview path, or key custody.
Separate security and owner approval is required before building or running either in production.

Both packages carry their lockfiles (the Go module has `go.sum`, the Node package its lockfile), have
been built from those lockfiles with dependency downloads disabled, and pass their offline tests:
`go vet ./...` plus `go test ./...` for the proxy, `pnpm check` and the Node suite for the preview
gateway. The proxy's disposable end-to-end harness lives in
`tailnet-dashboard-proxy-poc/cmd/e2e` and is re-run against the real dashboard before each release.
