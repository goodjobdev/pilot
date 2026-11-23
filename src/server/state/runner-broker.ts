import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { safePath, within } from '../paths';
import { ControlStore, ControlStoreError } from './control-store';
import type { ControlScope, OperationRecord, OutboxRecord } from '../../shared/control-state';
import {
  RUNNER_ATTENTION_DETAILS, RUNNER_CONTAINER_WORKSPACE_PATH, RUNNER_DEFAULT_LEASE_MS, RUNNER_MAX_JOBS,
  RUNNER_MAX_LEASE_MS, RUNNER_RECIPE_COMMANDS, RunnerError,
  assertRunnerContainment, assertRunnerLimits, nextRunnerJob, parseRunnerIdentifier, parseRunnerJobId, parseRunnerOwner,
  runnerClaimVerdict, runnerJobRequest, runnerRunVerdict, runnerSettleVerdict, runnerView, submittedRunnerJob,
  truncateRunnerOutput, validateRunnerJobRecord,
  type RunnerClaim, type RunnerContainment, type RunnerJobRecord, type RunnerJobResult, type RunnerLimits,
  type RunnerRecipeId, type RunnerView
} from '../../shared/runner';

/**
 * The durable half of the bounded coding runner: one control-store operation per job revision, one
 * execution port, and the real container command line.
 *
 * It introduces **no** new persistence. Exactly like the queue, the lifecycle and the session registry,
 * it keeps one operation per revision — keyed 'runner.<jobId>.r<revision>' inside a reserved
 * control-store scope for the project — and the store's UNIQUE(project_id, session_id,
 * idempotency_key) index is what makes two writers aiming at the same revision a conflict rather than
 * two records. The revision is therefore not a read-then-write check: every mutating operation reads
 * the job, plans purely, yields once so the window between the read and the store's own transaction is
 * real, and only then writes at the next revision's key. Two writers that read the same revision really
 * race, and the store's index picks exactly one winner.
 *
 * Three rules keep the runner honest, and each is enforced here rather than asserted:
 *
 * 1. **A run is written durably before a container starts, and only then.** 'claimed' means nothing has
 *    run (which is why a reclaim and an explicit settlement of a claimed job cannot repeat an
 *    execution), and 'running' means an execution may have happened. Compare-and-swap resolves a
 *    run and settlement competing for the claimed revision only. After 'running' is committed,
 *    settlement can record attention before the port starts; it does not fence that later dispatch.
 * 2. **Nothing runs without containment, and there is no fallback.** Every operation that could start a
 *    container asks the port to establish the container's properties first and refuses unless every
 *    required property is present and the runtime can enforce the job's limits. There is deliberately
 *    no branch in this file — or anywhere else in this build — that runs a job in-process, in the
 *    application container or on the host: the only execution path is the port, and the only port this
 *    build ships builds a \`docker run\` command line.
 * 3. **An outcome this build cannot establish is never invented.** A run whose result the port could
 *    not report leaves the job 'running' with no result, and settlement turns that into the named
 *    operator-attention state 'job-interrupted'. Nothing is ever re-run to find out what happened.
 *
 * The reserved scope dimension is the literal 'runner': a coding job belongs to a project, not to a
 * conversation, and no named session with that id is ever created (session ids are UUIDs). The
 * alternative — borrowing a real session's scope — would put a job's records inside a conversation's
 * state, which is not what they are.
 */

const OPERATION_KIND = 'runner.job';
const OUTBOX_KIND = 'runner.job';
/** The reserved control-store scope dimension a project's jobs live under. */
export const RUNNER_CONTROL_SESSION = 'runner';
/** How long the broker waits for a port to report after it aborted the run, before it records what it knows. */
export const RUNNER_ABORT_GRACE_MS = 2_000;

/** What one execution reported. The port must resolve when its signal aborts; a rejection means it could not report. */
export type RunnerExecution = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  /** An independently observed termination, required to settle an aborted timeout. */
  readonly terminationConfirmed?: boolean;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
};

/** One execution request: the job, the resolved workspace to mount, the container name and the abort signal. */
export type RunnerExecutionRequest = {
  readonly job: RunnerJobRecord;
  /** The absolute, canonical workspace path this broker resolved and contained. It is never stored. */
  readonly workspace: string;
  /** A deterministic name derived from the job id, so a timed-out run can be stopped by name. */
  readonly containerName: string;
  readonly signal: AbortSignal;
};

/**
 * The execution port: the only place a job can run.
 *
 * \`establish\` answers with the containment the next run will enforce, or refuses with a precise,
 * path-free reason. \`execute\` runs one job and reports what it observed; it must resolve (not reject)
 * once its signal aborts, so a run this build stopped at its wall clock still reports the output it had.
 */
export type RunnerPort = {
  establish(): Promise<RunnerContainment>;
  execute(input: RunnerExecutionRequest): Promise<RunnerExecution>;
};

/**
 * How a job's workspace reference becomes the one host path a container may see. The broker resolves it
 * on submission (so an uncontained reference is refused before anything is written) and again at the
 * moment it is mounted (so a reference that stopped being contained is refused rather than mounted).
 */
export type RunnerWorkspaceResolver = {
  resolve(input: { readonly projectId: string; readonly workspace: string }): Promise<string>;
};

export type RunnerBrokerOptions = {
  readonly workspace: RunnerWorkspaceResolver;
  /**
   * Whether this instance has a registered project under that id. A job belongs to a registered
   * project and to no other, so every operation refuses an id this instance does not know rather than
   * reading an empty list for it.
   */
  readonly projectKnown: (projectId: string) => boolean;
  readonly clock?: () => Date;
  /**
   * How long one claim authorises a run, and the whole of the time before another owner may reclaim it.
   * There is deliberately no second liveness knob: this build cannot observe another process's
   * liveness, so a heartbeat would be a number derived from the same clock as the lease.
   */
  readonly leaseMs?: number;
  readonly maxJobs?: number;
};

/** One operation's outcome: the job as it now reads, and what the operation did. */
export type RunnerSettleResult = {
  readonly record: RunnerJobRecord;
  /** A named outcome: 'settled', 'attention' or 'unchanged'. */
  readonly outcome: string;
  /** False for a legal no-op, which returns the record at its own revision and writes nothing. */
  readonly changed: boolean;
};

/** What one reconciliation did, per job. Deterministic, and never a re-run. */
export type RunnerReconciliation = {
  readonly settled: number;
  readonly attention: number;
  readonly unchanged: number;
};

function iso(at: Date): string {
  const time = at.getTime();
  if (!Number.isFinite(time)) throw new RunnerError('The runner clock is not a valid instant', 'INVALID');
  return new Date(time).toISOString();
}
function boundedDuration(value: unknown, label: string, fallback: number, maximum: number): number {
  const exact = value === undefined ? fallback : value;
  if (typeof exact !== 'number' || !Number.isInteger(exact) || exact <= 0 || exact > maximum)
    throw new RunnerError(label + ' must be a whole number of milliseconds from 1 to ' + maximum, 'INVALID');
  return exact;
}

export class RunnerBroker {
  private readonly clock: () => Date;
  private readonly leaseMs: number;
  private readonly maxJobs: number;
  private readonly workspace: RunnerWorkspaceResolver;
  private readonly projectKnown: (projectId: string) => boolean;
  constructor(private readonly store: ControlStore, private readonly port: RunnerPort, options: RunnerBrokerOptions) {
    if (!options || !options.workspace || typeof options.projectKnown !== 'function')
      throw new RunnerError('The coding runner needs a workspace resolver and the project registry it belongs to', 'INVALID');
    this.workspace = options.workspace;
    this.projectKnown = options.projectKnown;
    this.clock = options.clock ?? (() => new Date());
    this.leaseMs = boundedDuration(options.leaseMs, 'leaseMs', RUNNER_DEFAULT_LEASE_MS, RUNNER_MAX_LEASE_MS);
    this.maxJobs = options.maxJobs ?? RUNNER_MAX_JOBS;
  }

  /** The jobs of one project, in submission order, as the owner reads them. Read-only. */
  read(projectId: unknown): RunnerView {
    const project = this.known(projectId);
    const jobs = this.jobs(project);
    return runnerView({ projectId: project, jobs: jobs.slice(0, this.maxJobs), truncated: jobs.length > this.maxJobs });
  }

  /** One job, or a refusal. An unknown job is not found rather than guessed at. */
  readJob(projectId: unknown, jobId: unknown): RunnerJobRecord {
    const project = this.known(projectId);
    const id = parseRunnerJobId(jobId);
    const found = this.jobs(project).find((job) => job.id === id);
    if (found === undefined) throw new RunnerError('Project ' + project + ' holds no coding job ' + id + '; nothing was changed', 'NOT_FOUND');
    return found;
  }

  /**
   * Submit one validated job. The recipe, the workspace reference and every limit are checked before
   * anything is written, and the workspace is resolved against the project's own root here — so an
   * uncontained reference is refused before a record exists — and again when it is mounted.
   */
  async submit(input: { projectId: unknown; recipe: unknown; workspace: unknown; limits?: unknown; jobId?: unknown }): Promise<RunnerJobRecord> {
    const project = this.known(input.projectId);
    const request = runnerJobRequest({ recipe: input.recipe, workspace: input.workspace, limits: input.limits });
    await this.workspace.resolve({ projectId: project, workspace: request.workspace });
    if (this.jobs(project).length >= this.maxJobs)
      throw new RunnerError(
        'Project ' + project + ' already holds its documented maximum of ' + this.maxJobs + ' coding jobs; settle and inspect them before submitting another; the record is unchanged',
        'BOUNDED'
      );
    const id = input.jobId === undefined ? randomUUID() : parseRunnerJobId(input.jobId);
    return this.writeNew(submittedRunnerJob({ id, projectId: project, request, now: this.clock() }));
  }

  /**
   * Claim the next job for one named owner, with a lease. A job this owner already holds is renewed; a
   * claim whose lease has expired is reclaimed; a job that is running, settled or awaiting an operator
   * is never claimed. Containment is established **before** the claim is written, so an instance that
   * cannot contain a job leaves it unclaimed rather than claiming work it cannot run.
   */
  async claim(input: { projectId: unknown; owner: unknown; expectedJobId?: unknown }): Promise<RunnerJobRecord> {
    const project = this.known(input.projectId);
    const owner = parseRunnerOwner(input.owner);
    const expected = input.expectedJobId === undefined ? undefined : parseRunnerJobId(input.expectedJobId);
    const now = this.clock();
    const verdict = runnerClaimVerdict(this.jobs(project), { owner, now });
    if (verdict.kind === 'refused') throw new RunnerError(verdict.reason, verdict.code);
    // A model-facing caller must not accidentally claim an earlier person's pending job.
    // The ordinary FIFO choice still decides which job is eligible; this is a refusal, not a skip.
    if (expected !== undefined && verdict.job.id !== expected)
      throw new RunnerError('A different coding job is at the head of the queue; the requested job was not claimed', 'CONFLICT');
    assertRunnerContainment(await this.port.establish());
    const head = verdict.job;
    const claim: RunnerClaim = Object.freeze({
      owner,
      claimedAt: verdict.kind === 'renew' ? head.claim!.claimedAt : iso(now),
      leaseExpiresAt: iso(new Date(now.getTime() + this.leaseMs))
    });
    const next = nextRunnerJob(head, { state: 'claimed', claim, result: null, attention: null, now });
    return this.write(head, next);
  }

  /**
   * Run one claimed job under containment, collect its bounded result and settle it.
   *
   * The order is the whole of the safety argument: containment is established first, then the durable
   * 'running' record is written, and only then does a container start. A conflict on that write — a
   * settle or another claim that got there first — means nothing executes. Once 'running' is written,
   * a concurrent settlement does not prevent a later port invocation. A port that cannot report leaves
   * no result; settlement records operator attention without proving termination or preventing dispatch.
   */
  async run(input: { projectId: unknown; jobId: unknown; owner: unknown; signal?: AbortSignal; beforeExecute?:()=>Promise<void> }): Promise<RunnerJobRecord> {
    const project = this.known(input.projectId);
    const jobId = parseRunnerJobId(input.jobId);
    const owner = parseRunnerOwner(input.owner);
    const current = this.readJob(project, jobId);
    const verdict = runnerRunVerdict(current, { owner, now: this.clock() });
    if (verdict.kind === 'refused') throw new RunnerError(verdict.reason, verdict.code);
    const workspace = await this.workspace.resolve({ projectId: project, workspace: current.workspace });
    const containment = await this.port.establish();
    assertRunnerContainment(containment);
    assertRunnerLimits(current.limits, containment);
    await input.beforeExecute?.();
    const liveVerdict=runnerRunVerdict(current,{owner,now:this.clock()});
    if(liveVerdict.kind==='refused')throw new RunnerError(liveVerdict.reason,liveVerdict.code);
    if (input.signal?.aborted) throw new RunnerError('The run was cancelled before it started; the job remains claimed and nothing executed', 'ILLEGAL');
    const running = await this.write(current, nextRunnerJob(current, { state: 'running', claim: current.claim, result: null, attention: null, now: this.clock() }));
    await input.beforeExecute?.();
    const finalVerdict=runnerRunVerdict(current,{owner,now:this.clock()});
    if(finalVerdict.kind==='refused')throw new RunnerError('The claim expired after admission; reconcile the durable job before retrying.', 'UNAVAILABLE');
    if (input.signal?.aborted) throw new RunnerError('The run was cancelled after admission; reconcile its durable state before trying again.', 'UNAVAILABLE');
    const execution = await this.execute(running, workspace, input.signal);
    const result = this.resultOf(running, execution);
    return this.write(running, nextRunnerJob(running, { state: 'settled', claim: running.claim, result, attention: null, now: this.clock() }));
  }

  /**
   * Settle one job from what the durable record proves:
   *
   * - a valid running record has no result; a running record with a result is corrupt and refused;
   * - a run that began and reported nothing becomes the named operator-attention state
   *   'job-interrupted' — whether it executed cannot be established, and it is never re-run;
   * - a job that was claimed and never started becomes 'job-not-run', which the record proves because a
   *   run writes 'running' before it starts a container;
   * - a job that is already settled or awaiting an operator is a no-op, and a pending job has nothing
   *   to settle.
   *
   * It executes nothing, and it is the same primitive the start-time reconciliation uses.
   */
  async settle(input: { projectId: unknown; jobId: unknown }): Promise<RunnerSettleResult> {
    const project = this.known(input.projectId);
    const jobId = parseRunnerJobId(input.jobId);
    const current = this.readJob(project, jobId);
    const verdict = runnerSettleVerdict(current);
    if (verdict.kind === 'refused') throw new RunnerError(verdict.reason, verdict.code);
    if (verdict.kind === 'unchanged') return Object.freeze({ record: current, outcome: 'unchanged' as const, changed: false });
    const now = this.clock();
    const next = verdict.kind === 'settle'
      ? nextRunnerJob(current, { state: 'settled', claim: current.claim, result: current.result, attention: null, now })
      : nextRunnerJob(current, {
        state: 'attention',
        claim: current.claim,
        result: null,
        attention: Object.freeze({ reason: verdict.reason, detail: RUNNER_ATTENTION_DETAILS[verdict.reason] }),
        now
      });
    const record = await this.write(current, next);
    return Object.freeze({ record, outcome: verdict.kind === 'settle' ? 'settled' : 'attention', changed: true });
  }

  /**
   * Reconcile every job a previous process left behind, deterministically and idempotently:
   *
   * - a valid running record carries no result; a running record with a result fails validation;
   * - a job that is running without a result becomes 'job-interrupted', the named operator-attention
   *   state: whether it executed cannot be established, and it is never re-run;
   * - anything else is left exactly as it is. A claimed job is not touched: its lease is the whole of
   *   the liveness evidence, and a claim whose lease has expired is reclaimable by an ordinary claim.
   */
  async reconcile(projectId?: unknown): Promise<RunnerReconciliation> {
    const projects = projectId === undefined ? this.projects() : [this.known(projectId)];
    let settled = 0, attention = 0, unchanged = 0;
    for (const project of projects) {
      for (const job of this.jobs(project)) {
        if (job.state !== 'running') continue;
        try {
          const answer = await this.settle({ projectId: project, jobId: job.id });
          if (answer.outcome === 'settled') settled += 1;
          else if (answer.outcome === 'attention') attention += 1;
          else unchanged += 1;
        } catch (error) {
          // Another writer moved this job while this reconciliation was planning its write. The store
          // picked one winner; this reconciliation claims nothing about what it did not write.
          if (error instanceof RunnerError && error.code === 'CONFLICT') { unchanged += 1; continue; }
          throw error;
        }
      }
    }
    return Object.freeze({ settled, attention, unchanged });
  }

  /** The projects that hold coding jobs, read-only. */
  projects(): readonly string[] {
    const rows = this.rows('SELECT DISTINCT project_id FROM operations WHERE kind=? ORDER BY project_id', [OPERATION_KIND]);
    return Object.freeze(rows.map((row) => String(row.project_id)));
  }

  /**
   * Run one job under the port, with the wall clock enforced here rather than by the port alone.
   *
   * The broker aborts at the job's own timeout and then waits a bounded grace for the port to report
   * what it had. A port that does not report cannot hold the job open. A timeout is settled only
   * when the port confirms termination; aborting a request is not proof that the job stopped. Otherwise
   * the durable running job remains uncertain and requires inspection.
   */
  private async execute(job: RunnerJobRecord, workspace: string, signal?: AbortSignal): Promise<RunnerOutcomeReport> {
    const controller = new AbortController();
    const started = Date.now(), startedAt = new Date(started).toISOString();
    let timedOut = false, cancelled = false;
    const cancel = () => { cancelled = true; controller.abort(); };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { if (!cancelled) { timedOut = true; controller.abort(); } }, job.limits.timeoutMs);
    const attempt: Promise<Attempt> = this.port
      .execute({ job, workspace, containerName: 'pilot-runner-' + job.id, signal: controller.signal })
      .then(
        (execution) => ({ ok: true as const, execution }),
        (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error : new Error(String(error)) })
      );
    const graceMs = Math.min(RUNNER_ABORT_GRACE_MS, Math.max(50, Math.round(job.limits.timeoutMs / 10)));
    let reported: Attempt | null = null;
    try {
      reported = await Promise.race([attempt, afterAbort(controller.signal, graceMs)]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
    // A cancellation can race the container's exit or stop operation. Do not assert that the test
    // succeeded or that its effects were undone; leave the durable running record for reconciliation.
    if (cancelled) throw new RunnerError('The job was cancelled after admission; its effects are uncertain. Inspect and settle it; it is never re-run automatically.', 'UNAVAILABLE');
    if (reported === null || !reported.ok) {
      const detail = reported === null ? 'it did not report within the bounded grace after abort' : reported.error.message;
      console.error('The execution port could not report the outcome of coding job ' + job.id + ': ' + detail);
      throw new RunnerError(
        'The execution port could not report the outcome of job ' + job.id + ', so no result was recorded. The job stays running and needs an operator to settle it; it is never re-run automatically. The port\'s own error was logged on the server and is not repeated here.',
        'UNAVAILABLE'
      );
    }
    const execution = reported.execution;
    if ((timedOut || execution.timedOut) && execution.terminationConfirmed !== true)
      throw new RunnerError('Timeout termination was not confirmed; the job may still be running. Inspect and settle it; do not retry automatically.', 'UNAVAILABLE');
    return Object.freeze({
      execution: Object.freeze({
        ...execution,
        exitCode: timedOut ? null : execution.exitCode,
        timedOut: timedOut || execution.timedOut,
        startedAt: execution.startedAt === '' ? startedAt : execution.startedAt,
        endedAt: execution.endedAt === '' ? iso(new Date()) : execution.endedAt,
        durationMs: execution.durationMs >= 0 ? execution.durationMs : Date.now() - started
      }),
      startedAt,
      durationMs: Date.now() - started
    });
  }

  /** The bounded result one execution produced, with each stream cut to the job's own cap. */
  private resultOf(job: RunnerJobRecord, report: RunnerOutcomeReport): RunnerJobResult {
    const execution = report.execution;
    const stdout = truncateRunnerOutput(execution.stdout, job.limits.outputBytes);
    const stderr = truncateRunnerOutput(execution.stderr, job.limits.outputBytes);
    const timedOut = execution.timedOut;
    const outcome = timedOut ? 'timed-out' as const : execution.exitCode === 0 ? 'succeeded' as const : 'failed' as const;
    const endedAt = execution.endedAt;
    const startedAt = execution.startedAt;
    return Object.freeze({
      recipe: job.recipe,
      outcome,
      exitCode: timedOut ? null : execution.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: execution.stdoutBytes,
      stderrBytes: execution.stderrBytes,
      truncated: stdout.truncated || stderr.truncated || execution.stdoutTruncated === true || execution.stderrTruncated === true,
      capBytes: job.limits.outputBytes,
      durationMs: execution.durationMs,
      startedAt,
      endedAt: Date.parse(endedAt) < Date.parse(startedAt) ? startedAt : endedAt,
      commands: Object.freeze([Object.freeze({ recipe: job.recipe, argv: RUNNER_RECIPE_COMMANDS[job.recipe] })])
    });
  }

  /** The one write path for a brand-new job: one admission at the first revision, and the store's verdict. */
  private async writeNew(record: RunnerJobRecord): Promise<RunnerJobRecord> {
    return this.admit(record);
  }

  /** The one write path for a new revision: the store's unique index is the compare-and-swap. */
  private async write(current: RunnerJobRecord, next: RunnerJobRecord): Promise<RunnerJobRecord> {
    if (next.revision !== current.revision + 1) throw new RunnerError('A coding job revision must be the next one after the record it replaces', 'INVALID');
    return this.admit(next);
  }

  private async admit(next: RunnerJobRecord): Promise<RunnerJobRecord> {
    // The yield is deliberate: it makes the window between this operation's read and the store's own
    // transaction real, so the revision really is decided by the unique index and not by the fact that
    // one JavaScript task happened to run to completion first.
    await Promise.resolve();
    let admitted: { operation: OperationRecord; outbox: OutboxRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: { projectId: next.projectId, sessionId: RUNNER_CONTROL_SESSION },
        // One key per revision inside this project's own scope: the store's unique index is what makes
        // two writers at the same revision a conflict rather than two records.
        idempotencyKey: 'runner.' + next.id + '.r' + next.revision,
        kind: OPERATION_KIND,
        input: next,
        outbox: { kind: OUTBOX_KIND, payload: { version: 1, projectId: next.projectId, jobId: next.id, revision: next.revision } }
      });
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new RunnerError('Coding job ' + next.id + ' revision ' + next.revision + ' was already written by another writer (' + error.message + '); the record is unchanged', 'CONFLICT');
      throw new RunnerError('The durable store refused the coding job write: ' + (error as Error).message, 'STORAGE');
    }
    if (admitted.existing)
      throw new RunnerError('Coding job ' + next.id + ' revision ' + next.revision + ' was already written; the record is unchanged', 'CONFLICT');
    return next;
  }

  /** Every job of one project, in submission order, each at its latest revision. */
  private jobs(projectId: string): RunnerJobRecord[] {
    const scope = this.scopeOf(projectId);
    const rows = this.rows('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid', [projectId, RUNNER_CONTROL_SESSION, OPERATION_KIND]);
    const order: string[] = [];
    const latest = new Map<string, RunnerJobRecord>();
    for (const row of rows) {
      const record = this.decode(String(row.id), scope);
      if (!latest.has(record.id)) order.push(record.id);
      const held = latest.get(record.id);
      if (held === undefined || record.revision > held.revision) latest.set(record.id, record);
      else if (record.revision === held.revision) throw new RunnerError('Corrupt runner storage: two records of job ' + record.id + ' share revision ' + record.revision, 'CORRUPT');
    }
    return order.map((id) => latest.get(id)!);
  }

  /** A project id this instance really has, or a refusal. Nothing is read or written for an unknown one. */
  private known(projectId: unknown): string {
    const project = parseRunnerIdentifier(projectId, 'projectId');
    if (!this.projectKnown(project))
      throw new RunnerError('Project ' + project + ' is not registered on this instance, so it holds no coding jobs; nothing was read and nothing was changed', 'NOT_FOUND');
    return project;
  }

  private scopeOf(projectId: string): ControlScope {
    return { projectId, sessionId: RUNNER_CONTROL_SESSION };
  }

  private decode(operationId: string, scope: ControlScope): RunnerJobRecord {
    let operation: OperationRecord;
    try {
      operation = this.store.getOperation(operationId, scope);
    } catch (error) {
      throw new RunnerError('The durable store could not read coding job operation ' + operationId + ': ' + (error as Error).message, 'STORAGE');
    }
    if (operation.kind !== OPERATION_KIND) throw new RunnerError('Runner storage holds an unexpected operation kind', 'CORRUPT');
    let record: RunnerJobRecord;
    try {
      record = validateRunnerJobRecord(operation.input, 'CORRUPT');
    } catch (error) {
      throw new RunnerError('A stored coding job record is corrupt: ' + (error as Error).message, 'CORRUPT');
    }
    if (record.projectId !== scope.projectId) throw new RunnerError('A stored coding job record is outside its own scope', 'CORRUPT');
    const outbox = this.outboxFor(operation.id, scope);
    if (outbox.kind !== OUTBOX_KIND) throw new RunnerError('Runner storage holds an unexpected outbox kind', 'CORRUPT');
    if (outbox.state !== 'pending') throw new RunnerError('A coding job outbox must stay pending for the life of the record', 'CORRUPT');
    const payload = outbox.payload as { version?: unknown; projectId?: unknown; jobId?: unknown; revision?: unknown } | null;
    if (!payload || typeof payload !== 'object' || payload.version !== 1 || payload.projectId !== record.projectId || payload.jobId !== record.id || payload.revision !== record.revision)
      throw new RunnerError('The stored coding job outbox payload does not describe its record', 'CORRUPT');
    return record;
  }

  private outboxFor(operationId: string, scope: ControlScope): OutboxRecord {
    const rows = this.rows('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2', [operationId]);
    if (rows.length !== 1) throw new RunnerError('Runner storage holds no unambiguous outbox row for one of its operations', 'CORRUPT');
    try {
      return this.store.getOutbox(String(rows[0].id), scope);
    } catch (error) {
      throw new RunnerError('The durable store could not read a coding job outbox: ' + (error as Error).message, 'STORAGE');
    }
  }

  /** Read-only SELECTs over the reviewed control schema; every record is read back through the store's own getters. */
  private rows(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try {
      return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    } catch (error) {
      throw new RunnerError('The durable control store could not be read: ' + (error as Error).message, 'STORAGE');
    }
  }
}

/** One execution attempt, discriminated so a port that could not report is never confused with one that did. */
type Attempt = { readonly ok: true; readonly execution: RunnerExecution } | { readonly ok: false; readonly error: Error };

/**
 * What one run reported to the broker. A missing port report remains uncertain and is never a result.
 */
type RunnerOutcomeReport = {
  readonly execution: RunnerExecution;
  readonly startedAt: string;
  readonly durationMs: number;
};

/** A promise that resolves only once the signal aborts, then waits the bounded grace. */
function afterAbort(signal: AbortSignal, graceMs: number): Promise<null> {
  return new Promise<null>((done) => {
    const finish = () => setTimeout(() => done(null), graceMs);
    if (signal.aborted) { finish(); return; }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * How a job's workspace reference becomes a host path: it must be a relative reference inside the
 * registered project's own root, with no symlink anywhere in it, and the directory it names must exist
 * and still canonicalise inside that root. Anything else is refused — never resolved and rewritten.
 *
 * The project's own root is the approved root, and it is the *tightest* one available: a job can only
 * ever see the project it was submitted against, and never the approved browse roots, another project,
 * or any host path. The reference itself is what the durable record holds; no absolute path is stored.
 */
export function createProjectWorkspaceResolver(input: { readonly projectRoot: (projectId: string) => string | undefined }): RunnerWorkspaceResolver {
  return {
    async resolve({ projectId, workspace }) {
      const root = input.projectRoot(projectId);
      if (root === undefined)
        throw new RunnerError('Project ' + projectId + ' is not registered, so it has no approved root to run a job in; the record is unchanged', 'NOT_FOUND');
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(root);
      } catch {
        throw new RunnerError('The registered root of project ' + projectId + ' cannot be resolved to a directory, so no job can run in it', 'NOT_FOUND');
      }
      let target: string;
      try {
        target = await safePath(canonicalRoot, workspace);
      } catch (error) {
        throw new RunnerError(
          'The workspace reference is refused: ' + (error as Error).message + '. A job workspace is a relative path inside the registered project root, with no symlink in it.',
          'OUTSIDE_ROOT'
        );
      }
      let canonical: string;
      try {
        canonical = await realpath(target);
      } catch {
        throw new RunnerError('The workspace reference does not name an existing directory inside the registered project root', 'NOT_FOUND');
      }
      if (!within(canonicalRoot, canonical))
        throw new RunnerError('The workspace reference resolves outside the registered project root, so it is refused; nothing was mounted and nothing was run', 'OUTSIDE_ROOT');
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new RunnerError('The workspace reference does not name a directory, so there is nothing to mount', 'INVALID');
      return canonical;
    }
  };
}

export type DockerRunnerOptions = {
  /** The image built from deploy/runner/Dockerfile. An absent or unusable one refuses every job. */
  readonly image?: string;
  /** The container CLI binary. It is configured, never discovered from a caller's request. */
  readonly docker?: string;
  readonly user?: string;
  readonly tmpfsBytes?: number;
};

/**
 * The command line one job runs under. It is built here, from the recipe allowlist and the job's own
 * bounded limits, and there is no other place a container is started. Every flag is one of the
 * properties the broker requires:
 *
 * - \`--network none\`: no interface at all, so a job cannot reach the network, a provider or a service
 *   on the host;
 * - \`--read-only\`: the image and everything outside the single mount cannot be modified;
 * - \`--user <non-root>\` plus the image's own user: the job never runs as uid 0 in its namespace;
 * - \`--cap-drop ALL\` and \`--security-opt no-new-privileges\`: no capability is kept and none can be
 *   gained from a setuid binary;
 * - no \`-v /var/run/docker.sock\` anywhere: the runtime's own socket is root on the host;
 * - one \`--volume <workspace>:/workspace:rw\` and nothing else: the job sees exactly the directory it
 *   was given, at a fixed path, and no other host path;
 * - \`--pids-limit\`, \`--memory\` (with \`--memory-swap\` pinned to the same value so swap cannot exceed
 *   it), \`--cpus\`: the hard resource caps the job's limits asked for;
 * - \`--tmpfs /tmp\` bounded: a read-only root filesystem still needs somewhere to write, and it must not
 *   be the host.
 */
export function dockerRunArgv(input: {
  readonly image: string;
  readonly user: string;
  readonly tmpfsBytes: number;
  readonly workspace: string;
  readonly containerName: string;
  readonly limits: RunnerLimits;
  readonly recipe: RunnerRecipeId;
}): readonly string[] {
  return Object.freeze([
    'run',
    '--rm',
    '--sig-proxy=false',
    '--name', input.containerName,
    '--network', 'none',
    '--read-only',
    '--user', input.user,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(input.limits.pids),
    '--memory', String(input.limits.memoryBytes) + 'b',
    '--memory-swap', String(input.limits.memoryBytes) + 'b',
    '--cpus', String(input.limits.cpus),
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=' + input.tmpfsBytes,
    '--volume', input.workspace + ':' + RUNNER_CONTAINER_WORKSPACE_PATH + ':rw',
    '--workdir', RUNNER_CONTAINER_WORKSPACE_PATH,
    input.image,
    ...RUNNER_RECIPE_COMMANDS[input.recipe]
  ]);
}

/**
 * The legacy Docker execution port is unavailable. It cannot authenticate a container's identity
 * during cancellation or prove a wall-clock termination bound; neither establish nor execute starts
 * a process. Tests can inject a separate synthetic port. The command-line builder is retained for
 * inspection, not as evidence of containment.
 */
export function dockerRunnerPort(options: DockerRunnerOptions = {}): RunnerPort {
  const image = (options.image ?? '').trim();
  // A configuration value is validated once, here: an image reference that could be read as a flag or
  // that carries whitespace is refused rather than passed to a command line.
  const usable = image !== '' && image.length <= 200 && !/\s/.test(image) && !image.startsWith('-') && !/[\u0000-\u001f\u007f]/.test(image);
  const unusableReason = image === ''
    ? 'no runner image is configured'
    : 'the configured runner image reference is not a plain image name';
  return {
    async establish(): Promise<RunnerContainment> {
      if (!usable)
        throw new RunnerError(
          'The coding runner cannot contain a job: ' + unusableReason +
            '. Build deploy/runner/Dockerfile and set DASHBOARD_RUNNER_IMAGE to it. Nothing was run, and nothing will be run on the host instead.',
          'UNAVAILABLE'
        );
      // Stopping this CLI cannot establish that its container stopped. Do not claim a wall-clock
      // containment limit, write a claim, or invoke Docker until an identity-bound termination and
      // recovery mechanism is available. The explicit test-only port remains injectable separately.
      throw new RunnerError('The Docker runner cannot verify a wall-clock termination bound; no job was claimed or run.', 'UNAVAILABLE');
    },
    async execute(_input: RunnerExecutionRequest): Promise<RunnerExecution> {
      throw new RunnerError('The Docker runner cannot verify a wall-clock termination bound; no job was run.', 'UNAVAILABLE');
    }
  };
}
