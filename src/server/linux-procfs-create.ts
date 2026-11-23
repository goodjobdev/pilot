import { constants } from 'node:fs';
import { mkdir, open, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

const PROC_SUPER_MAGIC = 0x9fa0;
// Linux UAPI O_PATH; Node does not expose this flag in fs.constants.
const O_PATH = 0x200000;
const DIRECTORY_FLAGS = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_PATH_COMPONENTS = 128;
const MAX_PATH_BYTES = 4096;

export class LinuxProcfsCreateError extends Error {
  constructor(
    public readonly code: 'BACKEND_UNAVAILABLE' | 'INVALID_PARENT' | 'CREATE_UNCERTAIN',
    public readonly cause?: unknown,
  ) {
    super(code === 'BACKEND_UNAVAILABLE'
      ? 'Linux procfs descriptor-relative creation is unavailable'
      : code === 'INVALID_PARENT'
        ? 'Parent folder cannot be created'
        : 'The new document may be empty or partially written');
  }
}

function relativeParts(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error('Unsafe relative path');
  }
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error('Unsafe relative path');
  return parts;
}

function absoluteParts(path: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error('Unsafe absolute root');
  }
  if (path === '/') return [];
  const parts = path.slice(1).split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error('Unsafe absolute root');
  return parts;
}

function failClosed(): LinuxProcfsCreateError {
  return new LinuxProcfsCreateError('BACKEND_UNAVAILABLE');
}

async function verifyProcfs(): Promise<void> {
  if (process.platform !== 'linux') throw failClosed();
  try {
    const info = await statfs('/proc');
    if (info.type !== PROC_SUPER_MAGIC) throw failClosed();
    const held = await open('.', O_PATH | constants.O_DIRECTORY);
    try {
      const expected = await held.stat({ bigint: true });
      const viaProc = await open(`/proc/self/fd/${held.fd}`, O_PATH | constants.O_DIRECTORY);
      try {
        const actual = await viaProc.stat({ bigint: true });
        if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw failClosed();
      } finally { await viaProc.close(); }
    } finally { await held.close(); }
  } catch { throw failClosed(); }
}

async function openDirectoryChild(parent: FileHandle, name: string): Promise<FileHandle> {
  const child = await open(`/proc/self/fd/${parent.fd}/${name}`, DIRECTORY_FLAGS);
  try {
    if (!(await child.stat()).isDirectory()) throw new LinuxProcfsCreateError('INVALID_PARENT');
    return child;
  } catch (error) {
    try { await child.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'Descriptor-relative directory open failed and its descriptor cleanup also failed'); }
    throw error;
  }
}

/**
 * Exclusively creates one file beneath descriptor-pinned Linux directories. Missing parents are
 * made relative to their already-open parent descriptors. There is deliberately no pathname
 * fallback. This does not pin the project's identity, prevent mount crossings or parent renames,
 * protect against same-UID mutation, or make later Git/history operations descriptor-relative.
 */
export async function createLinuxProcfsFileBeneath(
  rootAbsolute: string,
  relativePath: string,
  fileMode: number,
  directoryMode: number,
  opener: typeof open = open,
): Promise<FileHandle> {
  if (!Number.isInteger(fileMode) || fileMode < 0 || fileMode > 0o777 ||
      !Number.isInteger(directoryMode) || directoryMode < 0 || directoryMode > 0o777) throw new Error('Invalid creation mode');
  if (Buffer.byteLength(rootAbsolute) + 1 + Buffer.byteLength(relativePath) > MAX_PATH_BYTES) throw new Error('Path exceeds the traversal limit');
  const rootParts = absoluteParts(rootAbsolute);
  const fileParts = relativeParts(relativePath);
  if (rootParts.length + fileParts.length > MAX_PATH_COMPONENTS) throw new Error('Path exceeds the traversal limit');
  await verifyProcfs();

  const handles: FileHandle[] = [];
  let result: FileHandle | undefined;
  let operationError: unknown;
  try {
    let current = await opener('/', DIRECTORY_FLAGS);
    handles.push(current);
    for (const part of rootParts) {
      current = await openDirectoryChild(current, part);
      handles.push(current);
    }

    for (const part of fileParts.slice(0, -1)) {
      let next: FileHandle;
      try { next = await openDirectoryChild(current, part); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          if (code === 'ENOTDIR' || code === 'ELOOP') throw new LinuxProcfsCreateError('INVALID_PARENT', error);
          throw error;
        }
        try { await mkdir(`/proc/self/fd/${current.fd}/${part}`, { mode: directoryMode }); }
        catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        try { next = await openDirectoryChild(current, part); }
        catch (error) { throw new LinuxProcfsCreateError('INVALID_PARENT', error); }
      }
      handles.push(next);
      current = next;
    }

    const leaf = fileParts[fileParts.length - 1];
    result = await opener(`/proc/self/fd/${current.fd}/${leaf}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, fileMode);
    if (!(await result.stat()).isFile()) throw new Error('Created target is not a regular file');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    operationError = result === undefined && !(error instanceof LinuxProcfsCreateError) && (code === 'ENOTDIR' || code === 'ELOOP')
      ? new LinuxProcfsCreateError('INVALID_PARENT', error)
      : error;
  }

  const closeOutcomes = await Promise.allSettled(handles.reverse().map(handle => handle.close()));
  const cleanupErrors = closeOutcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
  if (operationError === undefined && cleanupErrors.length === 0) return result!;

  const failures = operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors];
  if (result !== undefined) {
    try { await result.close(); }
    catch (error) { failures.push(error); }
    throw new LinuxProcfsCreateError('CREATE_UNCERTAIN', failures.length === 1 ? failures[0] : new AggregateError(failures));
  }
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'Descriptor-relative file creation failed');
}
