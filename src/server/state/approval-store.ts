import { randomBytes } from 'node:crypto';
import { CONTROL_RECORD_VERSION, exceedsJsonLimit, validateOperationRecord, validateOutboxRecord, type ControlScope, type OperationRecord, type OutboxRecord } from '../../shared/control-state';
import { ControlStore, ControlStoreError } from './control-store';
import {
  APPROVAL_NONCE_BYTES, APPROVAL_NONCE_PATTERN, APPROVAL_RECORD_VERSION, ApprovalError, approvalIsExpired, approvalTargetDiffs,
  parseApprovalKind, parseApprovalScope, parseApprovalTarget, sameApprovalScope, sameApprovalTarget, validateApprovalDefinition,
  validateApprovalRecord, validateApprovalRequest,
  type ApprovalDefinition, type ApprovalKind, type ApprovalRecord, type ApprovalScope, type ApprovalState, type ApprovalTarget
} from '../../shared/approvals';

/**
 * Durable, scoped, single-use approvals.
 *
 * The model, the closed kind set, the per-kind target identity and the strict validation live in
 * `src/shared/approvals.ts`. This file is the storage and lifecycle half, and it introduces **no**
 * new persistence: an approval is one control-store operation (its immutable definition is the
 * operation input) whose lifecycle is the operation's state and receipt — pending is `pending`,
 * consumed is `succeeded` with the consumption receipt, revoked is `failed` with the revocation
 * receipt. Every write goes through `ControlStore.admit` and `ControlStore.updateOperation`.
 *
 * Two consequences matter:
 *
 * - **Single use.** `updateOperation` refuses any transition away from a terminal state and
 *   checks the expected revision inside its own transaction, so a second consumption (in this
 *   process, in another process, or after a crash and reopen) is refused and a race between a
 *   check and a write cannot leave a consumable approval behind.
 * - **No action.** Consuming records who or what consumed it and returns the exact target it
 *   authorised. It performs no commit, push, deploy, spend, provision or publish.
 */

const OPERATION_KIND = 'approval.record';
const OUTBOX_KIND = 'approval.lifecycle';
/**
 * The control store scopes operations by project and session, while an approval scope may name
 * only one of them. The control-layer scope is therefore a storage bucket, never the authority:
 * the approval's own scope is stored inside the record and is the only thing enforced here, and a
 * record is always read back by primary key.
 */
const UNNAMED = 'unscoped';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function storage(message: string): ApprovalError {
  return new ApprovalError(message, 'STORAGE');
}
function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) throw new ApprovalError(label + ' must be 1-160 characters from A-Za-z0-9._:-', 'INVALID');
  return value;
}
function isInstant(value: unknown): boolean {
  return typeof value === 'string' && isoInstantPattern.test(value) && Number.isFinite(Date.parse(value));
}
/** A stored receipt is a strict, closed record: anything else is corruption, not a shorter receipt. */
function readReceipt(value: unknown, fields: Record<string, (field: unknown) => boolean>, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw storage('Stored ' + label + ' is not an object');
  const keys = Object.keys(value);
  if (keys.length !== Object.keys(fields).length || keys.some((key) => !(key in fields))) throw storage('Stored ' + label + ' has unexpected fields');
  for (const [key, check] of Object.entries(fields)) if (!check((value as Record<string, unknown>)[key])) throw storage('Stored ' + label + ' has an invalid ' + key);
  return value as Record<string, unknown>;
}
/** Rebuilds the record a reader sees from the durable operation, refusing any impossible combination. */
function decodeOperationRow(row: Record<string, unknown>): OperationRecord {
  const parse = (text: unknown, label: string): unknown => {
    if (typeof text !== 'string') throw storage('Stored ' + label + ' is not a JSON text value');
    if (exceedsJsonLimit(text)) throw storage('Stored ' + label + ' exceeds the control payload limit');
    try { return JSON.parse(text); } catch { throw storage('Stored ' + label + ' is not readable JSON'); }
  };
  try {
    return validateOperationRecord({
      version: CONTROL_RECORD_VERSION,
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      inputDigest: row.input_digest,
      input: parse(row.input_json, 'operation input'),
      state: row.state,
      revision: row.revision,
      receipt: row.receipt_json === null ? null : parse(row.receipt_json, 'operation receipt'),
      receiptPresent: row.receipt_json !== null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  } catch (error) {
    if (error instanceof ApprovalError) throw error;
    throw storage('Stored approval operation record is corrupt: ' + (error as Error).message);
  }
}
function decodeOutboxRow(row: Record<string, unknown>): OutboxRecord {
  try {
    return validateOutboxRecord({
      version: CONTROL_RECORD_VERSION,
      id: row.id,
      operationId: row.operation_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      kind: row.kind,
      payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : null,
      state: row.state,
      revision: row.revision,
      receipt: row.receipt_json === null || row.receipt_json === undefined ? null : JSON.parse(String(row.receipt_json)),
      receiptPresent: row.receipt_json !== null && row.receipt_json !== undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  } catch (error) {
    throw storage('Stored approval outbox record is corrupt: ' + (error as Error).message);
  }
}

export type ApprovalConsumeInput = {
  readonly id: unknown;
  readonly scope: unknown;
  readonly kind: unknown;
  readonly target: unknown;
  readonly consumedBy: unknown;
};
export type ApprovalConsumeResult = { readonly approval: ApprovalRecord; readonly target: ApprovalTarget };
export type ApprovalRevokeInput = { readonly id: unknown; readonly scope: unknown; readonly revokedBy: unknown; readonly reason?: unknown };
export type ApprovalStoreOptions = { clock?: () => Date; nonce?: () => string };

export class ApprovalStore {
  private readonly clock: () => Date;
  private readonly nonce: () => string;
  constructor(private readonly store: ControlStore, options: ApprovalStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(APPROVAL_NONCE_BYTES).toString('hex'));
  }

  /** Creates one pending approval. The id, the nonce and the issue time are the store's. */
  create(input: unknown): ApprovalRecord {
    const request = validateApprovalRequest(input, this.clock());
    const nonce = this.nonce();
    if (typeof nonce !== 'string' || !APPROVAL_NONCE_PATTERN.test(nonce)) throw storage('The approval nonce source returned an unusable nonce');
    const definition = Object.freeze({
      version: APPROVAL_RECORD_VERSION,
      kind: request.kind,
      scope: request.scope,
      target: request.target,
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
      nonce
    }) as ApprovalDefinition;
    let admitted;
    try {
      admitted = this.store.admit({
        scope: this.bucket(request.scope),
        idempotencyKey: 'approval.' + nonce,
        kind: OPERATION_KIND,
        input: definition,
        outbox: { kind: OUTBOX_KIND, payload: { version: 1, approvalKind: request.kind, issuedAt: request.issuedAt } }
      });
    } catch (error) {
      throw this.writeFailure('create the approval', error);
    }
    if (admitted.existing) throw storage('The generated approval nonce already exists; refusing to reuse an existing record');
    return this.record(admitted.operation, this.outboxFor(admitted.operation.id));
  }

  /** Reads one approval. A record outside the requested scope is refused, not hidden. */
  read(scopeFilter: unknown, id: unknown): ApprovalRecord {
    const filter = parseApprovalScope(scopeFilter, 'scope filter');
    const identity = requireIdentifier(id, 'id');
    const record = this.recordOf(identity);
    if (!sameApprovalScope(filter, record.scope)) throw new ApprovalError('Approval ' + record.id + ' is outside the requested scope', 'SCOPE');
    return record;
  }

  /**
   * Lists the approvals in scope that can still be consumed, oldest first by id. An expired record
   * is not listed because it can never be consumed; it stays readable by id so an operator can see
   * and revoke it.
   */
  listPending(scopeFilter: unknown): readonly ApprovalRecord[] {
    const filter = parseApprovalScope(scopeFilter, 'scope filter');
    const now = this.clock();
    const records: ApprovalRecord[] = [];
    for (const operation of this.all()) {
      const record = this.record(operation, this.outboxFor(operation.id));
      if (record.state !== 'pending') continue;
      if (approvalIsExpired(record, now)) continue;
      if (!sameApprovalScope(filter, record.scope)) continue;
      records.push(record);
    }
    return Object.freeze(records.sort((left, right) => left.id.localeCompare(right.id)));
  }

  /**
   * Consumes one approval, exactly once. The kind, the scope and every target field must match
   * exactly, the record must still be pending and unexpired, and the write is the store's own
   * checked transaction, so a crash between check and consume cannot leave a consumable approval.
   * The exact target it authorised is returned; the action itself is not performed here.
   */
  consume(input: ApprovalConsumeInput): ApprovalConsumeResult {
    const filter = parseApprovalScope(input?.scope, 'scope filter');
    const identity = requireIdentifier(input?.id, 'id');
    const requestedKind = parseApprovalKind(input?.kind);
    const requestedTarget = parseApprovalTarget(requestedKind, input?.target);
    const consumer = requireIdentifier(input?.consumedBy, 'consumedBy');
    const operation = this.find(identity);
    const before = this.record(operation, this.outboxFor(operation.id));
    if (!sameApprovalScope(filter, before.scope)) throw new ApprovalError('Approval ' + before.id + ' is outside the requested scope', 'SCOPE');
    if (before.kind !== requestedKind) throw new ApprovalError('Approval ' + before.id + ' authorises \'' + before.kind + '\', not \'' + requestedKind + '\'', 'KIND_MISMATCH');
    if (!sameApprovalTarget(requestedKind, before.target, requestedTarget)) {
      const diffs = approvalTargetDiffs(requestedKind, before.target, requestedTarget);
      throw new ApprovalError('Approval ' + before.id + ' authorises a different ' + before.kind + ' target (differing fields: ' + (diffs.join(', ') || 'unknown') + ')', 'TARGET_MISMATCH');
    }
    if (before.state === 'revoked') throw new ApprovalError('Approval ' + before.id + ' was revoked at ' + before.revokedAt + '; it cannot be consumed', 'REVOKED');
    if (before.state === 'consumed') throw new ApprovalError('Approval ' + before.id + ' was already consumed at ' + before.consumedAt + ' by ' + before.consumedBy + '; it is single use and cannot be consumed again', 'CONSUMED');
    const now = this.clock();
    if (approvalIsExpired(before, now)) throw new ApprovalError('Approval ' + before.id + ' expired at ' + before.expiresAt + '; an expired approval cannot be consumed', 'EXPIRED');
    const receipt = Object.freeze({ consumedAt: new Date(now.getTime()).toISOString(), consumedBy: consumer });
    let updated: OperationRecord;
    try {
      updated = this.store.updateOperation(operation.id, this.bucket(before.scope), operation.revision, 'succeeded', receipt);
    } catch (error) {
      throw this.transitionFailure(before.id, error, 'it is not consumable again');
    }
    return Object.freeze({ approval: this.record(updated, this.outboxFor(updated.id)), target: before.target });
  }

  /**
   * Revokes a pending approval so it can never be consumed. Revoking an already revoked approval
   * returns that record unchanged; a consumed approval cannot be revoked, because the action it
   * authorised may already have happened.
   */
  revoke(input: ApprovalRevokeInput): ApprovalRecord {
    const filter = parseApprovalScope(input?.scope, 'scope filter');
    const identity = requireIdentifier(input?.id, 'id');
    const revoker = requireIdentifier(input?.revokedBy, 'revokedBy');
    const reason = input?.reason ?? null;
    if (reason !== null && (typeof reason !== 'string' || reason.length === 0 || reason.length > 400))
      throw new ApprovalError('reason must be null or a 1-400 character string', 'INVALID');
    const operation = this.find(identity);
    const before = this.record(operation, this.outboxFor(operation.id));
    if (!sameApprovalScope(filter, before.scope)) throw new ApprovalError('Approval ' + before.id + ' is outside the requested scope', 'SCOPE');
    if (before.state === 'consumed') throw new ApprovalError('Approval ' + before.id + ' was already consumed at ' + before.consumedAt + '; a spent approval cannot be revoked', 'CONSUMED');
    if (before.state === 'revoked') return before;
    const receipt = Object.freeze({ revokedAt: new Date(this.clock().getTime()).toISOString(), revokedBy: revoker, reason });
    let updated: OperationRecord;
    try {
      updated = this.store.updateOperation(operation.id, this.bucket(before.scope), operation.revision, 'failed', receipt);
    } catch (error) {
      throw this.transitionFailure(before.id, error, 'the revocation wrote nothing and the record is unchanged');
    }
    return this.record(updated, this.outboxFor(updated.id));
  }

  private bucket(scope: ApprovalScope): ControlScope {
    return { projectId: scope.projectId ?? UNNAMED, sessionId: scope.sessionId ?? UNNAMED };
  }
  private record(operation: OperationRecord, outbox: OutboxRecord): ApprovalRecord {
    // A definition read back from storage is not a caller's request: if it does not validate, the
    // durable record is corrupt, so it is refused as a storage fault rather than an input error.
    let definition: ApprovalDefinition;
    try { definition = validateApprovalDefinition(operation.input); }
    catch (error) { throw storage('Stored approval definition is corrupt: ' + (error as Error).message); }
    if (outbox.operationId !== operation.id) throw storage('Approval outbox does not belong to its operation');
    if (outbox.kind !== OUTBOX_KIND) throw storage('Approval outbox has an unexpected kind');
    if (outbox.state !== 'pending') throw storage('Approval outbox must stay pending for the life of the record');
    const lifecycle = this.lifecycle(operation);
    return validateApprovalRecord({ ...definition, id: operation.id, ...lifecycle });
  }
  private recordOf(id: string): ApprovalRecord {
    const operation = this.find(id);
    return this.record(operation, this.outboxFor(operation.id));
  }
  private lifecycle(operation: OperationRecord): { state: ApprovalState; consumedAt: string | null; consumedBy: string | null; revokedAt: string | null } {
    if (operation.state === 'pending') {
      if (operation.receiptPresent) throw storage('A pending approval carries receipt evidence');
      return { state: 'pending', consumedAt: null, consumedBy: null, revokedAt: null };
    }
    if (operation.state === 'succeeded') {
      const receipt = readReceipt(operation.receipt, { consumedAt: isInstant, consumedBy: (value) => typeof value === 'string' && identifierPattern.test(value) }, 'consumption receipt');
      return { state: 'consumed', consumedAt: receipt.consumedAt as string, consumedBy: receipt.consumedBy as string, revokedAt: null };
    }
    if (operation.state === 'failed') {
      const receipt = readReceipt(operation.receipt, { revokedAt: isInstant, revokedBy: (value) => typeof value === 'string' && identifierPattern.test(value), reason: (value) => value === null || typeof value === 'string' }, 'revocation receipt');
      return { state: 'revoked', consumedAt: null, consumedBy: null, revokedAt: receipt.revokedAt as string };
    }
    throw storage('Approval operation ended in state \'' + operation.state + '\', which is not an approval lifecycle state');
  }
  /**
   * The store's own checked transaction refused a lifecycle write. The wording is the refusal the
   * affected path can honestly claim: a consume says the approval is not consumable again, while a
   * revocation says only that nothing was written, rather than borrowing the consume-specific
   * sentence for a write that had nothing to do with consuming.
   */
  private transitionFailure(id: string, error: unknown, refusal: string): ApprovalError {
    if (error instanceof ControlStoreError && error.code === 'CONFLICT')
      return new ApprovalError('Approval ' + id + ' changed while it was being written (' + error.message + '); ' + refusal, 'CONFLICT');
    if (error instanceof ControlStoreError && error.code === 'SCOPE')
      return new ApprovalError('Approval ' + id + ' is outside the requested scope', 'SCOPE');
    return storage('The durable store refused the write for approval ' + id + ': ' + (error as Error).message);
  }
  private writeFailure(action: string, error: unknown): ApprovalError {
    if (error instanceof ControlStoreError && error.code === 'CONFLICT')
      return new ApprovalError('The approval key was already used with different content', 'CONFLICT');
    return storage('The durable store refused to ' + action + ': ' + (error as Error).message);
  }
  private find(id: string): OperationRecord {
    const rows = this.select('SELECT * FROM operations WHERE id=? AND kind=? LIMIT 2', [id, OPERATION_KIND]);
    if (rows.length === 0) throw new ApprovalError('No approval with id ' + id, 'NOT_FOUND');
    if (rows.length > 1) throw storage('Corrupt approval storage: duplicate approval id');
    return decodeOperationRow(rows[0]);
  }
  private all(): OperationRecord[] {
    return this.select('SELECT * FROM operations WHERE kind=? ORDER BY rowid', [OPERATION_KIND]).map(decodeOperationRow);
  }
  private outboxFor(operationId: string): OutboxRecord {
    const rows = this.select('SELECT * FROM outboxes WHERE operation_id=? LIMIT 2', [operationId]);
    if (rows.length !== 1) throw storage('Corrupt approval storage: missing or duplicate outbox row');
    return decodeOutboxRow(rows[0]);
  }
  /**
   * Read-only SELECTs over the reviewed control schema. The store exposes no enumeration API, so
   * these decoders reuse the shared record validators and interpret a row exactly as the store
   * would; nothing here writes.
   */
  private select(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try { return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[]; }
    catch (error) {
      if (error instanceof ApprovalError) throw error;
      throw storage('The durable control store could not be read: ' + (error as Error).message);
    }
  }
}
