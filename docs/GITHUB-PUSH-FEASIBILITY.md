# GitHub exact commit and non-force push: offline feasibility

**Research only; no transport, capability, approval or deployment is installed by this document.**
The prospective `j3hn/test-pilot` `main` target is an owner-proposed name, not a verified repository,
owner, branch, permission or instruction to push. No GitHub network request or live repository
modification was made. This design does not establish that GitHub offers the identity-bound atomic
operation it requires; until independently verified and implemented, the transport must refuse.

## Inspected baseline

An independent local reconstruction of `work/pilot-integration` at
`0cc6b82b36d8d40050ae0f2523e26f30ff808d72` was inspected, not a live deployment. Its
`docs/PROJECT-CONNECTIONS.md` and `src/server/repositories.ts` describe a normalized GitHub SSH
URL, pinned GitHub Ed25519 host key, isolated SSH configuration and project deploy key. `test` uses
`ls-remote` and explicitly proves only read access; `fetchDefault` is an owner-reviewed read/update
adapter, not a push adapter. `src/server/workspace.ts` locally commits selected saved files with
`git commit --only` on the managed Pilot branch; it does not pre-bind an exact commit object or
push. Its failure after entering commit is uncertain. `src/shared/approvals.ts` binds commit approval
to repository, branch and tree digest, and push approval to remote, branch and 40-hex commit SHA;
neither includes the immutable provider identity or expected remote head. Approval consumption is
not execution. These existing interfaces cannot authorize this proposed stronger operation unchanged.

## Three distinct identities

1. A pinned SSH host key authenticates the **Git server endpoint** under the configured trust policy;
   the deploy key authenticates/authorizes a client to that server. Neither proves an immutable
   GitHub repository identity. A successful Git read also does not prove permission to write.
2. `git@github.com:j3hn/test-pilot.git` is a mutable routing name. Rename, transfer, deletion,
   recreation, redirect or reassignment can change what it denotes. `main` is likewise a mutable
   ref, not a repository identity. A Git object ID names content, not its owning repository.
3. A provider-issued immutable repository identifier, obtained over an authenticated, verified
   provider API and explicitly confirmed by the owner, is a separate identity. The exact API fields,
   permanence, redirect/transfer semantics and authorization required must be verified against
   current GitHub documentation and experimentally verified in a separately authorized disposable
   environment. No such evidence is asserted here.

## Proposed preconditions and binding

A future owner-selected operation would first acquire and display a fresh authenticated provider
observation: provider and endpoint, immutable repository ID, canonical owner/name, intended exact
`refs/heads/main`, and credential identity/version without secret material. Refuse missing, ambiguous,
redirected, transferred or changed identity/name unless the owner explicitly reselects and authorizes
it. Pin the Git server key independently. Preserve the observed identity, time and verification method;
never put token/key bytes in records or logs.

A new versioned, single-use authorization must bind the project/worktree identity, provider endpoint,
immutable repository ID and canonical name, ref, object hash algorithm, expected remote old commit,
exact new commit, and credential version, plus expiry and action scope. It must also bind the exact
commit's tree, ordered parent(s), author/committer identities and timestamps, message bytes and any
other commit headers. Review must cover the full resulting tree and all included history, not just a
list of paths. Establish ancestry `old` → `new`; refuse missing/unknown old ref, non-commit objects,
unsupported object formats, non-fast-forward, stale grant, dirty/changed inputs or uncertain work.
Creation/deletion of a branch is outside this design. The current 40-hex approval schema and its
commit tree digest do not express these requirements; a separate reviewed contract and migration are
needed, not interpretation of an existing approval as broader authority.

For an exact local commit, construct the candidate from an independently checked snapshot and fully
specified commit bytes, calculate and verify its object ID, and approve that object and its parent(s)
before any ref update. Use isolated, bounded Git invocation and temporary index; disable hooks,
filters, signing, external helpers, config rewrites and other repository-controlled execution. A
local ref update, if separately authorized, needs a compare-and-swap against the approved old local
head. Keep project serialization and refuse concurrent external writers; same-UID shell is not
isolated from credentials or repository state. Existing `commitFiles` does not provide this binding.

## Transport feasibility gate

A provider API identity lookup followed by an SSH push to a mutable name has a **TOCTOU gap**:
the name can resolve to another repository after lookup, even if both connections authenticate the
correct GitHub server. Repeating the lookup immediately before or after push only narrows or detects
some races; it cannot undo a push to the wrong repository. A deploy key's supposed repository scope
must not be treated as a proven immutable identity binding without provider evidence covering key
lifecycle, transfers, reuse and the exact receiving repository. Refuse to install the transport unless
an independently verified provider-enforced mechanism binds the write itself atomically to the
approved immutable repository ID and ref, with no fallback to name-only routing. If GitHub exposes no
such mechanism, this strong guarantee is not feasible with the existing SSH adapter; an owner
accepting weaker name-based risk would require a separate explicit product/security decision.

Also require a server-enforced conditional update of **exactly** approved `old` to approved `new`,
with non-force fast-forward semantics. A standalone `ls-remote` followed by ordinary `git push` does
not pin the approved old head: push negotiates again and a concurrent advance to another ancestor
could still result in a successful fast-forward. A lease alone is not sufficient evidence of a
non-force operation; force-capable options must not be silently substituted. A potential low-level
receive-pack old/new conditional request needs its own protocol implementation, peer and server
verification, and proof it is non-force and identity-bound; this is a design candidate, not an
implemented or verified GitHub capability. Branch protection, required checks, permission denial,
server hooks and repository rules may reject an otherwise valid fast-forward; never bypass them.

Before any eventual effect, persist admission and exact intent. One send only: distinguish explicit
rejection from confirmed server acceptance and ambiguous interruption/timeout; do not retry, roll
back or infer success from process exit alone. Record bounded sanitized evidence. Resolve uncertainty
through operator review and a fresh identity-bound observation; current head equal to `new` alone
does not prove which actor performed the update. Tests must use disposable local synthetic fixtures,
with a fake identity service and controllable races, never real credentials or a live provider. Cover
name reassignment between lookup and send, mismatched IDs, stale heads, intervening fast-forward,
non-fast-forward, protection rejection, lost response, credential changes and zero calls on refusal.
These are proposed tests, not results from this investigation.
