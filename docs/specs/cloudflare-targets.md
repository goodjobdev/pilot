---
title: "Cloudflare deployment target definition prototype"
description: "A non-writing typed identity contract for future Cloudflare Workers or Pages deployments."
pilot:
  schema: 1
  id: cloudflare-targets
  kind: specification
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

## Scope and non-goals

This local, pure validation prototype models an owner-configured destination for an existing
Cloudflare Workers Script or Pages project. It does not register a destination in the application,
install an agent tool, call Cloudflare, access credentials, build artifacts or deploy. The setting is
default-off. The existing revisioned generic action-target store remains a separate persistence seam;
this module does not duplicate it or claim that its generic integration identifiers verify provider
identity.

## Behaviour contract

A target has schema version 1, a positive safe-integer revision, an optional `enabled` flag that
defaults to false, an explicit `production` or `preview` environment, and exactly one destination:
`workers` with an account ID and script name, or `pages` with an account ID and project name.
Strict parsing rejects unknown fields, invalid revisions/environments and cross-kind resource fields.
The SHA-256 identity digest canonically binds provider, resource kind, account, exact resource name
and environment; revision and enabled state are intentionally not resource identity. The safe display
projection retains kind, revision, environment, enabled state and digest, omitting account and exact
resource identifiers. These syntax checks do not prove the values identify an authorized Cloudflare
resource, nor that an account ID is not sensitive data entered in an unexpected field.

This is not an API permission boundary. No claim is made that Cloudflare supports fine-grained
resource restriction, immutable artifact provenance or deploy execution. A future implementation must
separately establish owner-authenticated revision-checked storage, chosen target and authority,
artifact/build provenance, credential handling, scope and policy enforcement, durable intent/receipt,
uncertainty reconciliation, concurrency and rollback. Route/domain mutation and resource creation are
not represented here and remain excluded.

## Acceptance evidence

- **CT-1:** strict parsing accepts the two distinct kinds and rejects unknown, invalid revision,
  invalid environment and cross-kind fields (`tests/unit/cloudflare-target.test.ts`).
- **CT-2:** canonical identity digest changes for account, resource, kind or environment substitution,
  but not for the enabled flag.
- **CT-3:** default configuration is disabled, and the safe display projection omits account and
  resource identifiers.

All evidence is synthetic and local. The implementation is not installed or released; no deployment
capability is available. User instructions do not exist because there is no user-facing control.
