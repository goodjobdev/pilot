import type { ControlScope, OperationRecord, OutboxRecord } from '../../shared/control-state';
import {
  buildWorkerModelPolicy,
  parseWorkerModelPolicyActor,
  parseWorkerModelPolicyUpdate,
  sameWorkerModelPolicyDraft,
  validateWorkerModelPolicyDraft,
  validateWorkerModelPolicyRecord,
  WorkerModelPolicyError,
  type WorkerModelPolicy,
  type WorkerModelPolicyActor
} from '../../shared/model-policy';
import type { ModelChoice } from '../../shared/settings';
import { ControlStore, ControlStoreError } from './control-store';

/**
 * The durable worker model policy.
 *
 * The record is deployment-level working state, not documentation. It lives in the existing
 * control store as **one operation per revision**, exactly like the agent registry and the
 * named sessions. The operation's own outbox row is the audit evidence of who changed it and
 * when. There is no new table and no second database.
 *
 * The scope is a reserved settings bucket. Real project ids are UUIDs, so the fixed
 * `settings` project id cannot collide with one. It is the same pattern the agent registry
 * already uses with its own `agents` bucket.
 */
export const WORKER_MODEL_POLICY_PROJECT_ID = 'settings';
export const WORKER_MODEL_POLICY_SESSION_ID = 'worker-policy';
const OPERATION_KIND = 'settings.worker-model-policy';
const OUTBOX_KIND = 'settings.worker-model-policy';
const SCOPE: ControlScope = Object.freeze({
  projectId: WORKER_MODEL_POLICY_PROJECT_ID,
  sessionId: WORKER_MODEL_POLICY_SESSION_ID
});

export type WorkerModelPolicyStoreOptions = {
  readonly clock?: () => Date;
  /** Every model this instance offers now. A saved model may later leave this list. */
  readonly models: () => readonly ModelChoice[];
};

export class WorkerModelPolicyStore {
  private readonly clock: () => Date;
  constructor(
    private readonly store: ControlStore,
    private readonly options: WorkerModelPolicyStoreOptions
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** The current policy, or null when none has been saved. Read-only. */
  read(): WorkerModelPolicy | null {
    const rows = this.rows('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid');
    let latest: WorkerModelPolicy | null = null;
    for (const row of rows) {
      const policy = this.decode(String(row.id));
      if (latest === null || policy.revision > latest.revision) latest = policy;
      else if (policy.revision === latest.revision)
        throw new WorkerModelPolicyError(
          'Corrupt worker model policy storage: two revisions of the policy share revision ' + policy.revision,
          'CORRUPT'
        );
    }
    return latest;
  }

  /**
   * Write one revision under an optimistic compare-and-swap.
   *
   * The actor is supplied by the caller, never by the request body. Only an owner may change
   * the policy. A stale revision writes nothing. Same content at the current revision is a
   * no-op; different content writes the next revision. Two writers at one revision race in
   * the control store's own unique index, and the loser is refused.
   */
  update(input: unknown, actorInput: WorkerModelPolicyActor): WorkerModelPolicy {
    const actor = parseWorkerModelPolicyActor(actorInput);
    if (actor.kind !== 'owner')
      throw new WorkerModelPolicyError('Only the owner may change the worker model policy; an agent request is refused', 'NOT_PERMITTED');
    const request = parseWorkerModelPolicyUpdate(input);
    const current = this.read();
    const currentRevision = current?.revision ?? 0;
    if (request.revision !== currentRevision) {
      throw new WorkerModelPolicyError(
        'The worker model policy is at revision ' + currentRevision + ', not ' + request.revision + '; the request wrote nothing and the policy is unchanged',
        'CONFLICT'
      );
    }
    const draft = validateWorkerModelPolicyDraft(request.policy, this.options.models(), current);
    if (current !== null && sameWorkerModelPolicyDraft(current, draft)) return current;
    const next = buildWorkerModelPolicy({
      revision: currentRevision + 1,
      draft,
      actor,
      updatedAt: this.now()
    });
    return this.write(next);
  }

  /** One control-store admission. The key is derived from the revision the write produces. */
  private write(policy: WorkerModelPolicy): WorkerModelPolicy {
    try {
      this.store.admit({
        scope: SCOPE,
        idempotencyKey: 'worker-model-policy.r' + policy.revision,
        kind: OPERATION_KIND,
        input: policy,
        outbox: {
          kind: OUTBOX_KIND,
          payload: {
            version: 1,
            revision: policy.revision,
            changedBy: policy.updatedBy,
            changedAt: policy.updatedAt
          }
        }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new WorkerModelPolicyError(
          'Worker model policy revision ' + policy.revision + ' was already written with different content (' + error.message + '); the policy is unchanged',
          'CONFLICT'
        );
      throw new WorkerModelPolicyError('The durable store refused the worker model policy write: ' + (error as Error).message, 'STORAGE');
    }
    return policy;
  }

  /** One operation row as a record, through the store's own validated getters. */
  private decode(operationId: string): WorkerModelPolicy {
    let operation: OperationRecord;
    try {
      operation = this.store.getOperation(operationId, SCOPE);
    } catch (error) {
      throw new WorkerModelPolicyError('The durable store could not read worker model policy operation ' + operationId + ': ' + (error as Error).message, 'STORAGE');
    }
    if (operation.kind !== OPERATION_KIND)
      throw new WorkerModelPolicyError('Worker model policy storage holds an unexpected operation kind', 'CORRUPT');
    let policy: WorkerModelPolicy;
    try {
      policy = validateWorkerModelPolicyRecord(operation.input);
    } catch (error) {
      if (error instanceof WorkerModelPolicyError && error.code === 'CORRUPT') throw error;
      throw new WorkerModelPolicyError('A stored worker model policy is corrupt: ' + (error as Error).message, 'CORRUPT');
    }
    if (operation.state !== 'pending')
      throw new WorkerModelPolicyError('A stored worker model policy operation is not pending', 'CORRUPT');
    if (operation.idempotencyKey !== 'worker-model-policy.r' + policy.revision)
      throw new WorkerModelPolicyError('A stored worker model policy operation has an unexpected idempotency key', 'CORRUPT');
    const outbox = this.outboxFor(operation.id);
    if (outbox.kind !== OUTBOX_KIND)
      throw new WorkerModelPolicyError('Worker model policy storage holds an unexpected outbox kind', 'STORAGE');
    if (outbox.state !== 'pending')
      throw new WorkerModelPolicyError('A worker model policy outbox must stay pending for the life of the record', 'STORAGE');
    const payload = outbox.payload as { version?: unknown; revision?: unknown; changedBy?: unknown; changedAt?: unknown } | null;
    if (!payload || typeof payload !== 'object' || payload.version !== 1 || payload.revision !== policy.revision || payload.changedAt !== policy.updatedAt)
      throw new WorkerModelPolicyError('The stored worker model policy outbox payload does not describe its record', 'STORAGE');
    let changedBy: WorkerModelPolicyActor;
    try {
      changedBy = parseWorkerModelPolicyActor(payload.changedBy, 'changedBy');
    } catch (error) {
      throw new WorkerModelPolicyError('A stored worker model policy audit entry is corrupt: ' + (error as Error).message, 'CORRUPT');
    }
    if (changedBy.kind !== policy.updatedBy.kind || changedBy.identity !== policy.updatedBy.identity)
      throw new WorkerModelPolicyError('The stored worker model policy audit entry does not match its record', 'CORRUPT');
    return policy;
  }

  private outboxFor(operationId: string): OutboxRecord {
    const rows = this.rows('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2', [operationId]);
    if (rows.length !== 1)
      throw new WorkerModelPolicyError('Worker model policy storage holds no unambiguous outbox row for one of its operations', 'STORAGE');
    try {
      return this.store.getOutbox(String(rows[0].id), SCOPE);
    } catch (error) {
      throw new WorkerModelPolicyError('The durable store could not read a worker model policy outbox: ' + (error as Error).message, 'STORAGE');
    }
  }

  /** Read-only SELECTs over the reviewed control schema. Every record is decoded above. */
  private rows(sql: string, params: (string | number)[] = [WORKER_MODEL_POLICY_PROJECT_ID, WORKER_MODEL_POLICY_SESSION_ID, OPERATION_KIND]): Record<string, unknown>[] {
    try {
      return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    } catch (error) {
      throw new WorkerModelPolicyError('The durable control store could not be read: ' + (error as Error).message, 'STORAGE');
    }
  }

  private now(): string {
    const at = this.clock().getTime();
    if (!Number.isFinite(at)) throw new WorkerModelPolicyError('The policy clock is not a valid instant', 'STORAGE');
    return new Date(at).toISOString();
  }
}
