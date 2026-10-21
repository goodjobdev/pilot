import type { ControlScope, OperationRecord, OutboxRecord } from '../../shared/control-state';
import {
  SESSION_LIFECYCLE_VERSION, SessionLifecycleError, parseSessionLifecycleAction, parseSessionLifecycleIdentifier, parseSessionLifecycleReason,
  planSessionLifecycleAction, planStartupAdoption, initialSessionLifecycle, validateSessionLifecycleRecord,
  SESSION_LIFECYCLE_DISPATCH_REFUSED_REASON,
  type SessionLifecycleAction, type SessionLifecyclePlan, type SessionLifecycleRecord
} from '../../shared/session-lifecycle';
import { ControlStore, ControlStoreError } from './control-store';

/**
 * Durable session lifecycles, over the reviewed control store.
 *
 * The pure model — the closed state set, the record, the five actions and the transition rules — is
 * `src/shared/session-lifecycle.ts`. This file is the storage and the orchestration half, and it
 * introduces **no** new persistence: exactly like the named-session registry it keeps one
 * control-store operation per record revision, keyed by `lifecycle.r<revision>` inside the session's
 * own scope. The control store's `UNIQUE(project_id, session_id, idempotency_key)` index is what
 * makes two writers aiming at the same revision a conflict rather than two records, so a stale
 * client can never overwrite a newer state.
 *
 * The other half of this file is orchestration. An action is planned purely (which state, whether it
 * dispatches, which request identity) and then performed in a **fixed order that differs by kind**,
 * because the two kinds of effect have opposite failure modes:
 *
 * - a **dispatching** action (`resume`, `retry`) writes the durable transition **first** and only then
 *   asks the port to dispatch. The write *is* the serialization point and the authorisation: the
 *   racer that wins revision R+1 is the only one that may send a model request, and a racer that
 *   loses it is refused with a conflict having performed no effect. Two racers can therefore never
 *   both spend, which no effect-first order could guarantee - it could only make a second spend
 *   *likely to collapse* after both had already dispatched.
 *   The port's own capability check (`authoriseDispatch`) is asked *before* the write, so a port that
 *   can never dispatch (agents disabled, an unregistered project) refuses and changes nothing.
 *   If the port then refuses an effect the record has already authorised, the attempt is closed
 *   durably as `failed` with one fixed, path-free reason: nothing is sent, nothing is replayed, no
 *   revision is left claiming a generation that never started, and the session stays retryable.
 *   A crash between the write and the dispatch leaves a `running` record for work that may not have
 *   been sent; the next start adopts it as an uncertain interruption (operator attention) rather than
 *   replaying it, and while the process lives the owner can pause it (which keeps it resumable) or
 *   stop it.
 * - a **cancelling** action (`stop`, `pause`) asks the port to cancel first and then writes, because
 *   its effect is to end work that is already open rather than to spend: a port that refuses a cancel
 *   leaves the record exactly as it was, still describing the generation that is still running. The
 *   one writer at the cancel's revision is the owner: the harness suppresses its own settled hook for
 *   an owner-initiated cancel (see `harness-host.ts`), so the owner's terminal or paused state can
 *   never be overwritten by the watcher observing the very end the cancel caused.
 * - `reconnect` and an already-stopped or already-paused session change nothing and call no port at
 *   all, which is why they can never cause a model request.
 *
 * Every read and write is frozen. Nothing in this file opens an agent harness, reads or writes a
 * transcript, or sends anything to a provider by itself: the only model work is whatever the injected
 * port performs, and the tests inject a synthetic one.
 */

const OPERATION_KIND = 'session.lifecycle';
const OUTBOX_KIND = 'session.lifecycle';

function storage(message: string): SessionLifecycleError {
  return new SessionLifecycleError(message, 'STORAGE');
}
/** The request-identity rule, shared with the pure model, parsed once here for the admin transitions. */
const requestIdRule = /^[^\s\u0000-\u001f\u007f]{1,200}$/;
function parseSessionLifecycleRequestId(value: unknown): string {
  if (typeof value !== 'string' || !requestIdRule.test(value))
    throw new SessionLifecycleError('requestId must be 1-200 printable characters', 'INVALID');
  return value;
}
/** Builds the next revision of a record from the current one, without going through an owner action. */
function buildLifecycleRecord(
  current: SessionLifecycleRecord,
  change: {
    state: SessionLifecycleRecord['state'];
    attempt?: number;
    requestId?: string | null;
    reason: string | null;
    uncertain: boolean;
    now: Date;
  }
): SessionLifecycleRecord {
  const at = change.now.getTime();
  if (!Number.isFinite(at)) throw new SessionLifecycleError('The session lifecycle clock is not a valid instant', 'INVALID');
  const timestamp = new Date(at).toISOString();
  return validateSessionLifecycleRecord({
    version: SESSION_LIFECYCLE_VERSION,
    projectId: current.projectId,
    sessionId: current.sessionId,
    state: change.state,
    revision: current.revision + 1,
    attempt: change.attempt === undefined ? current.attempt : change.attempt,
    requestId: change.requestId === undefined ? current.requestId : change.requestId,
    reason: change.reason,
    uncertain: change.uncertain,
    activityAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * How one action performs its effect outside the store.
 *
 * `resume` continues the current generation, reusing the record's original request identity.
 * `retry` starts a new attempt with the `requestId` the plan chose.
 * `cancel` asks the current generation to stop (used by both `stop` and `pause`).
 *
 * A port is the only place model work can happen; a port that cannot perform an action refuses with
 * an error, and the store is told nothing about an effect that did not happen.
 */
export interface SessionLifecyclePort {
  /**
   * Whether this port can dispatch at all right now. It is asked **before** the durable write of a
   * dispatching action, so a port that can never dispatch (agents disabled on this instance, a
   * project that is not registered) refuses without claiming a revision or writing anything.
   *
   * It must perform no model work: it may only check that a dispatch is possible at all. Opening an
   * agent harness here would itself be a model request, so it never happens.
   */
  authoriseDispatch(input: { readonly projectId: string; readonly sessionId: string; readonly record: SessionLifecycleRecord }): Promise<void> | void;
  resume(input: { readonly projectId: string; readonly sessionId: string; readonly record: SessionLifecycleRecord; readonly requestId: string }): Promise<void>;
  retry(input: { readonly projectId: string; readonly sessionId: string; readonly record: SessionLifecycleRecord; readonly requestId: string }): Promise<void>;
  cancel(input: { readonly projectId: string; readonly sessionId: string; readonly record: SessionLifecycleRecord }): Promise<void>;
}

/** One action's outcome: the record it produced and whether an effect was dispatched or cancelled. */
export type SessionLifecycleActionResult = {
  readonly record: SessionLifecycleRecord;
  /** True only when a model request may have been dispatched (`resume` or `retry`). */
  readonly dispatched: boolean;
  /** True when the port was asked to stop the current generation (`stop` or `pause`). */
  readonly cancelled: boolean;
  /** True for a legal no-op: reconnect, an already-stopped session, an already-paused one. */
  readonly unchanged: boolean;
};

export type SessionLifecycleOptions = {
  readonly clock?: () => Date;
};

/**
 * The durable lifecycle store. Every write is one control-store admission; every read is a read-only
 * SELECT plus the store's own validated getters.
 */
export class SessionLifecycleStore {
  private readonly clock: () => Date;
  constructor(private readonly store: ControlStore, options: SessionLifecycleOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** Read the record of one session, or the deterministic idle record it has before its first write. */
  read(projectId: unknown, sessionId: unknown): SessionLifecycleRecord {
    const project = parseSessionLifecycleIdentifier(projectId, 'projectId');
    const session = parseSessionLifecycleIdentifier(sessionId, 'sessionId');
    return this.latest(project, session) ?? initialSessionLifecycle(project, session);
  }

  /** Whether this exact project/session pair already has a durable lifecycle row. */
  has(projectId: unknown, sessionId: unknown): boolean {
    const project = parseSessionLifecycleIdentifier(projectId, 'projectId');
    const session = parseSessionLifecycleIdentifier(sessionId, 'sessionId');
    return this.latest(project, session) !== null;
  }

  /** Every session whose durable state is `running`, in a deterministic order, for startup adoption. */
  running(): readonly SessionLifecycleRecord[] {
    const rows = this.rows('SELECT id,project_id,session_id FROM operations WHERE kind=? ORDER BY rowid', [OPERATION_KIND]);
    const latest = new Map<string, SessionLifecycleRecord>();
    for (const row of rows) {
      const projectId = String(row.project_id), sessionId = String(row.session_id);
      const record = this.decode(String(row.id), { projectId, sessionId });
      const key = projectId + '\n' + sessionId;
      const previous = latest.get(key);
      if (previous === undefined || record.revision > previous.revision) latest.set(key, record);
      else if (record.revision === previous.revision) throw storage('Corrupt lifecycle storage: two records share a revision');
    }
    return Object.freeze(
      [...latest.values()]
        .filter((record) => record.state === 'running')
        .sort((left, right) => left.projectId.localeCompare(right.projectId) || left.sessionId.localeCompare(right.sessionId))
    );
  }

  /**
   * The administrative "a generation started" transition the harness reports. It is not an owner
   * action: it exists so a run that the live process starts is visible in the durable record, which
   * is exactly what the next start's adoption reads. It is a no-op while the session is already
   * running (a queued follow-up does not restart the attempt), and it opens one new attempt otherwise.
   */
  markRunning(input: { projectId: unknown; sessionId: unknown; requestId: unknown; now?: Date }): SessionLifecycleRecord {
    const project = parseSessionLifecycleIdentifier(input.projectId, 'projectId');
    const session = parseSessionLifecycleIdentifier(input.sessionId, 'sessionId');
    const requestId = parseSessionLifecycleRequestId(input.requestId);
    const current = this.read(project, session);
    if (current.state === 'running') return current;
    return this.write(
      buildLifecycleRecord(current, {
        state: 'running',
        attempt: current.attempt + 1,
        requestId,
        reason: null,
        uncertain: false,
        now: input.now ?? this.clock()
      })
    );
  }

  /**
   * The administrative "the running generation ended" transition. It is a no-op unless the session is
   * currently running, so it can never clobber a state an owner action deliberately set (a pause, or a
   * stop) and it can never turn a failed session back into an idle one.
   */
  markSettled(input: { projectId: unknown; sessionId: unknown; outcome: 'idle' | 'failed'; reason?: unknown; now?: Date }): SessionLifecycleRecord {
    const project = parseSessionLifecycleIdentifier(input.projectId, 'projectId');
    const session = parseSessionLifecycleIdentifier(input.sessionId, 'sessionId');
    const current = this.read(project, session);
    if (current.state !== 'running') return current;
    if (input.outcome === 'failed') {
      const reason = input.reason === undefined || input.reason === null ? 'The generation ended in a terminal failure.' : parseSessionLifecycleReason(input.reason);
      return this.write(buildLifecycleRecord(current, { state: 'failed', reason, uncertain: false, now: input.now ?? this.clock() }));
    }
    return this.write(buildLifecycleRecord(current, { state: 'idle', reason: null, uncertain: false, now: input.now ?? this.clock() }));
  }

  /** The one write path: a strict record, one admission, and the store's own conflict verdict. */
  write(record: SessionLifecycleRecord): SessionLifecycleRecord {
    const validated = validateSessionLifecycleRecord(record);
    let admitted: { operation: OperationRecord; outbox: OutboxRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: { projectId: validated.projectId, sessionId: validated.sessionId },
        // One key per revision inside this session's own scope: the store's unique index is what
        // makes two writers at the same revision a conflict rather than two records.
        idempotencyKey: 'lifecycle.r' + validated.revision,
        kind: OPERATION_KIND,
        input: validated,
        outbox: { kind: OUTBOX_KIND, payload: { version: 1, sessionId: validated.sessionId, revision: validated.revision } }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new SessionLifecycleError(
          'Session ' + validated.sessionId + ' lifecycle revision ' + validated.revision + ' was already written by another writer (' + error.message + '); the record is unchanged',
          'CONFLICT'
        );
      throw storage('The durable store refused the session lifecycle write: ' + (error as Error).message);
    }
    // One writer per revision, even when the two writes are byte-identical: the revision is the
    // compare-and-swap, so a second admission of a revision that is already written is a *second
    // writer* being refused, not the same record being written twice. Treating an identical
    // duplicate as success would let two racers both believe they had won a dispatching revision.
    if (admitted.existing)
      throw new SessionLifecycleError(
        'Session ' + validated.sessionId + ' lifecycle revision ' + validated.revision + ' was already written; the record is unchanged',
        'CONFLICT'
      );
    return validated;
  }

  private latest(projectId: string, sessionId: string): SessionLifecycleRecord | null {
    const rows = this.rows('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid', [projectId, sessionId, OPERATION_KIND]);
    let latest: SessionLifecycleRecord | null = null;
    for (const row of rows) {
      const record = this.decode(String(row.id), { projectId, sessionId });
      if (latest === null || record.revision > latest.revision) latest = record;
      else if (record.revision === latest.revision) throw storage('Corrupt lifecycle storage: two records of session ' + sessionId + ' share revision ' + record.revision);
    }
    return latest;
  }

  private decode(operationId: string, scope: ControlScope): SessionLifecycleRecord {
    let operation: OperationRecord;
    try {
      operation = this.store.getOperation(operationId, scope);
    } catch (error) {
      throw storage('The durable store could not read lifecycle operation ' + operationId + ': ' + (error as Error).message);
    }
    if (operation.kind !== OPERATION_KIND) throw storage('Session lifecycle storage holds an unexpected operation kind');
    let record: SessionLifecycleRecord;
    try {
      record = validateSessionLifecycleRecord(operation.input, 'INVALID');
    } catch (error) {
      throw storage('A stored session lifecycle record is corrupt: ' + (error as Error).message);
    }
    if (record.sessionId !== scope.sessionId || record.projectId !== scope.projectId) throw storage('A stored session lifecycle record is outside its own scope');
    const outbox = this.outboxFor(operation.id, scope);
    if (outbox.kind !== OUTBOX_KIND) throw storage('Session lifecycle storage holds an unexpected outbox kind');
    if (outbox.state !== 'pending') throw storage('A session lifecycle outbox must stay pending for the life of the record');
    const payload = outbox.payload as { version?: unknown; sessionId?: unknown; revision?: unknown } | null;
    if (!payload || typeof payload !== 'object' || payload.version !== 1 || payload.sessionId !== record.sessionId || payload.revision !== record.revision)
      throw storage('The stored session lifecycle outbox payload does not describe its record');
    return record;
  }
  private outboxFor(operationId: string, scope: ControlScope): OutboxRecord {
    const rows = this.rows('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2', [operationId]);
    if (rows.length !== 1) throw storage('Session lifecycle storage holds no unambiguous outbox row for one of its operations');
    try {
      return this.store.getOutbox(String(rows[0].id), scope);
    } catch (error) {
      throw storage('The durable store could not read a session lifecycle outbox: ' + (error as Error).message);
    }
  }
  /** Read-only SELECTs over the reviewed control schema; every record is read back through the store's own getters. */
  private rows(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try {
      return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    } catch (error) {
      throw storage('The durable control store could not be read: ' + (error as Error).message);
    }
  }
}

/**
 * The orchestration half: it turns one owner action into at most one transition plus at most one port
 * effect, in an order that never lets the record lie about a generation.
 */
export class SessionLifecycleService {
  private readonly clock: () => Date;
  constructor(private readonly store: SessionLifecycleStore, private readonly port: SessionLifecyclePort, options: SessionLifecycleOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  read(projectId: unknown, sessionId: unknown): SessionLifecycleRecord {
    return this.store.read(projectId, sessionId);
  }

  /**
   * Run one owner action. The revision is checked before anything happens; an illegal jump, a stale
   * revision or an uncertain interruption is refused with no effect and no mutation.
   */
  async run(projectId: unknown, sessionId: unknown, action: unknown, input: { revision: unknown; reason?: unknown }): Promise<SessionLifecycleActionResult> {
    const project = parseSessionLifecycleIdentifier(projectId, 'projectId');
    const session = parseSessionLifecycleIdentifier(sessionId, 'sessionId');
    const parsedAction = parseSessionLifecycleAction(action);
    const current = this.store.read(project, session);
    if (input?.reason !== undefined && input.reason !== null) parseSessionLifecycleReason(input.reason);
    // The plan carries the request identity of the attempt: reused by `resume`, and derived from the
    // revision it writes by `retry`. Nothing here mints an identity, so two racers at one revision
    // plan the identical submission and the durable write can pick a single winner.
    const plan = planSessionLifecycleAction(current, parsedAction, {
      revision: input?.revision,
      reason: input?.reason,
      now: this.clock()
    });
    if (plan.kind === 'unchanged') return Object.freeze({ record: current, dispatched: false, cancelled: false, unchanged: true });
    return this.perform(project, session, parsedAction, plan);
  }

  private async perform(projectId: string, sessionId: string, action: SessionLifecycleAction, plan: Extract<SessionLifecyclePlan, { kind: 'transition' }>): Promise<SessionLifecycleActionResult> {
    if (plan.dispatch) return this.dispatch(projectId, sessionId, action, plan);
    // A cancel ends work that is already open rather than spending anything, so its effect goes
    // first: a port that refuses to cancel leaves the record exactly as it was, still describing the
    // generation that is still running. The owner's write is the only one at this revision, because
    // the harness suppresses its own settled hook for an owner-initiated cancel.
    await this.port.cancel({ projectId, sessionId, record: plan.record });
    const persisted = this.store.write(plan.next);
    return Object.freeze({ record: persisted, dispatched: false, cancelled: true, unchanged: false });
  }

  /**
   * A dispatching action, in the only order that cannot double-spend.
   *
   * 1. The port is asked whether it can dispatch at all. It performs no model work, and a refusal
   *    here leaves the durable record untouched.
   * 2. The durable transition is written. This is the **serialization point and the authorisation**:
   *    the racer that wins revision R+1 is the only one that reaches step 3, and the loser is refused
   *    with a conflict having dispatched nothing. Waiting for the effect first could not give that -
   *    both racers would already have sent their request.
   * 3. The plan's request identity is dispatched. `resume` reuses the record's identity and `retry`
   *    uses the identity derived from the revision, so two racers submit the *same* identity and the
   *    harness collapses them onto one submission even if both were to reach it.
   *
   * A refusal at step 3 closes the attempt the record already authorised as `failed`, with one fixed,
   * path-free reason and at its own revision. The record therefore never claims a generation that was
   * not dispatched, no provider text (and so no path) is ever stored, and the session stays
   * retryable. The port's own error is returned to the caller unchanged.
   */
  private async dispatch(projectId: string, sessionId: string, action: SessionLifecycleAction, plan: Extract<SessionLifecyclePlan, { kind: 'transition' }>): Promise<SessionLifecycleActionResult> {
    const requestId = plan.requestId;
    if (requestId === null) throw new SessionLifecycleError('A dispatching action planned no request identity', 'CORRUPT');
    await this.port.authoriseDispatch({ projectId, sessionId, record: plan.record });
    const persisted = this.store.write(plan.next);
    try {
      if (action === 'resume') await this.port.resume({ projectId, sessionId, record: plan.record, requestId });
      else await this.port.retry({ projectId, sessionId, record: plan.record, requestId });
    } catch (error) {
      try {
        this.store.write(
          buildLifecycleRecord(persisted, {
            state: 'failed',
            reason: SESSION_LIFECYCLE_DISPATCH_REFUSED_REASON,
            uncertain: false,
            now: this.clock()
          })
        );
      } catch (compensation) {
        // The session is still recoverable (the owner's next action re-reads the record), and the
        // port's own refusal is what the caller must see, so it is reported rather than thrown away.
        console.error('The refused dispatch for session ' + sessionId + ' could not be recorded as failed (' + (compensation as Error).message + '); the caller still receives the refusal');
      }
      throw error;
    }
    return Object.freeze({ record: persisted, dispatched: true, cancelled: false, unchanged: false });
  }
}

/** What one start did about the running lifecycles it found. Deterministic, and never a filesystem path. */
export type SessionLifecycleAdoptionReport = {
  readonly readOnly: false;
  readonly adopted: number;
  readonly entries: readonly { readonly projectId: string; readonly sessionId: string; readonly revision: number }[];
};

/**
 * The startup adoption: every session whose durable state says `running` but whose process is gone
 * is marked `interrupted`, with a reason and an uncertainty flag, at its next revision.
 *
 * It is deterministic and idempotent: the sessions are adopted in a fixed order, a second start
 * finds no running record and changes nothing, and no browser is involved. It is deliberately
 * distinct from the delivery reconciliation: it moves no outbox row, re-sends nothing and replays
 * no effect. An adopted `uncertain` session refuses `resume`, so the interrupted generation is
 * never replayed.
 */
export function adoptRunningSessions(store: SessionLifecycleStore, now: Date): SessionLifecycleAdoptionReport {
  const entries: { projectId: string; sessionId: string; revision: number }[] = [];
  for (const current of store.running()) {
    const plan = planStartupAdoption(current, now);
    if (plan.kind !== 'transition') continue;
    const persisted = store.write(plan.next);
    entries.push({ projectId: persisted.projectId, sessionId: persisted.sessionId, revision: persisted.revision });
  }
  return Object.freeze({ readOnly: false as const, adopted: entries.length, entries: Object.freeze(entries) });
}

