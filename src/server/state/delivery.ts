import { createHash } from 'node:crypto';
import { z } from 'zod';
import { boundedJson, canonicalJson, type ControlScope, type OperationRecord, type OperationState, type OutboxRecord, type OutboxState } from '../../shared/control-state';
import { ControlStore, ControlStoreError } from './control-store';

/**
 * The delivery ledger: agent questions and answers as durable operations with idempotency keys.
 *
 * This is a receipt and idempotency ledger, **not** the source of truth for question text. The
 * transcript in the agent session stays canonical; the ledger keeps a copy of the text only so
 * that a re-admission with different content is a conflict instead of a silent overwrite, and it
 * never returns that text in a report. The one internal exception is the text of a recorded answer,
 * which `recordedAnswer` exposes to the reconciliation path so that a crash between the answer
 * record and the transcript write can be *finished* from the ledger instead of stranding the
 * human's answer; the owner-visible projection (`deliveries`) still returns no text at all.
 *
 * Storage is the reviewed durable control store: every write goes through `admit`,
 * `acknowledgeOutbox` and `updateOperation`, and every read is a read-only SELECT over that
 * same schema. No second persistence mechanism, table or file is introduced.
 *
 * A crash between admitting a question and acknowledging its delivery leaves a pending operation
 * and an undelivered outbox row. `reconcileOnStartup` reads those (and nothing else) and reports
 * which may be re-sent over a channel whose effect is idempotent and which need an operator. It
 * replays nothing itself: no blind replay.
 *
 * The ledger has two halves and this file is both: the write half (`admitQuestion`,
 * `answerQuestion`, `markDelivered`, `completeAcknowledgement`) is what the running application
 * uses to make a question and an answer durable before their effects, and the read half
 * (`reconcileOnStartup`, `deliveries`) is what a start and the owner read. Acting on the report is
 * the caller's decision: a start re-sends only the entries this report explicitly marks idempotent,
 * keeps a notification the channel deliberately skipped outstanding, and reports the rest for an
 * operator.
 */

export type DeliveryKind = 'question' | 'answer';

/** The durable operation and outbox kinds this ledger owns. Nothing else is ever reported. */
const LEDGER = {
  question: { operationKind: 'question.delivery', outboxKind: 'question.notify' },
  answer: { operationKind: 'answer.delivery', outboxKind: 'answer.deliver' }
} as const;

/**
 * Only these outbox kinds may be re-sent after a crash, and only because the delivery is tagged by
 * the question id: a second push for the same question collapses onto the same notification, and
 * the answer's request id is derived from the question, so a repeat finds the original submission.
 * Anything else is reported, never replayed.
 */
const IDEMPOTENT_OUTBOX_KINDS: ReadonlySet<string> = new Set([LEDGER.question.outboxKind, LEDGER.answer.outboxKind]);
const IDEMPOTENCY_MARK = 'question-tagged-notification' as const;

export type DeliveryErrorCode =
  | 'INVALID'
  | 'CONFLICT'
  | 'ANSWER_CONFLICT'
  | 'UNKNOWN_QUESTION'
  | 'AMBIGUOUS'
  | 'NOT_FOUND'
  | 'NEEDS_ATTENTION'
  | 'CORRUPT'
  | 'STORAGE';
export class DeliveryError extends Error {
  constructor(message: string, public readonly code: DeliveryErrorCode) {
    super(message);
    this.name = 'DeliveryError';
  }
}

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const isoInstant = z.string().datetime();
const MAX_TEXT = 8000;

const storedQuestion = z.strictObject({ version: z.literal(1), delivery: z.literal('question'), questionId: identifier, text: z.string().min(1).max(MAX_TEXT), askedAt: isoInstant });
const storedAnswer = z.strictObject({ version: z.literal(1), delivery: z.literal('answer'), questionId: identifier, text: z.string().min(1).max(MAX_TEXT), answeredAt: isoInstant });
const storedPayload = z.strictObject({ version: z.literal(1), delivery: z.enum(['question', 'answer']), questionId: identifier, tag: z.string().min(1).max(200), requestId: z.string().min(1).max(200).nullable() });

export type DeliveryInput =
  | { readonly version: 1; readonly delivery: 'question'; readonly questionId: string; readonly text: string; readonly askedAt: string }
  | { readonly version: 1; readonly delivery: 'answer'; readonly questionId: string; readonly text: string; readonly answeredAt: string };

function refuse(error: unknown, label: string): never {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue && issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
    throw new DeliveryError(label + ' is invalid: ' + path + (issue?.message ?? 'invalid value'), 'INVALID');
  }
  throw error;
}
function requireIdentifier(value: unknown, label: string): string {
  try { return identifier.parse(value); } catch (error) { refuse(error, label); }
}
/** A caller may pass epoch milliseconds (as the harness does) or an ISO instant; both normalise. */
function normalizeInstant(value: unknown, label: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new DeliveryError(label + ' must be epoch milliseconds or an ISO-8601 instant', 'INVALID');
    try { return new Date(value).toISOString(); } catch { throw new DeliveryError(label + ' is not a representable instant', 'INVALID'); }
  }
  if (typeof value === 'string') {
    try { return new Date(isoInstant.parse(value)).toISOString(); } catch (error) { refuse(error, label); }
  }
  throw new DeliveryError(label + ' must be epoch milliseconds or an ISO-8601 instant', 'INVALID');
}
function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new DeliveryError(label + ' must be a non-empty string', 'INVALID');
  if (value.length > MAX_TEXT) throw new DeliveryError(label + ' exceeds ' + MAX_TEXT + ' characters', 'INVALID');
  return value;
}

/**
 * The idempotency key is derived from the question id alone, so the same question always maps to
 * one operation inside its own project/session scope and never to a second outbox row.
 */
export function deliveryIdempotencyKey(delivery: DeliveryKind, questionId: string): string {
  const id = requireIdentifier(questionId, 'questionId');
  const digest = createHash('sha256').update(delivery + '\n' + id).digest('hex').slice(0, 48);
  return delivery + '.' + digest;
}

function decodeInput(operation: OperationRecord): DeliveryInput {
  const schema = operation.kind === LEDGER.question.operationKind ? storedQuestion : operation.kind === LEDGER.answer.operationKind ? storedAnswer : undefined;
  if (!schema) throw new DeliveryError('Unknown ledger operation kind: ' + operation.kind, 'CORRUPT');
  try { return schema.parse(operation.input) as DeliveryInput; } catch (error) { refuse(error, 'stored ' + operation.kind + ' input'); }
}
function decodePayload(outbox: OutboxRecord): z.infer<typeof storedPayload> {
  try { return storedPayload.parse(outbox.payload); } catch (error) { refuse(error, 'stored outbox payload'); }
}
/** The channel-level tag of one delivery: the same question always re-sends onto the same effect. */
function tagFor(delivery: DeliveryKind, questionId: string): string {
  return delivery + ':' + questionId;
}

/**
 * Whether a stored body *is* the delivery being admitted, or a different one.
 *
 * A question's identity is its whole body. An answer's identity is its **text**: the harness sends a
 * fresh `answeredAt` with every request, so comparing instants would refuse the retry that
 * reconciles a crash between the answer record and the transcript write — leaving the question open
 * forever and the human's answer stranded. A different text is still a conflict.
 */
function sameBody(delivery: DeliveryKind, stored: DeliveryInput, body: DeliveryInput): boolean {
  if (delivery !== 'answer') return canonicalJson(stored) === canonicalJson(body);
  return stored.delivery === 'answer' && body.delivery === 'answer' && stored.questionId === body.questionId && stored.text === body.text;
}

/**
 * Whether the stored outbox payload still describes this exact delivery, or why it does not.
 *
 * The idempotency claim is the payload's tag (and the request id derived from the question), so a
 * payload that disagrees with its own operation is never treated as a re-sendable effect.
 */
function payloadMismatch(outbox: OutboxRecord, delivery: DeliveryKind, questionId: string): string | null {
  if (outbox.kind !== LEDGER[delivery].outboxKind)
    return 'the outbox kind \'' + outbox.kind + '\' does not match the \'' + delivery + '\' delivery; an operator must decide';
  let payload: z.infer<typeof storedPayload>;
  try { payload = decodePayload(outbox); }
  catch (error) { return 'the stored outbox payload is not a readable delivery payload (' + (error as Error).message + '); an operator must decide'; }
  const requestId = delivery === 'answer' ? 'answer:' + questionId : null;
  if (payload.delivery !== delivery || payload.questionId !== questionId || payload.tag !== tagFor(delivery, questionId) || payload.requestId !== requestId)
    return 'the stored outbox payload does not match this delivery: kind, delivery, question id, tag and request id must all agree, and they do not; an operator must decide';
  return null;
}

export type DeliveryResult = {
  readonly operation: OperationRecord;
  readonly outbox: OutboxRecord;
  /** True when an operation with this idempotency key already existed and nothing was written. */
  readonly existing: boolean;
};
export type MarkDeliveredResult = DeliveryResult & {
  /** True when this call completed the operation state left behind by a crash mid-delivery. */
  readonly completed: boolean;
};

/**
 * One delivery as the owner sees it: its identity, both states and the receipt the channel itself
 * reported. It carries no question or answer text, no filesystem path and no secret.
 */
export type DeliveryStatus = {
  readonly delivery: DeliveryKind;
  readonly questionId: string;
  readonly operationState: OperationState;
  readonly outboxKind: string;
  readonly outboxState: OutboxState;
  /** The outbox was acknowledged and its operation completed: the effect reported itself delivered. */
  readonly delivered: boolean;
  /** When the acknowledgement was written, or null while the delivery is still outstanding. */
  readonly acknowledgedAt: string | null;
  /** The channel's own report (for a notification: `{sent,failed,skipped}`), or null. */
  readonly receipt: unknown;
};
/** Which deliveries one project/session scope has recorded, and how far each one got. */
export type DeliveryStatusView = {
  readonly scope: ControlScope;
  readonly questions: readonly DeliveryStatus[];
  readonly answers: readonly DeliveryStatus[];
  /** Operation ids this ledger cannot read back as a delivery in this scope. Never their content. */
  readonly unreadable: readonly string[];
};

export type DeliveryReconciliationEntry = {
  readonly operationId: string;
  readonly operationKind: string;
  readonly delivery: DeliveryKind | null;
  readonly questionId: string | null;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly operationState: OperationState | 'unreadable';
  readonly outboxState: OutboxState | 'absent';
  readonly disposition: 'redeliver-idempotent' | 'complete-acknowledgement' | 'needs-operator-attention';
  /** Explicitly marked true only where re-sending is idempotent. Nothing here is replayed. */
  readonly redeliver: boolean;
  readonly idempotency: typeof IDEMPOTENCY_MARK | null;
  readonly reason: string;
};
export type DeliveryReconciliation = {
  readonly readOnly: true;
  readonly redeliveryPolicy: string;
  readonly counts: {
    readonly pendingOperations: number;
    readonly undeliveredOutboxRows: number;
    readonly redeliverIdempotent: number;
    readonly completeAcknowledgement: number;
    readonly needsOperatorAttention: number;
  };
  readonly entries: readonly DeliveryReconciliationEntry[];
};

export type DeliveryLedgerOptions = { clock?: () => Date };

export class DeliveryLedger {
  private readonly clock: () => Date;
  constructor(private readonly store: ControlStore, options: DeliveryLedgerOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** Admits one question exactly once. The same question id returns the existing operation. */
  admitQuestion(input: { projectId: string; sessionId: string; questionId: string; text: string; askedAt: string | number }): DeliveryResult {
    const scope = this.requireScope(input?.projectId, input?.sessionId);
    const questionId = requireIdentifier(input?.questionId, 'questionId');
    const body: DeliveryInput = Object.freeze({ version: 1, delivery: 'question', questionId, text: requireText(input?.text, 'text'), askedAt: normalizeInstant(input?.askedAt, 'askedAt') });
    return this.admit('question', scope, body);
  }

  /**
   * Records one answer per question, at most. An answer with the same **text** reconciles, because
   * the text is the answer's semantic identity and the harness sends a fresh instant with every
   * request; a second, different answer, or an answer for a question that was never admitted in
   * this scope, is refused.
   */
  answerQuestion(input: { projectId: string; sessionId: string; questionId: string; text: string; answeredAt: string | number }): DeliveryResult {
    const scope = this.requireScope(input?.projectId, input?.sessionId);
    const questionId = requireIdentifier(input?.questionId, 'questionId');
    const body: DeliveryInput = Object.freeze({ version: 1, delivery: 'answer', questionId, text: requireText(input?.text, 'text'), answeredAt: normalizeInstant(input?.answeredAt, 'answeredAt') });
    // An answer is only meaningful for a question this scope actually asked.
    const asked = this.findKey(LEDGER.question.operationKind, deliveryIdempotencyKey('question', questionId), scope);
    if (asked.length === 0) throw new DeliveryError('Question ' + questionId + ' was never admitted in this project/session scope; the answer is refused', 'UNKNOWN_QUESTION');
    // One comparison rule, in `admit`: it returns the recorded answer unchanged for the same text
    // and refuses a different one, so a retry and its first attempt can never disagree.
    return this.admit('answer', scope, body);
  }

  /**
   * The text of the answer this ledger recorded for a question, or null when none is recorded.
   *
   * This is the ledger's own copy, for one internal caller only: the reconciliation path, which has
   * to complete a record the ledger already committed to when a crash happened between the answer
   * record and the transcript write. It is deliberately **not** part of `deliveries()`, the
   * owner-visible projection, which returns identities, states and receipts and never text: the
   * transcript stays canonical, and the interface must not become a second copy of the
   * conversation. Nothing here performs an effect; the caller decides.
   */
  recordedAnswer(input: { projectId: string; sessionId: string; questionId: string }): { text: string; answeredAt: string } | null {
    const scope = this.requireScope(input?.projectId, input?.sessionId);
    const questionId = requireIdentifier(input?.questionId, 'questionId');
    const matches = this.findKey(LEDGER.answer.operationKind, deliveryIdempotencyKey('answer', questionId), scope);
    if (matches.length === 0) return null;
    const stored = decodeInput(this.operation(matches[0].id, scope));
    // A delivery operation whose stored body is not an answer is nothing this ledger can finish.
    if (stored.delivery !== 'answer') throw new DeliveryError('The recorded delivery for question ' + questionId + ' does not hold an answer body; an operator must decide', 'CORRUPT');
    return Object.freeze({ text: stored.text, answeredAt: stored.answeredAt });
  }

  /**
   * Acknowledges one delivery exactly once. An identical receipt reconciles (including completing
   * an operation state a crash left behind); conflicting evidence is rejected and changes nothing.
   */
  markDelivered(questionId: string, receipt: unknown, options: { kind?: DeliveryKind; scope?: { projectId?: string; sessionId?: string } } = {}): MarkDeliveredResult {
    const delivery = options.kind ?? 'question';
    if (delivery !== 'question' && delivery !== 'answer') throw new DeliveryError('kind must be \'question\' or \'answer\'', 'INVALID');
    const id = requireIdentifier(questionId, 'questionId');
    // A receipt that is not bounded JSON could never be stored, so it is refused before any read.
    let receiptJson: string;
    try { receiptJson = boundedJson(receipt); } catch (error) { throw new DeliveryError('receipt is invalid: ' + (error as Error).message, 'INVALID'); }
    const located = this.locate(delivery, id, this.requireOptionalScope(options.scope));
    const deliveryScope = located.scope;
    const operation = located.operation;
    let outbox = located.outbox;

    if (outbox.state === 'delivered') {
      const stored = outbox.receiptPresent ? boundedJson(outbox.receipt) : null;
      if (stored !== receiptJson)
        throw new DeliveryError('The delivery of question ' + id + ' was already acknowledged with different evidence; nothing was changed', 'CONFLICT');
      if (operation.state === 'succeeded') return Object.freeze({ operation, outbox, existing: true, completed: false });
      if (operation.state === 'pending') {
        // The crash window: the outbox was acknowledged but the operation was never completed.
        const completed = this.update(operation, deliveryScope, receipt, 'mark the delivery complete');
        return Object.freeze({ operation: completed, outbox, existing: true, completed: true });
      }
      throw new DeliveryError('The delivery of question ' + id + ' was acknowledged but its operation ended as \'' + operation.state + '\'; an operator must decide, so nothing is replayed', 'NEEDS_ATTENTION');
    }

    if (operation.state !== 'pending')
      throw new DeliveryError('The operation for question ' + id + ' ended as \'' + operation.state + '\' while its outbox is still undelivered; an operator must decide', 'NEEDS_ATTENTION');
    if (operation.receiptPresent || outbox.receiptPresent)
      throw new DeliveryError('Question ' + id + ' carries receipt evidence before its delivery was acknowledged; an operator must decide', 'NEEDS_ATTENTION');

    let acknowledged;
    try {
      acknowledged = this.store.acknowledgeOutbox(outbox.id, deliveryScope, outbox.revision, receipt);
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new DeliveryError('The delivery of question ' + id + ' changed while it was being acknowledged (' + error.message + '); retry', 'CONFLICT');
      throw new DeliveryError('The durable store refused the acknowledgement of question ' + id + ': ' + (error as Error).message, 'STORAGE');
    }
    outbox = acknowledged.outbox;
    const completed = this.update(acknowledged.operation, deliveryScope, receipt, 'mark the delivery complete');
    return Object.freeze({ operation: completed, outbox: this.outboxFor(completed.id, deliveryScope), existing: false, completed: true });
  }

  /**
   * Completes a delivery whose outbox a crash already acknowledged, without re-sending anything: it
   * repeats `markDelivered` with the evidence the outbox itself carries, so no second
   * acknowledgement is written and none is invented. A row that is not in that state is refused.
   */
  completeAcknowledgement(questionId: string, options: { kind?: DeliveryKind; scope?: { projectId?: string; sessionId?: string } } = {}): MarkDeliveredResult {
    const delivery = options.kind ?? 'question';
    if (delivery !== 'question' && delivery !== 'answer') throw new DeliveryError('kind must be \'question\' or \'answer\'', 'INVALID');
    const id = requireIdentifier(questionId, 'questionId');
    const located = this.locate(delivery, id, this.requireOptionalScope(options.scope));
    if (located.outbox.state !== 'delivered' || !located.outbox.receiptPresent)
      throw new DeliveryError('The ' + delivery + ' delivery of question ' + id + ' has no acknowledged outbox to complete; an operator must decide', 'NEEDS_ATTENTION');
    return this.markDelivered(id, located.outbox.receipt, { kind: delivery, scope: located.scope });
  }

  /**
   * True when this exact project/session scope has already admitted the question. It is what lets a
   * caller admit-then-answer without ever admitting the same question twice.
   */
  hasQuestion(questionId: string, scope: { projectId: string; sessionId: string }): boolean {
    const id = requireIdentifier(questionId, 'questionId');
    const exact = this.requireScope(scope?.projectId, scope?.sessionId);
    return this.findKey(LEDGER.question.operationKind, deliveryIdempotencyKey('question', id), exact).length > 0;
  }

  /**
   * Read-only reconciliation over the ledger's pending operations and undelivered outbox rows. It
   * writes nothing, replays nothing and returns a deterministic, frozen report: two consecutive
   * calls over unchanged storage are deep-equal. Only entries explicitly marked `redeliver` may be
   * re-sent, and only because their effect is idempotent; every uncertain entry is reported for an
   * operator instead.
   */
  reconcileOnStartup(): DeliveryReconciliation {
    const rows = this.rows('SELECT id,project_id,session_id,kind,state FROM operations WHERE kind IN (?,?) ORDER BY rowid', [LEDGER.question.operationKind, LEDGER.answer.operationKind]);
    const outboxRows = this.rows('SELECT id,operation_id,project_id,session_id,kind,state FROM outboxes WHERE kind IN (?,?) ORDER BY rowid', [LEDGER.question.outboxKind, LEDGER.answer.outboxKind]);
    const seen = new Set<string>();
    const entries: DeliveryReconciliationEntry[] = [];

    const classify = (operationId: string, operationKind: string, rowProjectId: unknown, rowSessionId: unknown) => {
      if (seen.has(operationId)) return;
      seen.add(operationId);
      const delivery = operationKind === LEDGER.question.operationKind ? 'question' as const : operationKind === LEDGER.answer.operationKind ? 'answer' as const : null;
      const projectId = typeof rowProjectId === 'string' ? rowProjectId : null;
      const sessionId = typeof rowSessionId === 'string' ? rowSessionId : null;
      if (!delivery || projectId === null || sessionId === null) {
        entries.push(Object.freeze({ operationId, operationKind, delivery: null, questionId: null, projectId, sessionId, operationState: 'unreadable', outboxState: 'absent', disposition: 'needs-operator-attention', redeliver: false, idempotency: null, reason: 'this ledger row does not carry a readable operation kind and scope' }));
        return;
      }
      const scope: ControlScope = { projectId, sessionId };
      let operation: OperationRecord, outbox: OutboxRecord;
      try {
        operation = this.store.getOperation(operationId, scope);
        outbox = this.store.getOutbox(this.outboxIdFor(operationId, scope), scope);
      } catch (error) {
        entries.push(Object.freeze({ operationId, operationKind, delivery, questionId: null, projectId, sessionId, operationState: 'unreadable', outboxState: 'absent', disposition: 'needs-operator-attention', redeliver: false, idempotency: null, reason: 'the durable store could not read this delivery: ' + (error as Error).message }));
        return;
      }
      let questionId: string | null = null;
      try { questionId = decodeInput(operation).questionId; } catch (error) {
        entries.push(Object.freeze({ operationId, operationKind, delivery, questionId: null, projectId, sessionId, operationState: operation.state, outboxState: outbox.state, disposition: 'needs-operator-attention', redeliver: false, idempotency: null, reason: (error as Error).message }));
        return;
      }
      const base = { operationId, operationKind, delivery, questionId, projectId, sessionId, operationState: operation.state, outboxState: outbox.state };
      if (operation.state === 'succeeded' && outbox.state === 'delivered') return; // settled: not pending work
      const evidence = operation.receiptPresent && outbox.receiptPresent && boundedJson(operation.receipt) === boundedJson(outbox.receipt);
      if (outbox.state === 'pending' && operation.state === 'pending') {
        // The stored payload is validated before any idempotent re-send is claimed: the tag is what
        // collapses a repeat onto the same effect, so a payload that no longer agrees with this
        // operation would repeat a *different* effect under this row's receipt, and is never re-sent.
        const mismatch = payloadMismatch(outbox, delivery, questionId);
        if (operation.receiptPresent || outbox.receiptPresent) {
          entries.push(Object.freeze({ ...base, disposition: 'needs-operator-attention', redeliver: false, idempotency: null, reason: 'the operation and its outbox are undelivered but receipt evidence already exists; an operator must decide' }));
        } else if (mismatch !== null) {
          entries.push(Object.freeze({ ...base, disposition: 'needs-operator-attention', redeliver: false, idempotency: null, reason: mismatch }));
        } else if (IDEMPOTENT_OUTBOX_KINDS.has(outbox.kind)) {
          entries.push(Object.freeze({ ...base, disposition: 'redeliver-idempotent', redeliver: true, idempotency: IDEMPOTENCY_MARK, reason: 'the delivery is tagged by the question id, so re-sending it collapses onto the same notification' }));
        } else {
          entries.push(Object.freeze({ ...base, disposition: 'needs-operator-attention', redeliver: false, idempotency: null, reason: 'the delivery channel \'' + outbox.kind + '\' has no idempotency marker, so it is not replayed' }));
        }
        return;
      }
      if (outbox.state === 'delivered' && operation.state === 'pending') {
        if (evidence) {
          entries.push(Object.freeze({ ...base, disposition: 'complete-acknowledgement', redeliver: false, idempotency: null, reason: 'the outbox is acknowledged with matching evidence and only the operation state is missing; repeating markDelivered completes it without re-sending anything' }));
        } else {
          entries.push(Object.freeze({ ...base, disposition: 'needs-operator-attention', redeliver: false, idempotency: null, reason: 'a delivered outbox and its operation do not carry matching receipt evidence; an operator must decide' }));
        }
        return;
      }
      entries.push(Object.freeze({ ...base, disposition: 'needs-operator-attention', redeliver: false, idempotency: null, reason: 'the operation ended as \'' + operation.state + '\' with an outbox in state \'' + outbox.state + '\'; an operator must decide' }));
    };

    for (const row of rows) classify(String(row.id), String(row.kind), row.project_id, row.session_id);
    // An outbox row whose operation row is missing (or whose kind the operation scan did not see)
    // is undelivered work this ledger cannot complete: it is reported, not replayed.
    for (const row of outboxRows) {
      const operationId = String(row.operation_id);
      if (seen.has(operationId)) continue;
      seen.add(operationId);
      const operationKind = String(row.kind) === LEDGER.question.outboxKind ? LEDGER.question.operationKind : LEDGER.answer.operationKind;
      const delivery = operationKind === LEDGER.question.operationKind ? 'question' as const : 'answer' as const;
      const projectId = typeof row.project_id === 'string' ? row.project_id : null;
      const sessionId = typeof row.session_id === 'string' ? row.session_id : null;
      entries.push(Object.freeze({ operationId, operationKind, delivery, questionId: null, projectId, sessionId, operationState: 'unreadable', outboxState: 'absent', disposition: 'needs-operator-attention', redeliver: false, idempotency: null, reason: 'this undelivered outbox row has no operation of the matching ledger kind; an operator must decide' }));
    }

    entries.sort((a, b) => (a.delivery ?? '').localeCompare(b.delivery ?? '') || (a.questionId ?? '').localeCompare(b.questionId ?? '') || a.operationId.localeCompare(b.operationId));
    const frozenEntries = Object.freeze(entries);
    const counts = Object.freeze({
      pendingOperations: frozenEntries.filter((entry) => entry.operationState === 'pending').length,
      undeliveredOutboxRows: frozenEntries.filter((entry) => entry.outboxState === 'pending').length,
      redeliverIdempotent: frozenEntries.filter((entry) => entry.disposition === 'redeliver-idempotent').length,
      completeAcknowledgement: frozenEntries.filter((entry) => entry.disposition === 'complete-acknowledgement').length,
      needsOperatorAttention: frozenEntries.filter((entry) => entry.disposition === 'needs-operator-attention').length
    });
    return Object.freeze({
      readOnly: true as const,
      redeliveryPolicy: 'Nothing in this report is replayed by this call. Only entries marked redeliver may be re-sent, and only because their effect is idempotent (a notification tagged by question id); every other entry is reported for an operator instead.',
      counts,
      entries: frozenEntries
    });
  }

  /**
   * Which questions and answers this exact scope has recorded, with the receipt each channel
   * reported. It returns identifiers, states and receipts only — never question or answer text,
   * never a path and never a secret — so the owner can see which questions were delivered and which
   * answers were recorded without the ledger becoming a second copy of the transcript.
   */
  deliveries(scope: { projectId: string; sessionId: string }): DeliveryStatusView {
    const exact = this.requireScope(scope?.projectId, scope?.sessionId);
    const rows = this.rows('SELECT id,kind FROM operations WHERE project_id=? AND session_id=? AND kind IN (?,?) ORDER BY rowid', [exact.projectId, exact.sessionId, LEDGER.question.operationKind, LEDGER.answer.operationKind]);
    const questions: DeliveryStatus[] = [], answers: DeliveryStatus[] = [], unreadable: string[] = [];
    for (const row of rows) {
      const operationId = String(row.id);
      const delivery: DeliveryKind = String(row.kind) === LEDGER.question.operationKind ? 'question' : 'answer';
      try {
        const operation = this.store.getOperation(operationId, exact);
        const outbox = this.store.getOutbox(this.outboxIdFor(operationId, exact), exact);
        const status: DeliveryStatus = Object.freeze({
          delivery,
          questionId: decodeInput(operation).questionId,
          operationState: operation.state,
          outboxKind: outbox.kind,
          outboxState: outbox.state,
          delivered: operation.state === 'succeeded' && outbox.state === 'delivered',
          acknowledgedAt: outbox.receiptPresent ? outbox.updatedAt : null,
          receipt: outbox.receiptPresent ? outbox.receipt : null
        });
        (delivery === 'question' ? questions : answers).push(status);
      } catch { unreadable.push(operationId); }
    }
    const byQuestion = (left: DeliveryStatus, right: DeliveryStatus) => left.questionId.localeCompare(right.questionId) || left.delivery.localeCompare(right.delivery);
    return Object.freeze({
      scope: Object.freeze({ projectId: exact.projectId, sessionId: exact.sessionId }),
      questions: Object.freeze(questions.sort(byQuestion)),
      answers: Object.freeze(answers.sort(byQuestion)),
      unreadable: Object.freeze(unreadable)
    });
  }

  private admit(delivery: DeliveryKind, scope: ControlScope, body: DeliveryInput): DeliveryResult {
    const key = deliveryIdempotencyKey(delivery, body.questionId);
    const existing = this.findKey(LEDGER[delivery].operationKind, key, { projectId: scope.projectId, sessionId: scope.sessionId });
    if (existing.length > 0) {
      const operation = this.operation(existing[0].id, scope);
      const stored = decodeInput(operation);
      if (!sameBody(delivery, stored, body)) throw this.conflict(delivery, key, body);
      return Object.freeze({ operation, outbox: this.outboxFor(operation.id, scope), existing: true });
    }
    const payload = Object.freeze({
      version: 1 as const,
      delivery,
      questionId: body.questionId,
      tag: tagFor(delivery, body.questionId),
      requestId: delivery === 'answer' ? 'answer:' + body.questionId : null
    });
    let admitted;
    try {
      admitted = this.store.admit({ scope, idempotencyKey: key, kind: LEDGER[delivery].operationKind, input: body, outbox: { kind: LEDGER[delivery].outboxKind, payload } });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new DeliveryError('Idempotency key ' + key + ' was already admitted with different content; the existing ' + delivery + ' is unchanged', 'CONFLICT');
      throw new DeliveryError('The durable store refused the ' + delivery + ' admission: ' + (error as Error).message, 'STORAGE');
    }
    if (admitted.existing) {
      const stored = decodeInput(admitted.operation);
      if (!sameBody(delivery, stored, body)) throw this.conflict(delivery, key, body);
    }
    return Object.freeze({ operation: admitted.operation, outbox: admitted.outbox, existing: admitted.existing });
  }

  /** The refusal for a body that is not the delivery already recorded under this idempotency key. */
  private conflict(delivery: DeliveryKind, key: string, body: DeliveryInput): DeliveryError {
    return delivery === 'answer'
      ? new DeliveryError('Question ' + body.questionId + ' already has an answer; a second, different answer is refused and the recorded answer is unchanged', 'ANSWER_CONFLICT')
      : new DeliveryError('Idempotency key ' + key + ' was already admitted with different content; the existing ' + delivery + ' is unchanged', 'CONFLICT');
  }

  private update(operation: OperationRecord, scope: ControlScope, receipt: unknown, action: string): OperationRecord {
    try {
      return this.store.updateOperation(operation.id, scope, operation.revision, 'succeeded', receipt);
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new DeliveryError('The operation for this delivery changed while trying to ' + action + ' (' + error.message + '); inspect the record before retrying', 'CONFLICT');
      throw new DeliveryError('The durable store refused to ' + action + ': ' + (error as Error).message, 'STORAGE');
    }
  }

  private requireScope(projectId: unknown, sessionId: unknown): ControlScope {
    return { projectId: requireIdentifier(projectId, 'projectId'), sessionId: requireIdentifier(sessionId, 'sessionId') };
  }
  private requireOptionalScope(scope: { projectId?: string; sessionId?: string } | undefined): { projectId?: string; sessionId?: string } | undefined {
    if (scope === undefined) return undefined;
    const out: { projectId?: string; sessionId?: string } = {};
    if (scope.projectId !== undefined) out.projectId = requireIdentifier(scope.projectId, 'scope.projectId');
    if (scope.sessionId !== undefined) out.sessionId = requireIdentifier(scope.sessionId, 'scope.sessionId');
    // An empty scope object would otherwise read as "match everything", which is not a scope.
    return Object.keys(out).length ? out : undefined;
  }
  /** The one delivery of this kind for this question, in the requested scope. */
  private locate(delivery: DeliveryKind, id: string, scope: { projectId?: string; sessionId?: string } | undefined): { operation: OperationRecord; outbox: OutboxRecord; scope: ControlScope } {
    const matches = this.findKey(LEDGER[delivery].operationKind, deliveryIdempotencyKey(delivery, id), scope);
    if (matches.length === 0) throw new DeliveryError('No ' + delivery + ' delivery is recorded for question ' + id + (scope ? ' in the requested scope' : ''), 'NOT_FOUND');
    if (matches.length > 1) throw new DeliveryError('Question ' + id + ' has ' + delivery + ' deliveries in more than one scope; name the scope explicitly', 'AMBIGUOUS');
    const exact: ControlScope = { projectId: matches[0].projectId, sessionId: matches[0].sessionId };
    return { operation: this.operation(matches[0].id, exact), outbox: this.outboxFor(matches[0].id, exact), scope: exact };
  }
  private operation(id: string, scope: ControlScope): OperationRecord {
    try { return this.store.getOperation(id, scope); } catch (error) { throw new DeliveryError('The durable store could not read the delivery operation: ' + (error as Error).message, 'STORAGE'); }
  }
  private outboxFor(operationId: string, scope: ControlScope): OutboxRecord {
    return this.store.getOutbox(this.outboxIdFor(operationId, scope), scope);
  }
  private outboxIdFor(operationId: string, scope: ControlScope): string {
    const rows = this.rows('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2', [operationId]);
    if (rows.length !== 1) throw new DeliveryError('The delivery operation has no unambiguous outbox row', 'CORRUPT');
    return String(rows[0].id);
  }
  private findKey(kind: string, key: string, scope: { projectId?: string; sessionId?: string } | undefined): { id: string; projectId: string; sessionId: string }[] {
    const rows = this.rows('SELECT id,project_id,session_id FROM operations WHERE kind=? AND idempotency_key=? ORDER BY rowid', [kind, key]);
    return rows
      .map((row) => ({ id: String(row.id), projectId: String(row.project_id), sessionId: String(row.session_id) }))
      .filter((row) => (scope?.projectId === undefined || row.projectId === scope.projectId) && (scope?.sessionId === undefined || row.sessionId === scope.sessionId));
  }
  /**
   * Read-only SELECT over the reviewed control schema. The store deliberately exposes no
   * enumeration API, so a ledger read projects only key columns and then reads every record back
   * through the store's own validated getters.
   */
  private rows(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try { return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[]; }
    catch (error) { throw new DeliveryError('The durable control store could not be read: ' + (error as Error).message, 'STORAGE'); }
  }
}
