# The queue of pending inputs

A named session is *what a conversation is about*; the session lifecycle
(`docs/RECOVERY.md`, `src/shared/session-lifecycle.ts`) is whether a generation is running. The
**queue** is the third piece: the ordered list of inputs the owner has decided to send but that have
not been settled yet, held durably so a closed browser, a vanished dispatcher or a fresh client all
read the same list.

## The queue records intent, and nothing else

This is the rule the rest of this document exists to keep. The durable transcript — the conversation
the harness writes — is the **only** authority on what was actually submitted. Nothing in the queue
treats a queued entry, a claim, or even its own `submitted` state as proof that a model ever received
the input. An entry becomes `settled` only when reconciliation matches it against the submission the
transcript holds for that entry's own stable request identity, and a state the queue cannot prove from
the transcript is reported as a **named operator-attention state** rather than being re-sent.

## The entry

One entry is one pending input. Every field is frozen and strictly validated; an unknown field, a
field of the wrong kind or a combination that contradicts the entry's own state fails closed.

| Field | Meaning |
|---|---|
| `id` | A stable identifier, generated once when the entry is appended. It is the only input the submission identity is derived from, so it never changes. |
| `position` | The entry's place in the order. Positions are the queue's own order: they are exactly `0 … n-1`, so a position outside the queue cannot exist in a stored record. |
| `text` | The input's text, or `""` when the entry carries only images. |
| `images` | Up to 6 image references. A reference is the stored facts of an accepted image — its hex media id, sniffed type, byte length and pixel size — and never a path. The id is resolved against the media store when the entry is appended, so an entry can never carry an unverified reference. |
| `state` | One of the six states below. |
| `claim` | Who holds the entry, until when, and which stable submission identity that claim authorises, for `claimed` and `submitted`. The claim is the durable record of the *intent to submit*, written in the same revision as the entry's own text and images; the strict validation refuses a claim whose recorded identity is not its own entry's. |
| `submission` | The submission the transcript holds for this entry's stable request identity, for `submitted` and `settled` (and for a `failed` entry that was reconciled against one). |
| `attention` | The named reason a `failed` entry needs an operator. |
| `createdAt`, `updatedAt` | When the entry was appended, and when it last changed. |

An entry that carries neither text nor an image is refused: it is not an input, so there would be
nothing to submit.

### The states

The set is closed. An unknown state fails closed rather than being interpreted.

| State | Means | Claim | Submission | Attention |
|---|---|---|---|---|
| `queued` | Waiting, and never dispatched. | no | no | no |
| `claimed` | A named dispatcher holds a lease on it, with the stable request identity that lease authorises, and is the only party allowed to submit it. It is the queue's effective head. | yes | no | no |
| `submitted` | Handed to the dispatcher's port under the entry's stable request identity; not yet reconciled against the transcript. It is the queue's effective head. | yes | yes | no |
| `settled` | Reconciliation found the transcript's own submission for that identity. It is never dispatched again. | no | yes | no |
| `failed` | Terminal, and it needs an operator: the durable transcript could not be matched against the entry's own request identity, so what really happened cannot be established. The queue never records that a dispatcher refused a submission. It is never re-sent automatically and never dispatched again. | no | either | yes |
| `cancelled` | Withdrawn by the owner. It never dispatches. A claimed or submitted entry is never cancelled directly: a submission of it may be in flight, so its claim is released first. | no | no | no |

### The legal transitions

Everything else fails closed, with the transition the table does not hold named in the refusal.

| From | May become | Through |
|---|---|---|
| `queued` | `claimed`, `cancelled` | claim, cancel |
| `claimed` | `claimed`, `submitted`, `queued`, `settled`, `failed` | a renewal or a reclaim, submit, release, reconcile (a crash that reached the transcript, or a submission the dispatcher did not report back) |
| `submitted` | `settled`, `failed` | reconcile |
| `settled` | — | terminal: it is removed by `clear` |
| `failed` | `settled`, `failed`, `cancelled` | a later reconciliation that matched, a reconciliation that refreshed the reason, the operator discarding it |
| `cancelled` | — | terminal |

`claimed` **cannot** become `cancelled`, and that is a rule rather than an omission. A claimed entry
may have a submission in flight under its identity: cancelling it there would drop the claim and
leave the submission in the transcript with nothing that could ever reconcile it — invisible rather
than merely unrecorded. The way to withdraw a claimed entry is to **release** it first (the claim's
own owner gives it back, which is the `claimed` to `queued` transition) and then cancel the queued
entry. A `submitted` entry cannot be cancelled either: its input may already be in the transcript,
so it is reconciled instead.

## The revision rule

The queue carries **one revision** that increments on every mutation — append, edit, reorder, remove,
clear, cancel, claim, release, submit and reconcile all raise it, and a legal no-op (clearing nothing,
moving an entry to the position it already holds) does not.

A caller sends back the revision it read. A stale one is a **conflict that writes nothing**: the
refusal names both revisions and the record is left exactly as it was, so a client can never overwrite
a change it did not see.

The revision is also the compare-and-swap. Each mutation is written as one control-store operation
keyed `queue.r<revision>` inside the session's own scope, and the store's
`UNIQUE(project_id, session_id, idempotency_key)` index decides which of two writers at the same
revision is the one that happened. The store reads the queue, plans the change purely, yields once so
the window between the read and the transaction is real, and only then writes — so two writers that
read the same revision genuinely race, and the loser is refused by the store's own transaction rather
than by a read-then-write check that both of them could have passed.

## Claims, leases and the effective head

A dispatcher claims the queue's **head** entry for a named owner. The head is the entry at the
smallest position among those still pending — waiting, claimed or submitted. Entries that are settled,
failed or cancelled are not part of the pending order, which is exactly why they can never be
dispatched.

**The effective head is enforced, not assumed.** An entry that is `claimed` or `submitted` *is* the
queue's effective head until it settles or is explicitly reconciled:

- at most one entry can be in flight at a time, and the strict record validation refuses a stored
  record that holds two of them;
- the in-flight entry must be the first pending entry, and the strict record validation refuses an
  order that puts a later pending entry ahead of it — so a **reorder** that would let later intent
  dispatch before earlier intent is refused, naming the in-flight entry that stands in the way;
- a claim always targets that entry, so a claim can never skip over a submission in flight.

The order is part of what a valid record *is*, exactly as positions are: a stored record that put a
later pending entry ahead of an entry in flight is refused when it is read (and a record with two
entries in flight is refused too) rather than being read and interpreted.

A claim records the owner, when it was taken, **one expiry**, and the **stable request identity** the
claim authorises. It carries no second liveness field, and that is deliberate: this build cannot
observe another process's liveness, so it does not pretend to.

- **The holder renews.** The same owner claiming the head again extends its lease and keeps the claim
  it already had. A dispatcher that needs longer than its lease renews before the lease expires.
- **A claim whose lease is live is never stolen.** Another owner's claim is refused with the holder's
  name and its lease expiry in the refusal, and the refusal says what it is based on: a live lease is
  the only liveness evidence this build has, so nothing here claims to know that the holder is alive.
- **A claim whose lease has expired is reclaimable.** The entry is handed to the next dispatcher as a
  new claim with the new owner and a new `claimedAt` — and with the *same* stable request identity,
  because that identity is derived from the entry id and is recorded with the claim. That is what
  makes a reclaim safe: a slow original owner and the dispatcher that took the entry over submit under
  one identity, so the transcript holds one submission, never two.
- **A submission needs a live claim.** Submitting requires the caller to hold the entry's claim and
  the lease to be unexpired; the queue never submits on an expired lease, because the entry may
  already belong to another dispatcher.
- **Releasing gives the entry back.** Only the claim's owner may release it, and a release drops the
  claim and leaves the entry `queued`. Nothing is dispatched and no submission is touched. A release
  is also how a claimed entry is withdrawn: a cancel is refused while an entry is claimed.

Claiming and releasing are the only operations that move an entry between dispatchers. Both are
serialised by the queue revision, so exactly one claimant wins a race.

### The honest limitation of the lease

The lease is the *whole* of this build's liveness evidence, and it is a lease rather than proof of
death. A claim whose lease has expired is reclaimable even if its owner is still running, so a
dispatcher whose submission outlives its lease can lose the claim. What makes that safe is the stable
request identity and the dispatcher's idempotency by identity, not the claim: whoever submits the
entry next names the same submission, so the outcome is one submission and one reconciliation — never
two submissions, and never a lost input. A build that could genuinely observe the owner (a process
identity compared against a real observation) could reclaim more precisely. This one cannot, so there
is no heartbeat field pretending otherwise.

## The stable request identity, and reconciliation

`queueRequestId(entryId)` derives the submission identity from the entry id alone — never from a
revision, a timestamp or a random value. Every attempt to submit one entry therefore names the *same*
submission, and the dispatcher's `submit` must be idempotent by request identity: a repeat returns the
submission that already exists instead of creating a second one. This is the property the durable
harness provides (Pi resolves a request id within its conversation and returns the original
submission).

The **claim records that identity**, in the same durable revision as the entry's own text and images,
so the intent and the identity that names its submission are both durable *before* any submission
starts. The strict validation refuses a stored claim whose recorded identity is not exactly
`queueRequestId(entry.id)`; a claim can therefore never name a second submission. That, and not the
claim's lease, is what makes every window reconcile to **one submission rather than two**:

| Interrupted | What is durable | What happens next |
|---|---|---|
| **before** the submission starts (after the claim) | the claim, the intent and the stable identity; the transcript holds nothing | the entry is still the head: the holder renews and submits under the same identity, or another dispatcher reclaims it after the lease and submits under the same identity. Either way the transcript ends up with one submission |
| **during** the submission, after the transcript wrote it | the claim, and the transcript's submission | the port does not return; the queue reads the transcript back and settles the entry on what it really holds |
| **after** the submission, before `submitted` is written | the same two | the same read-back, or `failed` / `submission-not-readable` where this instance has no read-back |

One further window is covered by the identity rather than by the queue's bookkeeping. If another writer
wins the revision while a submission is in flight — a release, for instance — then `submitted` is not
written and the winner's record stands. The entry is still there, and it still carries the identity its
submission was made under: submitting it again names that same submission, and reconciling it settles
the entry on what the transcript really holds. A submission is never left invisible — it is either
recorded, or reconcilable by an identity the entry still carries — and it is never made twice.

Submission happens in this order, and the order is the point:

1. the entry is claimed durably, with the intent and the stable request identity it authorises;
2. the dispatcher is asked whether this instance can dispatch at all — before anything is written;
3. the input is handed to the port under the stable request identity;
4. `submitted` is written, with the submission the port reported.

**Reconciliation** reads what the transcript holds for the entry's identity and decides. The same
read decides what a submission the port never reported back *was*, which is why the failure path
cannot record anything the transcript does not support:

| What the transcript answers | The entry becomes |
|---|---|
| it holds this entry's submission (the same identity, the same entry, and — when the queue recorded one — the same submission id) | `settled`, carrying that submission |
| it holds nothing under that identity | `failed` / `submission-absent` |
| it holds something under that identity that is not this entry's submission | `failed` / `submission-mismatched` |
| this instance cannot read the transcript back by request identity | `failed` / `submission-not-readable` |

Reconciliation only reads. It never re-sends, and it never overwrites what the transcript holds.

### What operator attention means, and what it does not claim

`failed` is this build's operator-attention state: a **named** condition an operator has to look at,
with one fixed, path-free sentence describing it. It is never a silent retry, and the queue's own
refusal to act is the safety property, not an accident.

**The queue never records that a dispatcher refused a submission.** A refused submission and one
interrupted around the transcript write are indistinguishable from the queue's side, so a state
asserting a refusal would assert something this code cannot know — and the crash case would falsify it.
What is recorded is what the durable record can be shown to hold, and nothing else:

- **`submission-absent`** — the transcript *was read back* and holds nothing under the identity, so
  nothing reached the transcript under it. That is what is known. Whether the input should be queued
  again is the operator's decision, not the queue's. The dispatcher's own error is returned to the
  caller but is **never stored**, because it may name a path.
- **`submission-mismatched`** — the transcript holds something under the identity that is not this
  entry's submission. The operator must inspect the transcript; the queue neither re-sends nor
  overwrites.
- **`submission-not-readable`** — this instance *cannot* read the transcript back by identity, so
  whether the entry was submitted cannot be established at all. This is the honest answer to both a
  refusal and an interrupted submission on such an instance, and it is a 200 with the outcome
  `attention`: the operation really did record the named state and really did send nothing.

So: where the transcript can be read, the answer is the transcript's own; where it cannot be read, the
state says so by name. There is no third thing, and no state that asserts a refusal.

A failed entry is not pending, so it can never be claimed again. It can be reconciled again (a later
match settles it, or the reason is refreshed), cancelled, or cleared.

### The honest limit of this build

The installed harness exposes **no read-back of a submission by request identity**, so the production
dispatcher port has no `lookup`. On this instance every one of those outcomes therefore reports
`submission-not-readable`: a reconciliation, and equally a submission the dispatcher did not report
back. The queue does not fill that gap with a guess — it does not record a refusal it cannot
establish, and it does not re-send. The matched → `settled` path is implemented in the store and
proven with an injected ledger port in the tests; wiring a read-back into the harness is follow-up
work, and until then the queue says so by name. Submitting itself is real: it goes through the
harness under the stable request identity, exactly as the lifecycle's `resume` and `retry` dispatch.

Two smaller limits are worth stating. The queue lives in the same single-writer control store as the
rest of the durable state, so concurrent means concurrent writers within one instance holding the
service lock. And the harness holds **one conversation per project** in this build, so a queue entry
dispatches to its project's conversation; the entry's session is what the queue is scoped to.

## The bounds

The queue is bounded, and every bound is refused by name rather than by a database error:

| Bound | Value |
|---|---|
| entries per queue | 50 |
| text per entry | 2000 characters of printable text |
| images per entry | 6 (the message bound) |
| one stored queue record | 65536 bytes (the control store's own payload cap) |

A record that would exceed the byte bound is refused before it is written, so the queue can never grow
past what the store can hold.

## The routes

Every route is behind the same owner-only authentication as the rest of the API, behind the unchanged
Host check, and the writes carry the same origin and CSRF enforcement. The session a route acts on is
the one in the path; `projectId` is a query parameter on the read and a body field on the writes.

| Route | Method | What it does |
|---|---|---|
| `/api/sessions/:id/queue` | GET | the queue with its revision, its entries and the bounds (`?projectId=` required) |
| `/api/sessions/:id/queue/append` | POST | `{projectId, revision, text?, images?}` |
| `/api/sessions/:id/queue/edit` | POST | `{projectId, revision, entryId, text}` |
| `/api/sessions/:id/queue/reorder` | POST | `{projectId, revision, entryId, position}` |
| `/api/sessions/:id/queue/remove` | POST | `{projectId, revision, entryId}` |
| `/api/sessions/:id/queue/clear` | POST | `{projectId, revision}` |
| `/api/sessions/:id/queue/cancel` | POST | `{projectId, revision, entryId}` |
| `/api/sessions/:id/queue/claim` | POST | `{projectId, owner}` |
| `/api/sessions/:id/queue/release` | POST | `{projectId, entryId, owner}` |
| `/api/sessions/:id/queue/submit` | POST | `{projectId, entryId, owner}` |
| `/api/sessions/:id/queue/reconcile` | POST | `{projectId, entryId}` |

A write answers with `{queue, entry, outcome, changed, removed}`: the queue as it now reads, the entry
it acted on (or `null`), the named outcome, whether it changed anything and how many entries left the
queue. The statuses are the ones every other durable surface uses:

| Refusal | Status |
|---|---|
| an unknown field, an entry with neither text nor an image, a position outside the queue, a value that is not of the documented kind | 422 |
| a session or entry the store does not hold | 404 |
| a stale revision, an illegal transition, a live claim that is not stolen, a queue at its documented bound | 409 |
| a dispatcher that cannot dispatch (the harness is off, the project is unregistered) | 503 |
| a storage or corruption fault | 500 |

Every refusal is path-free, and no route returns a stored path, a token or a conversation's text. A
`submission-not-readable` reconciliation is a **200**: the operation did what it should — it recorded
the named attention state and sent nothing — and the outcome says so.

The same operations are also declared in the typed action registry as `queue.read`, `queue.append`,
`queue.edit`, `queue.reorder`, `queue.remove`, `queue.clear`, `queue.cancel`, `queue.claim`,
`queue.release`, `queue.submit` and `queue.reconcile`, so they are reachable through the one command
surface; `docs/ACTIONS.md` lists them with their preconditions. The routes and the registry share the
same store methods, so the two surfaces cannot disagree about what an operation does.

## Tests

- `tests/server/queue.test.ts` — persistence across a close and reopen with the same order and
  revision; a stale revision refused with the record unchanged; unknown fields, empty entries,
  positions outside the queue and illegal transitions refused; two concurrent claims with exactly one
  winner and a live claim that is never stolen; a claim whose lease has expired reclaimed and one
  whose lease is live not; every crash window reconciling to exactly one submission without
  re-sending — before the submission starts (resumed or taken over under the same identity), during
  it, and after it, including on an instance with no read-back, where the entry becomes the named
  uncertain state instead; two attempts under one stable request identity collapsing to one
  submission; a cancel raced against a submission that is really in flight, which is refused and
  leaves the submission accounted for, and a release raced against one, which leaves the entry
  resubmittable under the same identity rather than invisible; a reorder that would move a later
  input ahead of an entry in flight refused, on the operation and on the stored record; a
  mismatched, absent or unreadable transcript becoming a named operator-attention state and never
  being re-sent; a cancelled entry never dispatching and a settled entry never being re-dispatched;
  and the documented bounds, in entries and in bytes.
- `tests/server/action-registry.test.ts` — every one of the eleven queue actions driven through the
  registry, its queue revision parameter declaring the read it comes from, and each of its
  preconditions driven by the refusal its handler really produces.
- `tests/server/http.test.ts` — the queue routes behind owner auth, the Host check and the origin
  check; the read with its revision and bounds; precise statuses for a stale revision, an unknown
  entry, a position outside the queue, an empty entry, an unknown field, an image the media store does
  not hold and a dispatcher that cannot dispatch; and the same operations through the registry.

The tests use disposable roots, a disposable control store and a **synthetic** dispatcher: no harness
is opened, no provider is contacted and no model call is made.
