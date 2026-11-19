---
title: "Owner-authenticated tailnet access"
description: "Security and acceptance contract for Pilot's opt-in Tailscale alternative to Cloudflare Access."
pilot:
  schema: 1
  id: tailnet-owner-access
  kind: specification
  doc_status: draft
  feature_status: implemented
  verified_release: null
---

# Status

**Implemented and shipped, opt-in, not enabled.** The application accepts
`DASHBOARD_IDENTITY_PROVIDER=tailnet-gateway` with `TAILNET_GATEWAY_ISSUER`, `TAILNET_GATEWAY_AUD` and
`TAILNET_GATEWAY_PUBLIC_KEY`, and `deploy/experimental/tailnet-dashboard-proxy-poc/` is the matching
gateway source with an example Compose unit. No deployment of Pilot enables it: the live dashboard
still runs `DASHBOARD_IDENTITY_PROVIDER=cloudflare` and Cloudflare Access remains the hosted default.
A tailnet connection or Tailscale membership is not proof that a request is the owner; only a valid
gateway assertion for the configured owner, verified by Pilot, is.

## Problem and outcome

An owner may want to reach Pilot over a private Tailscale tailnet rather than route the application
through Cloudflare Access. If implemented, the owner must authenticate as the configured owner using
an explicitly trusted identity proof, and every existing application route must retain Pilot's
owner-only checks. Cloudflare Access must remain available as an alternative, not be weakened or
silently replaced.

## Scope and non-goals

- Explore an explicitly configured, fail-closed hosted identity mode for owner access over a
  Tailscale tailnet, without changing the existing Cloudflare Access mode.
- Establish a reviewed source of authenticated *owner identity*, not merely a private network path
  or an enrolled node.
- Preserve the current owner session, CSRF, origin, Host, and route protections, including terminal
  WebSockets and any future preview path.
- No anonymous/local-mode tunnelling, shared users, node-membership-as-owner, trusted-by-default
  forwarded headers, or automatic changes to live deployment configuration.
- No Tailscale control-plane provisioning, tailnet administration, deployment, or identity-provider
  secret management in this design task.

## Security contract

1. **Network reachability is not identity.** Being on the tailnet, having a Tailscale IP, or being a
   member of a tailnet does not authenticate the human owner. The design must identify and verify
   the configured owner principal, with a reviewable trust chain and a documented behavior when that
   proof is unavailable.
2. **Headers are not self-authenticating.** `Remote-User`, `Tailscale-User-*`, `X-Forwarded-*`,
   `Cf-Access-*`, and other request headers supplied by a client are untrusted. They may be used
   only if a specifically designed trusted component authenticates the peer, strips/overwrites
   caller-supplied copies, and delivers an integrity-protected assertion over a protected local
   boundary. That component and boundary require explicit review; deployment behind a proxy alone
   does not make a header trustworthy.
3. **Owner-only access stays end-to-end.** All API routes, page/bootstrap data, event streams,
   assets and WebSockets remain authenticated and bound to the owner session, CSRF/origin and Host
   checks. No new unauthenticated route may disclose a session token or enable command execution.
4. **Fail closed.** Missing, ambiguous, stale, malformed, or unverifiable owner identity, invalid
   provider configuration, unavailable identity source, and failed trust-boundary checks deny
   access. Startup must refuse invalid hosted configuration rather than falling back to local mode,
   Cloudflare identity, a tailnet-IP allowlist, or a caller header.
5. **Provider isolation.** Cloudflare Access behavior and its existing audience/signature/owner
   verification remain unchanged when that provider is selected. Tailnet mode must not accept
   Cloudflare assertions unless explicitly selected by its own reviewed configuration; one provider
   cannot silently satisfy the other's checks.
6. **Least exposure.** A future deployment guide must specify private listener/proxy binding,
   ingress restrictions and the trusted component boundary. Tailnet reachability is not claimed to
   be an application firewall or a substitute for owner authentication.

## Behavior and configuration decisions to resolve

The implementation design must choose and document one concrete identity-verification mechanism.
Candidates could include a locally authenticated Tailscale identity API or a dedicated trusted local
identity proxy, but neither is selected or approved by this document. The design must answer:

- How Pilot obtains identity data over a protected channel and proves it came from the expected local
  Tailscale component or proxy, not a remote caller.
- How the exact configured owner principal is matched, normalized and revoked; what happens for
  multiple identities, missing fields, stale identity, daemon restart, or API failure.
- Whether identity is checked at each request or bound to a bounded Pilot session, and how logout,
  session expiry, revocation and WebSocket disconnect work.
- What explicit provider selection and configuration shape prevent Cloudflare and tailnet modes
  from being confused. Exact variable names are intentionally not specified yet.
- How the listener remains private and how direct access that bypasses the identity-verifying
  component is refused.

Until those decisions are reviewed, do not implement an auth bypass, trust an assertion header, or
call a network-membership check owner authentication.

## Acceptance criteria for a future implementation

- **TA-1 — Explicit alternative:** tests show Cloudflare mode remains the default/current behavior
  unless an owner explicitly selects a separately validated tailnet mode; both paths retain
  fail-closed startup and do not silently fall back to one another.
- **TA-2 — No membership-only auth:** integration tests with a tailnet member who is not the
  configured owner are denied; an enrolled device or valid tailnet IP without verified owner
  identity is denied.
- **TA-3 — Header spoofing:** requests carrying forged identity and forwarding headers, including
  headers matching the configured owner, are denied when they do not arrive through the verified
  trust boundary. Tests cover duplicate/conflicting header forms and direct-backend access.
- **TA-4 — Owner proof and failures:** tests cover the configured owner accepted only through the
  reviewed identity mechanism, another owner-like principal denied, and missing, malformed, stale,
  revoked, unavailable or ambiguous identity denied without fallback.
- **TA-5 — Route parity:** integration tests assert owner authentication and existing CSRF, origin,
  Host and session requirements on HTML/bootstrap, API writes, documents/assets, streams and
  terminal WebSockets. No path becomes anonymous.
- **TA-6 — Provider separation:** Cloudflare signature/audience failures remain denied in Cloudflare
  mode; tailnet evidence is not accepted there. Cloudflare evidence alone cannot authenticate
  tailnet mode unless a separately accepted design explicitly says otherwise.
- **TA-7 — Deployment boundary:** disposable production-like tests verify the listener and trusted
  identity endpoint are not exposed beyond the intended private boundary, with no privileged
  container, host networking expansion, or untrusted header trust.
- **TA-8 — Documentation:** deployment and troubleshooting instructions describe exact owner setup,
  revocation, failure behavior, and the fact that tailnet membership alone is insufficient. Status
  remains planned until independently reviewed implementation and release evidence exist.

## Open questions and review gate

- Which identity source and cryptographic/local trust boundary meet TA-2 through TA-4?
- What principal identifier is owner-configured, and how is it rotated or revoked safely?
- Does the production environment permit access to the Tailscale local identity API/socket, or is a
  separately secured proxy required?
- How should setup and break-glass recovery work without a fail-open fallback?

A security/design review must resolve these before implementation. Cloudflare remains the supported
hosted identity path in the meantime.
