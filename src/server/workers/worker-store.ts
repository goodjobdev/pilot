import { randomUUID } from 'node:crypto';
import { modelKey, type ModelChoice } from '../../shared/settings';
import type { WorkerModelPolicy } from '../../shared/model-policy';
import { AGENT_TOOL_SCOPES, authorizeToolUse, type AgentScope } from '../../shared/agent-registry';
import {
  WORKER_MAX_MODEL_TURNS, WorkerError, buildWorkerRecord, buildWorkerRun, composeWorkerReport,
  parseWorkerActor, parseWorkerCreate, pinWorkerModel, revokeWorkerRecord, validateWorkerRecord,
  validateWorkerRun, validateWorkerConversationBinding, workerConversationBinding, workerReportHeaderMatches, parseWorkerReportHeader,
  workerConversationKey, workerModelAllowed, workerModelOffered, workerPrompt, workerReportPath,
  WORKERS_MAX_LIVE_PER_PROJECT,
  type WorkerActor, type WorkerConversationBinding, type WorkerRecord, type WorkerRun,
  type WorkerRunState, type WorkerScope
} from '../../shared/workers';
import { ControlStore, ControlStoreError } from '../state/control-store';
import type { ControlScope, OperationRecord, OutboxRecord } from '../../shared/control-state';
import { inspectWorkerReport, readWorkerReportText, writeWorkerReport } from './report';

/**
 * The durable half of bounded, owner-created workers (W1).
 *
 * Every worker, run and lease is one control-store operation per revision in the existing
 * `operations`/`outboxes` tables, in the exact project scope and the reserved `workers` session
 * bucket. There is no new table and no second database.
 *
 * The service adds the effects: one background model run through an injected port, the project
 * lease, the canonical report write, cooperative cancellation and the honest startup recovery.
 * The port is the only place a model request can happen; the tests inject a synthetic one.
 */

const SESSION_ID = 'workers';
const WORKER_KIND = 'workers.worker';
const RUN_KIND = 'workers.run';
const LEASE_KIND = 'workers.lease';
const CONVERSATION_KIND = 'workers.conversation';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REASON_MAX = 400;

type Lease = {
  readonly version: 1;
  readonly projectId: string;
  readonly state: 'held' | 'released';
  readonly runId: string | null;
  readonly workerId: string | null;
  readonly fence: number;
  readonly at: string;
};

export type WorkerStoreOptions = {
  readonly clock?: () => Date;
  /** The owner's current worker model policy. Read at creation and again at every admission. */
  readonly policy: () => WorkerModelPolicy | null;
  /** Every model this instance offers now. */
  readonly offered: () => readonly ModelChoice[];
  /** The registered project's own root, or undefined when it is not registered here. */
  readonly projectRoot: (projectId: string) => string | undefined;
  readonly dataRoot: string;
  readonly persistReport?: (projectId:string,input:Parameters<typeof writeWorkerReport>[0])=>Promise<Awaited<ReturnType<typeof writeWorkerReport>>&{commit?:import('../../shared/workspace').SaveCommit}>;
};

export type WorkerPortResult = {
  readonly text: string;
  readonly turns: number;
  readonly cancelled?: boolean;
  readonly failed?: boolean;
  readonly reason?: string | null;
};

export type WorkerPortRunInput = {
  readonly projectId: string;
  readonly workerId: string;
  readonly runId: string;
  readonly model: ModelChoice;
  readonly scopes: readonly WorkerScope[];
  readonly prompt: string;
  readonly requestId: string;
  /** Re-checked on every tool call. Returns a refusal reason, or null to allow the call. */
  readonly guard: (tool: string) => Promise<string | null>;
  /** Persist the run-to-conversation binding. It must finish before any input is submitted. */
  readonly onConversation: (conversationId: number) => Promise<void>;
  /** Re-check the run, worker and policy immediately before the one submission. */
  readonly beforeSubmit: () => Promise<string | null>;
  /** Aborted when the owner stops or revokes. It closes the open window before any submit. */
  readonly signal?: AbortSignal;
};

/**
 * The one port through which a worker run can ask for model work. A port that cannot run refuses;
 * the store records the refusal and nothing is replayed.
 */
export interface WorkerRunPort {
  run(input: WorkerPortRunInput): Promise<WorkerPortResult>;
  cancel(input: { readonly projectId: string; readonly runId: string }): Promise<void>;
}

export type RevocationResult = {
  readonly worker: WorkerRecord;
  readonly run: WorkerRun | null;
  readonly cancelled: boolean;
  readonly outcome: 'revoked' | 'terminal' | 'unchanged';
};

export type StopResult = {
  readonly run: WorkerRun;
  readonly cancelled: boolean;
  readonly unchanged: boolean;
  readonly outcome: 'cancelled' | 'terminal';
};

export type WorkerRecoveryReport = {
  readonly readOnly: false;
  readonly recoveredRuns: number;
  readonly releasedLeases: number;
  readonly reportsChecked: number;
  readonly reportsUnavailable: number;
  readonly entries: readonly { readonly projectId: string; readonly runId: string; readonly revision: number }[];
};

/** One project's read-only view. */
export type WorkerProjectView = {
  readonly workers: readonly WorkerRecord[];
  readonly runs: readonly WorkerRun[];
  readonly policy: { readonly revision: number; readonly allowedWorkerModels: readonly ModelChoice[]; readonly defaultWorkerModel: ModelChoice | null } | null;
  readonly liveWorkers: number;
  readonly activeRunId: string | null;
};

export class WorkerStore {
  private readonly clock: () => Date;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly store: ControlStore, private readonly options: WorkerStoreOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** The owner policy, with a storage failure reported as one path-free worker refusal. */
  private currentPolicy(): WorkerModelPolicy | null {
    try { return this.options.policy(); }
    catch (error) { throw new WorkerError('The owner worker model policy could not be read. Nothing was admitted and no fallback was used.', 'STORAGE'); }
  }

  private scope(projectId: string): ControlScope {
    return { projectId, sessionId: SESSION_ID };
  }

  private async serial<T>(key: string, work: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.tails.set(key, current);
    try { return await current; } finally { if (this.tails.get(key) === current) this.tails.delete(key); }
  }

  /** Proves the project is registered before any record or file is touched. */
  private requireProject(projectId: unknown): string {
    if (typeof projectId !== 'string' || !ID_PATTERN.test(projectId))
      throw new WorkerError('Invalid project id', 'INVALID');
    if (this.options.projectRoot(projectId) === undefined)
      throw new WorkerError('The project ' + projectId + ' is not registered on this instance', 'NOT_FOUND');
    return projectId;
  }

  readWorker(projectId: unknown, workerId: unknown): WorkerRecord {
    const project = this.requireProject(projectId);
    const id = this.parseId(workerId, 'worker');
    const record = this.latestWorker(project, id);
    if (record === null) throw new WorkerError('Worker ' + id + ' does not exist in this project', 'NOT_FOUND');
    return record;
  }

  readRun(projectId: unknown, runId: unknown): WorkerRun {
    const project = this.requireProject(projectId);
    const id = this.parseId(runId, 'worker run');
    const record = this.latestRun(project, id);
    if (record === null) throw new WorkerError('Worker run ' + id + ' does not exist in this project', 'NOT_FOUND');
    return record;
  }

  listWorkers(projectId: unknown): readonly WorkerRecord[] {
    const project = this.requireProject(projectId);
    const latest = new Map<string, WorkerRecord>();
    for (const operation of this.operations(project, WORKER_KIND)) {
      const record = this.decodeWorker(operation, project);
      const previous = latest.get(record.id);
      if (previous === undefined || record.revision > previous.revision) latest.set(record.id, record);
      else if (record.revision === previous.revision)
        throw new WorkerError('Corrupt worker storage: two revisions of worker ' + record.id + ' share revision ' + record.revision, 'CORRUPT');
    }
    return Object.freeze([...latest.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)));
  }

  listRuns(projectId: unknown, workerId?: string): readonly WorkerRun[] {
    const project = this.requireProject(projectId);
    const latest = new Map<string, WorkerRun>();
    for (const operation of this.operations(project, RUN_KIND)) {
      const record = this.decodeRun(operation, project);
      if (workerId !== undefined && record.workerId !== workerId) continue;
      const previous = latest.get(record.id);
      if (previous === undefined || record.revision > previous.revision) latest.set(record.id, record);
      else if (record.revision === previous.revision)
        throw new WorkerError('Corrupt worker storage: two revisions of run ' + record.id + ' share revision ' + record.revision, 'CORRUPT');
    }
    return Object.freeze([...latest.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id)));
  }

  /** Everything one project's worker view reports. Read-only, and it opens no harness. */
  view(projectId: unknown): WorkerProjectView {
    const project = this.requireProject(projectId);
    const workers = this.listWorkers(project);
    const runs = this.listRuns(project);
    const policy = this.currentPolicy();
    const lease = this.latestLease(project);
    return Object.freeze({
      workers,
      runs,
      policy: policy === null ? null : Object.freeze({
        revision: policy.revision,
        allowedWorkerModels: policy.allowedWorkerModels,
        defaultWorkerModel: policy.defaultWorkerModel
      }),
      liveWorkers: workers.filter((worker) => worker.state === 'active').length,
      activeRunId: lease !== null && lease.state === 'held' ? lease.runId : null
    });
  }

  /** Owner-only creation, with the model pinned and no fallback. */
  async create(projectId: unknown, actorInput: unknown, request: unknown): Promise<WorkerRecord> {
    const project = this.requireProject(projectId);
    const actor = parseWorkerActor(actorInput);
    if (actor.kind !== 'owner') throw new WorkerError('Only the owner may create a worker; an agent request is refused by name', 'NOT_PERMITTED');
    const parsed = parseWorkerCreate(request);
    return this.serial(project + ':workers', () => {
      const workers = this.listWorkers(project);
      const live = workers.filter((worker) => worker.state === 'active');
      if (live.some((worker) => worker.name === parsed.name))
        throw new WorkerError('A live worker in this project already has the name ' + JSON.stringify(parsed.name) + '; nothing was created', 'CONFLICT');
      if (live.length >= WORKERS_MAX_LIVE_PER_PROJECT)
        throw new WorkerError('This project already has ' + WORKERS_MAX_LIVE_PER_PROJECT + ' live workers. Revoke one before creating another; nothing was created', 'LIMIT');
      const model = pinWorkerModel(this.currentPolicy(), parsed.model);
      if (!workerModelOffered(this.options.offered(), model))
        throw new WorkerError('The model ' + modelKey(model) + ' is not offered by this instance now. No fallback was used and nothing was created', 'MODEL_UNAVAILABLE');
      const record = buildWorkerRecord({
        id: 'w-' + randomUUID(),
        projectId: project,
        name: parsed.name,
        model,
        scopes: parsed.scopes,
        actor,
        now: this.clock()
      });
      this.writeWorker(record);
      return record;
    });
  }

  /**
   * Owner-only revocation. The record becomes immutable history. The active run, if any, is
   * returned so the service can cooperatively cancel it; nothing already committed is rolled back.
   */
  async revoke(projectId: unknown, workerId: unknown, revision: unknown, actorInput: unknown): Promise<{
    readonly worker: WorkerRecord;
    readonly activeRun: WorkerRun | null;
    readonly changed: boolean;
  }> {
    const project = this.requireProject(projectId);
    const id = this.parseId(workerId, 'worker');
    const actor = parseWorkerActor(actorInput);
    if (actor.kind !== 'owner') throw new WorkerError('Only the owner may revoke a worker; an agent request is refused by name', 'NOT_PERMITTED');
    return this.serial(project + ':workers', () => {
      const current = this.readWorker(project, id);
      if (current.state === 'revoked') return { worker: current, activeRun: this.activeRunForWorker(project, id), changed: false };
      const expected = this.parseRevision(revision, 'worker');
      if (expected !== current.revision)
        throw new WorkerError('The worker is at revision ' + current.revision + ', not ' + expected + '; nothing was revoked and the record is unchanged', 'CONFLICT');
      const next = revokeWorkerRecord(current, actor, this.clock());
      this.writeWorker(next);
      return { worker: next, activeRun: this.activeRunForWorker(project, id), changed: true };
    });
  }

  /**
   * Admit one run: durable project lease first, then the run record. A second run is refused as
   * busy; there is no queue. The policy and the pinned model are checked again here, with no
   * fallback.
   */
  async admitRun(projectId: unknown, workerId: unknown, actorInput: unknown): Promise<WorkerRun> {
    const project = this.requireProject(projectId);
    const id = this.parseId(workerId, 'worker');
    const actor = parseWorkerActor(actorInput);
    if (actor.kind !== 'owner') throw new WorkerError('Only the owner may start a worker run; an agent request is refused by name', 'NOT_PERMITTED');
    return this.serial(project + ':workers', () => {
      const worker = this.readWorker(project, id);
      if (worker.state === 'revoked')
        throw new WorkerError('Worker ' + worker.name + ' is revoked. A revoked worker can start no run and nothing was admitted', 'NOT_PERMITTED');
      const policy = this.currentPolicy();
      if (!workerModelAllowed(policy, worker.model))
        throw new WorkerError('The pinned model ' + modelKey(worker.model) + ' is no longer in the owner\u2019s allowed worker set. No run was admitted and no fallback was used', 'MODEL_NOT_ALLOWED');
      if (!workerModelOffered(this.options.offered(), worker.model))
        throw new WorkerError('The pinned model ' + modelKey(worker.model) + ' is not offered by this instance now. No run was admitted and no fallback was used', 'MODEL_UNAVAILABLE');
      let lease = this.latestLease(project);
      if (lease !== null && lease.state === 'held') {
        // A lease whose holder is already terminal is stale (a release that failed after the run
        // settled). Release it here rather than refuse forever; a lease whose holder is still
        // running is a real active run and the request is refused as busy. Nothing is replayed.
        const holder = lease.runId === null ? null : this.latestRun(project, lease.runId);
        if (holder !== null && holder.state === 'running')
          throw new WorkerError('This project already has an active worker run (' + (lease.runId ?? 'unknown') + '). Wait for it to end or stop it; W1 has no queue and nothing was admitted', 'BUSY');
        this.releaseLeaseWithin(project, lease.runId);
        lease = this.latestLease(project);
      }
      const run = buildWorkerRun({ id: 'r-' + randomUUID(), projectId: project, worker, now: this.clock() });
      const fence = (lease?.fence ?? 0) + 1;
      this.writeLease(project, { version: 1, projectId: project, state: 'held', runId: run.id, workerId: worker.id, fence, at: this.now() });
      try {
        this.writeRun(run);
      } catch (error) {
        // The lease must never outlive a run that was not admitted by this call.
        try { this.releaseLeaseWithin(project, run.id); } catch { /* reported by the startup recovery */ }
        throw error;
      }
      return run;
    });
  }

  /** Record that a cooperative cancel was asked for. Idempotent, and a terminal run is unchanged. */
  async markCancelRequested(projectId: unknown, runId: unknown): Promise<{ readonly run: WorkerRun; readonly changed: boolean }> {
    const project = this.requireProject(projectId);
    const id = this.parseId(runId, 'worker run');
    return this.serial(project + ':workers', () => {
      const current = this.readRun(project, id);
      if (current.state !== 'running' || current.cancelRequested) return { run: current, changed: false };
      const next = validateWorkerRun({ ...current, revision: current.revision + 1, cancelRequested: true });
      this.writeRun(next);
      return { run: next, changed: true };
    });
  }

  /** The one settle path. A repeated settle of a terminal run returns it unchanged. */
  async settleRun(projectId: unknown, runId: unknown, change: {
    readonly state: Exclude<WorkerRunState, 'running'>;
    readonly turns?: number;
    readonly report?: { readonly path: string; readonly sha256: string; readonly bytes: number } | null;
    readonly reason?: string | null;
  }): Promise<{ readonly run: WorkerRun; readonly changed: boolean }> {
    const project = this.requireProject(projectId);
    const id = this.parseId(runId, 'worker run');
    return this.serial(project + ':workers', () => {
      const current = this.readRun(project, id);
      if (current.state !== 'running') return { run: current, changed: false };
      // The reported count is recorded as it was measured. It is never clamped to the budget: a
      // faulty provider that reports more must remain visible, and the run is failed separately.
      const turns = Math.max(current.turns, change.turns ?? current.turns);
      const reason = change.reason === undefined
        ? (change.state === 'completed' || change.state === 'cancelled' ? null : 'The worker run ended without a usable result.')
        : change.reason;
      const next = validateWorkerRun({
        ...current,
        state: change.state,
        revision: current.revision + 1,
        turns,
        report: change.report === undefined ? current.report : change.report,
        reason: reason === null ? null : String(reason).slice(0, REASON_MAX),
        endedAt: this.now()
      });
      this.writeRun(next);
      try { this.releaseLeaseWithin(project, id); }
      catch (error) { console.error('Worker run ' + id + ' is settled but its project lease could not be released (' + (error as Error).message + '); the next start releases it'); }
      return { run: next, changed: true };
    });
  }

  /**
   * Persist the run-to-conversation binding. This is written before any input is submitted, so a
   * restart can answer whether a conversation belongs to a worker without trusting process memory.
   * A repeat of the same binding is idempotent; a different conversation for one run conflicts.
   */
  async recordConversation(projectId: unknown, runId: unknown, conversationId: unknown): Promise<WorkerConversationBinding> {
    const project = this.requireProject(projectId);
    const run = this.parseId(runId, 'worker run');
    if (!Number.isInteger(conversationId) || (conversationId as number) < 1)
      throw new WorkerError('A worker conversation id must be a positive whole number', 'INVALID');
    return this.serial(project + ':workers', () => {
      // The run must exist in this project before its conversation is recorded.
      this.readRun(project, run);
      const existing = this.conversationForRun(project, run);
      if (existing !== null) {
        if (existing.binding.conversationId === conversationId) return existing.binding;
        throw new WorkerError('Worker run ' + run + ' already has a different conversation binding; the record is unchanged', 'CONFLICT');
      }
      const binding = workerConversationBinding({ projectId: project, runId: run, conversationId: conversationId as number, now: this.clock() });
      let admitted;
      try {
        admitted = this.store.admit({
          scope: this.scope(project),
          idempotencyKey: workerConversationKey(binding.runId),
          kind: CONVERSATION_KIND,
          input: binding,
          outbox: { kind: CONVERSATION_KIND, payload: { version: 1, projectId: project, runId: binding.runId } }
        });
      } catch (error) {
        if (error instanceof ControlStoreError && error.code === 'CONFLICT')
          throw new WorkerError('Worker run ' + run + ' already has a different conversation binding; the record is unchanged', 'CONFLICT');
        throw new WorkerError('The durable store refused the worker conversation binding: ' + (error as Error).message, 'STORAGE');
      }
      return this.decodeConversation(admitted.operation, project).binding;
    });
  }

  /** The durable conversation of a render run, or null. */
  conversationForRun(projectId: unknown, runId: unknown): { readonly binding: WorkerConversationBinding; readonly operationId: string } | null {
    const project = this.requireProject(projectId);
    const run = this.parseId(runId, 'worker run');
    for (const operation of this.operations(project, CONVERSATION_KIND)) {
      const decoded = this.decodeConversation(operation, project);
      if (decoded.binding.runId === run) return decoded;
    }
    return null;
  }

  /**
   * Whether a numeric conversation id belongs to a worker run of this project.
   *
   * This is the durable answer every generic path must use. The caller fails closed on a storage
   * error: an unreadable store must not turn a worker conversation into a session.
   */
  isWorkerConversation(projectId: unknown, conversationId: unknown): boolean {
    const project = this.requireProject(projectId);
    if (!Number.isInteger(conversationId) || (conversationId as number) < 1) return false;
    for (const operation of this.operations(project, CONVERSATION_KIND)) {
      if (this.decodeConversation(operation, project).binding.conversationId === conversationId) return true;
    }
    return false;
  }

  /** The durable conversation ids recorded for this project, sorted. Read-only. */
  workerConversationIds(projectId: unknown): readonly number[] {
    const project = this.requireProject(projectId);
    const ids = this.operations(project, CONVERSATION_KIND).map((operation) => this.decodeConversation(operation, project).binding.conversationId);
    return Object.freeze([...new Set(ids)].sort((left, right) => left - right));
  }

  private decodeConversation(operation: OperationRecord, projectId: string): { binding: WorkerConversationBinding; operationId: string } {
    if (operation.kind !== CONVERSATION_KIND) throw new WorkerError('Worker storage holds an unexpected conversation kind', 'CORRUPT');
    const binding = validateWorkerConversationBinding(operation.input);
    if (binding.projectId !== projectId) throw new WorkerError('A stored worker conversation binding is outside its own project', 'CORRUPT');
    if (operation.idempotencyKey !== workerConversationKey(binding.runId))
      throw new WorkerError('A stored worker conversation binding has an unexpected idempotency key', 'CORRUPT');
    if (operation.state !== 'pending') throw new WorkerError('A stored worker conversation binding operation is not pending', 'CORRUPT');
    const outbox = this.outboxFor(operation, projectId);
    if (outbox.kind !== CONVERSATION_KIND) throw new WorkerError('Worker conversation storage holds an unexpected outbox kind', 'CORRUPT');
    if (outbox.state !== 'pending') throw new WorkerError('A worker conversation outbox must stay pending', 'CORRUPT');
    return { binding, operationId: operation.id };
  }

  /**
   * The per-request re-check the static worker role makes immediately before every provider call.
   * A refusal throws in the generation hook, so the paid request is never sent. It also stops a
   * crash-resumed worker task: the startup recovery has already marked that run interrupted.
   */
  workerRequestRefusal(projectId: string, runId: string): string | null {
    let run: WorkerRun;
    try { run = this.readRun(projectId, runId); }
    catch { return 'The worker run is no longer readable, so no model request was sent.'; }
    if (run.state !== 'running' || run.cancelRequested)
      return 'The worker run is no longer running, so no model request was sent.';
    let worker: WorkerRecord;
    try { worker = this.readWorker(projectId, run.workerId); }
    catch { return 'The worker record is no longer readable, so no model request was sent.'; }
    if (worker.state !== 'active')
      return 'The worker is revoked, so no model request was sent.';
    const policy = this.currentPolicy();
    if (!workerModelAllowed(policy, run.model))
      return 'The pinned worker model is no longer allowed by the owner\u2019s policy, so no model request was sent.';
    if (!workerModelOffered(this.options.offered(), run.model))
      return 'The pinned worker model is not offered by this instance now, so no model request was sent.';
    return null;
  }

  /** Re-read the run and re-check its authority on every tool call. */
  guardTool(projectId: string, runId: string, tool: string): string | null {
    let run: WorkerRun;
    try { run = this.readRun(projectId, runId); }
    catch { return 'The worker run is no longer readable, so the tool ' + tool + ' is refused with no effect.'; }
    if (run.state !== 'running' || run.cancelRequested)
      return 'The worker run is no longer running, so the tool ' + tool + ' is refused with no effect.';
    let worker: WorkerRecord;
    try { worker = this.readWorker(projectId, run.workerId); }
    catch { return 'The worker record is no longer readable, so the tool ' + tool + ' is refused with no effect.'; }
    if (worker.state !== 'active')
      return 'The worker is revoked, so the tool ' + tool + ' is refused with no effect. Stop and report what you already observed.';
    if (worker.projectId !== projectId)
      return 'The tool ' + tool + ' would act on a project outside this worker\u2019s scope, so it is refused with no effect.';
    if (!workerModelAllowed(this.currentPolicy(), worker.model))
      return 'The pinned worker model is no longer allowed by the owner\u2019s worker policy, so the tool ' + tool + ' is refused with no effect.';
    if (!workerModelOffered(this.options.offered(), worker.model))
      return 'The pinned worker model is not offered by this instance now, so the tool ' + tool + ' is refused with no effect.';
    // The same pure privilege rule every agent tool call uses: a tool with no declared scope, or a
    // scope outside this worker's allowlist, is refused. The worker's own record is the allowlist.
    if (AGENT_TOOL_SCOPES[tool] === undefined)
      return 'The tool ' + tool + ' has no worker scope and is refused with no effect.';
    const verdict = authorizeToolUse({ scopes: worker.scopes as readonly AgentScope[], tool });
    if (!verdict.permitted) return 'The worker refused ' + tool + ': ' + verdict.reason.replace('this agent\u2019s allowlist', 'this worker\u2019s allowlist') + ' No effect was produced.';
    return null;
  }

  /**
   * A bounded integrity reading for the newest reports, for the owner-visible warning. It never
   * rewrites a file. At most `limit` reports are checked (20 by default); the rest are not reported
   * here, so a large history cannot turn one view into an unbounded scan.
   */
  async reportIntegrityFor(projectId: unknown, limit = 20): Promise<Record<string, { readonly state: 'intact' | 'changed' | 'missing' | 'unsafe'; readonly expectedSha256: string; readonly actualSha256: string | null; readonly expectedBytes: number; readonly actualBytes: number | null }>> {
    const project = this.requireProject(projectId);
    const root = this.options.projectRoot(project);
    if (root === undefined) return {};
    const result: Record<string, { state: 'intact' | 'changed' | 'missing' | 'unsafe'; expectedSha256: string; actualSha256: string | null; expectedBytes: number; actualBytes: number | null }> = {};
    for (const run of this.listRuns(project).filter((candidate) => candidate.report !== null).slice(0, Math.max(1, limit))) {
      const report = run.report!;
      const inspection = await inspectWorkerReport({ projectRoot: root, path: report.path });
      if (!inspection.exists) result[run.id] = { state: 'missing', expectedSha256: report.sha256, actualSha256: null, expectedBytes: report.bytes, actualBytes: null };
      else if (!inspection.valid) result[run.id] = { state: 'unsafe', expectedSha256: report.sha256, actualSha256: null, expectedBytes: report.bytes, actualBytes: null };
      else if (inspection.sha256 !== report.sha256 || inspection.bytes !== report.bytes) result[run.id] = { state: 'changed', expectedSha256: report.sha256, actualSha256: inspection.sha256, expectedBytes: report.bytes, actualBytes: inspection.bytes };
      else result[run.id] = { state: 'intact', expectedSha256: report.sha256, actualSha256: inspection.sha256, expectedBytes: report.bytes, actualBytes: inspection.bytes };
    }
    return result;
  }

  /**
   * Startup recovery. A crash can leave a held lease and a running run. Each running run is marked
   * interrupted with a reason, and every held lease is released. Nothing is replayed, resumed or
   * sent to a provider; the pass is deterministic and idempotent.
   */
  async recoverOnStartup(): Promise<WorkerRecoveryReport> {
    const projects = this.projectsWithRecords();
    const entries: { projectId: string; runId: string; revision: number }[] = [];
    let released = 0;
    let reportsChecked = 0;
    let reportsUnavailable = 0;
    for (const project of projects) {
      try {
        const root = this.options.projectRoot(project);
        if (root === undefined) {
          console.error('Worker recovery skipped project ' + project + ' because it is not registered; nothing was replayed');
          continue;
        }
        const lease = this.latestLease(project);
        for (const run of this.listRuns(project)) {
          const path = workerReportPath(run.workerId, run.id);
          if (run.state === 'running') {
            // A crash can leave a report already linked but the run not settled. The canonical file
            // is checked first: a valid regular file inside the project settles the run completed
            // with its hash and size, and no model work is repeated. Anything else settles the run
            // interrupted, exactly as before.
            const inspection = await inspectWorkerReport({ projectRoot: root, path });
            reportsChecked += 1;
            if (inspection.exists && inspection.valid) {
              // The file must carry the exact fixed header for **this** run. A manual file, a foreign
              // run's report or a partial header is not evidence of completion.
              const read = await readWorkerReportText({ projectRoot: root, path });
              const header = read === null ? null : parseWorkerReportHeader(read.text);
              const worker = this.latestWorker(project, run.workerId);
              const matches = header !== null && worker !== null && workerReportHeaderMatches(header, worker, run);
              if (read !== null && matches) {
                const settled = await this.settleRun(project, run.id, {
                  state: 'completed',
                  report: { path, sha256: read.sha256, bytes: read.bytes }
                });
                if (settled.changed) entries.push({ projectId: project, runId: settled.run.id, revision: settled.run.revision });
                continue;
              }
            }
            if (inspection.exists) reportsUnavailable += 1;
            const settled = await this.settleRun(project, run.id, {
              state: 'interrupted',
              reason: 'The owning process stopped while this worker run was active. Its completion cannot be proven, so it was not replayed. Start a new run if the owner wants another attempt.'
            });
            if (settled.changed) entries.push({ projectId: project, runId: settled.run.id, revision: settled.run.revision });
            continue;
          }
          if (run.report !== null) {
            // A finished run's report is canonical and is never rewritten here. The check only
            // reports whether the tracking hash and size still describe the file.
            const inspection = await inspectWorkerReport({ projectRoot: root, path });
            reportsChecked += 1;
            if (!inspection.exists || !inspection.valid || inspection.sha256 !== run.report.sha256 || inspection.bytes !== run.report.bytes)
              reportsUnavailable += 1;
          }
        }
        if (lease !== null && lease.state === 'held') {
          try {
            await this.releaseLease(project, lease.runId);
            released += 1;
          } catch (error) {
            console.error('The worker lease of project ' + project + ' could not be released at start (' + (error as Error).message + '); a later start retries it');
          }
        }
      } catch (error) {
        // One unreadable project must not stop the others. Nothing was replayed for it.
        console.error('Worker recovery for project ' + project + ' could not finish (' + (error as Error).message + '); nothing was replayed');
      }
    }
    return Object.freeze({ readOnly: false as const, recoveredRuns: entries.length, releasedLeases: released, reportsChecked, reportsUnavailable, entries: Object.freeze(entries) });
  }

  private releaseLease(projectId: string, runId: string | null): Promise<void> {
    return this.serial(projectId + ':workers', () => { this.releaseLeaseWithin(projectId, runId); });
  }

  private releaseLeaseWithin(projectId: string, runId: string | null): void {
    const lease = this.latestLease(projectId);
    if (lease === null || lease.state !== 'held') return;
    if (runId !== null && lease.runId !== runId) return;
    this.writeLease(projectId, {
      version: 1,
      projectId,
      state: 'released',
      runId: lease.runId,
      workerId: lease.workerId,
      fence: lease.fence + 1,
      at: this.now()
    });
  }

  private activeRunForWorker(projectId: string, workerId: string): WorkerRun | null {
    const runs = this.listRuns(projectId, workerId);
    return runs.find((run) => run.state === 'running') ?? null;
  }

  private latestWorker(projectId: string, workerId: string): WorkerRecord | null {
    let latest: WorkerRecord | null = null;
    for (const operation of this.operations(projectId, WORKER_KIND)) {
      const record = this.decodeWorker(operation, projectId);
      if (record.id !== workerId) continue;
      if (latest === null || record.revision > latest.revision) latest = record;
      else if (record.revision === latest.revision)
        throw new WorkerError('Corrupt worker storage: two revisions of worker ' + workerId + ' share revision ' + record.revision, 'CORRUPT');
    }
    return latest;
  }

  private latestRun(projectId: string, runId: string): WorkerRun | null {
    let latest: WorkerRun | null = null;
    for (const operation of this.operations(projectId, RUN_KIND)) {
      const record = this.decodeRun(operation, projectId);
      if (record.id !== runId) continue;
      if (latest === null || record.revision > latest.revision) latest = record;
      else if (record.revision === latest.revision)
        throw new WorkerError('Corrupt worker storage: two revisions of run ' + runId + ' share revision ' + record.revision, 'CORRUPT');
    }
    return latest;
  }

  private latestLease(projectId: string): Lease | null {
    let latest: Lease | null = null;
    for (const operation of this.operations(projectId, LEASE_KIND)) {
      const lease = this.decodeLease(operation, projectId);
      if (latest === null || lease.fence > latest.fence) latest = lease;
      else if (lease.fence === latest.fence)
        throw new WorkerError('Corrupt worker storage: two leases share fence ' + lease.fence, 'CORRUPT');
    }
    return latest;
  }

  private decodeWorker(operation: OperationRecord, projectId: string): WorkerRecord {
    if (operation.kind !== WORKER_KIND) throw new WorkerError('Worker storage holds an unexpected operation kind', 'CORRUPT');
    const record = validateWorkerRecord(operation.input);
    if (record.projectId !== projectId) throw new WorkerError('A stored worker record is outside its own project', 'CORRUPT');
    if (operation.idempotencyKey !== 'worker.' + record.id + '.r' + record.revision)
      throw new WorkerError('A stored worker record has an unexpected idempotency key', 'CORRUPT');
    if (operation.state !== 'pending') throw new WorkerError('A stored worker operation is not pending', 'CORRUPT');
    const outbox = this.outboxFor(operation, projectId);
    if (outbox.kind !== WORKER_KIND) throw new WorkerError('Worker storage holds an unexpected outbox kind', 'CORRUPT');
    if (outbox.state !== 'pending') throw new WorkerError('A worker outbox must stay pending for the life of the record', 'CORRUPT');
    return record;
  }

  private decodeRun(operation: OperationRecord, projectId: string): WorkerRun {
    if (operation.kind !== RUN_KIND) throw new WorkerError('Worker storage holds an unexpected operation kind', 'CORRUPT');
    const record = validateWorkerRun(operation.input);
    if (record.projectId !== projectId) throw new WorkerError('A stored worker run is outside its own project', 'CORRUPT');
    if (operation.idempotencyKey !== 'run.' + record.id + '.r' + record.revision)
      throw new WorkerError('A stored worker run has an unexpected idempotency key', 'CORRUPT');
    if (operation.state !== 'pending') throw new WorkerError('A stored worker run operation is not pending', 'CORRUPT');
    const outbox = this.outboxFor(operation, projectId);
    if (outbox.kind !== RUN_KIND) throw new WorkerError('Worker run storage holds an unexpected outbox kind', 'CORRUPT');
    if (outbox.state !== 'pending') throw new WorkerError('A worker run outbox must stay pending for the life of the record', 'CORRUPT');
    return record;
  }

  private decodeLease(operation: OperationRecord, projectId: string): Lease {
    if (operation.kind !== LEASE_KIND) throw new WorkerError('Worker storage holds an unexpected lease kind', 'CORRUPT');
    const value = operation.input as Partial<Lease> | null;
    if (!value || typeof value !== 'object' || value.version !== 1 || value.projectId !== projectId) throw new WorkerError('A stored worker lease is corrupt', 'CORRUPT');
    if (value.state !== 'held' && value.state !== 'released') throw new WorkerError('A stored worker lease has an unknown state', 'CORRUPT');
    if (!Number.isInteger(value.fence) || (value.fence as number) < 1) throw new WorkerError('A stored worker lease has no fence', 'CORRUPT');
    if (value.state === 'held' && (typeof value.runId !== 'string' || typeof value.workerId !== 'string')) throw new WorkerError('A held worker lease names no run', 'CORRUPT');
    if (operation.idempotencyKey !== 'lease.r' + value.fence) throw new WorkerError('A stored worker lease has an unexpected idempotency key', 'CORRUPT');
    if (operation.state !== 'pending') throw new WorkerError('A stored worker lease operation is not pending', 'CORRUPT');
    const outbox = this.outboxFor(operation, projectId);
    if (outbox.kind !== LEASE_KIND) throw new WorkerError('Worker lease storage holds an unexpected outbox kind', 'CORRUPT');
    if (outbox.state !== 'pending') throw new WorkerError('A worker lease outbox must stay pending', 'CORRUPT');
    return Object.freeze({
      version: 1 as const,
      projectId,
      state: value.state,
      runId: typeof value.runId === 'string' ? value.runId : null,
      workerId: typeof value.workerId === 'string' ? value.workerId : null,
      fence: value.fence as number,
      at: String(value.at ?? '')
    });
  }

  private outboxFor(operation: OperationRecord, projectId: string): OutboxRecord {
    try { return this.store.getOutbox(this.outboxIdOf(operation.id), this.scope(projectId)); }
    catch (error) { throw new WorkerError('The worker record\u2019s outbox could not be read: ' + (error as Error).message, 'STORAGE'); }
  }

  private outboxIdOf(operationId: string): string {
    const rows = this.store.db.prepare('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2').all(operationId) as { id?: unknown }[];
    if (rows.length !== 1 || typeof rows[0]?.id !== 'string') throw new WorkerError('Worker storage holds no unambiguous outbox row for one of its operations', 'STORAGE');
    return rows[0].id;
  }

  private operations(projectId: string, kind?: string): readonly OperationRecord[] {
    let rows: { id?: unknown }[];
    try {
      rows = kind === undefined
        ? this.store.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? ORDER BY rowid').all(projectId, SESSION_ID) as { id?: unknown }[]
        : this.store.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid').all(projectId, SESSION_ID, kind) as { id?: unknown }[];
    } catch (error) {
      throw new WorkerError('The durable control store could not be read: ' + (error as Error).message, 'STORAGE');
    }
    const result: OperationRecord[] = [];
    for (const row of rows) {
      if (typeof row.id !== 'string') throw new WorkerError('Worker storage holds a record with no id', 'CORRUPT');
      try { result.push(this.store.getOperation(row.id, this.scope(projectId))); }
      catch (error) { throw new WorkerError('The durable store could not read a worker operation: ' + (error as Error).message, 'STORAGE'); }
    }
    return result;
  }

  /** The distinct projects that hold any worker record, in a deterministic order. */
  private projectsWithRecords(): string[] {
    let rows: { project_id?: unknown }[];
    try {
      rows = this.store.db.prepare('SELECT DISTINCT project_id FROM operations WHERE session_id=? ORDER BY project_id').all(SESSION_ID) as { project_id?: unknown }[];
    } catch (error) {
      throw new WorkerError('The durable control store could not be read: ' + (error as Error).message, 'STORAGE');
    }
    return rows.map((row) => String(row.project_id ?? '')).filter((id) => ID_PATTERN.test(id));
  }

  private writeWorker(record: WorkerRecord): void {
    this.admit(record.projectId, 'worker.' + record.id + '.r' + record.revision, WORKER_KIND, record, record.revision);
  }

  private writeRun(record: WorkerRun): void {
    this.admit(record.projectId, 'run.' + record.id + '.r' + record.revision, RUN_KIND, record, record.revision);
  }

  private writeLease(projectId: string, lease: Lease): void {
    this.admit(projectId, 'lease.r' + lease.fence, LEASE_KIND, lease, lease.fence);
  }

  private admit(projectId: string, key: string, kind: string, input: unknown, revision: number): void {
    let admitted: { operation: OperationRecord; outbox: OutboxRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: this.scope(projectId),
        idempotencyKey: key,
        kind,
        input,
        outbox: { kind, payload: { version: 1, projectId, revision } }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new WorkerError('Worker storage revision ' + revision + ' was already written with different content; the record is unchanged', 'CONFLICT');
      throw new WorkerError('The durable store refused the worker write: ' + (error as Error).message, 'STORAGE');
    }
    // One writer per revision: an identical repeat is a second writer being refused, never a success.
    if (admitted.existing)
      throw new WorkerError('Worker storage revision ' + revision + ' was already written; the record is unchanged', 'CONFLICT');
  }

  private parseId(value: unknown, label: string): string {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new WorkerError('Invalid ' + label + ' id', 'INVALID');
    return value;
  }

  private parseRevision(value: unknown, label: string): number {
    if (!Number.isInteger(value) || (value as number) < 1) throw new WorkerError('The ' + label + ' revision must be a positive whole number', 'INVALID');
    return value as number;
  }

  private now(): string {
    const at = this.clock().getTime();
    if (!Number.isFinite(at)) throw new WorkerError('The worker clock is not a valid instant', 'STORAGE');
    return new Date(at).toISOString();
  }
}

/**
 * The orchestration half: admit, dispatch one bounded run, write the canonical report, cancel
 * cooperatively, and record every end honestly. No queue, no replay and no auto-accept.
 */
export class WorkerService {
  private readonly active = new Map<string, { run: WorkerRun; cancelled: boolean; readonly controller: AbortController }>();
  private readonly work = new Set<Promise<unknown>>();

  constructor(
    private readonly store: WorkerStore,
    private readonly port: WorkerRunPort,
    private readonly options: WorkerStoreOptions
  ) {}

  /** Start one run and dispatch it in the background. The caller reads the durable record. */
  async start(projectId: unknown, workerId: unknown, actor: unknown): Promise<WorkerRun> {
    const run = await this.store.admitRun(projectId, workerId, actor);
    const key = this.key(run.projectId, run.id);
    const entry = { run, cancelled: false, controller: new AbortController() };
    this.active.set(key, entry);
    const job = this.dispatch(run.projectId, run.id, entry).catch((error) => {
      console.error('Worker run ' + run.id + ' could not be dispatched (' + (error as Error).message + '); the record reports the failure');
    }).finally(() => {
      this.active.delete(key);
      this.work.delete(job);
    });
    this.work.add(job);
    return run;
  }

  private async dispatch(projectId: string, runId: string, entry: { run: WorkerRun; cancelled: boolean; controller: AbortController }): Promise<void> {
    const run = entry.run;
    // Re-check immediately before anything is sent. A revocation or a policy change that landed
    // after admission closes this run with zero submissions.
    const current = this.store.readWorker(projectId, run.workerId);
    if (current.state !== 'active') {
      await this.store.settleRun(projectId, runId, { state: 'cancelled', reason: 'The worker was revoked before its run was dispatched. Nothing was sent to a provider.' });
      return;
    }
    // The pinned model is checked once more, immediately before anything is sent. A policy change
    // that removed it, or a catalog that no longer offers it, is a named failure with no submission.
    let policy: WorkerModelPolicy | null;
    try { policy = this.options.policy(); }
    catch { policy = null; }
    if (!workerModelAllowed(policy, run.model) || !workerModelOffered(this.options.offered(), run.model)) {
      await this.store.settleRun(projectId, runId, { state: 'failed', reason: 'The pinned worker model is no longer allowed or offered. No request was sent to a provider and no report was written. Nothing was replayed.' });
      return;
    }
    const model = run.model;
    /**
     * The last check before the one submission. It runs after the conversation exists and its
     * durable binding is written, so a revocation, a cancel or a policy change that landed while
     * the conversation was opening refuses here with no model request.
     */
    const beforeSubmit = async (): Promise<string | null> => {
      try {
        const latestWorker = this.store.readWorker(projectId, run.workerId);
        if (latestWorker.state !== 'active') return 'The worker was revoked before this run submitted anything. Nothing was sent to a provider.';
        const latestRun = this.store.readRun(projectId, runId);
        if (latestRun.state !== 'running' || latestRun.cancelRequested) return 'This worker run is no longer running. Nothing was sent to a provider.';
        let latestPolicy: WorkerModelPolicy | null;
        try { latestPolicy = this.options.policy(); } catch { latestPolicy = null; }
        if (!workerModelAllowed(latestPolicy, run.model)) return 'The pinned worker model is no longer allowed by the owner’s policy. No request was sent and no fallback was used.';
        if (!workerModelOffered(this.options.offered(), run.model)) return 'The pinned worker model is not offered by this instance now. No request was sent and no fallback was used.';
        return null;
      } catch {
        return 'The worker run could not be re-checked immediately before submission, so nothing was sent to a provider.';
      }
    };
    const onConversation = async (conversationId: number): Promise<void> => {
      await this.store.recordConversation(projectId, run.id, conversationId);
    };
    let result: WorkerPortResult;
    try {
      result = await this.port.run({
        projectId,
        workerId: current.id,
        runId,
        model,
        scopes: current.scopes,
        prompt: workerPrompt(current),
        requestId: run.requestId,
        guard: async (tool: string) => this.store.guardTool(projectId, runId, tool),
        onConversation,
        beforeSubmit,
        signal: entry.controller.signal
      });
    } catch (error) {
      const detail = error instanceof WorkerError ? error.message : 'The worker model run failed. Check the provider connection, model access and quota.';
      await this.store.settleRun(projectId, runId, { state: 'failed', reason: detail.slice(0, REASON_MAX) });
      return;
    }
    if (entry.cancelled || result.cancelled) {
      await this.store.settleRun(projectId, runId, { state: 'cancelled', turns: result.turns, reason: 'The owner stopped this worker run. Effects already committed were not rolled back.' });
      return;
    }
    if (result.failed) {
      await this.store.settleRun(projectId, runId, { state: 'failed', turns: result.turns, reason: (result.reason ?? 'The worker model run failed.').slice(0, REASON_MAX) });
      return;
    }
    // The budget is checked before the report is written. The harness enforces the same ceilings.
    if (!Number.isInteger(result.turns) || result.turns < 1 || result.turns > WORKER_MAX_MODEL_TURNS) {
      await this.store.settleRun(projectId, runId, { state: 'failed', turns: Math.max(0, result.turns), reason: 'The worker run did not stay inside its ' + WORKER_MAX_MODEL_TURNS + '-turn budget. No report was written.' });
      return;
    }
    const projectRoot = this.options.projectRoot(projectId);
    if (projectRoot === undefined) {
      await this.store.settleRun(projectId, runId, { state: 'failed', turns: result.turns, reason: 'The project is no longer registered, so no report could be written.' });
      return;
    }
    const measured = { ...run, turns: result.turns };
    let report: { path: string; sha256: string; bytes: number },commitWarning:string|null=null;
    try {
      const content = composeWorkerReport({
        worker: current,
        run: measured,
        body: result.text,
        projectRoot,
        dataRoot: this.options.dataRoot,
        endedAt: new Date()
      });
      const input={projectRoot,path:workerReportPath(current.id,runId),content};
      const written:Awaited<ReturnType<typeof writeWorkerReport>>&{commit?:import('../../shared/workspace').SaveCommit}=this.options.persistReport?await this.options.persistReport(projectId,input):await writeWorkerReport(input);
      if(written.commit&&['failed','uncertain'].includes(written.commit.status))commitWarning='Report saved; Git history needs review: '+written.commit.message;
      report = { path: written.path, sha256: written.sha256, bytes: written.bytes };
    } catch (error) {
      const code = error instanceof WorkerError ? error.code : 'STORAGE';
      const reason = error instanceof WorkerError ? error.message : 'The report could not be written. The worker output was not stored anywhere else.';
      await this.store.settleRun(projectId, runId, { state: 'failed', turns: result.turns, reason: (code === 'REPORT_CONFLICT' ? 'Report conflict: ' : '') + reason.slice(0, REASON_MAX) });
      return;
    }
    await this.store.settleRun(projectId, runId, { state: 'completed', turns: result.turns, report, ...(commitWarning?{reason:commitWarning}:{}) });
  }

  /** Stop one run cooperatively. Idempotent; a terminal run is unchanged and never resumed. */
  async stop(projectId: unknown, runId: unknown, actor: unknown): Promise<StopResult> {
    const parsed = parseWorkerActor(actor);
    if (parsed.kind !== 'owner') throw new WorkerError('Only the owner may stop a worker run; an agent request is refused by name', 'NOT_PERMITTED');
    const project = this.store.readRun(projectId, runId).projectId;
    const id = String(runId);
    const current = await this.store.markCancelRequested(project, id);
    if (current.run.state !== 'running') return Object.freeze({ run: current.run, cancelled: false, unchanged: true, outcome: 'terminal' as const });
    const entry = this.active.get(this.key(project, id));
    if (entry) { entry.cancelled = true; entry.controller.abort(); }
    await this.port.cancel({ projectId: project, runId: id });
    const settled = await this.store.settleRun(project, id, {
      state: 'cancelled',
      reason: 'The owner stopped this worker run. Effects already committed were not rolled back.'
    });
    return Object.freeze({ run: settled.run, cancelled: true, unchanged: false, outcome: 'cancelled' as const });
  }

  /** Revoke, then cooperatively cancel the worker's active run. Committed effects stay. */
  async revoke(projectId: unknown, workerId: unknown, revision: unknown, actor: unknown): Promise<RevocationResult> {
    const result = await this.store.revoke(projectId, workerId, revision, actor);
    if (!result.changed) return Object.freeze({ worker: result.worker, run: result.activeRun, cancelled: false, outcome: 'terminal' as const });
    if (result.activeRun === null) return Object.freeze({ worker: result.worker, run: null, cancelled: false, outcome: 'revoked' as const });
    const project = result.worker.projectId;
    const entry = this.active.get(this.key(project, result.activeRun.id));
    if (entry) { entry.cancelled = true; entry.controller.abort(); }
    try { await this.port.cancel({ projectId: project, runId: result.activeRun.id }); }
    catch (error) { console.error('Worker run ' + result.activeRun.id + ' was not cancelled immediately (' + (error as Error).message + '); its next tool call is still refused'); }
    const settled = await this.store.settleRun(project, result.activeRun.id, {
      state: 'cancelled',
      reason: 'The worker was revoked. Its run was cancelled cooperatively; effects already committed were not rolled back.'
    });
    return Object.freeze({ worker: result.worker, run: settled.run, cancelled: settled.changed, outcome: 'revoked' as const });
  }

  /** Wait for the background dispatches of this process. Used by shutdown and tests. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  private key(projectId: string, runId: string): string { return projectId + ':' + runId; }
}
