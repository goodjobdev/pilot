# Protected repository/ref mutation boundary — design only

**Status: proposed, unimplemented, not approved for execution.** The existing accepted commit and
push adapters remain uninstalled. This design does not protect a caller-writable repository and does
not enable a transport. It proposes a deliberately narrower resource: a broker-owned bare repository,
not the existing project worktree. No live repository or service was contacted for this investigation.

## Finding and threat boundary

`accepted-git-commit.ts` checks the project root, `.git`, HEAD, ref and staged tree in separate Git
subprocesses, then runs `update-ref --no-deref` with an expected old object ID. The workspace lock is
in-process; neither it nor the durable Pilot resource barrier excludes another Git process or a
filesystem writer. An attacker can substitute root, gitfile, Git directory or final ref after a check.
Even `--no-deref` is insufficient: with `victim` a symbolic ref to `unrelated` at the expected old
OID, Git can replace `victim` itself with a direct ref and report success. It does not update
`unrelated`, but that is not the checked direct-ref identity. An OID CAS also cannot distinguish an
ABA change. The expected value alone is not a ref-type assertion. Post-effect checks cannot undo an
incorrect write or prove where it occurred.

A disposable local Git experiment reproduced the symbolic-ref replacement using `git symbolic-ref`
and `git update-ref --no-deref victim new old`; the victim became direct and the unrelated ref was
unchanged. This experiment demonstrates a failure mode, not a fix or a general Git specification.

## Candidate boundary and assumptions

1. A separately supervised broker runs as a dedicated OS identity. Its repository storage, every
   ancestor used for resolution, executable/configuration, IPC endpoint and durable journal are
   inaccessible for mutation by Pilot's UID, agents, other local users and their child processes.
   The broker's credentials and socket authentication are distinct from the caller. Root, a compromised
   broker, same-broker-UID processes, hostile kernel/filesystem administrators and remote service
   administrators are outside this guarantee. Merely changing a directory mode while sharing a UID
   does not meet it. The same-UID coding shell is explicitly not contained.
2. The broker alone creates and mutates one bare repository per opaque, random broker-issued resource
   ID in a private, non-symlinked, broker-owned hierarchy on a supported local filesystem. Registration
   records a durable creation generation and object format; a pathname, project ID, URL, inode or
   user-provided digest by itself is not identity. Broker restart validates ownership, hierarchy,
   type, object format and its durable mapping before admitting work. Replacement, migration,
   restore, deletion, mount changes or ambiguous identity fail closed and require an explicit owner
   re-registration/reconciliation; a retained file descriptor or inode number alone is not a durable
   identity. Hard links, alternate object directories, grafts, replacement objects, untrusted config,
   hooks, templates, credential helpers, external filters and linked worktrees/gitfiles are excluded.
   Provisioning must enforce these properties, not just document them. Filesystem durability and
   directory/mount policy need OS-specific proof; no descriptor-relative implementation exists here.
3. Clients submit an immutable, validated content manifest and expected parent bound to an acceptance;
   the broker constructs the tree and commit in its own object store. It must not read the caller's
   mutable index or treat an untrusted manifest as proof of source provenance or secret safety. Existing
   frozen-staging code is not a protected store. The acceptance must bind broker resource ID and
   generation, full refname, object format, parent, tree/manifest and target configuration revision.
4. A broker-wide per-resource lock, shared across **all broker processes and every mutation path**,
   serializes ref inspection and update, maintenance, registration and deletion. It must be an OS or
   transactional lock with verified crash semantics and no stale-lock breaking while a writer may
   live; a process-local mutex or SQLite record alone does not constrain Git/filesystem writers.
   Broker filesystem ownership is what excludes nonparticipating writers. Git child processes must
   finish or be conclusively terminated before releasing this lock. A disposable Linux container
   experiment confirmed a narrower counterexample: a toy child without the lock descriptor survived
   its killed parent, another process acquired the same lock, and the old child wrote a fixture
   marker. This was not a Git-child, cgroup, containment or recovery test. No broker shell or alternate
   interface may mutate the store outside this protocol. If this exclusion cannot be enforced, refuse
   operation rather than rely on check-then-use or Git's advisory lock files.

Under these assumptions the checked ref cannot be replaced between inspection and mutation by an
external writer. The broker checks that the *exact* configured branch is a direct ref, not a symbolic
ref, and is the accepted parent, while holding the lock. It invokes a fixed Git command with an
explicit private repository and isolated environment, expected-old CAS, and `--no-deref`, retaining
the exclusion through durable result verification. The direct-ref check plus protected namespace and
exclusive writer protocol is the safety argument; **`--no-deref` alone is not**. An out-of-protocol
writer with broker privileges invalidates the proof. Restrict supported Git/ref backend and version,
including packed-refs, to independently tested behavior; verify safe object creation, process
lifetime and durability. The lock must also cover any background Git maintenance, garbage collection
and ref packing. Whether per-resource locking is sufficiently crash-safe on each target OS remains an
implementation question, not a delivered primitive.

The above chooses broker-owned storage rather than trying to protect a project directory whose same-UID
shell can rename its parents or `.git`. A separate publication mechanism would be required if users
expect the original local worktree's branch to move. It is not part of this proposal.

## Authorization and write ordering

The broker must authenticate the application as a peer, not trust model input, caller-provided actor
labels or a hash as authority. Its trusted authorization service must resolve current owner policy,
session/agent scope, acceptance and exact registered resource, and atomically consume a single-use
operation ID while serializing this decision with policy/target revocation in the *same authoritative*
durable transaction domain. Reserve the exact resource and record the request and accepted identity
before any side effect; bind the resource generation and operation ID into the decision. Authenticate
and validate IPC messages with size limits and replay protection. Fail closed if that service or the
journal cannot establish a current decision. Its authoritative policy, acceptance and revocation
records, and the authority to change them, must be protected from Pilot's UID and its shell, with a
separately authenticated owner mutation path. App peer credentials do not distinguish the app from a
same-UID process that can use those credentials. This protected authority is an unmet design assumption,
not an existing Pilot guarantee. An in-process callback or repeated `revalidate()` calls cannot provide
this ordering across processes.

Define the successful durable authorization transaction as the admission linearization point:
revocation ordered before it prevents admission; revocation ordered after it does not retroactively
cancel an admitted effect. The UI and policy must disclose that semantics. If the owner requires a
stronger guarantee that a later revocation prevents even an already admitted write, this design is
insufficient; a common synchronization protocol covering the effect and revocation is needed, and
cannot recall a remote request already delivered. A short-lived token alone does not eliminate the
race. The broker checks journal state and holds the resource lock before the effect, but must not claim
that two independent stores or a broker lock make authorization and Git atomic.

Record durable states at least `admitted`, `effect-starting`, `succeeded`, and `uncertain`, with a
resource barrier retained across crash and restart. Record `effect-starting` before launching a Git
child or sending a network request. A proven failure before that point is not-started; otherwise a
crash, timeout, cancellation, interrupted child, lost response, persistence failure or inconclusive
read-back is uncertain. A child may outlive its parent: use supervision that proves termination before
any release, and retain the barrier if that proof is unavailable. Persist the successful receipt only
after the mutation and required durability/read-back checks. Journal failure after the write remains
uncertain, not a retry invitation. An older restored authorization database or broker journal can erase
revocation, operation-consumption or effect evidence while a repository or remote remains newer. Require
a coordinated restore epoch or independently protected rollback detection; mismatched, missing or
unverifiable epochs fail closed, and outstanding operations and external effects require reconciliation
before re-admission. A restored snapshot alone cannot establish that no later effect happened.
Reconciliation is an explicit, audited owner operation with evidence
and a defined barrier-release rule; it cannot infer non-occurrence merely because the current ref no
longer equals the proposed value. The existing action executor's barriers and state handling do not
provide the proposed broker-wide guarantees.

## Remote identity and competing writers

Push requires a separate transport design and is not enabled by this proposal. GitHub documents a
[`createCommitOnBranch`](https://docs.github.com/en/graphql/reference/commits#createcommitonbranch)
mutation accepting a branch's global node ID and an `expectedHeadOid`; it creates a new commit on
GitHub rather than pushing an existing local commit. Whether that different action can satisfy an
owner's exact-artifact policy, and the lifecycle and concurrent-mutation guarantees of the ref ID,
remain unverified; see the [research-only assessment](github-graphql-commit-research.md). Its
availability does not establish an exact-commit push transport or safe retry.
A local resource lock cannot exclude another client on a remote server. The transport must bind an owner-authorized immutable
provider/instance identity and immutable repository ID to an authenticated endpoint and exact ref,
not merely hash a configured URL or trust a remote alias. The server must attest that repository ID
for the same authenticated connection/session that receives the mutation; SSH host-key or TLS server
verification authenticates an endpoint but by itself does not prove a particular repository identity.
Avoid redirects, URL rewriting, proxies, helper commands and configuration that can change the
recipient, unless each is explicitly authenticated and included in the design. Fail closed when the
provider offers no trustworthy repository identity binding. Credentials are scoped to the exact
repository/ref where the provider supports it; do not log secrets.

For a meaningful expected-head precondition against external writers, the server must atomically
compare the accepted old value and update the exact ref while enforcing its branch policy. A normal
non-force fast-forward push is not equivalent to accepting an exact old head: another fast-forward
may have happened after preview. Git's [`--force-with-lease`](https://git-scm.com/docs/git-push)
is not by itself a non-force guarantee: Git documents that it can override the fast-forward restriction
when the expected ref value matches. A future adapter must independently enforce fast-forward and the
exact expected old value; this document does not establish that a particular transport can do both.
Standard Git old-OID comparison can still admit ABA; if the policy
must detect *any* intervening change, require a provider-supported monotonic ref generation or an
exclusive server-side transaction, and refuse providers without one. Server-controlled hooks, hidden
refs, branch protection, and the server's symbolic-ref semantics must be evaluated; this design does
not assume client-side `--no-deref` applies remotely. An authenticated read-back is only a point-in-time
observation; an external writer can change the branch immediately afterward, and it cannot prove a
lost request did not briefly take effect. Network failure after send is uncertain. A remote receipt
must bind provider, repository, ref, operation, old/new IDs and, where available, generation; absent a
server-durable operation receipt, exactly-once and conclusive automated reconciliation are not claimed.
Aliased URLs or differing asserted digests must not partition the resource barrier; only verified
canonical provider/repository identity may key it. Cross-instance Pilot journals still need a shared
coordinator or server enforcement.

## Required disposable validation before reconsidering installation

- Independent review of provisioning, privilege separation, protected path/mount and IPC assumptions;
  prove the caller and other ordinary UIDs cannot modify, rename or replace any repository ancestor,
  ref, config or socket. Include a negative test showing same-UID permissions are inadequate.
- Multi-process adversarial tests pause at each inspection/effect seam and try root, `.git`, ref,
  packed-ref and symbolic-ref substitution, including a same-old-OID symbolic ref. Every successful
  update must be the intended direct ref of the intended broker generation; otherwise refuse before
  mutation. Include ABA, competing legitimate Git writers, maintenance, lock-holder crash and child
  process survival. Tests against only a process mutex or post-write detection are insufficient.
- Fault-inject each authorization/revocation ordering, durable intent/journal step, Git start, fsync,
  response and restart; confirm no unproven not-started result, replay, barrier release or receipt.
- A disposable server/transport fixture must exercise endpoint/repository misbinding, redirects,
  aliases, external competing writers, expected-old mismatch, ABA, non-fast-forward policy, server
  rejection, lost replies, changed read-back, and ambiguous reconciliation. This is not proof of any
  particular hosted provider's behavior. Verify any actual provider contract separately before use.
- Review the accepted artifact binding, provenance, path/mode validation, object format, Git execution
  environment, resource lifecycle, backup/restore and policy semantics end to end. No production
  wiring until all unresolved assumptions and recovery controls have independent evidence.
