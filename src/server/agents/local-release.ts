import { createHash,randomBytes } from 'node:crypto';
import { lstat,mkdir,readFile,readdir,realpath,rm,writeFile } from 'node:fs/promises';
import { dirname,isAbsolute,join,resolve } from 'node:path';
import { within } from '../paths';

/**
 * The primitives shared by the two local release capabilities: `deploy` and `publish`.
 *
 * Both promote an **exact, digest-bound manifest of regular files** from the project's connected
 * worktree into an owner-configured local directory. Neither talks to a provider, a CI system or the
 * network, and neither reads a model-supplied destination: the destination is the owner's, and the
 * model only names the content it asks to promote (and, for `publish`, the reviewed files).
 *
 * These helpers are deliberately conservative:
 *
 * - A manifest is only ever built from regular files. A symlink at any component, a special file, an
 *   empty manifest, a path over the length bound, a file over its byte cap or a total over the total
 *   cap is refused rather than truncated, skipped or followed.
 * - A generation directory is only ever read back through `realpath`, so a link is never followed
 *   blindly: the caller checks the resolved directory is inside the generation root before reading.
 * - Every canonical digest is SHA-256 over a sorted manifest, so the same bytes produce the same
 *   identity and a changed byte produces a different one. A digest is a comparison aid, not proof of
 *   who produced the content or that the content is safe to serve.
 */

/** One project cannot promote an unbounded artifact. These caps apply per manifest. */
export const LOCAL_RELEASE_MAX_FILES = 500;
export const LOCAL_RELEASE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const LOCAL_RELEASE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const LOCAL_RELEASE_MAX_PATH_LENGTH = 240;
/** The directory holding the immutable generations, inside the owner-configured target. */
export const LOCAL_RELEASE_GENERATIONS = 'generations';
/** The one stable name a server reads: it points at the current generation. */
export const LOCAL_RELEASE_CURRENT = 'current';
/** Staging and link names this tool creates and owns; a name with this prefix is never a target. */
export const LOCAL_RELEASE_STAGING_PREFIX = '.pilot-staging-';
export const LOCAL_RELEASE_LINK_PREFIX = '.pilot-current-';

export type LocalReleaseErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'REFUSED'
  | 'BOUNDED'
  | 'UNAVAILABLE'
  | 'CONFLICT'
  | 'STORAGE';

export class LocalReleaseError extends Error {
  constructor(message: string, public readonly code: LocalReleaseErrorCode) {
    super(message);
    this.name = 'LocalReleaseError';
  }
}

/** One regular file in a release manifest: its relative path, digest and exact size. */
export type ReleaseEntry = { readonly path: string; readonly sha256: string; readonly bytes: number };
export type ReleaseManifest = {
  readonly entries: readonly ReleaseEntry[];
  readonly digest: string;
  readonly bytes: number;
};
export type ReleaseLimits = {
  readonly files: number;
  readonly fileBytes: number;
  readonly totalBytes: number;
};
export const LOCAL_RELEASE_LIMITS: ReleaseLimits = Object.freeze({
  files: LOCAL_RELEASE_MAX_FILES,
  fileBytes: LOCAL_RELEASE_MAX_FILE_BYTES,
  totalBytes: LOCAL_RELEASE_MAX_TOTAL_BYTES
});

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A relative path inside the project worktree: no absolute prefix, no backslash, no empty, current
 * or parent segment, and a conservative character set. It is a reference, never a resolved path.
 */
export function parseRelativePath(value: unknown, label = 'path'): string {
  if (typeof value !== 'string' || value === '' || value.length > LOCAL_RELEASE_MAX_PATH_LENGTH)
    throw new LocalReleaseError(label + ' must be a relative path of 1-' + LOCAL_RELEASE_MAX_PATH_LENGTH + ' characters', 'INVALID');
  if (isAbsolute(value) || value.includes('\\') || value.includes('\0'))
    throw new LocalReleaseError(label + ' must be a relative path with no absolute prefix and no backslash', 'INVALID');
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment)))
    throw new LocalReleaseError(label + ' has an empty, current or parent segment, or a character this build does not accept', 'INVALID');
  return value;
}

/** A destination the owner configured: absolute, canonical and free of a NUL or backslash. */
export function parseDestinationPath(value: unknown, label = 'directory'): string {
  if (typeof value !== 'string' || value === '' || value.length > 1024 || !isAbsolute(value) || value.includes('\\') || value.includes('\0') || resolve(value) !== value)
    throw new LocalReleaseError(label + ' must be an absolute, canonical directory path', 'INVALID');
  return value;
}

/** The canonical identity of one manifest. Sorted, so directory order can never change it. */
export function releaseDigest(entries: readonly ReleaseEntry[]): string {
  const ordered = [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(['pilot-local-release-v1', ...ordered.map((entry) => [entry.path, entry.sha256, entry.bytes])])).digest('hex');
}

/** A path-free refusal for a manifest that cannot be promoted. */
function bounded(what: string): LocalReleaseError {
  return new LocalReleaseError(what + ' is outside the documented release bounds; nothing was promoted', 'BOUNDED');
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build the manifest of a directory, refusing anything that is not a regular file this build may copy.
 * The directory itself must be real; a symlinked root is refused rather than followed.
 */
export async function directoryManifest(root: string, limits: ReleaseLimits = LOCAL_RELEASE_LIMITS): Promise<ReleaseManifest> {
  const info = await lstat(root).catch(() => undefined);
  if (!info || !info.isDirectory() || info.isSymbolicLink())
    throw new LocalReleaseError('The artifact is not a real directory; nothing was promoted', 'REFUSED');
  const entries: ReleaseEntry[] = [];
  let total = 0;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) throw new LocalReleaseError('The artifact directory is nested deeper than this build walks', 'REFUSED');
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolute = join(directory, name), relativePath = prefix === '' ? name : prefix + '/' + name;
      if (relativePath.length > LOCAL_RELEASE_MAX_PATH_LENGTH) throw bounded('an artifact path');
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink())
        throw new LocalReleaseError('The artifact contains a symbolic link; this build never follows or copies one', 'REFUSED');
      if (entry.isDirectory()) { await walk(absolute, relativePath, depth + 1); continue; }
      if (!entry.isFile())
        throw new LocalReleaseError('The artifact contains something that is not a regular file', 'REFUSED');
      if (entry.size > limits.fileBytes) throw bounded('an artifact file');
      if (entries.length + 1 > limits.files) throw bounded('the artifact file count');
      if (total + entry.size > limits.totalBytes) throw bounded('the artifact total size');
      const bytes = await readFile(absolute);
      if (bytes.byteLength !== entry.size) throw new LocalReleaseError('An artifact file changed while it was read; nothing was promoted', 'CONFLICT');
      entries.push(Object.freeze({ path: relativePath, sha256: hashBytes(bytes), bytes: bytes.byteLength }));
      total += bytes.byteLength;
    }
  };
  await walk(root, '', 0);
  if (entries.length === 0) throw new LocalReleaseError('The artifact holds no regular file; there is nothing to promote', 'REFUSED');
  return Object.freeze({ entries: Object.freeze(entries), digest: releaseDigest(entries), bytes: total });
}

/**
 * Build the manifest of an exact list of files, relative to a root. The same containment rule applies:
 * a symlink at any component and a non-regular file are refused, and the list is deduplicated.
 */
export async function fileListManifest(root: string, files: readonly unknown[], limits: ReleaseLimits = LOCAL_RELEASE_LIMITS): Promise<ReleaseManifest> {
  if (!Array.isArray(files) || files.length === 0 || files.length > limits.files)
    throw new LocalReleaseError('files must name 1-' + limits.files + ' reviewed files', 'INVALID');
  const seen = new Set<string>();
  const entries: ReleaseEntry[] = [];
  let total = 0;
  for (const value of files) {
    const relativePath = parseRelativePath(value, 'files');
    if (seen.has(relativePath)) throw new LocalReleaseError('files names the same file twice', 'INVALID');
    seen.add(relativePath);
    const absolute = resolve(root, relativePath);
    if (!within(root, absolute) || absolute === root)
      throw new LocalReleaseError('A published file resolves outside the project worktree', 'REFUSED');
    let at = root;
    for (const segment of relativePath.split('/')) {
      at = join(at, segment);
      const entry = await lstat(at).catch(() => undefined);
      if (!entry) throw new LocalReleaseError('A named publish file does not exist in the project worktree', 'NOT_FOUND');
      if (entry.isSymbolicLink())
        throw new LocalReleaseError('A named publish file path contains a symbolic link; this build never follows one', 'REFUSED');
      if (at !== absolute && !entry.isDirectory())
        throw new LocalReleaseError('A named publish file has a parent that is not a directory', 'REFUSED');
    }
    const entry = await lstat(absolute);
    if (!entry.isFile()) throw new LocalReleaseError('A named publish file is not a regular file', 'REFUSED');
    if (entry.size > limits.fileBytes) throw bounded('a published file');
    if (entries.length + 1 > limits.files) throw bounded('the published file count');
    if (total + entry.size > limits.totalBytes) throw bounded('the published total size');
    const bytes = await readFile(absolute);
    if (bytes.byteLength !== entry.size) throw new LocalReleaseError('A published file changed while it was read; nothing was published', 'CONFLICT');
    entries.push(Object.freeze({ path: relativePath, sha256: hashBytes(bytes), bytes: bytes.byteLength }));
    total += bytes.byteLength;
  }
  return Object.freeze({ entries: Object.freeze(entries), digest: releaseDigest(entries), bytes: total });
}

/** A contained relative directory inside the project worktree, refused if any component is a link. */
export async function containedDirectory(root: string, relativePath: string): Promise<string> {
  const parsed = parseRelativePath(relativePath, 'artifactPath');
  const absolute = resolve(root, parsed);
  if (!within(root, absolute) || absolute === root)
    throw new LocalReleaseError('The configured artifact path leaves the project worktree', 'REFUSED');
  let at = root;
  for (const segment of parsed.split('/')) {
    at = join(at, segment);
    const entry = await lstat(at).catch(() => undefined);
    if (!entry) throw new LocalReleaseError('The configured artifact path does not exist in the project worktree', 'NOT_FOUND');
    if (entry.isSymbolicLink())
      throw new LocalReleaseError('The configured artifact path contains a symbolic link; this build never follows one', 'REFUSED');
  }
  const final = await lstat(absolute);
  if (!final.isDirectory()) throw new LocalReleaseError('The configured artifact path is not a directory', 'REFUSED');
  return absolute;
}

/**
 * A real directory under one of the operator-configured roots. Both the destination and the roots are
 * resolved with `realpath`, so a link or a `..` in the middle cannot be used to reach another place.
 */
export async function approvedRealDirectory(value: string, approvedRoots: readonly string[]): Promise<string> {
  // The destination itself must be a real directory node; a parent may be a normal system link such
  // as `/var`, so the containment check below compares real paths rather than lexical ones.
  const info = await lstat(value).catch(() => undefined);
  if (!info) throw new LocalReleaseError('The configured destination directory does not exist', 'NOT_FOUND');
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new LocalReleaseError('The configured destination is not a real directory', 'REFUSED');
  const canonical = await realpath(value).catch(() => undefined);
  if (canonical === undefined) throw new LocalReleaseError('The configured destination directory does not exist', 'NOT_FOUND');
  const roots = await Promise.all(approvedRoots.map((root) => realpath(root).catch(() => undefined)));
  if (!roots.some((root) => root !== undefined && within(root, canonical)))
    throw new LocalReleaseError('The configured destination is outside the approved roots', 'REFUSED');
  return canonical;
}

/** A fresh, owned staging directory name. Never reused and never the destination itself. */
export function stagingDirectory(parent: string): string {
  return join(parent, LOCAL_RELEASE_STAGING_PREFIX + randomBytes(12).toString('hex'));
}

/** Copy one already-validated manifest out of its source root into an empty destination root. */
export async function copyManifest(sourceRoot: string, manifest: ReleaseManifest, destinationRoot: string): Promise<void> {
  await mkdir(destinationRoot, { recursive: false, mode: 0o755 });
  for (const entry of manifest.entries) {
    const target = join(destinationRoot, ...entry.path.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    const bytes = await readFile(join(sourceRoot, ...entry.path.split('/')));
    if (bytes.byteLength !== entry.bytes || hashBytes(bytes) !== entry.sha256)
      throw new LocalReleaseError('The content changed while it was copied; nothing was promoted', 'CONFLICT');
    await writeFile(target, bytes, { mode: 0o644 });
  }
}

/** Remove a staging directory this tool created. A failure is left for the operator, never hidden. */
export async function discardStaging(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

/** The digest of whatever a generation directory really holds. Used for both write and read-back. */
export async function directoryDigest(directory: string, limits: ReleaseLimits = LOCAL_RELEASE_LIMITS): Promise<string> {
  return (await directoryManifest(directory, limits)).digest;
}

/** The relative generation name a content digest always maps to; identity, not a counter. */
export function generationName(digest: string, prefix = 'gen-'): string {
  return prefix + digest.slice(0, 16);
}

/** Whether a value is a single safe path segment (a generation or link name this tool would create). */
export function isSafeSegment(value: string): boolean {
  return value.length > 0 && value.length <= 80 && SAFE_SEGMENT.test(value) && value !== '.' && value !== '..';
}
