---
title: "CI deployment binding contract prototype"
description: "A provider-independent, non-writing identity contract for exact future CI deployment targets."
pilot:
  schema: 1
  id: ci-deployment-contract
  kind: specification
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

## Scope and availability

This is a pure, local type/validation prototype, not a deployment capability. It does not select or
integrate a CI provider, install a tool, persist target configuration, invoke a pipeline, query run
state, access credentials, produce an artifact, or create a durable receipt. Deployment remains
unavailable. There is no user-facing setting or instruction because no configuration surface exists.

## Binding contract

The strict version-1 owner target shape contains an explicit provider/integration discriminator,
project ID, repository ID, pipeline ID and exact environment ID, plus a positive target configuration
revision and SHA-256-shaped pipeline and environment revision identifiers. The provider discriminator
is a required opaque bounded identifier, not a URL, command, credential or inferred provider choice.
The target defaults disabled. No real provider is selected by this contract; the provider identity is
supplied only when an owner configures a target. Syntax validation cannot prove that the owner
actually configured the named resources or that the revision digests correspond to immutable provider
configuration.

An action binding includes that complete target, an immutable source revision and artifact digest,
and separately named preview and action identities. The deterministic SHA-256 binding digest includes
the enabled state and provider discriminator, and changes when any bound identity changes. Its
redacted projection includes only the target revision and binding digest. Hashes and syntax are
comparison aids, not authentication, authorization or proof of artifact provenance. The discriminator
does not authenticate a provider or establish that the named pipeline belongs to it. Callers must still
strictly parse values; unknown fields fail closed.

## Non-effects and unresolved requirements

This contract causes no effect. It is not a durable preview, approval, trigger intent, action receipt,
reconciliation record, concurrency lock, policy/scope check or recovery mechanism. It provides no
guarantee of idempotency, exactly-once execution, trigger status, cancellation, rollback or read-back.
No provider retry semantics are assumed. A future implementation requires owner selection of the
provider and exact pipeline/environment, verification of repository and artifact authority, chosen
authentication and permissions, investigation of real trigger/lookup semantics, server-enforced scope
and policy, durable pre-effect intent/receipt and uncertain-outcome recovery. Until then no trigger or
retry is permitted by this prototype.

## Acceptance evidence

- **CI-1:** strict bounded parsing accepts a synthetic disabled target and refuses unknown fields,
  URL-shaped IDs, mutable pipeline references and invalid revisions.
- **CI-2:** the binding digest is sensitive to enabled state, provider discriminator,
  pipeline/environment configuration revision, artifact, preview and action identity.
- **CI-3:** display redaction omits raw configured identities and artifact digest.

Evidence is synthetic and local; no network, credentials or provider are involved. The contract is
implemented locally only, not installed or released.
