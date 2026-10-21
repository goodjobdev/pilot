import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { assertEditableDocPath } from '../../shared/docs';
import type { ControlScope, OperationRecord, OutboxRecord } from '../../shared/control-state';
import { ControlStore, ControlStoreError } from './control-store';
import { approvedDirectory } from '../paths';
import {
  SESSION_MAX_LINKS, SESSION_RECORD_VERSION, SessionError, canonicalLinks, legacySessionName,
  parseSessionIdentifier, parseSessionLink, parseSessionLinks, parseSessionModel, parseSessionName,
  sessionLinkKey, validateSessionRecord,
  type SessionLink, type SessionModelChoice, type SessionRecord
} from '../../shared/sessions';

/**
 * Named sessions with durable links.
 *
 * A session is a durable, project-scoped record: a stable id, an owner-visible name, created and
 * updated times, an optional **declared** model choice and links to work items (a board task, a
 * documentation path or spec reference, and a workspace directory).
 *
 * ## Where it is stored, and why that way
 *
 * The record lives in the reviewed durable control store as **one operation per record revision**:
 * the record itself is the operation input, the operation's outbox row is the evidence that the
 * write happened, and the idempotency key is derived from the revision the write produces
 * (session.r<revision>) inside the session's own scope. Three consequences:
 *
 * - **The revision is a real compare-and-swap.** A rename, a link and an unlink each write revision
 *   n+1 under the key session.r(n+1), and the control store's UNIQUE(project_id, session_id,
 *   idempotency_key) index admits exactly one of two concurrent writers at that revision. The loser
 *   is refused as a conflict inside the store's own transaction, so a stale client can never
 *   silently overwrite a newer record.
 * - **The current record is the highest revision** of that session. A read is a read-only SELECT
 *   over the same schema, projected through the store's own validated getters; a session whose rows
 *   share a revision is refused as corruption rather than resolved arbitrarily.
 * - **No second persistence.** No companion table is created: the control schema is frozen and the
 *   store refuses a database holding any table other than control_schema, operations and outboxes,
 *   so the alternative was a second SQLite file - which this round deliberately does not add.
 *   Everything a session writes therefore sits inside the control store's transaction guarantees
 *   and next to the delivery ledger and approvals that already live there.
 *
 * ## What is not here
 *
 * Nothing in this file sends a request to a model provider, opens an agent harness, reads or writes
 * a transcript, or changes a provider, model or thinking selection. A declared model choice is
 * recorded, never applied: applying it to a live conversation is a separate, explicit action.
 */

/** The durable operation and outbox kinds this registry owns. Nothing else is ever reported. */
const OPERATION_KIND = 'session.record';
const OUTBOX_KIND = 'session.registry';
/** One project cannot grow an unbounded registry: the operation payload is capped at 64 KiB each. */
export const SESSION_MAX_PER_PROJECT = 200;
const projectIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** The id of the lazily created conversation each project already has: Pi's reserved root. */
export const LEGACY_SESSION_ID = String(ROOT_CONVERSATION_ID);

function storage(message: string): SessionError {
  return new SessionError(message, 'STORAGE');
}
function refuse(error: unknown, label: string): never {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue && issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
    throw new SessionError(label + ' is invalid: ' + path + (issue?.message ?? 'invalid value'), 'INVALID');
  }
  throw error;
}
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    refuse(error, label);
  }
}
function parseRevision(value: unknown): number {
  return parseStrict(z.number().int().positive(), value, 'revision (a positive whole number)');
}

export type DocumentResolution =
  | { readonly state: 'ok'; readonly path: string }
  | { readonly state: 'not-found' }
  | { readonly state: 'outside-roots'; readonly reason: string };
export type WorkspaceResolution =
  | { readonly state: 'ok'; readonly canonical: string }
  | { readonly state: 'not-found' }
  | { readonly state: 'outside-roots'; readonly reason: string };

/**
 * Where link validation gets its facts. Every method is read-only: resolving a link never creates a
 * board, a document or a directory.
 */
export interface SessionResourcePort {
  /** Whether this project is registered; a session is never created for a project that is not. */
  knownProject(projectId: string): boolean;
  /** Whether the project's board contains this task id. A project without a readable board has none. */
  containsTask(projectId: string, taskId: string): Promise<boolean>;
  /** Resolves a documentation path, normalising it when the documentation store accepts it. */
  resolveDocument(projectId: string, path: string): Promise<DocumentResolution>;
  /** Resolves a workspace path to its canonical location, which must be inside the approved roots. */
  resolveWorkspace(path: string): Promise<WorkspaceResolution>;
}

/** The narrow inputs the real port needs, so the wiring stays in one place and the port stays testable. */
export interface SessionResourcePortInput {
  readonly browseRoots: readonly string[];
  /** The registered project, or undefined when no project has this id. */
  project(projectId: string): { readonly id: string; readonly path: string } | undefined;
  /** Every task id on this project's board. An unreadable or absent board has no tasks. */
  taskIds(projectId: string): Promise<readonly string[]>;
  /** Whether the documentation store serves this already-normalised repository-relative path. */
  documentServable(projectId: string, path: string): Promise<boolean>;
}

/**
 * The real resource port.
 *
 * A workspace path is resolved with the existing contained-path helper (approvedDirectory): the path
 * and every approved root are canonicalised, and the canonical path must be inside one of them. A
 * symlink that leads out of the approved roots therefore resolves outside them and is refused, while
 * a symlink that stays inside is accepted and stored canonically. Refusal messages are deliberately
 * path-free.
 */
export function createSessionResourcePort(input: SessionResourcePortInput): SessionResourcePort {
  return {
    knownProject: (projectId) => input.project(projectId) !== undefined,
    containsTask: async (projectId, taskId) => (await input.taskIds(projectId)).includes(taskId),
    resolveDocument: async (projectId, path) => {
      let normalized: string;
      try {
        normalized = assertEditableDocPath(path);
      } catch (error) {
        return { state: 'outside-roots', reason: (error as Error).message };
      }
      return (await input.documentServable(projectId, normalized)) ? { state: 'ok', path: normalized } : { state: 'not-found' };
    },
    resolveWorkspace: async (path) => {
      try {
        return { state: 'ok', canonical: await approvedDirectory(path, [...input.browseRoots]) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'not-found' };
        const message = (error as Error).message;
        if (message.includes('outside configured browse roots')) return { state: 'outside-roots', reason: 'the path is outside the approved browse roots' };
        if (message.includes('Select a directory')) return { state: 'outside-roots', reason: 'the path is not a directory' };
        return { state: 'outside-roots', reason: 'the path could not be resolved as a directory inside the approved browse roots' };
      }
    }
  };
}

export type SessionRegistryOptions = { readonly clock?: () => Date };

/**
 * The named-session registry over the durable control store. Every write is one control-store
 * admission; every read is a read-only SELECT plus the store's own validated getters.
 */
export class SessionRegistry {
  private readonly clock: () => Date;
  constructor(private readonly store: ControlStore, private readonly resources: SessionResourcePort, options: SessionRegistryOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** The sessions of one project, oldest first, ties broken by id: a deterministic order. */
  list(projectId: unknown): readonly SessionRecord[] {
    return Object.freeze(this.listRecords(parseSessionIdentifier(projectId, 'projectId')));
  }

  /** One session, or the refusal that names what is missing. */
  read(projectId: unknown, sessionId: unknown): SessionRecord {
    return this.require(parseSessionIdentifier(projectId, 'projectId'), parseSessionIdentifier(sessionId, 'sessionId'));
  }

  /** Whether this exact project/session pair already has a durable record. */
  has(projectId: unknown, sessionId: unknown): boolean {
    return this.latest(parseSessionIdentifier(projectId, 'projectId'), parseSessionIdentifier(sessionId, 'sessionId')) !== null;
  }

  /** Whether a live session of this project already carries this name. */
  nameTaken(projectId: unknown, name: unknown): boolean {
    const id = parseSessionIdentifier(projectId, 'projectId'), wanted = parseSessionName(name);
    return this.listRecords(id).some((record) => record.name === wanted);
  }

  /**
   * Resolves links exactly as a write would, without writing anything: parse strictly, then let the
   * resource port decide. Nothing here creates anything.
   */
  async resolveLinks(projectId: unknown, links: unknown): Promise<readonly SessionLink[]> {
    const id = parseSessionIdentifier(projectId, 'projectId');
    const parsed = parseSessionLinks(links);
    const resolved: SessionLink[] = [];
    const seen = new Set<string>();
    for (const link of parsed) {
      const candidate = await this.resolveLink(id, link);
      const key = sessionLinkKey(candidate);
      if (seen.has(key)) throw new SessionError('links name the same ' + candidate.kind + ' link twice', 'INVALID');
      seen.add(key);
      resolved.push(candidate);
    }
    return canonicalLinks(resolved);
  }

  /** Creates one session with a generated id. */
  async create(input: unknown): Promise<SessionRecord> {
    const data = parseStrict(
      z.strictObject({ projectId: z.unknown(), name: z.unknown(), model: z.unknown().optional(), links: z.unknown().optional() }),
      input,
      'create request (requires projectId and name; model and links are optional)'
    );
    const projectId = parseSessionIdentifier(data.projectId, 'projectId');
    const name = parseSessionName(data.name);
    const model = parseSessionModel(data.model);
    this.assertProject(projectId);
    const links = await this.resolveLinks(projectId, data.links);
    return this.materialize({ projectId, sessionId: randomUUID(), name, model, links });
  }

  /**
   * Adopts one session under an explicit id, for the legacy-conversation migration. It is
   * idempotent: a session that already exists is returned unchanged and nothing is written.
   */
  async adopt(input: unknown): Promise<{ readonly record: SessionRecord; readonly existing: boolean }> {
    const data = parseStrict(
      z.strictObject({ projectId: z.unknown(), sessionId: z.unknown(), name: z.unknown(), model: z.unknown().optional(), links: z.unknown().optional() }),
      input,
      'adopt request (requires projectId, sessionId and name; model and links are optional)'
    );
    const projectId = parseSessionIdentifier(data.projectId, 'projectId');
    const sessionId = parseSessionIdentifier(data.sessionId, 'sessionId');
    const name = parseSessionName(data.name);
    const model = parseSessionModel(data.model);
    this.assertProject(projectId);
    const existing = this.latest(projectId, sessionId);
    if (existing) return { record: existing, existing: true };
    const links = await this.resolveLinks(projectId, data.links);
    return { record: this.materialize({ projectId, sessionId, name, model, links }), existing: false };
  }

  /**
   * Renames a session under an optimistic revision check. Renaming to the name it already has is a
   * no-op that returns the record unchanged, so a repeat is idempotent; a stale revision with a
   * different name is a conflict that writes nothing.
   */
  rename(input: unknown): SessionRecord {
    const data = parseStrict(
      z.strictObject({ projectId: z.unknown(), sessionId: z.unknown(), name: z.unknown(), revision: z.unknown() }),
      input,
      'rename request (requires projectId, sessionId, name and revision)'
    );
    const projectId = parseSessionIdentifier(data.projectId, 'projectId'), sessionId = parseSessionIdentifier(data.sessionId, 'sessionId');
    const name = parseSessionName(data.name), revision = parseRevision(data.revision);
    const current = this.require(projectId, sessionId);
    if (current.name === name) return current;
    this.assertRevision(current, revision, 'rename');
    const clash = this.listRecords(projectId).find((record) => record.id !== sessionId && record.name === name);
    if (clash) throw new SessionError('Project ' + projectId + ' already has a live session named ' + name + ' (' + clash.id + '); names are unique within a project', 'DUPLICATE_NAME');
    return this.write(this.rebuild(current, { name }, revision));
  }

  /** Links one work item, validated by the resource port. Linking a link the session already has is a no-op. */
  async link(input: unknown): Promise<SessionRecord> {
    const data = parseStrict(
      z.strictObject({ projectId: z.unknown(), sessionId: z.unknown(), link: z.unknown(), revision: z.unknown() }),
      input,
      'link request (requires projectId, sessionId, link and revision)'
    );
    const projectId = parseSessionIdentifier(data.projectId, 'projectId'), sessionId = parseSessionIdentifier(data.sessionId, 'sessionId');
    const revision = parseRevision(data.revision);
    const requested = parseSessionLink(data.link);
    const current = this.require(projectId, sessionId);
    const resolved = await this.resolveLink(projectId, requested);
    const key = sessionLinkKey(resolved);
    if (current.links.some((link) => sessionLinkKey(link) === key)) return current;
    this.assertRevision(current, revision, 'link');
    if (current.links.length >= SESSION_MAX_LINKS) throw new SessionError('Session ' + sessionId + ' already holds the maximum of ' + SESSION_MAX_LINKS + ' links', 'INVALID');
    return this.write(this.rebuild(current, { links: [...current.links, resolved] }, revision));
  }

  /**
   * Unlinks one work item. Unlinking a link the session does not have is a no-op that returns the
   * record unchanged, so a repeat is idempotent; the stored value is matched exactly, so an unlink
   * needs no filesystem access and never fails because a path has since disappeared.
   */
  unlink(input: unknown): SessionRecord {
    const data = parseStrict(
      z.strictObject({ projectId: z.unknown(), sessionId: z.unknown(), link: z.unknown(), revision: z.unknown() }),
      input,
      'unlink request (requires projectId, sessionId, link and revision)'
    );
    const projectId = parseSessionIdentifier(data.projectId, 'projectId'), sessionId = parseSessionIdentifier(data.sessionId, 'sessionId');
    const revision = parseRevision(data.revision);
    const key = sessionLinkKey(parseSessionLink(data.link));
    const current = this.require(projectId, sessionId);
    const remaining = current.links.filter((link) => sessionLinkKey(link) !== key);
    if (remaining.length === current.links.length) return current;
    this.assertRevision(current, revision, 'unlink');
    return this.write(this.rebuild(current, { links: remaining }, revision));
  }

  private assertProject(projectId: string): void {
    if (!this.resources.knownProject(projectId)) throw new SessionError('Project ' + projectId + ' is not registered', 'NOT_FOUND');
  }
  private assertRevision(current: SessionRecord, revision: number, action: string): void {
    if (current.revision !== revision)
      throw new SessionError('Session ' + current.id + ' is at revision ' + current.revision + ', not ' + revision + '; the ' + action + ' wrote nothing and the record is unchanged', 'CONFLICT');
  }
  /** The next revision of a record: the write that carries it is the compare-and-swap. */
  private rebuild(current: SessionRecord, change: { name?: string; links?: readonly SessionLink[] }, expectedRevision: number): SessionRecord {
    return validateSessionRecord({
      ...current,
      name: change.name ?? current.name,
      links: canonicalLinks(change.links ?? current.links),
      revision: expectedRevision + 1,
      updatedAt: this.now()
    });
  }
  private async resolveLink(projectId: string, link: SessionLink): Promise<SessionLink> {
    if (link.kind === 'task') {
      if (!(await this.resources.containsTask(projectId, link.taskId)))
        throw new SessionError('The board of project ' + projectId + ' contains no task ' + link.taskId, 'NOT_FOUND');
      return link;
    }
    if (link.kind === 'document') {
      const resolved = await this.resources.resolveDocument(projectId, link.path);
      if (resolved.state === 'not-found') throw new SessionError('The documentation store of project ' + projectId + ' serves no document at that path', 'NOT_FOUND');
      if (resolved.state === 'outside-roots') throw new SessionError('That documentation path is outside the approved roots: ' + resolved.reason, 'OUTSIDE_ROOTS');
      return Object.freeze({ kind: 'document', path: resolved.path, anchor: link.anchor }) as SessionLink;
    }
    const resolved = await this.resources.resolveWorkspace(link.path);
    if (resolved.state === 'not-found') throw new SessionError('No workspace directory exists at that path', 'NOT_FOUND');
    if (resolved.state === 'outside-roots') throw new SessionError('That workspace path is outside the approved roots: ' + resolved.reason, 'OUTSIDE_ROOTS');
    return Object.freeze({ kind: 'workspace', path: resolved.canonical }) as SessionLink;
  }
  /** The one write path: a strict record, one admission, and the store's own conflict verdict. */
  private materialize(input: { projectId: string; sessionId: string; name: string; model: SessionModelChoice | null; links: readonly SessionLink[] }): SessionRecord {
    this.assertProject(input.projectId);
    if (this.latest(input.projectId, input.sessionId))
      throw new SessionError('Session ' + input.sessionId + ' already exists in project ' + input.projectId, 'CONFLICT');
    const records = this.listRecords(input.projectId);
    const clash = records.find((record) => record.name === input.name);
    if (clash) throw new SessionError('Project ' + input.projectId + ' already has a live session named ' + input.name + ' (' + clash.id + '); names are unique within a project', 'DUPLICATE_NAME');
    if (records.length >= SESSION_MAX_PER_PROJECT) throw new SessionError('Project ' + input.projectId + ' already holds the maximum of ' + SESSION_MAX_PER_PROJECT + ' sessions', 'INVALID');
    const timestamp = this.now();
    return this.write(validateSessionRecord({
      version: SESSION_RECORD_VERSION,
      id: input.sessionId,
      projectId: input.projectId,
      name: input.name,
      revision: 1,
      model: input.model,
      links: canonicalLinks(input.links),
      createdAt: timestamp,
      updatedAt: timestamp
    }));
  }
  private write(record: SessionRecord): SessionRecord {
    let admitted: { operation: OperationRecord; outbox: OutboxRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: { projectId: record.projectId, sessionId: record.id },
        // One key per revision inside this session's own scope: the store's unique index on
        // (project_id, session_id, idempotency_key) is what makes two writers at the same revision
        // a conflict rather than two records.
        idempotencyKey: 'session.r' + record.revision,
        kind: OPERATION_KIND,
        input: record,
        outbox: { kind: OUTBOX_KIND, payload: { version: 1, sessionId: record.id, revision: record.revision } }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new SessionError('Session ' + record.id + ' revision ' + record.revision + ' was already written with different content (' + error.message + '); the record is unchanged', 'CONFLICT');
      throw storage('The durable store refused the session write: ' + (error as Error).message);
    }
    // An admitted row with the same digest is the same record; nothing else is ever written.
    if (admitted.existing) return record;
    return record;
  }
  private require(projectId: string, sessionId: string): SessionRecord {
    const record = this.latest(projectId, sessionId);
    if (!record) throw new SessionError('No session ' + sessionId + ' in project ' + projectId, 'NOT_FOUND');
    return record;
  }
  private latest(projectId: string, sessionId: string): SessionRecord | null {
    const rows = this.rows('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid', [projectId, sessionId, OPERATION_KIND]);
    let latest: SessionRecord | null = null;
    for (const row of rows) {
      const record = this.decode(String(row.id), { projectId, sessionId });
      if (latest === null || record.revision > latest.revision) latest = record;
      else if (record.revision === latest.revision) throw storage('Corrupt session storage: two records of session ' + sessionId + ' share revision ' + record.revision);
    }
    return latest;
  }
  /** Every live session of one project: the highest revision of each session, in a deterministic order. */
  private listRecords(projectId: string): SessionRecord[] {
    const rows = this.rows('SELECT id,session_id FROM operations WHERE project_id=? AND kind=? ORDER BY rowid', [projectId, OPERATION_KIND]);
    const bySession = new Map<string, SessionRecord>();
    for (const row of rows) {
      const sessionId = String(row.session_id);
      const record = this.decode(String(row.id), { projectId, sessionId });
      const previous = bySession.get(sessionId);
      if (previous === undefined || record.revision > previous.revision) bySession.set(sessionId, record);
      else if (record.revision === previous.revision) throw storage('Corrupt session storage: two records of session ' + sessionId + ' share revision ' + record.revision);
    }
    return [...bySession.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
  /**
   * One operation row as a record: the store's own validated getter for the input, the record
   * validator for the payload, and the outbox as the evidence that this revision was written by
   * this registry. Anything else is corruption, never a record to interpret.
   */
  private decode(operationId: string, scope: ControlScope): SessionRecord {
    let operation: OperationRecord;
    try {
      operation = this.store.getOperation(operationId, scope);
    } catch (error) {
      throw storage('The durable store could not read session operation ' + operationId + ': ' + (error as Error).message);
    }
    if (operation.kind !== OPERATION_KIND) throw storage('Session storage holds an unexpected operation kind');
    let record: SessionRecord;
    try {
      record = validateSessionRecord(operation.input, 'INVALID');
    } catch (error) {
      throw storage('A stored session record is corrupt: ' + (error as Error).message);
    }
    if (record.id !== scope.sessionId || record.projectId !== scope.projectId) throw storage('A stored session record is outside its own scope');
    const outbox = this.outboxFor(operation.id, scope);
    if (outbox.kind !== OUTBOX_KIND) throw storage('Session storage holds an unexpected outbox kind');
    if (outbox.state !== 'pending') throw storage('A session outbox must stay pending for the life of the record');
    const payload = outbox.payload as { version?: unknown; sessionId?: unknown; revision?: unknown } | null;
    if (!payload || typeof payload !== 'object' || payload.version !== 1 || payload.sessionId !== record.id || payload.revision !== record.revision)
      throw storage('The stored session outbox payload does not describe its record');
    return record;
  }
  private outboxFor(operationId: string, scope: ControlScope): OutboxRecord {
    const rows = this.rows('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2', [operationId]);
    if (rows.length !== 1) throw storage('Session storage holds no unambiguous outbox row for one of its operations');
    try {
      return this.store.getOutbox(String(rows[0].id), scope);
    } catch (error) {
      throw storage('The durable store could not read a session outbox: ' + (error as Error).message);
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
    if (!Number.isFinite(at)) throw storage('The session clock is not a valid instant');
    return new Date(at).toISOString();
  }
}

/** Where the migration learns which project already has a conversation, and under which name. */
export interface LegacyConversationPort {
  /** The registered projects to consider, each with the owner-visible name used for the session. */
  projects(): Promise<readonly { readonly id: string; readonly name: string; readonly path: string }[]>;
  /** The id of the conversation this project already has on disk, or null when it has none. */
  conversationFor(projectId: string): Promise<string | null>;
}

/**
 * The legacy conversation each project already has: Pi Durable's single, lazily created root
 * conversation in <data>/agents/<projectId>/session.sqlite. The app has no other conversation.
 *
 * The check is an lstat of that store, never an open. Opening a harness would create the very
 * conversation this migration exists to find - Harness.open followed by root() commits the root
 * conversation on first open - and resuming one would run recovered work. A project with no store
 * on disk therefore has no conversation and is left exactly as it is. A symlink is never followed.
 */
export function legacyConversationPort(input: {
  readonly dataRoot: string;
  readonly projects: () => Promise<readonly { readonly id: string; readonly name: string; readonly path: string }[]>;
}): LegacyConversationPort {
  return {
    projects: input.projects,
    conversationFor: async (projectId) => {
      if (!projectIdPattern.test(projectId)) return null;
      const file = join(input.dataRoot, 'agents', projectId, 'session.sqlite');
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isFile()) return null;
        return LEGACY_SESSION_ID;
      } catch {
        return null;
      }
    }
  };
}

export type SessionMigrationActionKind = 'adopt' | 'already-adopted' | 'no-conversation' | 'refused';
export type SessionMigrationAction = {
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly action: SessionMigrationActionKind;
  readonly reason: string;
};
/** A deterministic, path-free report: the same registry and the same projects produce the same one. */
export type SessionMigrationReport = {
  readonly dryRun: boolean;
  readonly counts: {
    readonly projects: number;
    readonly conversations: number;
    readonly adopted: number;
    readonly alreadyAdopted: number;
    readonly withoutConversation: number;
    readonly refused: number;
  };
  readonly actions: readonly SessionMigrationAction[];
};

/**
 * Adopts every already existing conversation as a named session, once.
 *
 * The migration is **deterministic and idempotent**: it considers registered projects in id order,
 * derives the adopted name from the project's own name, checks whether the session is already
 * registered (in which case it writes nothing at all), and writes at most one session and at most
 * one workspace link per project. Running it twice produces the same registry state, and a project
 * with no conversation on disk is left alone. A dry run performs the same reads and resolutions and
 * writes nothing.
 *
 * It performs no model work of any kind: it opens no harness, reads and writes no transcript, and
 * sends nothing to a provider. A declared model choice is never recorded here either - the adopted
 * session declares none - so no provider, model or thinking selection can be affected.
 *
 * A project whose computed name is already taken by another live session is **refused** and reported
 * rather than renamed or skipped silently: the migration never invents a name.
 */
export async function migrateLegacyConversations(input: {
  readonly registry: SessionRegistry;
  readonly legacy: LegacyConversationPort;
  readonly dryRun: boolean;
}): Promise<SessionMigrationReport> {
  const projects = [...(await input.legacy.projects())].sort((left, right) => left.id.localeCompare(right.id));
  const actions: SessionMigrationAction[] = [];
  let conversations = 0, adopted = 0, alreadyAdopted = 0, withoutConversation = 0, refused = 0;
  for (const project of projects) {
    const sessionId = await input.legacy.conversationFor(project.id);
    if (sessionId === null) {
      withoutConversation += 1;
      actions.push(Object.freeze({ projectId: project.id, sessionId: null, action: 'no-conversation' as const, reason: 'this project has no conversation on disk to adopt' }));
      continue;
    }
    conversations += 1;
    try {
      if (input.registry.has(project.id, sessionId)) {
        alreadyAdopted += 1;
        actions.push(Object.freeze({ projectId: project.id, sessionId, action: 'already-adopted' as const, reason: 'session ' + sessionId + ' is already registered for this conversation' }));
        continue;
      }
      const name = legacySessionName(project.name);
      if (input.registry.nameTaken(project.id, name)) {
        refused += 1;
        actions.push(Object.freeze({ projectId: project.id, sessionId, action: 'refused' as const, reason: 'a live session of this project is already named ' + name + '; the migration never invents another name' }));
        continue;
      }
      const plan = await planLegacyLink(input.registry, project);
      if (input.dryRun) {
        adopted += 1;
        actions.push(Object.freeze({ projectId: project.id, sessionId, action: 'adopt' as const, reason: 'would create session ' + sessionId + ' named ' + name + '; ' + plan.note }));
        continue;
      }
      const result = await input.registry.adopt({ projectId: project.id, sessionId, name, model: null, links: plan.links });
      adopted += 1;
      actions.push(Object.freeze({
        projectId: project.id, sessionId, action: 'adopt' as const,
        reason: (result.existing ? 'session ' + sessionId + ' was already registered; nothing was written' : 'created session ' + sessionId + ' named ' + name) + '; ' + plan.note
      }));
    } catch (error) {
      if (error instanceof SessionError) {
        refused += 1;
        actions.push(Object.freeze({ projectId: project.id, sessionId, action: 'refused' as const, reason: error.message }));
        continue;
      }
      throw error;
    }
  }
  return Object.freeze({
    dryRun: input.dryRun,
    counts: Object.freeze({ projects: projects.length, conversations, adopted, alreadyAdopted, withoutConversation, refused }),
    actions: Object.freeze(actions)
  });
}

/**
 * The project folder as a workspace link, using the same resolution a write would perform. A folder
 * the approved roots do not contain (a managed workspace under the data root, for instance) is not a
 * refusal of the migration: the session is still adopted, and the report says why it carries no link.
 */
async function planLegacyLink(registry: SessionRegistry, project: { readonly id: string; readonly path: string }): Promise<{ readonly links: readonly SessionLink[]; readonly note: string }> {
  if (!project.path) return { links: Object.freeze([] as SessionLink[]), note: 'the project records no folder, so the session carries no workspace link' };
  try {
    const links = await registry.resolveLinks(project.id, [{ kind: 'workspace', path: project.path }]);
    return { links, note: 'the project folder is linked as a workspace' };
  } catch (error) {
    if (error instanceof SessionError) return { links: Object.freeze([] as SessionLink[]), note: 'the project folder is not linked: ' + error.message };
    throw error;
  }
}
