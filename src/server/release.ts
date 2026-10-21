import { readFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Release identity: the running build, the storage schema it expects, and the durable lock
 * identity derived from them. This module is a strict, frozen, secret-free loader with no
 * filesystem mutation: it reads one manifest file and, read-only, one storage schema marker.
 */

/** The environment variable that names the manifest. Missing means the default beside the build. */
export const RELEASE_MANIFEST_ENV = 'DASHBOARD_RELEASE_MANIFEST';
/** The default manifest filename inside the release directory the build was launched from. */
export const RELEASE_MANIFEST_FILENAME = 'release.json';
/** The explicit identity of a build that has no manifest; local mode may run as this. */
export const UNRELEASED_LOCAL = 'unreleased-local' as const;
/** Storage schema ids this build understands. 'pilot-state-1' is the current control schema. */
export const SUPPORTED_SCHEMA_IDS = Object.freeze(['pilot-state-1'] as const);
export type SupportedSchemaId = (typeof SUPPORTED_SCHEMA_IDS)[number];
/** Storage version each supported schema id corresponds to (ControlStore SCHEMA_VERSION). */
const SCHEMA_VERSION_BY_ID: Readonly<Record<SupportedSchemaId, number>> = Object.freeze({ 'pilot-state-1': 1 });

/** The unreleased build version, so the identity is never mistaken for a real release. */
const UNRELEASED_VERSION = '0.0.0-unreleased';

/**
 * Every recorded identity value is an opaque token, never a path: an absolute path or a
 * traversal segment ('..', 'a/../b', './x') is rejected before it can reach the lock.
 */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const BUILD_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const SOURCE_DIGEST = /^[a-f0-9]{7,64}$/;

export interface ReleaseManifest {
  /** The running build version (semver-shaped), e.g. "0.1.0". */
  readonly version: string;
  /** Durable release identity recorded in the service lock. */
  readonly releaseId: string;
  /** The storage schema this build expects. Must be one of SUPPORTED_SCHEMA_IDS. */
  readonly schemaId: SupportedSchemaId;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** Optional source digest of the exact revision that produced the build. */
  readonly sourceDigest?: string;
  /** Optional opaque build identifier. */
  readonly buildId?: string;
}

export interface ReleaseIdentity {
  readonly source: 'manifest' | 'unreleased-local';
  readonly releaseId: string;
  readonly schemaId: SupportedSchemaId;
  readonly version: string;
  readonly manifestPath: string;
  readonly createdAt?: string;
  readonly sourceDigest?: string;
  readonly buildId?: string;
}

export type ReleaseLoad =
  | { readonly status: 'present'; readonly path: string; readonly manifest: ReleaseManifest }
  | { readonly status: 'absent'; readonly path: string }
  | { readonly status: 'invalid'; readonly path: string; readonly reason: string };

export type ReleaseResolution =
  | { readonly state: 'released'; readonly path: string; readonly identity: ReleaseIdentity }
  | { readonly state: 'unreleased-local'; readonly path: string; readonly identity: ReleaseIdentity }
  | { readonly state: 'missing'; readonly path: string; readonly reason: string }
  | { readonly state: 'invalid'; readonly path: string; readonly reason: string };

export interface ReleaseDependencies {
  /** Deterministic read seam; returns undefined when the file does not exist. */
  readonly readText?: (path: string) => Promise<string | undefined>;
}

const defaultReadText = async (path: string): Promise<string | undefined> => {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

/** The default manifest path: release.json beside the built server, resolved through no symlink beyond Node's own. */
export function defaultReleaseManifestPath(): string {
  return fileURLToPath(new URL('./' + RELEASE_MANIFEST_FILENAME, import.meta.url));
}

/**
 * Resolve the manifest path. An operator may give an absolute path; a value containing a NUL or
 * a '..' traversal segment fails closed. Missing or empty means the default beside the release.
 */
export function releaseManifestPath(env: NodeJS.ProcessEnv): string {
  const raw = env[RELEASE_MANIFEST_ENV];
  if (raw === undefined || raw === '') return defaultReleaseManifestPath();
  if (raw.includes('\0')) throw new Error(RELEASE_MANIFEST_ENV + ' must be a valid path');
  if (raw.split(/[\\/]/).includes('..')) throw new Error(RELEASE_MANIFEST_ENV + ' must not contain a path traversal segment');
  return resolve(raw);
}

const manifestSchema = z.strictObject({
  version: z.string().min(1).max(64).regex(BUILD_VERSION),
  releaseId: z.string().regex(OPAQUE_ID),
  schemaId: z.string().regex(OPAQUE_ID),
  createdAt: z.string().datetime(),
  sourceDigest: z.string().regex(SOURCE_DIGEST).optional(),
  buildId: z.string().regex(OPAQUE_ID).optional()
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown validation error';
  const path = issue.path.length ? issue.path.join('.') + ' ' : '';
  return path + issue.message;
}

/** Validate a decoded manifest. Unknown fields, missing fields, malformed ids/timestamps and path-like values throw. */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid release manifest: ' + firstIssue(result.error));
  const parsed = result.data;
  if (!SUPPORTED_SCHEMA_IDS.includes(parsed.schemaId as SupportedSchemaId)) {
    throw new Error('Invalid release manifest: unsupported schema version "' + parsed.schemaId + '" (this build supports ' + SUPPORTED_SCHEMA_IDS.join(', ') + ')');
  }
  // Rebuild the record explicitly: only declared fields are copied, and only the optional
  // fields actually present are added. The returned object is frozen.
  const manifest: { version: string; releaseId: string; schemaId: SupportedSchemaId; createdAt: string; sourceDigest?: string; buildId?: string } = {
    version: parsed.version,
    releaseId: parsed.releaseId,
    schemaId: parsed.schemaId as SupportedSchemaId,
    createdAt: parsed.createdAt
  };
  if (parsed.sourceDigest !== undefined) manifest.sourceDigest = parsed.sourceDigest;
  if (parsed.buildId !== undefined) manifest.buildId = parsed.buildId;
  return Object.freeze(manifest);
}

/** Read and validate the manifest. Never throws on a bad file: absence and invalidity are data. */
export async function loadReleaseManifest(env: NodeJS.ProcessEnv, dependencies: ReleaseDependencies = {}): Promise<ReleaseLoad> {
  const path = releaseManifestPath(env);
  const read = dependencies.readText ?? defaultReadText;
  let text: string | undefined;
  try { text = await read(path); }
  catch (error) { return { status: 'invalid', path, reason: 'release manifest at ' + path + ' could not be read: ' + (error as Error).message }; }
  if (text === undefined) return { status: 'absent', path };
  let decoded: unknown;
  try { decoded = JSON.parse(text); }
  catch { return { status: 'invalid', path, reason: 'release manifest at ' + path + ' is not valid JSON' }; }
  try { return { status: 'present', path, manifest: parseReleaseManifest(decoded) }; }
  catch (error) { return { status: 'invalid', path, reason: (error as Error).message }; }
}

/** The explicit unreleased identity. It is frozen and carries the current supported schema. */
export function unreleasedLocalIdentity(manifestPath: string, releaseId: string = UNRELEASED_LOCAL): ReleaseIdentity {
  return Object.freeze({
    source: 'unreleased-local' as const,
    releaseId,
    schemaId: SUPPORTED_SCHEMA_IDS[0],
    version: UNRELEASED_VERSION,
    manifestPath
  });
}

/**
 * Resolve the release for a validated mode. Hosted mode fails closed when the manifest is missing;
 * local mode may run as the explicit 'unreleased-local' identity. An invalid manifest fails closed
 * in both modes: corruption is never silently downgraded to "unreleased". Local mode is the only
 * mode that reads a missing manifest as permission to continue.
 */
export async function resolveRelease(env: NodeJS.ProcessEnv, mode: 'local' | 'hosted', dependencies: ReleaseDependencies = {}): Promise<ReleaseResolution> {
  const loaded = await loadReleaseManifest(env, dependencies);
  if (loaded.status === 'invalid') return { state: 'invalid', path: loaded.path, reason: loaded.reason };
  if (loaded.status === 'absent') {
    if (mode === 'hosted') return { state: 'missing', path: loaded.path, reason: 'no release manifest at ' + loaded.path };
    return { state: 'unreleased-local', path: loaded.path, identity: unreleasedLocalIdentity(loaded.path) };
  }
  const manifest = loaded.manifest;
  return Object.freeze({
    state: 'released' as const,
    path: loaded.path,
    identity: Object.freeze({
      source: 'manifest' as const,
      releaseId: manifest.releaseId,
      schemaId: manifest.schemaId,
      version: manifest.version,
      manifestPath: loaded.path,
      createdAt: manifest.createdAt,
      ...(manifest.sourceDigest === undefined ? {} : { sourceDigest: manifest.sourceDigest }),
      ...(manifest.buildId === undefined ? {} : { buildId: manifest.buildId })
    })
  });
}

/** The storage-schema version a supported schema id maps to, or undefined when unknown. */
export function schemaVersionForId(schemaId: string): number | undefined {
  return (SCHEMA_VERSION_BY_ID as Record<string, number>)[schemaId];
}

export type StorageSchemaObservation =
  | { readonly state: 'present'; readonly version: number }
  | { readonly state: 'absent' }
  | { readonly state: 'busy'; readonly reason: string }
  | { readonly state: 'malformed'; readonly reason: string };

const CONTROL_SCHEMA_FILE = 'control.sqlite';
/** How long the observation connection waits for a live writer's lock before reporting contention. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** SQLITE_BUSY/SQLITE_LOCKED and their message forms: contention, not corruption. */
function isBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown }).errcode;
  if (errcode === 5 || errcode === 6) return true;
  return /SQLITE_BUSY|SQLITE_LOCKED|database( table)? is locked/i.test((error as Error).message ?? '');
}

/**
 * Read-only observation of the storage schema marker. It opens the database read-only, never
 * creates, writes, deletes or locks anything, and reports malformed evidence instead of throwing.
 * It is a second connection beside a live writer, so it waits out a transient lock (busy timeout)
 * and reports contention as its own state rather than as an unreadable schema.
 */
export function observeStorageSchema(dataRoot: string, options: { readonly busyTimeoutMs?: number } = {}): StorageSchemaObservation {
  const file = join(resolve(dataRoot), CONTROL_SCHEMA_FILE);
  const requested = options.busyTimeoutMs;
  const busyTimeoutMs = typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0 ? requested : DEFAULT_BUSY_TIMEOUT_MS;
  let info;
  try { info = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'malformed', reason: 'storage schema at ' + file + ' cannot be inspected' };
  }
  if (!info.isFile() || info.isSymbolicLink()) return { state: 'malformed', reason: 'storage schema path is not a regular file' };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=' + busyTimeoutMs + ';');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    if (!tables.some((table) => table.name === 'control_schema')) {
      return tables.length
        ? { state: 'malformed', reason: 'storage schema has tables but no control schema marker' }
        : { state: 'malformed', reason: 'storage schema is empty and uninitialized' };
    }
    const markers = db.prepare('SELECT version FROM control_schema').all() as { version?: unknown }[];
    if (markers.length !== 1 || !Number.isInteger(markers[0]?.version)) return { state: 'malformed', reason: 'storage schema marker is missing, duplicated or corrupt' };
    return { state: 'present', version: markers[0].version as number };
  } catch (error) {
    if (isBusy(error)) return { state: 'busy', reason: 'storage schema is temporarily locked by another writer' };
    return { state: 'malformed', reason: 'storage schema is unreadable: ' + (error as Error).message };
  } finally {
    try { db?.close(); } catch { /* a read-only close never masks the observation */ }
  }
}
