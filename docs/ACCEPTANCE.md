# Completion records and acceptance

A unit of work is not "done" because someone said so. It is done when there is a **completion
record** — what was produced, from which revision, by which commands, with which real test counts —
and, where something consequential follows from it, an **acceptance** of that exact artifact by an
identity the policy permits.

The model lives in `src/shared/acceptance.ts` (pure: the closed sets, the strict validation and the
honesty rules) and the durable half in `src/server/state/acceptance-store.ts`. The actions are
`acceptance.read`, `acceptance.evidence.record`, `acceptance.accept` and
`acceptance.policy.update`; the owner-only routes are in `docs/ACTIONS.md`. Every record is one
operation in the durable control store, so this introduces **no new persistence**, and the Markdown
record is written inside the project's own tree.

Nothing here commits, pushes, deploys, spends, provisions or publishes. An acceptance records a
decision about an artifact; performing anything with it stays a separate, explicit step.

## The completion record

One record is one operation and its input is the frozen record itself. It is validated strictly,
written once, and has **no update path**.

| Field | Meaning |
|---|---|
| `id` | `ev-<sha256>`: derived from the canonical request, so it is the record's content, not a random label |
| `projectId`, `sessionId` | the project it belongs to, and the named session when it has one |
| `subject` | the unit of work: `{ kind: "job" \| "session", id }` |
| `artifact` | the exact identity it was produced from: `{ revision, commit }`, where `commit` is a 40-hex SHA or `null` (not committed) |
| `commands` | the commands that were run: 1-50 entries, each 1-500 printable characters |
| `diff` | the summary — `files`, `linesAdded`, `linesRemoved` — plus the full diff **inlined** (inside 16384 bytes) or **by reference** |
| `tests` | one entry per command actually run: the command, the outcome, the recorded output and the counts read from it, or a named absence |
| `review` | the review verdict when one exists: `approved`, `changes-requested` or `blocked`, by an owner or an agent, with an instant and an optional note |
| `producedAt` | when the evidence was produced. It must not be in the future; it is the caller's fact about the work, not the store's write time |
| `frozen` | always `true`: the record is written once |

The identity and the idempotency key are derived from the canonical form of the request, so:

- recording the **same** evidence twice is the **same** record (one durable row), and that call
  rewrites its Markdown — which is how a file a crash never wrote is repaired;
- a **changed** revision is a **different** record. Evidence is bound to the revision it was produced
  from, so a new revision needs new evidence before it can be accepted.

## Honesty rules

The counts a record carries are **read from the recorded output**, never taken on trust.

- A **count line** is a line whose whole content is a marker (`#` for TAP, the `ℹ` this repository's
  own test runner prints) followed by `tests`, `pass`, `fail`/`failures` or `skip`/`skipped` and a
  whole number. Nothing else is a count line, so prose or a log line cannot be read as a result.
- If the caller **claims** counts, they are checked against those lines. A claim that contradicts the
  recorded output is **refused**, naming both numbers; a claim with no output, or with an output that
  carries no count line, is **refused** too — the honest alternative is to claim nothing.
- If a record's output carries no readable count, the record stores a **named absence**
  (`command-output-not-recorded`, `command-output-carries-no-count-lines` or `command-not-run`) and
  writes it into the Markdown. A missing count is never reported as `0`.
- An output that contradicts itself (a `# tests` line smaller than the counters it summarises) is
  refused rather than one number being picked.
- **The outcome is reconciled with the counts the same output carries.** A record that says `passed`
  while its own output reports a failure, or `failed` while its own output reports none, is refused:
  a record never states a result its own evidence contradicts.
- A **`not-run`** command asserts no result at all, so it stores the named absence `command-not-run`
  instead of whatever counts any output recorded beside it happens to carry. Output is not this
  record's result when the record says the command did not run.
- Every result must name a command the record says was run, and no result may claim a pass or fail
  count for a command it also says was **not run**.
- The diff must be complete: a summary *and* the full diff — inlined inside the bound, or referenced
  by a contained relative reference. A diff that is neither, or an inlined diff over the bound, is
  refused. A **large** diff is referenced, never inlined.
- A stored record that does not validate is **corrupt**, and is refused as corruption rather than
  interpreted into something plausible.

## The Markdown evidence format

The durable record is rendered to Markdown inside the project's own tree, through the same contained
path helper and atomic write every other repository write uses:

```
<project root>/docs/acceptance/<record id>.md
```

It is **deterministic**: the same record always renders to the same bytes. That is what lets a reader
tell a file the store wrote from a hand-edited one. The write **claims nothing about itself**: it
re-reads the file it just wrote through the same derivation every read uses, so a recording answers
`written: true` only when the file really renders the record, and a render that fails after a
decision is already durable is reported as that file's own state rather than as a refusal that
contradicts the decision. The file carries:

- a header table: project, session, the work it belongs to, the artifact revision, the commit (or "not
  committed"), `producedAt` and the frozen note;
- **Commands run** — the recorded command list;
- **Diff** — files, lines `+n / -m`, and either the inlined full diff in a fenced block or the
  reference it lives at;
- **Test evidence** — per command: the outcome, the counts read from its own output, and the recorded
  output itself in a fenced block (or "Recorded output: none"), or the named absence;
- **Review** — the verdict, who gave it and the note, or that none is recorded;
- **Acceptance** — the accepted artifact, who or what accepted it and when, the action class, the
  policy revision, mode and class decision, and the rule that permitted it.

The fence length is chosen longer than any run of backticks inside the block, so a diff or an output
cannot break the file. The block above is a rendering, not a second source of truth: **the control
store is authoritative**, and every read reports the state of the file instead of trusting it:

| `markdown.state` | Meaning |
|---|---|
| `current` | the file on disk renders exactly the durable record |
| `stale` | the file differs from the rendering: it was edited by hand, and the record is unchanged |
| `missing` | the file is not there |
| `unreadable` | the file exists but cannot be read, or the project's root could not be resolved |

Because the durable record cannot be modified through any API, a hand edit can never change what was
accepted — it can only make the repository copy wrong, which is reported as `stale`.

## The acceptance policy

One policy per instance, stored durably as one operation per revision, under a bucket that names no
project. The written policy and the default are the same shape, so a client never reads a special case.

| Field | Meaning |
|---|---|
| `mode` | the closed set `owner-only` \| `agent-may-accept` |
| `actionClasses` | one decision per action class — `commit`, `push`, `deploy`, `spend`, `provision`, `publish` — each `ask` or `full-auto` |
| `revision` | the compare-and-swap: a write names the revision it read, and a stale one is a conflict |
| `recorded` | `false` exactly when no policy row exists yet |
| `updatedAt`, `updatedBy` | when it was written, and by which owner identity |

**The documented default is `owner-only` with every class set to `ask`.** It is the safe direction:
an instance that has never been configured cannot let an agent accept anything. An unwritten policy
reads as that default with `revision: 0`, `recorded: false` and a named absence
(`no-policy-recorded-yet`) — an absence reported as an absence, never as a stored fact.

The policy is **changeable only by the owner**. An agent identity is refused
(`POLICY_OWNER_ONLY`, 403): the policy that decides what an agent may accept is not something an
agent may set. Changes are revision-checked, so two writers at one revision race and the loser writes
nothing.

## Who may accept, and under what rule

| Actor | `owner-only` | `agent-may-accept` + class `ask` | `agent-may-accept` + class `full-auto` |
|---|---|---|---|
| the owner | accepted | accepted | accepted |
| an agent | **refused** (`ACCEPTOR_PERMITTED`) | **refused** (`ACTION_CLASS_DECIDED`) | accepted, recording `agent-may-accept:<class>=full-auto` |

The decision is a pure function of the policy, the actor and the action class
(`decideAcceptance`), so the same three inputs always decide the same way — and an acceptance
records **why** it was allowed: the policy revision, its mode, the class decision that applied, and,
for an agent, the rule `agent-may-accept:<class>=full-auto`. An owner acceptance records no rule,
because an owner decision needs none.

## Single use and revision binding

An acceptance is one operation keyed by the evidence it accepts, which is what makes it single use:

- the **artifact is bound**: the request names the exact `revision` (and `commit`) it accepts, and it
  must be the one the evidence was produced from. An artifact that has changed since the evidence was
  produced is **refused** (`ARTIFACT_CHANGED`, 409) and needs new evidence.
- the **acceptance is single use**: a second acceptance of the same record — in this process, from
  another handle over the same database, or after a crash and reopen — is **refused**
  (`ALREADY_ACCEPTED`, 409), naming the acceptance and the identity that already holds it. The
  durable store's unique index is the compare-and-swap, so a race between two acceptors has exactly
  one winner.

Accepting a *new* revision means recording new evidence for it and accepting that. There is no path
that moves an acceptance onto a different artifact.

## The operator flow

**Declaring the accepting identity.** A caller may declare who is accepting: either beside the request
(`{ projectId, request: { … }, actor }`) or **inside** it
(`{ projectId, request: { evidenceId, artifact, actionClass, actor } }`), which is the shape the
registry publishes for `acceptance.accept` and the shape the palette sends. Both are honoured, and
what is declared is what the record carries — the route never substitutes an identity for a declared
one. A body that declares **both** and gives them different values is refused `422` rather than one of
them being silently used, because which identity accepted must never be ambiguous. A body that declares
no actor at all is the authenticated owner, and only then.

**Ask mode (the default; `owner-only`, every class `ask`).** Nothing an agent can do leads to an
acceptance on its own.

1. An agent (or a script) records the evidence for the unit of work:
   `POST /api/acceptance/evidence` with `{ projectId, evidence }` — the work, the artifact, the
   commands, the diff and the test evidence. It answers `201` with the record, its Markdown path and
   `markdown.state: "current"`.
2. The owner reads it: `GET /api/acceptance?projectId=<id>` (or the file in
   `docs/acceptance/<record id>.md`, or `acceptance.read` from the palette).
3. The owner accepts: `POST /api/acceptance/accept` with `{ projectId, request: { evidenceId, artifact,
   actionClass } }` and no `actor` anywhere — so the accepting identity is the authenticated owner. An
   agent acceptance attempted here is refused `403` with the reason.
4. The Markdown record now carries the acceptance section.

**Full-auto mode (a deliberate owner decision).**

1. The owner sets the policy:
   `POST /api/acceptance/policy` with
   `{ "revision": 0, "policy": { "mode": "agent-may-accept", "actionClasses": { "commit": "full-auto", "push": "ask", "deploy": "ask", "spend": "ask", "provision": "ask", "publish": "ask" } } }`.
   Only the classes the owner really wants decided without them are set to `full-auto`; the rest stay
   `ask`, and those classes still need the owner.
2. The worker records the evidence, then accepts it, naming itself:
   `POST /api/acceptance/accept` with `{ projectId, request: { evidenceId, artifact, actionClass:
   "commit" }, actor: { kind: "agent", identity: "<worker>" } }`. The acceptance recorded carries
   `acceptedBy.policyRule = "agent-may-accept:commit=full-auto"` and the policy revision it was
   decided under.
3. Through the command registry the same steps are `acceptance.evidence.record`, `acceptance.read`,
   `acceptance.accept` and `acceptance.policy.update` — the registry validates the published schema,
   enforces the declared scope, and the handler's own refusal keeps the status it has on the routes
   (422 invalid, 404 not found, 403 not permitted, 409 conflict) with a path-free message.

## Statuses

| Refusal | Status | `code` |
|---|---|---|
| a malformed request, a claim that contradicts its own output, an outcome that contradicts the counts its own output carries, a not-run result stored as counts, a diff with no full diff, two actors declared that disagree | 422 | `INVALID` |
| an unknown completion record, an unresolvable project root | 404 | `NOT_FOUND` |
| an identity the policy does not permit (owner-only, or a class set to `ask`) | 403 | `NOT_PERMITTED` |
| a stale policy revision, a second acceptance, an artifact that has changed | 409 | `CONFLICT`, `ALREADY_ACCEPTED`, `ARTIFACT_CHANGED` |
| a storage fault, or a stored record that does not validate | 500 | `STORAGE`, `CORRUPT` |
| no durable control store open on this instance | 503 | (`UNAVAILABLE`, from the registry) |

Every message is path-free and names the field, the record or the reason — never a filesystem path and
never a secret.

## What this does not prove

- **An agent identity is declared, not authenticated.** The HTTP surface is owner-authenticated (local
  token or the hosted owner's Access assertion); an agent acceptance is a *declared* identity on a
  request only the owner's credential can make. The policy is therefore an acceptance-control rule
  over a decision procedure — it decides who may accept, and records why — and **not** a separate
  agent credential. There is no agent token in this build, and this file does not claim one.
- **The artifact identity is not re-read from git.** Acceptance is bound to the revision the evidence
  itself recorded; this build has no Git plumbing that would re-read the live tree or the live commit.
  A caller with such a source can enforce the stronger check at the point where it produces the
  evidence.
- **A job subject is not resolved against the runner.** `subject: { kind: "job", id }` names the work;
  the project is checked for registration and a named session for existence, but the job id is not
  resolved against the coding runner's job list.
- **There is no documented maximum on how many completion records a project may hold.** Each record is
  bounded (the control store's 64 KiB JSON limit, and the per-field bounds above) and the read is
  capped at 200 records with `truncated: true`, but growth is only bounded by those.
- **The Markdown file is repository-readable and hand-editable.** The store is authoritative and the
  edit is reported as `stale`; re-recording the same evidence rewrites the file. Editing it can never
  change the record, and it can never change an acceptance.

## Tests

- `tests/server/acceptance-store.test.ts` — the store over a disposable root: policy validation,
  owner-only refusal, the permitting rule, ask mode, the changed artifact, single use across a crash
  and reopen and across two handles, contradictory, unreconciled and unreadable counts, the not-run
  absence, the diff bound, the Markdown record read back from the disposable project folder, and a
  Markdown write whose file cannot be rendered reporting its real, non-current state.
- `tests/server/action-registry.test.ts` — the four actions driven through the registry, and every
  declared precondition matched to a refusal the handler really produces.
- `tests/server/http.test.ts` — the routes owner-only, behind the unchanged Host check and the origin
  enforcement for writes, with the real Markdown file asserted after both a recording and an
  acceptance, the registry-shaped body (`request.actor`) accepted as the agent it declares, a body
  that declares two disagreeing actors refused, and an agent refused under a policy that forbids it.
