# The bounded coding runner

The runner is the one place this build runs *someone else's code*: a workspace's own test suite, inside
a container, with no network, a read-only root filesystem and hard limits — and nothing else. It is
**disabled by default** and it is deliberately narrow: one fixed recipe, one workspace inside one
registered project, one container, one bounded result.

This page states the job model, the recipe allowlist, the exact container properties, the fail-closed
rules, the switch, the reconciliation semantics, and — in the last section — what this is *not*.

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

### The result

A settled job carries what the run reported, bounded and path-free:

| Field | Meaning |
|---|---|
| `outcome` | `succeeded`, `failed` or `timed-out`. A timeout is a known outcome: this build stopped the run at its wall clock. |
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

A job runs in a container created from `deploy/runner/Dockerfile`. The command line is built by this
build (never by a caller) and every property is one flag:

| Property | Flag | Why it matters |
|---|---|---|
| No network | `--network none` | A job must not reach the network, a provider or another service on the host. The container is created with **no interface at all**, not a filtered one. |
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
| Wall clock | enforced by the broker | A job must be stopped at a stated wall clock even if it never exits by itself. The broker aborts the run and the port stops the container **by name** (then removes it), because killing the client alone would leave the container alive. |
| Removed after it stops | `--rm` | A finished or stopped container does not accumulate on the runtime. |

**The broker refuses to run a job when it cannot establish those properties.** Every operation that
could start a container asks the port to establish them first and checks the report against one
declared list of requirements (`RUNNER_REQUIRED_PROPERTIES`, in `src/shared/runner.ts`); a property
that is missing or wrong is a refusal that names it and why it matters. The port also reports the
largest memory, CPU, PID and wall-clock limits the runtime says it can enforce, and a job whose limits
exceed them is refused — with the runtime's own ceiling named — rather than quietly given less.

The report is the port's statement about the run it is about to perform, not an independent audit of
the kernel: the flags are built by this code, and `establish` verifies that the runtime answers and
that the image is present before it answers. See *Honest limits*.

## Fail-closed rules

1. **There is no host or in-app fallback.** The port is the only execution path in this build, and
   there is deliberately no branch anywhere that runs a job in-process, in the application container
   or on the host. If the runtime is unreachable, the image is missing, or the properties cannot be
   established, the job is refused — and, at claim time, **left unclaimed**.
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

The runner is **disabled by default**. With it disabled its five actions are **absent from the typed
registry** — not listed and failing — and the routes refuse with a named reason.

| Variable | Default | Meaning |
|---|---|---|
| `DASHBOARD_RUNNER` | `off` | The explicit switch. `on` enables the runner and its actions. |
| `DASHBOARD_RUNNER_IMAGE` | *(none)* | The image built from `deploy/runner/Dockerfile`. An absent or unusable value refuses every job with a clear reason. |
| `DASHBOARD_RUNNER_DOCKER` | `docker` | The container CLI binary. It is configured by the operator, never taken from a request. |

    DASHBOARD_RUNNER=on
    DASHBOARD_RUNNER_IMAGE=pilot-runner:1

Enabling the runner **without** an image is not a silent failure: the actions are offered (the switch
is on) and every claim or run refuses with "no runner image is configured". Enabling it without a
durable control store is reported at startup, and the actions stay unavailable.

## The durable record and the actions

Jobs live in the durable control store — the same store as the named sessions, the lifecycle, the
approvals and the queue — one operation per revision, keyed `runner.<jobId>.r<revision>` inside a
reserved scope dimension for the project. The store's `UNIQUE(project_id, session_id,
idempotency_key)` index *is* the compare-and-swap: two writers that read the same revision cannot both
win, which is what decides the claim race and a settle raced against a run.

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

## Reconciliation

A crash is a first-class case, not an accident. At every start, before anything listens, the runner
reconciles what a previous process left behind — deterministically, idempotently, and **never by
re-running a job**:

- a job that is `running` **with** a recorded result is settled on that result, so an outcome a crash
  interrupted before the settlement write is completed rather than lost;
- a job that is `running` **without** a result becomes `attention` with the reason `job-interrupted`:
  whether it executed, how far it got and what it left in the workspace cannot be established from
  here, and an operator inspects the workspace;
- anything else is left exactly as it is. A `claimed` job is not touched: its lease is the whole of the
  liveness evidence, and a claim whose lease has expired is reclaimable by an ordinary claim.

`runner.settle` is the same primitive, applied by hand: an owner can settle a job that a restart has
not reached yet, and settling a job that is already settled or awaiting an operator is a no-op at its
own revision. The reconciliation report is logged; a failure to reconcile is reported and never stops
the process from serving.

## Tests

- `tests/server/runner-broker.test.ts` — the durable runner over a disposable root and a synthetic
  port: validation refusals for unknown fields, unknown recipes, out-of-root and symlinked workspaces
  and oversized limits; a claim race with exactly one winner and a live claim that is never stolen; a
  run the port cannot report leaving the job `running` and reconciling to `job-interrupted` without a
  rerun; a settled job that is never run again, and a settle raced against a run where the loser
  executes nothing; output truncated at the byte cap with the record inside the control store's own
  bound; the wall clock enforced by the broker, including a port that ignores the abort; a job refused
  — and left unclaimed — when the container properties cannot be established, with the port's execute
  never called; durability across a close and reopen; and the per-project bound.
- The same file exercises the **real** port's command line: `dockerRunArgv` is asserted flag by flag
  (no network, read-only root, non-root user, all capabilities dropped, no-new-privileges, one mount,
  bounded tmpfs, memory/swap/CPU/PID caps, no environment, no shell, no runtime socket), and the port
  itself is pointed at a **fake binary** that only records the argv it was spawned with.
- `tests/server/action-registry.test.ts` — the five actions are declared, reachable and really act
  through the broker; every new precondition code matches a refusal the handlers really produce; and
  with the runner disabled the actions are **absent from the offered registry** rather than listed and
  failing.
- `tests/server/http.test.ts` — the routes are owner-only, behind the unchanged Host check and the
  origin check; a workspace outside the registered root, an unknown recipe, an unknown field, an
  oversized limit and a missing workspace each fail closed with their own status; a job that cannot be
  contained is left unclaimed and executes nothing; and a settled job is never run again.

**No container is started in any unit test.** The broker's only execution path is its port, so the
suite injects one; the single test that exercises the real port points it at a fake binary. A real
container run is therefore *wired and unverified here*: it is exercised by hand, on the testing
deployment, with `DASHBOARD_RUNNER=on`.

## Honest limits

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

### One frozen inconsistency, stated rather than hidden

`docs/ARCHITECTURE.md` invariant 4 says "the agent harness is the only execution surface", and
`docs/SECURITY.md` says there is no general shell or file API. Both predate this step and are now
**incomplete**: the bounded runner is a second execution surface — bounded by the allowlist, the
containment and the limits above, and enabled only by explicit operator action. Those two files are
outside this step's file boundary and were deliberately left unmodified; this page is the current
statement of what the runner is and is not.
