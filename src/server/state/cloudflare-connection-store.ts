import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { parseAgentActor, parseAgentIdentifier } from '../../shared/agent-registry';

const targetSchema = z.strictObject({ accountId: z.string().regex(/^[a-f0-9]{32}$/), workerName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/) });
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{10,256}$/);
const rowSchema = z.strictObject({ project_id: z.string(), connection_id: z.string(), revision: z.number().int().positive().safe(), enabled: z.union([z.literal(0), z.literal(1)]), account_id: targetSchema.shape.accountId, worker_name: targetSchema.shape.workerName, token: tokenSchema.nullable() }).refine(row => !row.enabled || row.token !== null);
const updateSchema = z.strictObject({ projectId: z.string(), connectionId: z.string(), revision: z.number().int().nonnegative().safe().max(Number.MAX_SAFE_INTEGER - 1), target: targetSchema, enabled: z.boolean().default(false), credential: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('keep') }), z.strictObject({ kind: z.literal('replace'), token: tokenSchema }), z.strictObject({ kind: z.literal('remove') })]), actor: z.unknown() });
export type CloudflareConnectionView = Readonly<{ projectId: string; connectionId: string; revision: number; enabled: boolean; credentialConfigured: boolean; targetDigest: string; authority: 'https://api.cloudflare.com' }>;

type Row = z.infer<typeof rowSchema>;
const schema = 'CREATE TABLE connections (project_id TEXT NOT NULL, connection_id TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, account_id TEXT NOT NULL, worker_name TEXT NOT NULL, token TEXT, PRIMARY KEY(project_id, connection_id)) STRICT';
function verifySchema(db: DatabaseSync): void {
  const objects = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all();
  // The composite PRIMARY KEY creates exactly this SQLite-owned autoindex; it has no SQL text.
  if (objects.length !== 2 || objects[0].type !== 'index' || objects[0].name !== 'sqlite_autoindex_connections_1' || objects[0].tbl_name !== 'connections' || objects[0].sql !== null || objects[1].type !== 'table' || objects[1].name !== 'connections' || objects[1].tbl_name !== 'connections' || objects[1].sql !== schema) throw new Error('Private connection storage is unavailable or corrupt.');
}
function view(row: Row): CloudflareConnectionView {
  return Object.freeze({ projectId: row.project_id, connectionId: row.connection_id, revision: row.revision, enabled: row.enabled === 1, credentialConfigured: row.token !== null, targetDigest: createHash('sha256').update(JSON.stringify(['cloudflare-worker-v1', row.account_id, row.worker_name])).digest('hex'), authority: 'https://api.cloudflare.com' });
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Internal only: no token retrieval, no network request and no agent tool. An owner-authenticated,
 * default-off route may configure one connection (`DASHBOARD_CLOUDFLARE_CONNECTION`); nothing consumes
 * the credential yet. Callers must supply every project root.
 */
export class CloudflareConnectionStore {
  private db: DatabaseSync;
  constructor(dataRoot: string, projectRoots: readonly string[]) {
    // Resolve existing roots before creating anything. Callers must recheck when projects change.
    const data = realpathSync(dataRoot), roots = projectRoots.map(root => realpathSync(root));
    const dir = join(data, 'credentials');
    if (!roots.length || roots.some(root => within(root, data) || within(root, join(dir, 'cloudflare-connections.sqlite')))) throw new Error('Private data root must be outside every project root.');
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const ds = lstatSync(dir);
    if (!ds.isDirectory() || ds.isSymbolicLink() || (ds.mode & 0o077) !== 0) throw new Error('Private credentials directory is unavailable or insecure.');
    const path = join(dir, 'cloudflare-connections.sqlite');
    let fd: number, created = false;
    try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); created = true; closeSync(fd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Private connection storage is unavailable.'); }
    const fs = lstatSync(path);
    if (!fs.isFile() || fs.isSymbolicLink() || (fs.mode & 0o077) !== 0) throw new Error('Private connection storage is unavailable or insecure.');
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;');
      if (created) db.exec(schema);
      verifySchema(db);
      const result = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      if (result?.quick_check !== 'ok') throw new Error('corrupt');
      this.db = db;
    } catch { db?.close(); throw new Error('Private connection storage is unavailable or corrupt.'); }
  }
  private row(projectId: string, connectionId: string): Row | null {
    try {
      const raw = this.db.prepare('SELECT project_id, connection_id, revision, enabled, account_id, worker_name, token FROM connections WHERE project_id=? AND connection_id=?').get(projectId, connectionId);
      if (!raw) return null;
      const row = rowSchema.parse(raw);
      if (row.project_id !== projectId || row.connection_id !== connectionId) throw new Error('invalid');
      return row;
    } catch { throw new Error('Private connection storage is unavailable or corrupt.'); }
  }
  read(project: string, connection: string): CloudflareConnectionView | null {
    const projectId = parseAgentIdentifier(project), connectionId = parseAgentIdentifier(connection);
    this.db.exec('BEGIN');
    try {
      verifySchema(this.db);
      const row = this.row(projectId, connectionId);
      this.db.exec('COMMIT');
      return row ? view(row) : null;
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Private connection storage is unavailable or corrupt.');
    }
  }
  write(input: unknown): CloudflareConnectionView {
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) throw new Error('Invalid Cloudflare connection configuration.');
    const value = parsed.data, projectId = parseAgentIdentifier(value.projectId), connectionId = parseAgentIdentifier(value.connectionId);
    const actor = parseAgentActor(value.actor);
    if (actor.kind !== 'owner') throw new Error('Only the owner may configure a Cloudflare connection.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      verifySchema(this.db);
      const current = this.row(projectId, connectionId);
      if ((current?.revision ?? 0) !== value.revision) throw new Error('Cloudflare connection revision conflict.');
      const token = value.credential.kind === 'replace' ? value.credential.token : value.credential.kind === 'remove' ? null : current?.token ?? null;
      if (value.enabled && !token) throw new Error('A credential is required to enable a Cloudflare connection.');
      this.db.prepare(`INSERT INTO connections VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, connection_id) DO UPDATE SET revision=excluded.revision, enabled=excluded.enabled, account_id=excluded.account_id, worker_name=excluded.worker_name, token=excluded.token`).run(projectId, connectionId, value.revision + 1, value.enabled ? 1 : 0, value.target.accountId, value.target.workerName, token);
      const result = this.row(projectId, connectionId);
      if (!result) throw new Error('Private connection storage is unavailable or corrupt.');
      this.db.exec('COMMIT');
      return view(result);
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof Error && ['Cloudflare connection revision conflict.', 'A credential is required to enable a Cloudflare connection.', 'Private connection storage is unavailable or corrupt.'].includes(error.message)) throw error;
      throw new Error('Private connection storage is unavailable or corrupt.');
    }
  }
  close(): void { this.db.close(); }
}
