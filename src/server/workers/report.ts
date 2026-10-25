import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { safePath, within } from '../paths';
import { WORKER_REPORT_MAX_BYTES, WorkerError, type WorkerReport } from '../../shared/workers';

/**
 * Write one canonical worker report into the project.
 *
 * The Markdown file is canonical. This module never stores the content anywhere else: the caller
 * records only the returned path, SHA-256 and byte size as derived tracking.
 *
 * Safety, in order:
 * - the path is derived from two validated ids and resolved through `safePath`, so `..`, an absolute
 *   path and a symlink at any component are refused rather than followed;
 * - the canonical project root is re-checked against the resolved parent, so a report can never land
 *   outside the project it belongs to;
 * - an existing file is **never replaced**. A byte-identical file is an idempotent success; a
 *   different file is `REPORT_CONFLICT`, because that Markdown belongs to the owner;
 * - the file is written to a temporary file, fsynced, then linked into place atomically, so a crash
 *   never leaves a half-written report at the canonical path.
 */
export async function writeWorkerReport(input: {
  readonly projectRoot: string;
  readonly path: string;
  readonly content: string;
}): Promise<WorkerReport & { readonly created: boolean }> {
  const canonicalRoot = await realpath(input.projectRoot);
  let target: string;
  let parent: string;
  try {
    // `createParents` makes only the missing directories, 0700, and refuses a symlink at any level.
    target = await safePath(canonicalRoot, input.path, true);
    parent = dirname(target);
    await safePath(canonicalRoot, relative(canonicalRoot, parent), false);
  } catch (error) {
    throw new WorkerError('The report path is not a safe location inside the project: ' + (error as Error).message, 'INVALID');
  }
  const canonicalParent = await realpath(parent);
  if (!within(canonicalRoot, canonicalParent) || canonicalParent === canonicalRoot)
    throw new WorkerError('The report directory resolves outside the project and was refused', 'INVALID');
  const bytes = new TextEncoder().encode(input.content).byteLength;
  const sha256 = createHash('sha256').update(input.content).digest('hex');

  const existing = await readExisting(target);
  if (existing !== null) {
    if (existing.content === input.content)
      return Object.freeze({ path: input.path, sha256, bytes, created: false });
    throw new WorkerError(
      'A different report already exists at ' + input.path + '. It was not overwritten: the owner\u2019s Markdown is canonical and a manual decision is needed',
      'REPORT_CONFLICT'
    );
  }

  const temporary = target + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(input.content);
    await file.sync();
  } finally {
    await file.close();
  }
  let created = true;
  try {
    // `link` is atomic and fails when the target exists, unlike `rename`, which would replace it.
    await link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await unlink(temporary).catch(() => {});
      // A raw filesystem error can name an absolute path. The caller gets one fixed, path-free
      // sentence; the internal detail is not stored and the owner's existing file is untouched.
      throw new WorkerError('The report could not be committed atomically. No report was recorded and an existing file was not replaced.', 'STORAGE');
    }
    // Another writer committed the report between the read and the link. Never overwrite it: accept
    // only a byte-identical file, exactly as above.
    created = false;
    const raced = await readExisting(target);
    if (raced === null || raced.content !== input.content) {
      await unlink(temporary).catch(() => {});
      throw new WorkerError(
        'A different report was committed at ' + input.path + ' by another writer. It was not overwritten',
        'REPORT_CONFLICT'
      );
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  try {
    const dir = await open(canonicalParent, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch {
    // A directory fsync is best effort on platforms that refuse it; the file itself is durable.
  }
  return Object.freeze({ path: input.path, sha256, bytes, created });
}

/** Read an existing report, refusing a symlink or a non-file at the canonical path. */
async function readExisting(target: string): Promise<{ content: string } | null> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new WorkerError('A symlink exists at the report path and was not followed', 'INVALID');
    if (!stat.isFile()) throw new WorkerError('A non-file exists at the report path and was not replaced', 'REPORT_CONFLICT');
    if (stat.size > WORKER_REPORT_MAX_BYTES)
      throw new WorkerError('The existing report is larger than the ' + WORKER_REPORT_MAX_BYTES + '-byte limit and was not read or replaced', 'REPORT_CONFLICT');
    return { content: await readFile(target, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof WorkerError) throw error;
    // A raw filesystem error can name an absolute path, so it is not propagated.
    throw new WorkerError('The existing report could not be read or is unsafe. It was not replaced.', 'STORAGE');
  }
}

/** What one canonical report path holds, read with the same containment and bounds as a write. */
export type WorkerReportInspection =
  | { readonly exists: false }
  | { readonly exists: true; readonly valid: true; readonly sha256: string; readonly bytes: number }
  | { readonly exists: true; readonly valid: false; readonly reason: string };

/**
 * Check an existing canonical report without writing anything.
 *
 * A regular file inside the project, no larger than the report bound and no smaller than one byte,
 * is hashed and reported as valid. A symlink, a directory, an oversize file, a path outside the
 * project and an unreadable file are reported as invalid. The path is never followed outside the
 * project, and no content is returned.
 */
export async function inspectWorkerReport(input: { readonly projectRoot: string; readonly path: string }): Promise<WorkerReportInspection> {
  let target: string;
  try {
    const root = await realpath(input.projectRoot);
    target = await safePath(root, input.path, false);
    const parent = await realpath(dirname(target));
    if (!within(root, parent) || parent === root) return Object.freeze({ exists: true, valid: false, reason: 'the report directory resolves outside the project' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ exists: false });
    return Object.freeze({ exists: true, valid: false, reason: 'the report path is not a safe location inside the project' });
  }
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) return Object.freeze({ exists: true, valid: false, reason: 'the report path is a symlink' });
    if (!stat.isFile()) return Object.freeze({ exists: true, valid: false, reason: 'the report path is not a regular file' });
    if (stat.size < 1) return Object.freeze({ exists: true, valid: false, reason: 'the report file is empty' });
    if (stat.size > WORKER_REPORT_MAX_BYTES) return Object.freeze({ exists: true, valid: false, reason: 'the report file is larger than the report bound' });
    const content = await readFile(target);
    return Object.freeze({
      exists: true,
      valid: true,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ exists: false });
    return Object.freeze({ exists: true, valid: false, reason: 'the report file could not be read' });
  }
}

/**
 * Read a recovery candidate with the same containment and bounds as a write. It returns text only
 * when the path is a regular, non-symlink file inside the project within the report bound. The
 * caller parses the fixed header; this function does not decide whether the content is a report.
 */
export async function readWorkerReportText(input: { readonly projectRoot: string; readonly path: string }): Promise<{ readonly text: string; readonly sha256: string; readonly bytes: number } | null> {
  try {
    const root = await realpath(input.projectRoot);
    const target = await safePath(root, input.path, false);
    const parent = await realpath(dirname(target));
    if (!within(root, parent) || parent === root) return null;
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > WORKER_REPORT_MAX_BYTES) return null;
    const content = await readFile(target);
    return Object.freeze({ text: content.toString('utf8'), sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength });
  } catch {
    return null;
  }
}
