# Architecture and invariants

Three surfaces over one project's own files, plus derived state that can be rebuilt.

## The surfaces

| Surface | Owns | Stored as |
|---|---|---|
| Board | Work items, dependencies, milestones | `docs/dashboard/board.md` in the project |
| Wiki | Intent, behaviour, decisions, open questions | any Markdown in the project |
| Agents | Conversations, questions, tool calls, checkpoints | `<data>/agents/<projectId>/session.sqlite` |

## Invariants

1. **Markdown is canonical.** Every planning fact lives in a file inside the project, in git.
   The SQLite index, the canvas layout, the alert subscriptions and the agent sessions are
   derived or working state. Deleting them loses convenience, never documentation.
2. **Writes are revision-checked.** A client sends the revision it read; a mismatch is a
   conflict that preserves the draft. The application never overwrites a newer file.
3. **Paths are contained.** Every read and write resolves through one containment helper that
   refuses absolute paths, `..`, and symlinks. Generated folders (`node_modules`, `dist`, …)
   and app-managed paths are never served or edited. Reads and writes are size-capped.
4. **The agent harness is the only execution surface.** There is no shell endpoint and no
   general file API. Agent tools resolve their paths through the same containment helper, so a
   registered project root is the boundary for the current question/note tools. Repository
   setup is a separate fixed-operation provisioning path (keygen, access check, clone and
   worktree): no arbitrary commands, hooks, installs, commits or pushes. See
   [Project connections](PROJECT-CONNECTIONS.md).
5. **Everything is behind the same door.** Every route — documents, agents, alerts, assets —
   passes the same authentication, session CSRF, origin and Host checks. There is no bypass
   mode, no anonymous route, and the process binds loopback only.
6. **Work is admitted durably before it is shown.** An agent input is committed to storage
   first; the interface reads committed state, so a closed browser cannot lose a run.

## The agent model

One harness per project, opened lazily, over its own SQLite file with its own provider
collection — so two projects share no conversation state. A conversation is a transcript of
immutable entries plus built-in documents (the running generation, the queued inbox, usage,
the agent's own choices).

- **Turns and runs.** An input starts a run; a run is one or more model turns with tool calls.
  Partial text and tool output are committed as they stream, which is why the transcript
  updates live and why a crash loses at most the last commit interval.
- **Steering and queueing.** Submitting while busy queues a follow-up by default; `steer`
  places the message after the current tool round, `reject` refuses it. Stopping withdraws
  queued inputs and aborts the run.
- **Questions.** The agent asks through a tool that records a question entry and ends its
  turn. The question is answered once: the answer record and the input that carries it both
  use a request id derived from the question, so a retry cannot answer twice, and an
  already-answered question is refused.
- **Interruption.** A tool is either safe to replay or not. After a crash, an unsafe tool
  returns an interrupted result to the model instead of running again; a safe tool may rerun.
- **Resumption.** Opening a harness resumes unfinished work from its checkpoint, which is how
  a run survives the process that started it.

## The alert model

Each project's conversation is watched on the server, not by a browser, so questions,
finished runs and failures are reported with no client attached. Alerts hold a VAPID key pair
and a bounded subscription list, throttle repeats of the same kind of event per project, and
drop endpoints the push service reports as gone. Payloads carry a title, one line of context
and a link — never document text.

## Isolation

Documents are scoped by project root, agent sessions by project id, and the only application-
level secrets are the VAPID key pair and the session secret, neither of which is exposed to
an agent or to the interface. The test suite asserts this directly: a document written in one
project is a 404 in another, the other project's transcript stays empty, and no key material
appears in an agent view.

## Failure semantics

| Failure | Behaviour |
|---|---|
| Two writers | Conflict, draft preserved, file untouched |
| Unreadable or malformed board | Served read-only rather than guessed at |
| Crash mid-tool | Run resumes; unsafe tool reports interrupted; no duplicate submission |
| Unclean process kill | `service.lock` remains and startup fails closed until an operator clears it |
| Push endpoint gone | Subscription pruned on 404/410 |
| Missing or forged identity | 401; wrong Host 403; the application verifies signatures itself |
