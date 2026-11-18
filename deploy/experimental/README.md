# Experimental gateway source only

Both directories here are opt-in research components, not part of Pilot's standard image, Compose
project, startup path, or service units. Nothing is enrolled, deployed, enabled, or configured by this
repository. Do not copy live hostnames, node identifiers, credentials, assertion keys, certificates,
or prior operator evidence into tracked files.

- `preview-gateway-poc/` is the Go + Node isolated terminal-dev-server preview gateway packaging
  source. It has a separate gateway/preview-site purpose and must not be treated as the Pilot
  dashboard authentication proxy.
- `tailnet-dashboard-proxy-poc/` is a distinct Go tailnet dashboard proxy POC. Its owner/node checks
  produce assertions verified by Pilot only when `DASHBOARD_IDENTITY_PROVIDER=tailnet-gateway` is
  explicitly selected. Cloudflare remains the default and its verifier behavior is unchanged.

The POCs have separate browser/site roles and must not be chained or conflated. The terminal UI's
optional `DASHBOARD_PREVIEW_CONTROL_ORIGIN` value is only a link to a separately authenticated control
site; it does not activate either implementation. Their source and example entrypoints are retained
for review only. No readiness claim is made for real tsnet enrollment, real TLS/certificates, browser
cookie isolation, actual dashboard terminal sessions, production service identity, egress policy,
or deployment. Separate security and owner approval is required before building or running either.

The source has not been built or tested in this integration worktree. The preview package includes
its Node lockfile and pinned Go module files; the dashboard proxy POC lacks an independent Go checksum
lockfile in its source checkout, which is a release blocker until reviewed and resolved. Do not run
package installation or Go commands that download dependencies as an implicit step.
