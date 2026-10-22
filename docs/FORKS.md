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

A child is created **paused**, and `paused` means exactly one thing here: it refuses to dispatch
anything. The refusal is read from the durable state before the transcript port is called at all, so a
dispatch attempt on a paused child causes **no submission, no admission and no model request of any
kind** — which is what makes a fork safe to create before deciding whether to use it. An explicit
`fork.resume` lifts the pause; the resume itself dispatches nothing, makes no model request and grants
nothing. A **repeat** of that call is a declared **no-op**: an already `active` fork answers
`unchanged` **without re-checking the revision**, because it writes nothing at all — the revision is
the token of the transitions that really write (the resume that lifts a pause, and the discard), so the
`REVISION_MATCHES` the action descriptor declares and this one call accepting any revision are not in
contradiction. Only an `active` fork may be dispatched into, and a `discarded` or `failed` one refuses
with the reason.

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

`fork.discard` is **target-bound**: it acts on the `worktreePath` the durable record itself carries,
re-checked against the designated fork root, and it never reads a path from a caller. It is
**revision-checked**: a stale revision is a conflict that mutates nothing and touches no file. And it is
never implicitly forced:

| The worktree is… | what a discard does |
|---|---|
| already gone | completes the discard, removes nothing, and says so (`removed: false`) |
| clean | one `git worktree remove` — no force — and the fork becomes `discarded` |
| dirty (uncommitted or untracked changes) | **refuses** without an explicit `force`: the fork becomes the named operator-attention state `worktree-dirty` and the worktree is left exactly where it is |
| dirty, with `force: true` | removed by one `git worktree remove --force`, and the fork becomes `discarded` |
| not removable, or unreadable | nothing is forced: the fork becomes `worktree-remove-refused` or `worktree-unreadable`, and the worktree stays where it is |

A fork that needs an operator cannot be resumed (only discarded), a discarded fork is terminal, and
nothing outside the designated fork root is ever touched — not even when a stored record claims a path
there. `git` removes the worktree; this build never deletes a directory itself, never runs
`git clean`, and never runs `git worktree prune`.

## Routes and actions

Every fork route is behind the same owner-only authentication as every other route, behind the
**unchanged Host check**, and every write carries the same origin and CSRF enforcement.

| Route | Method | What it does |
|---|---|---|
| `/api/projects/:id/forks` | GET | the project's forks, with the three rules and the bounds in force |
| `/api/projects/:id/forks` | POST | `{ parentSessionId, baseCommit, cutoffEntryId, target? }`; 201 when the fork exists, 200 with `created: false` when it is recorded as a named operator-attention state |
| `/api/projects/:id/forks/:childSessionId/resume` | POST | `{ revision }` — lifts the pause; dispatches nothing |
| `/api/projects/:id/forks/:childSessionId/discard` | POST | `{ revision, force? }` — removes the worktree the record carries, or reports the named attention state |

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

- **Dispatching into an active child is not an owner route in this build.** `fork.resume` makes a child
  dispatchable; the guarded dispatch itself (`ForkStore.dispatchChild`, which refuses anything that is
  not `active` before it reaches the harness) is the path a server-side dispatcher would use, and
  `tests/server/fork-store.test.ts` drives it. This project's **queue** dispatcher submits into the
  project's *root* conversation, so the queue's claim and submit routes **refuse a fork child** (409)
  rather than misdirect its input into the wrong transcript — a child's queue is empty by construction,
  and it stays un-dispatchable through that path on purpose.
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
  branch, so continuing work there is an explicit operator step. Nothing in this build commits, pushes,
  deploys, spends, provisions or publishes, for a fork or for anything else.
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
