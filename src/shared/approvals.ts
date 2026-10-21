import { z } from 'zod';
import { boundedJson, canonicalJson } from './control-state';

/**
 * The approval model: an explicit, single-use, target-bound grant.
 *
 * This module is pure — no Node built-ins and no framework. It defines the closed kind set, the
 * exact target identity each kind binds, the persisted definition and the record a reader sees,
 * and the strict, fail-closed validation both of them go through. The durable storage lives in
 * `src/server/state/approval-store.ts`; generating the nonce (the only source of randomness) and
 * reading the clock are the caller's job, so validation stays deterministic and testable.
 *
 * Nothing here performs a commit, push, deploy, spend, provision or publish. An approval records
 * an authorisation; performing the action stays a separate, explicit step.
 */

export const APPROVAL_RECORD_VERSION = 1 as const;

/** The closed kind set. An unknown kind fails closed rather than being interpreted. */
export const APPROVAL_KINDS = ['commit', 'push', 'deploy', 'spend', 'provision', 'publish'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** A record is pending (awaiting consumption), consumed (spent) or revoked (withdrawn). */
export const APPROVAL_STATES = ['pending', 'consumed', 'revoked'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** A scope names at least one dimension; an unscoped approval or query does not exist. */
export const APPROVAL_SCOPE_DIMENSIONS = ['projectId', 'sessionId', 'operation'] as const;
export type ApprovalScopeDimension = (typeof APPROVAL_SCOPE_DIMENSIONS)[number];
export type ApprovalScope = {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly operation?: string;
};

/**
 * The documented maximum lifetime of an approval, measured from its issue time. A request asking
 * for longer, or for a moment that is not strictly in the future, fails closed: a long-lived or
 * already-dead "approval" is not an approval.
 */
export const APPROVAL_MAX_LIFETIME_MS = 60 * 60 * 1000;
/** The target of one approval is bounded JSON, so a grant cannot become an unbounded payload. */
export const APPROVAL_MAX_TARGET_BYTES = 4096;
/** A nonce is 32 random bytes, lowercase hex: single use, unforgeable and cheap to compare. */
export const APPROVAL_NONCE_BYTES = 32;
export const APPROVAL_NONCE_PATTERN = /^[a-f0-9]{64}$/;

/** Failed-closed reasons. Each refusal carries one of these codes and a precise message. */
export type ApprovalErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'SCOPE'
  | 'KIND_MISMATCH'
  | 'TARGET_MISMATCH'
  | 'CONFLICT'
  | 'CONSUMED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'STORAGE';
export class ApprovalError extends Error {
  constructor(message: string, public readonly code: ApprovalErrorCode) {
    super(message);
    this.name = 'ApprovalError';
  }
}

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
/** A field that names something outside Pilot (a remote, an endpoint, a channel) is opaque but bounded. */
const opaque = z.string().min(1).max(300).regex(/^[^\s\u0000-\u001f\u007f]+$/);
const digest256 = z.string().regex(/^[a-f0-9]{64}$/);
const commitSha = z.string().regex(/^[a-f0-9]{40}$/);
const isoInstant = z.string().datetime();

/**
 * The exact target identity per kind. Every field is required and unknown fields are refused, so a
 * grant cannot be widened by adding detail the approval does not name.
 */
export const APPROVAL_TARGET_SCHEMAS = {
  commit: z.strictObject({ repository: opaque, branch: opaque, treeDigest: digest256 }),
  push: z.strictObject({ remote: opaque, branch: opaque, commitSha }),
  deploy: z.strictObject({ endpoint: opaque, releaseId: opaque }),
  spend: z.strictObject({ amountMinor: z.number().int().positive().max(1_000_000_000_000), currency: z.string().regex(/^[A-Z]{3}$/) }),
  provision: z.strictObject({ resource: opaque, region: opaque }),
  publish: z.strictObject({ channel: opaque, artifact: opaque })
} as const;

export type ApprovalTargets = {
  commit: { readonly repository: string; readonly branch: string; readonly treeDigest: string };
  push: { readonly remote: string; readonly branch: string; readonly commitSha: string };
  deploy: { readonly endpoint: string; readonly releaseId: string };
  spend: { readonly amountMinor: number; readonly currency: string };
  provision: { readonly resource: string; readonly region: string };
  publish: { readonly channel: string; readonly artifact: string };
};
export type ApprovalTarget = ApprovalTargets[ApprovalKind];

/** The required target fields per kind, in a stable order. Documentation and tests read this. */
export const APPROVAL_TARGET_FIELDS: Record<ApprovalKind, readonly string[]> = {
  commit: ['repository', 'branch', 'treeDigest'],
  push: ['remote', 'branch', 'commitSha'],
  deploy: ['endpoint', 'releaseId'],
  spend: ['amountMinor', 'currency'],
  provision: ['resource', 'region'],
  publish: ['channel', 'artifact']
};

/** What a create request supplies; the id, issue time, nonce and state are the store's business. */
export type ApprovalCreateRequest = {
  readonly kind: ApprovalKind;
  readonly scope: ApprovalScope;
  readonly target: unknown;
  readonly expiresAt: string;
};
export type ValidatedApprovalRequest = {
  readonly kind: ApprovalKind;
  readonly scope: ApprovalScope;
  readonly target: ApprovalTarget;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lifetimeMs: number;
};

/** The immutable, self-describing part of an approval as it is stored durably. */
export type ApprovalDefinition = {
  readonly version: 1;
  readonly kind: ApprovalKind;
  readonly scope: ApprovalScope;
  readonly target: ApprovalTarget;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
};
/** What a reader sees: the definition plus the durable identity and the lifecycle state. */
export type ApprovalRecord = ApprovalDefinition & {
  readonly id: string;
  readonly state: ApprovalState;
  readonly consumedAt: string | null;
  readonly consumedBy: string | null;
  readonly revokedAt: string | null;
};

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const path = issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
  return path + issue.message;
}
/** Strict parsing: a ZodError becomes a precise, typed refusal rather than a stack trace. */
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new ApprovalError(label + ' is invalid: ' + firstIssue(error), 'INVALID');
    throw error;
  }
}

const scopeSchema = z.strictObject({
  projectId: identifier.optional(),
  sessionId: identifier.optional(),
  operation: identifier.optional()
});
/**
 * A scope (or a scope filter) must name at least one dimension. That is what makes "foreign scope"
 * a refusal instead of a wildcard read, and it is enforced on every entry point.
 */
export function parseApprovalScope(value: unknown, label = 'scope'): ApprovalScope {
  const parsed = parseStrict(scopeSchema, value, label);
  if (APPROVAL_SCOPE_DIMENSIONS.every((dimension) => parsed[dimension] === undefined))
    throw new ApprovalError(label + ' is invalid: name at least one of ' + APPROVAL_SCOPE_DIMENSIONS.join(', '), 'INVALID');
  return Object.freeze(parsed) as ApprovalScope;
}

export function parseApprovalKind(value: unknown): ApprovalKind {
  if (typeof value === 'string' && (APPROVAL_KINDS as readonly string[]).includes(value)) return value as ApprovalKind;
  throw new ApprovalError('Unknown approval kind; the closed set is ' + APPROVAL_KINDS.join(', '), 'INVALID');
}

/** Parses the target for one kind. Missing fields, unknown fields and wrong types all fail closed. */
export function parseApprovalTarget(kind: ApprovalKind, value: unknown): ApprovalTarget {
  const schema = APPROVAL_TARGET_SCHEMAS[kind];
  if (!schema) throw new ApprovalError('Unknown approval kind: ' + String(kind), 'INVALID');
  const parsed = parseStrict(schema as unknown as z.ZodType<Record<string, unknown>>, value, 'target for kind \'' + kind + '\' (requires ' + APPROVAL_TARGET_FIELDS[kind].join(', ') + ')');
  const encoded = boundedJson(parsed);
  if (new TextEncoder().encode(encoded).byteLength > APPROVAL_MAX_TARGET_BYTES)
    throw new ApprovalError('The target exceeds the ' + APPROVAL_MAX_TARGET_BYTES + ' byte approval target limit', 'INVALID');
  return Object.freeze(parsed) as ApprovalTarget;
}

/**
 * Validates a create request against the caller's clock: unknown fields, unknown kinds, a target
 * that is missing a field for its kind, an expiry that is not strictly in the future, and a
 * lifetime beyond the documented maximum all fail closed.
 */
export function validateApprovalRequest(value: unknown, now: Date): ValidatedApprovalRequest {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new ApprovalError('The approval clock is not a valid instant', 'STORAGE');
  const parsed = parseStrict(
    z.strictObject({ kind: z.string(), scope: z.unknown(), target: z.unknown(), expiresAt: z.unknown() }),
    value,
    'approval request (requires kind, scope, target, expiresAt)'
  );
  const kind = parseApprovalKind(parsed.kind);
  const scope = parseApprovalScope(parsed.scope);
  const target = parseApprovalTarget(kind, parsed.target);
  const expiresAtText = parseStrict(isoInstant, parsed.expiresAt, 'expiresAt');
  const expiresMs = Date.parse(expiresAtText);
  if (!Number.isFinite(expiresMs)) throw new ApprovalError('expiresAt is not a valid instant', 'INVALID');
  if (expiresMs <= nowMs) throw new ApprovalError('expiresAt must be strictly in the future; an approval is never issued already expired', 'INVALID');
  const lifetimeMs = expiresMs - nowMs;
  if (lifetimeMs > APPROVAL_MAX_LIFETIME_MS)
    throw new ApprovalError('The requested lifetime of ' + lifetimeMs + 'ms exceeds the documented maximum of ' + APPROVAL_MAX_LIFETIME_MS + 'ms', 'INVALID');
  const expiresAt = new Date(expiresMs).toISOString();
  const issuedAt = new Date(nowMs).toISOString();
  return Object.freeze({ kind, scope, target, issuedAt, expiresAt, lifetimeMs });
}

/** Validates the immutable definition exactly as it is read back from durable storage. */
export function validateApprovalDefinition(value: unknown): ApprovalDefinition {
  const parsed = parseStrict(
    z.strictObject({
      version: z.literal(APPROVAL_RECORD_VERSION),
      kind: z.string(),
      scope: z.unknown(),
      target: z.unknown(),
      issuedAt: isoInstant,
      expiresAt: isoInstant,
      nonce: z.string().regex(APPROVAL_NONCE_PATTERN)
    }),
    value,
    'approval definition'
  );
  const kind = parseApprovalKind(parsed.kind);
  const scope = parseApprovalScope(parsed.scope, 'approval definition scope');
  const target = parseApprovalTarget(kind, parsed.target);
  const issuedMs = Date.parse(parsed.issuedAt), expiresMs = Date.parse(parsed.expiresAt);
  if (expiresMs <= issuedMs) throw new ApprovalError('Stored approval definition expires at or before it was issued', 'STORAGE');
  if (expiresMs - issuedMs > APPROVAL_MAX_LIFETIME_MS) throw new ApprovalError('Stored approval definition exceeds the maximum lifetime', 'STORAGE');
  return Object.freeze({ version: APPROVAL_RECORD_VERSION, kind, scope, target, issuedAt: parsed.issuedAt, expiresAt: parsed.expiresAt, nonce: parsed.nonce }) as ApprovalDefinition;
}

/** Validates a full record, including that its lifecycle fields agree with its state. */
export function validateApprovalRecord(value: unknown): ApprovalRecord {
  const parsed = parseStrict(
    z.strictObject({
      version: z.literal(APPROVAL_RECORD_VERSION),
      id: identifier,
      kind: z.string(),
      scope: z.unknown(),
      target: z.unknown(),
      issuedAt: isoInstant,
      expiresAt: isoInstant,
      nonce: z.string().regex(APPROVAL_NONCE_PATTERN),
      state: z.enum(APPROVAL_STATES),
      consumedAt: isoInstant.nullable(),
      consumedBy: identifier.nullable(),
      revokedAt: isoInstant.nullable()
    }),
    value,
    'approval record'
  );
  const definition = validateApprovalDefinition({
    version: parsed.version,
    kind: parsed.kind,
    scope: parsed.scope,
    target: parsed.target,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
    nonce: parsed.nonce
  });
  if (parsed.state === 'pending' && (parsed.consumedAt !== null || parsed.consumedBy !== null || parsed.revokedAt !== null))
    throw new ApprovalError('A pending approval must carry no consumption or revocation', 'STORAGE');
  if (parsed.state === 'consumed' && (parsed.consumedAt === null || parsed.consumedBy === null || parsed.revokedAt !== null))
    throw new ApprovalError('A consumed approval must record when and by what it was consumed, and nothing else', 'STORAGE');
  if (parsed.state === 'revoked' && (parsed.revokedAt === null || parsed.consumedAt !== null || parsed.consumedBy !== null))
    throw new ApprovalError('A revoked approval must record when it was revoked, and no consumption', 'STORAGE');
  return Object.freeze({ ...definition, id: parsed.id, state: parsed.state, consumedAt: parsed.consumedAt, consumedBy: parsed.consumedBy, revokedAt: parsed.revokedAt });
}

/**
 * Whether a query names exactly the approval's scope. Consumption, reading and revocation all
 * require an exact match of the scope — not an intersecting one — so an approval scoped to a
 * project is never reachable through a session-only query, and vice versa.
 */
export function sameApprovalScope(filter: ApprovalScope, granted: ApprovalScope): boolean {
  return APPROVAL_SCOPE_DIMENSIONS.every((dimension) => filter[dimension] === granted[dimension]);
}

/** The stored target is bounded JSON, so two targets match when their canonical forms are equal. */
export function sameApprovalTarget(kind: ApprovalKind, left: ApprovalTarget, right: ApprovalTarget): boolean {
  return canonicalJson(parseApprovalTarget(kind, left)) === canonicalJson(parseApprovalTarget(kind, right));
}

/** Which target fields differ, for a precise refusal message. Empty means an exact match. */
export function approvalTargetDiffs(kind: ApprovalKind, left: unknown, right: unknown): string[] {
  const fields = APPROVAL_TARGET_FIELDS[kind] ?? [];
  const a = (left ?? {}) as Record<string, unknown>;
  const b = (right ?? {}) as Record<string, unknown>;
  return fields.filter((field) => canonicalJson({ value: a[field] }) !== canonicalJson({ value: b[field] }));
}

export function approvalIsExpired(record: { expiresAt: string }, now: Date): boolean {
  return Date.parse(record.expiresAt) <= now.getTime();
}
