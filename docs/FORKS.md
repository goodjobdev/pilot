# Forks

A **fork** is one child session branched from a parent transcript at an exact cutoff entry, with its
own git worktree created from a recorded base commit. It is the one place in this build where a
conversation and a filesystem are created together, so every part of it is a rule rather than a
convention: what the child may see, where its worktree comes from, what it inherits (nothing), and what
has to happen before it is allowed to dispatch anything (an explicit resume).

The model is pure and lives in `src/shared/forks.ts`; the durable half, the transcript port and the one
git port are `src/server/state/fork-store.ts` and `src/server/agents/harness-host.ts`; the actions are
registered in `src/shared/actions.ts` and bound in `src/server/state/action-registry.ts`; the routes are
in `src/server/main.ts`. The tests are `tests/server/fork-store.test.ts` (a real disposable repository
and the application's own harness), `tests/server/action-registry.test.ts` and
`tests/server/http.test.ts`.

## The record

A fork is durable. It is one control-store operation per revision — keyed `fork.r<revision>` inside the
**child session's own scope** — so the control store's `UNIQUE(project_id, session_id,
idempotency_key)` index is the compare-and-swap: a creation is a single admission, and a fork either
exists at revision 1 or does not exist at all. Nothing else persists; the schema is not extended.

| Field | Meaning |
|---|---|
| `projectId` | the parent project (and the project whose repository the child worktree is added to) |
| `parentSessionId` | the parent session the fork branched from |
| `cutoffEntryId` | the exact entry id in the parent transcript the child branched at |
| `childSessionId` | the child session — the child transcript conversation, adopted as a named session. It **is** the fork's identity: resume and discard name it and nothing else |
| `worktreePath` | the child worktree's own absolute path, always inside the designated fork root |
| `baseCommit` | the full 40-character commit the child worktree was created from |
| `state` | one of `paused`, `active`, `discarded`, `failed` |
| `revision` | one per mutation; the token a resume or a discard sends back |
| `attention` | the named reason a `failed` fork needs a person (`null` in every other state) |
| `createdAt`, `updatedAt` | the creation instant and the last write |

Validation is strict and every refusal is **path-free**:

- an **unknown field**, a missing field or a value of the wrong kind is refused by the record's own
  schema, so nothing a model does not describe can be stored;
- a fork cannot be its own parent session, an unknown state is never interpreted, and a cutoff of zero
  is not an entry of any transcript;
- the `attention` field must match the state: a `failed` fork always carries the reason it needs a
  person for, and a `paused`, `active` or `discarded` fork never does;
- a base commit is the full lowercase 40-character id of one commit — an abbreviation, a branch name or
  an uppercase id is refused, so the record always names exactly one immutable commit;
- a stored record over the documented byte bound (64 KiB, the control store's own payload cap) and a
  stored record that does not validate are **corruption**, refused as such rather than interpreted;
- a **cutoff that does not exist in the parent transcript** and a **base commit that is not a commit of
  the project's own repository** are refused before anything is created, with a message that names no
  path;
- a **target path outside the designated fork root** is refused rather than rewritten, both when a
  target is supplied (an absolute path, a separator or a parent segment is refused by the parameter
  rule, and a symlink component is refused by the contained-path helper) and when a record is read back
  (a `worktreePath` that is not a direct child of the fork root is refused as an escape, and nothing is
  touched).

## The cutoff rule

**A child sees the parent context up to and including the cutoff entry, and nothing the parent recorded
after it.** The rule is one pure function (`forkContextEntries`) and it is what the transcript fork
implements: the child conversation is created by Pi Durable's own `fork(at)`, not by a copy this
application performs, so the cutoff is the transcript's own boundary. Creating it makes **no model
request** — the tests assert it — and the child is created with ownerless ownership, exactly like the
project's root conversation, so it is durable and readable like any other conversation.

Two bounds are worth stating plainly:

- the cutoff is looked up inside the **newest 2,000 entries** of the parent transcript, searched oldest
  first in pages. The lookup is bounded on purpose: a cutoff outside that window is refused (nothing is
  created) rather than searched for without limit;
- the parent must be a **conversation of that project's harness**. A session id that is not one is
  refused as not found, and this build never invents a parent transcript.

## The worktree rule

The child's worktree is created from the **recorded base commit** by **one fixed git operation**:

```
git -c core.hooksPath=/dev/null -c protocol.file.allow=never -c protocol.ext.allow=never \
    -c submodule.recurse=false -c fetch.recurseSubmodules=no -c submodule.fetchJobs=1 \
    -c advice.detachedHead=false \
    worktree add --detach -- <worktree path> <recorded commit>
```

run inside the registered project's own folder with a stripped environment (`HOME=/nonexistent`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `LANG=C.UTF-8`).
What that means, property by property:

- **No hooks.** `core.hooksPath=/dev/null` for every invocation, so no repository hook can run.
- **No submodule recursion.** Submodule recursion is off by configuration
  (`submodule.recurse=false`, `fetch.recurseSubmodules=no`). That is the only way to say it:
  `git worktree add` has no `--no-recurse-submodules` flag and never initializes a submodule of its
  own, so this build sets the configuration rather than pretending a flag exists.
- **No network.** There is no `fetch`, `clone`, `pull` or `ls-remote` anywhere in the fork port. A fork
  never reaches a remote, and it never asks for a credential.
- **No local-protocol transport.** `protocol.file.allow=never` and `protocol.ext.allow=never`, so
  neither a local path nor an external helper can be used as a transport.
- **No branch, no force.** `--detach` checks out exactly the recorded commit and creates no branch, and
  there is no `--force`: an occupied target fails closed instead of being overwritten.

And, most importantly:

- **No dirty-state carry, and no stash.** Nothing in this build reads the parent's working tree, copies
  an uncommitted or staged change, or runs `git stash` in any form. The command above checks out a
  commit; it cannot see an untracked file, a staged change or an index entry. The test suite proves it
  with a sentinel: an untracked, unstaged file **and** a staged change are left in the parent worktree,
  a fork is created, and the child worktree holds neither — while the parent's file, the parent's
  `git status` and the parent's HEAD are exactly what they were, and `git stash list` is empty.

**One root per project.** The designated fork root is `<data>/forks/<projectId>`, resolved and cached
**per project id** and created on first use with private permissions (0700). The application constructs
one `ForkStore` for the whole instance, so the root is keyed by the project: a child of project B is
never created under project A's root, and the layout `<data>/forks/<projectId>/<childSessionId>` holds
for every project whichever one is used first. `tests/server/fork-store.test.ts` drives one store for
two projects and asserts each child's recorded path is inside its own project's root, that neither is
under the other's, and that discarding one project's fork leaves the other's worktree exactly where it
is.

**State this plainly to anyone reading a fork's worktree: a fork starts from the recorded commit.**
Uncommitted work is deliberately *not* carried, in either direction. If something exists only in the
parent's working tree, the child does not have it and never will without an explicit operator step.

## The paused child, and inheritance

A child is created **paused**, and a dispatch that observes `paused` is refused before the transcript
port is called. The application now exposes that fenced dispatch on two model/owner paths: the
owner-authenticated route `POST /api/projects/<project>/forks/<childSessionId>/dispatch` and the
`fork_dispatch` agent tool (governed by the `fork` scope), both carrying a caller-supplied invocation
ID. `dispatchChild` requires a stable, caller-owned invocation ID, which the caller must reuse for
retries and change for logically distinct work. Before submission, the store
records a durable admission binding that ID to the child and exact text digest. The Pi request ID is
derived from the invocation identity. An exact retry after a successful durable receipt returns that
receipt without resubmitting; changed text under the same identity conflicts. A pending or unknown
admission is never replayed, including after reopen, because the prior submission outcome may be
uncertain. The action holds the durable per-child lifecycle fence while its transcript-dispatch promise
is awaited. The controlled host marks only failures proven to occur before `conversation.submit` is
invoked as a typed not-started refusal; those release the fence because this call submitted no input.
Every other callback rejection or interruption remains uncertain and holds the fence for operator
review. This is a limited application-level
reservation around that one call, not an atomic handoff with Pi Durable's conversation admission. Pi
Durable 1.3.0 may resume the scheduler before awaiting admission commit, and its public API does not
expose an atomic lifecycle reservation and activation handoff. Provider-before-submit-return behavior
and async-context propagation are not established as safe assumptions. The fence does not prove provider
quiescence or termination. Ordinary harness submissions, question answer/dismissal/redelivery, and
lifecycle replay remain unfenced across their full input-admission sequences; other processes/releases
may bypass this process's reservation. Do not treat a state check or submission return as proof that
provider work is quiescent. An explicit
`fork.resume` lifts the pause; the resume itself dispatches nothing, makes no model request and grants
nothing. A **repeat** of that call is a declared **no-op**: an already `active` fork answers
`unchanged` **without re-checking the revision**, because it writes nothing at all — the revision is
the token of the transitions that really write (the resume that lifts a pause, and the discard), so the
`REVISION_MATCHES` the action descriptor declares and this one call accepting any revision are not in
contradiction. Only an `active` fork may be dispatched into, and a `discarded` or `failed` one refuses
with the reason. The harness checks that state before each provider request and tool execution, as
well as for ordinary session input, question delivery, lifecycle dispatch and the fork dispatch action;
these remain check-then-submit paths, not admission reservations. A lifecycle refusal happens before
its revision is changed. These checks cannot stop a provider request
or tool already in progress. They are not process isolation: a same-UID shell can leave background
processes even after its harness generation is no longer working.

Before creating the transcript, the store records a durable per-project creation fence. While held, it
refuses new dispatch checks for other sessions and competing fork creations; the known parent remains
usable. A submission that passed its gate before acquisition can still be admitted while it is held. The
fence is released only after a paused or failed fork record is durable. If the transcript call or its
receipt is uncertain, the fence stays held across restart rather than guessing whether a child exists.
The owner-only fork list reports a held fence's revision and parent. An owner can release it
deliberately with `POST /api/projects/:id/forks/recover-creation` and the exact `{parentSessionId,
revision}` the list showed; the release requires the parent session to be quiescent, creates nothing,
replays nothing and removes nothing. Do not clear the record manually.

An explicitly requested target is checked again against the filesystem and recorded fork targets
while the creation fence is held, before the transcript is made. A successful new worktree receives a
durable opaque ownership fingerprint. The experimental removal path checks for missing or conflicting
ownership and compares the registered Git worktree and filesystem identity, but it is available only
to disposable tests. A failed creation never acquires deletion authority over an occupied target. These
checks are not a race-free OS handle: a same-UID process can still replace paths or Git metadata
between verification and Git's removal. Consequently the application does not automatically remove
existing fork worktrees, including legacy forks without an ownership record.

Resume, discard, each awaited child provider request and each awaited child tool execution take the
same durable per-child fence. Competing activity or lifecycle operations refuse while it is held; the
activity itself can recheck its session under its private reservation. A provider's terminal event is
forwarded only after release, allowing a subsequent tool to acquire its own fence. This closes the
gate-to-body race with worktree removal for these awaited calls. Discard also checks the harness view for running or queued work after
acquiring the fence; it refuses if that check is unavailable or the child is busy. If the process dies
with the fence held, or removal starts and no durable result is recorded, the fence remains held across
restart. The owner-only fork list reports held fences for listed children, but it cannot distinguish a
currently running tool from an interrupted operation, so recovery is an owner decision, not an
automatic one: `POST /api/projects/:id/forks/:childSessionId/recover` with the exact `{revision}` the
list showed releases the fence only after the child is proven quiescent. It dispatches nothing,
replays nothing and removes nothing; the owner must still inspect any interrupted effect and decide
what to do next. A fork whose worktree was left behind still needs a separate operator decision
because this build does not remove an existing worktree automatically.

Fence reads verify the latest two revisions, their transition and linked durable outboxes. A malformed
or mismatched recent record fails closed rather than being treated as released. This bounded check is
not a full-history audit and cannot protect the store from a same-UID writer that can alter or delete
records; it also does not establish whether interrupted work is still running. The owner recovery
routes above release a fence deliberately, but they cannot distinguish a live operation from an
interrupted one and do not prove provider quiescence: the release records the owner's decision, not a
fact about the interrupted effect.

A provider stream failure, cancellation or unconfirmed final result retains its child fence rather
than assuming termination. An ordinary settled tool failure releases its fence, and a normal provider
result is still only the provider's report—not independent evidence of remote termination. The fence
is not an operating-system lease and cannot prove that an uncontained shell or a remote job has left
no detached effects. It does
not stop a same-UID process in another session from accessing the fork. It also does not cancel an
effect already started. Inspect such processes before discarding. Older builds do not understand these
fence records, so rolling back to one can bypass a held fence; a release needs a reviewed rollback
procedure that preserves the block, not an assumption that the old build enforces it.

Project documentation and note tools, acceptance writes, and the bounded `file_edit` tool resolve to the parent workspace
rather than this child; they are refused in a fork instead of reading or changing the wrong tree. When
explicitly enabled, the direct coding tools resolve the child worktree. This routing does not establish
successful execution beyond this guarded path: ordinary submissions, question delivery and lifecycle
replay remain unfenced, and this dispatch is not atomic admission or proof of provider quiescence.
Action-driven dispatch waits for the child submission result under the lifecycle fence, but does not
contain detached processes. The optional shell remains
uncontained and can still reach the parent, other projects and credentials.

A fork **inherits nothing**:

- no **approvals** — an approval is a single-use, target-bound grant, and the child's own approval list
  is empty while the parent's is untouched;
- no **accepted artifacts** — no completion record names the child session;
- no **grants or links of any kind** — the child session is adopted with no link and no declared model,
  so a task, document or workspace link the parent holds is not the child's;
- an **empty queue** — the child's queue reads at revision 0 with no entries, and the fork touches
  nothing of the parent's queue, which stays at its own revision in its own state, unclaimed by the
  child;
- its **own transcript** — the child holds the parent's context up to the cutoff and nothing after it.

The child session's name is derived from the parent's name and the child session id
(`Parent session fork 12`), so it says which session it branched from and two forks of one parent can
never collide.

## Discard

`fork.discard` is revision-checked and never accepts a caller-supplied path. **Discard of an active
fork is unavailable**, even if its worktree appears absent or the session looks idle: a submission can
be admitted asynchronously after a quiescence check. There is currently no safe transition from active
back to paused, so an active fork remains active pending a reviewed admission and recovery design.
This restriction prevents that lifecycle transition; it does not make admission atomic or establish
that detached processes have stopped. Older binaries or other writers can bypass it.

**Automatic removal of an existing worktree is also unavailable**, even with `force: true`: the application returns 503
and leaves the fork and worktree unchanged. Independent review found that pathname-based Git removal
cannot pin the verified directory against concurrent replacement. The owner must stop and inspect the
workspace and use an appropriately safe, separately controlled procedure outside Pilot; do not assume
that a force flag makes the target safe. If a non-active fork's recorded path is already absent, Pilot
can close it with `removed: false`; an already discarded fork is a no-op. There is no automatic cleanup,
`git clean`, or `git worktree prune`.

The ownership fingerprints and path rechecks are defense in depth, not proof against a hostile
same-UID process. The removal implementation is exercised only through an explicit disposable-test
seam, not enabled by the application. Legacy forks without fingerprints also require operator review.

## Routes and actions

Every fork route is behind the same owner-only authentication as every other route, behind the
**unchanged Host check**, and every write carries the same origin and CSRF enforcement.

| Route | Method | What it does |
|---|---|---|
| `/api/projects/:id/forks` | GET | the project's forks, with the three rules and the bounds in force |
| `/api/projects/:id/forks` | POST | `{ parentSessionId, baseCommit, cutoffEntryId, target? }`; 201 when the fork exists, 200 with `created: false` when it is recorded as a named operator-attention state |
| `/api/projects/:id/forks/:childSessionId/resume` | POST | `{ revision }` — lifts the pause; dispatches nothing |
| `/api/projects/:id/forks/:childSessionId/discard` | POST | `{ revision, force? }` — closes a non-active fork only if its recorded worktree is already absent; otherwise returns 503 |
| `/api/projects/:id/forks/:childSessionId/dispatch` | POST | `{ parentSessionId, invocationId, text }` — sends one input to an **active** child under the fenced, durably bound submission; an exact repeat returns the same `requestId`, changed text conflicts, and an uncertain outcome holds the fence |
| `/api/projects/:id/forks/:childSessionId/recover` | POST | `{ revision }` — owner recovery for a **held lifecycle fence**: releases it only after the child is proven quiescent; dispatches, replays and removes nothing (404 when no fence is held, 409 when the revision is stale, 503 when quiescence cannot be verified) |
| `/api/projects/:id/forks/recover-creation` | POST | `{ parentSessionId, revision }` — owner recovery for a **held creation fence** for that parent; same guarantees and statuses, and it creates nothing |

The same four capabilities are the actions `fork.create`, `fork.list`, `fork.resume` and
`fork.discard` (`docs/ACTIONS.md`), which is what the palette writes through. Both surfaces call the
same store methods, so they cannot disagree about what an operation does. Statuses: 422 for a malformed
request or an unreal base commit, 403 for a target that escapes the fork root, 404 for an unknown fork
and a cutoff the transcript does not hold, 409 for a stale revision, a taken target, the fork bound and
an illegal state change, 503 when this instance has no fork capability (the agent harness is off), 500
for storage or corruption. **A refusal never names a path**: a git or filesystem error may name one, so
those are logged on the server and never stored in a record or returned to a caller.

## Bounds

| Bound | Value |
|---|---|
| forks one project may hold (live; discarded forks do not count) | 20 |
| parent transcript entries searched for the cutoff | 2,000 |
| stored fork record | 64 KiB |
| fork target | one path component of 1-80 characters, letters, digits and `._:-`, starting alphanumeric |
| base commit | the full 40-character lowercase hex commit id |

## Honest limits

- **Dispatching into an active child is one guarded path, and the queue is not it.** `fork.resume`
  makes a child dispatchable; both the owner route above and the `fork_dispatch` tool call
  `ForkStore.dispatchChild`, which refuses anything that is not `active` before it reaches the harness,
  refuses a caller whose own session is not the fork's recorded parent, and binds the invocation
  identity to the exact text. This project's **queue** dispatcher submits into the project's *root*
  conversation, so the queue's claim and submit routes **refuse a fork child** (409) rather than
  misdirect its input into the wrong transcript — a child's queue is empty by construction, and it
  stays un-dispatchable through that path on purpose.
- **Reading a fork attaches a conversation.** Creating a fork reads the parent's transcript, which opens
  the project's harness exactly as the Agents view does, and opening a harness resumes unfinished work
  the previous process left behind. That is the same exposure every other agent read in this build has;
  the fork itself makes no model request of its own (asserted in the tests).
- **A crash between the transcript fork and the record write can leave a child.** The order is
  parent → cutoff → base commit → target → transcript fork → child session → worktree → record, so a
  process that dies in the middle can leave a child conversation, a child session or a worktree with no
  fork record. Nothing retries a fork automatically, and this build never deletes what it did not
  finish creating.
- **A failed worktree creation is recorded, not cleaned up.** If `git worktree add` fails, the fork is
  recorded as `failed` with `worktree-create-failed` so an operator can see exactly what exists; the
  target may hold a partial directory, and nothing force-removes it.
- **A discard never prunes.** When a worktree directory has already vanished, the discard completes, but
  the *parent repository* may still carry a stale registration for it. `git worktree prune` would clear
  that, and this build deliberately runs no prune, because prune would also drop the registration of a
  worktree that is broken for another reason. An operator decides.
- **The child worktree is a detached checkout, not a branch.** It is at the recorded commit and on no
  branch, so continuing work there is an explicit operator step. The action tools that are installed
  in this build (`commit`, `push`, `deploy`, `publish`, `provision`, `spend`, `run_tests`) are all
  refused in a fork: they act on the parent project, its configured targets or its repository. A fork
  can still reach the same effects through the uncontained shell if that is granted.
- **`forks/` is an explicit, documented backup exclusion — and a restored root keeps the fork records
  but none of their worktrees.** The child worktrees live in `<data>/forks/<projectId>/<childSessionId>`;
  `docs/BACKUP.md` and `docs/DEPLOYMENT.md` name that directory as an exclusion with its reason. It is
  derived state — the repository's own commits checked out again, held as git worktrees registered
  inside a repository that is itself excluded, because that repository is its own backup — so a restore
  cannot reuse the directory and no commit is lost with it. The consequence is stated plainly: because
  `control.sqlite` **is** captured, a restored root still lists the forks of the root it came from, and
  every record still names the worktree path of *that* root. A discard acts on the path a record carries
  and re-checks that it is inside the root in force **now**, so this build refuses to touch those paths
  (`OUTSIDE_ROOT`) rather than following them out of the restored root. Such a fork is therefore left
  as a deliberate operator decision, and this build has no path that clears one yet.

## Agent tools and worktree routing

An agent with the `fork` scope can call `fork_context` for recent entry IDs and `fork_create` for
its own conversation, providing an exact commit and cutoff. The existing 2,000-entry cutoff scan
still applies. The child is paused, receives no inherited agent grants, and requires separate binding
and resume. Creation makes no model call in the child.

For an active fork, direct coding tools use that fork’s worktree for file operations and the shell’s
initial working directory. The shell itself remains uncontained. Calls are refused if the fork is
not active or its worktree cannot be verified. The bounded `file_edit` tool is refused in forked
sessions because it targets the parent project; planning tools still use the project’s canonical
planning documents.

**A model-facing child dispatch is installed, and it is narrower than the fork grant.** `HarnessHost`
installs `fork_context`, `fork_create` and `fork_dispatch` through `forkExtension`. `fork_dispatch`
passes the calling conversation's own session identity to `ForkStore.dispatchChild`, which refuses any
child whose recorded parent is not that session — project membership alone is not authority to send
into someone else's fork. The store binds the caller-supplied invocation identity to the child and the
exact text digest at durable admission, so an exact repeat returns its receipt without resubmitting and
changed text conflicts; a pending or unknown admission is never replayed. Duplicate admission and the
held lifecycle fence are enforced in the same store transaction.

The fence around the dispatch is not a fence around everything. `HarnessHost.submit` checks
`assertNotUncertain`/`sessionGate` before `conversation.submit`, but it does not reserve the fork
lifecycle fence across that check-to-submit interval. A deterministic test in
`tests/server/fork-store.test.ts` installs a production-equivalent `sessionGate`, starts the ordinary
`HarnessHost.submit` path, and pauses the real `conversation.submit` call after the gate has passed; it
then acquires the child fence and confirms the ordinary submission reaches that paused call while the
fence is held. Pi Durable exposes no atomic reservation-and-activation handoff for that admission, so
ordinary submissions, question delivery and lifecycle work can still race admission. Neither the fence
nor submission completion proves provider quiescence or termination, and the child's worktree is not a
process sandbox. The installed action therefore binds identity, text and receipt; it does **not** claim
exactly-once execution or containment, and an uncertain outcome is for the owner to reconcile.
