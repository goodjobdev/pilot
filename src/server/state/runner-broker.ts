import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { safePath, within } from '../paths';
import { ControlStore, ControlStoreError } from './control-store';
import type { ControlScope, OperationRecord, OutboxRecord } from '../../shared/control-state';
import {
  RUNNER_ATTENTION_DETAILS, RUNNER_CONTAINER_WORKSPACE_PATH, RUNNER_DEFAULT_LEASE_MS, RUNNER_LIMIT_BOUNDS, RUNNER_MAX_JOBS,
  RUNNER_MAX_LEASE_MS, RUNNER_MAX_OUTPUT_BYTES, RUNNER_RECIPE_COMMANDS, RUNNER_WORKSPACE_MOUNT, RunnerError,
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
 *    execution), and 'running' means an execution may have happened. The run-versus-settle race is
 *    decided by the store's compare-and-swap: whoever loses writes nothing and executes nothing.
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
  async submit(input: { projectId: unknown; recipe: unknown; workspace: unknown; limits?: unknown }): Promise<RunnerJobRecord> {
    const project = this.known(input.projectId);
    const request = runnerJobRequest({ recipe: input.recipe, workspace: input.workspace, limits: input.limits });
    await this.workspace.resolve({ projectId: project, workspace: request.workspace });
    if (this.jobs(project).length >= this.maxJobs)
      throw new RunnerError(
        'Project ' + project + ' already holds its documented maximum of ' + this.maxJobs + ' coding jobs; settle and inspect them before submitting another; the record is unchanged',
        'BOUNDED'
      );
    return this.writeNew(submittedRunnerJob({ id: randomUUID(), projectId: project, request, now: this.clock() }));
  }

  /**
   * Claim the next job for one named owner, with a lease. A job this owner already holds is renewed; a
   * claim whose lease has expired is reclaimed; a job that is running, settled or awaiting an operator
   * is never claimed. Containment is established **before** the claim is written, so an instance that
   * cannot contain a job leaves it unclaimed rather than claiming work it cannot run.
   */
  async claim(input: { projectId: unknown; owner: unknown }): Promise<RunnerJobRecord> {
    const project = this.known(input.projectId);
    const owner = parseRunnerOwner(input.owner);
    const now = this.clock();
    const verdict = runnerClaimVerdict(this.jobs(project), { owner, now });
    if (verdict.kind === 'refused') throw new RunnerError(verdict.reason, verdict.code);
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
   * settle or another claim that got there first — means nothing executes. A port that cannot report
   * leaves the job 'running' with no result rather than inventing an outcome, and an operator settles
   * it from there.
   */
  async run(input: { projectId: unknown; jobId: unknown; owner: unknown }): Promise<RunnerJobRecord> {
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
    const running = await this.write(current, nextRunnerJob(current, { state: 'running', claim: current.claim, result: null, attention: null, now: this.clock() }));
    const execution = await this.execute(running, workspace);
    const result = this.resultOf(running, execution);
    return this.write(running, nextRunnerJob(running, { state: 'settled', claim: running.claim, result, attention: null, now: this.clock() }));
  }

  /**
   * Settle one job from what the durable record proves:
   *
   * - a run that reported a result becomes 'settled' with that result;
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
   * - a job that is running and carries a result is settled on that result, so the outcome a crash
   *   interrupted before the settlement write is completed rather than lost;
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
   * what it had: a port that honours the abort reports promptly, and a port that does not cannot hold
   * the job open. A timeout is a known outcome — this build stopped the run — so it is recorded as
   * 'timed-out' with no exit code. A port that could not report at all leaves the outcome unknown and
   * nothing is recorded.
   */
  private async execute(job: RunnerJobRecord, workspace: string): Promise<RunnerOutcomeReport> {
    const controller = new AbortController();
    const started = Date.now(), startedAt = new Date(started).toISOString();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, job.limits.timeoutMs);
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
    }
    if (reported === null || !reported.ok) {
      // The port reported nothing. If this build aborted the run, the outcome is known: it was stopped
      // at its wall clock, and the broker still knows when it started and how long it waited. Otherwise
      // the outcome cannot be established, and nothing is recorded.
      if (!timedOut) {
        const detail = reported === null ? 'it did not report within the bounded grace after the run was stopped' : reported.error.message;
        console.error('The execution port could not report the outcome of coding job ' + job.id + ': ' + detail);
        throw new RunnerError(
          'The execution port could not report the outcome of job ' + job.id + ', so no result was recorded. The job stays running and needs an operator to settle it; it is never re-run automatically. The port\'s own error was logged on the server and is not repeated here.',
          'UNAVAILABLE'
        );
      }
      return Object.freeze({ execution: null, startedAt, durationMs: Date.now() - started });
    }
    const execution = reported.execution;
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
    const stdout = truncateRunnerOutput(execution?.stdout ?? '', job.limits.outputBytes);
    const stderr = truncateRunnerOutput(execution?.stderr ?? '', job.limits.outputBytes);
    const timedOut = execution === null || execution.timedOut;
    const outcome = timedOut ? 'timed-out' as const : execution.exitCode === 0 ? 'succeeded' as const : 'failed' as const;
    const endedAt = execution?.endedAt ?? iso(this.clock());
    const startedAt = execution?.startedAt ?? report.startedAt;
    return Object.freeze({
      recipe: job.recipe,
      outcome,
      exitCode: timedOut ? null : execution.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: execution?.stdoutBytes ?? 0,
      stderrBytes: execution?.stderrBytes ?? 0,
      truncated: stdout.truncated || stderr.truncated || execution?.stdoutTruncated === true || execution?.stderrTruncated === true,
      capBytes: job.limits.outputBytes,
      // A port that reported nothing still leaves the broker's own observation: when the run started and
      // how long it waited are facts this build has, so they are recorded rather than zeroed.
      durationMs: execution?.durationMs ?? report.durationMs,
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
 * What one run reported to the broker: the port's own report when there was one, and — always — when
 * this build started the run and how long it waited. A run stopped at its wall clock therefore still
 * records a real duration and start instant, even when the port could say nothing.
 */
type RunnerOutcomeReport = {
  readonly execution: RunnerExecution | null;
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

/** The docker CLI is a bounded subprocess like any other: every call has a timeout and a captured bound. */
const DOCKER_CLI_TIMEOUT_MS = 20_000;
/** How long a stopped container is given to disappear before its client process is killed outright. */
const DOCKER_KILL_GRACE_MS = 1_000;
/** The writable tmpfs a read-only root filesystem needs, bounded so it cannot fill the host. */
const DOCKER_TMPFS_BYTES = 16 * 1024 * 1024;
/** The non-root user the runner image is built with, passed explicitly so the property is never implicit. */
const DOCKER_RUNNER_USER = '10001:10001';

export type DockerRunnerOptions = {
  /** The image built from deploy/runner/Dockerfile. An absent or unusable one refuses every job. */
  readonly image?: string;
  /** The container CLI binary. It is configured, never discovered from a caller's request. */
  readonly docker?: string;
  readonly user?: string;
  readonly tmpfsBytes?: number;
};

/** One CLI invocation's bounded result. It never throws: a missing binary is a result like any other. */
type CliResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly error: Error | null };
function runCli(binary: string, args: readonly string[], timeoutMs: number): Promise<CliResult> {
  return new Promise<CliResult>((done) => {
    let settled = false;
    const finish = (result: CliResult) => { if (settled) return; settled = true; clearTimeout(timer); done(result); };
    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = captureStream(child.stdout, 4_096), err = captureStream(child.stderr, 4_096);
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: null, stdout: out.text, stderr: err.text, error: new Error('the container CLI did not answer within ' + timeoutMs + 'ms') }); }, timeoutMs);
    child.on('error', (error) => finish({ code: null, stdout: out.text, stderr: err.text, error }));
    child.on('close', (code) => finish({ code, stdout: out.text, stderr: err.text, error: null }));
  });
}

type Capture = { text: string; bytes: number; truncated: boolean };
/** Capture one stream, counting every byte and storing at most the cap. */
function captureStream(stream: NodeJS.ReadableStream, cap: number): Capture {
  const capture: Capture = { text: '', bytes: 0, truncated: false };
  stream.on('data', (chunk: Buffer) => {
    capture.bytes += chunk.byteLength;
    if (capture.truncated) return;
    const cut = truncateRunnerOutput(capture.text + chunk.toString('utf8'), cap);
    capture.text = cut.text;
    if (cut.truncated) capture.truncated = true;
  });
  return capture;
}
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

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
 * The real execution port: a container created from the configured image, with the documented
 * properties, one mount and hard limits.
 *
 * \`establish\` verifies the runtime answers and the image is present, and reports the properties the
 * next run will enforce together with the largest limits the runtime says it can enforce. \`execute\`
 * starts the container, captures its bounded output and stops it by name when this build aborts the
 * run. A missing binary, an unreachable runtime or a missing image refuses every job with a clear,
 * path-free reason — nothing is ever run on the host instead.
 */
export function dockerRunnerPort(options: DockerRunnerOptions = {}): RunnerPort {
  const docker = (options.docker ?? '').trim() === '' ? 'docker' : (options.docker as string).trim();
  const image = (options.image ?? '').trim();
  const user = (options.user ?? '').trim() === '' ? DOCKER_RUNNER_USER : (options.user as string).trim();
  const tmpfsBytes = options.tmpfsBytes ?? DOCKER_TMPFS_BYTES;
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
      const version = await runCli(docker, ['version', '--format', '{{.Server.Version}}'], DOCKER_CLI_TIMEOUT_MS);
      if (version.code !== 0) {
        if (version.error !== null || version.stderr.trim() !== '') console.error('The container CLI ' + docker + ' did not answer: ' + (version.error?.message ?? version.stderr.trim().slice(0, 400)));
        throw new RunnerError(
          'The container runtime did not answer, so no job can be contained. Nothing was run, and nothing will be run on the host instead. The runtime\'s own error was logged on the server and is not repeated here.',
          'UNAVAILABLE'
        );
      }
      const inspected = await runCli(docker, ['image', 'inspect', image, '--format', '{{.Id}}'], DOCKER_CLI_TIMEOUT_MS);
      if (inspected.code !== 0 || inspected.stdout.trim() === '')
        throw new RunnerError(
          'The runner image ' + image + ' is not present in the container runtime, so no job can be contained. Build deploy/runner/Dockerfile and load it, or correct DASHBOARD_RUNNER_IMAGE. Nothing was run.',
          'UNAVAILABLE'
        );
      const memory = await runCli(docker, ['info', '--format', '{{.MemTotal}}'], DOCKER_CLI_TIMEOUT_MS);
      const cpus = await runCli(docker, ['info', '--format', '{{.NCPU}}'], DOCKER_CLI_TIMEOUT_MS);
      const maxMemoryBytes = wholeNumber(memory.stdout), maxCpus = wholeNumber(cpus.stdout);
      if (maxMemoryBytes === null || maxCpus === null)
        throw new RunnerError(
          'The container runtime did not report the memory and CPU limits it can enforce, so this build cannot promise a job is bounded and will not run one. Nothing was run.',
          'UNAVAILABLE'
        );
      return Object.freeze({
        runtime: 'docker',
        image,
        network: 'none',
        rootFilesystem: 'read-only' as const,
        user,
        capabilities: 'none',
        noNewPrivileges: true,
        dockerSocket: false,
        mounts: Object.freeze([RUNNER_WORKSPACE_MOUNT]),
        // The runtime's own ceiling, and never more than this build documents: a job asking for more
        // than either is refused rather than quietly given less.
        maxMemoryBytes: Math.min(maxMemoryBytes, RUNNER_LIMIT_BOUNDS.memoryBytes.max),
        maxCpus: Math.min(maxCpus, RUNNER_LIMIT_BOUNDS.cpus.max),
        maxPids: RUNNER_LIMIT_BOUNDS.pids.max,
        maxWallClockMs: RUNNER_LIMIT_BOUNDS.timeoutMs.max
      });
    },
    async execute(input: RunnerExecutionRequest): Promise<RunnerExecution> {
      const started = Date.now(), startedAt = new Date(started).toISOString();
      const argv = dockerRunArgv({
        image,
        user,
        tmpfsBytes,
        workspace: input.workspace,
        containerName: input.containerName,
        limits: input.job.limits,
        recipe: input.job.recipe
      });
      const child = spawn(docker, [...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
      const out = captureStream(child.stdout, RUNNER_MAX_OUTPUT_BYTES), err = captureStream(child.stderr, RUNNER_MAX_OUTPUT_BYTES);
      let aborted = false;
      const stop = () => {
        aborted = true;
        // The container is stopped by name and then removed, so a run this build aborted cannot keep
        // running: killing the CLI alone would leave the container alive on the runtime.
        void runCli(docker, ['kill', input.containerName], DOCKER_CLI_TIMEOUT_MS)
          .then(() => runCli(docker, ['rm', '-f', input.containerName], DOCKER_CLI_TIMEOUT_MS))
          .catch(() => { /* the container may already be gone */ });
        const hard = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, DOCKER_KILL_GRACE_MS);
        if (typeof hard.unref === 'function') hard.unref();
      };
      if (input.signal.aborted) stop();
      else input.signal.addEventListener('abort', stop, { once: true });
      const outcome = await new Promise<{ code: number | null; error: Error | null }>((done) => {
        child.on('error', (error) => done({ code: null, error }));
        child.on('close', (code) => done({ code, error: null }));
      });
      input.signal.removeEventListener('abort', stop);
      if (outcome.error !== null && !aborted) throw outcome.error;
      return Object.freeze({
        exitCode: aborted ? null : outcome.code,
        stdout: out.text,
        stderr: err.text,
        stdoutBytes: out.bytes,
        stderrBytes: err.bytes,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        timedOut: aborted,
        durationMs: Date.now() - started,
        startedAt,
        endedAt: new Date().toISOString()
      });
    }
  };
}
