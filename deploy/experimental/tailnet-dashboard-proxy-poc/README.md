# Tailnet dashboard proxy POC

Source-only, separately disabled Go POC. It is not included in Pilot's normal image, deployment
units, or request path. It must not be chained with the
terminal-preview gateway; this proxy has the dashboard's owner-authentication role, while the other
POC is for a separate preview site.

When independently deployed, the proxy design uses its own tsnet TLS listener, checks the accepted
socket's remote tailnet node identity, dials only a configured numeric private dashboard endpoint,
and signs a short-lived Ed25519 assertion. Pilot has an explicit `tailnet-gateway` verifier mode for
such assertions; this setting is off by default and Cloudflare stays the hosted default. The
Cloudflare assertion path remains unchanged. Pilot still enforces exact Host, owner identity, same
origin, session cookie, and CSRF checks. Forwarded identity headers and tailnet membership alone are
not accepted as owner authentication.

The module graph and `go.sum` were generated in a disposable run using cached dependencies; an
offline ARM64 `go test -mod=readonly ./...` passed, but that run did not independently attest module
download provenance. A synthetic integration test exercised a later Pilot verifier's session, CSRF,
and terminal upgrade with fake identity; it did not use a live tailnet or this checkout's production
image. Live tailnet/dashboard access, ACL or egress verification, certificate/key custody validation,
and deployment remain release blockers. Dedicated service identity, state/key permissions,
firewall policy, verified stable node IDs and owner-approved provisioning are still operator work.
Terminal commands run as the Pilot service UID and are not contained by a preview/proxy. This POC is
not production-ready and requires independent review and approval before use.
