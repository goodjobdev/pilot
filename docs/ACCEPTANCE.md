# Completion records and acceptance

A unit of work is not "done" because someone said so. It is done when there is a **completion
record** — a claim about what was produced, from which revision, by which commands, and with what
test counts — and, where something consequential follows from it, an **acceptance** of that exact
artifact by an identity the policy permits. The store checks the claim's internal consistency; it
does not independently verify that commands ran, output is authentic, or the artifact matches.

The model lives in `src/shared/acceptance.ts` (pure: the closed sets, the strict validation and the
honesty rules) and the durable half in `src/server/state/acceptance-store.ts`. The actions are
`acceptance.read`, `acceptance.evidence.record`, `acceptance.accept` and
`acceptance.policy.update`; the owner-only routes are in `docs/ACTIONS.md`. Every record is one
operation in the durable control store, so this introduces **no new persistence**, and the Markdown
record is written inside the project's own tree.

Nothing here commits, pushes, deploys, spends, provisions or publishes. An acceptance records a
decision about an artifact; performing anything with it stays a separate, explicit step.

## Runner provenance bridge: not installed

Runner-linked evidence is not currently an acceptance mode. Existing completion records remain
self-reported and compatible; recording a runner job ID or copying runner output into a record does
not upgrade its trust. No model-facing provenance tool is installed.

The current bounded runner's durable job identifies a project, job revision, settled status and
reported result. It does **not** bind that result to a named session, an observed artifact revision
and content digest, or an independently protected receipt digest. A workspace name is not an artifact
identity, and a synthetic execution port proves only the behaviour of that test double. The experimental
runner snapshot validator likewise validates submitted bytes but explicitly does not prove they came
from a Git revision or the live worktree. Thus this build cannot safely turn a settled job into
acceptance-grade evidence.

A future opt-in bridge requires all of these interfaces before it can be implemented honestly:

1. A protected artifact-observation port that returns the canonical project/session binding, an
   immutable artifact revision and digest, and the exact bytes or immutable snapshot identity tested.
   The observation must be made by the trusted service, not supplied by the model.
2. A protected runner receipt reader that authenticates integrity and returns project ID, named
   session ID, job ID, terminal job revision, successful result/status, tested artifact revision and
   digest, and a unique receipt digest. It must distinguish revoked, missing, uncertain and corrupt
   receipts; the current runner broker record alone is not this interface.
3. A shared durable-store transaction that revalidates the receipt, artifact binding and revocation
   state while admitting the immutable acceptance evidence, with the same project and session scope.
   If receipt authority can be revoked, revocation and evidence admission must serialize against the
   same authoritative state. No match, stale revision, untrusted adapter or unavailable transaction
   must refuse without writing.
4. A content-derived idempotency binding over the exact receipt and artifact identities, plus durable
   integrity validation on every read. Replays of identical linkage may return the same evidence;
   changed linkage must never rewrite it or be treated as equivalent.

The focused characterization in `tests/server/runner-broker.test.ts` uses a disposable store and a
port whose output is controlled by the test. It demonstrates that successful storage of that canned
output does not authenticate a real execution; it deliberately does not freeze the runner record schema.
The bridge remains unavailable until the protected interfaces and their production wiring,
transactional races, revocation, corruption and refusal cases are independently verified.

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

**Accepting identity.** The HTTP and action interfaces are owner-authenticated. They derive the
recorded owner identity from the authenticated deployment, not from a submitted label. For compatibility,
an owner actor may be supplied inside or beside the request; an agent actor is refused, and conflicting
declarations are refused. An agent acceptance can only come through the bound agent session's
`acceptance_accept` tool, not by naming an agent in an owner request.

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
2. The evidence must already be recorded for the named session. Its explicitly bound agent, if granted
   `accept`, can call `acceptance_accept` with the evidence ID, exact artifact and `commit` action class.
   The recorded decision carries `agent-may-accept:commit=full-auto` and the policy revision. The
   model does not choose the actor identity.
3. The owner can use the registry's evidence, policy and acceptance actions, but those authenticated
   requests cannot impersonate an agent. The model-facing acceptance records a decision only; it does
   not execute any subsequent action.

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

- **An agent is not a separate security principal.** Owner HTTP requests cannot claim an agent
  identity; the model-facing tool resolves its identity from the durable session binding and rechecks
  it at admission. There is no separate agent credential or same-UID process isolation.
- **The artifact identity is not re-read from git.** Acceptance is bound to the revision the evidence
  itself recorded; this build has no Git plumbing that would re-read the live tree or the live commit.
  A caller with such a source can enforce the stronger check at the point where it produces the
  evidence.
- **A job subject is not resolved against the runner.** `subject: { kind: "job", id }` names the work;
  the project is checked for registration and a named session for existence, but the job id is not
  resolved against the coding runner's job list.
- **There is no documented maximum on how many completion records a project may hold.** Each record is
  bounded (the control store's 64 KiB JSON limit, and the per-field bounds above). A read returns the
  oldest 200 matching records and reports `truncated: true` when more exist; agent reads select their
  session before applying this cap. Policy history also has no total bound: each project read validates
  it once in a SQLite read snapshot, so its time and memory costs can still grow with history.
- **The Markdown file is repository-readable and hand-editable.** The store is authoritative for these
  acceptance records and an edit is reported as `stale`; re-recording the same evidence attempts to
  rewrite the file. A render failure after admission reports the durable record with `written: false`
  and the observed Markdown state; it does not mean admission was undone. Editing the file cannot
  change the stored record or acceptance.
- **Stored hashes are consistency checks, not authentication.** Reads check the operation and outbox
  digest and linkage, acceptance-to-evidence fields, contiguous policy revisions, and the decision's
  consistency with its cited historical policy. A writer able to
  coordinate database changes can rewrite these together or remove all history. The evidence ID is
  derived from the submitted request, but output-count normalization means that original request
  cannot always be reconstructed from the stored record. Neither the ID nor the read checks prove
  that claimed tests, diffs, or reviews really occurred.

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
  acceptance, attempted agent impersonation refused, and conflicting actor declarations rejected.

## Offline operator control

An operator with access to the stopped data root can explicitly set all acceptance classes to
`full-auto` and the mode to `agent-may-accept` with
`pnpm exec tsx scripts/full-auto-policy.ts <data-root> <expected-revision> <owner-identity> --execute`.
The command requires an existing control store, refuses a paused restore and any existing service-lock
evidence, acquires its own service lock, and records the change through the same revision-checked
acceptance store used by the authenticated interface. It changes no agent's grants and does not run a
command, commit, push, deploy, or publish. The shell remains an unrestricted direct tool if granted.

## Agent-facing evidence tools

When the durable control store is available, a named agent granted the `accept` scope can call
`acceptance_read` (ten summaries per page), optional `acceptance_record` (self-reported evidence for the
calling session, installed only with the default-off `DASHBOARD_AGENT_EVIDENCE_RECORDING=on` deployment
switch), and `acceptance_accept` (an evidence ID, exact artifact and action class). Evidence
is a claim: the store checks internal consistency, not that commands ran or that the diff matches the
artifact. The record format does not distinguish model and owner producers, so no record should be
assumed independently verified. The server
uses the bound agent identity, never a model-supplied actor. The model-facing read shows only evidence
whose recorded session is the calling session, and the acceptance path refuses an evidence ID from
another session. An agent in a fork cannot call `acceptance_record` or `acceptance_accept`: Markdown rendering targets the
parent workspace rather than the fork. The owner-authenticated project-wide interface is unchanged. The store refuses stale
artifacts, repeated acceptance, policy-denied action classes, and missing evidence. Agent and project
scope are rechecked after the evidence read. Scope, explicit session-to-agent binding and current
policy are also rechecked synchronously inside the durable acceptance admission transaction. The
transaction compares the dispatch authority and its agent/binding revisions, so a revoke-and-restore
before admission does not revive the same call. A legacy project-wide agent match without an explicit
session binding cannot accept. A read reports if the underlying store's bounded evidence list is truncated.
Cancellation before durable admission prevents a new record; after admission the durable record remains
and is reported even if rendering is skipped. Agent authority and cancellation are checked again before
the final Markdown replacement. Those checks cannot retract a filesystem operation already issued or
make the filesystem and SQLite one atomic transaction. These checks protect the recorded decision, not unrelated same-UID shell operations, and do not make
untrusted test or diff claims true. An accepted record is not a commit, push, deployment, expense,
provisioning operation or publication. The separate `commit_accepted` and `push_accepted` harness tools
are the only agent-facing paths in this build that perform an accepted action class, and only where
their own deployment switch (`DASHBOARD_AGENT_COMMIT`/`DASHBOARD_AGENT_PUSH`), an exact
owner-configured target and a `full-auto` class decision are all in force; they consume the same
single-use acceptance this section describes and never replay an uncertain intent. See
[docs/AGENTS.md](AGENTS.md), *The bounded commit and push capability*.
