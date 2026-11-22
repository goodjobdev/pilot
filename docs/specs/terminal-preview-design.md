---
title: "Isolated terminal dev-server preview"
description: "Design and acceptance criteria for the opt-in preview of an already-running terminal dev server."
pilot:
  schema: 1
  id: terminal-preview-design
  kind: design
  doc_status: reviewed
  feature_status: implemented
  verified_release: "20261121T000000Z-r14"
---

# Status

**Implemented and deployed as an opt-in, separately packaged gateway.** A dedicated tsnet gateway
serves one port per preview on its own tailnet name, authenticates the owner per request, and forwards
only to an explicit loopback port on the dashboard's network namespace. The Pilot-side
`DASHBOARD_PREVIEW_CONTROL_ORIGIN` link stays unset by default, so a deployment without that setting is
unchanged. `deploy/experimental/preview-gateway-poc/` holds the gateway source and packaging; the
owner-facing procedure is in `docs/manual/terminal.md`.

The live acceptance run recorded HTTPS 200 with a valid certificate, byte-identical upstream content,
a working WebSocket upgrade, refusal of foreign `Origin`/`Host`, refusal of an unapproved tailnet peer,
and revocation closing a live upgrade. Honest limits: the gateway shares the dashboard's network
namespace (it is not a sandbox), a same-UID terminal process is not contained, and the preview's
upstream is whatever the owner started in their own terminal session.

## Design intent

Let the authenticated owner inspect a development server that is already running in a terminal
session, without exposing the Pilot application or the dev server to unauthenticated network users.
The preview must be isolated from Pilot's own origin, session cookies and authenticated API. The
terminal's broad same-user shell remains a separate risk; this preview is not a sandbox and must not
be presented as one.

## Scope and explicit non-goals

- Preview only a server that the owner has already started in an existing terminal session.
- A future design may specify a narrowly bound preview transport, but this document does not select
  a proxy, port, host, tunnel, process supervisor, or authentication mechanism.
- Do not launch or supervise dev servers, run package manager commands, create a disposable manager,
  or change terminal command semantics as part of preview work.
- Do not expose arbitrary host ports, arbitrary URLs, files, shell output, or the Pilot control API.
- Do not treat tailnet membership, a private IP, an untrusted header, or knowledge of a preview URL as
  owner authentication. Tailnet identity is separately planned in
  [owner-authenticated tailnet access](tailnet-owner-access.md) and is not implemented by this design.
- No live deployment, public tunnel, production project, credential, or non-disposable data is used
  for design validation.

## Flow and state inventory

These are design requirements, not current UI states:

- **TP-1 — Not available:** no eligible already-running terminal server is registered. The UI says
  preview is unavailable; it never guesses a port or starts a process.
- **TP-2 — Request / authorization:** owner requests access to an identified terminal session and
  server. The system verifies the session and owner authorization before creating or displaying a
  preview address.
- **TP-3 — Ready:** preview content is shown from a separately selected preview origin with a
  visible association to the terminal session and an explicit stop/revoke action. The origin boundary
  is not a promise to control the browser's navigation choices; tab versus iframe remains undecided.
- **TP-4 — Denied / unavailable:** unauthorized, unknown, observably stopped/replaced, or
  unreachable server gets a bounded refusal/error. When server identity cannot be revalidated, access
  fails closed rather than assuming it is unchanged. No backend address, secret, environment value,
  or server output is leaked into diagnostics.
- **TP-5 — Revoked / expired:** owner stops access, the terminal session stops, or a detectable
  server/process identity change occurs; the preview stops serving the configured upstream and fails
  closed if it cannot re-validate its association. Reconnect must not silently accept a replacement
  listener solely because it reuses the same port. These checks can detect ordinary/detectable
  changes; they cannot guarantee isolation from hostile code running as the same Pilot service UID.
- **TP-6 — Browser origin boundary:** preview content is served from an origin/site selected by the
  approved design that does not share Pilot's session cookies, local storage, or service-worker scope.
  A proxy may constrain upstream destinations, redirects it follows, and WebSocket upgrades. The
  system cannot prevent the browser or hostile page content from navigating to Pilot or another
  site, and must not claim it can. Whether the preview is presented in a tab or an iframe remains
  undecided; neither choice may be described as preventing all navigation.

Visual layout, mobile behavior, keyboard and screen-reader interaction remain to be designed after
security architecture is approved. Do not mock these states as if they exist in the current app.

## Security and behavior questions requiring advisor review

1. How is the already-running process associated with its owning terminal session and protected from
   port-reuse/TOCTOU substitution? A port number or terminal label alone is not durable identity;
   define the detectable changes that fail closed without promising protection from hostile same-UID
   code.
2. What backend transport restricts forwarding to the configured server endpoint and denies
   caller-selected upstream destinations, redirects to disallowed destinations, and unintended
   access to Pilot or other local services? The boundary must account for the fact that a hostile
   same-UID process may interfere with the listener and is not contained by a proxy alone.
3. How is the browser-facing preview authenticated as the owner independently of the dev server's
   own content and independent of the supplied preview URL? Which trusted component enforces auth
   before any upstream bytes, redirects, errors, websocket upgrades or cache hits are served?
4. Which separate origin/site and cookie policy prevents Pilot cookies, session tokens,
   service-worker scope and local storage from being sent to preview content? How are proxy-followed
   redirects and websocket upgrades constrained to the same authorization boundary? Browser-level
   navigation to other sites is not preventable by this feature and must not be an acceptance claim.
5. What binds the preview grant to one project, one terminal session and the expected listener/process
   identity? Specify which changes can be detected and cause fail-closed revocation. Because the
   terminal and dev server share Pilot's service UID, hostile same-UID code may alter process/listener
   state; exact process binding against that attacker is not guaranteed without a separate OS identity
   or equivalent isolation. Define expiry, terminal shutdown, owner logout, server restart and
   uncertain termination behavior without promising resistance to that same-UID attacker.
6. How does the design fail closed if the broker, identity provider, process inspection, authorization
   store or cleanup path is unavailable? An unclear teardown must not leave a reachable route.
7. How can a hostile dev server attempt DNS rebinding, Host confusion, header spoofing, redirect
   escape, cache poisoning, path traversal, websocket bypass or resource exhaustion, and what limits
   are enforceable without pretending the developer server is trusted?
8. What isolation does the feature actually provide? It must state honestly that terminal commands run
   as Pilot's service user and can reach whatever that identity can reach; preview isolation does not
   contain that shell or hostile server code.

## Review and acceptance criteria for a future implementation

- **TP-AC1 — Correct source:** an integration fixture registers only an already-running server tied to
  an existing terminal session; the preview path never starts a process or invokes a package manager.
- **TP-AC2 — Owner auth:** unauthenticated, expired, wrong-owner and forged-header requests are denied
  before any upstream body, redirect, websocket upgrade or error detail is returned.
- **TP-AC3 — Detectable server association:** tests reject unknown session/server identities,
  cross-project selection, caller-selected upstream destinations, and detectable listener/process
  replacement or port reuse. Detection failures are fail-closed. Documentation and tests must not
  claim protection from a hostile same-UID process; if that threat is in scope, a separate OS identity
  or equivalent isolation is required before implementation.
- **TP-AC4 — Origin and proxy isolation:** browser/security tests prove Pilot cookies, session
  bootstrap, authenticated API access, service-worker scope and CSRF authority are not available to or
  sent to preview content. Tests cover proxy redirect policy, disallowed upstream destinations and
  websocket upgrades. They must not claim the product prevents top-level browser navigation to Pilot
  or another site; tab versus iframe presentation remains a design decision.
- **TP-AC5 — Revocation and recovery:** tests cover owner revocation, logout, terminal stop, crash,
  restart and uncertain cleanup where those events are observable by the preview authority; verify
  access is revoked or fails closed when the authority cannot revalidate. Detectable replacement
  listeners are refused. The implementation and tests must state any limits where process replacement
  cannot be distinguished, especially for a hostile same-UID actor; they must not promise exact
  process binding against that actor.
- **TP-AC6 — Hostile content:** tests exercise attempted redirects to disallowed upstreams,
  DNS/Host confusion, spoofed headers, cache behavior, path escapes, websocket paths, large/slow
  responses and bounded resource use. Tests distinguish broker/proxy refusals from browser actions
  the feature cannot prevent.
- **TP-AC7 — Fail closed and no leakage:** unavailable auth/broker/identity/process state fails closed;
  responses/logs reveal no filesystem paths, credentials, environment secrets or other projects.
- **TP-AC8 — Production-like boundary:** disposable container tests verify intended auth gate and
  network restrictions without privileged containers or host networking; manual owner review checks
  the real browser origin/cookie boundary before any release. No live deployment is part of the test.
- **TP-AC9 — Honest docs:** user instructions explain prerequisites, the selected architecture, stop
  and recovery behavior, and that preview does not sandbox terminal commands. They are shipped with the
  release that provides the behaviour.

## Decisions taken

- **Transport:** a dedicated Go tsnet gateway terminates TLS on its own tailnet node at `:443` and
  forwards to one explicit loopback port per preview; the client speaks ordinary HTTPS and WebSocket to
  `https://<gateway-node>.<tailnet>.ts.net:<port>/`. There is no DNS record, wildcard certificate,
  Funnel or browser control site.
- **Authentication:** per request, the gateway resolves the calling node with the local `WhoIs` API and
  requires the configured owner login, an allowlist of stable node IDs, no tags, and an ID that is
  neither the gateway nor the host node. Cloudflare assertions are not accepted in this path.
- **Isolation:** the gateway runs as a separate non-root UID with a read-only root, dropped
  capabilities, no published ports and no host sockets, and shares the dashboard's network namespace so
  it can reach loopback. That sharing is a documented exposure, not a sandbox; same-UID terminal code
  is not contained against hostile code, and that limitation is stated where the owner configures it.
- **Lifecycle:** routes are created and revoked over a mode-`0600` Unix socket by the gateway service
  UID, and a route expires; a held upgrade is closed on revoke.
- **UI:** the terminal shows an optional link to a separately authenticated control site when
  `DASHBOARD_PREVIEW_CONTROL_ORIGIN` is set; the link starts nothing and is unset by default.
