import { z } from 'zod';
import { canonicalJson } from './control-state';

/**
 * A fork: one child session branched from a parent transcript at an exact cutoff entry, holding its
 * own git worktree created from a recorded base commit.
 *
 * The model is deliberately narrow, and every part of it is a rule rather than a convention:
 *
 * - **The record is the fork.** A fork is durable, strictly validated and revisioned: the parent
 *   project and session, the exact cutoff entry id it branched from, the child session id, the
 *   child's git worktree path, the recorded base commit, the creation instant and a state from the
 *   closed set below. An unknown field, an absent one or a value of the wrong kind fails closed with
 *   a precise reason, and no reason carries a filesystem path.
 * - **The cutoff rule.** The child sees the parent's context **up to and including the cutoff entry
 *   and nothing after it**. It is the rule the transcript fork implements (Pi Durable's own
 *   `fork(at)`), and `forkContextEntries` states it as a pure function so it can be checked
 *   directly.
 * - **The worktree rule.** The child's worktree is created from the **recorded base commit** by one
 *   fixed git operation (`git worktree add`), and never from the parent's working tree. Nothing is
 *   copied, nothing is stashed and no uncommitted or staged change is ever carried: a fork starts
 *   from a commit, and the parent's own worktree is left exactly as it was.
 * - **The paused rule.** A child is created **paused**. While it is paused it refuses to dispatch
 *   anything at all, so no model request can be made for it until an explicit resume, and it inherits
 *   no approvals, no accepted artifact and no grant of any kind.
 *
 * This module is pure: its only runtime import is the control store's own JSON helper (the same one
 * the coding-runner model uses), so the client can render the same closed sets the server enforces.
 * The durable half is `src/server/state/fork-store.ts`, the transcript and worktree ports are
 * `src/server/agents/harness-host.ts` and the same store, and the operator-facing description is
 * `docs/FORKS.md`.
 */

export const FORK_VERSION = 1 as const;

/**
 * The closed state set. Each state says exactly what the durable record proves:
 *
 * - `paused`: the fork exists and refuses to dispatch anything. This is how a fork is created, and
 *   the only state from which a resume is legal.
 * - `active`: an explicit resume lifted the pause, so the child may be dispatched into. Nothing is
 *   dispatched by the resume itself.
 * - `discarded`: the worktree was removed (or was already gone) and the fork is closed. Terminal.
 * - `failed`: the fork needs an operator; the reason is the named `attention` reason and never a
 *   path. Terminal until an operator discards it — and a forced discard is the only way out, so a
 *   fork that failed is never quietly completed.
 */
export const FORK_STATES = ['paused', 'active', 'discarded', 'failed'] as const;
export type ForkState = (typeof FORK_STATES)[number];

/**
 * The closed set of operator-attention reasons, each with the one sentence it is reported as. Every
 * one of them is path-free: a git or filesystem failure may name a path, and those are logged, never
 * stored or returned.
 *
 * - `worktree-create-failed`: the child's worktree could not be created from the recorded commit and
 *   a directory was left behind, so whether it is usable cannot be established from here.
 * - `worktree-dirty`: the child's worktree holds uncommitted or untracked changes. A discard refuses
 *   to remove it without an explicit `force`, because those changes exist nowhere else.
 * - `worktree-remove-refused`: git refused to remove the child's worktree and nothing was forced.
 * - `worktree-unreadable`: the child worktree could not be inspected at all — git could not report
 *   its state — so nothing was removed and nothing about its contents is claimed.
 * - `child-session-refused`: the child conversation exists but its named session could not be
 *   created, so the fork is recorded rather than hidden.
 */
export const FORK_ATTENTION_REASONS = ['worktree-create-failed', 'worktree-dirty', 'worktree-remove-refused', 'worktree-unreadable', 'child-session-refused'] as const;
export type ForkAttentionReason = (typeof FORK_ATTENTION_REASONS)[number];

/** The fixed, path-free sentence each reason is reported with. */
export const FORK_ATTENTION_DETAILS: Readonly<Record<ForkAttentionReason, string>> = Object.freeze({
  'worktree-create-failed': 'Creating the child worktree from the recorded base commit failed, so this fork was never usable and is recorded here rather than hidden. Inspect the fork target and discard the fork before trying again; this build never quietly retries a git worktree operation and never removes a worktree it did not finish creating.',
  'worktree-dirty': 'The child worktree holds uncommitted or untracked changes, and this build never removes them implicitly: those changes exist nowhere else. Inspect the worktree, then discard the fork again with an explicit force when the changes are not needed.',
  'worktree-remove-refused': 'git refused to remove the child worktree and nothing was forced, so the worktree is still there and the fork is unchanged. Inspect it, then discard again with an explicit force when it is safe to remove.',
  'worktree-unreadable': 'The child worktree could not be inspected: git could not report whether it holds uncommitted or untracked changes, so this build removed nothing and claims nothing about its contents. Inspect it by hand before deciding what to do.',
  'child-session-refused': 'The child transcript conversation was created but its named session could not be, so the fork is recorded here rather than hidden. Inspect the project sessions before trying again.'
});

/** The most forks one project may hold. A creation beyond it is refused with the record unchanged. */
export const FORK_MAX_FORKS = 20;
/** The documented maximum size of one stored fork record, in bytes (the control store's own cap). */
export const FORK_MAX_RECORD_BYTES = 64 * 1024;
/**
 * How many of a parent transcript's entries one creation reads while looking for the cutoff. The
 * lookup is bounded on purpose: a cutoff outside the bound is refused rather than searched for
 * without limit, and the reason names the bound.
 */
export const FORK_MAX_ENTRY_SCAN = 2_000;
/** The documented ceiling on expression this build accepts: a 40-character lowercase hex commit. */
export const FORK_BASE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
/** The identifier rule, shared with the control store's own record identifier rule. */
export const FORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/**
 * A fork target is exactly one path component inside the designated fork root: letters, digits and
 * `._:-`, never starting with a dot, and therefore never `.` or `..`, never a separator and never an
 * absolute path.
 */
export const FORK_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
/** The longest worktree path a fork record may carry. */
export const FORK_MAX_PATH_LENGTH = 1_000;
/** The cutoff rule, in one sentence, as it is documented and as the transcript fork implements it. */
export const FORK_CONTEXT_RULE =
  'A child sees the parent context up to and including the cutoff entry, and nothing the parent recorded after it.';

/** Failed-closed reasons. Each refusal carries one of these codes and a precise, path-free message. */
export type ForkErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'OUTSIDE_ROOT'
  | 'CONFLICT'
  | 'ILLEGAL'
  | 'BOUNDED'
  | 'WORKTREE'
  | 'UNAVAILABLE'
  | 'CORRUPT'
  | 'STORAGE';
export class ForkError extends Error {
  constructor(message: string, public readonly code: ForkErrorCode) {
    super(message);
    this.name = 'ForkError';
  }
}

/** A named operator-attention state: why this fork needs a person and not another attempt. */
export type ForkAttention = {
  readonly reason: ForkAttentionReason;
  readonly detail: string;
};

/**
 * One fork, exactly as it is stored and read back. Every field is required and strictly validated.
 *
 * `childSessionId` is the fork's own identity: resume and discard name it, and nothing else about the
 * fork may be addressed by a caller-supplied path. `worktreePath` is the child worktree's own
 * absolute path **inside the designated fork root**, and every operation that touches the filesystem
 * re-checks that it is still inside that root.
 */
export type ForkRecord = {
  readonly version: typeof FORK_VERSION;
  readonly projectId: string;
  readonly parentSessionId: string;
  /** The exact entry id in the parent transcript the child was branched at. */
  readonly cutoffEntryId: number;
  readonly childSessionId: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly state: ForkState;
  readonly revision: number;
  readonly attention: ForkAttention | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** What the owner reads for one project: the forks, the cutoff rule and the bounds this build enforces. */
export type ForkView = {
  readonly readOnly: true;
  readonly projectId: string;
  readonly forks: readonly ForkRecord[];
  readonly rules: {
    readonly cutoff: string;
    readonly worktree: string;
    readonly paused: string;
  };
  readonly limits: {
    readonly forks: number;
    readonly entryScan: number;
    readonly bytes: number;
  };
  readonly truncated: boolean;
};

/** What a resume or a discard reports: the record, what it did, and whether anything was removed. */
export type ForkActionResult = {
  readonly fork: ForkRecord;
  readonly outcome: 'created' | 'resumed' | 'unchanged' | 'discarded' | 'attention';
  /** True only when a worktree was really removed by this call. */
  readonly removed: boolean;
};

const textPattern = /^[^\u0000-\u001f\u007f]+$/;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const path = issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
  return path + issue.message;
}
/** Strict parsing: a ZodError becomes a precise, typed refusal rather than a schema-library message. */
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string, code: ForkErrorCode = 'INVALID'): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new ForkError(label + ' is invalid: ' + firstIssue(error), code);
    throw error;
  }
}
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

/** A project, session, fork or parent identifier: the control store's own record identifier rule. */
export function parseForkIdentifier(value: unknown, label: string): string {
  return parseStrict(z.string().regex(FORK_ID_PATTERN, label + ' must be 1-160 characters, starting alphanumeric, from A-Za-z0-9._:-'), value, label);
}
/**
 * The recorded base commit: a full, lowercase 40-character hex commit id. A short ref, a branch name
 * or an uppercase abbreviation is refused, so the record always names exactly one immutable commit.
 */
export function parseForkBaseCommit(value: unknown, label = 'baseCommit'): string {
  return parseStrict(
    z.string().regex(FORK_BASE_COMMIT_PATTERN, label + ' must be the full 40-character lowercase hex id of one commit'),
    value,
    label
  );
}
/**
 * The cutoff entry id: the numeric id of one entry in the parent transcript (the transcript view
 * renders it as a string). Zero and negative values are refused, because the first entry of a
 * transcript is 1 and a cutoff of 0 would mean "no context at all" without saying so.
 */
export function parseForkCutoffEntryId(value: unknown, label = 'cutoffEntryId'): number {
  return parseStrict(z.number().int().positive(), value, label + ' must be the whole entry id of one entry in the parent transcript');
}
/** A fork target: one path component inside the designated fork root, and nothing that could escape it. */
export function parseForkTarget(value: unknown, label = 'target'): string {
  return parseStrict(
    z.string().regex(FORK_TARGET_PATTERN, label + ' must be one path component inside the fork root: 1-80 characters of letters, digits and ._:-, starting alphanumeric'),
    value,
    label
  );
}
/** The revision a caller read. It is the only compare-and-swap a resume or a discard sends. */
export function parseForkRevision(value: unknown, label = 'revision'): number {
  return parseStrict(z.number().int().positive(), value, label + ' must be a whole number of one or more');
}
export function parseForkState(value: unknown, label = 'state'): ForkState {
  return parseStrict(z.enum(FORK_STATES), value, label + ' must be one of ' + FORK_STATES.join(', '));
}

const attentionSchema = z.strictObject({
  reason: z.enum(FORK_ATTENTION_REASONS),
  detail: z.string().min(1).max(800).regex(textPattern, 'a detail must be printable text')
});
const recordSchema = z.strictObject({
  version: z.literal(FORK_VERSION),
  projectId: z.string().regex(FORK_ID_PATTERN, 'a project id must be 1-160 characters from A-Za-z0-9._:-'),
  parentSessionId: z.string().regex(FORK_ID_PATTERN, 'a parent session id must be 1-160 characters from A-Za-z0-9._:-'),
  cutoffEntryId: z.number().int().positive(),
  childSessionId: z.string().regex(FORK_ID_PATTERN, 'a child session id must be 1-160 characters from A-Za-z0-9._:-'),
  worktreePath: z.string().min(1).max(FORK_MAX_PATH_LENGTH).regex(textPattern, 'a worktree path must be printable text'),
  baseCommit: z.string().regex(FORK_BASE_COMMIT_PATTERN, 'a base commit must be the full 40-character lowercase hex id of one commit'),
  state: z.enum(FORK_STATES),
  revision: z.number().int().positive(),
  attention: attentionSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

/** What each state requires of the one optional field, so no combination can mean two things. */
const STATE_FIELDS: Readonly<Record<ForkState, { attention: boolean }>> = Object.freeze({
  paused: { attention: false },
  active: { attention: false },
  discarded: { attention: false },
  failed: { attention: true }
});

/**
 * The strict validation every fork record goes through, on the way in and on the way out of storage.
 * Everything here fails closed with a precise reason:
 *
 * - an unknown or absent field is refused by the very schema the record is declared with;
 * - the named operator-attention field must match the fork's own state, so a failed fork cannot exist
 *   without the reason it needs a person for, and a paused, active or discarded fork cannot carry one;
 * - a fork never forks itself, and its worktree path must be a printable, bounded path with no
 *   control character in it;
 * - the record must fit the documented byte bound, which is the control store's own payload cap.
 */
export function validateForkRecord(value: unknown, code: ForkErrorCode = 'INVALID'): ForkRecord {
  const record = parseStrict(recordSchema, value, 'The fork record', code);
  if (record.childSessionId === record.parentSessionId)
    throw new ForkError('The fork record is invalid: a fork cannot be its own parent session', code);
  if (STATE_FIELDS[record.state].attention !== (record.attention !== null))
    throw new ForkError(
      'The fork record is invalid: a ' + record.state + ' fork ' + (STATE_FIELDS[record.state].attention ? 'must carry the named reason it needs attention' : 'must not carry an operator-attention reason'),
      code
    );
  let encoded: string;
  try {
    encoded = canonicalJson(record);
  } catch (error) {
    throw new ForkError('The fork record is invalid: it is not bounded JSON data (' + (error as Error).message + ')', code);
  }
  if (new TextEncoder().encode(encoded).byteLength > FORK_MAX_RECORD_BYTES)
    throw new ForkError('The fork record is invalid: it exceeds the documented ' + FORK_MAX_RECORD_BYTES + ' byte bound', 'BOUNDED');
  return deepFreeze(record);
}

/**
 * Which state changes are legal. Every operation performs exactly one of these, and anything else
 * fails closed. The table is the whole authority on transitions.
 *
 * - `paused` to `active` is the explicit resume: it lifts the pause and dispatches nothing.
 * - `paused` or `active` to `discarded` is a discard whose worktree really went away.
 * - `paused` or `active` to `failed` is a discard that could not remove the worktree, or a creation
 *   that left a directory behind. Nothing is forced, so the fork stays visible for an operator.
 * - `failed` to `discarded` is an operator resolving exactly that: a discard that then succeeded
 *   (with an explicit force where the worktree was dirty).
 * - Nothing leaves `discarded`: a discarded fork is never resumed and never dispatched into.
 */
export const FORK_TRANSITIONS: Readonly<Record<ForkState, readonly ForkState[]>> = Object.freeze({
  paused: Object.freeze(['active', 'discarded', 'failed'] as const),
  active: Object.freeze(['discarded', 'failed'] as const),
  discarded: Object.freeze([] as const),
  failed: Object.freeze(['discarded'] as const)
});
export function isLegalForkTransition(from: ForkState, to: ForkState): boolean {
  return FORK_TRANSITIONS[from].includes(to);
}
/** Refuse a state change the table does not hold, with the states that are legal named in the reason. */
export function assertForkTransition(from: ForkState, to: ForkState, childSessionId: string): void {
  if (isLegalForkTransition(from, to)) return;
  const allowed = FORK_TRANSITIONS[from];
  throw new ForkError(
    'Fork ' + childSessionId + ' is ' + from + ' and cannot become ' + to +
      (allowed.length === 0 ? '; ' + from + ' is terminal, so the fork is never resumed or dispatched into again' : '; a ' + from + ' fork can only become ' + allowed.join(', ')),
    'ILLEGAL'
  );
}

/**
 * The record a fork is created as: **paused**, at the first revision it may be read at, with the exact
 * parent, cutoff, child, worktree path and base commit it was created from. Nothing else may construct
 * a first revision.
 */
export function createdForkRecord(input: {
  readonly projectId: string;
  readonly parentSessionId: string;
  readonly cutoffEntryId: number;
  readonly childSessionId: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly state?: ForkState;
  readonly attention?: ForkAttention | null;
  readonly now: Date;
}): ForkRecord {
  const at = input.now.getTime();
  if (!Number.isFinite(at)) throw new ForkError('The fork clock is not a valid instant', 'INVALID');
  const timestamp = new Date(at).toISOString();
  return validateForkRecord({
    version: FORK_VERSION,
    projectId: parseForkIdentifier(input.projectId, 'projectId'),
    parentSessionId: parseForkIdentifier(input.parentSessionId, 'parentSessionId'),
    cutoffEntryId: parseForkCutoffEntryId(input.cutoffEntryId),
    childSessionId: parseForkIdentifier(input.childSessionId, 'childSessionId'),
    worktreePath: input.worktreePath,
    baseCommit: parseForkBaseCommit(input.baseCommit),
    state: input.state ?? ('paused' as const),
    revision: 1,
    attention: input.attention ?? null,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * The next revision of a fork, from the current one and one change, with everything re-validated. It is
 * the only constructor of a new revision, and the transition it performs must be one the table holds.
 */
export function nextForkRecord(
  current: ForkRecord,
  change: { readonly state: ForkState; readonly attention: ForkAttention | null; readonly now: Date }
): ForkRecord {
  const at = change.now.getTime();
  if (!Number.isFinite(at)) throw new ForkError('The fork clock is not a valid instant', 'INVALID');
  assertForkTransition(current.state, change.state, current.childSessionId);
  return validateForkRecord({
    ...current,
    state: change.state,
    attention: change.attention,
    revision: current.revision + 1,
    updatedAt: new Date(at).toISOString()
  });
}

/**
 * Why a fork may not be dispatched into, or null when it may. It is one pure rule, read by the store
 * that enforces it and by the tests, so "paused children refuse to dispatch" cannot mean two things:
 *
 * - a fork that is `paused` refuses, and the reason says an explicit resume is required;
 * - a fork that is `discarded` refuses, because the fork is closed;
 * - a fork that is `failed` refuses, because an operator has to resolve it first;
 * - only `active` may be dispatched into, and nothing here dispatches anything by itself.
 */
export function forkDispatchRefusal(record: ForkRecord): string | null {
  if (record.state === 'active') return null;
  if (record.state === 'paused')
    return 'Fork ' + record.childSessionId + ' is paused: a child is created paused and dispatches nothing — no model request at all — until an explicit resume lifts the pause. Resume it first, then dispatch.';
  if (record.state === 'discarded')
    return 'Fork ' + record.childSessionId + ' is discarded: its worktree is gone and the fork is closed, so nothing is dispatched into it.';
  return 'Fork ' + record.childSessionId + ' needs an operator (' + (record.attention?.reason ?? 'unknown') + '): resolve it and discard the fork before dispatching anywhere.';
}

/**
 * The cutoff rule as a pure function: the entries of a parent transcript a child branched at this
 * cutoff may see. The cutoff itself is included, everything after it is not, and an entry id the parent
 * transcript does not hold yields no context rather than a partial guess.
 */
export function forkContextEntries<T extends { readonly id: string | number }>(parent: readonly T[], cutoffEntryId: unknown): readonly T[] {
  const cutoff = parseForkCutoffEntryId(cutoffEntryId, 'cutoffEntryId');
  const at = parent.findIndex((entry) => Number(entry.id) === cutoff);
  if (at < 0) return Object.freeze([] as T[]);
  return Object.freeze(parent.slice(0, at + 1));
}

/**
 * The name of the session a fork's child is adopted as. It is derived from the parent's own name and
 * from the child session id, so it is deterministic, it says which session it branched from, and two
 * forks of one parent can never collide: the child session id is unique and it is part of the name.
 * The result always satisfies the documented session-name rule (1-80 characters, first character
 * alphanumeric).
 */
export function forkChildName(parentName: string, childSessionId: string): string {
  const id = parseForkIdentifier(childSessionId, 'childSessionId');
  const suffix = ' fork ' + id;
  const room = 80 - suffix.length;
  const head = parentName.trim().slice(0, Math.max(1, room)).trimEnd();
  const name = (head === '' ? 'Session' : head) + suffix;
  return name.length > 80 ? name.slice(0, 80).trimEnd() : name;
}

/** The owner-visible read of one project's forks: the records, the rules and the bounds in force. */
export function forkView(input: { readonly projectId: string; readonly forks: readonly ForkRecord[]; readonly truncated: boolean }): ForkView {
  return Object.freeze({
    readOnly: true as const,
    projectId: parseForkIdentifier(input.projectId, 'projectId'),
    forks: Object.freeze(input.forks.map((fork) => validateForkRecord(fork, 'CORRUPT'))),
    rules: Object.freeze({
      cutoff: FORK_CONTEXT_RULE,
      worktree: 'The child worktree is created from the recorded base commit by one fixed git worktree add, with no hooks, no submodule recursion, no network and no local-protocol transport; the parent uncommitted and staged changes are never copied, never stashed and never inherited.',
      paused: 'A child is created paused and inherits no approval, no accepted artifact and no grant; it refuses to dispatch anything until an explicit resume.'
    }),
    limits: Object.freeze({ forks: FORK_MAX_FORKS, entryScan: FORK_MAX_ENTRY_SCAN, bytes: FORK_MAX_RECORD_BYTES }),
    truncated: input.truncated
  });
}
