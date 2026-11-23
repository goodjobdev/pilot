---
title: "Milestone: owner-directed full-auto"
description: "The direction change, safeguards and remaining work toward owner-controlled autonomy."
pilot:
  schema: 1
  id: autonomy-milestone
  kind: specification
  doc_status: accepted
  feature_status: partial
  verified_release: null
---

# Milestone — owner-directed full-auto

## Decision and history

Pilot began as an owner-reviewed documentation workspace with narrow question and note tools. Later
iterations added opt-in coding and shell tools, agent scopes, acceptance policy, durable operations,
forks and release controls. The owner has now directed the project to continue towards **full-auto**:
an owner should be able to delegate work end to end, select the level of autonomy, and inspect what
actually happened without having to approve every routine step. The supplied HTML is a starting point
for a consistent desktop and phone redesign, not a replacement for existing product behaviour.

This document records that change of direction. It does not claim that every capability below exists,
or that a test run authorises an external action.

Pilot's own application release is deployed and was verified after promotion: the running container's
image and release manifest digest match the promoted candidate the operator promoted, the container is
healthy, an unauthenticated API call and the readiness endpoint refuse, and a wrong Host is refused.
Authenticated readiness was not exercised, because that requires an owner identity session. The exact
release id, promotion revision, source digest, suite and browser counts, backup digest and rollback
target are operator records kept **outside this repository** under `operations/`, not published here;
this document states only what the capability claims are, not deployment identifiers. That deployment is the
operator release process for Pilot itself; it is not an agent deployment capability and proves nothing
about the `deploy`, `spend`, `provision` or `publish` classes below.
`docs/PLAN.md` preserves the earlier phone-dependability plan and its historical boundaries; this
milestone supersedes its no-shell product direction for subsequent work, not its acceptance evidence.

## Intended outcome

- An owner opts in per instance, agent and action class. Defaults remain conservative and existing
  owner choices are never silently widened. Agents cannot expand their own scopes or policy.
- The UI and agent prompt distinguish installed, granted and effective capabilities and disclose
  refusal, uncertainty and recovery. A named scope is available only if a real tool enforces it.
- The owner can delegate tests, review and consequential actions by class under explicit policy.
  Actions bind the exact project, target and artifact, record durable intent and outcome, refuse stale
  or uncertain state, and do not blindly replay after interruption. Independent external effects need
  their own implementation; an acceptance record alone performs no commit, push, deployment, spend,
  provisioning or publication.
- The owner also wants agents to create and reuse tools, including a Cloudflare MCP Code Mode-style
  integration, without repeatedly setting up credentials. The local, unreleased
  [JSON projection slice](reusable-json-tools.md) provides only deterministic non-network reusable definitions behind
  instance and agent opt-in. It is not Cloudflare or MCP Code Mode. Credential connections and
  executable authority remain distinct future work: design and review lifecycle, scope and target
  enforcement, revocation, secret handling, durable outcomes and uncertainty recovery before any
  external execution. Do not assume a provider or MCP client avoids retrying uncertain writes.
- Existing direct coding tools and optional shell remain separately granted. The shell runs as the
  application user and can access same-user credentials and other projects; working-directory checks
  and individual semantic scopes do **not** contain it. Never market it as sandboxed.
- Preserve owner-only authentication, CSRF, origin and Host checks, Markdown conflict protection,
  explicit release identity and backup/rollback procedures. Never expose secrets in logs or views.
- Improve the workspace consistently from the supplied design reference, including accessible states,
  keyboard use, reduced motion and phone layouts without losing drafts or existing behaviour.

## Remaining work and acceptance

| Work | Current status | Evidence required before claiming complete |
|---|---|---|
| Design refresh | Implemented locally; desktop/phone, theme, reduced-motion, keyboard and draft-recovery browser checks passed. Dialog titles now provide accessible names, focus returns to the opener, and agent field errors are associated with inputs. | Broader accessibility review (including assistive technology and contrast) and verification in the released instance. |
| Forks | Partially implemented locally. The independently reviewed fork-dispatch increment uses caller-owned stable invocation IDs and durable input binding: exact successful retries return the receipt without resubmission, changed text conflicts, and pending/unknown attempts are not replayed. It keeps the lifecycle fence across the awaited child submission; focused disposable child-coding and receipt-failure tests pass. The production caller is now installed on both paths — the owner-authenticated dispatch route and the `fork_dispatch` agent tool under the `fork` scope, both bound to the calling conversation's own session — so a child submission goes through the durable invocation binding and the held lifecycle fence instead of an unfenced transcript call. Other submission paths remain unfenced; this is not atomic admission or proof of provider quiescence. A held lifecycle or creation fence now has an explicit owner recovery route: it releases only the fence, needs the exact revision and a quiescent session, and dispatches, replays and removes nothing. Active fork discard and automatic removal of an existing worktree remain unavailable, and a process that dies with a fence held or a removal started still requires the owner's deliberate decision; parent-rooted documentation, acceptance, commit, push, deploy, publish, provision and spend tools are refused in child sessions. | Safe active-fork recovery, race-resistant workspace creation/removal, recovery of held fences, detached-process safety, restart races, broader independent review and fuller end-to-end isolation tests. Shell remains uncontained. |
| Project file operations | Ordinary Wiki body and allowlisted asset reads, bounded document listing, and ordinary exclusive document creation use Linux descriptor-relative backends with no pathname fallback. The canonical plan's board-backed bridge remains pathname-based. Post-open create failures report an uncertain outcome for manual reconciliation; later history operations remain pathname-based. Separate disposable seccomp fixtures denied `statfs` and verified unavailable responses, not every procfs failure mode. Parent-directory checks elsewhere remain non-atomic; a disposable fixture reproduced an out-of-project read before the reader change. The owner selected Linux only for now. | Race-resistant operations across all installed paths, including writes and history; root identity, mount and hard-link policy; preservation of revision conflicts, size caps and recovery; full independent review and disposable Linux end-to-end tests. Pinned parents can be renamed; no claim of same-user process isolation or whole-app containment. |
| `run_tests` | **Installed locally and default-off.** With `DASHBOARD_TEST_RUNNER=on`, a named agent bound to a session, holding `run_tests` and granted the project can call the `run_tests` tool. It runs one constant recipe — `node --test` with no arguments — as a child process of the application in the registered project root, with a durable intent written before the process starts and a bounded receipt afterwards. A duplicate invocation identity reuses its operation; a timeout, cancellation or restart records `unknown`/`interrupted` and is never replayed. The rolling-hour `maxJobsPerHour` limit is enforced through the durable agent budget ledger, and the versioned authority is re-checked in the intent transaction and immediately before `spawn`. Disposable-project tests cover a real passing and failing run, process-group timeout and cancellation, output caps, revocation before `spawn`, the job-rate cap, duplicate idempotency and a killed application process. It is **not a sandbox and not a container**: it runs as the application user inside the application container, can read `credentials/`, the durable store and every project, has no cgroup memory or PID limit, and its process-group termination is best-effort. The legacy container broker remains unavailable and the experimental injected harness extension remains test-only. | Independent review of the local runner and its docs; a separately hosted execution service with real containment; resource limits; owner-visible usage; scoped fork/workspace semantics and provenance; broader revocation and crash tests. |
| Agent budgets | Durable per-agent request reservations are implemented locally. Supported provider payloads are checked for the requested output bound; uncheckable transports, including Codex and ChatGPT sign-in, are refused. Provider compliance is not proven. The installed local `run_tests` path reserves one rolling-hour job through the same ledger before it writes its durable intent, and the cap is enforced by the path a model really reaches; the reservation is never refunded, and the window uses the host clock. No other application job path uses it. | Independently reviewed accounting and revocation races, owner-visible usage, safe rollback and full end-to-end coverage. Not a spending cap. |
| Acceptance evidence | `acceptance_accept` is installed whenever a durable control store exists; only `acceptance_record` is switch-gated, and with `DASHBOARD_AGENT_EVIDENCE_RECORDING=on` a bound agent with `accept` can record self-reported same-session evidence as well as accept evidence for an exact artifact under the current policy; admission rechecks versioned authority and the session gate, one acceptance is reserved once, and a pending or uncertain intent is never retried. Evidence is a claim: it is not proof that tests ran or that a diff matches an artifact, and it performs no commit, push, deploy, spend, provision or publication. | Independent review of model evidence admission and rendering, provenance disclosure and end-to-end links to real action targets. |
| `commit`, `push` | **Installed locally and default-off** (`DASHBOARD_AGENT_COMMIT=on` / `DASHBOARD_AGENT_PUSH=on`). With a durable control store, an owner-configured commit target and an owner-configured local push target, a bound named agent holding the scope, same-session evidence and `agent-may-accept` with `full-auto` for the class, `commit_accepted` creates the exact immutable staged-tree commit on the fixed Pilot branch (never staging, never pushing) and `push_accepted` pushes exactly that accepted commit, without force, to the configured local filesystem remote. Both use the accepted-action executor: durable intent, a verified receipt, uncertainty with the barrier retained, and no automatic replay; a moved remote is refused before any intent. Disposable repositories and a disposable bare remote cover the end-to-end path, refusal races and duplicate invocation. Limits: the remote is a local filesystem repository, so there is no hosted credential or transport integration; staging does not scan for secrets; revision checks are not external-writer CAS; a final check-to-write race and remote identity are not eliminated. | Independent review of the installed wiring, transport and target routes; a hosted Git integration would need its own protected broker, credential lifecycle and remote identity. |
| `deploy` | A **local** deploy tool is implemented locally and default-off behind `DASHBOARD_DEPLOY=on`; see [Local deploy and publish](#local-deploy-and-publish-implemented-locally). It promotes an exact owner-configured built artifact into one owner-configured local directory through a staged copy, an immutable generation and an atomic `current` link swap, reads the served digest back and retains the previous generation for manual rollback. It is a local filesystem target, not Cloudflare, a self-hosted service or a CI/CD pipeline. Provider deployment remains unavailable: no provider transport, credential, target, routing or adapter is installed, and the [Cloudflare target](cloudflare-targets.md) and [CI binding](ci-deployment-contract.md) remain non-writing prototypes. | Independent review of the local adapter's uncertainty, concurrency and rollback limits; provider selection with owner authority, artifact provenance and provider-specific reconciliation before any provider write. |
| `spend` | Implemented locally and default off (`DASHBOARD_SPEND_ACTIONS=on`). Real `spend_preview`/`spend_accepted` harness tools are installed only with a durable control store, an owner-configured billing endpoint with a private credential, one fixed currency and both caps, a bound named agent holding `spend`, and evidence accepted for `spend` under `full-auto`. Spend reserves its amount durably before one non-retried `POST`, refuses redirects, requires the exact JSON media type and a provider charge id, bounds the response, and records non-2xx, timeout, lost or unverifiable outcomes as unknown with no replay. It is **not provider-side exactly-once** and **not a global spending cap**; reservations are never refunded; revocation cannot cancel a request already in flight. Disposable tests use a loopback billing stub only; no live billing target is configured. | Independent review of cap accounting, credential handling, provider contract and uncertainty reconciliation; a provider that really honours the idempotency key; owner-visible receipts in the released instance. |
| `provision` | Implemented locally and default off (`DASHBOARD_PROVISION_ACTIONS=on` with `DASHBOARD_PROVISION_ROOT`). Creates exactly one Pilot-owned local directory with a bounded manifest through staging and one atomic rename, idempotently for identical content and as a conflict otherwise, refusing escapes, symlinks, unowned targets and oversized input; the approved root must overlap neither the data root nor a registered project. It is not infrastructure provisioning and makes no provider call. | Independent review of race-resistant path handling; a real provider resource target if one is ever chosen; verification in the released instance. |
| `publish` | A **local** publish tool is implemented locally and default-off behind `DASHBOARD_PUBLISH=on`; see [Local deploy and publish](#local-deploy-and-publish-implemented-locally). It copies an exact, bounded set of reviewed files into one owner-configured local publication root through a staged copy and one atomic rename, then reads the digests back; a previous publication is never replaced. It is a local filesystem target, not a provider or CDN channel, and has no rollback pointer. | Independent review of its bounds, refusal paths and interruption handling; a provider or CDN publication needs its own exact target, authority and adapter. |
| Release | Deployed and verified by the operator; the release id, revision, digests and verification logs are operator records kept outside this repository. Every action tool described above is in the deployed build, and each is default-off. | Independent review of the final candidate, full Linux suite and browser suite, immutable artifact identity, verified encrypted backup with an isolated paused restore, promotion, and post-promotion health and access-denial checks. Authenticated owner readiness cannot be exercised from this environment and is recorded as missing evidence rather than a pass. |

### Installed spend and provision adapters (default off)

`src/server/agents/accepted-spend.ts` and `src/server/agents/accepted-provision.ts` are the first
installed adapters for a consequential class. Both are composed in `createApp` only when their
deployment switch is on, and both need `AcceptedActionExecutor`: durable intent, the receipt and an
uncertain outcome come from that executor, not from the adapter. Each tool rechecks the bound agent's
live scope, the project scope, the owner target and the acceptance policy around the effect.

- **Spend** sends one `POST` to one owner-configured HTTPS endpoint (plain HTTP is accepted only for
  a loopback address). The endpoint, bearer credential, account and currency are owner configuration;
  the credential is a private file under `<data>/credentials/`, outside every project root, and is
  never returned to a model or written to a log. Two hard caps are owner configuration: a per-charge
  cap for the class and a per-project cap, both enforced by a durable reservation ledger whose sum is
  re-read inside the same write transaction that admits the reservation. The `Idempotency-Key` is
  derived from the accepted artifact, so the same accepted charge is one durable intent. Redirects
  are not followed, the media type must be exactly JSON, the response is bounded, a provider charge id
  is required, and there is no retry path. Non-2xx, redirect, timeout, lost response and an
  unverifiable body are all recorded as unknown, with the intent and cap reservation retained.
  **Provider-side exactly-once is not claimed**: honouring the key, its lifetime and its scope are the
  provider's contract and are not verifiable here. This is **not a global spending cap**: it bounds
  only charges Pilot sends through this one target; other providers, other projects and direct
  provider activity are outside it. Revocation is rechecked before the request and cannot cancel a
  request already in flight. There is no provider reconciliation, refund or receipt display beyond the
  durable action history.
- **Provision** creates one directory holding one bounded `manifest.json` at
  `<approved root>/<projectId>/<targetId>`. It writes the manifest in a staging directory and publishes
  it with one `rename`. Identical content is idempotent (the existing receipt is returned) and
  different content is a conflict. It refuses path escapes, symlinked roots, parents, targets or
  manifests, an existing target that is not a Pilot-owned resource, and oversized input, and the
  approved root must not overlap the data root or a registered project. It creates no infrastructure
  and calls no provider. Check-then-use on the filesystem is not atomic, `rename` atomicity is the
  POSIX filesystem's, and parent directories are not fsync'd; this is not a crash-durability claim.

Both tools are refused in forks. Disposable tests in `tests/server/accepted-spend.test.ts`,
`tests/server/accepted-provision.test.ts` and `tests/server/accepted-provision-spend-tools.test.ts`
use a loopback billing stub and disposable roots; no external network or live credential is used.

### Accepted commit (installed, default off)


The application now installs `commit_preview`/`commit_accepted` when `DASHBOARD_AGENT_COMMIT=on` and
`push_preview`/`push_accepted` when `DASHBOARD_AGENT_PUSH=on`, with the durable control store. Both
require a named agent's own same-session evidence and a current `agent-may-accept` policy whose class
decision is `full-auto`; a class decision other than `full-auto` refuses the action. The owner-selected
adapter fixes a target ID, revision, project and Pilot branch; the model supplies no path, command,
branch, remote or target. An owner-authenticated, revision-checked interface configures the fixed
project Pilot commit target and the push target; the push route derives the remote digest from one
local remote the owner names, and accepts no URL, branch, actor or command. The push transport reaches
only a local filesystem repository: there is no hosted credential integration and no network
transport, so a remote identity at a hosting provider remains unimplemented. The more general target registry is not exposed through the application; its actor label is
not authentication. Preview reports the target,
its definition fingerprint, staged tree identity and parent. The evidence artifact binds those values
before an accepted action reserves that acceptance once durably. The adapter rechecks the staged tree, branch, parent, policy, target and
scope, creates the exact immutable tree commit without hooks, and compare-and-swaps the branch. It does
not stage or push anything. It refuses disallowed paths and symlinks; that is not a secret scanner or
proof that allowed content is safe. A pending or uncertain intent is never automatically retried.
After effect execution is entered, cancellation stops the executor's wait even if the adapter does not
settle, and records uncertainty when possible. The adapter may still perform effects afterward; the
intent and any resource barrier remain held. This does not bound earlier authorization or preflight
checks, and a failed state update can leave the intent pending.

The application creates the port only when its switch is on, but this is still an unreleased
capability with no staging tool, reconciliation controls or owner approval flow. An owner action history reports durable intent states and validated receipt metadata; owners can record revision-bound, unverified observations, but neither feature retries an action or releases its barrier. Neither independently verifies the target;
the embedding must supply a live session check that refuses unsupported fork workspaces. A preview
writes Git tree objects even though it does not update a branch. Evidence is a claim and the adapter
checks the actual Git tree, not whether its diff/test claims are truthful. Revocation checks are
admission checks, not a lease: revocation after the last check cannot retract a started effect.
Interrupted Git commands and competing updates can leave an uncertain outcome, so inspect the branch
and durable intent; do not manually replay it. A target fingerprint binds stored identifiers, not the
repository or integration those identifiers resolve to. Independent review found that the Git directory is not
pinned against replacement. `update-ref --no-deref` prevents a symbolic-ref swap from updating its
unrelated destination, but can replace the swapped symbolic ref itself; exact target identity is not
proven. Repeating `lstat`, `realpath`, branch, parent or tree checks around Git subprocesses would still
be check-then-use: the path or `.git` indirection can change after a check and before a later
subprocess, so post-checks cannot prove which repository/ref received the write. The adapter refuses
an indirect HEAD or symbolic configured branch during inspection and repeats its snapshot after commit
object creation; a detected post-admission substitution remains uncertain. These checks only detect
some substitutions, not ones after the final check, and do not pin a repository. Before this capability
could be described as exact-target execution rather than best-effort checking, the target belongs in
broker-owned storage that the caller and other same-UID processes cannot rename or modify; have a separately protected broker
resolve and retain the repository/worktree and Git-directory identity for the operation, reject
linked-worktree or gitfile redirection unless the broker pins and validates both common Git dir and
worktree, and perform the final ref update through an OS primitive or broker transaction that cannot
be redirected by replacement of the checked pathname. The broker must serialize competing target
updates and verify the exact ref identity and expected old value at the write boundary. Tests must
substitute the project root, `.git` directory/gitfile, and branch ref between each preflight and write
against disposable repositories, proving refusal or exact-target-only update; tests that merely check
for detection after the write are insufficient. These are requirements, not capabilities provided by
this prototype. The protected ref mutation proposal in `protected-ref-mutation-design.md` describes a
possible separate broker and its unproven authorization, recovery and remote-identity assumptions; it
is design only. These races and the missing pinning remain open, so the installed adapter is
default-off, is offered only where an owner configured an exact target, and must be described as
best-effort identity checking rather than exactly-once execution. Staging is not secret scanning, and
the push transport's local-only restriction is a deliberate limit rather than a guarantee about the
remote's contents. Same-UID shell remains unrestricted. Older releases ignore action intents, making
rollback across this boundary unsafe without review. No external Git repository or push was used in
tests: the push tests use disposable local repositories only.

#### Installed push target and local transport

`push_preview`/`push_accepted` are installed with `DASHBOARD_AGENT_PUSH=on`. The owner route
`/api/projects/:id/action-targets/push` accepts only a revision, an enabled flag and the name of one
remote already configured in the project's Git repository. The server resolves that remote from the
repository's own configuration, refuses a network URL, a relative path, a symlink or a non-canonical
path, and stores the branch it chose plus the SHA-256 of the remote's canonical local path. The remote
URL is never returned, logged or put in a refusal.

The adapter performs one non-force `git push` of one accepted commit to that branch, with hooks,
filters, credential helpers and every protocol except the local file transport disabled. It verifies
the commit exists in the project, is reachable from its branch, has at most one parent, and that the
remote branch is empty, at the accepted commit's parent, or already at the accepted commit; it
re-reads the remote branch head immediately before the write and reads it back afterwards. The
service's post-push read-back is an observation through the same adapter: it does not prove the
branch stayed there, and an external writer can move it. These checks are not atomic with Git's ref
update, so the outcome of a lost receipt is uncertain and is never replayed automatically. The
transport is deliberately local-only: a hosted remote, credential resolution, provider ownership and
remote identity remain unimplemented, and staging is not secret scanning.

#### Frozen staging manifest seam (uninstalled)

A small pure in-memory prototype now reuses the runner snapshot validator to bound and normalize
regular-file byte manifests (1000 files, 2 MiB/file, 8 MiB total), permit only regular-file modes,
reject disallowed paths, symlink/special modes, duplicate and file/directory collisions, and bind a
canonical SHA-256 identity to the configured project/target id, target revision, target digest and
branch. Supported paths are conservatively limited to ASCII letters, digits, dot, underscore, slash
and hyphen; collisions compare ASCII case only. This is not a claim of cross-platform filesystem
name equivalence. The manifest must come from trusted
owner configuration; this code cannot establish who supplied it. It snapshots no live filesystem,
creates no protected broker object store or Git tree, and is not wired into an endpoint or action.
The frozen value is only in-process immutable data, not immutable storage. No distinct-UID boundary,
protected target repository/ref identity, provenance, secret scanning, durable receipt or recovery is
provided. Thus the frozen-staging module is a validation seam, not frozen staging security. It is **not** the
installed commit path: the installed `commit_accepted` adapter writes the exact staged tree through
Git plumbing on the fixed Pilot branch, and the limits above (protected repository/ref identity, a
final check-to-write race, remote identity) remain the honest limits of that installed adapter too.

### Accepted push (installed, default off, local remote only)

An injected `push_preview`/`push_accepted` model path was exercised against a disposable local Git
repository through a test-only transport. Its artifact binds one configured remote identity digest,
branch and commit; same-session acceptance and the current matching full-auto policy revision are
required. The target, artifact and content are rechecked before a durable single-use effect intent.
A lost response, cancellation after admission, or failed remote verification remains uncertain. A
second acceptance for the same bound effect cannot automatically replay it. The prototype also
retains a resource barrier derived from the configured repository digest and branch, so its own target
aliases and revisions with those same values cannot admit another push, even after success. It has no
release or recovery path. This is not global exactly-once execution: different assertions for the same
repository, other writers, older code or another store can bypass the association. For a new push,
the control store checks the resource key against the current configured target and target fingerprint
under its writer transaction; historical push barriers are checked against their original validated
target revision. This validates the configuration binding, not remote identity or caller authority.
The global history and target-chain scans are synchronous and unbounded while holding the writer lock,
so they need an indexed, bounded design before production. Legacy keyless push history blocks all new
resource admissions conservatively until separately reviewed recovery; it is not silently migrated.

The uninstalled service now rejects non-string and non-exact 40-character commit and observed-head
identities, including values with trailing newlines; a malformed post-effect observation remains
uncertain. Synthetic tests exercise that boundary without a Git operation. This validation does not
establish remote identity or make the prototype available.

The observed remote head is informative, **not an accepted or reserved precondition**. Non-force
semantics, repository identity resolution, source-object verification and read-back are obligations of
the injected transport. After a matching push receipt the service performs another read-back and
requires the head to match; a failure or mismatch remains uncertain. This uses the same injected
transport, so its reported digest and receipt are not independent proof, and the branch can change
immediately afterward. An inspection that never settles can leave the operation pending; cancellation
does not prove termination. No production transport, credentials, push-target configuration UI or
reconciliation controls are installed. The read-only action history is not proof of the remote state. Policy
and scope revocation are admission checks, not atomic cancellation of an external effect. Evidence
claims do not prove tests or diffs came from the pushed commit. Never enable this path until those
boundaries are implemented and independently verified. Tests used no external push.

### Agent deployment target

The owner wants eventual agent deployment support for (1) a Cloudflare application, (2) a
self-hosted application and (3) a CI/CD deployment pipeline. No specific project, service, pipeline,
environment, artifact authority or credential has yet been designated for any of these. The local
filesystem deploy added later is none of these three: it has no provider, service, pipeline or
credential, and does not route or serve the result. All three
remain unavailable until exact integrations and resource boundaries are chosen, implemented and
reviewed. An uninstalled, non-writing `src/shared/cloudflare-target.ts` prototype validates separate
Workers and Pages target definitions and produces a redacted display; it does not verify provider
identity, credentials, artifacts, policy or deployment outcomes. See `docs/specs/cloudflare-targets.md`.
The uninstalled synthetic deploy experiment is not one of those integrations or release
evidence. The separate documentation site is not automatically the intended target, and no Cloudflare
provider write has been made. Operator deployment of Pilot itself remains a separate release process.

Full-auto is complete only when each requested class has a real, verified action path and its owner can
inspect policy and outcomes. Where a provider or target has no safe adapter, report it as unavailable;
never silently substitute shell access or an acceptance decision. Scope changes, budget exhaustion,
crashes, revocation and concurrent writers require explicit tests. A green suite is evidence, not a
substitute for reviewing security boundaries or validating the deployed service.

### Owner decision: unreviewed action classes stay unavailable (2026-11-08)

The owner reviewed the remaining action-class blockers and directed that `commit`, `push`, `deploy`,
`spend`, `provision` and `publish` be recorded as **specifically identified unavailable
integrations for this milestone** rather than shipped or approximated. `accept` remains implemented
but default-off, because it records a decision about claimed evidence and performs no external
effect.

**Superseded for the local adapters (2026-11-08, later the same day).** A completion audit for this
milestone requires a real, installed path for every class it names, so the owner set aside the blanket
unavailable record. This build now installs local, default-off adapters for `deploy`, `publish`,
`spend` and `provision`, and for `commit` and `push` against an owner-configured local repository and
remote — each described in its row above and in the sections below. Every one of them needs an
owner-configured target, a bound named agent holding the scope, same-session evidence accepted for the
class under `full-auto`, and its own deployment switch; each performs a real effect with durable
intent, a receipt and honest uncertainty, and none is a provider integration. No live billing target,
production provisioning root, hosted Git credential or Cloudflare/CI deployment transport exists, so a
provider-side capability for those classes is still **not** installed and is not claimed.

Reasons, each evidenced elsewhere in this document and its linked investigations:

- **`commit`** and **`push`** are now installed locally and default off (see their rows above), and
  they are the classes this build really performs: an exact staged-tree commit on the fixed Pilot
  branch, then a non-force push to one owner-configured *local filesystem* remote. What remains
  unavailable is the **hosted** side of both: protected repository/ref identity against external
  writers, a hosted credential and transport, and remote identity verification.

- **`deploy` (provider/CI/CD)** has no agreed agent-facing provider protocol or provider-verified
  artifact authority. The owner has chosen a separate static test website and a disposable
  repository for future work, but that is an operator procedure, and the Cloudflare/CI prototypes
  are non-writing and uninstalled. A separate operator deployment of Pilot itself is not an agent
  capability. The local deploy added later is not this provider capability.
- **`spend`** is implemented locally and default-off, but only against an owner-configured billing
  endpoint; no live target is configured, and it is not provider-side exactly-once or a global cap.
- **`provision`** is implemented locally and default-off, and creates only a Pilot-owned local
  directory with a bounded manifest; it is not infrastructure provisioning.
- **`commit`, `push`** are implemented locally and default-off against an owner-configured
  repository target and a local filesystem remote; no hosted Git credential or transport exists.
- **provider `deploy` and provider/CDN `publish`** still have no target, protocol or artifact
  authority, so a local filesystem destination is the whole capability and must not be described as
  provider deployment or publication.

The application enforces and discloses both states. A scope whose deployment switch is off has **no
installed tool**: the closed tool-to-scope map refuses a call, the model prompt lists the scope as
granted but not usable, and the owner-visible capability report marks it unavailable
(`tests/server/agents.test.ts`, `tests/server/agent-capability-reporting.test.ts`). A scope whose
switch is on has a real installed tool, and the same vocabulary reports it as installed; where the
class needs an owner-configured target, a run without one is refused at call time by name (for
example "No commit target is configured"), not silently reported as an uninstalled capability. What is not installed and is not claimed is the provider side:
Cloudflare/CI deployment, provider or CDN publication, and a hosted Git transport. No shell access, acceptance decision or
documentation record substitutes for any of those effects. The installed local `deploy` and
`publish` tools are separate, switchable, scope-gated and policy-gated, and are still local
filesystem operations rather than provider deployment.

### Owner decision history: model-facing test execution stayed unavailable (2026-11-08), superseded

On 2026-11-08 the owner directed that model-facing test execution be treated as a specifically
identified unavailable integration for that milestone rather than shipped incomplete. The recorded
reasons were about a **container or hosted execution service**: no authenticated runner service, no
protected journal existence or freshness authority, supervisor dispatch and close not being one
authority, policy and job budgets in a different store from dispatch, runtime identity, hard
lifetime and termination not proven, and a supplied-byte snapshot digest not proving project/fork
provenance or a coherent file state.

That decision is **superseded for the local, uncontained recipe** by the increment recorded above.
Nothing about it is relaxed for containers or a hosted service: the legacy Docker port and the
experimental service-side runner remain unavailable, and the reasons above still apply to them. The
installed capability is deliberately a different thing — one fixed `node --test` recipe as a child
process of the application, with a durable intent and receipt and honest uncertainty — and it makes
no containment claim. `docs/RUNNER.md` states exactly what it can reach, and the capability is
default-off behind `DASHBOARD_TEST_RUNNER=on`.

The uninstalled container prototypes and characterizations remain in the worktree as evidence. They
are not part of the installed capability and must not be described as one.

### Local deploy and publish (implemented locally)

On the owner's later direction, this build installs two **local** action capabilities behind separate
default-off deployment switches. They do not change the provider or CI/CD statements above: no provider is
contacted and no server is started or routed by these two. `docs/specs/local-release-targets.md` is the behaviour contract and
`tests/server/local-deploy.test.ts`, `tests/server/local-publish.test.ts`,
`tests/server/local-destination-http.test.ts` and `tests/server/local-release-harness.test.ts` are the
disposable evidence.

- **`deploy`** (`DASHBOARD_DEPLOY=on`, scope `deploy`): the owner configures one artifact path inside
  the project's connected worktree and one existing real target directory under the approved browse
  roots. `deploy_preview` reduces the artifact to a sorted SHA-256 manifest. `deploy_accepted`
  requires same-session evidence accepted for that exact target-bound artifact under
  `agent-may-accept` with `deploy=full-auto`, then copies into an owned staging directory, reads the
  staged digest back, renames it to an immutable `generations/gen-<digest-prefix>`, swaps a stable
  `current` symlink by atomic rename, reads the served digest back and records the previous
  generation. The previous generation is retained for **manual** rollback; Pilot never rolls back or
  deletes a generation automatically.
- **`publish`** (`DASHBOARD_PUBLISH=on`, scope `publish`): the owner configures one publication root;
  the model names 1–500 reviewed files relative to the project worktree. `publish_preview` returns
  their digests and the bound artifact; `publish_accepted` stages a copy, reads it back and renames
  it to `publish-<digest-prefix>` with one atomic rename, then reads the published digests back. An
  earlier publication is never replaced or removed, and there is no rollback pointer.

Both use the existing `AcceptedActionExecutor`, the action-target-style owner configuration and the
existing scope/policy machinery: a durable intent precedes the effect, a confirmed effect records a
receipt and outcome, an interruption is reported as uncertain with its barrier retained, and a
duplicate invocation is never replayed. The resource key binds the configured directory and the
promoted content, so a later generation of the same target is admissible while the same accepted
content is not.

Honest limits, stated rather than implied: these are same-UID local filesystem operations, not
sandboxed, transactional or provider-verified effects; a digest proves the bytes this process read,
not provenance or safety; a staging directory is briefly visible under the target; a hard crash can
leave staging litter; and two different contents targeting the same directory are not serialized.
The optional shell can reach the same directories, so granting it is not contained by these tools.
Both are refused in a fork session. A release of this build must still be independently reviewed and
must not be described as provider deployment.


### Experimental runner response binding

The test-only injected `run_tests` orchestration checks the broker's returned job ID, project, fixed
recipe, workspace, expected state and claim owner at each stage, and requires a result before
reporting settlement. A mismatch stops the sequence and returns the invocation's job ID for
inspection; it does not retry. This guards against misrouted or inconsistent broker responses, not a
malicious broker, service authentication, source provenance, or verified runtime termination. It is
not the installed capability; the installed local runner has its own durable operation per
invocation (`src/server/state/local-test-runner.ts`).
