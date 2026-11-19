# Experimental gateway source only

Both directories here are opt-in components, not part of Pilot's standard image, Compose project,
startup path, or service units. The dashboard-side verifier for `tailnet-gateway` mode is part of the
application, but no identity provider is switched by this repository and no service here is enabled. Do not copy live hostnames, node identifiers, credentials, assertion keys, certificates,
or prior operator evidence into tracked files.

- `preview-gateway-poc/` is the Go + Node isolated terminal-dev-server preview gateway packaging
  source. It has a separate gateway/preview-site purpose and must not be treated as the Pilot
  dashboard authentication proxy.
- `tailnet-dashboard-proxy-poc/` is the Go gateway for Pilot's opt-in `tailnet-gateway` identity mode.
  Its owner/stable-node checks produce short-lived Ed25519 assertions that Pilot verifies only when
  `DASHBOARD_IDENTITY_PROVIDER=tailnet-gateway` is explicitly selected; Cloudflare remains the default
  and its verifier behavior is unchanged. `compose.example.yaml` shows the intended packaging.

The POCs have separate browser/site roles and must not be chained or conflated. The terminal UI's
optional `DASHBOARD_PREVIEW_CONTROL_ORIGIN` value is only a link to a separately authenticated control
site; it does not activate either implementation. Their source and example entrypoints are retained
for review and for an opt-in rollout. Offline and disposable end-to-end tests exist for both the
application verifier and the proxy (forged headers, non-owner and unapproved nodes, replay, HTTP and
WebSocket forwarding), but no readiness claim is made for an enrolled production node, live ACL and
egress policy, certificate or key custody, browser cookie isolation, or a switched deployment.
Separate security and owner approval is required before building or running either in production.

The source has not been built or tested in this integration worktree. The preview package includes
its Node lockfile and pinned Go module files; the dashboard proxy POC lacks an independent Go checksum
lockfile in its source checkout, which is a release blocker until reviewed and resolved. Do not run
package installation or Go commands that download dependencies as an implicit step.
