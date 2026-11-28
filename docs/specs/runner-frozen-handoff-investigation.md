---
title: "Frozen runner handoff investigation"
description: "Source identity, filesystem races and the blocker for a future separate runner."
pilot:
  schema: 1
  id: runner-frozen-handoff-investigation
  kind: specification
  doc_status: draft
  feature_status: planned
  verified_release: null
---

# Frozen runner handoff investigation

## Disposition

**Blocked; no live-tree snapshot producer or runner handoff is installed or implemented here.** The
existing `runner-snapshot.ts` validates caller-supplied file bytes and computes a content digest; it
never reads a project, authorizes a project or fork, or proves a coherent point-in-time view. The
uninstalled service admission binds a caller's `projectId`, `workspaceId` and content digest into a
journal request, but its authorization callback and snapshot validator do not establish that those
bytes came from that workspace. Materialization validates supplied bytes into a private directory; it
is not a source snapshot or provenance proof. In particular, choosing a pathname and then copying it
is not a safe substitute for the missing boundary. No existing code in this investigation is installed
or enabled.

The owner-authorized source, principal isolation, filesystem freezing and fork mutation coordination
needed below are not established by the current integration. A purely in-process manifest wrapper
would merely label unverified bytes; a pathname walker would create an unsafe handoff. Consequently no
new purported security primitive is warranted until those preconditions have a real implementation.
No claim of protection from same-UID processes is made.

## What must be established before implementation

1. **Exact authority and identity.** A separately protected service must resolve an independently
   owner-administered, revisioned mapping to the exact project and, where applicable, child fork,
   including project identity, fork/session identity, fork revision and lifecycle, authorized source
   root and permitted source revision. An application-provided ID, directory, Git HEAD, digest or
   fork label is not proof. Specify what source state the owner authorizes: a specific immutable Git
   tree, or a specific coherent dirty worktree generation. A fork's base commit alone does not name its
   later edits. Reject wrong project/fork, stale or revoked mappings and unresolved/uncertain lifecycle;
   bind the policy/source revision to the job and recheck at the defined admission boundary. Define
   revocation semantics for a snapshot already sealed and a job already started. App authentication
   does not itself authenticate the owner or validate the asserted origin.
2. **Freeze the source, not just the result.** Use a genuinely immutable, independently protected
   source generation (for example a broker-owned immutable object or a separately reviewed filesystem
   snapshot with its exact creation/consistency guarantees). Specify who may write and rename every
   ancestor, create mounts, and mutate inodes, and how writes by all participating processes are
   fenced; Pilot's lifecycle fences alone cannot stop arbitrary processes or same-UID shell. If a
   consistent generation cannot be obtained, refuse rather than advertise a frozen worktree. Multiple
   stat checks or rehashing before and after a sequential copy cannot prove a single point-in-time tree
   under arbitrary mutation, including ABA changes. A Git tree can identify committed content but does
   not capture uncommitted fork work and needs a separately pinned repository/object source.
3. **Pin traversal and deny escapes.** On the selected Linux platform use a reviewed descriptor-relative
   traversal rooted in the exact authorized immutable generation, with kernel-enforced beneath/no-symlink
   and no-mount-crossing semantics (including bind mounts), fail closed if unsupported, and no pathname
   fallback. `O_NOFOLLOW` on a leaf does not protect its ancestors; device-number comparisons alone do
   not identify same-device bind mounts. Reject symlinks, special files, inaccessible/changed entries,
   and hard-linked regular files (including `nlink != 1`) unless a separately reviewed policy proves
   their immutable provenance. Pin and validate the root and every descriptor, and account for rename,
   link and mount races; merely checking metadata and later opening by path is insufficient. A private
   namespace and mount policy require independent setup and validation, not an assumption from Node.
4. **Bound before and during work.** Apply fixed limits to raw transport/frame bytes before parsing,
   scanned entries (including excluded entries and directories), depth, path bytes, individual and
   aggregate content bytes, open descriptors, time and concurrent jobs. Bound reads incrementally,
   including files that grow, directory enumeration and encoding overhead; reject entire snapshots on
   any violation, errors or unsupported names rather than silently truncate. Decide explicit policy for
   empty trees, empty directories, executable bits, generated/app-managed paths and unapproved files;
   specify case and filesystem name-equivalence collisions on the actual destination filesystem. The
   current validator limits 1000 input files, 2 MiB per file, 8 MiB total, 32 path segments and 4000
   derived directories, but does not enumerate a filesystem or bound excluded entries and cannot
   decide what the authorized tree should contain. File path filtering is not secret scanning.
5. **Bind and seal evidence.** Define a versioned domain-separated canonical statement containing
   independently resolved project/fork identity, source generation and policy revision, precise
   inclusion rules, sorted paths, modes, per-file lengths and cryptographic digests, aggregate counts,
   and a digest of the complete manifest. Authenticate that statement at the protected handoff and
   verify bytes and identity independently at the receiver. Publish only after complete validation and
   durable atomic sealing into service-owned immutable storage; verify its private ownership, mount,
   ACL and crash/recovery assumptions. Quarantine uncertain partial artifacts; do not treat a digest,
   read-only mode bits, app-supplied receipt or unsigned label as provenance or immutability. A digest
   proves which bytes were represented, not who authorized them or whether they ever coexisted.
6. **Review and test the full boundary.** Require disposable Linux tests for root/ancestor swaps,
   symlink and bind-mount insertion (including same-device mounts), hardlinks and external inode writes,
   inode replacement, directory entry and content mutation during every traversal/read/seal boundary,
   ABA mutation, cap exhaustion, unsupported kernel operations, cross-project/fork substitution,
   policy revocation and lifecycle races, restart/crash and partial seal recovery. Prove refusal or an
   exact authorized immutable generation, not merely detection after a leaked read. Independently
   review principal separation, source authorization, filesystem consistency, service transport and
   runtime before production integration. Tests must not use a live project or modify the host.

## Disposable characterization and limits

`tests/server/runner-frozen-handoff-characterization.test.ts` demonstrates that identical supplied
bytes have the same digest for distinct asserted project/fork labels; a checked directory can be
replaced with a symlink before an `O_NOFOLLOW` leaf open; an in-tree regular file may share an inode
with a mutable outside hardlink; and sequential reads can yield a correctly hashed mixed-time state.
It also verifies the existing input-file count limit. These are deterministic counterexamples in
temporary directories, not tests of a nonexistent collector or proof of an attack against an installed
endpoint. They do not exercise mounts, Linux `openat2`, cross-principal access, live concurrent races,
service policy, protected sealing, or the runner runtime. Existing snapshot tests cover content digest,
path/mode checks and the per-file and total byte bounds of the in-memory validator.
