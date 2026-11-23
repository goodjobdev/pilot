import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ControlStore, ControlStoreError, operationDigest } from './control-store';
import { parseAgentActor, parseAgentIdentifier } from '../../shared/agent-registry';
import type { AcceptanceActionClass } from '../../shared/acceptance';
import { parseDestinationPath, parseRelativePath, LocalReleaseError } from '../agents/local-release';

/**
 * The owner-configured destinations of the two local release capabilities, and their durable outcomes.
 *
 * This store is configuration and receipts only: it performs no copy, swap, publish or removal. The
 * destination is set by the authenticated owner through a revision-checked route, and no agent (and
 * therefore no model) can widen, replace or invent one. Each accepted revision is immutable and kept
 * in the shared durable control store, so the target an action was accepted for can be told apart
 * from a later one.
 *
 * The identifiers here are **local directories**, not provider, Cloudflare or CI resources. The
 * syntax checks cannot prove that a configured directory is on a volume the operator intended; the
 * service resolves it again, through `realpath`, at admission and at execution.
 */

const KIND = 'local.destination', OUTBOX = 'local.destination-audit';
const OUTCOME_KIND = 'local.release-outcome', OUTCOME_OUTBOX = 'local.release-outcome-audit';
export const LOCAL_DESTINATION_TARGET_IDS: Readonly<Record<'deploy' | 'publish', string>> = Object.freeze({
  deploy: 'local-deploy',
  publish: 'local-publish'
});
export type LocalReleaseActionClass = Extract<AcceptanceActionClass, 'deploy' | 'publish'>;

const destinationDefinition = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('deploy-local'), artifactPath: z.string(), targetDirectory: z.string() }),
  z.strictObject({ kind: z.literal('publish-local'), publicationRoot: z.string() })
]);
type DestinationDefinition = z.infer<typeof destinationDefinition>;

const destinationRecord = z.strictObject({
  version: z.literal(1),
  projectId: z.string(),
  targetId: z.string(),
  revision: z.number().int().positive().safe(),
  enabled: z.boolean(),
  definition: destinationDefinition,
  updatedBy: z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/),
  updatedAt: z.string().datetime()
});
export type LocalDestinationRecord = Readonly<z.infer<typeof destinationRecord>>;

const outcomeRecord = z.strictObject({
  version: z.literal(1),
  projectId: z.string(),
  actionClass: z.enum(['deploy', 'publish']),
  artifactRevision: z.string().min(1).max(200),
  targetRevision: z.number().int().positive().safe(),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  externalId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  previousGeneration: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).nullable(),
  recordedAt: z.string().datetime()
});
export type LocalReleaseOutcome = Readonly<z.infer<typeof outcomeRecord>>;

function requireKind(value: unknown): LocalReleaseActionClass {
  if (value !== 'deploy' && value !== 'publish') throw new LocalReleaseError('kind must be deploy or publish', 'INVALID');
  return value;
}

function parseDefinition(kind: LocalReleaseActionClass, definition: unknown): DestinationDefinition {
  const parsed = destinationDefinition.safeParse(definition);
  if (!parsed.success) throw new LocalReleaseError('Invalid local release destination; only the exact configured shape is accepted', 'INVALID');
  if (kind === 'deploy') {
    if (parsed.data.kind !== 'deploy-local') throw new LocalReleaseError('A deploy destination must be a deploy-local definition', 'INVALID');
    return Object.freeze({
      kind: 'deploy-local' as const,
      artifactPath: parseRelativePath(parsed.data.artifactPath, 'artifactPath'),
      targetDirectory: parseDestinationPath(parsed.data.targetDirectory, 'targetDirectory')
    });
  }
  if (parsed.data.kind !== 'publish-local') throw new LocalReleaseError('A publish destination must be a publish-local definition', 'INVALID');
  return Object.freeze({ kind: 'publish-local' as const, publicationRoot: parseDestinationPath(parsed.data.publicationRoot, 'publicationRoot') });
}

/** Fingerprint the immutable definition and its revision; the action artifact binds this value. */
export function localDestinationFingerprint(value: LocalDestinationRecord): string {
  const record = destinationRecord.parse(value), definition = record.definition;
  const fields = definition.kind === 'deploy-local' ? [definition.artifactPath, definition.targetDirectory] : [definition.publicationRoot];
  return createHash('sha256').update(JSON.stringify(['pilot-local-destination-v1', record.projectId, record.targetId, record.revision, record.enabled, definition.kind, ...fields])).digest('hex');
}

/**
 * The canonical resource one accepted local effect contends on: the configured directory **and** the
 * exact promoted content. Including the content is deliberate: a later generation of the same target
 * is a different effect and must be admissible, while replaying the same accepted content is refused
 * by the same durable barrier. It does not serialize two distinct contents targeting one directory;
 * that limitation is stated in the documentation rather than hidden.
 */
export function localDestinationResourceKey(projectId: string, kind: LocalReleaseActionClass, definition: DestinationDefinition, contentDigest: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentDigest)) throw new LocalReleaseError('Invalid release content digest', 'INVALID');
  const resource = definition.kind === 'deploy-local' ? definition.targetDirectory : definition.publicationRoot;
  return 'resource-' + createHash('sha256').update(JSON.stringify(['pilot-local-release-resource-v2', parseAgentIdentifier(projectId), kind, resource, contentDigest])).digest('hex');
}

export class LocalReleaseStore {
  constructor(private readonly store: ControlStore) {}

  private history(projectId: string, kind: LocalReleaseActionClass): readonly LocalDestinationRecord[] {
    const targetId = LOCAL_DESTINATION_TARGET_IDS[kind], scope = { projectId, sessionId: targetId };
    const rows = this.store.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid').all(projectId, targetId, KIND) as { id: string }[];
    let latest: LocalDestinationRecord | null = null;
    const records: LocalDestinationRecord[] = [];
    for (const row of rows) {
      const operation = this.store.getOperation(row.id, scope), parsed = destinationRecord.safeParse(operation.input);
      if (!parsed.success || operation.kind !== KIND || parsed.data.projectId !== projectId || parsed.data.targetId !== targetId || operation.idempotencyKey !== 'local-destination.r' + parsed.data.revision || operation.state !== 'pending')
        throw new LocalReleaseError('The local release destination registry is corrupt', 'STORAGE');
      const outboxes = this.store.db.prepare('SELECT id FROM outboxes WHERE operation_id=?').all(operation.id) as { id: string }[];
      if (outboxes.length !== 1) throw new LocalReleaseError('The local release destination audit is corrupt', 'STORAGE');
      const outbox = this.store.getOutbox(outboxes[0].id, scope), payload = outbox.payload as { version?: unknown; targetId?: unknown; revision?: unknown } | null;
      if (outbox.operationId !== operation.id || outbox.kind !== OUTBOX || outbox.state !== 'pending' || outbox.receiptPresent || operation.receiptPresent || !payload || Object.keys(payload).sort().join(',') !== 'revision,targetId,version' || payload.version !== 1 || payload.targetId !== targetId || payload.revision !== parsed.data.revision || operation.inputDigest !== operationDigest(operation.kind, { input: operation.input, outbox: { kind: outbox.kind, payload: outbox.payload } }))
        throw new LocalReleaseError('The local release destination audit is corrupt', 'STORAGE');
      if (latest !== null && parsed.data.revision !== latest.revision + 1) throw new LocalReleaseError('The local release destination history is corrupt', 'STORAGE');
      if (latest === null && parsed.data.revision !== 1) throw new LocalReleaseError('The local release destination history is corrupt', 'STORAGE');
      let definition: DestinationDefinition;
      try { definition = parseDefinition(kind, parsed.data.definition); }
      catch { throw new LocalReleaseError('A stored local release destination is invalid', 'STORAGE'); }
      latest = Object.freeze({ ...parsed.data, definition });
      records.push(latest);
    }
    return records;
  }

  /** The current configuration of one project's destination, or null. */
  readDestination(project: unknown, kind: unknown): LocalDestinationRecord | null {
    const projectId = parseAgentIdentifier(project), actionClass = requireKind(kind);
    return this.history(projectId, actionClass).at(-1) ?? null;
  }

  /** Resolve one exact revision that is still the enabled current one, or refuse. */
  resolveDestination(project: unknown, kind: unknown, revision: unknown): LocalDestinationRecord {
    const projectId = parseAgentIdentifier(project), actionClass = requireKind(kind);
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new LocalReleaseError('Invalid local release destination revision', 'INVALID');
    const record = this.readDestination(projectId, actionClass);
    if (!record || !record.enabled || record.revision !== revision)
      throw new LocalReleaseError('The configured local release destination is unavailable or changed', 'UNAVAILABLE');
    return record;
  }

  /** Owner-only, revision-checked configuration. The definition is validated before anything is written. */
  writeDestination(input: { projectId: unknown; kind: unknown; revision: unknown; enabled: unknown; definition: unknown; actor: unknown }): LocalDestinationRecord {
    const projectId = parseAgentIdentifier(input.projectId), actionClass = requireKind(input.kind), actor = parseAgentActor(input.actor);
    if (actor.kind !== 'owner') throw new LocalReleaseError('Only the owner may configure a local release destination', 'UNAVAILABLE');
    if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0 || typeof input.enabled !== 'boolean')
      throw new LocalReleaseError('Invalid destination revision or state', 'INVALID');
    const definition = parseDefinition(actionClass, input.definition);
    const targetId = LOCAL_DESTINATION_TARGET_IDS[actionClass], revision = input.revision as number, current = this.readDestination(projectId, actionClass);
    if ((current?.revision ?? 0) !== revision) throw new LocalReleaseError('The local release destination changed; no revision was written', 'CONFLICT');
    const record: LocalDestinationRecord = {
      version: 1, projectId, targetId, revision: revision + 1, enabled: input.enabled,
      definition, updatedBy: actor.identity, updatedAt: new Date().toISOString()
    };
    try {
      this.store.admit({
        scope: { projectId, sessionId: targetId },
        idempotencyKey: 'local-destination.r' + record.revision,
        kind: KIND,
        input: record,
        outbox: { kind: OUTBOX, payload: { version: 1, targetId, revision: record.revision } },
        guard: () => { if ((this.readDestination(projectId, actionClass)?.revision ?? 0) !== revision) throw new Error('The local release destination changed before admission.'); }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && (error.code === 'CONFLICT' || error.code === 'INVALID'))
        throw new LocalReleaseError('The local release destination changed or its admission was refused; no revision was written', 'CONFLICT');
      throw error;
    }
    const written = this.readDestination(projectId, actionClass);
    if (!written || written.revision !== record.revision) throw new LocalReleaseError('The local release destination receipt could not be verified', 'STORAGE');
    return written;
  }

  /**
   * Record what one admitted effect really did, once per accepted artifact. A second write for the
   * same artifact returns the durable first record instead of overwriting it; it never promotes again.
   */
  recordOutcome(input: {
    projectId: unknown; actionClass: unknown; artifactRevision: unknown; targetRevision: unknown; targetDigest: unknown;
    contentDigest: unknown; externalId: unknown; previousGeneration: unknown;
  }): LocalReleaseOutcome {
    const projectId = parseAgentIdentifier(input.projectId), actionClass = requireKind(input.actionClass);
    const scope = { projectId, sessionId: 'local-release' };
    const record = outcomeRecord.parse({
      version: 1, projectId, actionClass, artifactRevision: input.artifactRevision, targetRevision: input.targetRevision,
      targetDigest: input.targetDigest, contentDigest: input.contentDigest, externalId: input.externalId,
      previousGeneration: input.previousGeneration ?? null, recordedAt: new Date().toISOString()
    });
    const key = 'outcome.' + createHash('sha256').update(record.artifactRevision).digest('hex');
    const admitted = this.store.admit({
      scope, idempotencyKey: key, kind: OUTCOME_KIND, input: record,
      outbox: { kind: OUTCOME_OUTBOX, payload: { version: 1, actionClass: record.actionClass, externalId: record.externalId } }
    });
    return this.readOutcome(projectId, admitted.operation.id);
  }

  private readOutcome(projectId: string, operationId: string): LocalReleaseOutcome {
    const scope = { projectId, sessionId: 'local-release' }, operation = this.store.getOperation(operationId, scope), parsed = outcomeRecord.safeParse(operation.input);
    if (!parsed.success || operation.kind !== OUTCOME_KIND || parsed.data.projectId !== projectId || operation.state !== 'pending')
      throw new LocalReleaseError('The recorded local release outcome is corrupt', 'STORAGE');
    const outboxes = this.store.db.prepare('SELECT id FROM outboxes WHERE operation_id=?').all(operation.id) as { id: string }[];
    if (outboxes.length !== 1) throw new LocalReleaseError('The recorded local release outcome is corrupt', 'STORAGE');
    const outbox = this.store.getOutbox(outboxes[0].id, scope);
    if (outbox.kind !== OUTCOME_OUTBOX || outbox.state !== 'pending' || outbox.receiptPresent) throw new LocalReleaseError('The recorded local release outcome is corrupt', 'STORAGE');
    return Object.freeze({ ...parsed.data });
  }

  /** Every recorded outcome of one project, oldest first. Read-only, for owner inspection and tests. */
  outcomes(project: unknown): readonly LocalReleaseOutcome[] {
    const projectId = parseAgentIdentifier(project), scope = { projectId, sessionId: 'local-release' };
    const rows = this.store.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid').all(projectId, scope.sessionId, OUTCOME_KIND) as { id: string }[];
    return rows.map(({ id }) => this.readOutcome(projectId, id));
  }
}
