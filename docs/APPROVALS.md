# Approvals and the delivery ledger

Two pieces of state with different jobs. An **approval** is an explicit, single-use,
target-bound authorisation for one consequential action. The **delivery ledger** is a receipt and
idempotency ledger for agent questions and answers. Neither one *performs* anything.

> **This milestone performs no commit, push, deploy, spend, provision or publish.** Consuming an
> approval records who or what consumed it and returns the exact target it authorised. The action
> itself still requires a separate, exact grant from its own component. The delivery ledger below
> does deliver, through the components that already exist: an agent question's owner notification
> goes out through the alert store and an answer reaches the agent through the harness, each as that
> ledger's own outbox step. Nothing here wires into the dispatch guard, backups, a new push
> transport or any deployment artefact.

## The approval model

An approval is a record with an id, a kind from a **closed set**, a scope, an exact target for that
kind, `issuedAt`, `expiresAt`, a random single-use nonce (32 bytes, lowercase hex) and a state of
`pending`, `consumed` or `revoked` (with `consumedAt`/`consumedBy`, or `revokedAt`). The closed
kind set is `commit`, `push`, `deploy`, `spend`, `provision`, `publish`; anything else fails closed
with the set named in the message.

**The nonce is not a credential.** It makes each stored record unique and cheap to compare; it
authorises nothing on its own, no route accepts it as proof and nothing should start treating it as
one. It is returned by the create response and by reading one record by its exact id; the listing
deliberately omits it. Turning it into a credential would be a new authorisation mechanism and needs
its own review.

### Target binding per kind

Every field is required, the object is strict (an unknown field is refused) and the target is
bounded (4096 bytes), so a grant cannot be widened by adding detail the approval does not name.

| Kind | Exact target identity |
|---|---|
| `commit` | `repository`, `branch`, `treeDigest` (64 hex) |
| `push` | `remote`, `branch`, `commitSha` (40 hex) |
| `deploy` | `endpoint`, `releaseId` |
| `spend` | `amountMinor` (positive integer), `currency` (three uppercase letters) |
| `provision` | `resource`, `region` |
| `publish` | `channel`, `artifact` |

### Scope

A scope names **at least one** of `projectId`, `sessionId`, `operation`; an unscoped approval and an
unscoped query do not exist. Every read, consumption, revocation and listing must name the
approval's scope **exactly** — not an intersecting or wider one. An approval scoped to a project is
not reachable through a session-only query, and a foreign-scope read is refused with
`outside the requested scope` rather than being silently skipped or treated as a wildcard.

### Validation is strict and frozen

`src/shared/approvals.ts` is a pure model and the only validator. A create request is refused
when it has an unknown field, an unknown kind, a missing or unknown target field for its kind, a
scope that names no dimension, an `expiresAt` that is not strictly in the future, an `expiresAt`
that is not an ISO instant, or a lifetime longer than the documented maximum of **60 minutes**.
Nothing is written when it fails. A definition read back from storage that does not validate is
refused as corruption (`STORAGE`), never interpreted.

### Single use, expiry and revocation

- **Single use.** Consuming requires an exact match of kind, scope and every target field; the
  kind must match before the target is compared, and a mismatch names the differing fields. The
  write is the control store's own checked transaction (`BEGIN IMMEDIATE` plus an expected-revision
  predicate), so a second consumption — in this process, in another process, or after a crash and
  reopen — is refused with `already consumed`, and a race between the check and the write cannot
  leave a consumable approval behind.
- **Expiry.** An approval expires at `expiresAt`. An expired record is still readable by id, is not
  listed as pending (it can never be consumed) and is refused with `expired`; it may still be
  revoked as the operator's cleanup.
- **Revocation.** Revoking a pending approval moves it to `revoked` and it can never be consumed.
  Revoking an already revoked record returns it unchanged. A **consumed** approval cannot be
  revoked, because the action it authorised may already have happened.
- **Ordering.** A revoke or a second consume against a record that changed underneath is refused
  as a conflict, with wording that names only what that write can claim: a consume says the approval
  is not consumable again, while a revocation says only that the revocation wrote nothing. Nothing is
  overwritten and no partial state is left.

### Where it is stored

An approval is one control-store operation. Its immutable definition is the operation input, its
lifecycle is the operation state and receipt: `pending` is the operation's `pending`, `consumed` is
`succeeded` with the consumption receipt, `revoked` is `failed` with the revocation receipt. The
lifecycle outbox row of an approval stays pending for the life of the record: it marks the record,
it is not a delivery obligation. **No new table, no new file and no second persistence mechanism
is introduced**; every write goes through `ControlStore.admit` and `ControlStore.updateOperation`.

### Routes

All of them are owner-only, behind the same authentication, session CSRF, origin and Host checks as
every other route, and consuming returns the exact target without performing anything.

| Route | Purpose |
|---|---|
| `POST /api/approvals` | Create. Body: `{kind, scope, target, expiresAt}`. `201` with `{approval}`. |
| `GET /api/approvals?<scope dimension>=…` | List the pending, unexpired approvals in that exact scope, each without its nonce. `{approvals}`. |
| `GET /api/approvals/:id?<scope dimension>=…` | Read one. `{approval}`. |
| `POST /api/approvals/:id/consume` | Body: `{scope, kind, target, consumedBy}`. Returns `{approval, target}`. |
| `POST /api/approvals/:id/revoke` | Body: `{scope, revokedBy, reason?}`. Returns `{approval}`. |

Statuses: `400` for a malformed request body or an unknown field in one (the strict parse refuses it
before the approval model is reached), `422` for an invalid approval model — an unknown kind, a
missing or unknown target field for that kind, an expiry that is not strictly in the future, a
lifetime beyond the documented maximum, or a query that names no scope — `403` for a foreign scope,
`404` for an unknown id, `409` for every lifecycle refusal (expired, revoked, already consumed,
wrong kind, wrong target, raced write), `500` for a storage fault, `503` when no control store is
open — approvals are never guessed at. The precise reason is in the JSON `error` field in every
case.

## The delivery ledger

`src/server/state/delivery.ts` turns agent questions and answers into durable operations with
idempotency keys, so a crash mid-delivery reconciles instead of duplicating or losing work.

- **It is a receipt and idempotency ledger, not the source of truth for question text.** The
  transcript in the agent session stays canonical. The ledger keeps a copy of the text only so that
  re-admitting the same question with different content is a conflict instead of a silent
  overwrite, and **no owner-visible report or view returns that text**.
- **The one bounded exception is internal, and it is a correctness requirement.** An answer the
  ledger recorded but the transcript never received is answerable by nobody else: the recorded text
  is the only copy of what the human decided. `recordedAnswer(scope, questionId)` therefore returns
  that text to the reconciliation path alone, so a start can finish the record the ledger already
  committed to. It is not a route, not part of `deliveries()`, not in the reconciliation report, not
  in the `Delivery reconciliation:` line and not in any agent view, and it is never logged.
  **The ledger cannot expose answer text publicly**, and that is a deliberate limit rather than an
  omission: the transcript is canonical and its edits are revision-checked, while the ledger's copy is
  a receipt record that nothing reconciles against a document — publishing it would create a second,
  unversioned source of truth for what a human decided, and an interface rendering it could present an
  answer the agent never received as though it had been delivered. The internal exposure carries no
  authority of its own: it is only ever turned into the transcript write and the submission the ledger
  had already committed to, under the same question-derived request id, and it never causes a second
  answer record or a second submission.
- **Admission.** `admitQuestion` derives its idempotency key from the question id
  (`question.` followed by 48 hex characters of `sha256('question' + newline + questionId)`), so re-admitting the same question returns
  the existing operation unchanged and creates no second outbox row, while a different body under
  that key is refused as a conflict.
- **Answers.** `answerQuestion` records at most one answer per question. An answer's identity is
  its **text**, not its whole body: the harness stamps every request with a fresh `answeredAt`, so a
  retry of the same answer reconciles even though its instant differs. Comparing whole bodies would
  refuse the very retry that recovers a crash between the answer record and the transcript write, and
  would leave the question permanently unanswerable with the human's answer stranded. A different text
  is refused as `already has an answer` and changes nothing. A question that was never admitted in
  that project/session scope is refused as unknown — which is what makes a foreign-scope answer
  impossible.
- **Delivery.** `markDelivered(questionId, receipt)` acknowledges the outbox exactly once. An
  identical receipt reconciles (including completing an operation the crash left pending); a
  conflicting receipt is rejected and changes neither linked record.
  `completeAcknowledgement(questionId)` finishes a delivery whose outbox a crash already
  acknowledged, by repeating `markDelivered` with the evidence the outbox itself carries, so nothing
  is re-sent and nothing is invented.
- **The running application writes it, so the ledger has real rows.** A question the harness surfaces
  is admitted before its owner notification is sent; that notification *is* the delivery's outbox
  step, tagged by the question id (`pilot-question-<questionId>`) and acknowledged with the receipt
  the alert store itself reported (`{sent, failed, skipped}`). An answer is recorded before anything reaches the agent: a refusal by
  the ledger refuses the whole answer, so an answer can never be delivered with no durable record,
  and its outbox step is the agent receiving it, acknowledged with the submission evidence. Both
  idempotency keys are derived from the question, so a retry or a crash cannot record twice.
- **A notification that reached no device is not a delivery.** Two receipts mean that: the channel
  deliberately sent nothing (no device subscribed, or a repeat inside the alert cooldown), or it had
  devices and **every send failed** — `skipped: false` with `sent: 0` — because only a receipt that
  reports at least one send is evidence of delivery. In both cases the outbox stays outstanding and
  the next start re-sends it.
- **What the question tag does and does not guarantee across a crash.** Re-sending a notification is
  safe in the sense that it is not a duplicate *effect* the server enforces away. The push message
  carries the tag `pilot-question-<questionId>`, and Web Push's `tag` collapses a repeated
  notification onto the previous one **only because the client honours it**: the server keeps no
  durable record of what a device displayed, so a client that ignores the tag may show the same
  question twice. The alert store's own cooldown is an **in-memory** map and is lost when the process
  restarts, so the start-time re-send of an outstanding row is exactly the case the cooldown cannot
  cover. This is a presentation-level limit only: nothing on the agent side is delivered twice,
  because the request id derived from the question is what a repeat finds.
- **The owner can see it.** The authenticated agent view of a project carries `delivery`: this
  project's and session's question and answer rows, each with both states, the receipt its channel
  reported and when it was acknowledged. It returns no question or answer text, no path and no
  secret. The transcript stays canonical; the ledger is never a second copy of the conversation.

### Reconciliation, and no blind replay

`reconcileOnStartup()` is read-only: two SELECT passes over the ledger's operations and outbox
rows, no write at all (the database and its `-wal` sidecar are left byte-identical), and a frozen,
deterministic report — two consecutive calls over unchanged storage are deep-equal. It replays
nothing itself. A **start** acts on that report, and only on what it licenses:

- Before any idempotent re-send is claimed, the stored payload is validated against the delivery
  (`kind`, `delivery`, `questionId`, `tag` and `requestId` all have to agree). A payload that no
  longer matches would repeat a *different* effect under this row's receipt, so it is reported, not
  replayed.
- A question delivery marked idempotent is re-sent as one notification under its question-derived
  tag, and acknowledged with the receipt the channel reported. A channel that sent nothing leaves the
  row outstanding for the next start.
- An answer delivery marked idempotent is re-delivered to the agent through the live harness. The
  answer is read back from the canonical transcript whenever it is there. When it is not — the crash
  window between the answer record and the transcript write — the ledger **finishes its own record**
  using the text `recordedAnswer` exposes internally: the transcript entry is written under the
  request id `answer:<questionId>` and the submission is then made from that same text under
  `answer-input:<questionId>`, so a repeat finds the original entry and the original submission
  instead of adding either. The row is then acknowledged with the same `{submissionId, requestId}`
  receipt shape the live answer path acknowledges with, so the two paths cannot disagree about what
  was delivered. A question this transcript does not hold at all is still reported for an operator:
  the ledger does not answer a question the conversation never asked.
- An acknowledgement a crash half-wrote is completed from the evidence the outbox already carries,
  and nothing is re-sent.
- Everything else — an uncertain row, a payload that does not match, a re-send that fails or cannot
  be performed because this instance has no agents — is reported for an operator.

Each entry is one of:

| Disposition | Meaning |
|---|---|
| `redeliver-idempotent` | A pending operation with an undelivered outbox on a channel that can be re-sent without a second effect: the delivery is **tagged by question id** (a push client that honours the tag collapses the repeat onto the same notification; an answer's request id is derived from the question, which the harness itself enforces), **and** its stored payload still matches the delivery exactly. Marked `redeliver: true` with the idempotency marker. |
| `complete-acknowledgement` | The outbox is acknowledged with matching evidence and only the operation state is missing: repeating `markDelivered` completes it **without re-sending anything**. |
| `needs-operator-attention` | Anything whose effect is uncertain — an operation that ended `interrupted`/`unknown`/`failed`, a delivered outbox without matching receipt evidence, an undelivered outbox whose operation is not pending, a row the store cannot read, a payload that no longer matches its own delivery, or a channel with no idempotency marker. Reported, never replayed. |

Every entry carries the operation id, kind, question id, scope, both states, the disposition, an
explicit `redeliver` flag and the reason; nothing in the report is question or answer text, a
filesystem path or a secret. A start logs one `Delivery reconciliation:` line — a deterministic
summary of the report's counts, the actions it took (`redelivered`, `completed`, `outstanding`,
`needsOperatorAttention`) and the attention entries with their reasons — only when there is an entry
to report; a fresh root logs nothing. A failure to reconcile is reported on stderr and does not stop
the process from serving.

## What this does not do

- No commit, push, deploy, spend, provision or publish is performed, wired or scheduled, and no
  delivery *is* one of those: a question notification and an agent submission are the only effects.
- No dispatch-guard admission is wired to approvals, and an approval is not an agent tool.
- No coding or test recipe is executed, no backup is created, Web Push payloads are unchanged, and
  no compose, Dockerfile, tunnel or DNS file is touched.
- No server-side notification de-duplication. A question notification re-sent after a crash is
  collapsed by the push client's own tag handling, not by this server, and the alert store's cooldown
  does not survive a restart.
- Nothing here is a grant to run any of the above; those actions still need their own explicit
  approval plus a separate exact grant.
