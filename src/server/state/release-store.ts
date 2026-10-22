import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  CONTROL_RECORD_VERSION, exceedsJsonLimit, validateOperationRecord,
  type ControlScope, type OperationRecord
} from '../../shared/control-state';
import { ControlStore, ControlStoreError } from './control-store';
import { SUPPORTED_SCHEMA_IDS, observeStorageSchema, schemaVersionForId, type StorageSchemaObservation } from '../release';
import {
  RELEASE_CANDIDATE_VERSION, RELEASE_EVENT_VERSION, RELEASE_MAX_PREVIEWS, RELEASE_PREVIEW_VERSION,
  ReleaseError, assertFingerprint, matchReleaseIdentity, parseReleaseCandidateRecord, parseReleaseCandidateRequest,
  parseReleaseEvent, parseReleasePreviewPlacement, parseReleasePreviewReservation, parseReleasePreviewRequest,
  recordCanonical, rollbackCompatibility, targetOf, validatePreviewPlacement, validatePreviewRemoval,
  type ObservedSchema, type PreviewRemovalReport, type ReleaseArtifact, type ReleaseCandidate,
  type ReleaseErrorCode, type ReleaseEvent, type ReleaseIdentityInput, type ReleaseMatch, type ReleasePreviewPlacement,
  type ReleasePreviewRequest, type ReleasePreviewReservation, type ReleaseResourceCap, type ReleaseTarget,
  type ReleaseVocabulary, type RollbackCompatibility
} from '../../shared/releases';

/**
 * The durable release store: candidates, disposable previews, promotions and rollbacks.
 *
 * It introduces **no** new persistence. Every record is one control-store operation whose immutable
 * input is the record itself and whose outbox row is its signature, exactly as the approval and
 * acceptance stores are built:
 *
 * - **A candidate** is one operation, keyed by its candidate id, admitted once and never updated.
 *   The store's own compare-and-swap is what makes it immutable: the same key with different content
 *   is refused inside the store's transaction, and the same key with identical content reads back
 *   the record that was already stored.
 * - **A preview** is two operations: a reservation written *before* anything is created, and the
 *   placement facts the container port established, written after they were validated. A discard
 *   moves the reservation's own operation to 'succeeded' with the removal receipt, checked against
 *   the revision the caller read, so two actors cannot both record a discard.
 * - **A promotion** is one operation per event, keyed by the revision it produces, in an append-only
 *   chain. Two layers make a stale promotion unable to win: the recorded revision is compared before
 *   the port is asked to do anything, and the key of the new revision is a compare-and-swap *inside*
 *   the store's transaction — a second writer that read the same revision is refused there, not
 *   silently overwritten.
 *
 * Nothing here deletes an artifact, and nothing here promotes a preview: a promotion names a
 * candidate, and a preview id named for promotion is refused with the candidate to promote instead.
 * The rules themselves live in 'src/shared/releases.ts'; the operator path is 'scripts/releases.mjs'
 * and the runbook is 'docs/RELEASES.md'.
 */

/** The one storage bucket every release record shares: these records are instance-scoped, not project-scoped. */
const BUCKET: ControlScope = Object.freeze({ projectId: 'release-control', sessionId: 'releases' });
const CANDIDATE_KIND = 'release.candidate';
const CANDIDATE_OUTBOX = 'release.candidate-record';
const PREVIEW_KIND = 'release.preview';
const PREVIEW_OUTBOX = 'release.preview-record';
const PLACEMENT_KIND = 'release.preview-placement';
const PLACEMENT_OUTBOX = 'release.preview-placement-record';
const EVENT_KIND = 'release.promotion';
const EVENT_OUTBOX = 'release.promotion-record';
/** Nothing reads more rows than these from a reviewed table, so a corrupt table cannot exhaust memory. */
const MAX_RECORDS = 1_000;
const MAX_PREVIEWS_READ = 200;
/** The opaque-identity rule, shared with the release model: never a path, never a traversal segment. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

function storage(message: string): ReleaseError {
  return new ReleaseError(message, 'STORAGE');
}
function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value))
    throw new ReleaseError(label + ' must be 1-120 characters from A-Za-z0-9._:- (an opaque identity, never a path)', 'INVALID');
  return value;
}
function requireRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
    throw new ReleaseError(label + ' must be the whole revision number the caller read (0 for a store with no promotion yet)', 'INVALID');
  return value;
}
function requireInstant(value: unknown, label: string, code: 'INVALID' | 'CORRUPT' = 'INVALID'): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || !Number.isFinite(Date.parse(value)))
    throw new ReleaseError(label + ' must be an ISO-8601 UTC instant with milliseconds', code);
  return value;
}
function instantOf(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw storage('The release store clock returned an unusable instant');
  return date.toISOString();
}
function sameTarget(left: ReleaseTarget | null, right: ReleaseTarget | null): boolean {
  if (left === null || right === null) return left === right;
  return left.candidateId === right.candidateId && left.releaseId === right.releaseId && left.schemaId === right.schemaId &&
    left.sourceDigest === right.sourceDigest && left.artifact.kind === right.artifact.kind &&
    left.artifact.reference === right.artifact.reference && left.artifact.identity === right.artifact.identity;
}

/** One preview container, as the durable reservation and the placement facts describe it. */
export type ReleasePreview = {
  readonly version: typeof RELEASE_PREVIEW_VERSION;
  readonly previewId: string;
  readonly candidateId: string;
  readonly releaseId: string;
  readonly schemaId: string;
  readonly artifact: ReleaseArtifact;
  readonly lifetimeMs: number;
  readonly limits: ReleaseResourceCap;
  readonly requestedAt: string;
  /** 'creating' is a reservation whose container was never recorded as established. */
  readonly state: 'creating' | 'active' | 'expired' | 'discarded';
  readonly placement: ReleasePreviewPlacement | null;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
  /** A preview is disposable by definition, and is never promoted: promotion names a candidate. */
  readonly disposable: true;
  readonly promotable: false;
  readonly discardedAt: string | null;
  readonly removed: readonly string[];
  /** The reservation operation's revision: the value a discard's revision check is made against. */
  readonly revision: number;
};

/** The promotion facts alone: the chain, without observing the storage schema. */
export type ReleasePromotionStatus = {
  readonly revision: number;
  readonly promotion: ReleaseEvent | null;
  /** The release that is active, as its candidate names it. */
  readonly target: ReleaseTarget | null;
  /** The release a rollback would return to, or null when nothing was promoted or nothing precedes it. */
  readonly rollbackTarget: ReleaseTarget | null;
};
/** What the store reports about promotions, and what a rollback would do now. */
export type ReleaseStatus = ReleasePromotionStatus & {
  /** What a rollback would do now, or null when there is nothing to roll back to. */
  readonly compatibility: RollbackCompatibility | null;
};

/** What the store asks a container port to create for one preview. */
export type PreviewEstablishRequest = {
  readonly previewId: string;
  readonly candidateId: string;
  readonly releaseId: string;
  readonly schemaId: string;
  readonly artifact: ReleaseArtifact;
  readonly lifetimeMs: number;
  readonly limits: ReleaseResourceCap;
  readonly previewRoot: string;
  readonly liveDataRoot: string;
};
export type PreviewDiscardRequest = { readonly preview: ReleasePreview };
/**
 * A preview's container port. \`establish\` creates a disposable container and reports the facts it
 * established, which the store then checks; \`discard\` removes what the preview created and reports
 * it. A port that cannot establish every isolation property must refuse rather than degrade: the
 * store refuses the preview either way.
 */
export interface PreviewContainerPort {
  establish(request: PreviewEstablishRequest): Promise<unknown>;
  discard(request: PreviewDiscardRequest): Promise<unknown>;
}
/** What the store asks a promotion port to do, and what that port must report back. */
export type ReleaseActivationRequest = {
  readonly action: 'promote' | 'rollback';
  readonly candidateId: string;
  readonly releaseId: string;
  readonly schemaId: string;
  readonly artifact: ReleaseArtifact;
  readonly liveDataRoot: string;
};
export type ReleaseActivationReceipt = {
  /** The immutable release path or name the service now starts through. */
  readonly pointer: string;
  /** Anything the port removed. A promotion never deletes the previous artifact, so this is empty. */
  readonly removed?: readonly string[];
  readonly activatedAt?: string;
};
/**
 * The promotion port: it points the running service at one candidate's artifact. It is the only
 * place a promotion touches anything outside this store, it is not wired into the application, and
 * the unit suite drives a synthetic one so no container is ever started by a test.
 */
export interface ReleasePromotionPort {
  activate(request: ReleaseActivationRequest): Promise<ReleaseActivationReceipt>;
}
/**
 * The minimal identity of the release a promote or rollback points at. The full candidate is not
 * needed here: this is every field the activation request and the reconciliation use.
 */
type ActivationTarget = {
  readonly candidateId: string;
  readonly releaseId: string;
  readonly schemaId: string;
  readonly artifact: ReleaseArtifact;
};
/**
 * The observation a store makes between its stale-revision check and its activation. The store cannot
 * itself prove that the target can start against the live data root, so a caller may inject that
 * proof here; **no pointer moves until it passes**, which is what makes every caller — not just the
 * operator CLI — refuse before the pointer is switched. A refusal names what is wrong and may carry a
 * release error code.
 */
export type ActivationPreflight =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly code?: ReleaseErrorCode };

export type ReleaseStoreOptions = {
  /** The storage schemas this build understands. Defaults to the release module's own list. */
  readonly supportedSchemaIds?: readonly string[];
  /** The designated root every preview data root lives inside. Required only to create a preview. */
  readonly previewRoot?: string;
  /** The live data root. Defaults to the directory the control store's own database lives in. */
  readonly liveDataRoot?: string;
  readonly clock?: () => Date;
  readonly observeSchema?: () => StorageSchemaObservation;
  readonly previewPort?: PreviewContainerPort;
  readonly promotionPort?: ReleasePromotionPort;
  /**
   * The injected startability observation. It is awaited between the stale-revision check and the
   * activation, and a refusal stops the promotion or rollback before the pointer is touched.
   */
  readonly canActivate?: () => ActivationPreflight | Promise<ActivationPreflight>;
  /** A source of unique ids. Tests inject a deterministic one. */
  readonly id?: () => string;
};

/** The projection of one control-store row, read-only: the store exposes no enumeration of its own. */
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
    if (error instanceof ReleaseError) throw error;
    throw storage('Stored release operation record is corrupt: ' + (error as Error).message);
  }
}
/** One discard receipt, strictly read: anything else is corruption, not a shorter receipt. */
function readDiscardReceipt(value: unknown): { discardedAt: string; removed: readonly string[]; environmentRemoved: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw storage('The preview discard receipt is not an object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'discardedAt,environmentRemoved,removed')
    throw storage('The preview discard receipt has unexpected fields');
  if (!Array.isArray(record.removed) || record.removed.some((entry) => typeof entry !== 'string'))
    throw storage('The preview discard receipt does not list the paths it removed');
  return {
    discardedAt: requireInstant(record.discardedAt, 'the discard instant', 'CORRUPT'),
    removed: Object.freeze(record.removed as string[]),
    environmentRemoved: record.environmentRemoved === true
  };
}

export class ReleaseStore {
  private readonly vocabulary: ReleaseVocabulary;
  private readonly clock: () => Date;
  private readonly id: () => string;
  private readonly supports: (canonical: string) => string;
  private readonly liveDataRoot: string;
  private readonly observe: () => ObservedSchema;
  private readonly previewRoot: string | null;
  private readonly previewPort: PreviewContainerPort | null;
  private readonly promotionPort: ReleasePromotionPort | null;
  private readonly canActivate: (() => ActivationPreflight | Promise<ActivationPreflight>) | null;
  constructor(private readonly store: ControlStore, options: ReleaseStoreOptions = {}) {
    this.vocabulary = { supportedSchemaIds: options.supportedSchemaIds ?? SUPPORTED_SCHEMA_IDS };
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? (() => randomUUID());
    this.supports = (canonical) => 'sha256:' + createHash('sha256').update(canonical).digest('hex');
    this.liveDataRoot = options.liveDataRoot ?? dirname(store.file);
    this.previewRoot = options.previewRoot ?? null;
    this.previewPort = options.previewPort ?? null;
    this.promotionPort = options.promotionPort ?? null;
    this.canActivate = options.canActivate ?? null;
    const observe = options.observeSchema ?? (() => observeStorageSchema(this.liveDataRoot));
    this.observe = () => {
      try {
        const observation = observe();
        return observation.state === 'present' ? { state: 'present', version: observation.version } : { state: observation.state };
      } catch { return { state: 'malformed' }; }
    };
  }

  /* ------------------------------------------------------------------------------------------- *
   * Candidates
   * ------------------------------------------------------------------------------------------- */

  /** Record one candidate. The same id with identical content reads back the stored record. */
  createCandidate(request: unknown): ReleaseCandidate {
    const parsed = parseReleaseCandidateRequest(request, this.vocabulary);
    const candidate: ReleaseCandidate = Object.freeze({
      version: RELEASE_CANDIDATE_VERSION, ...parsed, fingerprint: this.supports(recordCanonical({ version: RELEASE_CANDIDATE_VERSION, ...parsed }))
    }) as ReleaseCandidate;
    let admitted: { operation: OperationRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: BUCKET,
        idempotencyKey: 'release.candidate.' + candidate.candidateId,
        kind: CANDIDATE_KIND,
        input: candidate,
        outbox: { kind: CANDIDATE_OUTBOX, payload: { version: RELEASE_CANDIDATE_VERSION, candidateId: candidate.candidateId, releaseId: candidate.releaseId, fingerprint: candidate.fingerprint } }
      });
    } catch (error) {
      throw this.writeRefusal('record release candidate ' + candidate.candidateId, error,
        'a release candidate is immutable: it is never modified or replaced, and a changed build needs a new candidate id.');
    }
    const stored = this.candidateFromOperation(admitted.operation);
    if (!admitted.existing) return stored;
    if (stored.fingerprint !== candidate.fingerprint)
      throw new ReleaseError('the candidate id ' + candidate.candidateId + ' already names a candidate with different content: a release candidate is immutable and is never modified or replaced. Record the changed build under a new candidate id.', 'IMMUTABLE');
    return stored;
  }
  /** Read one candidate. An id that names a preview says so, rather than reading as "not found". */
  candidate(id: unknown): ReleaseCandidate {
    const identity = requireId(id, 'the candidate id');
    const rows = this.select('SELECT * FROM operations WHERE kind=? AND idempotency_key=? LIMIT 2', [CANDIDATE_KIND, 'release.candidate.' + identity]);
    if (rows.length === 0) {
      if (this.select('SELECT id FROM operations WHERE kind=? AND idempotency_key=? LIMIT 1', [PREVIEW_KIND, 'release.preview.' + identity]).length > 0)
        throw new ReleaseError(identity + ' names a preview, not a release candidate: a preview is disposable and is never promoted. Promote the candidate it was created from instead.', 'NOT_FOUND');
      throw new ReleaseError('no release candidate with id ' + identity + ' is recorded', 'NOT_FOUND');
    }
    if (rows.length > 1) throw storage('Corrupt release storage: duplicate release candidate id ' + identity);
    return this.candidateFromOperation(decodeOperationRow(rows[0] as Record<string, unknown>));
  }
  /** Every recorded candidate, oldest first. */
  candidates(): readonly ReleaseCandidate[] {
    const candidates = this.select('SELECT * FROM operations WHERE kind=? ORDER BY rowid LIMIT ?', [CANDIDATE_KIND, MAX_RECORDS])
      .map((row) => this.candidateFromOperation(decodeOperationRow(row)));
    return Object.freeze(candidates);
  }

  /* ------------------------------------------------------------------------------------------- *
   * Disposable previews
   * ------------------------------------------------------------------------------------------- */

  /**
   * Reserve a preview, then create it. The reservation is admitted before the port is asked for
   * anything, so a container is never created without a durable record; the placement is validated
   * before it is recorded, so a preview whose isolation cannot be established is refused rather than
   * degraded, and only what the port reports inside the preview's own data root is ever recorded.
   */
  async createPreview(request: unknown): Promise<ReleasePreview> {
    const parsed: ReleasePreviewRequest = parseReleasePreviewRequest(request);
    const previewRoot = this.requirePreviewRoot();
    const port = this.previewPort ?? (() => { throw new ReleaseError('no preview container port is configured, so no preview container can be created and none was created', 'UNAVAILABLE'); })();
    const candidate = this.candidate(parsed.candidateId);
    const existing = this.select('SELECT id FROM operations WHERE kind=? AND idempotency_key=? LIMIT 1', [PREVIEW_KIND, 'release.preview.' + parsed.previewId]).length > 0;
    const remaining = this.previews().filter((preview) => preview.state !== 'discarded');
    if (!existing && remaining.length >= RELEASE_MAX_PREVIEWS)
      throw new ReleaseError('this store already holds ' + remaining.length + ' previews, which is the documented maximum of ' + RELEASE_MAX_PREVIEWS + '; discard one before creating another. Nothing was created.', 'BOUNDED');
    const requestedAt = instantOf(this.clock());
    const reservationFields = {
      version: RELEASE_PREVIEW_VERSION, previewId: parsed.previewId, candidateId: candidate.candidateId,
      releaseId: candidate.releaseId, schemaId: candidate.schemaId, artifact: candidate.artifact,
      lifetimeMs: parsed.lifetimeMs, limits: parsed.limits, requestedAt
    };
    const reservation = Object.freeze({ ...reservationFields, fingerprint: this.supports(recordCanonical(reservationFields)) }) as ReleasePreviewReservation;
    let admitted: { operation: OperationRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: BUCKET,
        idempotencyKey: 'release.preview.' + reservation.previewId,
        kind: PREVIEW_KIND,
        input: reservation,
        outbox: { kind: PREVIEW_OUTBOX, payload: { version: RELEASE_PREVIEW_VERSION, previewId: reservation.previewId, candidateId: reservation.candidateId } }
      });
    } catch (error) {
      throw this.writeRefusal('reserve preview ' + reservation.previewId, error,
        'a preview id names one preview for its whole life; create it under a new id.');
    }
    if (admitted.existing) {
      const stored = this.previewView(admitted.operation);
      if (stored.disposable !== true) throw storage('Stored preview records are not marked disposable');
      const storedReservation = this.storedReservation(admitted.operation);
      if (storedReservation.fingerprint !== reservation.fingerprint)
        throw new ReleaseError('the preview id ' + reservation.previewId + ' already names a preview with different content: a preview id is never reused. Discard it and create the preview under a new id.', 'CONFLICT');
      return stored;
    }
    const established = await this.establishPreview(admitted.operation, reservation, candidate, previewRoot, port);
    return established;
  }
  /** Read one preview, exactly as its durable records describe it now. */
  preview(id: unknown): ReleasePreview {
    const identity = requireId(id, 'the preview id');
    const rows = this.select('SELECT * FROM operations WHERE kind=? AND idempotency_key=? LIMIT 2', [PREVIEW_KIND, 'release.preview.' + identity]);
    if (rows.length === 0) throw new ReleaseError('no preview with id ' + identity + ' is recorded', 'NOT_FOUND');
    if (rows.length > 1) throw storage('Corrupt release storage: duplicate preview id ' + identity);
    return this.previewView(decodeOperationRow(rows[0] as Record<string, unknown>));
  }
  /** Every recorded preview, newest request instant last. */
  previews(): readonly ReleasePreview[] {
    const previews = this.previewRows().map((entry) => this.previewView(entry.operation, entry.placement));
    return Object.freeze(previews);
  }
  /**
   * Discard a preview. The port removes what the preview created and reports it; the report is
   * checked against the preview's own data root and the reservation moves to 'succeeded' in the
   * store's own revision-checked transaction. An already discarded preview reads back unchanged.
   */
  async discardPreview(input: { previewId: unknown; revision?: unknown }): Promise<ReleasePreview> {
    const identity = requireId(input?.previewId, 'the preview id');
    const rows = this.select('SELECT * FROM operations WHERE kind=? AND idempotency_key=? LIMIT 2', [PREVIEW_KIND, 'release.preview.' + identity]);
    if (rows.length === 0) throw new ReleaseError('no preview with id ' + identity + ' is recorded', 'NOT_FOUND');
    if (rows.length > 1) throw storage('Corrupt release storage: duplicate preview id ' + identity);
    const operation = decodeOperationRow(rows[0] as Record<string, unknown>);
    const before = this.previewView(operation);
    if (before.state === 'discarded') return before;
    if (input?.revision !== undefined) {
      const expected = requireRevision(input.revision, 'the preview revision');
      if (expected !== operation.revision)
        throw new ReleaseError('the discard is stale: the caller read revision ' + expected + ' but the preview is at revision ' + operation.revision + '. Re-read the preview and discard again; nothing was removed by this call.', 'CONFLICT');
    }
    const port = this.previewPort;
    let report: PreviewRemovalReport;
    if (port === null) {
      // A reservation that was never established has no container this store can remove, and this
      // build never removes something it did not create: the record is closed with an empty report.
      report = Object.freeze({ removed: Object.freeze([]), environmentRemoved: false });
    } else {
      let raw: unknown;
      try { raw = await port.discard({ preview: before }); }
      catch (error) {
        throw new ReleaseError('the preview container could not be discarded, so nothing was recorded and the preview is still listed: ' + (error as Error).message, 'UNAVAILABLE');
      }
      if (before.placement === null) {
        const shape = raw as { removed?: unknown } | null;
        if (shape !== null && typeof shape === 'object' && Array.isArray(shape.removed) && shape.removed.length > 0)
          throw new ReleaseError('the discard reports removing paths for a preview whose placement was never recorded: this build removes only what the preview created and it cannot prove those paths were, so nothing was recorded as discarded.', 'CONTAINMENT');
        report = Object.freeze({ removed: Object.freeze([]), environmentRemoved: (raw as { environmentRemoved?: unknown })?.environmentRemoved === true });
      } else {
        report = validatePreviewRemoval(raw, before.placement.dataRoot);
      }
    }
    const receipt = Object.freeze({
      discardedAt: instantOf(this.clock()),
      removed: report.removed,
      environmentRemoved: report.environmentRemoved
    });
    let updated: OperationRecord;
    try {
      updated = this.store.updateOperation(operation.id, BUCKET, operation.revision, 'succeeded', receipt);
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new ReleaseError('the preview changed while it was being discarded (another actor discarded it first): nothing was recorded here, and the container may already be gone. Re-read the preview. (' + error.message + ')', 'CONFLICT');
      throw storage('The durable store refused to record the preview discard: ' + (error as Error).message);
    }
    return this.previewView(updated);
  }

  /* ------------------------------------------------------------------------------------------- *
   * Promotion and compatible rollback
   * ------------------------------------------------------------------------------------------- */

  /**
   * The promotion facts alone, read from the durable chain and nothing else. The running service uses
   * this: a readiness or release report must not open a second connection beside the live store handle
   * (the readiness path deliberately reports the schema from that handle), and it must not wait on a
   * writer's lock to answer.
   */
  promotionStatus(): ReleasePromotionStatus {
    const chain = this.chain();
    const promotion = chain.events.length > 0 ? chain.events[chain.events.length - 1] as ReleaseEvent : null;
    return Object.freeze({
      revision: chain.revision,
      promotion,
      target: promotion === null ? null : targetOf(promotion),
      rollbackTarget: promotion === null ? null : promotion.previousRelease
    });
  }
  /** The promotion facts plus what a rollback would do now: this one observes the storage schema. */
  status(): ReleaseStatus {
    const base = this.promotionStatus();
    const compatibility = base.rollbackTarget === null ? null : rollbackCompatibility({ target: base.rollbackTarget, observed: this.observe(), schemaVersionFor: schemaVersionForId });
    return Object.freeze({ revision: base.revision, promotion: base.promotion, target: base.target, rollbackTarget: base.rollbackTarget, compatibility });
  }
  /** The whole promotion history, oldest first. The chain is validated before any of it is returned. */
  promotions(): readonly ReleaseEvent[] {
    return Object.freeze(this.chain().events);
  }
  /** Whether the identity a running build was given is the identity the store says is promoted. */
  matchRelease(identity: ReleaseIdentityInput): ReleaseMatch {
    return matchReleaseIdentity(identity, this.promotionStatus().target);
  }
  /**
   * Point the service at one candidate. It records the candidate promoted, the release that was
   * previously active (the rollback target), the instant and the actor, at the next revision; a
   * caller whose revision is not the current one is refused before anything is activated, and the
   * key of the new revision is the compare-and-swap the store performs inside its own transaction.
   */
  async promote(input: { candidateId: unknown; expectedRevision: unknown; actor: unknown }): Promise<ReleaseEvent> {
    const candidateId = requireId(input?.candidateId, 'the promoted candidate id');
    const expectedRevision = requireRevision(input?.expectedRevision, 'the expected promotion revision');
    const actor = requireId(input?.actor, 'the promoting actor');
    const candidate = this.candidate(candidateId);
    const chain = this.chain();
    if (expectedRevision !== chain.revision)
      throw new ReleaseError('the promotion is stale: the caller read revision ' + expectedRevision + ' but the promotion history is at revision ' + chain.revision + '. Re-read the status and promote again; nothing was promoted and no service was pointed anywhere.', 'CONFLICT');
    const current = chain.events.length > 0 ? chain.events[chain.events.length - 1] as ReleaseEvent : null;
    if (current !== null && current.candidateId === candidateId)
      throw new ReleaseError('candidate ' + candidateId + ' is already the promoted release at revision ' + chain.revision + ', so this promotion would record nothing new and was refused. Nothing was promoted.', 'CONFLICT');
    const previousRelease = current === null ? null : targetOf(current);
    await this.requireStartable();
    const port = this.requirePromotionPort();
    const activation = await this.activate('promote', candidate, port);
    const fields = {
      version: RELEASE_EVENT_VERSION, eventId: this.id(), action: 'promote' as const, revision: chain.revision + 1,
      basedOnRevision: expectedRevision, candidateId: candidate.candidateId, releaseId: candidate.releaseId,
      schemaId: candidate.schemaId, sourceDigest: candidate.sourceDigest, artifact: candidate.artifact,
      previousRelease, actor, createdAt: instantOf(this.clock()), pointer: activation.pointer
    };
    return this.recordActivation(fields, port, 'The promotion port may already have pointed the service at ' + candidate.releaseId + '.');
  }
  /**
   * Return to the recorded previous release. It is refused unless the target release can read the
   * data schema actually on disk: a newer on-disk schema is refused with the encrypted backup
   * restore path rather than starting a service that would misread the data.
   */
  async rollback(input: { expectedRevision: unknown; actor: unknown }): Promise<ReleaseEvent> {
    const expectedRevision = requireRevision(input?.expectedRevision, 'the expected promotion revision');
    const actor = requireId(input?.actor, 'the rolling back actor');
    const chain = this.chain();
    if (expectedRevision !== chain.revision)
      throw new ReleaseError('the rollback is stale: the caller read revision ' + expectedRevision + ' but the promotion history is at revision ' + chain.revision + '. Re-read the status and roll back again; nothing was promoted and no service was pointed anywhere.', 'CONFLICT');
    const current = chain.events.length > 0 ? chain.events[chain.events.length - 1] as ReleaseEvent : null;
    if (current === null)
      throw new ReleaseError('nothing is promoted, so there is no recorded previous release to roll back to. Promote a candidate before rolling back.', 'NOT_FOUND');
    const target = current.previousRelease;
    if (target === null)
      throw new ReleaseError('the promotion at revision ' + chain.revision + ' is the first one and records no previous release, so there is nothing to roll back to. Nothing was promoted.', 'NOT_FOUND');
    const candidate = this.rollbackCandidate(target);
    const compatibility = rollbackCompatibility({ target, observed: this.observe(), schemaVersionFor: schemaVersionForId });
    if (!compatibility.compatible) throw new ReleaseError(compatibility.reason, 'INCOMPATIBLE');
    await this.requireStartable();
    const port = this.requirePromotionPort();
    const activation = await this.activate('rollback', candidate, port);
    const fields = {
      version: RELEASE_EVENT_VERSION, eventId: this.id(), action: 'rollback' as const, revision: chain.revision + 1,
      basedOnRevision: expectedRevision, candidateId: candidate.candidateId, releaseId: candidate.releaseId,
      schemaId: candidate.schemaId, sourceDigest: candidate.sourceDigest, artifact: candidate.artifact,
      previousRelease: targetOf(current), actor, createdAt: instantOf(this.clock()), pointer: activation.pointer
    };
    return this.recordActivation(fields, port, 'The promotion port may already have pointed the service at ' + candidate.releaseId + '.');
  }

  /* ------------------------------------------------------------------------------------------- *
   * Internals
   * ------------------------------------------------------------------------------------------- */

  private candidateFromOperation(operation: OperationRecord): ReleaseCandidate {
    const candidate = parseReleaseCandidateRecord(operation.input, this.vocabulary);
    assertFingerprint(candidate, this.supports, 'release candidate');
    if (operation.state !== 'pending')
      throw storage('A stored release candidate carries a lifecycle state, so the record is corrupt: a candidate is immutable and never transitions');
    return candidate;
  }
  private eventFromOperation(operation: OperationRecord): ReleaseEvent {
    const event = parseReleaseEvent(operation.input);
    assertFingerprint(event, this.supports, 'release event');
    if (operation.state !== 'pending')
      throw storage('A stored release event carries a lifecycle state, so the promotion history is corrupt');
    return event;
  }
  private chain(): { events: ReleaseEvent[]; revision: number } {
    // One row past the cap: a longer history is refused rather than silently reported as truncated.
    const rows = this.select('SELECT * FROM operations WHERE kind=? ORDER BY rowid LIMIT ?', [EVENT_KIND, MAX_RECORDS + 1]);
    if (rows.length > MAX_RECORDS)
      throw storage('The promotion history holds more than ' + MAX_RECORDS + ' recorded events, which is more than this build reads in one pass, so it cannot be reported in full and is refused rather than silently truncated. Archive older promotions before promoting or rolling back again.');
    const events = rows.map((row) => this.eventFromOperation(decodeOperationRow(row)));
    events.forEach((event, index) => {
      if (event.revision !== index + 1)
        throw storage('The promotion history is corrupt: a recorded event does not sit at the revision it claims');
      if (event.basedOnRevision !== index)
        throw storage('The promotion history is corrupt: a recorded event was not based on the revision before it');
      if (index === 0) {
        if (event.previousRelease !== null) throw storage('The promotion history is corrupt: the first promotion records a previous release');
        return;
      }
      const before = events[index - 1] as ReleaseEvent;
      if (!sameTarget(event.previousRelease, targetOf(before)))
        throw storage('The promotion history is corrupt: a recorded event does not name the release that was active before it');
      // A rollback returns to the release that was recorded before the one it leaves, which is
      // exactly the previous event's own previous release. Anything else is a corrupt history.
      const rollbackTarget = before.previousRelease;
      if (event.action === 'rollback' && (rollbackTarget === null || event.candidateId !== rollbackTarget.candidateId))
        throw storage('The promotion history is corrupt: a rollback does not return to the recorded previous release');
    });
    return { events, revision: events.length };
  }
  private recordEvent(fields: Omit<ReleaseEvent, 'fingerprint'>, activationNote: string): ReleaseEvent {
    const event = Object.freeze({ ...fields, fingerprint: this.supports(recordCanonical(fields)) }) as ReleaseEvent;
    // The key of the new revision is the compare-and-swap: the store's own transaction refuses a
    // second writer that read the same revision, so a stale promotion can never silently win.
    let admitted: { operation: OperationRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: BUCKET,
        idempotencyKey: 'release.promotion.' + event.revision,
        kind: EVENT_KIND,
        input: event,
        outbox: { kind: EVENT_OUTBOX, payload: { version: RELEASE_EVENT_VERSION, revision: event.revision, action: event.action, candidateId: event.candidateId } }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new ReleaseError('another actor recorded the promotion at revision ' + event.revision + ' first, so this one was refused. ' + activationNote + ' Re-read the status and promote again.', 'CONFLICT');
      throw this.writeRefusal('record the promotion at revision ' + event.revision, error, 'the promotion history is append-only and unchanged.');
    }
    if (!admitted.existing) return event;
    const stored = this.eventFromOperation(admitted.operation);
    if (stored.fingerprint !== event.fingerprint)
      throw new ReleaseError('another actor recorded a different promotion at revision ' + event.revision + ', so this one was refused. ' + activationNote + ' Re-read the status and promote again.', 'CONFLICT');
    return stored;
  }
  /** The port this store may promote through. The application does not wire one: promotion is an operator step. */
  private requirePromotionPort(): ReleasePromotionPort {
    if (this.promotionPort === null)
      throw new ReleaseError('no promotion port is configured, so this store cannot point a service at a candidate and nothing was promoted', 'UNAVAILABLE');
    return this.promotionPort;
  }
  private async activate(action: 'promote' | 'rollback', target: ActivationTarget, port: ReleasePromotionPort): Promise<ReleaseActivationReceipt> {
    let raw: unknown;
    try {
      raw = await port.activate({
        action, candidateId: target.candidateId, releaseId: target.releaseId,
        schemaId: target.schemaId, artifact: target.artifact, liveDataRoot: this.liveDataRoot
      });
    } catch (error) {
      throw new ReleaseError('the ' + action + ' port could not point the service at release ' + target.releaseId + ', so nothing was recorded and no release changed: ' + (error as Error).message, 'UNAVAILABLE');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw storage('The ' + action + ' port reported nothing usable, so nothing was recorded');
    const receipt = raw as Record<string, unknown>;
    if (Object.keys(receipt).some((key) => !['pointer', 'removed', 'activatedAt'].includes(key)))
      throw storage('The ' + action + ' port reported unexpected fields, so nothing was recorded');
    const pointer = receipt.pointer;
    if (typeof pointer !== 'string' || pointer.length === 0 || pointer.length > 300 || /[\u0000\n\r]/.test(pointer))
      throw storage('The ' + action + ' port did not report the immutable release pointer it activated, so nothing was recorded');
    const removed = receipt.removed;
    if (removed !== undefined && (!Array.isArray(removed) || removed.some((entry) => typeof entry !== 'string')))
      throw storage('The ' + action + ' port reported an unusable removal list, so nothing was recorded');
    if (Array.isArray(removed) && removed.length > 0)
      throw new ReleaseError('the ' + action + ' reported removing ' + removed.length + ' artifact path(s): a promotion and a rollback never delete the previous artifact, so this was refused and nothing was recorded.', 'CONTAINMENT');
    if (receipt.activatedAt !== undefined) requireInstant(receipt.activatedAt, 'the ' + action + ' instant');
    return Object.freeze({ pointer, removed: Object.freeze([]) as readonly string[] });
  }
  /**
   * The injected startability observation, awaited between the stale-revision check and the
   * activation. A refusal throws here, while the pointer is still untouched; an observation that
   * cannot answer at all is refused the same way rather than assumed to pass.
   */
  private async requireStartable(): Promise<void> {
    if (this.canActivate === null) return;
    let observed: ActivationPreflight;
    try { observed = await this.canActivate(); }
    catch (error) {
      throw new ReleaseError('the startability observation of the promotion target failed, so nothing was promoted and no pointer moved: ' + (error as Error).message, 'UNAVAILABLE');
    }
    if (observed === null || typeof observed !== 'object' || typeof (observed as { ok?: unknown }).ok !== 'boolean')
      throw storage('The startability observation of the promotion target reported nothing usable, so nothing was promoted and no pointer moved');
    if (!observed.ok) throw new ReleaseError(observed.reason, observed.code ?? 'UNAVAILABLE');
  }
  /**
   * Record the promotion, and if the revision was lost to another actor, make the pointer agree with
   * the recorded promotion before reporting the conflict. The pointer was already swapped by this
   * actor's activation, so re-pointing the service at the winner's recorded release is what keeps the
   * pointer and the record from disagreeing: the tool never restarts the service, so this happens
   * before any start on a release nobody recorded.
   */
  private async recordActivation(fields: Omit<ReleaseEvent, 'fingerprint'>, port: ReleasePromotionPort, note: string): Promise<ReleaseEvent> {
    try {
      return this.recordEvent(fields, note);
    } catch (error) {
      if (!(error instanceof ReleaseError) || error.code !== 'CONFLICT') throw error;
      const winner = this.promotionStatus().promotion;
      if (winner === null)
        throw new ReleaseError('the promotion pointer and the recorded promotion cannot be reconciled: this promotion lost the revision to another actor, but no promotion is recorded to point the service at. ' + note, 'STORAGE');
      try {
        await this.activate(winner.action, { candidateId: winner.candidateId, releaseId: winner.releaseId, schemaId: winner.schemaId, artifact: winner.artifact }, port);
      } catch (reconcileError) {
        throw new ReleaseError('the promotion pointer and the recorded promotion disagreed and could not be reconciled by re-pointing the service at the recorded release: ' + (reconcileError as Error).message + ' The pointer may still point at the candidate this actor activated. Do not restart the service: re-read the status and promote again deliberately. ' + note, 'STORAGE');
      }
      throw error;
    }
  }
  private rollbackCandidate(target: ReleaseTarget): ReleaseCandidate {
    let candidate: ReleaseCandidate;
    try { candidate = this.candidate(target.candidateId); }
    catch (error) {
      if (error instanceof ReleaseError && error.code === 'NOT_FOUND')
        throw new ReleaseError('the rollback target ' + target.releaseId + ' names candidate ' + target.candidateId + ', which is no longer recorded, so the target cannot be verified and nothing was promoted', 'CORRUPT');
      throw error;
    }
    if (candidate.releaseId !== target.releaseId || candidate.schemaId !== target.schemaId ||
      candidate.sourceDigest !== target.sourceDigest || candidate.artifact.reference !== target.artifact.reference)
      throw storage('The rollback target does not match the immutable candidate it names, so the promotion history is corrupt and nothing was promoted');
    return candidate;
  }
  private requirePreviewRoot(): string {
    if (this.previewRoot === null || this.previewRoot === '')
      throw new ReleaseError('no designated preview root is configured, so this build cannot prove a preview would be unable to reach the live data root and no preview was created', 'ISOLATION');
    return this.previewRoot;
  }
  private async establishPreview(operation: OperationRecord, reservation: ReleasePreviewReservation, candidate: ReleaseCandidate, previewRoot: string, port: PreviewContainerPort): Promise<ReleasePreview> {
    let rawPlacement: unknown;
    try {
      rawPlacement = await port.establish({
        previewId: reservation.previewId,
        candidateId: candidate.candidateId,
        releaseId: candidate.releaseId,
        schemaId: candidate.schemaId,
        artifact: candidate.artifact,
        lifetimeMs: reservation.lifetimeMs,
        limits: reservation.limits,
        previewRoot,
        liveDataRoot: this.liveDataRoot
      });
    } catch (error) {
      throw new ReleaseError('the preview container could not be established, so no preview was created: ' + (error as Error).message + ' The reservation stays recorded and is listed as creating; discard it once you know nothing was created.', 'UNAVAILABLE');
    }
    // Every isolation property is checked here. A placement that cannot establish one is refused and
    // only the reservation remains, so a degraded preview can never be recorded as an active one.
    const placement = validatePreviewPlacement(rawPlacement, {
      previewRoot,
      liveDataRoot: this.liveDataRoot,
      requestedLifetimeMs: reservation.lifetimeMs,
      requestedLimits: reservation.limits
    });
    const createdAt = instantOf(this.clock());
    const expiresAt = new Date(Date.parse(createdAt) + placement.lifetimeMs).toISOString();
    let admitted: { operation: OperationRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: BUCKET,
        idempotencyKey: 'release.preview-placement.' + reservation.previewId,
        kind: PLACEMENT_KIND,
        input: { version: RELEASE_PREVIEW_VERSION, previewId: reservation.previewId, placement, createdAt, expiresAt },
        outbox: { kind: PLACEMENT_OUTBOX, payload: { version: RELEASE_PREVIEW_VERSION, previewId: reservation.previewId, environment: placement.environment } }
      });
    } catch (error) {
      throw new ReleaseError('the preview container was established but its placement could not be recorded, so nothing is reported as an active preview: ' + (error as Error).message + ' Discard the reservation once you know what the container is.', 'STORAGE');
    }
    // The reservation is read back as the preview's identity; the placement facts are its second record.
    const reservationRows = this.select('SELECT * FROM operations WHERE kind=? AND idempotency_key=? LIMIT 1', [PREVIEW_KIND, 'release.preview.' + reservation.previewId]);
    if (reservationRows.length !== 1)
      throw storage('The preview reservation could not be read back after its container was established, so nothing is reported as an active preview; discard the reservation once you know what the container is');
    return this.previewView(decodeOperationRow(reservationRows[0] as Record<string, unknown>), admitted.operation.input as Record<string, unknown>);
  }
  private previewRows(): { operation: OperationRecord; placement: Record<string, unknown> | null }[] {
    const placements = new Map<string, Record<string, unknown>>();
    for (const row of this.select('SELECT * FROM operations WHERE kind=? ORDER BY rowid LIMIT ?', [PLACEMENT_KIND, MAX_PREVIEWS_READ])) {
      const payload = decodeOperationRow(row).input as { previewId?: unknown } | null;
      if (typeof payload !== 'object' || payload === null || typeof payload.previewId !== 'string')
        throw storage('A stored preview placement does not name the preview it belongs to, so the record is corrupt');
      placements.set('release.preview.' + payload.previewId, payload as Record<string, unknown>);
    }
    return this.select('SELECT * FROM operations WHERE kind=? ORDER BY rowid LIMIT ?', [PREVIEW_KIND, MAX_PREVIEWS_READ]).map((row) => {
      const operation = decodeOperationRow(row);
      return { operation, placement: placements.get(operation.idempotencyKey) ?? null };
    });
  }
  private storedReservation(operation: OperationRecord) {
    if (operation.kind !== PREVIEW_KIND) throw storage('A stored preview record is not a preview reservation');
    const payload = operation.input as { fingerprint?: unknown } | null;
    if (typeof payload !== 'object' || payload === null) throw storage('A stored preview reservation is not an object');
    if (typeof payload.fingerprint !== 'string') throw storage('A stored preview reservation carries no content fingerprint');
    return { fingerprint: payload.fingerprint };
  }
  private previewView(operation: OperationRecord, placementPayload?: Record<string, unknown> | null): ReleasePreview {
    if (operation.kind !== PREVIEW_KIND) throw storage('A preview was read from a record that is not a preview reservation');
    const reservation = parseReleasePreviewReservation(operation.input);
    assertFingerprint(reservation, this.supports, 'preview reservation');
    let payload: Record<string, unknown> | null = null;
    if (placementPayload !== undefined) {
      payload = placementPayload;
    } else {
      const row = this.select('SELECT * FROM operations WHERE kind=? AND idempotency_key=? LIMIT 1', [PLACEMENT_KIND, 'release.preview-placement.' + reservation.previewId])[0] ?? null;
      if (row !== null) payload = decodeOperationRow(row).input as Record<string, unknown>;
    }
    let placement: ReleasePreviewPlacement | null = null;
    let createdAt: string | null = null;
    let expiresAt: string | null = null;
    if (payload !== null) {
      if (typeof payload !== 'object' || payload.previewId !== reservation.previewId || payload.version !== RELEASE_PREVIEW_VERSION)
        throw storage('A stored preview placement does not match the preview it belongs to, so the record is corrupt');
      // The isolation rules were enforced before these facts were recorded, and the record is
      // immutable: a read re-validates their shape, not the world they described.
      placement = parseReleasePreviewPlacement(payload.placement);
      createdAt = requireInstant(payload.createdAt, 'the preview creation instant', 'CORRUPT');
      expiresAt = requireInstant(payload.expiresAt, 'the preview expiry', 'CORRUPT');
      if (Date.parse(expiresAt) - Date.parse(createdAt) !== placement.lifetimeMs)
        throw storage('A stored preview carries an expiry that does not match its own lifetime, so the record is corrupt');
    }
    let discardedAt: string | null = null;
    let removed: readonly string[] = Object.freeze([]);
    let state: ReleasePreview['state'];
    if (operation.state === 'succeeded') {
      const receipt = readDiscardReceipt(operation.receipt);
      discardedAt = receipt.discardedAt;
      removed = receipt.removed;
      state = 'discarded';
    } else if (operation.state !== 'pending') {
      throw storage('A stored preview reservation ended in a state this build does not write, so the record is corrupt');
    } else if (placement === null) {
      state = 'creating';
    } else {
      state = Date.parse(instantOf(this.clock())) >= Date.parse(expiresAt as string) ? 'expired' : 'active';
    }
    return Object.freeze({
      version: RELEASE_PREVIEW_VERSION,
      previewId: reservation.previewId,
      candidateId: reservation.candidateId,
      releaseId: reservation.releaseId,
      schemaId: reservation.schemaId,
      artifact: reservation.artifact,
      lifetimeMs: reservation.lifetimeMs,
      limits: reservation.limits,
      requestedAt: reservation.requestedAt,
      state,
      placement,
      createdAt,
      expiresAt,
      disposable: true as const,
      promotable: false as const,
      discardedAt,
      removed,
      revision: operation.revision
    }) as ReleasePreview;
  }
  private writeRefusal(action: string, error: unknown, hint: string): ReleaseError {
    if (error instanceof ReleaseError) return error;
    if (error instanceof ControlStoreError && error.code === 'CONFLICT')
      return new ReleaseError('the durable store refused to ' + action + ' because that key already holds different content: ' + hint, 'CONFLICT');
    return storage('The durable store refused to ' + action + ': ' + (error as Error).message);
  }
  /**
   * Read-only SELECTs over the reviewed control schema. The store exposes no enumeration API, so
   * these projections read rows and every record is then validated; nothing here writes.
   */
  private select(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try { return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[]; }
    catch (error) {
      if (error instanceof ReleaseError) throw error;
      throw storage('The durable control store could not be read: ' + (error as Error).message);
    }
  }
}
