import { randomUUID } from 'node:crypto';
import { ControlStore, ControlStoreError } from './control-store';
import type { ControlScope, OperationRecord, OutboxRecord } from '../../shared/control-state';
import {
  QUEUE_ATTENTION_DETAILS, QUEUE_DEFAULT_LEASE_MS, QUEUE_MAX_ENTRIES, QUEUE_MAX_LEASE_MS, QUEUE_TRANSITIONS, QueueError,
  assertQueueTransition, initialQueue, nextQueueRevision, parseQueueEntryId, parseQueueIdentifier, parseQueueImageRefs,
  parseQueueOwner, parseQueuePosition, parseQueueRevision, parseQueueText, queueClaimVerdict, queueEntryRequestId,
  queueHead, queueInFlightViolation, queueRequestId, validateQueueRecord,
  type QueueAttentionReason, type QueueEntry, type QueueImageRef, type QueueRecord, type QueueSubmission
} from '../../shared/queue';

/**
 * The durable half of the queue: one control-store operation per queue revision, plus the one
 * dispatcher port a claim may submit through.
 *
 * It introduces **no** new persistence. Exactly like the named-session registry and the session
 * lifecycle, it keeps one operation per revision — keyed \`queue.r<revision>\` inside the session's own
 * scope — and the control store's \`UNIQUE(project_id, session_id, idempotency_key)\` index is what
 * makes two writers aiming at the same revision a conflict rather than two records. The revision is
 * therefore not a read-then-write check: every mutating operation reads the queue, plans purely,
 * yields once so the window between the read and the store's own transaction is real, and only then
 * writes at the next revision's key. Two writers that read the same revision really race, and the
 * store's index picks exactly one winner.
 *
 * Three rules keep the queue honest, and each is enforced here rather than asserted:
 *
 * 1. **The queue records intent; the transcript stays authoritative.** \`submit\` hands the input to
 *    the port under the entry's stable request identity and writes \`submitted\`. What really happened
 *    is what the transcript holds for that same request identity, and reconciliation reads it. The
 *    failure path of \`submit\` reads it too: a failed submission that can be resolved from the
 *    transcript is resolved from the transcript, and one that cannot becomes a named
 *    operator-attention state. Nothing here ever records that a dispatcher *refused*, because a
 *    refusal and a crash around the write are indistinguishable from this side. Nothing re-sends.
 * 2. **The claim is durable before the submission, and a live claim is never stolen.** \`claim\`
 *    records the intent (the entry's own text and images) and the stable request identity it
 *    authorises in one revision, before anything is submitted, so a crash in the window before the
 *    transcript write reconciles to the same submission under the same identity or to a named
 *    operator-attention state — never to a second submission and never to a silent loss. A claim is
 *    taken over only once its lease has expired: the lease is the whole of the liveness evidence this
 *    build has. The head is claimed in order, and an entry that is claimed or submitted stays the
 *    queue's effective head: no reorder may move a later input ahead of it.
 * 3. **Nothing is dispatched twice.** The submission identity is derived from the entry id alone, so
 *    a repeat under that identity is the same submission, a stored claim can only ever name its own
 *    entry's identity, and a settled or cancelled entry is never claimed again at all.
 *
 * A dispatcher port is the only place a submission can happen. It performs no model work by itself:
 * \`authorise\` only reports whether this instance can dispatch at all, and it is asked **before** a
 * claim writes anything, so an instance that cannot dispatch refuses without claiming a revision.
 */

const OPERATION_KIND = 'session.queue';
const OUTBOX_KIND = 'session.queue';

/** One submission, as the durable transcript reported it. The queue stores this, and never invents it. */
export type QueueSubmissionRecord = {
  readonly requestId: string;
  readonly entryId: string;
  readonly submissionId: string;
  readonly acceptedAt: string;
};
/**
 * The dispatcher. \`submit\` **must** be idempotent by request identity: repeating it returns the
 * submission that already exists rather than creating a second one, which is what makes a crash
 * between a claim and a submission reconcile to one submission.
 *
 * \`lookup\` is the read-only half. It is optional because this build's installed harness exposes no
 * read-back of a submission by request identity; where it is absent, reconciliation reports the named
 * operator-attention state \`submission-not-readable\` instead of guessing, and never re-sends.
 */
export type QueueDispatchPort = {
  authorise(input: { readonly projectId: string; readonly sessionId: string }): Promise<void> | void;
  submit(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly requestId: string;
    readonly entryId: string;
    readonly text: string;
    readonly images: readonly QueueImageRef[];
  }): Promise<QueueSubmissionRecord>;
  lookup?(input: { readonly projectId: string; readonly sessionId: string; readonly requestId: string }): Promise<QueueSubmissionRecord | null>;
};
/** How a caller resolves attached image ids to the stored facts the queue records. */
export type QueueImageResolver = { resolve(ids: readonly string[]): Promise<readonly QueueImageRef[]> };

export type QueueStoreOptions = {
  readonly clock?: () => Date;
  /**
   * How long one claim authorises a submission, and the whole of the time before another dispatcher
   * may reclaim it. There is deliberately no second liveness knob: this build cannot observe another
   * process's liveness, so a heartbeat here would be a number derived from the same clock as the
   * lease rather than an independent signal.
   */
  readonly leaseMs?: number;
};

/** One operation's outcome: the queue as it now reads, the entry it acted on, and what it did. */
export type QueueResult = {
  readonly record: QueueRecord;
  readonly entry: QueueEntry | null;
  /** A named outcome: \`appended\`, \`edited\`, \`reordered\`, \`unchanged\`, \`removed\`, \`cleared\`, \`cancelled\`, \`claimed\`, \`renewed\`, \`reclaimed\`, \`released\`, \`submitted\`, \`settled\` or \`attention\`. */
  readonly outcome: string;
  /** False for a legal no-op, which returns the record at its own revision and writes nothing. */
  readonly changed: boolean;
  /** How many entries left the queue through this operation. */
  readonly removed: number;
};

function iso(at: Date): string {
  const time = at.getTime();
  if (!Number.isFinite(time)) throw new QueueError('The queue clock is not a valid instant', 'INVALID');
  return new Date(time).toISOString();
}
function boundedDuration(value: unknown, label: string, fallback: number, maximum: number): number {
  const exact = value === undefined ? fallback : value;
  if (typeof exact !== 'number' || !Number.isInteger(exact) || exact <= 0 || exact > maximum)
    throw new QueueError(label + ' must be a whole number of milliseconds from 1 to ' + maximum, 'INVALID');
  return exact;
}

export class QueueStore {
  private readonly clock: () => Date;
  private readonly leaseMs: number;
  constructor(private readonly store: ControlStore, private readonly port: QueueDispatchPort, options: QueueStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.leaseMs = boundedDuration(options.leaseMs, 'leaseMs', QUEUE_DEFAULT_LEASE_MS, QUEUE_MAX_LEASE_MS);
  }

  /** Read one session's queue, or the deterministic unwritten record it reads at before its first write. */
  read(projectId: unknown, sessionId: unknown): QueueRecord {
    const project = parseQueueIdentifier(projectId, 'projectId');
    const session = parseQueueIdentifier(sessionId, 'sessionId');
    return this.latest(project, session) ?? initialQueue(project, session);
  }

  /** Whether this exact project/session pair already has a durable queue row. */
  has(projectId: unknown, sessionId: unknown): boolean {
    const project = parseQueueIdentifier(projectId, 'projectId');
    const session = parseQueueIdentifier(sessionId, 'sessionId');
    return this.latest(project, session) !== null;
  }

  /** Append one input at the tail of the queue. Text, images, or both: an entry with neither is refused. */
  async append(input: {
    projectId: unknown; sessionId: unknown; revision: unknown; text?: unknown; images?: unknown;
  }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const current = this.read(projectId, sessionId);
    this.assertRevision(current, input.revision);
    // An absent, null or empty text means "no text": an entry with neither text nor an image is refused below.
    const text = input.text === undefined || input.text === null || input.text === '' ? '' : parseQueueText(input.text);
    const images = input.images === undefined || input.images === null ? Object.freeze([]) as readonly QueueImageRef[] : parseQueueImageRefs(input.images);
    if (text === '' && images.length === 0)
      throw new QueueError('A queued input needs text or an image; this one carries neither, so there would be nothing to submit', 'INVALID');
    if (current.entries.length >= QUEUE_MAX_ENTRIES)
      throw new QueueError(
        'The queue of session ' + sessionId + ' already holds its documented maximum of ' + QUEUE_MAX_ENTRIES +
          ' entries; clear a settled or failed entry before appending another; the record is unchanged',
        'BOUNDED'
      );
    const now = this.clock(), timestamp = iso(now);
    const entry: QueueEntry = Object.freeze({
      id: randomUUID(),
      position: current.entries.length,
      text,
      images,
      state: 'queued' as const,
      claim: null,
      submission: null,
      attention: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const record = await this.write(current, [...current.entries, entry], now);
    return this.result(record, record.entries[record.entries.length - 1], 'appended', 0);
  }

  /** Edit the text of a queued entry. Only a queued entry's text is editable, and a stale revision writes nothing. */
  async edit(input: { projectId: unknown; sessionId: unknown; revision: unknown; entryId: unknown; text: unknown }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const current = this.read(projectId, sessionId);
    this.assertRevision(current, input.revision);
    const { entry } = this.entryOf(current, input.entryId);
    if (entry.state !== 'queued')
      throw new QueueError(
        'Only a queued entry\'s text can be edited: entry ' + entry.id + ' is ' + entry.state +
          (entry.state === 'claimed' ? ' and a dispatcher holds it' : '') + ', so its text is no longer the input a dispatcher would read; the record is unchanged',
        'ILLEGAL'
      );
    const text = parseQueueText(input.text);
    const now = this.clock();
    const edited = Object.freeze({ ...entry, text, updatedAt: iso(now) });
    const record = await this.write(current, current.entries.map((candidate) => (candidate.id === entry.id ? edited : candidate)), now);
    return this.result(record, this.entryById(record, entry.id), 'edited', 0);
  }

  /** Move one entry to another position inside the queue. A position outside the queue is refused. */
  async reorder(input: { projectId: unknown; sessionId: unknown; revision: unknown; entryId: unknown; position: unknown }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const current = this.read(projectId, sessionId);
    this.assertRevision(current, input.revision);
    const { entry, index } = this.entryOf(current, input.entryId);
    const position = parseQueuePosition(input.position);
    if (position >= current.entries.length)
      throw new QueueError(
        'Position ' + position + ' is outside the queue of session ' + sessionId + ': it holds ' + current.entries.length +
          ' entries, so a position is 0 to ' + (current.entries.length - 1) + '; the record is unchanged',
        'INVALID'
      );
    if (position === index) return Object.freeze({ record: current, entry, outcome: 'unchanged' as const, changed: false, removed: 0 });
    const now = this.clock(), timestamp = iso(now);
    const remaining = current.entries.filter((candidate) => candidate.id !== entry.id);
    const moved = Object.freeze({ ...entry, updatedAt: timestamp });
    remaining.splice(position, 0, moved);
    // Every entry whose position changed is stamped, so the record says what really moved.
    const next = remaining.map((candidate, at) => (candidate.position === at ? candidate : Object.freeze({ ...candidate, updatedAt: timestamp })));
    // The effective head is not movable: an entry that is claimed or submitted stays the first
    // pending entry until it settles or is explicitly reconciled, so a reorder can never let later
    // intent dispatch before earlier intent. This is a refusal rather than a schema error, so the
    // caller is told what stands in the way.
    const disorder = queueInFlightViolation(next);
    if (disorder !== null)
      throw new QueueError(
        'Entry ' + entry.id + ' cannot be moved to position ' + position + ': ' + disorder +
          '; settle or explicitly reconcile it, or cancel it once it is out of flight; the record is unchanged',
        'ILLEGAL'
      );
    const record = await this.write(current, next, now);
    return this.result(record, this.entryById(record, entry.id), 'reordered', 0);
  }

  /**
   * Remove one entry that is not in flight. A claimed, submitted or settled entry is refused: removing
   * it could lose a claim or the record of a submission, and those have their own operations.
   */
  async remove(input: { projectId: unknown; sessionId: unknown; revision: unknown; entryId: unknown }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const current = this.read(projectId, sessionId);
    this.assertRevision(current, input.revision);
    const { entry } = this.entryOf(current, input.entryId);
    if (entry.state !== 'queued' && entry.state !== 'cancelled' && entry.state !== 'failed')
      throw new QueueError(
        'Only an entry that is queued, cancelled or failed can be removed: entry ' + entry.id + ' is ' + entry.state + ', so removing it could lose ' +
          (entry.state === 'claimed' ? 'a claim' : entry.state === 'submitted' ? 'a submission awaiting reconciliation' : 'the submission it was reconciled against') +
          '; ' + (entry.state === 'claimed' ? 'release its claim and then cancel it' : entry.state === 'submitted' ? 'reconcile it' : 'clear it') + '; the record is unchanged',
        'ILLEGAL'
      );
    const now = this.clock();
    const record = await this.write(current, current.entries.filter((candidate) => candidate.id !== entry.id), now);
    return this.result(record, null, 'removed', 1);
  }

  /** Clear every settled and failed entry, compacting the order. Nothing to clear is a legal no-op. */
  async clear(input: { projectId: unknown; sessionId: unknown; revision: unknown }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const current = this.read(projectId, sessionId);
    this.assertRevision(current, input.revision);
    const kept = current.entries.filter((entry) => entry.state !== 'settled' && entry.state !== 'failed');
    const removed = current.entries.length - kept.length;
    if (removed === 0) return Object.freeze({ record: current, entry: null, outcome: 'unchanged' as const, changed: false, removed: 0 });
    const record = await this.write(current, kept, this.clock());
    return this.result(record, null, 'cleared', removed);
  }

  /**
   * Cancel one entry so it can never dispatch. A claimed or submitted entry is refused: a submission
   * of it may already be in the durable transcript, and withdrawing the entry here would leave that
   * submission with nothing to reconcile it against — invisible rather than merely unrecorded. The
   * claim is released first (the holder gives it back), and only then is the entry cancellable.
   */
  async cancel(input: { projectId: unknown; sessionId: unknown; revision: unknown; entryId: unknown }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const current = this.read(projectId, sessionId);
    this.assertRevision(current, input.revision);
    const { entry } = this.entryOf(current, input.entryId);
    if (entry.state === 'claimed')
      throw new QueueError(
        'Entry ' + entry.id + ' is claimed by ' + entry.claim!.owner + ', and a submission of it may be in flight under the identity ' +
          queueEntryRequestId(entry) + ', so cancelling it here could withdraw an input the durable transcript already holds; release the claim first ' +
          '(the owner gives the entry back), then cancel it; the record is unchanged',
        'ILLEGAL'
      );
    assertQueueTransition(entry.state, 'cancelled', entry.id);
    const now = this.clock(), timestamp = iso(now);
    const cancelled = Object.freeze({ ...entry, state: 'cancelled' as const, claim: null, submission: null, attention: null, updatedAt: timestamp });
    const record = await this.write(current, current.entries.map((candidate) => (candidate.id === entry.id ? cancelled : candidate)), now);
    return this.result(record, this.entryById(record, entry.id), 'cancelled', 0);
  }

  /**
   * Claim the queue's head entry for one named owner, with a lease. A head this owner already holds is
   * renewed; a head whose lease has expired is reclaimed; anything else is a conflict that changes
   * nothing, because a claim whose lease is live is never stolen. This records the intent and the
   * stable request identity it authorises durably before any submission starts, and performs no
   * submission itself.
   */
  async claim(input: { projectId: unknown; sessionId: unknown; owner: unknown }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const owner = parseQueueOwner(input.owner);
    const current = this.read(projectId, sessionId);
    const now = this.clock();
    const verdict = queueClaimVerdict(current, { owner, now });
    // The verdict comes first, so an impossible claim (an empty pending queue, a live claim that is
    // not stolen) refuses without asking the port anything; the port is then asked whether this
    // instance can dispatch at all, before any revision is claimed.
    if (verdict.kind === 'held' || verdict.kind === 'in-flight') throw new QueueError(verdict.reason, 'CONFLICT');
    await this.port.authorise({ projectId, sessionId });
    const head = queueHead(current)!;
    const timestamp = iso(now);
    const claim = Object.freeze({
      owner,
      claimedAt: verdict.kind === 'renew' ? verdict.entry.claim!.claimedAt : timestamp,
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      // The claim names the submission identity it authorises, so the intent (this same record's
      // entry text and images) and the identity are durable before the submission starts. Validation
      // refuses any other value, so a stored claim can never name a second submission.
      requestId: queueRequestId(head.id)
    });
    const claimed = Object.freeze({ ...head, state: 'claimed' as const, claim, submission: null, attention: null, updatedAt: timestamp });
    const record = await this.write(current, current.entries.map((candidate) => (candidate.id === head.id ? claimed : candidate)), now);
    return this.result(record, this.entryById(record, head.id), verdict.kind === 'renew' ? 'renewed' : verdict.kind === 'reclaim' ? 'reclaimed' : 'claimed', 0);
  }

  /** Give a claimed entry back to the queue. Nothing is dispatched and no submission is touched. */
  async release(input: { projectId: unknown; sessionId: unknown; entryId: unknown; owner: unknown }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const owner = parseQueueOwner(input.owner);
    const current = this.read(projectId, sessionId);
    const { entry } = this.entryOf(current, input.entryId);
    assertQueueTransition(entry.state, 'queued', entry.id);
    if (entry.claim!.owner !== owner)
      throw new QueueError('Entry ' + entry.id + ' is claimed by ' + entry.claim!.owner + ', not by ' + owner + '; only the owner of a claim can release it; the record is unchanged', 'ILLEGAL');
    const now = this.clock();
    const released = Object.freeze({ ...entry, state: 'queued' as const, claim: null, submission: null, attention: null, updatedAt: iso(now) });
    const record = await this.write(current, current.entries.map((candidate) => (candidate.id === entry.id ? released : candidate)), now);
    return this.result(record, this.entryById(record, entry.id), 'released', 0);
  }

  /**
   * Submit a claimed entry through the port under the entry's stable request identity, and record
   * \`submitted\`. The port's own idempotency by request identity is what makes a repeat collapse onto
   * the submission that already exists.
   *
   * A submission the port does not report back is resolved from the durable transcript, never
   * asserted: a port refusal and a crash around the transcript write look identical from here, so the
   * queue records what the transcript can be shown to hold and says by name when it cannot read it.
   * The caller still receives the port's own error.
   */
  async submit(input: { projectId: unknown; sessionId: unknown; entryId: unknown; owner: unknown }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const owner = parseQueueOwner(input.owner);
    const current = this.read(projectId, sessionId);
    const { entry } = this.entryOf(current, input.entryId);
    assertQueueTransition(entry.state, 'submitted', entry.id);
    const claim = entry.claim!;
    if (claim.owner !== owner)
      throw new QueueError('Entry ' + entry.id + ' is claimed by ' + claim.owner + ', not by ' + owner + '; only the owner of a claim may submit it; the record is unchanged', 'ILLEGAL');
    const now = this.clock();
    if (now.getTime() >= Date.parse(claim.leaseExpiresAt))
      throw new QueueError(
        'The claim on entry ' + entry.id + ' expired at ' + claim.leaseExpiresAt + '; the queue never submits on an expired lease; reclaim it first; the record is unchanged',
        'ILLEGAL'
      );
    await this.port.authorise({ projectId, sessionId });
    // The identity comes from the record: the claim the queue wrote before any submission started.
    const requestId = queueEntryRequestId(entry);
    let reported: QueueSubmissionRecord;
    try {
      reported = await this.port.submit({ projectId, sessionId, requestId, entryId: entry.id, text: entry.text, images: entry.images });
    } catch (error) {
      await this.recordSubmissionFailure(current, entry);
      throw error;
    }
    if (!reported || reported.requestId !== requestId || reported.entryId !== entry.id)
      throw new QueueError(
        'The dispatcher reported a submission under a request identity that is not entry ' + entry.id + '\'s own; nothing is recorded as submitted and the entry stays claimed for reconciliation',
        'CORRUPT'
      );
    const submission: QueueSubmission = Object.freeze({ requestId, submissionId: reported.submissionId, acceptedAt: reported.acceptedAt });
    const timestamp = iso(now);
    const submitted = Object.freeze({ ...entry, state: 'submitted' as const, claim, submission, attention: null, updatedAt: timestamp });
    const record = await this.write(current, current.entries.map((candidate) => (candidate.id === entry.id ? submitted : candidate)), now);
    return this.result(record, this.entryById(record, entry.id), 'submitted', 0);
  }

  /**
   * Reconcile one entry against the durable transcript, by the entry's stable request identity:
   *
   * - the transcript holds this entry's submission → the entry is \`settled\` with that submission;
   * - the transcript holds nothing → a named operator-attention state (\`submission-absent\`);
   * - the transcript holds something that is not this entry's submission → \`submission-mismatched\`;
   * - this instance cannot read the transcript back → \`submission-not-readable\`.
   *
   * It reads only. It never re-sends, and it never overwrites what the transcript holds.
   */
  async reconcile(input: { projectId: unknown; sessionId: unknown; entryId: unknown }): Promise<QueueResult> {
    const { projectId, sessionId } = this.scopeOf(input);
    const current = this.read(projectId, sessionId);
    const { entry } = this.entryOf(current, input.entryId);
    const reachable = QUEUE_TRANSITIONS[entry.state].filter((state) => state === 'settled' || state === 'failed');
    if (reachable.length === 0)
      throw new QueueError(
        'Only a claimed, submitted or failed entry can be reconciled: entry ' + entry.id + ' is ' + entry.state + ', so the transcript already agrees with the queue or the entry was never dispatched; the record is unchanged',
        'ILLEGAL'
      );
    const answer = await this.readTranscript(projectId, sessionId, entry);
    const now = this.clock();
    const record = await this.write(current, this.resolve(current, entry, answer, now), now);
    return this.result(record, this.entryById(record, entry.id), answer.settled ? 'settled' : 'attention', 0);
  }

  /**
   * What the durable transcript holds for one entry, decided from the transcript alone and named:
   *
   * - it holds this entry's own submission under the entry's recorded identity → the entry settles on
   *   it, carrying the transcript's own submission id;
   * - it holds nothing under that identity → the entry needs an operator (\`submission-absent\`);
   * - it holds something that is not this entry's own submission → \`submission-mismatched\`;
   * - this instance cannot read it back → \`submission-not-readable\`, which says by name that whether
   *   the entry was submitted cannot be established.
   *
   * It only reads: it never re-sends, never overwrites what the transcript holds, and never asserts
   * that a dispatcher refused. A read that failed is not a read that found nothing, so the two stay
   * distinct and neither is reported as a submission.
   */
  private async readTranscript(projectId: string, sessionId: string, entry: QueueEntry): Promise<{ settled: boolean; submission: QueueSubmission | null; reason: QueueAttentionReason | null }> {
    // The identity is the one the record names — the claim's own, written before any submission — so a
    // reconciliation cannot be pointed at a different submission than the one the entry authorised.
    const requestId = queueEntryRequestId(entry);
    let evidence: QueueSubmissionRecord | null = null, readable = true;
    if (!this.port.lookup) readable = false;
    else {
      try {
        evidence = await this.port.lookup({ projectId, sessionId, requestId });
      } catch {
        readable = false;
      }
    }
    const mismatch = evidence !== null && (
      evidence.requestId !== requestId ||
      evidence.entryId !== entry.id ||
      (entry.submission !== null && entry.submission.submissionId !== evidence.submissionId)
    );
    if (!readable || evidence === null || mismatch)
      return Object.freeze({
        settled: false,
        submission: entry.submission,
        reason: !readable ? 'submission-not-readable' as const : evidence === null ? 'submission-absent' as const : 'submission-mismatched' as const
      });
    return Object.freeze({
      settled: true,
      submission: Object.freeze({ requestId, submissionId: evidence.submissionId, acceptedAt: evidence.acceptedAt }),
      reason: null
    });
  }

  /** The entries one transcript answer produces, from the entry's own record and nothing else. */
  private resolve(current: QueueRecord, entry: QueueEntry, answer: { settled: boolean; submission: QueueSubmission | null; reason: QueueAttentionReason | null }, now: Date): readonly QueueEntry[] {
    const timestamp = iso(now);
    const resolved = answer.settled
      ? Object.freeze({ ...entry, state: 'settled' as const, claim: null, submission: answer.submission, attention: null, updatedAt: timestamp })
      : Object.freeze({
        ...entry,
        state: 'failed' as const,
        claim: null,
        submission: answer.submission,
        attention: Object.freeze({ reason: answer.reason!, detail: QUEUE_ATTENTION_DETAILS[answer.reason!] }),
        updatedAt: timestamp
      });
    return current.entries.map((candidate) => (candidate.id === entry.id ? resolved : candidate));
  }

  /**
   * Resolve a submission the port did not report back, from the durable transcript, and record the
   * answer. Nothing here is asserted about the dispatcher: the transcript settles the entry on a
   * match, and a transcript that holds nothing, holds a different submission or cannot be read makes
   * the entry a named operator-attention state. The dispatcher's own error may name a path, so it is
   * never stored, and a compensation that cannot be written is reported rather than hidden — the
   * caller still receives the submission error, and the entry stays reconcilable.
   */
  private async recordSubmissionFailure(current: QueueRecord, entry: QueueEntry): Promise<void> {
    try {
      const answer = await this.readTranscript(current.projectId, current.sessionId, entry);
      const now = this.clock();
      await this.write(current, this.resolve(current, entry, answer, now), now);
    } catch (error) {
      console.error('The outcome of the failed submission of queue entry ' + entry.id + ' could not be recorded (' + (error as Error).message + '); the caller still receives the submission error and the entry stays reconcilable');
    }
  }

  /** The one write path: a strictly validated next revision, one admission, and the store's own verdict. */
  private async write(current: QueueRecord, entries: readonly QueueEntry[], now: Date): Promise<QueueRecord> {
    const next = nextQueueRevision(current, { entries, now });
    // The yield is deliberate: it makes the window between this operation's read and the store's own
    // transaction real, so the revision really is decided by the unique index and not by the fact
    // that one JavaScript task happened to run to completion first.
    await Promise.resolve();
    let admitted: { operation: OperationRecord; outbox: OutboxRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: { projectId: next.projectId, sessionId: next.sessionId },
        // One key per revision inside this session's own scope: the store's unique index is what makes
        // two writers at the same revision a conflict rather than two records.
        idempotencyKey: 'queue.r' + next.revision,
        kind: OPERATION_KIND,
        input: next,
        outbox: { kind: OUTBOX_KIND, payload: { version: 1, projectId: next.projectId, sessionId: next.sessionId, revision: next.revision } }
      });
    } catch (error) {
      if (error instanceof QueueError) throw error;
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new QueueError('The queue of session ' + next.sessionId + ' revision ' + next.revision + ' was already written by another writer (' + error.message + '); the record is unchanged', 'CONFLICT');
      throw new QueueError('The durable store refused the queue write: ' + (error as Error).message, 'STORAGE');
    }
    if (admitted.existing)
      throw new QueueError('The queue of session ' + next.sessionId + ' revision ' + next.revision + ' was already written; the record is unchanged', 'CONFLICT');
    return next;
  }

  private result(record: QueueRecord, entry: QueueEntry | null, outcome: string, removed: number): QueueResult {
    return Object.freeze({ record, entry, outcome, changed: true, removed });
  }
  private scopeOf(input: { projectId: unknown; sessionId: unknown }): { projectId: string; sessionId: string } {
    return { projectId: parseQueueIdentifier(input.projectId, 'projectId'), sessionId: parseQueueIdentifier(input.sessionId, 'sessionId') };
  }
  /** The revision the caller read must be the stored one: a stale one is a conflict that writes nothing. */
  private assertRevision(current: QueueRecord, revision: unknown): void {
    const exact = parseQueueRevision(revision);
    if (current.revision !== exact)
      throw new QueueError(
        'The queue of session ' + current.sessionId + ' is at revision ' + current.revision + ', not ' + exact + '; read it again before writing; the record is unchanged',
        'CONFLICT'
      );
  }
  private entryOf(record: QueueRecord, entryId: unknown): { entry: QueueEntry; index: number } {
    const id = parseQueueEntryId(entryId);
    const index = record.entries.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new QueueError('The queue of session ' + record.sessionId + ' holds no entry ' + id + '; the record is unchanged', 'NOT_FOUND');
    return { entry: record.entries[index], index };
  }
  private entryById(record: QueueRecord, entryId: string): QueueEntry {
    return record.entries.find((candidate) => candidate.id === entryId)!;
  }

  /** The latest stored revision of one queue, or null when the session has no durable queue row yet. */
  private latest(projectId: string, sessionId: string): QueueRecord | null {
    const rows = this.rows('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid', [projectId, sessionId, OPERATION_KIND]);
    let latest: QueueRecord | null = null;
    for (const row of rows) {
      const record = this.decode(String(row.id), { projectId, sessionId });
      if (latest === null || record.revision > latest.revision) latest = record;
      else if (record.revision === latest.revision) throw new QueueError('Corrupt queue storage: two records of session ' + sessionId + ' share revision ' + record.revision, 'CORRUPT');
    }
    return latest;
  }

  private decode(operationId: string, scope: ControlScope): QueueRecord {
    let operation: OperationRecord;
    try {
      operation = this.store.getOperation(operationId, scope);
    } catch (error) {
      throw new QueueError('The durable store could not read queue operation ' + operationId + ': ' + (error as Error).message, 'STORAGE');
    }
    if (operation.kind !== OPERATION_KIND) throw new QueueError('Queue storage holds an unexpected operation kind', 'CORRUPT');
    let record: QueueRecord;
    try {
      record = validateQueueRecord(operation.input, 'CORRUPT');
    } catch (error) {
      throw new QueueError('A stored queue record is corrupt: ' + (error as Error).message, 'CORRUPT');
    }
    if (record.projectId !== scope.projectId || record.sessionId !== scope.sessionId) throw new QueueError('A stored queue record is outside its own scope', 'CORRUPT');
    const outbox = this.outboxFor(operation.id, scope);
    if (outbox.kind !== OUTBOX_KIND) throw new QueueError('Queue storage holds an unexpected outbox kind', 'CORRUPT');
    if (outbox.state !== 'pending') throw new QueueError('A queue outbox must stay pending for the life of the record', 'CORRUPT');
    const payload = outbox.payload as { version?: unknown; projectId?: unknown; sessionId?: unknown; revision?: unknown } | null;
    if (!payload || typeof payload !== 'object' || payload.version !== 1 || payload.projectId !== record.projectId || payload.sessionId !== record.sessionId || payload.revision !== record.revision)
      throw new QueueError('The stored queue outbox payload does not describe its record', 'CORRUPT');
    return record;
  }
  private outboxFor(operationId: string, scope: ControlScope): OutboxRecord {
    const rows = this.rows('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2', [operationId]);
    if (rows.length !== 1) throw new QueueError('Queue storage holds no unambiguous outbox row for one of its operations', 'CORRUPT');
    try {
      return this.store.getOutbox(String(rows[0].id), scope);
    } catch (error) {
      throw new QueueError('The durable store could not read a queue outbox: ' + (error as Error).message, 'STORAGE');
    }
  }
  /** Read-only SELECTs over the reviewed control schema; every record is read back through the store's own getters. */
  private rows(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try {
      return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    } catch (error) {
      throw new QueueError('The durable control store could not be read: ' + (error as Error).message, 'STORAGE');
    }
  }
}

