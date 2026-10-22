import { z } from 'zod';
import { canonicalJson } from './control-state';

/**
 * The release model: an immutable candidate, a disposable preview created from one, and the
 * revision-checked promotion (and compatible rollback) that points the service at a candidate.
 *
 * Three rules are the point of this module, and every one of them is a rule rather than a
 * convention:
 *
 * - **A candidate is immutable.** A candidate is a record plus an artifact reference: its own
 *   candidate id, the release id and storage schema id it declares, the source digest of the exact
 *   revision it was built from, its image identity (a sha256 digest, or a version-shaped immutable
 *   tag), the creation instant and the environment it targets. Validation is strict: an unknown
 *   field, a missing or malformed identity, a moving tag, an unknown schema id or a malformed id or
 *   instant fails closed with a precise reason. Its content is fingerprinted, so a second candidate
 *   with the same id and *different* content is refused while a repeat of the identical record reads
 *   back the record that was already stored.
 * - **A preview is disposable and isolated by construction.** A preview belongs to one candidate,
 *   is created with its own data root, no production credentials, no tunnel, loopback-only
 *   publishing, a bounded lifetime and hard resource caps — and a placement that cannot establish
 *   every one of those is refused rather than degraded. A preview is never promoted: promotion
 *   names a candidate.
 * - **A promotion is a recorded fact and a rollback is compatible or refused.** A promotion records
 *   the candidate promoted, the release that was previously active (the rollback target), the
 *   instant and the actor, at the next revision of an append-only chain. A rollback returns to the
 *   recorded previous release only when the target release can read the data schema actually on
 *   disk; a newer on-disk schema is refused with a reason that points at the encrypted backup
 *   restore path rather than starting a service that would misread the data.
 *
 * This module is pure: its only import is the control store's own JSON helper, so every rule above
 * can be checked directly, and no refusal ever carries a secret. The durable half is
 * 'src/server/state/release-store.ts', the operator path is 'scripts/releases.mjs' and the runbook
 * is 'docs/RELEASES.md'.
 */

export const RELEASE_CANDIDATE_VERSION = 1 as const;
export const RELEASE_PREVIEW_VERSION = 1 as const;
export const RELEASE_EVENT_VERSION = 1 as const;

/** Failed-closed reasons. Each refusal carries one of these codes and a precise message. */
export type ReleaseErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IMMUTABLE'
  | 'ISOLATION'
  | 'CONTAINMENT'
  | 'BOUNDED'
  | 'INCOMPATIBLE'
  | 'UNAVAILABLE'
  | 'CORRUPT'
  | 'STORAGE';
export class ReleaseError extends Error {
  constructor(message: string, public readonly code: ReleaseErrorCode) {
    super(message);
    this.name = 'ReleaseError';
  }
}

/** The opaque-token rule every recorded identity follows: never a path, never a traversal segment. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** The source digest rule the release manifest itself uses. */
const SOURCE_DIGEST = /^[a-f0-9]{7,64}$/;
/** An image identity that cannot move: the digest of the exact image. */
const DIGEST_IDENTITY = /^sha256:[a-f0-9]{64}$/;
/** An image identity that does not move in practice: a version- or release-shaped tag. */
const IMMUTABLE_TAG = /^(?:v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?|release-[0-9]{4}-?[0-9]{2}-?[0-9]{2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;
/** The conventional moving tags, refused explicitly so the refusal names the reason. */
const MOVING_TAGS: readonly string[] = Object.freeze(['latest', 'main', 'master', 'head', 'edge', 'stable', 'nightly', 'dev', 'develop', 'test', 'trunk', 'canary', 'rolling']);
/** A lowercase image repository with an optional registry port: no scheme, no whitespace, no tag. */
const REPOSITORY = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;
/** One recorded instant: an ISO-8601 UTC instant with milliseconds, comparable as a string. */
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
/** The pointer a promotion leaves behind: the immutable release path or name the service starts through. */
const POINTER_MAX = 300;

/** The documented bounds of one preview: hard caps and a bounded lifetime, never "unlimited". */
export const RELEASE_PREVIEW_MIN_LIFETIME_MS = 60_000;
export const RELEASE_PREVIEW_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** The most previews one store may hold at once. A creation beyond it is refused, nothing created. */
export const RELEASE_MAX_PREVIEWS = 4;
export const RELEASE_PREVIEW_LIMIT_BOUNDS = Object.freeze({
  memoryBytes: Object.freeze({ min: 64 * 1024 * 1024, max: 8 * 1024 * 1024 * 1024 }),
  cpus: Object.freeze({ min: 0.1, max: 4 }),
  pids: Object.freeze({ min: 16, max: 512 })
});
export const RELEASE_PREVIEW_LIMITS_DOCUMENTED =
  'memory 64MiB-8GiB, CPU 0.1-4, PIDs 16-512, lifetime 1 minute - 24 hours';
/** A published port a preview may use. Anything else is a refusal, not a warning. */
export const RELEASE_LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', '::1', 'localhost']);
/** The one procedure a refused rollback points at: the encrypted full-state backup restore path. */
export const RELEASE_RESTORE_REFUSAL =
  'Return to the promoted release instead, or restore the matching state from the encrypted full-state backup: node scripts/restore.mjs <archive> <root>, then node scripts/data-tools.mjs promote <root>, and start that root. See docs/BACKUP.md.';

/** The storage schema vocabulary this build understands, supplied by the caller (see release.ts). */
export type ReleaseVocabulary = { readonly supportedSchemaIds: readonly string[] };

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const path = issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
  return path + issue.message;
}
/** Strict parsing: a ZodError becomes a precise, typed refusal rather than a schema-library message. */
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string, code: ReleaseErrorCode = 'INVALID'): T {
  try { return schema.parse(value); }
  catch (error) {
    if (error instanceof z.ZodError) throw new ReleaseError(label + ' is invalid: ' + firstIssue(error), code);
    throw error;
  }
}
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}
function requireToken(value: unknown, label: string, code: ReleaseErrorCode = 'INVALID'): string {
  if (typeof value !== 'string' || !ID.test(value))
    throw new ReleaseError(label + ' must be 1-120 characters from A-Za-z0-9._:- (an opaque identity, never a path)', code);
  return value;
}
function requireInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || !Number.isFinite(Date.parse(value)))
    throw new ReleaseError(label + ' must be an ISO-8601 UTC instant with milliseconds (YYYY-MM-DDTHH:MM:SS.sssZ)', 'INVALID');
  return value;
}
function requireSchemaId(value: unknown, vocabulary: ReleaseVocabulary): string {
  if (typeof value !== 'string' || !ID.test(value))
    throw new ReleaseError('the declared schema id must be 1-120 characters from A-Za-z0-9._:- (it names a storage schema, not a path)', 'INVALID');
  if (!vocabulary.supportedSchemaIds.includes(value))
    throw new ReleaseError('the declared storage schema \'' + value + '\' is not one this build supports (it supports ' + vocabulary.supportedSchemaIds.join(', ') + ')', 'INVALID');
  return value;
}
function requireDigest(value: unknown, label: string, code: ReleaseErrorCode): string {
  if (typeof value !== 'string' || !SOURCE_DIGEST.test(value))
    throw new ReleaseError(label + ' must be 7-64 lowercase hex characters: the exact source revision the artifact was built from', code);
  return value;
}

/**
 * The canonical text of a record, with the content fingerprint omitted, and the utility that reads a
 * fingerprint back. The digest itself is supplied by the caller, so this module stays pure.
 */
export function recordCanonical(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new ReleaseError('A release record must be an object', 'INVALID');
  const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'fingerprint');
  return canonicalJson(Object.fromEntries(entries));
}
export type FingerprintOf = (canonical: string) => string;
function requireFingerprint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_IDENTITY.test(value))
    throw new ReleaseError('the stored ' + label + ' fingerprint must be a content digest of the form sha256:<64 hex characters>', 'CORRUPT');
  return value;
}
/** Recomputes a record's content fingerprint and refuses the record when it does not match. */
export function assertFingerprint(record: { readonly fingerprint?: unknown }, fingerprintOf: FingerprintOf, label: string): string {
  const recorded = requireFingerprint(record.fingerprint, label);
  const expected = fingerprintOf(recordCanonical(record));
  if (recorded !== expected)
    throw new ReleaseError('the stored ' + label + ' fingerprint does not match its own content, so the durable record is corrupt and nothing is served from it', 'CORRUPT');
  return recorded;
}

/* --------------------------------------------------------------------------------------------- *
 * Path arithmetic. Pure string logic over absolute POSIX paths: the deployment is a Linux host and
 * a container, a backslash or NUL is refused rather than interpreted, and no symlink is resolved
 * here (the caller resolves reality; these rules decide whether a placement may exist at all).
 * --------------------------------------------------------------------------------------------- */

/** Normalise an absolute POSIX path lexically ('/a/./b/../c' becomes '/a/c'). Returns null when unusable. */
export function normaliseLocalPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) return null;
  if (!value.startsWith('/') || value.includes('\u0000') || value.includes('\\')) return null;
  const parts: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { parts.pop(); continue; }
    parts.push(segment);
  }
  return '/' + parts.join('/');
}
/** Whether one normalised path is the other or lies inside it. Pure, lexical and separator-aware. */
export function pathContains(root: string, path: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : root + '/');
}
/** Whether two paths overlap in either direction, which is exactly the relation a preview must not have. */
export function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

/* --------------------------------------------------------------------------------------------- *
 * The artifact reference and the candidate.
 * --------------------------------------------------------------------------------------------- */

/** The artifact a candidate names: one image, addressed by a digest or by an immutable tag. */
export type ReleaseArtifact = {
  /** The image repository, for example 'ghcr.io/owner/pilot'. */
  readonly repository: string;
  readonly kind: 'digest' | 'immutable-tag';
  /** The full immutable reference: '<repository>@sha256:<hex>' or '<repository>:<tag>'. */
  readonly reference: string;
  /** The digest ('sha256:<hex>') or the immutable tag itself. */
  readonly identity: string;
};
const artifactSchema = z.strictObject({
  repository: z.string().min(1).max(200),
  kind: z.enum(['digest', 'immutable-tag']),
  reference: z.string().min(1).max(400),
  identity: z.string().min(1).max(200)
});
/**
 * Strictly validate an artifact reference. A missing or malformed identity is refused with the
 * reason it failed: an empty repository, a moving tag ('latest'), a digest that is not 64 hex
 * characters, or a reference that does not address exactly the declared identity.
 */
export function validateReleaseArtifact(value: unknown): ReleaseArtifact {
  const artifact = parseStrict(artifactSchema, value, 'the release artifact');
  if (!REPOSITORY.test(artifact.repository))
    throw new ReleaseError('the release artifact repository must be a plain lowercase image repository (letters, digits, dot, dash, underscore, slash and an optional registry port) with no scheme and no tag', 'INVALID');
  if (artifact.kind === 'digest') {
    if (!DIGEST_IDENTITY.test(artifact.identity))
      throw new ReleaseError('the release artifact identity must be a sha256 digest of the form sha256:<64 hex characters>; an image addressed any other way can be replaced under the same name', 'INVALID');
    const expected = artifact.repository + '@' + artifact.identity;
    if (artifact.reference !== expected)
      throw new ReleaseError('the release artifact reference must address exactly its immutable identity (\'' + expected + '\')', 'INVALID');
  } else {
    if (MOVING_TAGS.includes(artifact.identity))
      throw new ReleaseError('the release artifact tag \'' + artifact.identity + '\' is a moving tag: a release candidate must name an immutable identity (a sha256 digest, or a version- or release-shaped tag)', 'INVALID');
    if (!IMMUTABLE_TAG.test(artifact.identity))
      throw new ReleaseError('the release artifact tag \'' + artifact.identity + '\' is not version-shaped, so this build cannot treat it as immutable: name a digest, or a tag such as v1.2.3, 1.2.3-rc.1 or release-2026-01-01', 'INVALID');
    const expected = artifact.repository + ':' + artifact.identity;
    if (artifact.reference !== expected)
      throw new ReleaseError('the release artifact reference must address exactly its immutable identity (\'' + expected + '\')', 'INVALID');
  }
  return deepFreeze({ repository: artifact.repository, kind: artifact.kind, reference: artifact.reference, identity: artifact.identity }) as ReleaseArtifact;
}

/** One immutable release candidate, exactly as it is stored and read back. */
export type ReleaseCandidate = {
  readonly version: typeof RELEASE_CANDIDATE_VERSION;
  readonly candidateId: string;
  readonly releaseId: string;
  readonly schemaId: string;
  readonly sourceDigest: string;
  readonly artifact: ReleaseArtifact;
  readonly createdAt: string;
  /** The environment this candidate targets, for example 'hosted-vps'. */
  readonly environment: string;
  readonly fingerprint: string;
};
/** The candidate fields a caller supplies. The version and the fingerprint are never caller-supplied. */
export type ReleaseCandidateRequest = Omit<ReleaseCandidate, 'version' | 'fingerprint'>;
const candidateFieldsSchema = z.strictObject({
  candidateId: z.string().min(1).max(120),
  releaseId: z.string().min(1).max(120),
  schemaId: z.string().min(1).max(120),
  sourceDigest: z.string().min(1).max(64),
  artifact: artifactSchema,
  createdAt: z.string().min(1).max(40),
  environment: z.string().min(1).max(120)
});
const candidateRecordSchema = candidateFieldsSchema.extend({ version: z.literal(RELEASE_CANDIDATE_VERSION), fingerprint: z.string().min(1).max(80) });

/** Validate a candidate a caller wants recorded. Unknown fields, missing fields and bad values are refused. */
export function parseReleaseCandidateRequest(value: unknown, vocabulary: ReleaseVocabulary): ReleaseCandidateRequest {
  const fields = parseStrict(candidateFieldsSchema, value, 'the release candidate');
  const candidate: ReleaseCandidateRequest = {
    candidateId: requireToken(fields.candidateId, 'the candidate id'),
    releaseId: requireToken(fields.releaseId, 'the candidate release id'),
    schemaId: requireSchemaId(fields.schemaId, vocabulary),
    sourceDigest: requireDigest(fields.sourceDigest, 'the candidate source digest', 'INVALID'),
    artifact: validateReleaseArtifact(fields.artifact),
    createdAt: requireInstant(fields.createdAt, 'the candidate creation instant'),
    environment: requireToken(fields.environment, 'the candidate target environment')
  };
  return deepFreeze(candidate);
}
/** Validate a candidate record read back from durable storage, including its own content fingerprint. */
export function parseReleaseCandidateRecord(value: unknown, vocabulary: ReleaseVocabulary): ReleaseCandidate {
  const record = parseStrict(candidateRecordSchema, value, 'the stored release candidate', 'CORRUPT');
  const fields = parseReleaseCandidateRequest(
    { candidateId: record.candidateId, releaseId: record.releaseId, schemaId: record.schemaId, sourceDigest: record.sourceDigest, artifact: record.artifact, createdAt: record.createdAt, environment: record.environment },
    vocabulary
  );
  return deepFreeze({ version: RELEASE_CANDIDATE_VERSION, ...fields, fingerprint: requireFingerprint(record.fingerprint, 'release candidate') }) as ReleaseCandidate;
}

/* --------------------------------------------------------------------------------------------- *
 * The preview: a request, a durable reservation, and the placement the container port established.
 * --------------------------------------------------------------------------------------------- */

/** The hard caps one preview runs under. All three are required: one absent means "not bounded". */
export type ReleaseResourceCap = { readonly memoryBytes: number; readonly cpus: number; readonly pids: number };
const capSchema = z.strictObject({
  memoryBytes: z.number().int().positive(),
  cpus: z.number().positive(),
  pids: z.number().int().positive()
});
const previewRequestSchema = z.strictObject({
  previewId: z.string().min(1).max(120),
  candidateId: z.string().min(1).max(120),
  lifetimeMs: z.number().int().positive(),
  limits: capSchema
});
export type ReleasePreviewRequest = {
  readonly previewId: string;
  readonly candidateId: string;
  readonly lifetimeMs: number;
  readonly limits: ReleaseResourceCap;
};
/** Validate one hard cap against the documented bounds, naming the dimension that failed. */
export function validateResourceCap(value: unknown, label: string): ReleaseResourceCap {
  const cap = parseStrict(capSchema, value, label);
  const bounds = RELEASE_PREVIEW_LIMIT_BOUNDS;
  if (cap.memoryBytes < bounds.memoryBytes.min || cap.memoryBytes > bounds.memoryBytes.max)
    throw new ReleaseError(label + ' must bound memory to ' + bounds.memoryBytes.min + '-' + bounds.memoryBytes.max + ' bytes, not ' + cap.memoryBytes + ' bytes', 'BOUNDED');
  if (cap.cpus < bounds.cpus.min || cap.cpus > bounds.cpus.max)
    throw new ReleaseError(label + ' must bound CPU to ' + bounds.cpus.min + '-' + bounds.cpus.max + ', not ' + cap.cpus, 'BOUNDED');
  if (cap.pids < bounds.pids.min || cap.pids > bounds.pids.max)
    throw new ReleaseError(label + ' must bound PIDs to ' + bounds.pids.min + '-' + bounds.pids.max + ', not ' + cap.pids, 'BOUNDED');
  return deepFreeze({ memoryBytes: cap.memoryBytes, cpus: cap.cpus, pids: cap.pids }) as ReleaseResourceCap;
}
/** Validate a preview creation request: a bounded lifetime and hard caps, or a refusal. */
export function parseReleasePreviewRequest(value: unknown): ReleasePreviewRequest {
  const request = parseStrict(previewRequestSchema, value, 'the preview request');
  const previewId = requireToken(request.previewId, 'the preview id');
  const candidateId = requireToken(request.candidateId, 'the preview candidate id');
  if (request.lifetimeMs < RELEASE_PREVIEW_MIN_LIFETIME_MS || request.lifetimeMs > RELEASE_PREVIEW_MAX_LIFETIME_MS)
    throw new ReleaseError('the preview lifetime must be ' + RELEASE_PREVIEW_MIN_LIFETIME_MS + '-' + RELEASE_PREVIEW_MAX_LIFETIME_MS + ' ms (' + RELEASE_PREVIEW_LIMITS_DOCUMENTED + '): a preview has a bounded lifetime and is never given an unbounded one', 'BOUNDED');
  return deepFreeze({ previewId, candidateId, lifetimeMs: request.lifetimeMs, limits: validateResourceCap(request.limits, 'the preview resource cap') }) as ReleasePreviewRequest;
}

/**
 * The durable reservation of a preview, written **before** anything is created. It is what makes a
 * preview container impossible to create without a durable record: a creation that fails leaves a
 * reservation an operator can see and discard, and never a container nobody knows about.
 */
export type ReleasePreviewReservation = {
  readonly version: typeof RELEASE_PREVIEW_VERSION;
  readonly previewId: string;
  readonly candidateId: string;
  readonly releaseId: string;
  readonly schemaId: string;
  readonly artifact: ReleaseArtifact;
  readonly lifetimeMs: number;
  readonly limits: ReleaseResourceCap;
  readonly requestedAt: string;
  readonly fingerprint: string;
};
const reservationSchema = z.strictObject({
  version: z.literal(RELEASE_PREVIEW_VERSION),
  previewId: z.string().min(1).max(120),
  candidateId: z.string().min(1).max(120),
  releaseId: z.string().min(1).max(120),
  schemaId: z.string().min(1).max(120),
  artifact: artifactSchema,
  lifetimeMs: z.number().int().positive(),
  limits: capSchema,
  requestedAt: z.string().min(1).max(40),
  fingerprint: z.string().min(1).max(80)
});
export function parseReleasePreviewReservation(value: unknown): ReleasePreviewReservation {
  const record = parseStrict(reservationSchema, value, 'the stored preview reservation', 'CORRUPT');
  if (record.lifetimeMs < RELEASE_PREVIEW_MIN_LIFETIME_MS || record.lifetimeMs > RELEASE_PREVIEW_MAX_LIFETIME_MS)
    throw new ReleaseError('the stored preview reservation carries a lifetime outside the documented bound, so the record is corrupt', 'CORRUPT');
  return deepFreeze({
    version: RELEASE_PREVIEW_VERSION,
    previewId: requireToken(record.previewId, 'the preview id', 'CORRUPT'),
    candidateId: requireToken(record.candidateId, 'the preview candidate id', 'CORRUPT'),
    releaseId: requireToken(record.releaseId, 'the preview release id', 'CORRUPT'),
    schemaId: requireToken(record.schemaId, 'the preview schema id', 'CORRUPT'),
    artifact: validateReleaseArtifact(record.artifact),
    lifetimeMs: record.lifetimeMs,
    limits: validateResourceCap(record.limits, 'the stored preview resource cap'),
    requestedAt: requireInstant(record.requestedAt, 'the preview request instant'),
    fingerprint: requireFingerprint(record.fingerprint, 'preview reservation')
  }) as ReleasePreviewReservation;
}

/** The facts a preview's container port established. Every one of them is checked before it is recorded. */
export type ReleasePreviewPlacement = {
  readonly environment: string;
  /** The preview's OWN data root. It is never the live data root and never overlaps it. */
  readonly dataRoot: string;
  /** Every host path the preview may see. Each one is inside the preview's own data root. */
  readonly mountedHostPaths: readonly string[];
  /** The production credential paths that would be mounted. A preview's list must be empty. */
  readonly credentials: readonly string[];
  /** The tunnel the preview would be reachable through. For a preview this must be null. */
  readonly tunnel: string | null;
  /** Every published port. Each one must be loopback-only. */
  readonly published: readonly { readonly host: string; readonly port: number }[];
  readonly resourceCap: ReleaseResourceCap;
  readonly lifetimeMs: number;
};
const placementSchema = z.strictObject({
  environment: z.string().min(1).max(120),
  dataRoot: z.string().min(1).max(1000),
  mountedHostPaths: z.array(z.string().min(1).max(1000)).max(16),
  credentials: z.array(z.string().min(1).max(300)).max(64),
  tunnel: z.string().min(1).max(300).nullable(),
  published: z.array(z.strictObject({ host: z.string().min(1).max(80), port: z.number().int() })).max(8),
  resourceCap: capSchema,
  lifetimeMs: z.number().int().positive()
});
export type PreviewPlacementContext = {
  /** The designated root every preview data root lives inside. It is outside the live data root. */
  readonly previewRoot: string;
  /** The live data root. A preview must be unable to read or write it. */
  readonly liveDataRoot: string;
  readonly requestedLifetimeMs: number;
  readonly requestedLimits: ReleaseResourceCap;
};
/**
 * Shape-only validation of a placement: the fields it must carry, and nothing about the world it
 * describes. A record read back from durable storage is re-validated with this; the rules below were
 * enforced before the facts were recorded and the record is immutable.
 */
export function parseReleasePreviewPlacement(value: unknown): ReleasePreviewPlacement {
  const placement = parseStrict(placementSchema, value, 'the preview placement');
  return deepFreeze({
    environment: placement.environment,
    dataRoot: placement.dataRoot,
    mountedHostPaths: Object.freeze([...placement.mountedHostPaths]),
    credentials: Object.freeze([...placement.credentials]),
    tunnel: placement.tunnel,
    published: Object.freeze(placement.published.map((entry) => ({ host: entry.host, port: entry.port }))),
    resourceCap: deepFreeze({ memoryBytes: placement.resourceCap.memoryBytes, cpus: placement.resourceCap.cpus, pids: placement.resourceCap.pids }),
    lifetimeMs: placement.lifetimeMs
  }) as ReleasePreviewPlacement;
}
/**
 * Validate a placement. Every isolation property is checked here, and a property that cannot be
 * established is a refusal (never a degraded preview): its own data root inside the designated
 * preview root and overlapping neither the live data root nor anything else the live service uses,
 * every mounted host path inside that root, no production credentials, no tunnel, loopback-only
 * publishing, hard caps within the documented bounds and no wider than what was requested, and a
 * bounded lifetime within the documented bound and no longer than what was requested.
 */
export function validatePreviewPlacement(value: unknown, context: PreviewPlacementContext): ReleasePreviewPlacement {
  const placement = parseReleasePreviewPlacement(value);
  const environment = requireToken(placement.environment, 'the preview environment name');
  const previewRoot = normaliseLocalPath(context.previewRoot);
  const liveRoot = normaliseLocalPath(context.liveDataRoot);
  if (previewRoot === null)
    throw new ReleaseError('the designated preview root is not an absolute POSIX path, so a preview cannot be isolated and none is created', 'ISOLATION');
  if (liveRoot === null)
    throw new ReleaseError('the live data root is not an absolute POSIX path, so a preview cannot be proven unable to reach it and none is created', 'ISOLATION');
  const dataRoot = normaliseLocalPath(placement.dataRoot);
  if (dataRoot === null)
    throw new ReleaseError('the placement does not report an absolute POSIX data root for the preview, so its own storage cannot be established and none is created', 'ISOLATION');
  if (dataRoot === previewRoot || !pathContains(previewRoot, dataRoot))
    throw new ReleaseError('the placement reports a data root outside the designated preview root, so this build cannot keep the preview out of the live data and none is created', 'ISOLATION');
  if (pathsOverlap(dataRoot, liveRoot))
    throw new ReleaseError('the placement reports a data root that is the live data root, inside it, or an ancestor of it, so a preview could read or write the live data and none is created', 'ISOLATION');
  if (placement.mountedHostPaths.length === 0)
    throw new ReleaseError('the placement mounts nothing at all, so the preview could not have its own data root and none is created', 'ISOLATION');
  for (const mounted of placement.mountedHostPaths) {
    const path = normaliseLocalPath(mounted);
    if (path === null)
      throw new ReleaseError('the placement reports a mounted host path that is not an absolute POSIX path, so it cannot be contained and none is created', 'CONTAINMENT');
    if (!pathContains(dataRoot, path))
      throw new ReleaseError('the placement mounts a host path outside the preview\'s own data root and inside the live service\'s own storage: a preview sees its own data root and nothing else, so none is created', 'CONTAINMENT');
    if (pathsOverlap(path, liveRoot))
      throw new ReleaseError('the placement mounts a host path that overlaps the live data root, so a preview could read or write the live data and none is created', 'ISOLATION');
  }
  if (placement.credentials.length > 0)
    throw new ReleaseError('the placement would mount ' + placement.credentials.length + ' production credential path(s); a preview is never given production credentials or secrets, so none is created', 'ISOLATION');
  if (placement.tunnel !== null)
    throw new ReleaseError('the placement reports a tunnel, so the preview would be reachable from outside the host; a preview has no tunnel and none is created', 'ISOLATION');
  const published: { host: string; port: number }[] = [];
  for (const entry of placement.published) {
    if (!RELEASE_LOOPBACK_HOSTS.includes(entry.host))
      throw new ReleaseError('the placement publishes on ' + entry.host + ', which is not loopback; a preview is reachable on loopback only, so none is created', 'ISOLATION');
    if (entry.port < 1024 || entry.port > 65535)
      throw new ReleaseError('the placement publishes port ' + entry.port + ', which is outside the unprivileged range 1024-65535, so none is created', 'ISOLATION');
    published.push({ host: entry.host, port: entry.port });
  }
  const cap = validateResourceCap(placement.resourceCap, 'the placement resource cap');
  if (cap.memoryBytes > context.requestedLimits.memoryBytes || cap.cpus > context.requestedLimits.cpus || cap.pids > context.requestedLimits.pids)
    throw new ReleaseError('the placement reports resource caps wider than the preview request asked for, so this build cannot promise the preview is bounded as requested and none is created', 'BOUNDED');
  if (placement.lifetimeMs < RELEASE_PREVIEW_MIN_LIFETIME_MS || placement.lifetimeMs > RELEASE_PREVIEW_MAX_LIFETIME_MS)
    throw new ReleaseError('the placement reports a lifetime of ' + placement.lifetimeMs + ' ms, outside the documented bound (' + RELEASE_PREVIEW_LIMITS_DOCUMENTED + '), so none is created', 'BOUNDED');
  if (placement.lifetimeMs > context.requestedLifetimeMs)
    throw new ReleaseError('the placement reports a lifetime of ' + placement.lifetimeMs + ' ms, longer than the ' + context.requestedLifetimeMs + ' ms that was requested, so none is created', 'BOUNDED');
  return deepFreeze({
    environment,
    dataRoot,
    mountedHostPaths: Object.freeze(placement.mountedHostPaths.map((mounted) => normaliseLocalPath(mounted) as string)),
    credentials: Object.freeze([]),
    tunnel: null,
    published: Object.freeze(published),
    resourceCap: cap,
    lifetimeMs: placement.lifetimeMs
  }) as ReleasePreviewPlacement;
}

/** A preview discard's removal report: what the port removed, and whether it removed the environment. */
export type PreviewRemovalReport = { readonly removed: readonly string[]; readonly environmentRemoved: boolean };
const removalSchema = z.strictObject({ removed: z.array(z.string().min(1).max(1000)).max(64), environmentRemoved: z.boolean() });
/**
 * Validate a discard's removal report against the preview's own data root. A preview is discarded by
 * removing only what the preview created: a report naming anything outside the preview's own data
 * root (the live data root above all) is refused, and nothing is recorded as discarded.
 */
export function validatePreviewRemoval(value: unknown, dataRoot: string): PreviewRemovalReport {
  const report = parseStrict(removalSchema, value, 'the preview removal report');
  const root = normaliseLocalPath(dataRoot);
  if (root === null) throw new ReleaseError('the preview\'s own data root is not an absolute POSIX path, so a discard cannot be contained and nothing was recorded', 'CONTAINMENT');
  const removed: string[] = [];
  for (const entry of report.removed) {
    const path = normaliseLocalPath(entry);
    if (path === null || !pathContains(root, path))
      throw new ReleaseError('the discard reports removing something outside the preview\'s own data root, which this build never does: nothing was recorded as discarded and the preview is still listed', 'CONTAINMENT');
    removed.push(path);
  }
  return deepFreeze({ removed: Object.freeze(removed), environmentRemoved: report.environmentRemoved }) as PreviewRemovalReport;
}

/* --------------------------------------------------------------------------------------------- *
 * Promotion, rollback and the release identity the running service reports.
 * --------------------------------------------------------------------------------------------- */

/** A release the service can be pointed at: the candidate's identity and the artifact that carries it. */
export type ReleaseTarget = {
  readonly candidateId: string;
  readonly releaseId: string;
  readonly schemaId: string;
  readonly sourceDigest: string;
  readonly artifact: ReleaseArtifact;
};
/** One recorded promotion or rollback. The chain of these records is the promotion history. */
export type ReleaseEvent = {
  readonly version: typeof RELEASE_EVENT_VERSION;
  readonly eventId: string;
  readonly action: 'promote' | 'rollback';
  /** The event's position in the chain: 1 for the first promotion, and never reused. */
  readonly revision: number;
  /** The revision the operator read before this promotion: the compare-and-swap basis. */
  readonly basedOnRevision: number;
  readonly candidateId: string;
  readonly releaseId: string;
  readonly schemaId: string;
  readonly sourceDigest: string;
  readonly artifact: ReleaseArtifact;
  /** The release that was active before this event: the rollback target, or null for the first. */
  readonly previousRelease: ReleaseTarget | null;
  readonly actor: string;
  readonly createdAt: string;
  /** The immutable release path or name the port pointed the service at. */
  readonly pointer: string;
  readonly fingerprint: string;
};
const targetSchema = z.strictObject({
  candidateId: z.string().min(1).max(120),
  releaseId: z.string().min(1).max(120),
  schemaId: z.string().min(1).max(120),
  sourceDigest: z.string().min(1).max(64),
  artifact: artifactSchema
});
const eventSchema = z.strictObject({
  version: z.literal(RELEASE_EVENT_VERSION),
  eventId: z.string().min(1).max(64),
  action: z.enum(['promote', 'rollback']),
  revision: z.number().int().positive(),
  basedOnRevision: z.number().int().min(0),
  candidateId: z.string().min(1).max(120),
  releaseId: z.string().min(1).max(120),
  schemaId: z.string().min(1).max(120),
  sourceDigest: z.string().min(1).max(64),
  artifact: artifactSchema,
  previousRelease: targetSchema.nullable(),
  actor: z.string().min(1).max(120),
  createdAt: z.string().min(1).max(40),
  pointer: z.string().min(1).max(POINTER_MAX),
  fingerprint: z.string().min(1).max(80)
});
export function validateReleaseTarget(value: unknown): ReleaseTarget {
  const target = parseStrict(targetSchema, value, 'the release target', 'CORRUPT');
  return deepFreeze({
    candidateId: requireToken(target.candidateId, 'the target candidate id', 'CORRUPT'),
    releaseId: requireToken(target.releaseId, 'the target release id', 'CORRUPT'),
    schemaId: requireToken(target.schemaId, 'the target schema id', 'CORRUPT'),
    sourceDigest: requireDigest(target.sourceDigest, 'the target source digest', 'CORRUPT'),
    artifact: validateReleaseArtifact(target.artifact)
  }) as ReleaseTarget;
}
export function parseReleaseEvent(value: unknown): ReleaseEvent {
  const event = parseStrict(eventSchema, value, 'the stored release event', 'CORRUPT');
  if (!UUID.test(event.eventId)) throw new ReleaseError('the stored release event id is malformed, so the promotion history is corrupt', 'CORRUPT');
  if (event.basedOnRevision >= event.revision)
    throw new ReleaseError('the stored release event claims a revision that is not later than the revision it was based on, so the promotion history is corrupt', 'CORRUPT');
  if (/[\u0000\n\r]/.test(event.pointer))
    throw new ReleaseError('the stored release event carries an unusable pointer, so the promotion history is corrupt', 'CORRUPT');
  return deepFreeze({
    version: RELEASE_EVENT_VERSION,
    eventId: event.eventId,
    action: event.action,
    revision: event.revision,
    basedOnRevision: event.basedOnRevision,
    candidateId: requireToken(event.candidateId, 'the stored event candidate id', 'CORRUPT'),
    releaseId: requireToken(event.releaseId, 'the stored event release id', 'CORRUPT'),
    schemaId: requireToken(event.schemaId, 'the stored event schema id', 'CORRUPT'),
    sourceDigest: requireDigest(event.sourceDigest, 'the stored event source digest', 'CORRUPT'),
    artifact: validateReleaseArtifact(event.artifact),
    previousRelease: event.previousRelease === null ? null : validateReleaseTarget(event.previousRelease),
    actor: requireToken(event.actor, 'the stored event actor', 'CORRUPT'),
    createdAt: requireInstant(event.createdAt, 'the stored event instant'),
    pointer: event.pointer,
    fingerprint: requireFingerprint(event.fingerprint, 'release event')
  }) as ReleaseEvent;
}
/** The target a promoted (or rolled back to) release is addressed by. */
export function targetOf(event: {
  readonly candidateId: string; readonly releaseId: string; readonly schemaId: string;
  readonly sourceDigest: string; readonly artifact: ReleaseArtifact;
}): ReleaseTarget {
  return deepFreeze({ candidateId: event.candidateId, releaseId: event.releaseId, schemaId: event.schemaId, sourceDigest: event.sourceDigest, artifact: event.artifact }) as ReleaseTarget;
}

/* --------------------------------------------------------------------------------------------- *
 * The release identity the running service reports, and the compatibility rule a rollback obeys.
 * --------------------------------------------------------------------------------------------- */

/** The identity a running build reports: the manifest's release id, schema id and optional source digest. */
export type ReleaseIdentityInput = { readonly releaseId: string; readonly schemaId: string; readonly sourceDigest?: string };
export type ReleaseDifference = { readonly field: 'releaseId' | 'schemaId' | 'sourceDigest'; readonly running: string; readonly promoted: string };
export type ReleaseMatch =
  | { readonly state: 'match' }
  | { readonly state: 'not-promoted' }
  | { readonly state: 'mismatch'; readonly differences: readonly ReleaseDifference[] };
/**
 * Whether the identity the running build was given is the identity of the candidate the store says
 * is promoted. A store with no promotion says nothing is promoted. A manifest that declares no
 * source digest cannot be checked for one, so only the fields it does declare are compared.
 */
export function matchReleaseIdentity(identity: ReleaseIdentityInput, promotion: ReleaseTarget | null): ReleaseMatch {
  if (promotion === null) return Object.freeze({ state: 'not-promoted' as const });
  const differences: ReleaseDifference[] = [];
  if (identity.releaseId !== promotion.releaseId) differences.push({ field: 'releaseId', running: identity.releaseId, promoted: promotion.releaseId });
  if (identity.schemaId !== promotion.schemaId) differences.push({ field: 'schemaId', running: identity.schemaId, promoted: promotion.schemaId });
  if (identity.sourceDigest !== undefined && identity.sourceDigest !== promotion.sourceDigest)
    differences.push({ field: 'sourceDigest', running: identity.sourceDigest, promoted: promotion.sourceDigest });
  if (differences.length === 0) return Object.freeze({ state: 'match' as const });
  return Object.freeze({ state: 'mismatch' as const, differences: Object.freeze(differences) });
}

/** What was observed of the storage schema on disk. It mirrors the read-only observation in release.ts. */
export type ObservedSchema =
  | { readonly state: 'present'; readonly version: number }
  | { readonly state: 'absent' }
  | { readonly state: 'busy' }
  | { readonly state: 'malformed' };
export type RollbackCompatibility =
  | { readonly compatible: true; readonly targetSchemaVersion: number; readonly onDiskSchemaVersion: number }
  | { readonly compatible: false; readonly refusal: 'schema-newer' | 'schema-older' | 'schema-unknown' | 'schema-unobservable'; readonly reason: string };
/**
 * Whether a rollback to a target release is compatible with the data schema actually on disk. It is
 * compatible only when the target release can read the schema that is there: a **newer** on-disk
 * schema is refused (the target would misread the data) and points at the encrypted backup restore
 * path, an older one is refused with its own reason, a schema this build cannot map to a version is
 * refused, and an unobservable schema is refused rather than assumed.
 */
export function rollbackCompatibility(input: {
  readonly target: ReleaseTarget;
  readonly observed: ObservedSchema;
  readonly schemaVersionFor: (schemaId: string) => number | undefined;
}): RollbackCompatibility {
  const targetSchemaVersion = input.schemaVersionFor(input.target.schemaId);
  if (targetSchemaVersion === undefined)
    return Object.freeze({
      compatible: false, refusal: 'schema-unknown' as const,
      reason: 'the rollback target release ' + input.target.releaseId + ' declares the storage schema ' + input.target.schemaId + ', which this build cannot map to a schema version, so it cannot prove the target could read the data on disk. ' + RELEASE_RESTORE_REFUSAL
    });
  const observed = input.observed;
  if (observed.state !== 'present')
    return Object.freeze({
      compatible: false, refusal: 'schema-unobservable' as const,
      reason: 'the storage schema on disk could not be observed (' + observed.state + '), so this build cannot prove the rollback target release ' + input.target.releaseId + ' could read it. Nothing was promoted and no service was started. ' + RELEASE_RESTORE_REFUSAL
    });
  if (observed.version > targetSchemaVersion)
    return Object.freeze({
      compatible: false, refusal: 'schema-newer' as const,
      reason: 'the storage schema on disk is version ' + observed.version + ', which is newer than release ' + input.target.releaseId + ' understands (version ' + targetSchemaVersion + '), so rolling back would start a service that misreads the data. The rollback is refused and nothing was promoted. ' + RELEASE_RESTORE_REFUSAL
    });
  if (observed.version < targetSchemaVersion)
    return Object.freeze({
      compatible: false, refusal: 'schema-older' as const,
      reason: 'the storage schema on disk is version ' + observed.version + ', which is older than release ' + input.target.releaseId + ' expects (version ' + targetSchemaVersion + '), so the target release would refuse to start on it. The rollback is refused and nothing was promoted. ' + RELEASE_RESTORE_REFUSAL
    });
  return Object.freeze({ compatible: true as const, targetSchemaVersion, onDiskSchemaVersion: observed.version });
}
