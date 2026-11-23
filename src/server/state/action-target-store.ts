import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ControlStore, ControlStoreError, operationDigest } from './control-store';
import { parseAgentActor, parseAgentIdentifier } from '../../shared/agent-registry';
import type { AcceptanceActionClass } from '../../shared/acceptance';

const KIND = 'accepted.target', OUTBOX = 'accepted.target-audit';
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
// Git's full ref validation remains an adapter responsibility. This rejects control characters,
// options, traversal, and URL-like data before any target definition is stored.
const branch = z.string().min(12).max(200).regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/).refine(v => !v.includes('..') && !v.includes('//') && !v.endsWith('/') && !v.endsWith('.') && !v.endsWith('.lock'));
const definition = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('commit'), repositoryId: id, branch }),
  z.strictObject({ kind: z.literal('push'), remoteId: id, repositoryDigest: z.string().regex(/^[a-f0-9]{64}$/), branch }),
  z.strictObject({ kind: z.literal('deploy'), integrationId: id, serviceId: id, environmentId: id, resourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ kind: z.literal('spend'), integrationId: id, accountId: id }),
  z.strictObject({ kind: z.literal('provision'), integrationId: id, accountId: id, regionId: id, templateId: id }),
  z.strictObject({ kind: z.literal('publish'), integrationId: id, channelId: id })
]);
const recordSchema = z.strictObject({
  version: z.literal(1), projectId: id, targetId: id, revision: z.number().int().positive().safe(),
  enabled: z.boolean(), definition, updatedBy: z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/), updatedAt: z.string().datetime()
});
export type ActionTargetRecord = Readonly<z.infer<typeof recordSchema>>;

/** Fingerprint the verified immutable definition as well as its version; no credentials belong here. */
export function actionTargetFingerprint(value: ActionTargetRecord): string {
  const record = recordSchema.parse(value), d = record.definition;
  const fields = d.kind === 'commit' ? [d.repositoryId, d.branch]
    : d.kind === 'push' ? [d.remoteId, d.repositoryDigest, d.branch]
    : d.kind === 'deploy' ? [d.integrationId, d.serviceId, d.environmentId, d.resourceDigest]
    : d.kind === 'spend' ? [d.integrationId, d.accountId]
    : d.kind === 'provision' ? [d.integrationId, d.accountId, d.regionId, d.templateId]
    : [d.integrationId, d.channelId];
  return createHash('sha256').update(JSON.stringify(['pilot-target-v1', record.projectId, record.targetId, record.revision, record.enabled, d.kind, ...fields])).digest('hex');
}

/**
 * Owner-only, revisioned semantic target identities. This internal prototype does not install a
 * tool, provision an integration, resolve a credential, or itself authorize or perform an effect.
 * IDs must refer to separately configured integrations, not URLs, commands, paths or secrets; syntax
 * validation cannot detect a secret accidentally entered as an identifier.
 * Each accepted target revision is immutable and remains in the shared durable control store.
 */
export class ActionTargetStore {
  constructor(private readonly store: ControlStore) {}

  private history(project: string, target: string): readonly ActionTargetRecord[] {
    const projectId = parseAgentIdentifier(project), targetId = parseAgentIdentifier(target);
    const scope = { projectId, sessionId: targetId };
    const rows = this.store.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid').all(projectId, targetId, KIND) as { id: string }[];
    let latest: ActionTargetRecord | null = null;
    const records: ActionTargetRecord[] = [];
    for (const row of rows) {
      const operation = this.store.getOperation(row.id, scope), parsed = recordSchema.safeParse(operation.input);
      if (!parsed.success || operation.kind !== KIND || parsed.data.projectId !== projectId || parsed.data.targetId !== targetId || operation.idempotencyKey !== 'accepted-target.r' + parsed.data.revision || operation.state !== 'pending')
        throw new Error('The action target registry is corrupt.');
      const outboxes = this.store.db.prepare('SELECT id FROM outboxes WHERE operation_id=?').all(operation.id) as { id: string }[];
      if (outboxes.length !== 1) throw new Error('The action target audit is corrupt.');
      const outbox = this.store.getOutbox(outboxes[0].id, scope), payload = outbox.payload as { version?: unknown; targetId?: unknown; revision?: unknown } | null;
      if (outbox.operationId !== operation.id || outbox.kind !== OUTBOX || outbox.state !== 'pending' || outbox.receiptPresent || operation.receiptPresent || !payload || Object.keys(payload).sort().join(',') !== 'revision,targetId,version' || payload.version !== 1 || payload.targetId !== targetId || payload.revision !== parsed.data.revision || operation.inputDigest !== operationDigest(operation.kind, { input: operation.input, outbox: { kind: outbox.kind, payload: outbox.payload } }))
        throw new Error('The action target audit is corrupt.');
      if (latest !== null && parsed.data.revision !== latest.revision + 1) throw new Error('The action target history is corrupt.');
      if (latest === null && parsed.data.revision !== 1) throw new Error('The action target history is corrupt.');
      latest = Object.freeze({ ...parsed.data, definition: Object.freeze(parsed.data.definition) });
      records.push(latest);
    }
    return records;
  }

  read(project: string, target: string): ActionTargetRecord | null {
    const records = this.history(project, target);
    return records.at(-1) ?? null;
  }

  /** Read one immutable historical revision from the validated target chain. */
  readRevision(project: string, target: string, revision: number): ActionTargetRecord {
    const projectId = parseAgentIdentifier(project), targetId = parseAgentIdentifier(target);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid action target revision.');
    const record = this.history(projectId, targetId)[revision - 1];
    if (!record || record.revision !== revision) throw new Error('The historical action target is unavailable.');
    return record;
  }

  resolve(projectId: string, targetId: string, revision: number, kind: AcceptanceActionClass): ActionTargetRecord {
    const target = this.read(projectId, targetId);
    if (!target || !target.enabled || target.revision !== revision || target.definition.kind !== kind)
      throw new Error('The configured action target is unavailable or changed.');
    return target;
  }

  write(input: { projectId: string; targetId: string; revision: number; enabled: boolean; definition: unknown; actor: unknown }): ActionTargetRecord {
    const projectId = parseAgentIdentifier(input.projectId), targetId = parseAgentIdentifier(input.targetId), actor = parseAgentActor(input.actor);
    if (actor.kind !== 'owner') throw new Error('Only the owner may configure an action target.');
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.enabled !== 'boolean') throw new Error('Invalid target revision or state.');
    const parsed = definition.safeParse(input.definition);
    if (!parsed.success) throw new Error('Invalid action target definition; only bounded integration identifiers are accepted.');
    const current = this.read(projectId, targetId);
    if ((current?.revision ?? 0) !== input.revision) throw new Error('The action target changed; no revision was written.');
    const record: ActionTargetRecord = { version: 1, projectId, targetId, revision: input.revision + 1, enabled: input.enabled, definition: parsed.data, updatedBy: actor.identity, updatedAt: new Date().toISOString() };
    try {
      this.store.admit({ scope: { projectId, sessionId: targetId }, idempotencyKey: 'accepted-target.r' + record.revision, kind: KIND, input: record,
        outbox: { kind: OUTBOX, payload: { version: 1, targetId, revision: record.revision } },
        guard: () => { if ((this.read(projectId, targetId)?.revision ?? 0) !== input.revision) throw new Error('The action target changed before admission.'); }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && (error.code === 'CONFLICT' || error.code === 'INVALID')) throw new Error('The action target changed or its admission was refused; no revision was written.');
      throw error;
    }
    return this.resolveWritten(record);
  }
  private resolveWritten(record: ActionTargetRecord): ActionTargetRecord {
    const current = this.read(record.projectId, record.targetId);
    if (!current || current.revision !== record.revision) throw new Error('The action target receipt could not be verified.');
    return current;
  }
}
