# The bounded coding runner, and the installed local test capability

This page describes two different things and must not be read as one.

**The installed capability is the local test runner.** With `DASHBOARD_TEST_RUNNER=on`, a named agent
that is bound to a session, granted the `run_tests` scope and given the project can call the
`run_tests` tool. It runs exactly one fixed recipe — `node --test` with no arguments — as a child
process of this application, with the registered project root as its working directory. A durable
intent is written before the process starts; the result, or an honest `unknown`, is written
afterwards. It is default off, and it is **not a sandbox and not a container**:

- The child runs as the **application user inside the application container**. It can read
  `<data>/credentials/`, the durable control store and **every** registered project, and it can modify
  this one.
- There are **no cgroup memory or PID limits**. The wall-clock timeout and the output caps bound how
  long it may run and how much is stored, not how much CPU, memory or process table it may consume
  before it is stopped.
- The process group is signalled on a timeout or cancellation, and that termination is
  **best-effort**. A run stopped at its wall clock is recorded as `unknown`; it is never treated as a
  pass, a failure, or proof that the group is gone.
- A run that is cancelled, timed out or interrupted by a restart is **never replayed or retried
  automatically**. Inspect the record before running the tests again.

A model cannot choose the command, an argument, an image or an environment: the recipe is a constant
of this build, and the only request knobs are a bounded wall-clock timeout and a bounded output cap.
The local runner's test process receives a fixed environment (`PATH`, `HOME`, `TMPDIR`, `LANG`,
`NODE_ENV=test`), never the application's own variables. It can still read anything the application
user can read, including the stored credentials.

**The legacy Docker execution port is unavailable**, even with `DASHBOARD_RUNNER=on`. It cannot
authenticate container identity for cancellation or enforce a wall-clock container lifetime. It
refuses both preflight and direct execution without spawning Docker; the switch alone does not expose
the runner actions. An injectable synthetic port is used only for disposable tests. The separate
experimental service-side runner is also uninstalled; see [its boundary](specs/runner-service-boundary.md).

Everything from **The job** to **Reconciliation** below describes that unavailable container broker's
narrow design and its unresolved gaps. None of it is an installed execution capability or proof of
runtime isolation. Historical records do not prove termination; investigate unknown jobs and
containers before attempting recovery. The local test runner above is a separate module,
`src/server/state/local-test-runner.ts`, and does not use the container broker.

## The job

A job is a typed, validated request. Every field is required, frozen and strictly validated, and an
unknown field fails closed.

| Field | Meaning |
|---|---|
| `id` | A stable identifier, generated once when the job is submitted. |
| `projectId` | The registered project the job belongs to. A job belongs to a project and to no conversation. |
| `recipe` | One name from the fixed allowlist below. It is a name for one constant command line, never command text. |
| `workspace` | A **relative** reference inside the registered project's own root (for example `.` or `packages/api`). An absolute path, a parent segment, a backslash or a symlink is refused. |
| `limits` | `timeoutMs`, `outputBytes`, `memoryBytes`, `cpus`, `pids` — each bounded, each refused rather than reduced when it is outside its bound. |
| `state`, `revision` | The job's state and the compare-and-swap revision the durable store enforces. |
| `claim` | Who holds the job, and until when. The lease is the whole of this build's liveness evidence. |
| `result` | The bounded outcome of a finished run, or `null`. |
| `attention` | The named reason a job needs an operator, or `null`. |
| `createdAt`, `updatedAt` | When the job was submitted, and when it last changed. |

There is no `command`, no `args`, no `env`, no `image` and no second step. A caller chooses *which*
recipe and *where*, and states the limits; it never composes a command line.

### The states

The set is closed, and each state says exactly what the durable record proves.

| State | Means | Claim | Result | Attention |
|---|---|---|---|---|
| `pending` | Submitted and validated, claimed by nobody. Nothing has run. | no | no | no |
| `claimed` | One named owner holds a lease on it. **Nothing has run yet.** | yes | no | no |
| `running` | A run began: the record was written before any container started. It carries the claim of the owner that started it, and a result only once the run reported one. | yes | no | no |
| `settled` | Finished, with its result recorded. It is never run again. | yes | yes | no |
| `attention` | Terminal, and it needs a person: the run began and reported nothing, or the job was claimed and settled without ever starting. | yes | no | yes |

The two states that make the rest safe are `claimed` and `running`:

- **`claimed` means nothing has run.** A run writes `running` *before* it starts a container, so a job
  that is merely claimed is provably unexecuted. That is why a claim whose lease has expired may be
  reclaimed, and why an owner may settle a claimed job, without any risk of repeating an execution that
  never began.
- **`running` means an execution may have happened.** It is never claimed again and never run again; it
  is settled from what the record proves, or it becomes `attention`.

### The legal transitions

Everything else fails closed, with the states that are legal named in the refusal.

| From | May become | Through |
|---|---|---|
| `pending` | `claimed` | claim |
| `claimed` | `claimed`, `running`, `attention` | a renewal or a reclaim, run, settle (the job never started) |
| `running` | `settled`, `attention` | settle, or reconciliation (a recorded result, or the named operator-attention state) |
| `settled` | — | terminal: it is never run again |
| `attention` | — | terminal: it is never re-run to discover an outcome this build could not establish |

### Exact job claims

The broker also accepts an internal `expectedJobId` guard. It still selects the ordinary FIFO
eligible head; when that is not the expected job, it refuses before claiming or establishing a
container. It never skips another pending job. An internal caller may supply a cancellation signal:
a cancellation observed before admission leaves the claim unrun; one observed after admission
aborts the execution port, keeps the job's outcome uncertain, and requires reconciliation rather than
claiming success or replaying it. The existing owner action retains its ordinary FIFO behaviour.

A second `run_tests` harness extension is test-only: it exists only when an embedding explicitly
injects a runner broker and a session-aware workspace check, and the application never does. It uses
the fixed `test-run` recipe, checks the named agent's project and `run_tests` grant before submission,
claim and run, and derives a stable job ID from the project and invocation identity so a repeated
invocation cannot create a second job. It is exercised end-to-end with a synthetic port and a real
disposable agent store. The application installs the local runner instead, and a harness refuses to
install both.

**The installed local capability** (`DASHBOARD_TEST_RUNNER=on`, `src/server/state/local-test-runner.ts`
and `src/server/agents/local-test-dispatch.ts`) enforces its own path:

1. The `run_tests` tool is installed only when the switch is on. Every call starts from the one-use
   ticket the privilege hook issued for that exact call, and the owner's own dispatch (no bound agent)
   is refused — the capability belongs to a bound named agent.
2. The session must be bound to that agent; the agent must hold `run_tests`; the project must be in
   its project grant; and the versioned authority snapshot the ticket carries must still match the
   durable records. A change since the call refuses before anything is reserved or started.
3. One rolling-hour job is reserved through the durable agent budget ledger, whose guard re-checks
   binding, revision, scope and project inside its admission transaction. The reservation is
   conservative and is **not refunded** on failure, cancellation or a duplicate invocation. The
   rolling window uses the host clock; it is not a provider spending cap.
4. The local runner admits one durable operation keyed by a stable job id derived from the project,
   conversation and task identity. A duplicate invocation finds that operation and is told what it
   holds; it cannot create a second job. A concurrent duplicate loses the admission race the same way.
5. The runner re-reads the same versioned authority inside the admission transaction and once more
   immediately before `spawn`. A revocation in the second window records `not-started` — nothing ran.
6. A fork is refused: the fixed recipe's working directory is the registered project root, not the
   fork worktree.

The budget and authority checks apply while the switch is on. Turning the switch off removes the
tool; it does not delete durable jobs, and the startup reconciliation still records any pending
intent as `unknown`.

### The result

A settled job carries what the run reported, bounded and path-free:

| Field | Meaning |
|---|---|
| `outcome` | `succeeded`, `failed` or `timed-out`. A timeout is settled only if the port confirms termination. Otherwise the job remains uncertain, not a timed-out result. |
| `exitCode` | The process exit code, and `null` exactly when the run was stopped at its wall clock — the code a killed container reports is not the command's own outcome. |
| `stdout`, `stderr` | The stored prefixes, cut to the job's `outputBytes` cap. |
| `stdoutBytes`, `stderrBytes` | The bytes each stream produced as far as the port counted them, so a truncated stream still says how much there was. |
| `truncated`, `capBytes` | Whether output was dropped, and what the job asked to keep. |
| `durationMs`, `startedAt`, `endedAt` | The wall clock this broker observed. |
| `commands` | The exact command that ran: the recipe and the allowlist's own argv. |

The cap is measured in the bytes the output occupies **inside the stored record**, so a stream of
control characters — which the record has to escape — cannot inflate a record past the control store's
own 64 KiB payload bound. The record is validated against that bound on the way in and on the way out.

## The recipe allowlist

The allowlist is closed and lives in one place (`src/shared/runner.ts`), so the command line a job
produces is a constant of this build:

| Recipe | The exact command | What it is for |
|---|---|---|
| `test-run` | `node --test` | the workspace's own Node test suite, with the container's default discovery and no arguments from the caller |
| `noop-probe` | `/bin/echo pilot-runner-probe` | proving the container, its image and its mount work before trusting a longer job |

There is no shell: the container's entry process is `argv[0]` and every later element is a literal
argument. There is no argument a caller can supply, no environment, no pipe and no second command.

## The container properties, and why each matters

The retained command-line builder describes a proposed container from `deploy/runner/Dockerfile`.
These flags alone do not establish containment, and the disabled port does not start it:

| Property | Flag | Why it matters |
|---|---|---|
| No network | `--network none` | A job must not reach the network, a provider or another service on the host. The container has only its own loopback interface and no external network interface. |
| Read-only root | `--read-only` | The job must not be able to modify the image, or anything outside the one workspace it was given. |
| Non-root user | `--user 10001:10001` | The job must not run as uid 0 inside its own namespace. The image's own `USER` says the same, and the flag makes it explicit and checkable. |
| No capabilities | `--cap-drop ALL` | A job must not keep a capability the container runtime would otherwise keep by default. |
| No new privileges | `--security-opt no-new-privileges` | A setuid or setcap binary inside the image must not be able to raise privileges. |
| No runtime socket | *(nothing is mounted)* | The container runtime's socket is root on the host. A job that could reach it would be outside every other limit here, so it is never mounted — and the broker refuses a report that says it is reachable. |
| One mount | `--volume <workspace>:/workspace:rw` | The single workspace is the only host path a job may see, at a fixed path. No project it was not given, no home directory, no host path. |
| Bounded tmp | `--tmpfs /tmp:rw,noexec,nosuid,size=16m` | A read-only root filesystem still needs somewhere to write. It is bounded, non-executable and never the host's disk. |
| Memory cap | `--memory <n>b` and `--memory-swap <n>b` | A job must not exhaust the host's memory, and swap is pinned to the same value so it cannot exceed it. |
| CPU cap | `--cpus <n>` | A job must not monopolise the host's CPUs. |
| PID cap | `--pids-limit <n>` | A job must not fork without bound. |
| Wall clock | broker deadline | A broker deadline is not a container lifetime bound. The legacy Docker port is disabled until identity-bound termination and recovery are established. |
| Removed after it stops | `--rm` | A finished or stopped container does not accumulate on the runtime. |

**The broker refuses to run a job when it cannot establish those properties.** Every operation that
could start a container asks the port to establish them first and checks the report against one
declared list of requirements (`RUNNER_REQUIRED_PROPERTIES`, in `src/shared/runner.ts`); a property
that is missing or wrong is a refusal that names it and why it matters. The legacy Docker port cannot
provide that report and refuses before any claim or runtime invocation. A report from an injected test
port is not an independent audit of a kernel or evidence of a production runtime.

## Fail-closed rules

1. **The container broker has no host or in-app fallback.** The port is the only execution path for
   a *container* job, and there is deliberately no branch that runs one in-process, in the
   application container or on the host. If the runtime is unreachable, the image is missing, or the
   properties cannot be established, the job is refused — and, at claim time, **left unclaimed**.
   The installed local `run_tests` capability is a different module and does run in the application
   container, uncontained; it is not this broker's fallback.
2. **An unknown recipe, an out-of-root workspace, an oversized limit and an unknown field are refused
   before anything is written.** The workspace is resolved against the registered project's own root
   with the same containment helper the rest of the application uses (no absolute path, no `..`, no
   symlink at any component, and the resolved directory must still canonicalise inside the root). It is
   resolved again at the moment it is mounted, so a reference that stopped being contained is refused
   rather than mounted.
3. **A refusal never carries a path.** The runtime's own error may name a binary, a socket or a
   directory, so it is logged on the server and never repeated in a response.
4. **Nothing is executed before the durable record says so.** The `running` write precedes the
   container. If that write loses the compare-and-swap — a settle, or another claim, got there first —
   the run executes nothing at all.
5. **An outcome this build cannot establish is never invented.** A run whose result the port could not
   report leaves the job `running` with no result, and settlement turns that into the named
   operator-attention state `job-interrupted`. A port that reports nothing is *not* recorded as a
   failure, because a refusal and a crash around the write look identical from here.

## The switch

The runner is **unavailable** with the built-in Docker port. Its actions are absent from the typed
registry, and routes refuse with a named reason. An explicitly injected port can enable it in tests.

| Variable | Default | Meaning |
|---|---|---|
| `DASHBOARD_TEST_RUNNER` | `off` | Installs the **local** `run_tests` tool: the fixed `node --test` recipe as an uncontained child process of the application. Requires a durable control store and the agent registry. |
| `DASHBOARD_RUNNER` | `off` | Requests the container broker, but cannot enable the unavailable built-in Docker port. |
| `DASHBOARD_RUNNER_IMAGE` | *(none)* | Historical image setting; no value makes the built-in port available. |
| `DASHBOARD_RUNNER_DOCKER` | `docker` | Historical CLI setting; the disabled port does not invoke it. |

`DASHBOARD_RUNNER` does not enable test execution: requests without a separately injected port are
reported at startup and the container actions remain unavailable, and a durable control store is also
required. `DASHBOARD_TEST_RUNNER` is the installed capability: it installs the local `run_tests` tool
(never a container) and also requires a durable control store and the agent registry.

## The durable record and the actions

Jobs live in the durable control store — the same store as the named sessions, the lifecycle, the
approvals and the queue — one operation per revision, keyed `runner.<jobId>.r<revision>` inside a
reserved scope dimension for the project. The store's `UNIQUE(project_id, session_id,
idempotency_key)` index *is* the compare-and-swap: two writers that read the same revision cannot both
win. This decides a claim race and a run and settlement that both contend for the **claimed**
revision; it does not serialize a later port invocation against settlement of `running`.

Five actions exist, all project-scoped, and all of them are refused while the runner is disabled:

| Action | Effect | Writes |
|---|---|---|
| `runner.read` | reads one project's jobs, oldest first, with the allowlist and the bounds | no |
| `runner.submit` | writes one pending job from a validated request | yes |
| `runner.claim` | claims the oldest unclaimed job for a named owner, with a lease; establishes containment first | yes |
| `runner.run` | writes `running`, runs the job in one container, writes the bounded result and settles it | yes |
| `runner.settle` | settles one job from what the record proves, and executes nothing | yes |

The same operations are reachable as authenticated owner-only routes, behind the unchanged Host check
and the same origin/CSRF enforcement for writes:

| Route | Method | What it does |
|---|---|---|
| `/api/projects/:id/runner/jobs` | GET | the project's jobs, the recipe allowlist and the documented bounds. Read-only. |
| `/api/projects/:id/runner/jobs` | POST | submits one job: `{ "recipe": "...", "workspace": "...", "limits": { ... } }` |
| `/api/projects/:id/runner/jobs/claim` | POST | claims the next job for one owner: `{ "owner": "..." }` |
| `/api/projects/:id/runner/jobs/:jobId/run` | POST | runs the job that owner holds: `{ "owner": "..." }` |
| `/api/projects/:id/runner/jobs/:jobId/settle` | POST | settles one job from its durable record |

## Dispatch and settlement gap (unresolved)

A run can commit `running`, pause before invoking the port, and have a second broker settle the
job to `attention` (`job-interrupted`). The first broker can then invoke the port anyway. Its
subsequent result write conflicts with the attention revision, so the report is not stored. A job in
attention can therefore still start or continue, and its missing result is not evidence of absence,
termination, or rolled-back effects. The synthetic regression in `runner-broker.test.ts` reproduces
this with separate SQLite connections; it does not establish host or process isolation. The built-in
port remains disabled. Do not enable a runner on the strength of this broker protocol.

A safe integration requires a service protocol, not another broker read or a process-local lock:

1. Bind a stable job ID and immutable request digest to a durable service-side admission. Exact
   duplicate dispatch is lookup-only; changed content is refused. A durable service-side arbitration
   point must order dispatch against a cancel/close request from any broker process. If close wins
   before dispatch, the service persists a non-dispatch tombstone and rejects every later dispatch
   for that identity, including delayed messages and retries. A broker-side `attention` write alone
   is not that tombstone.
2. If dispatch wins, or the service cannot prove which won, close returns in-flight/unknown rather
   than not-run. The service durably binds the identity to its workload and retains the barrier;
   independently verified termination and a durable terminal receipt are required before treating
   execution as stopped. A lost response, crash between runtime operations and journal writes, or
   contradictory evidence remains unknown and is never retried or automatically cleared.
3. The broker reconciles from authenticated service evidence and records the close outcome and any
   terminal receipt without overwriting uncertainty. A conflict or a crash between the service and
   broker writes requires idempotent lookup/reconciliation; neither store can atomically commit the
   other's external effects. Manual investigation remains necessary when the service cannot prove
   the runtime identity or termination. Termination does not undo external effects.

This is a design requirement, not an implemented guarantee; service arbitration, recovery and its
host assumptions require independent review and cross-process/crash tests before integration.

## Reconciliation

When an injected broker is active, its startup reconciliation does not re-run jobs. A valid `running`
record has no result and becomes `attention` with reason `job-interrupted`; the record does not prove
whether execution occurred or stopped. Records claiming both `running` and a result are rejected as
corrupt by strict validation, not settled. Other states remain unchanged. With the built-in port
unavailable, its broker is not activated and this startup reconciliation does not run.

The `attention` label is not proof that a container terminated and must not be used to authorize a
retry, cleanup, or release of a separate runner barrier. Historical `settled` results are records of
what an older port reported, not independent remote termination evidence. Investigate historical jobs
and containers before recovery; safe identity-bound reconciliation remains unimplemented.

## Tests

- `tests/server/runner-broker.test.ts` — the durable runner over a disposable root and a synthetic
  port: validation refusals for unknown fields, unknown recipes, out-of-root and symlinked workspaces
  and oversized limits; a claim race with exactly one winner and a live claim that is never stolen; a
  run the port cannot report leaving the job `running` and reconciling to `job-interrupted` without a
  rerun; a settled job that is never run again, a claimed-revision run/settle race where the loser
  executes nothing, and the unresolved post-admission dispatch/settlement gap; output truncated at the byte cap with the record inside the control store's own
  bound; the wall clock enforced by the broker, including a port that ignores the abort; a job refused
  — and left unclaimed — when the container properties cannot be established, with the port's execute
  never called; durability across a close and reopen; and the per-project bound.
- The same file exercises the **real** port's command line: `dockerRunArgv` is asserted flag by flag
  (no network, read-only root, non-root user, all capabilities dropped, no-new-privileges, one mount,
  bounded tmpfs, memory/swap/CPU/PID caps, no environment, no shell, no runtime socket), and the port
  itself is pointed at a **fake binary** that only records the argv it was spawned with.
- `tests/server/local-test-runner.test.ts` — the installed local recipe against disposable projects:
  a real passing and a real failing `node --test` run; a wall-clock timeout and a cancellation that
  each terminate the whole process group (including a spawned grandchild); the output cap with its
  truncation flag and counted bytes; revocation in the admission transaction and immediately before
  `spawn`, with no record and no process respectively; the rolling-hour job budget refusing a second
  invocation before it runs; duplicate invocation identity with one execution; and a killed
  application process whose reopened store reconciles the pending intent to `unknown` without
  re-running it.
- `tests/server/local-test-dispatch.test.ts` — the installed dispatch refuses a stale authority
  snapshot, a revoked `run_tests` scope, an unbound session and a fork before anything runs, and
  enforces the rolling-hour job limit on the installed path.
- `tests/server/local-test-runner-harness.test.ts` — the harness-level check: owner dispatch is
  refused, an unbound session is refused even when a legacy project rule exists, a bound agent's call
  really runs the disposable project's tests and returns its receipt, and revoking the scope stops the
  next call with no execution.
- `tests/server/action-registry.test.ts` — the five actions are declared, reachable and really act
  through the broker; every new precondition code matches a refusal the handlers really produce; and
  with the runner disabled the actions are **absent from the offered registry** rather than listed and
  failing.
- `tests/server/http.test.ts` — the routes are owner-only, behind the unchanged Host check and the
  origin check; a workspace outside the registered root, an unknown recipe, an unknown field, an
  oversized limit and a missing workspace each fail closed with their own status; a job that cannot be
  contained is left unclaimed and executes nothing; and a settled job is never run again.

**No container is started in any unit test.** The broker's only execution path is its port, so the
suite injects one; the single test that exercises the real port points it at a fake binary.
The explicit local acceptance script starts real containers only when an operator supplies a locally
built image. See [Local runner validation](RUNNER-LOCAL-VALIDATION.md) for the command, observed
results and limits. This local check does not verify any remote deployment.

## Honest limits

### The installed local `run_tests` capability

- **It is not a sandbox.** The test process runs as the application user inside the application
  container. It can read the stored credentials under `<data>/credentials/`, the durable control
  store and every registered project, and it can modify the project it was pointed at. Granting the
  `run_tests` scope is granting the application user's own reach, minus the ability to choose a
  command.
- **There are no cgroup memory or PID limits.** A runaway test can exhaust the container's memory or
  fill its process table before the wall clock stops it.
- **Termination is best-effort.** A timeout or cancellation signals the child's process group; if
  the signal fails, the run is recorded `unknown`. A run may have written files, spawned processes
  that outlive the group, or read data before it was stopped. A stop is not a rollback.
- **The output is stored durably.** The receipt keeps a bounded prefix of stdout and stderr in the
  control store. Node's own test runner folds a test file's stderr into its stdout, so the
  application-side stderr stream is often empty even when a test wrote to stderr.
- **A restart does not resume or rerun anything.** A pending intent becomes `unknown` once at
  startup. The job budget is not refunded, and no automatic retry exists.

### The unavailable container broker

- **This is containment, not a hostile same-UID sandbox.** The properties above bound what a job can
  reach and consume, and they are enforced by the container runtime, not by an audit of the kernel. A
  container escape or a runtime vulnerability is outside what this build can promise.
- **The runtime's own socket is root on the host.** For the application to start a container it must
  be able to reach a container runtime — the docker group, or a narrowly scoped socket proxy — which is
  effectively root-equivalent on that host. The container is a boundary around the *job's* code, not
  around the application. The capped application container in `deploy/pilot/` deliberately has **no**
  docker socket, so the runner cannot work from inside it: enable the runner only where the application
  process can reach a runtime you are willing to expose to it.
- **A job can write inside its workspace.** That is the point of a test run, and it is why the
  workspace is the only mount. Point it at a project whose contents you are willing to have modified,
  and inspect the workspace after an `attention` job rather than assuming.
- **The bounded output is stored durably.** The control store holds the stored prefix of each stream
  (up to the job's cap). It is the workspace's own output, so treat the data root as holding it.
- **The wall clock is not a resource guarantee.** A job stopped at its wall clock has already used up
  to that much CPU and memory; the caps bound the *rate*, not the total work done before the stop.
- **This deployment is a testing environment.** The runner is enabled on the Oracle VPS as a testing
  environment for this work, not as a hardened multi-tenant execution service. The application is still
  single-owner, with no roles and no rate limiting.

### Two execution surfaces, both opt-in

The runner is one: jobs are bounded by the allowlist, the containment and the limits above, and it
exists only under explicit operator action. The agent's own coding tools are the other, documented
in [Coding tools](specs/coding-tools.md): `read`/`write` bounded to the connected worktree, and a
shell that is deliberately **not** contained. `docs/ARCHITECTURE.md` invariant 4 and
`docs/SECURITY.md` now state both, so neither file claims a boundary this build does not hold.
