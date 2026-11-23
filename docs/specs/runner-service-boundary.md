---
title: "Proposed runner service boundary"
description: "Requirements and unresolved risks for executing tests outside the Pilot application container."
pilot:
  schema: 1
  id: runner-service-boundary
  kind: specification
  doc_status: draft
  feature_status: planned
  verified_release: null
---

# Proposed runner service boundary

This is a design constraint, **not an implemented service or a deployment instruction**. The
application container must not receive a container runtime socket or host privileges. A synthetic
test port does not establish isolation on a real host.

The installed `run_tests` capability is deliberately **not** this service and makes no isolation
claim: it runs the fixed `node --test` recipe as a child process of the application, as the
application user, with no container and no cgroup memory or PID limit, and its process-group
termination is best-effort. See [the runner page](../RUNNER.md). The experimental broker-based
`run_tests` extension remains test-only and is not installed.

## Proposed Linux security architecture

This is the concrete target design for review, not an implementation, installation recipe, or claim
that the service exists. The owner-selected topology is a host-local Linux service administered
separately from Pilot, running under a distinct host principal. Pilot's application container receives
neither a container-runtime socket nor host privileges. Until every prerequisite and acceptance gate
below is met, this contained execution service remains unavailable; it does not describe the
installed local recipe, which is uncontained and documented separately.

### Principals, peer authentication, and protected state

- Run the service as a dedicated, non-login host account (for example, `pilot-runner`) that is not the
  Pilot application UID, not a member of the host's general-purpose `docker` group, and not an operator
  or root account. A root-owned service manager owns the executable, unit, and configuration; ordinary
  Pilot processes cannot replace them, signal the service manager, or edit its policy. The service has
  no general host-administration authority.
- Use one host-local Unix-domain socket in a root-owned parent directory. Authentication requires
  **both** Linux `SO_PEERCRED` and mTLS over the Unix socket: on every accepted connection, verify the
  kernel-reported host-side UID against the configured app UID and verify the client certificate chain
  plus the exact currently authorized leaf pin. Neither check alone is sufficient. Before enabling the
  channel, test and record the actual container-to-host UID mapping using the deployed user-namespace
  configuration; reject startup/admission if the observed peer UID is not the expected UID. If the
  mapping cannot be stable and verified, this transport is not deployable as specified. Apply bounded
  framing and strict request parsing after authentication. These checks authenticate the app principal,
  not the owner or truthfulness of a request; all authority checks remain service-side. Do not expose TCP,
  forward the socket, or proxy runtime protocol calls.
- If Pilot requires a host bind exposure to reach the service socket, the only allowed exposure is the
  exact pre-created runner socket, or its dedicated otherwise-empty parent directory if socket
  pathname resolution requires it. Review that one bind's source, target, owner, mode, mount flags, and
  container namespace mapping against the deployed configuration. No broader service-state or host
  directory may be exposed. Never bind-mount the runtime control socket, other host sockets, credentials,
  or unrelated host paths; Pilot receives neither runtime authority nor general host privileges. The
  application principal needs access to its client key/certificate, so any process that compromises
  Pilot with that principal can use the key and submit requests within the service's enforced policy.
  Protect the client key from all other principals, keep it out of logs/images/backups, and use a
  stop-the-world rotation: stop service admission, install a replacement app key/certificate and update
  the service's one accepted leaf pin as a matched pair, restart, then verify the configured peer UID
  and new pin before restoring admission. Never accept old and new pins concurrently. On mismatch,
  rollback is operator-driven only: stop admission and restore the prior key/pin pair together, then
  verify before resuming; do not roll back a suspected-compromised key. Loss or suspected compromise
  disables that client identity until this procedure completes. The current prototype accepts one exact
  pin; this stop-the-world operational procedure is a proposal and its rotation/recovery path is not
  implemented. mTLS does not distinguish trusted code from compromised code running as the app principal.
- Store policy, job journal, runtime metadata, snapshots, logs, and the service signing key only in
  service-owned directories with restrictive ownership and permissions. The app principal must have no
  filesystem, backup, debug, ptrace, signal, namespace, or credential access to these objects, including
  service private keys and journal files. The service must reject startup if ownership, mode, mount, ACL,
  or key permissions are not as configured. Conventional mode-bit checks alone are insufficient: host
  preflight must inspect ACLs, parent directories, mount behavior and effective UID mappings. No
  model/provider/deploy credential is placed in a job or made readable by the runner.
- Keep owner policy administration out-of-band from the application API. A root/operator-owned policy
  file or equivalent privileged administrative interface is the sole authority for exact project
  identities, allowed recipe identifiers and immutable recipe/image digests, enabled state, and limits.
  Pilot cannot add or widen entries. A policy change increments a durable revision; jobs bind that
  revision, and disabling/replacing an entry prevents new admission. Policy revision checks do not recall
  an already dispatched job.

### Request scope, workload identity, and provenance

The protocol accepts only a bounded, versioned job envelope: a unique caller job ID, owner-configured
project ID, immutable source/snapshot digest and revision, allowlisted recipe ID, and requested resource
ceiling no greater than policy. It accepts no shell/argv, image or tag, runtime flags, arbitrary
environment, host path, network request, secret, mount, output path, or runtime identifier. Unknown
fields, duplicate keys, stale policy revisions, duplicate job IDs with changed content, and inputs over
fixed byte/file/path limits are rejected before admission. Retries for the same exact ID and digest are
lookup-only; no timeout or lost response creates a second execution.

The service resolves project IDs through its own owner-managed mapping and obtains bytes by a separately
reviewed immutable handoff. It must verify source identity, revision and content digest itself; a
client-supplied digest or a passed snapshot validator is not provenance. The service rejects symlinks,
special files, hard-link escapes, path collisions, generated/app-managed content and unapproved files
while constructing a private per-job snapshot. It must not mount a live writable project tree. The
allowed recipe is service-owned and immutable, and its image is pinned by digest and verified against an
owner-approved signature/provenance policy before use; never pull an unapproved mutable tag during job
admission.

Each admitted execution gets a unique immutable workload identity bound to job ID, request digest,
project/source digest, policy revision, recipe and image digest, and runtime/cgroup identity. A receipt
carries these values, result/output digests, applied limits, and termination evidence. The service signs
the receipt with a key inaccessible to Pilot and workloads; a separately pinned verifier key is used by
the owner/reviewer to verify it. The signature proves that the service made the assertion, not that the
kernel enforced it. The service independently queries runtime and cgroup state before signing a normal
completion; unverifiable identity or state produces `unknown`, never a successful receipt. Test-produced
stdout/stderr and artifacts are untrusted data, bounded and escaped on display; provenance identifies
their source and does not assert tests were meaningful or honest.

### Runtime authority and arbitrary-code confinement

Use the host's root-owned systemd manager as the process/cgroup supervisor for each job (or an
independently reviewed equivalent with the same properties); do not rely on a Docker socket as the
isolation primitive. A narrow, root-owned supervisor interface accepts only a service-authenticated,
service-generated job identity and the fixed workload specification, and permits create/start,
read-only inspect, terminate and remove for that job only. It rejects caller-selected unit names,
commands, paths and properties. The Pilot app cannot access that interface. The service account cannot
obtain a general root shell or unrestricted host-manager API through it.

Each workload runs as a dedicated, unprivileged per-job host UID distinct from both Pilot and the
service; the job UID cannot read service policy, journal, signing key, snapshots belonging to other
jobs, host credentials or supervisor state. systemd places it in a dedicated cgroup before execution,
with fixed namespaces and properties; an independent root-owned supervisor/watchdog retains the
ability to kill that cgroup if the service dies. The service holds only the authority needed to submit
fixed jobs and inspect/terminate its own job identities. Those interfaces and the root-owned supervisor
remain in the trusted computing base and require exact-host verification. If the host cannot restrict
service access to this fixed-job surface, admission remains disabled. No runtime control socket is
mounted into a test workload or Pilot, and no generic runtime endpoint is exposed.

Treat the recipe and every test file it executes as hostile arbitrary code, even when owner-allowlisted.
A job runs in a disposable, non-root, unprivileged user namespace and isolated cgroup with a read-only
pinned image and read-only input snapshot; only a separate size-capped result channel is writable. It
gets no host paths except those explicitly constructed for that job, no credentials, no runtime socket,
no host PID/IPC/network namespace, no device access, no capabilities, no privilege escalation, and no
network egress or DNS. Use a verified Linux seccomp/LSM policy and a private mount namespace in addition
to container controls. A same-kernel container is not a defense against kernel vulnerabilities; for
stronger assurance than that assumption permits, a separately reviewed VM boundary is required. Do not
describe either as an absolute sandbox.

Enforce CPU quota, memory and swap ceiling, PID count, block-I/O ceiling where available, input/output
bytes, log bytes, disk quota, and a monotonic wall-clock deadline at host/runtime level, not merely in
the recipe or application. Pin the workload into a dedicated cgroup before executing untrusted code.
On deadline, cancellation, output overflow, service shutdown or operator stop, terminate the exact
runtime object and kill the entire job cgroup (including descendants), then independently verify that
the cgroup is empty and the runtime object is terminal. Killing the CLI/client process is not
termination. If the target kernel/runtime cannot prove cgroup placement, hard limits, and descendant
termination under tested daemon lifecycle, admission is disabled. Limits remain subject to
kernel/runtime correctness and host-wide resource contention; they do not guarantee protection against
a host kernel defect or privileged host administrator.

### Durable uncertainty and manual recovery

Persist an immutable intent and workload identity before dispatch, then append a terminal receipt only
after independent runtime and cgroup verification. Store both in service-protected durable state with
atomic updates and an integrity-protected history anchor not writable by the app. Recovery treats
missing, malformed, contradictory, stale, or unauthenticated evidence as uncertain. On service crash,
host reboot, runtime restart, daemon unavailability, lost response, failed kill, or uncertain create/start
window: do not retry, infer absence from a missing ID, refund the budget, or clear a barrier. Quarantine
the exact job and private files; keep admission closed for that job (and close global admission if the
runtime's active set cannot be established).

An operator must stop automatic service restarts as appropriate, preserve the journal and host/runtime
logs, inspect the exact immutable runtime ID and cgroup after the runtime is stable, verify no process or
descendant remains and no restart policy can recreate it, then record a signed, audited resolution using
a separate privileged procedure. If any identity or termination fact cannot be established, keep the
job uncertain and require host-level investigation or rebuild; never offer a model/client-facing
"force clear" or automatic stale-record cleanup. A reboot is not proof that the runtime or its external
side effects are absent. Recovery can establish local process termination, not undo arbitrary writes to
the snapshot or prove that no external side effect occurred; network denial and no credentials are
therefore essential.

### Host preflight and explicit trust assumptions

Before enabling any integration, an independent Linux host operator must verify and retain evidence for:

1. A supported, patched Linux kernel with cgroup v2 and the required user namespaces, mount isolation,
   seccomp and selected LSM active; no unsupported fallback or silent feature downgrade.
2. Exact service/app UID mapping, Unix-socket peer credentials and directory access from the real
   container namespace; no app access to service files, keys, process inspection, signals or runtime
   endpoint. Check ACLs, supplementary groups, capabilities, mount flags, parent directories and
   symlink behavior, not only `stat` mode bits.
3. The exact root-owned systemd unit/template and narrow supervisor API, authorization rules,
   service-manager permissions, namespace configuration, and restart behavior. Inspect every mount in
   the deployed Pilot container: retain only its already documented, separately reviewed application
   data mounts and, if needed, the one explicitly approved bind exposure of the exact runner socket (or
   its dedicated otherwise-empty parent). Do not infer that Pilot has no host mounts. Reject the runtime
   control socket, any other host socket, credentials, broad host directories, and every unapproved host
   mount. Confirm no Docker-group or equivalent broad runtime authority is given to the application;
   verify the job has only its per-job snapshot/result mounts and no runtime socket.
4. Actual cgroup membership and enforcement for each limit, including descendants, overload, service
   restart, runtime restart and host reboot; a root-owned independent watchdog or equivalent must kill
   the exact job cgroup even if the service process exits. Verify no remaining process before declaring
   termination.
5. Policy/config/image provenance, signing-key custody and verifier pin distribution, durable storage
   ownership and failure behavior, bounded logs/output/disk, and that the host firewall and runtime
   cannot provide egress or metadata-service access to jobs.
6. A disposable real-host exercise of refusal, concurrent/duplicate admission, cancellation, service and
   daemon crash, reboot, malformed runtime evidence, resource exhaustion and manual recovery, reviewed
   independently by someone other than the implementer. No live project, credential or external
   destination is used for that exercise.

The trusted assumptions are: host root and the kernel/runtime/LSM/cgroup implementation are not
malicious or compromised; the separate service/operator identity and policy-signing key are protected;
the owner-approved image/recipe and source identity are correct; and the chosen host configuration
continues to match the verified preflight. Host root can bypass every local boundary, inspect memory,
replace executables or keys, and falsify local evidence. A compromised kernel can defeat namespaces,
cgroups and seccomp. The design does not protect against either. No same-UID unit test, fake runtime,
mode-bit check, TLS fixture, or application-level assertion can prove UID separation, ACL isolation,
peer credential mapping, runtime authority separation, cgroup enforcement, descendant kill, no egress,
reboot recovery or host-root trust. Those require independent verification on the exact target host.

### Preflight evidence collector

`scripts/runner-host-preflight.mjs` collects the host facts above that can be observed without
privilege: kernel release, cgroup v2 availability and the presence of the `cpu`, `memory`, `pids` and
`io` controllers, user-namespace allowance, available seccomp actions, the identity the check runs as,
whether two configured UIDs are distinct and non-root, and the owner/mode of a proposed socket parent.
It writes nothing. Non-Linux hosts are refused rather than passed, and a missing required fact exits
non-zero with the fact named. It is an evidence collector, not an approval: it cannot create or
inspect a workload cgroup, test peer credentials on an accepted socket, read ACLs without host tools,
prove descendant termination, or establish that the host is not compromised.

Observed on the current Pilot host, read-only, from a disposable unprivileged container: Linux
`6.8.0-1062-oracle`; cgroup v2 present with `cpuset cpu io memory hugetlb pids rdma misc`; user
namespaces allowed; seccomp actions including `kill_process` and `errno`; the socket parent not
world-writable. Those are facts about a host that still has **no runner service, no runner principal
and no job cgroup**, so they prove readiness for the next review step only.

### Identity-only proof of kernel peer credentials (uninstalled)

`scripts/runner-peer-uid-proof.py` is a Linux-only proof that the selected transport can authenticate
a kernel-reported peer identity at all. It binds an owner-provided absolute socket path, reads
`SO_PEERCRED` on every accepted connection **before** reading or answering, ignores a connection whose
UID is not the configured one, and answers only the exact request `STATUS` with a fixed diagnostic. It
executes no work, relays nothing, exposes no runtime, and never unlinks a caller-supplied path: an
existing file or symlink makes `bind` fail, so an operator-owned collision is preserved rather than
replaced. Python 3 is an optional runtime requirement of this helper, not an application dependency.

`tests/runner-peer-uid-proof-linux.py` is one disposable smoke check: it starts the helper twice with
the current UID and with a different UID, and asserts that only the matching principal receives the
diagnostic. It also asserts that a pre-existing path and a symlinked path are refused and left
untouched, and that a relative or over-length path is refused. Both client connections still run as
the **same** process UID: the check distinguishes matching from mismatching expected UID, not two
separately running principals, and says nothing about ACLs, container UID mapping, mTLS or a real
deployment. Its runtime and per-request bounds are code-level limits, not exercised by the smoke check;
the accept deadline can overrun by at most one connection's socket timeouts.

This component has **not** been executed on the Pilot host: the deployed image contains no Python, and
installing one there is a provisioning decision. It has been executed on Linux in a disposable
container, where two **real** host principals were created: the configured principal received the
diagnostic and the other received nothing, so kernel peer-credential separation works for this helper.
That result does not extend to the host's socket directory ownership, ACLs, the container-to-host UID
mapping, mTLS, or any workload. Until an operator repeats it on the target host under the real service
and application principals, the transport remains unproven and no runner service may be enabled.

## Required separation

A separately managed execution service may possess narrowly provisioned access to a container runtime;
the Pilot application must not. Its interface must offer a fixed test recipe, never a command, runtime
arguments, image, environment, arbitrary host path or generic runtime proxy. Its target must be bound to
an owner-configured project and session workspace, with an independently checked allowlist on the service
side. A local transport's filesystem permissions must restrict which principal can connect; an exposed
network listener or a socket that speaks the container runtime protocol is not acceptable. Compromise
of Pilot must not grant general control over the host through the service.

The service must establish its own bounded execution properties and report only what it can verify.
Per-job CPU, memory, PID and wall-clock bounds, no network, no runtime socket in the job, and bounded
output remain mandatory. A test suite is arbitrary code: it can modify whatever workspace it receives
and may print its contents. A container's flags are not proof against a kernel or runtime escape.

## Durable identity and uncertain effects

The service needs an independent durable, atomic admission keyed to the exact job and exact request.
Concurrent or repeated submissions cannot start two containers; an interrupted invocation must not be
replayed automatically. The experimental journal currently imposes a single global in-flight slot:
a pending, unknown, or other non-successful job blocks every new job across restart. There is no
operator release protocol yet, so an uncertain job can halt the service indefinitely. A blocked new
job may already have consumed its conservative budget reservation. A durable intent must precede execution and a receipt must follow it. On
restart it must reconcile container identity and retained receipts, or expose a named uncertain state
for an operator. A client disconnect or abort is not evidence the container stopped. Cancellation must
address the specific container and expose uncertainty if termination cannot be verified. Bound message
and output sizes, validate all fields, and keep credentials and absolute host paths out of responses.

## Experimental admission journal

`src/server/state/runner-service-admission.ts` is an **uninstalled internal journal**, not a service
or security boundary. It can durably bind a fixed test request and opaque snapshot identity to one
job ID, deny duplicates after restart, and preserve uncertain outcomes using a separate control-store
instance in disposable tests. Its authorization callback and completed-result receipt are trusted
internal assertions, not evidence that an external peer is authenticated, that a workspace matches
the digest, or that a runtime stopped. A future service must own a separate private store and enforce
its own peer, target and workspace checks; the journal cannot make an application-owned store
independent. Before admitting a new job, the prototype validates the linked evidence in its reserved
job scope; the policy and budget prototypes similarly validate their scoped history. This detects some
one-sided corruption, not deletion or coordinated rewriting of linked records, which require an
independently protected history anchor. The scans run synchronously under the SQLite writer lock and
can grow expensive as history grows; no bounded retention, index migration or capacity proof exists.
No deployed transport, verified runtime, recovery protocol or verified snapshot handoff has been
implemented.

### Experimental bounded snapshot input

`src/server/state/runner-snapshot.ts` validates an in-memory set of bounded regular-file bytes, rejects
symlinks, disallowed paths, duplicate paths and file/directory collisions, and hashes a canonical
sorted manifest including each path, mode and content digest. The uninstalled journal can recompute
and bind that digest before admission. It accepts no host path. This is only byte identity: it does
not verify that the bytes came from a claimed commit or live workspace, scan secrets, install
omitted dependencies, provide a bounded transport, or establish isolation on a host.

The separately uninstalled `runner-snapshot-materialize.ts` experiment can write those files to a
service-configured private root and read back their hashes. It checks conventional POSIX owner and
mode bits, refuses the configured application UID if it equals the service UID, creates files
exclusively without following final symlinks, and makes the result read-only by mode. It leaves partial
snapshots for manual cleanup on failure. These checks **do not** verify ACLs, actual peer credentials,
all mount and namespace behavior, or protection against other processes with the service UID. A future
service must enforce transport bounds before parsing, verify those host properties independently, and
use a separately verified read-only runtime mount. The configured application UID is an assertion,
not peer authentication. Tests use disposable roots; no snapshot is executed and no production
service or cleanup protocol exists.

`runner-service.ts` combines this experimental journal and materializer with an injected service-local
runtime port. It rechecks the service's synchronous authorization before invoking the fixed recipe,
and records a bounded result only after the port reports completion. Duplicates only inspect; abort,
timeout, lost results and invalid or oversized output remain uncertain. The timeout starts after
materialization, and a port's completion claim is trusted rather than independently verified. Tests
exercise this flow with a stub runtime; it has no installed transport, independently configured
production policy, verified real runtime, production job budget or application integration. Authorization can change
immediately after the recheck, and neither a signal nor a timeout proves that a runtime stopped.

### Experimental staged supervisor ledger

`runner-supervisor-journal.ts` and `runner-supervisor.ts` are a separate, uninstalled incremental prototype. They use a dedicated SQLite journal file (not extra tables in `ControlStore`, whose validated schema is closed) and a service-owned `ControlStore` for the existing policy and budget prototypes. The API contract is: parse the fixed request; check the service policy; reserve the service budget; atomically admit the immutable request and absolute wall-clock deadline in the stage journal, binding both into an integrity digest that is checked on startup and reads; duplicate admission returns the stored deadline without consulting a new clock. This unkeyed digest detects accidental changes but does not protect against a same-UID writer able to rewrite both fields. Then, only for the winning first admission, persist `create-intent`, invoke `create` under the journal writer lock and commit `create-dispatched`, persist the returned opaque runtime ID, persist `start-intent`, then invoke `start` with that exact ID under the writer lock and commit `start-dispatched`. The duplicate path is inspection-only. The policy/budget `ControlStore` and stage journal use separate SQLite files and cannot share one transaction; budget is deliberately reserved first and is not refunded if stage admission fails or a service crash occurs between those operations. The policy is rechecked immediately before both create and start dispatch; a refused or throwing recheck leaves the admitted job uncertain and suppresses that call. Policy read and journal dispatch are not atomic, so revocation after the recheck can still race the effect; this prototype makes no post-check revocation enforcement claim. The stage journal's unique job key and global unresolved-job barrier, not budget history, control dispatch. This prototype has no settlement or removal path: after the first admission, no distinct second job can be admitted, even if inspection reports an exited runtime; inspection cannot release the barrier. It is not a runnable multi-job service.

#### Why no reconciliation or settlement API is provided

The prototype cannot safely clear its global barrier. `RunnerSupervisorRuntime.inspect()` returns the port's claim about a runtime ID, request digest, and state; the stub used by tests can fabricate all of these. A well-formed matching ID or a reported `exited` state is not authenticated evidence that the referenced container is the one created for this job, that it has no live processes/descendants, that the daemon will not restart it, or that the journal and runtime observations share a protected trust boundary. The journal has no attestation type, verifier, or settlement transition; a caller-supplied assertion or an `inspect()` result cannot be promoted into one.

A future settlement protocol must be designed and independently verified against an actual separately managed runtime authority. At minimum it needs: (1) a service identity and journal inaccessible to the application principal (with same-UID and ACL assumptions reviewed); (2) an authenticated service-to-runtime control channel that returns authoritative evidence for the exact immutable runtime ID and binds it to the admitted job/request; (3) a reconciliation result proving the exact workload is terminal, with its process/cgroup empty, no restart path or live-restored workload, and stable retained evidence across daemon/service restart; and (4) one journal transaction that verifies that evidence and records an immutable terminal receipt before allowing any later distinct admission. Missing, duplicated, mismatched, unavailable, or active runtime observations must leave the job uncertain and the barrier closed. Cancellation would need the same exact-ID termination evidence. No retry, cleanup, or capacity release follows from a client assertion, timeout, or ordinary self-reported `exited` state. Until that protocol exists, an observed exit is inspection-only and the first admitted row blocks all later jobs indefinitely.

The created ID and request digest are trusted-port correlation values, not authenticated runtime provenance. The stub interface exposes separate `create`, `start` and read-only `inspect`; there is no terminate-by-name method. A crash in `create-intent` can hide a created object before its ID is durably recorded; a crash after `start-intent` may mean start happened. Both remain uncertain, are inspection-only after restart, and never cause automatic retry. A mismatched identity/digest in a create response, start acknowledgement or inspection remains uncertain. The synchronous port invocation is serialized against journal cancellation: cancellation committed first prevents invocation, while cancellation after invocation only latches uncertainty and cannot retract the effect. A crash after invocation but before its dispatched-stage commit remains ambiguous. **The injected port's synchronous prefix runs inside the SQLite writer transaction and cannot be bounded by its `Promise` type.** If it blocks, it blocks the event loop and journal lock, so cancellation and deadline timers cannot make timely progress. This prototype cannot guarantee timely cancellation or deadline response and remains uninstalled; moving the call outside the transaction would reopen the cancellation/dispatch race unless a separately verified nonblocking enqueue/supervisor protocol is designed. The absolute deadline is immutable and passed to the stub; the service checks it before invoking each effect, races its wait against that deadline and durably latches uncertainty if it crosses the deadline, but does not prove process termination or enforce a hard lifetime. Persisted rows are checked for valid stage/revision and runtime-ID combinations; malformed evidence is refused. A late effect may continue after the service response. Cancellation only latches uncertainty; no runtime kill is attempted because no safe verified termination protocol is implemented. The prototype has no result/receipt completion protocol, operator resolution, bounded retention, authenticated peer, independently protected service root, or deployment integration. Conventional directory/file mode checks do not establish protection from same-UID actors. Tests use disposable stores and stub calls only; they do not establish authenticated identity, cgroup placement, runtime provenance or hard lifetime.

`runner-service-policy.ts` supplies an experimental service-owned, revisioned allowlist for exact
project/session/workspace identities and maximum limits. Requests bind the revision; disabling and
re-enabling the same target therefore cannot revive an older admitted job at the pre-execution check.
Policy updates are intended for an out-of-band service operator, not the application peer. The policy also binds each project/session to one named agent and specifies a finite rolling-hour
service job cap per agent across that agent's allowed targets. A separate durable reservation is
recorded before job admission; duplicate submissions cannot consume another slot, and a failed or
uncertain job is not refunded. This service-side cap uses the host wall clock and is not the
application's configured agent budget. The service store must actually be protected from the
application's principal, and the peer must be authenticated in a separately managed service: those
host protections have not been verified. The allowlist also does not prove that submitted bytes came
from the named workspace.

### Experimental local transport

The uninstalled `runner-transport-unix.ts` prototype offers one fixed-job HTTPS endpoint on a Unix
socket, not a TCP listener or runtime proxy. It checks a dedicated CA and exact client certificate pin,
uses a fresh service-owned publication directory, bounds the input document and rejects duplicate JSON
keys. A cancellation, uncertain result, timeout or ambiguous service failure latches the endpoint
closed and retains its directory on shutdown; no automatic cleanup or restart recovery is supplied.
A normal close reports whether the service promise settled, **not** whether its runtime stopped.
Manually removing the directory or using another store can bypass the fence. Filesystem and TLS tests
run with the same local UID and temporary certificates: the configured application UID is an assertion,
not a peer-credential check. Group and POSIX mode checks do not verify ACLs, key exclusivity, UID or
mount isolation, and a privileged or same-UID actor can replace paths. A transport timer is an event-loop
response deadline, not a hard bound on parsing, materialization or termination. Pre-authentication
connection exhaustion, unexpected filesystem failure, safe stale-socket recovery and peak-memory limits
need further testing. Disposable raw-TLS tests cover representative partial uploads, pipelining and
ambiguous framing, not every HTTP or platform interleaving.

The uninstalled `runner-transport-client.ts` uses the Unix socket, verifies the server CA, hostname and
exact certificate pin, and binds the returned job ID to its request. An authenticated read-only lookup
accepts the complete fixed request and returns a matching receipt, uncertainty, or `unavailable`;
`unavailable` conflates absence and mismatch and does **not** prove no job is in flight or authorize
retry. Inspection does not clear either the journal barrier or transport uncertainty fence. Once connection dispatch begins,
a timeout, disconnect, invalid response or refusal is reported as unknown and is never automatically
retried. A completed response is the service's claim, not proof of execution or artifact provenance.
Its deadline cannot preempt synchronous validation or prove that in-flight work stopped. Neither this
client nor the endpoint is installed; do not enable them on the existing host without independent host
review.

A focused disposable transport regression test additionally verifies that a client certificate signed
by the configured CA but not matching the configured leaf pin is refused before the service receives a
job. This establishes the tested mTLS certificate/pin gate only. It does not authenticate the operating
system peer UID, protect key material from a same-UID process, verify ACLs, establish service/runtime
identity separation, or validate any host's runtime enforcement; those remain prerequisites for a real
service and are not established by the test's temporary certificates and same-process fixture.

The uninstalled `runner-service-docker.ts` port constructs a fixed Node test recipe against a pinned
image ID and a read-only service snapshot. It uses no network, drops capabilities, requests resource
limits and retains the container and a private container-ID file for inspection. The cidfile lives in
a deterministic private operation directory; a read-only restart inspection accepts only the exact
container ID, expected generated name and operation-ID label. It reports only `running`, `exited`,
`unavailable` or `uncertain`; unavailable includes absent and mismatched evidence and does not prove
that no effect occurred. Inspection never changes the journal, creates a receipt, clears an uncertainty
barrier or authorizes retry. A normal result is accepted only after the daemon reports that specific
container exited and its exit code matches the CLI. Abort or output overflow stops only the Docker
CLI with signal proxy disabled; it never kills a container by a derived name, which could identify
someone else's container. Restart inspection does not yet provide a safe cancellation operation or
prove termination across daemon races. The container may continue after cancellation, output
overflow or the service deadline, consuming resources indefinitely; the deadline bounds the service's
wait, not the container's lifetime. The outcome remains uncertain until a separately designed
recovery process can establish identity and termination.
Automated tests use a fake Docker CLI. Two additional one-off disposable checks used a real local
Docker Desktop daemon and an already-present image: one exited successfully after checking UID,
loopback-only interfaces and read-only writes; one observed a running container, cancelled it and
retained an unknown journal outcome while a duplicate remained inspection-only. Both predated the
removal of automatic name-based kills; they do not validate the current cancellation behavior. The
scripts inspected the exited containers before requesting removal, but did not log a final root-removal check. These observations do
not establish host isolation, protected ACL/UID separation, output provenance, safe termination in
every race or enforcement of all limits. The fake-Docker tests verify protocol handling only: a
synthetic cidfile, operation label, container id or receipt is not proof of real daemon identity,
container lifetime or execution. There is a crash window after Docker creates or starts a container
and before its cidfile is available; restart inspection then returns unavailable or uncertain and
cannot find or safely cancel that container. The generated name and operation label are correlation
fields, not independently authenticated identity. The one-off checks used the selected Docker context
without the explicit socket-verification procedure of the established local acceptance script; they
are not acceptance evidence for a production endpoint. No image was pulled. There is no reconciliation,
external hard-lifetime supervisor or cleanup protocol, so this port is not installed or
deployment-ready. A systemd unit that only stops the Docker CLI would not establish a bound on the
daemon-created container. Any proposed cgroup parent or independent watchdog must be verified on the
target host, including actual workload placement, daemon restart and reboot behavior.

## Workspace isolation is unresolved

The application's existing path resolver checks for symlinks and canonicalises a workspace, but that
check followed by a container runtime mount is not a race-free host security boundary against a
concurrent writer. A path can be replaced between validation and the runtime opening it. Likewise,
using a working directory, a typed request, or a per-agent action scope does not confine a same-UID
shell. The service must not mount a path selected by an untrusted request merely because that resolver
accepted it.

The proposed handoff is a service-created, immutable per-job snapshot, never a live project mount.
Its implementation must use race-resistant descriptor-relative resolution or an equivalently reviewed
mechanism, independently validate the configured project/worktree identity, and reject symlink/hard-link
escapes, concurrent substitution, generated/app-managed paths, secret-bearing files, and limit
violations before snapshot publication. Snapshot identity and source revision must be included in the
signed workload receipt. Fork/session lifecycle fencing and cleanup remain implementation requirements,
not capabilities established here. A snapshot that omits dependencies or differs from the live worktree
must report that difference; it must not silently present a passing run as proof of the original
artifact. This handoff is a proposed requirement, not verified code.

## Before integration

Prove the service boundary and failure modes with isolated disposable projects and a stub runtime,
including malformed and oversized requests, peer access, exact project and workspace identity, path
replacement races, duplicate and concurrent effects, cancellation, daemon restart, lost receipts,
resource limits and revocation. Then independently review the implementation and perform a separate
real-host isolation exercise before enabling it. Until then, the scope must remain unavailable in the
application's effective capabilities, and the existing hosted container must not gain a runtime socket.

### Experimental dispatch/close arbitration journal

`runner-dispatch-arbitration.ts` is a separate, uninstalled prototype, not integrated with the broker,
transport, or staged supervisor. It serializes exact fixed requests through one SQLite writer lock.
The first dispatch commits `dispatch-possible` before returning its one-shot invocation permission;
a close committed first stores a persistent `closed-before-dispatch` tombstone. Duplicate dispatches
are lookup-only, changed request content is refused, and any possible dispatch permanently blocks
other dispatches in this prototype. A close after dispatch always returns `dispatch-possible`, even
if the caller has not yet invoked anything or lost its response. A retained, intact journal records the decision before permission is returned; a clean reopen
does not grant another invocation. Crash and power-loss durability have not been tested here. The caller must honor the one-shot result; the journal cannot enforce this against
an untrusted caller. A tombstone is not evidence that a process terminated or that a separate runtime
had no effects. This does not authenticate peers, verify runtime or source identity, protect the journal
from a same-UID writer, install a service, or reconcile existing broker records. Reopen refuses missing, empty and incompatible journals; initial provisioning is a separate exclusive
create and must never be used to recover a lost journal. There is no independently protected existence
or freshness anchor: deletion, replacement with a valid empty journal, rollback, and a provisioning
mistake can erase the barrier without detection. The guarantee is limited to a retained, intact journal.
Detected corruption and storage errors fail closed; this cannot cover undetectable loss or corruption.
The unkeyed digest binds the request and decision to detect some accidental changes, not a malicious
writer that recomputes it. Physical durability depends on SQLite and the underlying filesystem. History
scanning is unbounded. The ready-gated process test demonstrates agreement in one concurrent attempt
and clean reopen, not crash durability. Independent review and crash and host verification remain
required before any integration.
