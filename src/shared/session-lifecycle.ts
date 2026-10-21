import { z } from 'zod';
import { boundedJson } from './control-state';

/**
 * The durable session lifecycle: an explicit execution state for a named session.
 *
 * A named session (see `sessions.ts`) is a durable record of *what a conversation is about*. This
 * module adds the other half a client needs: a durable, revision-checked execution state, so a
 * closed browser, a vanished process or a fresh client all read the *same* truth from storage
 * instead of guessing from the running process.
 *
 * This module is pure — no Node built-ins and no framework. It defines the closed state set, the
 * record, the five owner actions, the strict fail-closed validation all of it goes through, and the
 * transition function that is the single authority on what each action does. The durable half lives
 * in `src/server/state/session-lifecycle.ts`; the operator-facing description is
 * `docs/RECOVERY.md`.
 *
 * The states are a closed set and mean exactly this:
 *
 * - `idle`: no generation is running and nothing is pending. Where a session begins and where a
 *   completed or deliberately stopped run ends.
 * - `running`: a generation with a request identity is in flight. Only `resume` and `retry`
 *   enter this state in this round; the record is what a fresh client reads instead of a stuck
 *   browser.
 * - `paused`: the owner stopped the current generation but kept it resumable, so it can still be
 *   continued under its original request identity.
 * - `interrupted`: the owning process went away while the session was running. Whether the
 *   generation's effect can be proven idempotent is recorded in `uncertain`, and an uncertain
 *   interruption is never replayed.
 * - `failed`: the generation ended in a terminal failure. It is re-run only by an explicit
 *   `retry`, as a brand-new attempt under an identity derived from the revision it is written at.
 *
 * A non-idle state carries a `reason`. The reason is required for `paused`, `interrupted` and
 * `failed`, and must be absent for `idle` and `running`: a state that needs explaining and has
 * no explanation is corruption, not a record to interpret.
 */

export const SESSION_LIFECYCLE_VERSION = 1 as const;
/** One control-store payload cap applies: the record is stored as bounded JSON. */
export const SESSION_LIFECYCLE_MAX_RECORD_BYTES = 64 * 1024;
/** The documented reason bound. A reason is short, printable and human-facing. */
export const SESSION_LIFECYCLE_REASON_MAX_LENGTH = 240;
/** The id rule, shared with the named-session identifier rule. */
export const SESSION_LIFECYCLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/** A request identity is an opaque, bounded, printable token (Pi's request id). */
export const SESSION_LIFECYCLE_REQUEST_ID_MAX_LENGTH = 200;

/** The revision a session that has no durable lifecycle row yet reads at. */
export const SESSION_LIFECYCLE_UNRECORDED_REVISION = 0;
/** The deterministic instant of the unrecorded initial record, so a read is reproducible. */
export const SESSION_LIFECYCLE_EPOCH = '1970-01-01T00:00:00.000Z';

/** The closed state set. An unknown state fails closed rather than being interpreted. */
export const SESSION_LIFECYCLE_STATES = ['idle', 'running', 'paused', 'interrupted', 'failed'] as const;
export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

/** The closed action set the owner may take. There is no action outside these five. */
export const SESSION_LIFECYCLE_ACTIONS = ['reconnect', 'resume', 'retry', 'stop', 'pause'] as const;
export type SessionLifecycleAction = (typeof SESSION_LIFECYCLE_ACTIONS)[number];

/** Which actions can cause a model request to be dispatched. Only these two, and only as a new or continued generation. */
export const SESSION_LIFECYCLE_DISPATCHING_ACTIONS: ReadonlySet<SessionLifecycleAction> = new Set(['resume', 'retry']);

/** The stored record. `revision` is the optimistic-concurrency token every action sends back. */
export type SessionLifecycleRecord = {
  readonly version: 1;
  readonly projectId: string;
  readonly sessionId: string;
  readonly state: SessionLifecycleState;
  readonly revision: number;
  /** How many generations this session has started. 0 means none yet. */
  readonly attempt: number;
  /** The request identity of the current or last generation, or null when no generation has run. */
  readonly requestId: string | null;
  /** Why the session is not idle, or null while idle or running. */
  readonly reason: string | null;
  /** True only for an `interrupted` state whose effect cannot be proven idempotent. */
  readonly uncertain: boolean;
  /** The last durable activity: when the record last changed through an action or an adoption. */
  readonly activityAt: string;
  readonly updatedAt: string;
};

/** Failed-closed reasons. Each refusal carries one of these codes and a precise, path-free message. */
export type SessionLifecycleErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'ILLEGAL'
  | 'CONFLICT'
  | 'NEEDS_ATTENTION'
  | 'CORRUPT'
  | 'STORAGE';
export class SessionLifecycleError extends Error {
  constructor(message: string, public readonly code: SessionLifecycleErrorCode) {
    super(message);
    this.name = 'SessionLifecycleError';
  }
}

const textPattern = /^[^\u0000-\u001f\u007f]+$/;
const requestIdPattern = new RegExp('^[^\\s\\u0000-\\u001f\\u007f]{1,' + SESSION_LIFECYCLE_REQUEST_ID_MAX_LENGTH + '}$');

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const path = issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
  return path + issue.message;
}
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string, code: SessionLifecycleErrorCode = 'INVALID'): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new SessionLifecycleError(label + ' is invalid: ' + firstIssue(error), code);
    throw error;
  }
}

const stateSchema = z.enum(SESSION_LIFECYCLE_STATES);
const recordSchema = z.strictObject({
  version: z.literal(SESSION_LIFECYCLE_VERSION),
  projectId: z.string().regex(SESSION_LIFECYCLE_ID_PATTERN, 'a project id must be 1-160 characters from A-Za-z0-9._:-'),
  sessionId: z.string().regex(SESSION_LIFECYCLE_ID_PATTERN, 'a session id must be 1-160 characters from A-Za-z0-9._:-'),
  state: stateSchema,
  revision: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  requestId: z.string().regex(requestIdPattern, 'a request identity must be 1-' + SESSION_LIFECYCLE_REQUEST_ID_MAX_LENGTH + ' printable characters').nullable(),
  reason: z
    .string()
    .min(1)
    .max(SESSION_LIFECYCLE_REASON_MAX_LENGTH)
    .regex(textPattern, 'a reason must be printable text')
    .nullable(),
  uncertain: z.boolean(),
  activityAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export function parseSessionLifecycleIdentifier(value: unknown, label: string): string {
  return parseStrict(z.string().regex(SESSION_LIFECYCLE_ID_PATTERN, label + ' must be 1-160 characters from A-Za-z0-9._:-'), value, label);
}
export function parseSessionLifecycleState(value: unknown, label = 'state'): SessionLifecycleState {
  return parseStrict(stateSchema, value, label + ' must be one of ' + SESSION_LIFECYCLE_STATES.join(', '));
}
export function parseSessionLifecycleAction(value: unknown, label = 'action'): SessionLifecycleAction {
  return parseStrict(z.enum(SESSION_LIFECYCLE_ACTIONS), value, label + ' must be one of ' + SESSION_LIFECYCLE_ACTIONS.join(', '));
}
/** A reason for a non-idle state. Refuses empty text, control characters and anything over the bound. */
export function parseSessionLifecycleReason(value: unknown, label = 'reason'): string {
  return parseStrict(
    z.string().min(1).max(SESSION_LIFECYCLE_REASON_MAX_LENGTH).regex(textPattern, 'a reason must be printable text'),
    value,
    label + ' must be 1-' + SESSION_LIFECYCLE_REASON_MAX_LENGTH + ' characters of printable text'
  );
}

/**
 * The deterministic record a session reads at before it has a durable lifecycle row. It is idle,
 * revision 0 and carries no attempt, so the first action a client sends (revision 0) transitions it
 * to revision 1 through the same compare-and-swap every other write uses.
 */
export function initialSessionLifecycle(projectId: string, sessionId: string): SessionLifecycleRecord {
  const id = parseSessionLifecycleIdentifier(projectId, 'projectId');
  const session = parseSessionLifecycleIdentifier(sessionId, 'sessionId');
  return Object.freeze({
    version: SESSION_LIFECYCLE_VERSION,
    projectId: id,
    sessionId: session,
    state: 'idle' as const,
    revision: SESSION_LIFECYCLE_UNRECORDED_REVISION,
    attempt: 0,
    requestId: null,
    reason: null,
    uncertain: false,
    activityAt: SESSION_LIFECYCLE_EPOCH,
    updatedAt: SESSION_LIFECYCLE_EPOCH
  });
}

/**
 * Validates a whole record: strict fields, the cross-field rules that make the state mean what it
 * says, and the payload cap. A record read back from storage that does not validate is corruption,
 * never a record to interpret.
 *
 * The cross-field rules are the honesty of the model:
 * - a request identity exists exactly when there has been an attempt;
 * - only `idle` may have had no attempt;
 * - `running` requires an attempt in flight, so it always has a request identity;
 * - `paused`, `interrupted` and `failed` require a reason, and `idle` and `running` forbid one;
 * - `uncertain` is possible only for an interruption.
 */
export function validateSessionLifecycleRecord(value: unknown, code: SessionLifecycleErrorCode = 'INVALID'): SessionLifecycleRecord {
  const parsed = parseStrict(
    recordSchema,
    value,
    'session lifecycle record (requires version, projectId, sessionId, state, revision, attempt, requestId, reason, uncertain, activityAt, updatedAt)',
    code
  );
  if (parsed.requestId === null && parsed.attempt !== 0) throw new SessionLifecycleError('A session lifecycle record claims an attempt with no request identity', code);
  if (parsed.requestId !== null && parsed.attempt === 0) throw new SessionLifecycleError('A session lifecycle record carries a request identity but no attempt', code);
  if (parsed.state !== 'idle' && parsed.attempt < 1) throw new SessionLifecycleError('A ' + parsed.state + ' session lifecycle record must name the attempt it is about', code);
  if (parsed.state === 'idle' && parsed.requestId === null && parsed.attempt !== 0) throw new SessionLifecycleError('A session lifecycle record is inconsistent', code);
  if ((parsed.state === 'idle' || parsed.state === 'running') && parsed.reason !== null)
    throw new SessionLifecycleError('A ' + parsed.state + ' session lifecycle record must not carry a reason', code);
  if ((parsed.state === 'paused' || parsed.state === 'interrupted' || parsed.state === 'failed') && parsed.reason === null)
    throw new SessionLifecycleError('A ' + parsed.state + ' session lifecycle record must carry the reason it is not idle', code);
  if (parsed.uncertain && parsed.state !== 'interrupted') throw new SessionLifecycleError('Only an interrupted session lifecycle record may be marked uncertain', code);
  if (Date.parse(parsed.updatedAt) < Date.parse(parsed.activityAt)) throw new SessionLifecycleError('A session lifecycle record is updated before its last activity', code);
  const record: SessionLifecycleRecord = Object.freeze({
    version: SESSION_LIFECYCLE_VERSION,
    projectId: parsed.projectId,
    sessionId: parsed.sessionId,
    state: parsed.state,
    revision: parsed.revision,
    attempt: parsed.attempt,
    requestId: parsed.requestId,
    reason: parsed.reason,
    uncertain: parsed.uncertain,
    activityAt: parsed.activityAt,
    updatedAt: parsed.updatedAt
  });
  let encoded: string;
  try {
    encoded = boundedJson(record);
  } catch (error) {
    throw new SessionLifecycleError('The session lifecycle record is not bounded JSON data: ' + (error as Error).message, code);
  }
  if (new TextEncoder().encode(encoded).byteLength > SESSION_LIFECYCLE_MAX_RECORD_BYTES)
    throw new SessionLifecycleError('The session lifecycle record exceeds ' + SESSION_LIFECYCLE_MAX_RECORD_BYTES + ' bytes', code);
  return record;
}

/** The reason a startup adoption records for a session whose process is gone. Deterministic text. */
export const SESSION_LIFECYCLE_ADOPTION_REASON = 'The owning process stopped while this session was running; the generation\'s completion cannot be proven, so it was not replayed.';
/**
 * The reason a dispatching action records when its own port refused to dispatch. Deterministic text,
 * and deliberately generic: a port's own error text may name a filesystem path or a provider detail,
 * so it is returned to the caller and never stored in the record.
 */
export const SESSION_LIFECYCLE_DISPATCH_REFUSED_REASON = 'The attempt was authorised and then refused by the harness, so nothing was sent to a provider and nothing was replayed; the session stays retryable.';

/**
 * What one action does: either nothing (a legal, idempotent no-op, or a `reconnect` that only
 * attaches) or one transition to a new revision. The plan is produced before anything is written or
 * dispatched, so an illegal or stale request is refused with no effect and no mutation.
 */
export type SessionLifecyclePlan =
  | { readonly kind: 'unchanged'; readonly record: SessionLifecycleRecord; readonly dispatch: false; readonly cancel: false }
  | {
      readonly kind: 'transition';
      readonly record: SessionLifecycleRecord;
      readonly next: SessionLifecycleRecord;
      /** True only for `resume` and `retry`: the actions that may dispatch a model request. */
      readonly dispatch: boolean;
      /** True for the two stop-like actions, which ask the current generation to stop. */
      readonly cancel: boolean;
      /**
       * The request identity the generation must be dispatched with. `resume` reuses the record's
       * own identity; `retry` uses the deterministic identity `retryRequestId` derives from the
       * revision the attempt is written at. Neither is ever minted at random, so two actions that
       * intend the same attempt always name the same submission.
       */
      readonly requestId: string | null;
    };

export type SessionLifecycleActionInput = {
  /** The revision the client read. A mismatch is a conflict that changes nothing. */
  readonly revision: unknown;
  /** The owner's reason, for the states that require one. */
  readonly reason?: unknown;
  /** The write instant. */
  readonly now: Date;
};

/**
 * The deterministic request identity of the attempt a `retry` starts.
 *
 * It is a pure function of the session and the revision the attempt is about to be written at, and
 * that is the point: two clients that both read the failed revision R, both tap retry and both act
 * on it derive the *identical* identity. The harness admits one submission per request identity, so
 * even a duplicate that did reach it collapses onto the original instead of starting a second model
 * run - and a *random* identity would do the opposite, letting both racers dispatch two different
 * requests (two charges) before either write landed.
 *
 * The identity is always a new one for the attempt: the failed attempt's own identity was derived at
 * an earlier revision, and a collision is refused rather than dispatched.
 */
export function retryRequestId(sessionId: string, targetRevision: number): string {
  return 'retry:' + sessionId + ':r' + targetRevision;
}

function parseRevision(value: unknown): number {
  return parseStrict(z.number().int().nonnegative(), value, 'revision (a whole number, 0 before the first write)');
}
function assertRevision(current: SessionLifecycleRecord, revision: number, action: SessionLifecycleAction): void {
  if (current.revision !== revision)
    throw new SessionLifecycleError(
      'Session ' + current.sessionId + ' is at lifecycle revision ' + current.revision + ', not ' + revision + '; the ' + action + ' wrote nothing and the record is unchanged',
      'CONFLICT'
    );
}
function instant(now: Date): string {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new SessionLifecycleError('The session lifecycle clock is not a valid instant', 'INVALID');
  return new Date(at).toISOString();
}
function transition(current: SessionLifecycleRecord, change: {
  state: SessionLifecycleState;
  attempt?: number;
  requestId?: string | null;
  reason: string | null;
  uncertain?: boolean;
  requestIdForDispatch: string | null;
  dispatch: boolean;
  cancel: boolean;
  now: Date;
}): SessionLifecyclePlan {
  const requestId = change.requestId === undefined ? current.requestId : change.requestId;
  const attempt = change.attempt === undefined ? current.attempt : change.attempt;
  const next = validateSessionLifecycleRecord({
    version: SESSION_LIFECYCLE_VERSION,
    projectId: current.projectId,
    sessionId: current.sessionId,
    state: change.state,
    revision: current.revision + 1,
    attempt,
    requestId,
    reason: change.reason,
    uncertain: change.uncertain ?? false,
    activityAt: instant(change.now),
    updatedAt: instant(change.now)
  });
  return Object.freeze({
    kind: 'transition' as const,
    record: current,
    next,
    dispatch: change.dispatch,
    cancel: change.cancel,
    requestId: change.requestIdForDispatch
  });
}

/**
 * The single authority on what each owner action does. It reads the current record and the action,
 * validates the revision, refuses every illegal jump with a precise reason, and returns either a
 * no-op (reconnect, an already-stopped session, an already-paused session) or exactly one transition.
 *
 * Nothing here dispatches or cancels anything; the caller performs the planned effect. What is
 * guaranteed here is the semantics: `resume` reuses the original request identity and `retry` uses
 * the identity derived from the revision it writes (so neither can ever mint an identity a second
 * racer would not also derive), and an uncertain interruption is refused rather than replayed.
 */
export function planSessionLifecycleAction(
  current: SessionLifecycleRecord,
  action: SessionLifecycleAction,
  input: SessionLifecycleActionInput
): SessionLifecyclePlan {
  const revision = parseRevision(input.revision);
  assertRevision(current, revision, action);
  const now = input.now;
  switch (action) {
    case 'reconnect':
      // Attaching a fresh client changes no execution state. Only the revision is checked, so a
      // stale client is told to re-read instead of acting on an old view.
      return Object.freeze({ kind: 'unchanged' as const, record: current, dispatch: false as const, cancel: false as const });
    case 'stop': {
      // Cancelling is idempotent: only a running session has a generation to cancel.
      if (current.state !== 'running')
        return Object.freeze({ kind: 'unchanged' as const, record: current, dispatch: false as const, cancel: false as const });
      return transition(current, { state: 'idle', reason: null, uncertain: false, requestIdForDispatch: null, dispatch: false, cancel: true, now });
    }
    case 'pause': {
      if (current.state === 'paused')
        return Object.freeze({ kind: 'unchanged' as const, record: current, dispatch: false as const, cancel: false as const });
      if (current.state !== 'running')
        throw new SessionLifecycleError('Only a running session can be paused; this session is ' + current.state, 'ILLEGAL');
      const reason = input.reason === undefined || input.reason === null ? 'The owner paused this session; it can still be resumed under its original request identity.' : parseSessionLifecycleReason(input.reason);
      return transition(current, { state: 'paused', reason, uncertain: false, requestIdForDispatch: null, dispatch: false, cancel: true, now });
    }
    case 'resume': {
      if (current.state !== 'paused' && current.state !== 'interrupted')
        throw new SessionLifecycleError('Only a paused or interrupted session can be resumed; this session is ' + current.state + (current.state === 'failed' ? ' (use retry)' : ''), 'ILLEGAL');
      if (current.requestId === null)
        throw new SessionLifecycleError('An interrupted or paused session has no request identity to resume', 'CORRUPT');
      if (current.state === 'interrupted' && current.uncertain)
        throw new SessionLifecycleError(
          'The interrupted generation cannot be proven idempotent, so resuming it could replay an uncertain effect; an operator must decide between a fresh retry and manual review, and nothing was replayed',
          'NEEDS_ATTENTION'
        );
      // Reuse the original request identity: a resumed generation can never double-submit.
      return transition(current, { state: 'running', reason: null, uncertain: false, requestIdForDispatch: current.requestId, dispatch: true, cancel: false, now });
    }
    case 'retry': {
      if (current.state !== 'failed')
        throw new SessionLifecycleError('Only a failed session can be retried; this session is ' + current.state, 'ILLEGAL');
      // The identity is *derived*, never minted: two racers that both read this revision plan the
      // same identity, so the harness can collapse them and the durable write can pick one winner.
      const fresh = retryRequestId(current.sessionId, current.revision + 1);
      if (fresh === current.requestId)
        throw new SessionLifecycleError('A retry must use a new request identity, not the failed attempt\'s own', 'INVALID');
      // A brand-new attempt under a derived identity: the failed one is never replayed.
      return transition(current, {
        state: 'running',
        attempt: current.attempt + 1,
        requestId: fresh,
        reason: null,
        uncertain: false,
        requestIdForDispatch: fresh,
        dispatch: true,
        cancel: false,
        now
      });
    }
  }
}

/**
 * The startup adoption of sessions whose durable state says `running` but whose process is gone.
 *
 * It is a plain transition, revision-checked like any other, so a second start (which finds no
 * running record) changes nothing and the adoption is idempotent. It is deliberately distinct from
 * the delivery reconciliation: it moves no outbox row and re-sends nothing, and an adopted session
 * is `uncertain`, so `resume` refuses it rather than replaying the interrupted generation.
 */
export function planStartupAdoption(current: SessionLifecycleRecord, now: Date): SessionLifecyclePlan {
  if (current.state !== 'running')
    return Object.freeze({ kind: 'unchanged' as const, record: current, dispatch: false as const, cancel: false as const });
  return transition(current, {
    state: 'interrupted',
    reason: SESSION_LIFECYCLE_ADOPTION_REASON,
    uncertain: true,
    requestIdForDispatch: null,
    dispatch: false,
    cancel: false,
    now
  });
}
