import { randomUUID } from 'node:crypto';
import type { ControlScope, OperationRecord, OutboxRecord } from '../../shared/control-state';
import { ControlStore, ControlStoreError } from './control-store';
import {
  AGENT_MAX_AGENTS, AgentError, buildAgentRecord, decideScopeChange, parseAgentActor, parseAgentDraft, parseAgentIdentifier,
  parseAgentPatch, scopesInForceFor, validateAgentRecord,
  type AgentActor, type AgentAuditEntry, type AgentDraft, type AgentPatch, type AgentRecord, type AgentScope
} from '../../shared/agent-registry';

/**
 * The durable agent registry: the record, its revision rule and its governance audit.
 *
 * A record lives in the reviewed durable control store as **one operation per record revision**: the
 * record itself is the operation input, the operation's outbox row is the evidence that the write
 * happened and carries who made it and when, and the idempotency key is derived from the revision the
 * write produces (agent.r<revision>). Three consequences:
 *
 * - **The revision is a real compare-and-swap.** A change writes revision n+1 under the key
 *   agent.r(n+1), and the control store's UNIQUE(project_id, session_id, idempotency_key) index admits
 *   exactly one of two concurrent writers at that revision. The loser is refused as a conflict inside
 *   the store's own transaction, so a stale interface can never silently overwrite a newer record.
 * - **The current record is the highest revision** of that agent, and a read is a read-only SELECT
 *   over the same schema, projected through the store's own validated getters. Two rows sharing a
 *   revision is refused as corruption rather than resolved arbitrarily.
 * - **No second persistence.** No companion table is created: the control schema is frozen and the
 *   store refuses a database holding any table other than control_schema, operations and outboxes.
 *   Everything an agent writes therefore sits inside the control store's transaction guarantees.
 *
 * Governance is enforced here, not in the interface: the owner may change any scope, an agent may
 * not create an agent, may not edit its own record and may not widen another agent beyond the scopes
 * it holds itself. The rule itself is the pure function 'decideScopeChange', and every write records
 * who made it, what it was and when in the outbox row beside the record.
 */

/** The durable operation and outbox kinds this registry owns. Nothing else is ever reported. */
const OPERATION_KIND = 'agent.record';
const OUTBOX_KIND = 'agent.registry';
/**
 * The control store scopes operations by project and session, while the agent registry is a
 * deployment-level list. The storage bucket is therefore a bucket, never the authority: an agent's own
 * record is the authority, and it is always read back through the store's validated getters.
 */
const BUCKET = 'agents';

export type AgentStoreOptions = {
  readonly clock?: () => Date;
  readonly id?: () => string;
  /**
   * Every model this instance really offers. A declared model outside this list is refused, so an
   * agent can never declare a model that cannot run here, and the interface can offer exactly the
   * same list rather than a second, drifting one.
   */
  readonly models: () => readonly { readonly provider: string; readonly modelId: string }[];
  /** Whether this instance knows this project. A workspace that names another one is refused. */
  readonly projectKnown: (projectId: string) => boolean;
};

function storage(message: string): AgentError {
  return new AgentError(message, 'STORAGE');
}
function corrupt(message: string): AgentError {
  return new AgentError(message, 'CORRUPT');
}

export class AgentStore {
  private readonly clock: () => Date;
  private readonly id: () => string;
  constructor(private readonly store: ControlStore, private readonly options: AgentStoreOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? (() => randomUUID());
  }

  /** Every agent, oldest first, ties broken by id: a deterministic order. */
  list(): readonly AgentRecord[] {
    return Object.freeze(this.records());
  }
  /** Every live (non-archived) agent. */
  live(): readonly AgentRecord[] {
    return Object.freeze(this.records().filter((record) => !record.archived));
  }
  /** Every model this instance really offers, in the order its catalog reports them. */
  offeredModels(): readonly { readonly provider: string; readonly modelId: string }[] {
    return Object.freeze(this.options.models().map((model) => Object.freeze({ provider: model.provider, modelId: model.modelId })));
  }
  /** One agent, or the refusal that names what is missing. */
  read(agentId: unknown): AgentRecord {
    return this.require(parseAgentIdentifier(agentId));
  }
  /** The durable audit trail of one agent, oldest first. */
  history(agentId: unknown): readonly AgentAuditEntry[] {
    const id = parseAgentIdentifier(agentId);
    this.require(id);
    return Object.freeze(this.recordsFor(id).map((entry) => entry.audit));
  }
  /** The agents whose workspace names this project, live or archived. */
  forProject(projectId: unknown): readonly AgentRecord[] {
    const id = parseAgentIdentifier(projectId, 'projectId');
    return Object.freeze(this.records().filter((record) => record.workspace.projectId === id));
  }
  /**
   * The scopes in force for one project's dispatch. 'null' means no agent is bound to it, so the
   * owner's own dispatch is in force and nothing is narrowed.
   */
  authority(projectId: unknown): { readonly agentId: string | null; readonly scopes: readonly AgentScope[] | null } {
    const bound = this.forProject(projectId).filter((record) => record.enabled && !record.archived);
    const scopes = scopesInForceFor(bound);
    return Object.freeze({ agentId: scopes === null ? null : (bound.length === 1 ? bound[0].id : null), scopes });
  }

  /**
   * Creates one agent under a generated id.
   *
   * The draft is validated strictly before anything is written, the name must be unique among the
   * live agents, the declared model must be one this instance offers, and the workspace project must
   * be one it knows. An agent actor may not create at all.
   */
  create(input: unknown): AgentRecord {
    const data = requireObject(input, 'create request (requires draft and actor)');
    const draft = parseAgentDraft(data.draft);
    const actor = parseAgentActor(data.actor);
    this.assertModel(draft);
    this.assertWorkspace(draft);
    const verdict = decideScopeChange({ actor, actorScopes: this.actorScopes(actor), current: null, next: draft.scopes });
    if (!verdict.permitted) throw new AgentError(verdict.reason, 'NOT_PERMITTED');
    const records = this.records();
    this.assertNameFree(records, draft.name, null);
    if (records.filter((record) => !record.archived).length >= AGENT_MAX_AGENTS)
      throw new AgentError('This registry already holds the maximum of ' + AGENT_MAX_AGENTS + ' live agents', 'INVALID');
    const at = this.now();
    const record = buildAgentRecord({
      id: this.id(), revision: 1, draft, archived: false, createdAt: at, updatedAt: at, updatedBy: actor
    });
    return this.write(record, 'created');
  }

  /**
   * Writes the next revision of one agent under an optimistic revision check.
   *
   * The patch is validated strictly, the resulting record is validated as a whole, and governance is
   * checked against the allowlist the change would leave in force — never against the request alone,
   * so a change that widens in two steps is refused at the step that widens.
   */
  update(input: unknown): AgentRecord {
    const data = requireObject(input, 'update request (requires agentId, revision, patch and actor)');
    const agentId = parseAgentIdentifier(data.agentId);
    const revision = requireRevision(data.revision);
    const patch = parseAgentPatch(data.patch);
    const actor = parseAgentActor(data.actor);
    const current = this.require(agentId);
    if (current.archived) throw new AgentError('Agent ' + agentId + ' is archived, so it is refused; an archived agent is never changed', 'CONFLICT');
    if (current.revision !== revision)
      throw new AgentError('Agent ' + agentId + ' is at revision ' + current.revision + ', not ' + revision + '; the change wrote nothing and the record is unchanged', 'CONFLICT');
    const next: AgentDraft = Object.freeze({
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      enabled: patch.enabled ?? current.enabled,
      model: patch.model ?? current.model,
      workspace: patch.workspace ?? current.workspace,
      budgets: patch.budgets ?? current.budgets,
      scopes: patch.scopes ?? current.scopes
    });
    this.assertModel(next);
    this.assertWorkspace(next);
    const verdict = decideScopeChange({ actor, actorScopes: this.actorScopes(actor), current, next: next.scopes });
    if (!verdict.permitted) throw new AgentError(verdict.reason, 'NOT_PERMITTED');
    this.assertNameFree(this.records(), next.name, agentId);
    const record = buildAgentRecord({
      id: current.id, revision: revision + 1, draft: next, archived: false,
      createdAt: current.createdAt, updatedAt: this.now(), updatedBy: actor
    });
    return this.write(record, 'updated');
  }

  /**
   * Archives one agent: it keeps every field it held and stops being in force. Archiving an archived
   * agent is a conflict, so the same request twice is refused rather than silently succeeding.
   */
  archive(input: unknown): AgentRecord {
    const data = requireObject(input, 'archive request (requires agentId, revision and actor)');
    const agentId = parseAgentIdentifier(data.agentId);
    const revision = requireRevision(data.revision);
    const actor = parseAgentActor(data.actor);
    const current = this.require(agentId);
    if (current.archived) throw new AgentError('Agent ' + agentId + ' is already archived; the request wrote nothing', 'CONFLICT');
    if (current.revision !== revision)
      throw new AgentError('Agent ' + agentId + ' is at revision ' + current.revision + ', not ' + revision + '; the archive wrote nothing and the record is unchanged', 'CONFLICT');
    const verdict = decideScopeChange({ actor, actorScopes: this.actorScopes(actor), current, next: current.scopes });
    if (!verdict.permitted) throw new AgentError(verdict.reason, 'NOT_PERMITTED');
    const record = buildAgentRecord({
      id: current.id, revision: revision + 1,
      draft: { name: current.name, description: current.description, enabled: current.enabled, model: current.model, workspace: current.workspace, budgets: current.budgets, scopes: current.scopes },
      archived: true, createdAt: current.createdAt, updatedAt: this.now(), updatedBy: actor
    });
    return this.write(record, 'archived');
  }

  /** The scopes an agent actor holds itself, read from the registry rather than from the request. */
  private actorScopes(actor: AgentActor): readonly AgentScope[] | null {
    if (actor.kind !== 'agent') return null;
    try {
      const record = this.require(actor.identity);
      return record.archived ? null : record.scopes;
    } catch {
      return null;
    }
  }
  private assertModel(draft: AgentDraft): void {
    if (this.options.models().some((offered) => offered.provider === draft.model.provider && offered.modelId === draft.model.modelId)) return;
    throw new AgentError(
      'The model ' + draft.model.provider + ' / ' + draft.model.modelId + ' is not one this instance offers, so the agent was not recorded; choose a model from the offered list',
      'MODEL_NOT_OFFERED'
    );
  }
  private assertWorkspace(draft: AgentDraft): void {
    if (this.options.projectKnown(draft.workspace.projectId)) return;
    throw new AgentError(
      'Project ' + draft.workspace.projectId + ' is not registered on this instance, so the agent has no workspace to work in',
      'WORKSPACE_NOT_IN_PROJECT'
    );
  }
  private assertNameFree(records: readonly AgentRecord[], name: string, exceptId: string | null): void {
    const clash = records.find((record) => !record.archived && record.id !== exceptId && record.name === name);
    if (clash)
      throw new AgentError(
        'A live agent is already named ' + name + ' (' + clash.id + '); names are unique among the live agents, and an archived agent\u2019s name is free again',
        'DUPLICATE_NAME'
      );
  }
  private require(agentId: string): AgentRecord {
    const rows = this.recordsFor(agentId);
    if (rows.length === 0) throw new AgentError('No agent ' + agentId + ' is recorded in this registry', 'NOT_FOUND');
    return rows[rows.length - 1].record;
  }
  /** The one write path: a strict record, one admission, and the store's own conflict verdict. */
  private write(record: AgentRecord, action: AgentAuditEntry['action']): AgentRecord {
    try {
      this.store.admit({
        scope: { projectId: BUCKET, sessionId: record.id },
        idempotencyKey: 'agent.r' + record.revision,
        kind: OPERATION_KIND,
        input: record,
        outbox: { kind: OUTBOX_KIND, payload: { version: 1, agentId: record.id, revision: record.revision, action, changedBy: record.updatedBy, changedAt: record.updatedAt } }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new AgentError('Agent ' + record.id + ' revision ' + record.revision + ' was already written with different content (' + error.message + '); the record is unchanged', 'CONFLICT');
      throw storage('The durable store refused the agent write: ' + (error as Error).message);
    }
    return record;
  }
  /** Every stored revision of every agent, oldest first, each decoded through the store's own getters. */
  private records(): AgentRecord[] {
    const rows = this.rows('SELECT id,session_id FROM operations WHERE project_id=? AND kind=? ORDER BY rowid', [BUCKET, OPERATION_KIND]);
    const latest = new Map<string, AgentRecord>();
    for (const row of rows) {
      const agentId = String(row.session_id);
      const record = this.decode(String(row.id), { projectId: BUCKET, sessionId: agentId });
      const previous = latest.get(agentId);
      if (previous === undefined || record.revision > previous.revision) latest.set(agentId, record);
      else if (record.revision === previous.revision) throw storage('Corrupt agent storage: two records of agent ' + agentId + ' share revision ' + record.revision);
    }
    return [...latest.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
  /** Every stored revision of one agent, oldest first, each with its own audit entry. */
  private recordsFor(agentId: string): { readonly record: AgentRecord; readonly audit: AgentAuditEntry }[] {
    const rows = this.rows('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid', [BUCKET, agentId, OPERATION_KIND]);
    const entries = rows.map((row) => {
      const operationId = String(row.id);
      const record = this.decode(operationId, { projectId: BUCKET, sessionId: agentId });
      return Object.freeze({ record, audit: this.auditFor(operationId, { projectId: BUCKET, sessionId: agentId }, record) });
    });
    return entries.sort((left, right) => left.record.revision - right.record.revision);
  }
  /**
   * One operation row as a record: the store's own validated getter for the input, the record
   * validator for the payload, and the outbox as the evidence that this revision was written by this
   * registry. Anything else is corruption, never a record to interpret.
   */
  private decode(operationId: string, scope: ControlScope): AgentRecord {
    let operation: OperationRecord;
    try {
      operation = this.store.getOperation(operationId, scope);
    } catch (error) {
      throw storage('The durable store could not read agent operation ' + operationId + ': ' + (error as Error).message);
    }
    if (operation.kind !== OPERATION_KIND) throw storage('Agent storage holds an unexpected operation kind');
    let record: AgentRecord;
    try {
      record = validateAgentRecord(operation.input, 'CORRUPT');
    } catch (error) {
      throw corrupt('A stored agent record is corrupt: ' + (error as Error).message);
    }
    if (record.id !== scope.sessionId) throw storage('A stored agent record is outside its own scope');
    const outbox = this.outboxFor(operation.id, scope);
    if (outbox.kind !== OUTBOX_KIND) throw storage('Agent storage holds an unexpected outbox kind');
    if (outbox.state !== 'pending') throw storage('An agent outbox must stay pending for the life of the record');
    const payload = outbox.payload as { version?: unknown; agentId?: unknown; revision?: unknown } | null;
    if (!payload || typeof payload !== 'object' || payload.version !== 1 || payload.agentId !== record.id || payload.revision !== record.revision)
      throw storage('The stored agent outbox payload does not describe its record');
    return record;
  }
  /** The durable audit entry beside one revision: what changed, by whom and when. */
  private auditFor(operationId: string, scope: ControlScope, record: AgentRecord): AgentAuditEntry {
    const outbox = this.outboxFor(operationId, scope);
    const payload = outbox.payload as { action?: unknown; changedBy?: unknown; changedAt?: unknown } | null;
    if (!payload || typeof payload !== 'object') throw storage('A stored agent outbox payload is not an object');
    if (payload.action !== 'created' && payload.action !== 'updated' && payload.action !== 'archived')
      throw storage('A stored agent outbox payload names no known change');
    if (typeof payload.changedAt !== 'string' || !Number.isFinite(Date.parse(payload.changedAt)))
      throw storage('A stored agent outbox payload carries no readable instant');
    let changedBy: AgentActor;
    try {
      changedBy = parseAgentActor(payload.changedBy, 'changedBy');
    } catch (error) {
      throw corrupt('A stored agent audit entry is corrupt: ' + (error as Error).message);
    }
    return Object.freeze({ revision: record.revision, action: payload.action, changedBy, changedAt: payload.changedAt });
  }
  private outboxFor(operationId: string, scope: ControlScope): OutboxRecord {
    const rows = this.rows('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2', [operationId]);
    if (rows.length !== 1) throw storage('Agent storage holds no unambiguous outbox row for one of its operations');
    try {
      return this.store.getOutbox(String(rows[0].id), scope);
    } catch (error) {
      throw storage('The durable store could not read an agent outbox: ' + (error as Error).message);
    }
  }
  /**
   * Read-only SELECTs over the reviewed control schema. The store exposes no enumeration API, so
   * these projections read ids only and every record is then read back through the store's own
   * validated getters. Nothing here writes.
   */
  private rows(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try {
      return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    } catch (error) {
      throw storage('The durable control store could not be read: ' + (error as Error).message);
    }
  }
  private now(): string {
    const at = this.clock().getTime();
    if (!Number.isFinite(at)) throw storage('The agent clock is not a valid instant');
    return new Date(at).toISOString();
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('The ' + label + ' is invalid: it must be an object with exactly the documented fields', 'INVALID');
  return value as Record<string, unknown>;
}
function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new AgentError('revision must be a whole number that is not negative', 'INVALID');
  return value;
}
