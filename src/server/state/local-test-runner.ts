import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { z } from 'zod';
import { ControlStore, ControlStoreError } from './control-store';
import type { OperationRecord } from '../../shared/control-state';

/**
 * The installed model-facing test-execution capability: one fixed recipe, run as a child process of
 * this application, with a durable intent and receipt.
 *
 * What this module owns:
 *
 * 1. **One fixed command.** `node --test` with no arguments, in the registered project root, using
 *    the Node executable that runs the application. A caller chooses no command, argument, image or
 *    environment; the only knobs are the wall-clock timeout and the per-stream output cap, both
 *    bounded and refused rather than reduced when a request is out of range.
 * 2. **A durable intent before any process starts.** The intent is one control-store operation in
 *    the reserved `agent-tests` session dimension. The admission guard re-reads versioned authority
 *    inside the store's own write transaction, and the caller's `authorize` runs once more
 *    immediately before `spawn`. A duplicate invocation identity reuses the same operation key, so
 *    it can never start a second process.
 * 3. **A receipt, or an honest `unknown`.** A finished run records its bounded output and outcome. A
 *    timeout, a cancellation or a receipt that cannot be written leaves the operation `unknown` or
 *    `interrupted`: it is never replayed or auto-retried, and `reconcile()` turns an intent left
 *    pending by an earlier process into `unknown` rather than running it again.
 *
 * What this module does **not** provide: containment. The child runs as the application user inside
 * the application container, can read the durable store and the stored credentials and can reach
 * every project, has no cgroup memory or PID limit, and its termination is a best-effort process-
 * group signal. `docs/RUNNER.md` states this in the operator's own words.
 */

/** The reserved control-store session dimension: a test job belongs to a project, not a conversation. */
export const LOCAL_TEST_CONTROL_SESSION = 'agent-tests';
export const LOCAL_TEST_OPERATION_KIND = 'agent-tests.job';
export const LOCAL_TEST_RECIPE = 'test-run';
/** The one command line this build can run. The first element is the application's own Node. */
export const LOCAL_TEST_COMMAND = Object.freeze(['node', '--test'] as const);
export const LOCAL_TEST_TIMEOUT_BOUNDS = Object.freeze({ min: 1_000, max: 600_000, default: 120_000 });
export const LOCAL_TEST_OUTPUT_BOUNDS = Object.freeze({ min: 256, max: 32_768, default: 16_384 });
/** How long a stopped run may take to report its exit before it is recorded as unconfirmed. */
export const LOCAL_TEST_KILL_GRACE_MS = 2_000;
/** The environment a test process receives: a fixed set, never the application's own variables. */
export const LOCAL_TEST_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_ENV'] as const);

const JOB_ID_PATTERN = /^agent-test-[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const INVOCATION_PATTERN = /^[^\u0000-\u001f\u007f]{1,200}$/;

export type LocalTestState = 'pending' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
export type LocalTestOutcome = 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'not-started' | 'unknown';

export type LocalTestLimits = { readonly timeoutMs: number; readonly outputBytes: number };

/** What the durable operation records: the invocation identity and the bounded limits. It is path-free. */
export type LocalTestIntent = {
  readonly version: 1;
  readonly jobId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly taskId: string;
  readonly recipe: 'test-run';
  readonly limits: LocalTestLimits;
};

/** What a finished (or stopped) run reported. Everything stored here is bounded and path-free. */
export type LocalTestReceipt = {
  readonly version: 1;
  readonly jobId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly recipe: 'test-run';
  readonly outcome: LocalTestOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly commands: readonly ['node', '--test'];
  readonly terminationConfirmed: boolean;
  readonly reason: string | null;
  readonly limits: LocalTestLimits;
};

export type LocalTestRunResult = {
  readonly jobId: string;
  /** `completed` has a terminal result; `uncertain` may have run; `refused` did not start. */
  readonly status: 'completed' | 'uncertain' | 'refused';
  readonly state: LocalTestState;
  readonly outcome: LocalTestOutcome | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly commands: readonly string[];
  readonly terminationConfirmed: boolean | null;
  readonly reason: string | null;
  /** One plain-language sentence about what the record proves, or does not prove. */
  readonly note: string;
};

export type LocalTestErrorCode = 'INVALID' | 'REFUSED' | 'UNAVAILABLE' | 'UNCERTAIN';
export class LocalTestError extends Error {
  constructor(message: string, public readonly code: LocalTestErrorCode) {
    super(message);
    this.name = 'LocalTestError';
  }
}

const idSchema = z.string().regex(ID_PATTERN, 'an identifier must be 1-160 characters from A-Za-z0-9._:-');
const invocationSchema = z.string().regex(INVOCATION_PATTERN, 'an invocation identity must be 1-200 printable characters');
const limitsSchema = z.strictObject({
  timeoutMs: z.number().int().min(LOCAL_TEST_TIMEOUT_BOUNDS.min).max(LOCAL_TEST_TIMEOUT_BOUNDS.max),
  outputBytes: z.number().int().min(LOCAL_TEST_OUTPUT_BOUNDS.min).max(LOCAL_TEST_OUTPUT_BOUNDS.max)
});
const intentSchema = z.strictObject({
  version: z.literal(1),
  jobId: z.string().regex(JOB_ID_PATTERN),
  projectId: idSchema,
  agentId: idSchema,
  conversationId: invocationSchema,
  taskId: invocationSchema,
  recipe: z.literal('test-run'),
  limits: limitsSchema
});
const receiptSchema = z.strictObject({
  version: z.literal(1),
  jobId: z.string().regex(JOB_ID_PATTERN),
  projectId: idSchema,
  agentId: idSchema,
  recipe: z.literal('test-run'),
  outcome: z.enum(['succeeded', 'failed', 'timed-out', 'cancelled', 'not-started', 'unknown']),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(40).nullable(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  commands: z.tuple([z.literal('node'), z.literal('--test')]),
  terminationConfirmed: z.boolean(),
  reason: z.string().max(600).nullable(),
  limits: z.strictObject({
    timeoutMs: z.number().int().positive(),
    outputBytes: z.number().int().positive()
  })
});

function invalid(message: string): LocalTestError {
  return new LocalTestError(message, 'INVALID');
}

function parseIntent(value: unknown): LocalTestIntent {
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) throw invalid('A stored test job intent is not valid bounded data.');
  return Object.freeze({ ...parsed.data, limits: Object.freeze({ ...parsed.data.limits }) }) as LocalTestIntent;
}

function parseReceipt(value: unknown): LocalTestReceipt {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) throw new LocalTestError('A stored test job receipt is not valid bounded data.', 'UNCERTAIN');
  return Object.freeze({ ...parsed.data, commands: Object.freeze(['node', '--test'] as const), limits: Object.freeze({ ...parsed.data.limits }) }) as LocalTestReceipt;
}

/** The stable job id one invocation identity produces. A duplicate call therefore reuses the key. */
export function localTestJobId(input: { readonly projectId: string; readonly conversationId: string; readonly taskId: string }): string {
  const projectId = idSchema.parse(input.projectId), conversationId = invocationSchema.parse(input.conversationId), taskId = invocationSchema.parse(input.taskId);
  return 'agent-test-' + createHash('sha256').update(JSON.stringify([projectId, conversationId, taskId])).digest('hex');
}

/** The bounded limits a request produces: defaults when absent, refused rather than reduced otherwise. */
export function parseLocalTestLimits(value: { readonly timeoutMs?: number; readonly outputBytes?: number } | undefined): LocalTestLimits {
  const candidate = { timeoutMs: value?.timeoutMs ?? LOCAL_TEST_TIMEOUT_BOUNDS.default, outputBytes: value?.outputBytes ?? LOCAL_TEST_OUTPUT_BOUNDS.default };
  const parsed = limitsSchema.safeParse(candidate);
  if (!parsed.success)
    throw invalid('Test limits must be a wall-clock timeout from ' + LOCAL_TEST_TIMEOUT_BOUNDS.min + ' to ' + LOCAL_TEST_TIMEOUT_BOUNDS.max +
      ' ms and an output cap from ' + LOCAL_TEST_OUTPUT_BOUNDS.min + ' to ' + LOCAL_TEST_OUTPUT_BOUNDS.max + ' bytes per stream.');
  return Object.freeze({ timeoutMs: parsed.data.timeoutMs, outputBytes: parsed.data.outputBytes });
}

export type LocalTestRunInput = {
  readonly projectId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly taskId: string;
  /** The registered project root this build found for the project. It is used as the child's cwd. */
  readonly projectRoot: string;
  /** Re-reads versioned authority; throws to refuse. Called before admission and immediately before spawn. */
  readonly authorize: () => void;
  /** Reserves one rolling-hour job through the durable ledger; throws to refuse. Never refunded. */
  readonly reserveJob: () => void;
  readonly limits?: { readonly timeoutMs?: number; readonly outputBytes?: number };
  readonly signal?: AbortSignal;
};

type Capture = { readonly text: string; readonly bytes: number; readonly truncated: boolean };

/** Keep at most `cap` bytes of a stream while still counting everything it produced. */
class BoundedCapture {
  private readonly kept: Buffer[] = [];
  private keptBytes = 0;
  private totalBytes = 0;
  private truncated = false;
  constructor(private readonly cap: number) {}
  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.keptBytes < this.cap) {
      const take = Math.min(this.cap - this.keptBytes, chunk.length);
      this.kept.push(chunk.subarray(0, take));
      this.keptBytes += take;
    }
    if (this.totalBytes > this.cap) this.truncated = true;
  }
  read(): Capture {
    // The receipt is stored as JSON, where a control character escapes to up to six bytes. Replacing
    // everything outside printable ASCII and tab/newline keeps the stored contribution close to the
    // byte cap this class already enforces, so a cap that fits cannot overflow the record bound.
    const raw = Buffer.concat(this.kept).toString('utf8');
    const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?');
    return { text, bytes: this.totalBytes, truncated: this.truncated };
  }
}

type Exit = { readonly code: number | null; readonly signal: string | null };

/** The environment a test process receives: a fixed set copied from the application, never all of it. */
function testEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LOCAL_TEST_ENV_KEYS) {
    if (key === 'NODE_ENV') continue;
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Assigned last so the fixed value is what the recipe really receives: the application image sets
  // NODE_ENV=production, and a suite that branches on it must not run in the deployment's mode while
  // the receipt and the documentation say `test`.
  env.NODE_ENV = 'test';
  return env;
}

function delay(ms: number): Promise<null> {
  return new Promise<null>(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
}

export class LocalTestRunner {
  constructor(private readonly control: ControlStore) {}

  /**
   * Run the fixed recipe once for one invocation identity. Every refusal that happens before the
   * durable intent is admitted throws and leaves no record; everything after it is reported from the
   * record, and never as an implicit success.
   */
  async run(input: LocalTestRunInput): Promise<LocalTestRunResult> {
    const projectId = idSchema.parse(input.projectId), agentId = idSchema.parse(input.agentId);
    const conversationId = invocationSchema.parse(input.conversationId), taskId = invocationSchema.parse(input.taskId);
    const limits = parseLocalTestLimits(input.limits);
    const jobId = localTestJobId({ projectId, conversationId, taskId });
    const scope = { projectId, sessionId: LOCAL_TEST_CONTROL_SESSION };
    const idempotencyKey = 'agent-tests.' + jobId;
    const projectRoot = input.projectRoot;
    let rootIsDirectory: boolean;
    try { rootIsDirectory = statSync(projectRoot).isDirectory(); } catch { rootIsDirectory = false; }
    if (!rootIsDirectory) throw invalid('The registered project root is not a directory; no test job was started.');

    // 1. Nothing is reserved or written for a call whose authority is already gone.
    input.authorize();
    // 2. A duplicate invocation reuses its durable operation; it never starts a second process.
    const existing = this.find(projectId, idempotencyKey);
    if (existing !== undefined) return this.resultOf(existing, 'This invocation already has a durable test job; it was not started again.');
    // 3. One rolling-hour job is reserved before the intent is written and is never refunded.
    input.reserveJob();
    const intent: LocalTestIntent = Object.freeze({ version: 1 as const, jobId, projectId, agentId, conversationId, taskId, recipe: LOCAL_TEST_RECIPE, limits });
    let admitted: OperationRecord;
    try {
      const admission = this.control.admit({
        scope, idempotencyKey, kind: LOCAL_TEST_OPERATION_KIND, input: intent,
        outbox: { kind: LOCAL_TEST_OPERATION_KIND, payload: intent },
        // The authority is re-read inside the durable write transaction.
        guard: () => input.authorize()
      });
      admitted = admission.operation;
      if (admission.existing) return this.resultOf(admitted, 'A concurrent call admitted this invocation first; this call did not start a second process.');
    } catch (error) {
      if (error instanceof ControlStoreError)
        throw new LocalTestError('The durable test intent could not be admitted (' + error.message + '); no test job was started.',
          error.code === 'CORRUPT' || error.code === 'SCHEMA' ? 'UNAVAILABLE' : 'REFUSED');
      throw error;
    }

    // 4. The last authority check, immediately before the effect. A revocation here leaves a durable
    //    record that says nothing ran, rather than an invocation that silently disappears.
    if (input.signal?.aborted === true) {
      return this.settle(admitted, 'interrupted', this.preStartReceipt(intent, 'cancelled', 'Cancelled before the fixed command started; nothing ran.'));
    }
    try { input.authorize(); }
    catch (error) {
      const reason = error instanceof Error ? error.message : 'Authority was revoked.';
      this.settle(admitted, 'failed', this.preStartReceipt(intent, 'not-started', 'Authority was revoked immediately before the process start; nothing ran. ' + reason));
      return this.resultOf(this.control.getOperation(admitted.id, scope), null);
    }

    // 5. The one fixed command, in the project root, with its own process group.
    const receipt = await this.execute({ intent, projectRoot, signal: input.signal });
    const state: LocalTestState = receipt.outcome === 'succeeded' ? 'succeeded'
      : receipt.outcome === 'failed' || receipt.outcome === 'not-started' ? 'failed'
        : receipt.outcome === 'cancelled' && receipt.terminationConfirmed ? 'interrupted' : 'unknown';
    return this.settle(admitted, state, receipt);
  }

  /** One job's record, or null when this project has no job with that id. */
  read(projectId: string, jobId: string): LocalTestRunResult | null {
    const project = idSchema.parse(projectId);
    if (!JOB_ID_PATTERN.test(jobId)) throw invalid('A test job id has the form agent-test-<hex>.');
    const operation = this.find(project, 'agent-tests.' + jobId);
    return operation === undefined ? null : this.resultOf(operation, null);
  }

  /** Recent jobs for one project, newest first, bounded. Reads the durable operations only. */
  list(projectId: string, limit = 20): readonly LocalTestRunResult[] {
    const project = idSchema.parse(projectId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('A test job list limit is a whole number from 1 to 100.');
    const rows = this.control.db.prepare('SELECT id, session_id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid DESC LIMIT ?')
      .all(project, LOCAL_TEST_CONTROL_SESSION, LOCAL_TEST_OPERATION_KIND, limit) as { id: string; session_id: string }[];
    return Object.freeze(rows.map(row => this.resultOf(this.control.getOperation(row.id, { projectId: project, sessionId: row.session_id }), null)));
  }

  /**
   * A previous process can end while an intent is pending: its process may have started and the
   * result was lost. Each such operation becomes `unknown` once, deterministically, and is never
   * run again. Call this at startup, before this process admits anything.
   */
  reconcile(): { recovered: number } {
    const rows = this.control.db.prepare("SELECT id, project_id, session_id FROM operations WHERE kind=? AND state='pending' ORDER BY rowid")
      .all(LOCAL_TEST_OPERATION_KIND) as { id: string; project_id: string; session_id: string }[];
    let recovered = 0;
    for (const row of rows) {
      const scope = { projectId: row.project_id, sessionId: row.session_id };
      const operation = this.control.getOperation(row.id, scope);
      if (operation.state !== 'pending') continue;
      const intent = parseIntent(operation.input);
      const at = new Date().toISOString();
      try {
        this.control.updateOperation(operation.id, scope, operation.revision, 'unknown', {
          version: 1, jobId: intent.jobId, projectId: intent.projectId, agentId: intent.agentId, recipe: LOCAL_TEST_RECIPE,
          outcome: 'unknown', exitCode: null, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
          stdoutTruncated: false, stderrTruncated: false, durationMs: 0, startedAt: operation.createdAt, endedAt: at,
          commands: ['node', '--test'], terminationConfirmed: false,
          reason: 'The application process ended while this test intent was pending. The run may have started and its result was lost, so it is recorded as unknown and is not re-run.',
          limits: intent.limits
        });
      } catch (error) {
        // Another writer settled it between the read and the write: its receipt is the record.
        if (error instanceof ControlStoreError && error.code === 'CONFLICT') continue;
        throw error;
      }
      recovered++;
    }
    return { recovered };
  }

  private find(projectId: string, idempotencyKey: string): OperationRecord | undefined {
    const row = this.control.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND idempotency_key=?')
      .get(projectId, LOCAL_TEST_CONTROL_SESSION, idempotencyKey) as { id?: unknown } | undefined;
    if (row === undefined || typeof row.id !== 'string') return undefined;
    return this.control.getOperation(row.id, { projectId, sessionId: LOCAL_TEST_CONTROL_SESSION });
  }

  private settle(operation: OperationRecord, state: LocalTestState, receipt: LocalTestReceipt): LocalTestRunResult {
    const scope = { projectId: operation.projectId, sessionId: operation.sessionId };
    if (state === 'pending') throw new Error('A test job cannot be settled as pending.');
    try {
      const stored = this.control.updateOperation(operation.id, scope, operation.revision, state, receipt);
      return this.resultOf(stored, null);
    } catch {
      // A receipt that cannot be stored must not leave the job silently pending. Retry once with the
      // captured output dropped and say so, so the outcome is settled and inspectable.
      try {
        const dropped = Object.freeze({
          ...receipt, stdout: '', stderr: '', stdoutTruncated: true, stderrTruncated: true,
          reason: (receipt.reason ?? '') + ' The recorded output was dropped because it could not be stored within the durable receipt bound.'
        });
        const stored = this.control.updateOperation(operation.id, scope, operation.revision, state, dropped);
        return this.resultOf(stored, 'The run finished but its output could not be stored; the outcome is recorded without it.');
      } catch {
        throw new LocalTestError('The run finished but its durable receipt could not be recorded; the intent remains pending and needs inspection. Do not assume the result was recorded.', 'UNCERTAIN');
      }
    }
  }

  private preStartReceipt(intent: LocalTestIntent, outcome: 'cancelled' | 'not-started', reason: string): LocalTestReceipt {
    const at = new Date().toISOString();
    return Object.freeze({
      version: 1 as const, jobId: intent.jobId, projectId: intent.projectId, agentId: intent.agentId, recipe: LOCAL_TEST_RECIPE,
      outcome, exitCode: null, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
      stdoutTruncated: false, stderrTruncated: false, durationMs: 0, startedAt: at, endedAt: at,
      commands: Object.freeze(['node', '--test'] as const), terminationConfirmed: true, reason, limits: intent.limits
    });
  }

  private resultOf(operation: OperationRecord, note: string | null): LocalTestRunResult {
    const intent = parseIntent(operation.input);
    const receipt = operation.receiptPresent ? parseReceipt(operation.receipt) : null;
    const state: LocalTestState = operation.state;
    const status: LocalTestRunResult['status'] = state === 'succeeded' || state === 'failed'
      ? (receipt?.outcome === 'not-started' ? 'refused' : 'completed')
      : 'uncertain';
    const explained = note ?? receipt?.reason ?? (state === 'pending'
      ? 'This invocation has a durable intent that has not settled. It may be running or may have been interrupted; it is not started again.'
      : receipt?.outcome === 'succeeded'
        ? 'The fixed `node --test` recipe finished with exit code 0. The recorded output is the only evidence this build has.'
        : receipt?.outcome === 'failed'
          ? 'The fixed `node --test` recipe finished with a non-zero exit code. The recorded output is the only evidence this build has.'
          : null);
    return Object.freeze({
      jobId: intent.jobId, status, state,
      outcome: receipt?.outcome ?? null, exitCode: receipt?.exitCode ?? null, signal: receipt?.signal ?? null,
      stdout: receipt?.stdout ?? '', stderr: receipt?.stderr ?? '',
      stdoutBytes: receipt?.stdoutBytes ?? 0, stderrBytes: receipt?.stderrBytes ?? 0,
      stdoutTruncated: receipt?.stdoutTruncated ?? false, stderrTruncated: receipt?.stderrTruncated ?? false,
      durationMs: receipt?.durationMs ?? null, startedAt: receipt?.startedAt ?? null, endedAt: receipt?.endedAt ?? null,
      commands: LOCAL_TEST_COMMAND, terminationConfirmed: receipt?.terminationConfirmed ?? null,
      reason: receipt?.reason ?? null,
      note: explained ?? 'The fixed `node --test` recipe ran. Its recorded receipt is the only outcome this build has.'
    });
  }

  /** Spawn the one fixed command and report what was observed; never reports a run it stopped as success. */
  private async execute(input: { readonly intent: LocalTestIntent; readonly projectRoot: string; readonly signal?: AbortSignal }): Promise<LocalTestReceipt> {
    const { intent, projectRoot, signal } = input;
    const startedAt = new Date();
    const stdout = new BoundedCapture(intent.limits.outputBytes), stderr = new BoundedCapture(intent.limits.outputBytes);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [...LOCAL_TEST_COMMAND.slice(1)], {
        cwd: projectRoot,
        // Its own process group, so a stop can signal the command and everything it started.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: testEnvironment()
      });
    } catch (error) {
      return this.receipt(intent, startedAt, { outcome: 'not-started', exitCode: null, signal: null, stdout: stdout.read(), stderr: stderr.read(), terminationConfirmed: true, reason: 'The fixed test command could not be started (' + ((error as NodeJS.ErrnoException).code ?? 'unknown reason') + '); nothing ran.' });
    }
    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));

    let spawnError: NodeJS.ErrnoException | null = null;
    const exit = new Promise<Exit | null>(resolve => {
      child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      child.once('error', (error: NodeJS.ErrnoException) => { spawnError = error; resolve(null); });
    });

    const killGroup = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* an already-exited or unkillable group is reported, not hidden */ } }
    };

    let stopReason: 'timeout' | 'cancelled' | null = null;
    let stopRequested: () => void = () => {};
    const stopped = new Promise<'timeout' | 'cancelled'>(resolve => { stopRequested = () => resolve(stopReason as 'timeout' | 'cancelled'); });
    const requestStop = (reason: 'timeout' | 'cancelled') => {
      if (stopReason !== null) return;
      stopReason = reason;
      killGroup();
      stopRequested();
    };
    const timer = setTimeout(() => requestStop('timeout'), intent.limits.timeoutMs);
    const onAbort = () => requestStop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) requestStop('cancelled');

    let observed: Exit | null = null;
    let terminationConfirmed = false;
    try {
      const first = await Promise.race([
        exit.then(value => ({ kind: 'exit' as const, value })),
        stopped.then(reason => ({ kind: 'stop' as const, reason }))
      ]);
      observed = first.kind === 'exit' ? first.value : null;
      if (stopReason !== null) {
        // The stop signal was sent; wait a bounded time for the process itself to report its exit.
        const afterStop = await Promise.race([exit, delay(LOCAL_TEST_KILL_GRACE_MS)]);
        terminationConfirmed = afterStop !== null;
        observed = afterStop ?? observed;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // A group this process could not stop must not keep the application (or its tests) alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }

    const base = { stdout: stdout.read(), stderr: stderr.read() };
    if (spawnError !== null) {
      return this.receipt(intent, startedAt, { ...base, outcome: 'not-started', exitCode: null, signal: null, terminationConfirmed: true, reason: 'The fixed test command could not be started (' + ((spawnError as NodeJS.ErrnoException).code ?? 'unknown reason') + '); nothing ran.' });
    }
    if (stopReason === 'timeout') {
      return this.receipt(intent, startedAt, { ...base, outcome: 'timed-out', exitCode: null, signal: observed?.signal ?? null, terminationConfirmed,
        reason: terminationConfirmed
          ? 'The wall-clock limit stopped the run and its process group was signalled. Termination is best-effort, so the outcome is recorded as unknown and is not retried automatically.'
          : 'The wall-clock limit passed but the process did not confirm its exit within the grace period. Its outcome and any child processes are unknown; do not retry automatically.' });
    }
    if (stopReason === 'cancelled') {
      return this.receipt(intent, startedAt, { ...base, outcome: 'cancelled', exitCode: null, signal: observed?.signal ?? null, terminationConfirmed,
        reason: terminationConfirmed
          ? 'This invocation was cancelled and its process group was signalled. Termination is best-effort; inspect before running the tests again.'
          : 'This invocation was cancelled but the process did not confirm its exit within the grace period. It may still be running; inspect before running the tests again.' });
    }
    if (observed === null) {
      return this.receipt(intent, startedAt, { ...base, outcome: 'not-started', exitCode: null, signal: null, terminationConfirmed: false,
        reason: 'The fixed test command reported no exit; nothing is known about what it ran.' });
    }
    if (observed.signal !== null) {
      return this.receipt(intent, startedAt, { ...base, outcome: 'failed', exitCode: null, signal: observed.signal, terminationConfirmed: true,
        reason: 'The fixed test command was terminated by a signal this invocation did not send.' });
    }
    return this.receipt(intent, startedAt, { ...base, outcome: observed.code === 0 ? 'succeeded' : 'failed', exitCode: observed.code, signal: null, terminationConfirmed: true, reason: null });
  }

  private receipt(intent: LocalTestIntent, startedAt: Date, input: {
    readonly outcome: LocalTestOutcome; readonly exitCode: number | null; readonly signal: string | null;
    readonly stdout: Capture; readonly stderr: Capture; readonly terminationConfirmed: boolean; readonly reason: string | null;
  }): LocalTestReceipt {
    const endedAt = new Date();
    const receipt = Object.freeze({
      version: 1 as const, jobId: intent.jobId, projectId: intent.projectId, agentId: intent.agentId, recipe: LOCAL_TEST_RECIPE,
      outcome: input.outcome, exitCode: input.exitCode, signal: input.signal,
      stdout: input.stdout.text, stderr: input.stderr.text, stdoutBytes: input.stdout.bytes, stderrBytes: input.stderr.bytes,
      stdoutTruncated: input.stdout.truncated, stderrTruncated: input.stderr.truncated,
      durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()), startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
      commands: Object.freeze(['node', '--test'] as const), terminationConfirmed: input.terminationConfirmed,
      reason: input.reason, limits: intent.limits
    }) as LocalTestReceipt;
    return receipt;
  }
}
