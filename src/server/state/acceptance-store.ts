import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CONTROL_RECORD_VERSION, exceedsJsonLimit, validateOperationRecord, validateOutboxRecord, type ControlScope, type OperationRecord, type OutboxRecord } from '../../shared/control-state';
import {
  ACCEPTANCE_MAX_COMMANDS, ACCEPTANCE_MAX_EVIDENCE_ITEMS, ACCEPTANCE_MAX_EVIDENCE_READ, ACCEPTANCE_MAX_INLINE_DIFF_BYTES, ACCEPTANCE_MAX_OUTPUT_BYTES,
  ACCEPTANCE_IDENTITY_PATTERN, ACCEPTANCE_POLICY_ABSENCE, ACCEPTANCE_POLICY_ABSENCE_DETAIL,
  AcceptanceError, acceptanceMarkdown, canonicalEvidenceInput, checkTestEvidence, decideAcceptance, defaultAcceptancePolicy,
  parseAcceptancePolicyUpdate, parseAcceptanceRequest, validateAcceptanceRecord, validateCompletionRecord, validateCompletionRecordRequest, validateStoredAcceptancePolicy,
  type AcceptancePolicy, type AcceptanceRecord, type CompletionRecord, type CompletionRecordRequest
} from '../../shared/acceptance';
import { z } from 'zod';
import { atomicWrite } from '../board-store';
import { ControlStore, ControlStoreError } from './control-store';
import { safePath } from '../paths';

/**
 * The durable half of the acceptance model: the policy, the completion records and the acceptances.
 *
 * It introduces **no** new persistence. Every record is one control-store operation whose input is
 * the frozen record and whose outbox is its lifecycle evidence, exactly as the named sessions, the
 * lifecycle, the approvals and the coding jobs are:
 *
 * - **The policy is one operation per revision**, in a bucket that names no project, so a policy is
 *   a deployment-level setting with a real compare-and-swap: two writers at the same revision race,
 *   and the loser is refused rather than merging. An unwritten policy reads as the documented
 *   default (owner-only, everything asking) and says so (`recorded: false`), never as a stored row.
 * - **A completion record is one operation keyed by its own content digest.** The identity
 *   (`ev-…`) and the idempotency key are derived from the canonical request, so the same evidence
 *   recorded twice is *one* record and a changed revision is a *different* one. There is no update
 *   path: a record is written once and frozen.
 * - **An acceptance is one operation keyed by the evidence it accepts**, which is what makes it
 *   single use: the store's unique index refuses a second acceptance in this process, from another
 *   handle, or after a crash and reopen.
 *
 * The Markdown record is written next to the work, in the project's own tree, and is a rendering of
 * the durable record rather than a second source of truth: the store re-renders it when the same
 * evidence is recorded again, and every read reports whether the file on disk still matches
 * (`current`, `stale`, `missing` or `unreadable`) instead of trusting it.
 *
 * Nothing here performs a commit, push, deploy, spend, provision or publish.
 */

const POLICY_KIND = 'acceptance.policy';
const EVIDENCE_KIND = 'acceptance.evidence';
const ACCEPTANCE_KIND = 'acceptance.acceptance';
const POLICY_OUTBOX = 'acceptance.policy-version';
const EVIDENCE_OUTBOX = 'acceptance.evidence-record';
const ACCEPTANCE_OUTBOX = 'acceptance.decision';
/**
 * The control store scopes operations by project and session, while the policy is a deployment
 * setting and a record's session is optional. The storage bucket is therefore a bucket, never the
 * authority: the policy's own fields are the policy, and a record is always read back by key.
 */
const UNNAMED = 'unscoped';

/** The directory the durable Markdown record is written in, relative to the project's own root. */
export const ACCEPTANCE_RECORD_DIRECTORY = 'docs/acceptance';

/** Whether the Markdown record on disk still matches the durable record it renders. */
export const ACCEPTANCE_MARKDOWN_STATES = ['current', 'stale', 'missing', 'unreadable'] as const;
export type AcceptanceMarkdownState = (typeof ACCEPTANCE_MARKDOWN_STATES)[number];
export type AcceptanceMarkdownReport = { readonly path: string; readonly state: AcceptanceMarkdownState };

export type EvidenceView = {
  readonly readOnly: true;
  readonly record: CompletionRecord;
  readonly markdown: AcceptanceMarkdownReport;
  readonly acceptance: AcceptanceRecord | null;
};
export type ProjectAcceptanceView = {
  readonly readOnly: true;
  readonly projectId: string;
  readonly policy: AcceptancePolicy;
  readonly evidence: readonly EvidenceView[];
  readonly limits: {
    readonly evidence: number;
    readonly commands: number;
    readonly results: number;
    readonly outputBytes: number;
    readonly inlineDiffBytes: number;
  };
  readonly truncated: boolean;
};
/** What recording evidence answers with: the record, and whether its Markdown was written now. */
export type EvidenceResult = { readonly evidence: EvidenceView; readonly written: boolean };
/** What an acceptance answers with: the decision, and the evidence it was bound to. */
export type AcceptanceResult = { readonly acceptance: AcceptanceRecord; readonly evidence: EvidenceView };

export type AcceptanceStoreOptions = {
  clock?: () => Date;
  id?: () => string;
  /**
   * The registered project's own root, or undefined when this instance does not know the project.
   * The Markdown record is written inside it and nowhere else; a project without a resolvable root
   * is refused before anything is recorded, because the durable record must have its Markdown.
   */
  projectRoot: (projectId: string) => string | undefined;
};

/** The stored policy metadata: the revision's own record of when and by whom it was written. */
const policyMetaSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(160).regex(ACCEPTANCE_IDENTITY_PATTERN)
});

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value))
    throw new AcceptanceError(label + ' must be 1-160 characters, starting alphanumeric, from A-Za-z0-9._:-', 'INVALID');
  return value;
}
function storage(message: string): AcceptanceError {
  return new AcceptanceError(message, 'STORAGE');
}
function corrupt(message: string): AcceptanceError {
  return new AcceptanceError(message, 'CORRUPT');
}
/** Rebuilds the operation a reader sees from the durable row, refusing any impossible combination. */
function decodeOperationRow(row: Record<string, unknown>): OperationRecord {
  const parse = (text: unknown, label: string): unknown => {
    if (typeof text !== 'string') throw corrupt('Stored ' + label + ' is not a JSON text value');
    if (exceedsJsonLimit(text)) throw corrupt('Stored ' + label + ' exceeds the control payload limit');
    try { return JSON.parse(text); } catch { throw corrupt('Stored ' + label + ' is not readable JSON'); }
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
    if (error instanceof AcceptanceError) throw error;
    throw corrupt('Stored acceptance operation record is corrupt: ' + (error as Error).message);
  }
}
function decodeOutboxRow(row: Record<string, unknown>): OutboxRecord {
  const parse = (text: unknown, label: string): unknown => {
    if (typeof text !== 'string') throw corrupt('Stored ' + label + ' is not a JSON text value');
    if (exceedsJsonLimit(text)) throw corrupt('Stored ' + label + ' exceeds the control payload limit');
    try { return JSON.parse(text); } catch { throw corrupt('Stored ' + label + ' is not readable JSON'); }
  };
  try {
    return validateOutboxRecord({
      version: CONTROL_RECORD_VERSION,
      id: row.id,
      operationId: row.operation_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      kind: row.kind,
      payload: parse(row.payload_json, 'outbox payload'),
      state: row.state,
      revision: row.revision,
      receipt: row.receipt_json === null || row.receipt_json === undefined ? null : parse(row.receipt_json, 'outbox receipt'),
      receiptPresent: row.receipt_json !== null && row.receipt_json !== undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  } catch (error) {
    if (error instanceof AcceptanceError) throw error;
    throw corrupt('Stored acceptance outbox record is corrupt: ' + (error as Error).message);
  }
}
/** The identity and the key of the record one canonical request produces: both derived, never minted. */
function evidenceIdentity(canonical: string): { readonly digest: string; readonly id: string; readonly key: string } {
  const digest = createHash('sha256').update(canonical).digest('hex');
  return Object.freeze({ digest, id: 'ev-' + digest, key: 'acceptance.evidence.' + digest });
}

export class AcceptanceStore {
  private readonly clock: () => Date;
  private readonly id: () => string;
  constructor(private readonly store: ControlStore, private readonly options: AcceptanceStoreOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? (() => 'ac-' + randomUUID());
  }

  /** The policy in force. An unwritten policy is reported as the documented default, and says so. */
  readPolicy(): AcceptancePolicy {
    const rows = this.select('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid', [UNNAMED, UNNAMED, POLICY_KIND]);
    let latest: { operation: OperationRecord; revision: number } | null = null;
    for (const row of rows) {
      const operation = this.operation(String(row.id), { projectId: UNNAMED, sessionId: UNNAMED });
      const meta = this.policyMeta(operation);
      if (latest !== null && meta.revision === latest.revision) throw corrupt('Corrupt acceptance storage: two policy records share revision ' + meta.revision);
      if (latest === null || meta.revision > latest.revision) latest = { operation, revision: meta.revision };
    }
    if (latest === null)
      return Object.freeze({
        ...defaultAcceptancePolicy(),
        revision: 0,
        recorded: false as const,
        absenceReason: ACCEPTANCE_POLICY_ABSENCE.notRecorded,
        absenceDetail: ACCEPTANCE_POLICY_ABSENCE_DETAIL,
        updatedAt: null,
        updatedBy: null
      }) as AcceptancePolicy;
    let definition;
    try { definition = validateStoredAcceptancePolicy(latest.operation.input); }
    catch (error) { throw corrupt('A stored acceptance policy is corrupt: ' + (error as Error).message); }
    const meta = this.policyMeta(latest.operation);
    return Object.freeze({
      ...definition,
      revision: meta.revision,
      recorded: true as const,
      absenceReason: null,
      absenceDetail: null,
      updatedAt: meta.updatedAt,
      updatedBy: meta.updatedBy
    }) as AcceptancePolicy;
  }

  /**
   * Writes the next policy revision. Only the owner identity may call this, the revision the caller
   * read is the compare-and-swap, and a race is a conflict that changes nothing.
   */
  updatePolicy(input: unknown): AcceptancePolicy {
    const update = parseAcceptancePolicyUpdate(input);
    if (update.actor.kind !== 'owner')
      throw new AcceptanceError('The acceptance policy is changeable only by the owner, and ' + update.actor.kind + ' `' + update.actor.identity + '` is not the owner', 'NOT_PERMITTED');
    const current = this.readPolicy();
    if (current.revision !== update.revision)
      throw new AcceptanceError('The acceptance policy is at revision ' + current.revision + ', not ' + update.revision + '; the update wrote nothing', 'CONFLICT');
    const at = this.now();
    const revision = current.revision + 1;
    const meta = Object.freeze({ version: 1 as const, revision, updatedAt: at, updatedBy: update.actor.identity });
    const key = 'acceptance.policy.r' + revision;
    const found = this.byKey(POLICY_KIND, UNNAMED, key);
    if (found) throw new AcceptanceError('The acceptance policy already holds revision ' + revision + '; the update wrote nothing', 'CONFLICT');
    try {
      this.store.admit({
        scope: { projectId: UNNAMED, sessionId: UNNAMED },
        idempotencyKey: key,
        kind: POLICY_KIND,
        input: update.policy,
        outbox: { kind: POLICY_OUTBOX, payload: meta }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new AcceptanceError('The acceptance policy changed while it was being written (' + error.message + '); the update wrote nothing', 'CONFLICT');
      throw storage('The durable store refused the acceptance policy write: ' + (error as Error).message);
    }
    return this.readPolicy();
  }

  /**
   * Records one completion record and writes its Markdown next to the work.
   *
   * The same evidence recorded again is the same record — its identity and its key are derived from
   * the canonical request — and that call rewrites the Markdown, which is how a file a crash never
   * wrote is repaired. A record is never updated: there is no path that changes one.
   */
  async recordEvidence(input: { projectId: unknown; evidence: unknown }): Promise<EvidenceResult> {
    const projectId = requireIdentifier(input?.projectId, 'projectId');
    const request = validateCompletionRecordRequest(input?.evidence, this.clock());
    const root = this.options.projectRoot(projectId);
    if (root === undefined)
      throw new AcceptanceError('Project ' + projectId + ' could not be resolved to a folder, so the durable Markdown record cannot be written; nothing was recorded', 'NOT_FOUND');
    // The evidence is checked before anything is written: a claim that contradicts its own output,
    // or a result for a command the record does not say was run, records nothing at all.
    const tests = request.tests.map((claim) => checkTestEvidence(claim, request.commands));
    const identity = evidenceIdentity(canonicalEvidenceInput({ projectId, request }));
    const scope = this.bucket(projectId, request.sessionId);
    let record = this.materialize(projectId, request, tests, identity.id);
    const existing = this.byKey(EVIDENCE_KIND, projectId, identity.key);
    if (existing === null) {
      try {
        this.store.admit({
          scope,
          idempotencyKey: identity.key,
          kind: EVIDENCE_KIND,
          input: record,
          outbox: { kind: EVIDENCE_OUTBOX, payload: { version: 1, evidenceId: record.id, revision: record.artifact.revision } }
        });
      } catch (error) {
        if (error instanceof ControlStoreError && error.code === 'CONFLICT') {
          // A concurrent writer recorded the same evidence first. That is the same record, so it is
          // read back rather than refused; anything else is a storage fault.
          const raced = this.byKey(EVIDENCE_KIND, projectId, identity.key);
          if (raced === null) throw storage('The durable store refused the completion record (' + error.message + ') and no record of it can be read back');
          record = this.evidenceRecord(raced);
        } else {
          throw storage('The durable store refused the completion record: ' + (error as Error).message);
        }
      }
    } else {
      record = this.evidenceRecord(existing);
    }
    const acceptance = this.acceptanceFor(projectId, record.id);
    const markdown = await this.writeMarkdown(root, record, acceptance);
    return Object.freeze({ evidence: Object.freeze({ readOnly: true as const, record, markdown, acceptance }), written: markdown.state === 'current' });
  }

  /** One completion record of one project, with the Markdown state of its durable file. */
  async readEvidence(input: { projectId: unknown; evidenceId: unknown }): Promise<EvidenceView> {
    const projectId = requireIdentifier(input?.projectId, 'projectId');
    const evidenceId = requireIdentifier(input?.evidenceId, 'evidenceId');
    const record = this.evidenceRecord(this.requireEvidence(projectId, evidenceId));
    const acceptance = this.acceptanceFor(projectId, record.id);
    const root = this.options.projectRoot(projectId);
    return Object.freeze({
      readOnly: true as const,
      record,
      markdown: await this.markdownState(root, record, acceptance),
      acceptance
    });
  }

  /** The policy in force and every completion record of one project, newest last. */
  async readProject(input: { projectId: unknown }): Promise<ProjectAcceptanceView> {
    const projectId = requireIdentifier(input?.projectId, 'projectId');
    const rows = this.select('SELECT id,session_id FROM operations WHERE project_id=? AND kind=? ORDER BY rowid', [projectId, EVIDENCE_KIND]);
    const truncated = rows.length > ACCEPTANCE_MAX_EVIDENCE_READ;
    const records: CompletionRecord[] = rows.slice(0, ACCEPTANCE_MAX_EVIDENCE_READ).map((row) => {
      const operation = this.operation(String(row.id), { projectId, sessionId: String(row.session_id) });
      return this.evidenceRecord(operation);
    });
    const root = this.options.projectRoot(projectId);
    const evidence: EvidenceView[] = [];
    for (const record of records) {
      const acceptance = this.acceptanceFor(projectId, record.id);
      evidence.push(Object.freeze({ readOnly: true as const, record, markdown: await this.markdownState(root, record, acceptance), acceptance }));
    }
    return Object.freeze({
      readOnly: true as const,
      projectId,
      policy: this.readPolicy(),
      evidence: Object.freeze(evidence),
      limits: Object.freeze({
        evidence: ACCEPTANCE_MAX_EVIDENCE_READ,
        commands: ACCEPTANCE_MAX_COMMANDS,
        results: ACCEPTANCE_MAX_EVIDENCE_ITEMS,
        outputBytes: ACCEPTANCE_MAX_OUTPUT_BYTES,
        inlineDiffBytes: ACCEPTANCE_MAX_INLINE_DIFF_BYTES
      }),
      truncated
    });
  }

  /**
   * Accepts one artifact, exactly once, under the policy in force.
   *
   * In order: the evidence must exist in this project, the artifact identity the request names must
   * be the one the evidence was produced from (a changed artifact is refused rather than accepted by
   * accident), the evidence must not already have been accepted, and the policy must permit the
   * accepting identity. An agent acceptance records the rule that permitted it. The own artifact
   * identity in the request is what future callers are bound to: a new revision needs new evidence.
   */
  async accept(input: { projectId: unknown; request: unknown }): Promise<AcceptanceResult> {
    const projectId = requireIdentifier(input?.projectId, 'projectId');
    const request = parseAcceptanceRequest(input?.request);
    const root = this.options.projectRoot(projectId);
    if (root === undefined)
      throw new AcceptanceError('Project ' + projectId + ' could not be resolved to a folder, so the durable Markdown record cannot be updated; the acceptance wrote nothing', 'NOT_FOUND');
    const operation = this.requireEvidence(projectId, request.evidenceId);
    const record = this.evidenceRecord(operation);
    if (request.artifact.revision !== record.artifact.revision || request.artifact.commit !== record.artifact.commit)
      throw new AcceptanceError(
        'The artifact has changed since this evidence was produced: the evidence records revision ' + record.artifact.revision +
        ' (' + (record.artifact.commit === null ? 'not committed' : 'commit ' + record.artifact.commit) + '), and this request accepts revision ' +
        request.artifact.revision + ' (' + (request.artifact.commit === null ? 'not committed' : 'commit ' + request.artifact.commit) + '); record new evidence first',
        'ARTIFACT_CHANGED'
      );
    const already = this.acceptanceFor(projectId, record.id);
    if (already !== null)
      throw new AcceptanceError(
        'This artifact was already accepted at ' + already.acceptedAt + ' by ' + already.acceptedBy.kind + ' `' + already.acceptedBy.identity +
        '`; an acceptance is single use, and accepting a changed artifact needs new evidence',
        'ALREADY_ACCEPTED'
      );
    const policy = this.readPolicy();
    const decision = decideAcceptance({ actor: request.actor, actionClass: request.actionClass, policy });
    if (!decision.permitted) throw new AcceptanceError(decision.message, 'NOT_PERMITTED');
    const acceptance = validateAcceptanceRecord({
      version: 1,
      id: this.mintId(),
      projectId,
      sessionId: record.sessionId,
      subject: record.subject,
      evidenceId: record.id,
      artifact: record.artifact,
      actionClass: request.actionClass,
      acceptedBy: { kind: request.actor.kind, identity: request.actor.identity, policyRule: decision.policyRule },
      policy: {
        revision: policy.revision,
        recorded: policy.recorded,
        mode: policy.mode,
        classDecision: policy.actionClasses[request.actionClass]
      },
      acceptedAt: this.now(),
      singleUse: true
    });
    const scope = this.bucket(projectId, record.sessionId);
    try {
      this.store.admit({
        scope,
        idempotencyKey: 'acceptance.' + record.id,
        kind: ACCEPTANCE_KIND,
        input: acceptance,
        outbox: { kind: ACCEPTANCE_OUTBOX, payload: { version: 1, evidenceId: record.id, actionClass: request.actionClass } }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT') {
        const raced = this.acceptanceFor(projectId, record.id);
        if (raced !== null)
          throw new AcceptanceError(
            'This artifact was accepted concurrently at ' + raced.acceptedAt + ' by ' + raced.acceptedBy.kind + ' `' + raced.acceptedBy.identity + '`; an acceptance is single use',
            'ALREADY_ACCEPTED'
          );
      }
      throw storage('The durable store refused the acceptance: ' + (error as Error).message);
    }
    // The acceptance is durable and single use from here on. A render that fails after this point
    // must not be reported as a refusal: that would tell the operator the decision failed and then
    // tell them it already exists. The state of the Markdown file on disk is re-derived instead, so
    // the answer reports what is really there (and re-reading the evidence repairs the file).
    let markdown: AcceptanceMarkdownReport;
    try { markdown = await this.writeMarkdown(root, record, acceptance); }
    catch {
      markdown = await this.markdownState(root, record, acceptance);
      console.error('The acceptance of evidence ' + record.id + ' is durable, but its Markdown record could not be written; the answer reports the state of the file on disk, and recording the same evidence again writes it.');
    }
    return Object.freeze({ acceptance, evidence: Object.freeze({ readOnly: true as const, record, markdown, acceptance }) });
  }

  /* -------------------------------------------------------------------------------------------- *
   * Internals.
   * -------------------------------------------------------------------------------------------- */

  private bucket(projectId: string, sessionId: string | null): ControlScope {
    return { projectId, sessionId: sessionId ?? UNNAMED };
  }
  private mintId(): string {
    const value = this.id();
    if (typeof value !== 'string' || !identifierPattern.test(value)) throw storage('The acceptance identity source returned an unusable identity');
    return value;
  }
  private now(): string {
    const at = this.clock().getTime();
    if (!Number.isFinite(at)) throw storage('The acceptance clock is not a valid instant');
    return new Date(at).toISOString();
  }
  /** The record to write for one validated request: the identity is derived, the rest is the request. */
  private materialize(projectId: string, request: CompletionRecordRequest, tests: readonly ReturnType<typeof checkTestEvidence>[], id: string): CompletionRecord {
    return validateCompletionRecord({
      version: 1,
      id,
      projectId,
      sessionId: request.sessionId,
      subject: request.subject,
      artifact: request.artifact,
      commands: request.commands,
      diff: request.diff,
      tests,
      review: request.review,
      producedAt: request.producedAt,
      frozen: true
    });
  }
  /** One operation row as a completion record, refusing anything the store did not write. */
  private evidenceRecord(operation: OperationRecord): CompletionRecord {
    if (operation.kind !== EVIDENCE_KIND) throw corrupt('Acceptance storage holds an unexpected operation kind');
    let record: CompletionRecord;
    try { record = validateCompletionRecord(operation.input); }
    catch (error) { throw corrupt('A stored completion record is corrupt: ' + (error as Error).message); }
    const outbox = this.outboxFor(operation);
    if (outbox.kind !== EVIDENCE_OUTBOX) throw corrupt('Acceptance storage holds an unexpected outbox kind');
    if (outbox.state !== 'pending') throw corrupt('A completion record outbox must stay pending for the life of the record');
    const payload = outbox.payload as { version?: unknown; evidenceId?: unknown; revision?: unknown } | null;
    if (!payload || payload.version !== 1 || payload.evidenceId !== record.id || payload.revision !== record.artifact.revision)
      throw corrupt('The stored completion record outbox payload does not describe its record');
    // The key carries the digest the identity was derived from; a mismatch means the row is not the
    // record this build would have written, so it is refused rather than interpreted.
    const prefix = 'acceptance.evidence.';
    if (!operation.idempotencyKey.startsWith(prefix) || record.id !== 'ev-' + operation.idempotencyKey.slice(prefix.length))
      throw corrupt('The stored completion record identity does not match its own key');
    return record;
  }
  private policyMeta(operation: OperationRecord): { revision: number; updatedAt: string; updatedBy: string } {
    if (operation.kind !== POLICY_KIND) throw corrupt('Acceptance storage holds an unexpected policy operation kind');
    if (operation.state !== 'pending') throw corrupt('An acceptance policy operation must stay pending: a policy is replaced, never transitioned');
    const outbox = this.outboxFor(operation);
    if (outbox.kind !== POLICY_OUTBOX) throw corrupt('Acceptance storage holds an unexpected policy outbox kind');
    let meta;
    try { meta = policyMetaSchema.parse(outbox.payload); }
    catch (error) { throw corrupt('A stored acceptance policy version is corrupt: ' + (error as Error).message); }
    if ('acceptance.policy.r' + meta.revision !== operation.idempotencyKey) throw corrupt('A stored acceptance policy version does not match its own key');
    return meta;
  }
  private acceptanceRecord(operation: OperationRecord): AcceptanceRecord {
    if (operation.kind !== ACCEPTANCE_KIND) throw corrupt('Acceptance storage holds an unexpected operation kind');
    let record: AcceptanceRecord;
    try { record = validateAcceptanceRecord(operation.input); }
    catch (error) { throw corrupt('A stored acceptance is corrupt: ' + (error as Error).message); }
    const outbox = this.outboxFor(operation);
    if (outbox.kind !== ACCEPTANCE_OUTBOX) throw corrupt('Acceptance storage holds an unexpected outbox kind');
    if (outbox.state !== 'pending') throw corrupt('An acceptance outbox must stay pending for the life of the decision');
    const payload = outbox.payload as { version?: unknown; evidenceId?: unknown; actionClass?: unknown } | null;
    if (!payload || payload.version !== 1 || payload.evidenceId !== record.evidenceId || payload.actionClass !== record.actionClass)
      throw corrupt('The stored acceptance outbox payload does not describe its decision');
    return record;
  }
  /** The acceptance of one evidence record, or null. Read by the key the evidence identity produces. */
  private acceptanceFor(projectId: string, evidenceId: string): AcceptanceRecord | null {
    const rows = this.select('SELECT * FROM operations WHERE project_id=? AND kind=? AND idempotency_key=? LIMIT 2', [projectId, ACCEPTANCE_KIND, 'acceptance.' + evidenceId]);
    if (rows.length === 0) return null;
    if (rows.length > 1) throw corrupt('Corrupt acceptance storage: the same evidence holds two acceptances');
    return this.acceptanceRecord(decodeOperationRow(rows[0]));
  }
  /**
   * The one operation row for a key in a bucket, or null. Within a project a key names at most one
   * row: the record identity is derived from a request that already contains the session, so the
   * bucket cannot vary for one key.
   */
  private byKey(kind: string, projectId: string, key: string): OperationRecord | null {
    const rows = this.select('SELECT * FROM operations WHERE project_id=? AND kind=? AND idempotency_key=? LIMIT 2', [projectId, kind, key]);
    if (rows.length === 0) return null;
    if (rows.length > 1) throw corrupt('Corrupt acceptance storage: one key holds two records in project ' + projectId);
    return decodeOperationRow(rows[0]);
  }
  private requireEvidence(projectId: string, evidenceId: string): OperationRecord {
    if (!evidenceId.startsWith('ev-')) throw new AcceptanceError('No completion record with id ' + evidenceId + ' in project ' + projectId, 'NOT_FOUND');
    const rows = this.select('SELECT * FROM operations WHERE project_id=? AND kind=? AND idempotency_key=? LIMIT 2', [projectId, EVIDENCE_KIND, 'acceptance.evidence.' + evidenceId.slice('ev-'.length)]);
    if (rows.length === 0) throw new AcceptanceError('No completion record with id ' + evidenceId + ' in project ' + projectId, 'NOT_FOUND');
    if (rows.length > 1) throw corrupt('Corrupt acceptance storage: two records share the identity ' + evidenceId);
    return decodeOperationRow(rows[0]);
  }
  /** The repository-relative path of one record's Markdown file. Never an absolute path. */
  private markdownPath(record: CompletionRecord): string {
    return ACCEPTANCE_RECORD_DIRECTORY + '/' + record.id + '.md';
  }
  /**
   * Writes the Markdown record and reports the state of the file **as it is read back**, through the
   * same derivation every read uses. This write claims nothing about itself: a write that returned
   * `current` without reading the file back would assert a state the caller never verified, and
   * `written` would be true for a file that is not there.
   */
  private async writeMarkdown(root: string, record: CompletionRecord, acceptance: AcceptanceRecord | null): Promise<AcceptanceMarkdownReport> {
    const path = this.markdownPath(record);
    const rendered = acceptanceMarkdown(record, acceptance);
    let file: string;
    try { file = await safePath(root, path, true); }
    catch (error) { throw storage('The durable Markdown record could not be placed in the project (the path is not contained): ' + (error as Error).message); }
    try { await atomicWrite(file, rendered); }
    catch (error) { throw storage('The durable Markdown record could not be written in the project: ' + (error as Error).message); }
    return this.markdownState(root, record, acceptance);
  }
  /** Whether the Markdown file on disk still renders exactly the durable record. Read only. */
  private async markdownState(root: string | undefined, record: CompletionRecord, acceptance: AcceptanceRecord | null): Promise<AcceptanceMarkdownReport> {
    const path = this.markdownPath(record);
    if (root === undefined) return Object.freeze({ path, state: 'unreadable' as const });
    let file: string;
    try { file = await safePath(root, path); }
    catch { return Object.freeze({ path, state: 'missing' as const }); }
    try {
      const text = await readFile(file, 'utf8');
      return Object.freeze({ path, state: text === acceptanceMarkdown(record, acceptance) ? 'current' as const : 'stale' as const });
    } catch (error) {
      return Object.freeze({ path, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' as const : 'unreadable' as const });
    }
  }
  private operation(id: string, scope: ControlScope): OperationRecord {
    try { return this.store.getOperation(id, scope); }
    catch (error) { throw corrupt('The durable store could not read acceptance operation ' + id + ': ' + (error as Error).message); }
  }
  private outboxFor(operation: OperationRecord): OutboxRecord {
    const rows = this.select('SELECT * FROM outboxes WHERE operation_id=? LIMIT 2', [operation.id]);
    if (rows.length !== 1) throw corrupt('Acceptance storage holds no unambiguous outbox row for one of its operations');
    return decodeOutboxRow(rows[0]);
  }
  /**
   * Read-only SELECTs over the reviewed control schema. The store exposes no enumeration API, so
   * these projections read rows and every record is then validated; nothing here writes.
   */
  private select(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try { return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[]; }
    catch (error) {
      if (error instanceof AcceptanceError) throw error;
      throw storage('The durable control store could not be read: ' + (error as Error).message);
    }
  }
}

