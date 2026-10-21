import { z } from 'zod';
import { canonicalJson } from './control-state';
import {
  ACCEPTED_IMAGE_TYPES, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MEDIA_ID_PATTERN,
  type AcceptedImageType
} from './images';

/**
 * The durable queue of pending inputs for one named session.
 *
 * A named session (see \`sessions.ts\`) is *what a conversation is about*; the lifecycle
 * (\`session-lifecycle.ts\`) is whether a generation is running. This module is the third piece: the
 * ordered list of inputs the owner has decided to send but that have not been settled yet, held
 * durably so a closed browser, a vanished dispatcher or a fresh client reads the same list.
 *
 * **The queue records intent, and nothing else.** What was *actually* submitted is the durable
 * transcript's business, and only the transcript's. Nothing in this module treats a queued entry, a
 * claim or even its own \`submitted\` state as proof that a model ever received the input: an entry
 * becomes \`settled\` only when reconciliation matches it against the submission the transcript holds
 * for the entry's own stable request identity. A state this queue cannot prove from the transcript
 * is reported as a named operator-attention state, never silently re-sent.
 *
 * The states are a closed set and mean exactly this:
 *
 * - \`queued\`: waiting, and never dispatched.
 * - \`claimed\`: a named dispatcher holds a lease on it — the owner identity, an expiry and the
 *   stable request identity this claim authorises — and is the only party allowed to submit it. A
 *   claim is never stolen while its lease is live. The claim also carries the intent it belongs to:
 *   the entry's own text and images are in the same durable record, so the intent and the identity
 *   that names its submission are both durable before the submission starts.
 * - \`submitted\`: the input was handed to the dispatcher's port under the entry's stable request
 *   identity, and the queue has not yet reconciled that against the transcript.
 * - \`settled\`: reconciliation found the transcript's own submission for that request identity. A
 *   settled entry is never dispatched again.
 * - \`failed\`: a terminal state that needs an operator: the durable transcript could not be matched
 *   against the entry's own request identity, so what really happened cannot be established. The
 *   queue never records that a dispatcher refused a submission — a refusal and a crash around the
 *   write look identical from here — and a failed entry is never re-sent automatically and never
 *   dispatched again.
 * - \`cancelled\`: withdrawn by the owner. It never dispatches. A claimed entry is never cancelled
 *   directly: a submission of it may already be in the transcript, so its claim is released first.
 *
 * **The revision rule.** The queue carries one revision that increments on every mutation. A caller
 * sends back the revision it read; a stale one is refused as a conflict with the record unchanged,
 * so a client cannot overwrite a change it never saw. The revision is also the compare-and-swap the
 * durable store enforces: two writers that read the same revision write at the same idempotency key,
 * and the store's unique index picks exactly one winner (see \`src/server/state/queue-store.ts\`).
 *
 * **The stable request identity.** \`queueRequestId(entryId)\` derives the submission identity from
 * the entry id alone — never from a revision, a timestamp or a random value — so every attempt to
 * submit one entry names the *same* submission. The claim records that identity durably, in the same
 * record as the entry's own text and images, and validation refuses a claim that named any other
 * identity. A crash before the submission starts, in the middle of it, or after the transcript wrote
 * it therefore all resolve to the same submission rather than to a second one.
 *
 * **The effective head.** An entry that is claimed or submitted is the queue's effective head until
 * it settles or is explicitly reconciled: at most one entry can hold that position, and the strict
 * record validation refuses an order in which a later pending entry sits ahead of it. That, and not a
 * caller's politeness, is what stops a reorder from letting later intent dispatch before earlier
 * intent.
 *
 * **The lease is the whole of the liveness evidence.** A claim carries one expiry and nothing else.
 * This build cannot observe another process's liveness, so it does not pretend to: a claim whose
 * lease has expired is reclaimable, and a claim whose lease is live is not. That is safe because a
 * reclaim can only ever submit under the same stable request identity, so a slow original owner and
 * the dispatcher that took the entry over produce one submission, never two.
 *
 * This module is pure: no Node built-ins and no framework. It defines the record, the closed state
 * set, the legal transitions, the strict fail-closed validation everything goes through, and the
 * bounds. The durable half is \`src/server/state/queue-store.ts\`; the operator-facing description is
 * \`docs/QUEUE.md\`.
 */

export const QUEUE_VERSION = 1 as const;
/** The documented maximum number of entries one queue may hold. */
export const QUEUE_MAX_ENTRIES = 50;
/** The documented maximum length of one entry's text, in characters. */
export const QUEUE_MAX_TEXT_LENGTH = 2000;
/** The documented maximum number of image references one entry may carry (the message bound). */
export const QUEUE_MAX_IMAGES_PER_ENTRY = MAX_IMAGES_PER_MESSAGE;
/** The documented maximum size of one stored queue record, in bytes (the control store's own cap). */
export const QUEUE_MAX_RECORD_BYTES = 64 * 1024;
/** The identifier rule, shared with the named-session and lifecycle identifier rules. */
export const QUEUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/** The revision a session whose queue has never been written reads at. */
export const QUEUE_UNRECORDED_REVISION = 0;
/** The deterministic instant of the unwritten initial record, so a read is reproducible. */
export const QUEUE_EPOCH = '1970-01-01T00:00:00.000Z';
/** The prefix of the stable submission identity derived from an entry id. */
export const QUEUE_REQUEST_ID_PREFIX = 'queue:';
/**
 * How long one claim lasts by default, and the whole of the time it authorises a submission. A
 * dispatcher renews it by claiming the head again. This is also the whole of this build's liveness
 * evidence: an expired lease makes a claim reclaimable and a live one does not, and nothing here
 * claims to observe whether the owner is still running.
 */
export const QUEUE_DEFAULT_LEASE_MS = 60_000;
/** The longest lease this build accepts, so one claim cannot hold an entry longer than this. */
export const QUEUE_MAX_LEASE_MS = 60 * 60 * 1000;

/** The closed state set. An unknown state fails closed rather than being interpreted. */
export const QUEUE_STATES = ['queued', 'claimed', 'submitted', 'settled', 'failed', 'cancelled'] as const;
export type QueueEntryState = (typeof QUEUE_STATES)[number];

/**
 * The closed set of reasons a failed entry carries. Each is an operator-attention state, and each
 * says exactly as much as the durable transcript allows and no more:
 *
 * - the queue never records that a dispatcher *refused* a submission. A refusal and a submission
 *   interrupted around the transcript write look identical from the queue's side, so asserting a
 *   refusal would be asserting something this code cannot know;
 * - where the transcript can be read back, the reason is the transcript's own answer: nothing under
 *   the identity, or something that is not this entry's submission;
 * - where it cannot be read back, the reason says so by name rather than guessing.
 */
export const QUEUE_ATTENTION_REASONS = [
  'submission-absent',
  'submission-mismatched',
  'submission-not-readable'
] as const;
export type QueueAttentionReason = (typeof QUEUE_ATTENTION_REASONS)[number];

/** The fixed, path-free sentences that go with those reasons. */
export const QUEUE_ATTENTION_DETAILS: Readonly<Record<QueueAttentionReason, string>> = Object.freeze({
  'submission-absent': 'The durable transcript was read back by this entry\'s stable request identity and holds no submission under it, so nothing reached the transcript under that identity. An operator decides what happens next; the queue never re-sends by itself.',
  'submission-mismatched': 'The durable transcript holds a submission under this entry\'s stable request identity that is not this entry\'s own submission. An operator must inspect the transcript; the queue never re-sends and never overwrites what the transcript holds.',
  'submission-not-readable': 'This instance cannot read the durable transcript back by request identity, so whether this entry was submitted cannot be established — a dispatcher that refused the submission and one that was interrupted around the write look identical from here. An operator must inspect the transcript; the queue never re-sends by itself.'
});

/**
 * Which state changes are legal. Every operation performs exactly one of these, and anything else
 * fails closed. The table is the whole authority on transitions: no operation may invent one.
 *
 * - \`claimed\` to \`claimed\` is the same owner renewing its lease or a new owner reclaiming a claim
 *   whose lease has expired.
 * - \`claimed\` to \`settled\` is the crash case: the submission reached the transcript but the queue
 *   never recorded \`submitted\`.
 * - \`claimed\` to \`cancelled\` is deliberately **not** in the table. A claimed entry may have a
 *   submission in flight, so cancelling it could withdraw an input the transcript already holds and
 *   leave that submission with nothing to reconcile it against: the claim is released first, which
 *   is why \`claimed\` to \`queued\` is.
 * - \`failed\` to \`settled\` is a later reconciliation that finally matched, and \`failed\` to \`failed\`
 *   is a reconciliation that refreshed the attention reason.
 * - Nothing leaves \`settled\`: a settled entry is removed by \`clear\`, never re-dispatched.
 */
export const QUEUE_TRANSITIONS: Readonly<Record<QueueEntryState, readonly QueueEntryState[]>> = Object.freeze({
  queued: Object.freeze(['claimed', 'cancelled'] as const),
  claimed: Object.freeze(['claimed', 'submitted', 'queued', 'settled', 'failed'] as const),
  submitted: Object.freeze(['settled', 'failed'] as const),
  settled: Object.freeze([] as const),
  failed: Object.freeze(['settled', 'failed', 'cancelled'] as const),
  cancelled: Object.freeze([] as const)
});

/** Failed-closed reasons. Each refusal carries one of these codes and a precise, path-free message. */
export type QueueErrorCode = 'INVALID' | 'NOT_FOUND' | 'ILLEGAL' | 'CONFLICT' | 'BOUNDED' | 'CORRUPT' | 'STORAGE';
export class QueueError extends Error {
  constructor(message: string, public readonly code: QueueErrorCode) {
    super(message);
    this.name = 'QueueError';
  }
}

/** One image reference: the stored facts of an accepted image, and never a path. */
export type QueueImageRef = {
  readonly id: string;
  readonly mimeType: AcceptedImageType;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
};
/**
 * One claim: who holds the entry, until when, and which submission it authorises.
 *
 * The claim is the durable record of the *intent to submit*: the entry's own text and images are
 * stored in this same record, and \`requestId\` names the stable identity the submission will be made
 * under. Validation refuses a claim whose \`requestId\` is not exactly \`queueRequestId(entry.id)\`, so
 * a stored claim can never name a second submission. That is what makes a crash in the window before
 * the transcript write reconcile to the same submission instead of to a new one — or to a named
 * operator-attention state when the queue cannot establish what happened.
 *
 * There is exactly one expiry and no other liveness field: this build cannot observe whether another
 * process is running, so it does not claim to. A claim whose lease has expired is reclaimable; a
 * claim whose lease is live is never stolen.
 */
export type QueueClaim = {
  readonly owner: string;
  readonly claimedAt: string;
  /** The instant the claim stops authorising a submission, and the instant it becomes reclaimable. */
  readonly leaseExpiresAt: string;
  /** The stable submission identity this claim authorises: always \`queueRequestId\` of the entry. */
  readonly requestId: string;
};
/** The submission the transcript holds for one entry's stable request identity, as a port reported it. */
export type QueueSubmission = {
  readonly requestId: string;
  readonly submissionId: string;
  readonly acceptedAt: string;
};
/** A named operator-attention state: why the queue could not establish the transcript's answer. */
export type QueueAttention = { readonly reason: QueueAttentionReason; readonly detail: string };
/** One queued input. The id is stable, the position is its place in the order, and both timestamps are durable. */
export type QueueEntry = {
  readonly id: string;
  readonly position: number;
  readonly text: string;
  readonly images: readonly QueueImageRef[];
  readonly state: QueueEntryState;
  readonly claim: QueueClaim | null;
  readonly submission: QueueSubmission | null;
  readonly attention: QueueAttention | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};
/** The whole queue of one named session, at one revision. */
export type QueueRecord = {
  readonly version: 1;
  readonly projectId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly entries: readonly QueueEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
};
/** What the owner reads: the record, its revision, and the bounds this build enforces. */
export type QueueView = {
  readonly readOnly: true;
  readonly projectId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly entries: readonly QueueEntry[];
  readonly limits: {
    readonly entries: number;
    readonly text: number;
    readonly imagesPerEntry: number;
    readonly bytes: number;
  };
};

const textPattern = /^[^\u0000-\u001f\u007f]+$/;
const imageTypes = z.enum(ACCEPTED_IMAGE_TYPES as unknown as [AcceptedImageType, ...AcceptedImageType[]]);

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const path = issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
  return path + issue.message;
}
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string, code: QueueErrorCode = 'INVALID'): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new QueueError(label + ' is invalid: ' + firstIssue(error), code);
    throw error;
  }
}
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

/** The stable submission identity of one entry: derived from the entry id and from nothing else. */
export function queueRequestId(entryId: string): string {
  return QUEUE_REQUEST_ID_PREFIX + parseQueueEntryId(entryId);
}
/**
 * The submission identity one entry's own record names: the identity its claim recorded, or — for an
 * entry that holds no claim — the one derived from its entry id. Validation refuses a stored claim
 * whose recorded identity is not \`queueRequestId(entry.id)\`, so both answers are always the same
 * identity, and reconciliation reads it from the record rather than trusting a caller's guess.
 */
export function queueEntryRequestId(entry: QueueEntry): string {
  return entry.claim === null ? queueRequestId(entry.id) : entry.claim.requestId;
}
export function parseQueueIdentifier(value: unknown, label: string): string {
  return parseStrict(z.string().regex(QUEUE_ID_PATTERN, label + ' must be 1-160 characters from A-Za-z0-9._:-'), value, label);
}
/** The entry id: an identifier, and the only input the stable request identity is derived from. */
export function parseQueueEntryId(value: unknown, label = 'entryId'): string {
  return parseQueueIdentifier(value, label);
}
/** The dispatcher's identity: a named owner, recorded in the claim and in no other place. */
export function parseQueueOwner(value: unknown, label = 'owner'): string {
  return parseQueueIdentifier(value, label);
}
/** One entry's text. Refuses empty text, control characters and anything over the documented bound. */
export function parseQueueText(value: unknown, label = 'text'): string {
  return parseStrict(
    z.string().min(1).max(QUEUE_MAX_TEXT_LENGTH).regex(textPattern, 'text must be printable characters'),
    value,
    label + ' must be 1-' + QUEUE_MAX_TEXT_LENGTH + ' characters of printable text'
  );
}
/** The revision a caller read. The queue's own revision is the only compare-and-swap an edit sends. */
export function parseQueueRevision(value: unknown, label = 'revision'): number {
  return parseStrict(z.number().int().nonnegative(), value, label + ' must be a whole number of zero or more');
}
/** One image reference, validated as the stored facts of an accepted image. */
export function parseQueueImageRefs(value: unknown, label = 'images'): readonly QueueImageRef[] {
  return Object.freeze(parseStrict(z.array(imageRefSchema).max(QUEUE_MAX_IMAGES_PER_ENTRY), value, label, 'INVALID').map((image) => Object.freeze(image)));
}
/** A position is a whole number inside the queue; whether it is *in* the queue is checked against it. */
export function parseQueuePosition(value: unknown, label = 'position'): number {
  return parseStrict(z.number().int().nonnegative(), value, label + ' must be a whole number of zero or more');
}
export function parseQueueState(value: unknown, label = 'state'): QueueEntryState {
  return parseStrict(z.enum(QUEUE_STATES), value, label + ' must be one of ' + QUEUE_STATES.join(', '));
}

/** Whether one state change is in the closed transition table. */
export function isLegalQueueTransition(from: QueueEntryState, to: QueueEntryState): boolean {
  return QUEUE_TRANSITIONS[from].includes(to);
}
/**
 * Refuse a state change the table does not hold, with the reason the caller needs: an unknown state
 * is never interpreted, and a jump nobody implements is never performed.
 */
export function assertQueueTransition(from: QueueEntryState, to: QueueEntryState, entryId: string): void {
  if (isLegalQueueTransition(from, to)) return;
  const allowed = QUEUE_TRANSITIONS[from];
  throw new QueueError(
    'Entry ' + entryId + ' is ' + from + ' and cannot become ' + to +
      (allowed.length === 0 ? '; ' + from + ' is terminal, so it is removed by clear rather than changed' : '; a ' + from + ' entry can only become ' + allowed.join(', ')),
    'ILLEGAL'
  );
}

const claimSchema = z.strictObject({
  owner: z.string().regex(QUEUE_ID_PATTERN, 'a claim owner must be 1-160 characters from A-Za-z0-9._:-'),
  claimedAt: z.string().datetime(),
  leaseExpiresAt: z.string().datetime(),
  requestId: z.string().min(QUEUE_REQUEST_ID_PREFIX.length + 1).max(200)
});
const submissionSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  submissionId: z.string().min(1).max(200),
  acceptedAt: z.string().datetime()
});
const attentionSchema = z.strictObject({
  reason: z.enum(QUEUE_ATTENTION_REASONS),
  detail: z.string().min(1).max(600).regex(textPattern, 'a detail must be printable text')
});
const imageRefSchema = z.strictObject({
  id: z.string().regex(MEDIA_ID_PATTERN, 'an image reference is the hex media id of the stored bytes'),
  mimeType: imageTypes,
  bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  width: z.number().int().positive().max(MAX_IMAGE_DIMENSION),
  height: z.number().int().positive().max(MAX_IMAGE_DIMENSION)
});
const entrySchema = z.strictObject({
  id: z.string().regex(QUEUE_ID_PATTERN, 'an entry id must be 1-160 characters from A-Za-z0-9._:-'),
  position: z.number().int().nonnegative(),
  text: z.string().max(QUEUE_MAX_TEXT_LENGTH).regex(/^[^\u0000-\u001f\u007f]*$/, 'text must be printable characters'),
  images: z.array(imageRefSchema).max(QUEUE_MAX_IMAGES_PER_ENTRY),
  state: z.enum(QUEUE_STATES),
  claim: claimSchema.nullable(),
  submission: submissionSchema.nullable(),
  attention: attentionSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
const recordSchema = z.strictObject({
  version: z.literal(QUEUE_VERSION),
  projectId: z.string().regex(QUEUE_ID_PATTERN, 'a project id must be 1-160 characters from A-Za-z0-9._:-'),
  sessionId: z.string().regex(QUEUE_ID_PATTERN, 'a session id must be 1-160 characters from A-Za-z0-9._:-'),
  revision: z.number().int().nonnegative(),
  entries: z.array(entrySchema).max(QUEUE_MAX_ENTRIES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

/** What a state requires of the three optional fields, so no combination can mean two things. */
const STATE_FIELDS: Readonly<Record<QueueEntryState, { claim: boolean; submission: 'none' | 'any' | 'required'; attention: boolean }>> = Object.freeze({
  queued: { claim: false, submission: 'none', attention: false },
  claimed: { claim: true, submission: 'none', attention: false },
  submitted: { claim: true, submission: 'required', attention: false },
  settled: { claim: false, submission: 'required', attention: false },
  failed: { claim: false, submission: 'any', attention: true },
  cancelled: { claim: false, submission: 'none', attention: false }
});

/**
 * The strict validation every record goes through, on the way in and on the way out of storage.
 * Everything here fails closed with a precise reason:
 *
 * - an entry with neither text nor images is not an input, and is refused;
 * - positions must be exactly 0..n-1 in order, so a position outside the queue cannot exist;
 * - two entries cannot share an id;
 * - every claim names the stable submission identity of its own entry, so a stored claim can never
 *   name a second submission;
 * - the claim, submission and attention fields must match the entry's own state;
 * - at most one entry is claimed or submitted, and it is the first pending entry in the order, so the
 *   effective head can never be skipped over;
 * - the record must fit the documented bounds, in entries and in bytes.
 */
export function validateQueueRecord(value: unknown, code: QueueErrorCode = 'INVALID'): QueueRecord {
  const record = parseStrict(recordSchema, value, 'The queue record', code);
  const seen = new Set<string>();
  record.entries.forEach((entry, index) => {
    if (entry.position !== index)
      throw new QueueError(
        'The queue record is invalid: entry ' + entry.id + ' is at position ' + entry.position + ' but the queue holds it at ' + index + '; positions are the queue\'s own order and cannot be outside it',
        code
      );
    if (seen.has(entry.id)) throw new QueueError('The queue record is invalid: two entries share the id ' + entry.id, code);
    seen.add(entry.id);
    if (entry.text === '' && entry.images.length === 0)
      throw new QueueError('The queue record is invalid: entry ' + entry.id + ' carries neither text nor an image, so there is nothing to submit', code);
    const fields = STATE_FIELDS[entry.state];
    if (fields.claim !== (entry.claim !== null))
      throw new QueueError(
        'The queue record is invalid: a ' + entry.state + ' entry ' + (fields.claim ? 'must carry its claim' : 'must not carry a claim'),
        code
      );
    if (fields.submission === 'none' && entry.submission !== null)
      throw new QueueError('The queue record is invalid: a ' + entry.state + ' entry cannot carry a submission', code);
    if (fields.submission === 'required' && entry.submission === null)
      throw new QueueError('The queue record is invalid: a ' + entry.state + ' entry must carry the submission it was reconciled against', code);
    if (fields.attention !== (entry.attention !== null))
      throw new QueueError(
        'The queue record is invalid: a ' + entry.state + ' entry ' + (fields.attention ? 'must carry the named reason it needs attention' : 'must not carry an operator-attention reason'),
        code
      );
    if (entry.claim !== null && entry.claim.requestId !== queueRequestId(entry.id))
      throw new QueueError(
        'The queue record is invalid: the claim on entry ' + entry.id + ' names the submission ' + entry.claim.requestId +
          ', but that entry\'s own stable identity is ' + queueRequestId(entry.id) + '; a claim that named another submission could submit the input twice',
        code
      );
  });
  const disorder = queueInFlightViolation(record.entries);
  if (disorder !== null) throw new QueueError('The queue record is invalid: ' + disorder, code);
  let encoded: string;
  try {
    encoded = canonicalJson(record);
  } catch (error) {
    throw new QueueError('The queue record is invalid: it is not bounded JSON data (' + (error as Error).message + ')', code);
  }
  // The byte bound is the control store's own payload cap: a queue that outgrew it could not be
  // stored at all, so it is refused here with its own reason rather than by the store.
  if (new TextEncoder().encode(encoded).byteLength > QUEUE_MAX_RECORD_BYTES)
    throw new QueueError('The queue record is invalid: it exceeds the documented ' + QUEUE_MAX_RECORD_BYTES + ' byte bound', 'BOUNDED');
  return deepFreeze(record);
}

/**
 * The deterministic record a session reads at before its queue has ever been written: revision 0 and
 * no entries. It is a real revision to claim, not an absence of a queue.
 */
export function initialQueue(projectId: string, sessionId: string): QueueRecord {
  return Object.freeze({
    version: QUEUE_VERSION,
    projectId: parseQueueIdentifier(projectId, 'projectId'),
    sessionId: parseQueueIdentifier(sessionId, 'sessionId'),
    revision: QUEUE_UNRECORDED_REVISION,
    entries: Object.freeze([]) as readonly QueueEntry[],
    createdAt: QUEUE_EPOCH,
    updatedAt: QUEUE_EPOCH
  });
}

/** The owner-visible read of one queue: the record, its revision and the bounds this build enforces. */
export function queueView(record: QueueRecord): QueueView {
  const exact = validateQueueRecord(record, 'CORRUPT');
  return Object.freeze({
    readOnly: true as const,
    projectId: exact.projectId,
    sessionId: exact.sessionId,
    revision: exact.revision,
    entries: exact.entries,
    limits: Object.freeze({
      entries: QUEUE_MAX_ENTRIES,
      text: QUEUE_MAX_TEXT_LENGTH,
      imagesPerEntry: QUEUE_MAX_IMAGES_PER_ENTRY,
      bytes: QUEUE_MAX_RECORD_BYTES
    })
  });
}

/**
 * Whether an order breaks the effective-head invariant, as one pure check used by the record
 * validation and by every operation that can move an entry:
 *
 * - at most one entry may be claimed or submitted at a time;
 * - that entry must be the first pending entry — the first entry that is queued, claimed or submitted
 *   — so no later intent can ever be dispatched before it.
 *
 * Returns the precise reason the order is refused, or null when it is sound.
 */
export function queueInFlightViolation(entries: readonly QueueEntry[]): string | null {
  const inFlight = entries.filter((entry) => entry.state === 'claimed' || entry.state === 'submitted');
  if (inFlight.length > 1)
    return 'entries ' + inFlight.map((entry) => entry.id).join(' and ') + ' are each claimed or submitted, so the queue would have more than one dispatcher in flight at once';
  if (inFlight.length === 0) return null;
  const firstPending = entries.find((entry) => entry.state === 'queued' || entry.state === 'claimed' || entry.state === 'submitted');
  if (firstPending === undefined || firstPending.id === inFlight[0].id) return null;
  return 'entry ' + firstPending.id + ' is pending ahead of entry ' + inFlight[0].id + ', which is ' + inFlight[0].state +
    ': an entry that is claimed or submitted is the queue\'s effective head until it settles or is explicitly reconciled, so later input cannot be moved ahead of it';
}

/**
 * The queue's head: the entry with the smallest position among those that are still pending — waiting,
 * claimed or submitted. Entries that are settled, failed or cancelled are not part of the pending
 * order, which is exactly why they can never be dispatched.
 *
 * The strict record validation refuses any order in which a pending entry sits ahead of one that is
 * claimed or submitted, so when a dispatcher holds the head this returns that entry and nothing else.
 */
export function queueHead(record: QueueRecord): QueueEntry | null {
  for (const entry of record.entries) {
    if (entry.state === 'queued' || entry.state === 'claimed' || entry.state === 'submitted') return entry;
  }
  return null;
}

/** What a claim on one entry would be, decided purely and named: the caller only records the answer. */
export type QueueClaimVerdict =
  | { readonly kind: 'free' }
  | { readonly kind: 'renew'; readonly entry: QueueEntry }
  | { readonly kind: 'reclaim'; readonly entry: QueueEntry }
  | { readonly kind: 'held'; readonly reason: string }
  | { readonly kind: 'in-flight'; readonly reason: string };

/**
 * Whether one owner may claim (or renew, or reclaim) the queue's head, from the record alone:
 *
 * - a free head is claimed;
 * - a head the caller already holds is renewed;
 * - a head whose lease has expired is reclaimed. The lease is the whole of this build's liveness
 *   evidence, and the reclaim claims nothing more than that: this build cannot observe whether the
 *   previous owner is gone, so it neither asserts that it is nor refuses to act forever;
 * - anything else is held: a claim whose lease is live is never stolen, and a head awaiting
 *   reconciliation is not skipped over, because skipping would dispatch later intent before earlier
 *   intent.
 */
export function queueClaimVerdict(record: QueueRecord, input: { owner: string; now: Date }): QueueClaimVerdict {
  const owner = parseQueueOwner(input.owner);
  const at = input.now.getTime();
  if (!Number.isFinite(at)) throw new QueueError('The queue clock is not a valid instant', 'INVALID');
  const head = queueHead(record);
  if (head === null)
    throw new QueueError('The queue holds no pending input to claim: every entry is settled, failed or cancelled', 'ILLEGAL');
  if (head.state === 'submitted')
    return Object.freeze({ kind: 'in-flight' as const, reason: 'The head entry ' + head.id + ' was submitted and awaits reconciliation; reconcile it before claiming the next input' });
  if (head.state === 'queued') return Object.freeze({ kind: 'free' as const });
  const claim = head.claim!;
  if (claim.owner === owner) return Object.freeze({ kind: 'renew' as const, entry: head });
  // One expiry, one rule, no branch that can never be taken: past the lease the claim is reclaimable,
  // and before it the claim stands.
  if (at >= Date.parse(claim.leaseExpiresAt)) return Object.freeze({ kind: 'reclaim' as const, entry: head });
  return Object.freeze({
    kind: 'held' as const,
    reason:
      'The head entry ' + head.id + ' is claimed by ' + claim.owner + ' until ' + claim.leaseExpiresAt +
      ', and that lease is still live, so a live claim is never stolen: this build cannot observe whether that ' +
      'owner is still running, and a live lease is the only liveness evidence there is'
  });
}

/**
 * The next revision of a record, from the current one and one change, with everything re-validated.
 * It is the only constructor of a new revision: nothing else may raise a revision.
 */
export function nextQueueRevision(
  current: QueueRecord,
  change: { entries: readonly QueueEntry[]; now: Date }
): QueueRecord {
  const at = change.now.getTime();
  if (!Number.isFinite(at)) throw new QueueError('The queue clock is not a valid instant', 'INVALID');
  const timestamp = new Date(at).toISOString();
  const entries = change.entries.map((entry, index) => Object.freeze({ ...entry, position: index }));
  return validateQueueRecord({
    version: QUEUE_VERSION,
    projectId: current.projectId,
    sessionId: current.sessionId,
    revision: current.revision + 1,
    entries,
    createdAt: current.createdAt === QUEUE_EPOCH ? timestamp : current.createdAt,
    updatedAt: timestamp
  });
}
