# Attention: questions, approvals, failures and interruptions

One surface for the four things that need a person. It is a **read-only projection** of records that
already exist, plus explicit actions that change them through the routes that already own those
changes. Looking at the surface never resolves anything, never opens an agent harness and never
sends a model request.

The pure model is `src/shared/attention.ts`, the server projection is
`src/server/state/attention.ts`, the transcript reader is
`src/server/state/transcript-questions.ts`, the routes are in `src/server/main.ts`, and the interface
is `src/client/AttentionPanel.svelte`.

## The four kinds, and nothing else

| Kind | Source of truth | Open while | Exact identity |
|---|---|---|---|
| `question` | the project's canonical transcript (`app.question`, `app.answer`, `app.question.dismissed`) | no answer and no dismissal | `question:<questionId>` |
| `approval` | the durable approval operation | `pending` and not expired, and its own scope names this project or one of its named sessions | `approval:<approvalId>` |
| `failure` | the latest durable session lifecycle record | `failed` | `failure:<sessionId>` |
| `interrupted` | the latest durable session lifecycle record | `interrupted` | `interrupted:<sessionId>` |

A routine message, a finished run, a `running` session and a `paused` session are not attention
items. A paused run is an owner choice; it is not waiting to be rescued.

## Ordering, paging and the exact count

Ordering is total and deterministic: **severity** first — interrupted, failure, approval, question —
then **age** (older first), then the stable item id. The id is the final tie-break, so two items with
the same severity and instant cannot swap places between pages.

The cursor is a keyset, not an index: it encodes the severity, the instant and the id of the last
item shown. A later page lists every item **strictly after** that key. If the item that produced the
cursor is answered, consumed or otherwise resolved in the meantime, the next page still starts in
the right place, with no duplicate and no skip. A cursor this build cannot read is refused with
`422`; it is never treated as page one.

The list is conservative and provisional:

- **20 items per page** by default (a caller may ask for 1–100).
- **At most 100 open items listed** in one pass. Once 100 have been listed, `hasMore` is false even
  when more exist. The message says "at most 100 open items are listed in this pass", not that 100
  are visible: a single page still holds 20 unless the caller asks for more.
- The **open count** comes from its own query over every open item and is reported even when it is
  above the cap. It carries `complete`: `false` means at least one source was unavailable, so the
  number is a floor, not an exact total. The badge shows `count incomplete` and never an exact zero
  in that state.

`limits.policy` is `proposed` in every response. These limits are a proposed operator policy, not an
accepted one; changing them is an owner decision, not a code change hidden in a response.

### Query cost

Each list request builds the projection once: one read-only transcript read for the project, one
read-only pass over the approval operations, and one read-only pass over the lifecycle rows. Paging
rebuilds it from the durable records; there is no snapshot cache, so a status change appears on the
next page or refresh and no stale page can hide it. The panel uses the count that its list response
already carries, so opening the panel is one projection. The separate count route exists for the
badge and for callers that need no items.

A session-only approval adds one **registry lookup** of its owners. That lookup scans the control
store's operations by session id: the unique index begins with the project id, so the lookup is a
read-only scan, not an indexed point read. The transcript query returns only the entry kinds the
surface uses, but SQLite still scans the conversation's entries to find them; the `head` lookup per
conversation uses the head index. These are full read-only passes over the durable records, not a
new index, cache or authority. Their cost grows with the transcript and with the control-store
operations, and no result is cached across requests.

## Authority, and why no harness is opened

- **Questions** are read from the project's durable SQLite transcript with a **read-only** handle.
  Opening an agent harness resumes unfinished work, which is itself a model request; the attention
  read therefore never calls the harness. When no `-wal` sidecar exists it opens with SQLite's
  `immutable=1` URI, so the read creates no `-shm`/`-wal` files and cannot checkpoint. When a writer
  is live, the ordinary read-only handle sees its committed frames.
- **Questions follow the active transcript, not the whole history.** Durable records a `head` column
  on an entry as the first entry of the active context that entry selects. The newest such marker in
  a conversation bounds the active range; entries older than that bound are hidden history and are
  not listed. A conversation with no marker has every entry active. An entry with no `askedAt` has
  `at: null`: the interface says `age unknown` and sorts it after every recorded instant, then by id.
  It is never given the epoch as an age.
- **Approvals** are read from the durable control store through one read-only pass. A record scoped
  to another project is not reachable here, even by id.
  - A **project scope is authoritative** when it is present: a record naming another project is not
    listed, even if it also names a session this project has.
  - A **session-only scope** is attributed only when the registry proves exactly one project owns
    that session id and it is this project. The legacy root session id `1` exists in every project,
    so it proves nothing: such an approval is not attributed to any project. Zero or two owners are
    refused, never guessed. A registry read that fails also refuses the attribution and marks the
    approval source unavailable, so the count is incomplete.
  - An approval whose scope names neither a project nor a session cannot be attributed to a project
    and is not guessed into one. No target is copied into another project's response.
- **Failures and interruptions** are the latest lifecycle record per session in this project. The
  projection reads the same rows the lifecycle routes do; it does not infer state from a running
  process.
- **The queue is not an authority here.** No queued input, inbox item or client request becomes an
  attention item, and reading this surface cannot submit, claim or resume anything.

## Sensitive fields

The surface is owner-only, behind the same authentication, CSRF, origin and Host checks as every
other route. Question text is shown to the authenticated owner, as the answer UI already does.
Approval items carry the kind, the **full exact target**, the scope and the expiry — the same target a
consumption must match — but **never the single-use nonce**. No item returns a filesystem path, a
token or a secret, and nothing here is logged with those values.

Push notifications carry a title, one bounded line of context and a link. They never carry an
approval target, a path or a token. Keeping the approval nonce out of the listing is unchanged.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/projects/:id/attention?limit=&cursor=` | One page, plus the exact count, the page state and the source states. |
| `GET /api/projects/:id/attention/count` | The exact open count and per-kind counts, for the badge. |

Both are `GET` only; any other method is `405`. Statuses: `404` for an unknown project, `422` for an
unreadable cursor or a limit outside 1–100. A source that cannot be read is reported as
`unavailable` in `sources` and contributes no items; the request still succeeds, because the readable
kinds are still useful and the unreadable one is named rather than treated as empty.

## Actions

Every action is an explicit owner action through the route that already owns the change. Nothing is
automatic, and no action is taken by viewing or refreshing.

| Kind | Action | What it does |
|---|---|---|
| question | Open question | Selects the exact session and scrolls to the question in the existing answer UI. Answering and dismissing with a reason are unchanged. |
| approval | Review target… | Shows the kind, the exact target field by field, the scope, the expiry and the state. Consumption is a second, explicit step. |
| approval | Consume grant | Calls the existing approval consume route. It records who consumed the grant and returns the exact target; **it performs no commit, push, deploy, spend, provision or publish**. A consumed, revoked or expired approval is refused with the reason. |
| approval | Revoke | Revokes a pending approval; it can never be consumed. |
| failure | Retry | Calls the lifecycle `retry` route with the revision the item showed. An already-changed revision is a visible refusal; nothing is written. |
| interrupted, certain | Resume | Calls the lifecycle `resume` route under the original request identity. If that identity is still pending, the resume continues it. If it is already terminal, the response is `outcome: "terminal"` with `dispatched: false`: no new work starts, the lifecycle settles, and nothing is replayed. |
| interrupted, uncertain | — | No replay is offered. The item names the operator-attention case, and the `resume` route refuses it if called directly. |

Only `resume` and `retry` can cause a model dispatch, exactly as the lifecycle already specifies:
`resume` only while the original identity is pending, and `retry` only as an explicit new attempt
for a failed session. A terminal resume dispatches nothing. Reading, paging, opening an item and
reviewing an approval dispatch nothing.

## Push deep links

A question notification links to the project, the exact session and the exact item
(`&attention=question:<id>`). An agents failure notification links to the exact session and
`&attention=failure:<session>`; a finished-run notification keeps its project and session link but
names no attention item. The address value is validated before use and is never echoed into the
interface. A question item scrolls to its question; another kind opens the attention layer with that
item focused. If the item is no longer present, the panel says so instead of showing an empty page.

## The phone, and history

The surface is the existing `Needs me` layer. Opening it pushes one history entry, Back closes it,
and closing it in the app keeps the app. Opening a question selects the exact session as a route
change. The panel stays in the application bar, scrolls inside the viewport, keeps its last control
above the home indicator and adds the safe-area inset. Loading, an unreadable source, an empty list
and a capped list each have their own visible state. Refreshing or acting never changes the project,
the view or the session unless the person chose a question.

A **project change** rebuilds the panel for the new project and clears the previous project's items,
page, count, sources, approval review and missing-item notice at once. Each panel instance also
carries a request generation: a delayed list, paging or action response from the previous project is
discarded, so no old target and no old consume action can appear under the new project. An alert
switch is covered by the same rule.

## Per-conversation question state, and forks

Question state is **per conversation**. The reader maps a conversation to the session id in the
durable conversation binding, or to the numeric conversation id when no binding exists. A fork's
child transcript is a separate conversation with its own questions and answers. The surface does not
walk a fork tree, merge a parent's questions into a child, or claim that a child's question belongs
to the parent. A child question is listed under the child's session only when the child's binding
exists; otherwise it is listed under the numeric conversation id, and a person who follows it lands
in that conversation rather than in the parent's. A head marker in a conversation also hides that
conversation's earlier questions and answers, because Durable no longer considers them active.

## What this does not do

- It does not mark a question answered because it was seen, an approval consumed because it was
  opened, or a run resolved because it was listed. Only the durable decision changes the record.
- It does not introduce a second inbox with its own counts: the count is a query over the same
  durable records the list reads.
- It does not read the agent SQLite schema as an API with a future guarantee. A build that cannot
  read the transcript reports `sources.questions: unavailable` and `count.complete: false`; it does
  not guess and does not present an unreadable project as having no questions.
- It does not apply context edits when it reads question entries. The harness writes questions,
  answers and dismissals as their own entries and edits none of them; an edit that hid one would be
  a new durable semantic and would need its own audit.
- It does not list an approval that cannot be attributed to the requested project, and it does not
  widen an approval's scope to make it visible.
- Consumed, revoked and expired approvals are not open items, so they are not listed. A record that
  expires between two loads leaves the list; it stays readable by its exact id through the approvals
  route and can still be revoked there. The review panel names the state when an action changes it.
