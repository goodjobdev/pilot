import { constants } from 'node:fs';
import { open, opendir, statfs } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

const PROC_SUPER_MAGIC = 0x9fa0;
// Linux UAPI O_PATH; Node does not expose this flag in fs.constants.
const O_PATH = 0x200000;
const DIRECTORY_FLAGS = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LEAF_FLAGS = O_PATH | constants.O_NOFOLLOW;
const MAX_PATH_COMPONENTS = 128;
const MAX_PATH_BYTES = 4096;
interface LinuxProcfsListWorkLimits {
  maxDepth: number;
  maxVisitedDirectories: number;
  maxVisitedEntries: number;
  maxRelativePathBytes: number;
}

const PRODUCTION_WORK_LIMITS: LinuxProcfsListWorkLimits = {
  maxDepth: 64,
  maxVisitedDirectories: 50_000,
  maxVisitedEntries: 200_000,
  maxRelativePathBytes: 4096
};
const DIRECTORY_BUFFER_SIZE = 32;

export class LinuxProcfsListError extends Error {
  constructor(public readonly code: 'BACKEND_UNAVAILABLE' | 'WORK_LIMIT') {
    super(code === 'BACKEND_UNAVAILABLE'
      ? 'Linux procfs descriptor-relative listing is unavailable'
      : 'Documentation listing exceeds its safe traversal budget');
  }
}

export interface LinuxProcfsListEntry {
  path: string;
  size: number;
  mtime: Date;
}

export interface LinuxProcfsListOptions {
  /** Deterministic race-test seam, called after a directory has been pinned. */
  onDirectoryPinned?: (relativePath: string) => void | Promise<void>;
  /** Internal/test callers may lower, but never raise, the fixed production budgets. */
  workLimits?: Partial<LinuxProcfsListWorkLimits>;
}

function unavailable(): LinuxProcfsListError {
  return new LinuxProcfsListError('BACKEND_UNAVAILABLE');
}

function sameObject(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function splitAbsolute(path: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\\') || path.includes('\0') || Buffer.byteLength(path) > MAX_PATH_BYTES) {
    throw new Error('Unsafe project root');
  }
  if (path === '/') return [];
  const parts = path.slice(1).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe project root');
  if (parts.length > MAX_PATH_COMPONENTS) throw new Error('Project root exceeds the traversal limit');
  return parts;
}

async function verifyProcfs(): Promise<void> {
  if (process.platform !== 'linux') throw unavailable();
  try {
    if ((await statfs('/proc')).type !== PROC_SUPER_MAGIC) throw unavailable();
    const held = await open('.', O_PATH | constants.O_DIRECTORY);
    try {
      const expected = await held.stat({ bigint: true });
      const viaProc = await open(`/proc/self/fd/${held.fd}`, O_PATH | constants.O_DIRECTORY);
      try {
        if (!sameObject(expected, await viaProc.stat({ bigint: true }))) throw unavailable();
      } finally { await viaProc.close(); }
    } finally { await held.close(); }
  } catch { throw unavailable(); }
}

async function openDirectory(parent: FileHandle, name: string): Promise<FileHandle> {
  const handle = await open(`/proc/self/fd/${parent.fd}/${name}`, DIRECTORY_FLAGS);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error('Path component is not a directory');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Lists regular files beneath pinned directories using Linux procfs descriptor paths only.
 * Directory enumeration is streamed in small chunks. Work/depth limits fail the listing rather
 * than returning a partial result that looks complete. The result cap still stops traversal at
 * the same point as the prior DocStore implementation, before final path sorting.
 * This does not establish root identity, prevent pinned-directory renames or mount crossings,
 * reject hard links, or isolate against same-UID mutation. No pathname fallback is available.
 */
export async function listLinuxProcfsRegularFilesBeneath(
  rootAbsolute: string,
  maxEntries: number,
  include: (relativePath: string) => boolean,
  options: LinuxProcfsListOptions = {},
): Promise<LinuxProcfsListEntry[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > 5000) throw new Error('Invalid listing limit');
  if (typeof include !== 'function') throw new Error('A listing filter is required');
  const rootParts = splitAbsolute(rootAbsolute);
  const workLimits = { ...PRODUCTION_WORK_LIMITS, ...options.workLimits };
  for (const [name, ceiling] of Object.entries(PRODUCTION_WORK_LIMITS) as [keyof typeof PRODUCTION_WORK_LIMITS, number][]) {
    const value = workLimits[name];
    if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) throw new Error(`Invalid listing work limit: ${name}`);
  }
  await verifyProcfs();

  const handles: FileHandle[] = [];
  try {
    let current = await open('/', DIRECTORY_FLAGS);
    handles.push(current);
    for (const part of rootParts) {
      current = await openDirectory(current, part);
      handles.push(current);
    }
    const results: LinuxProcfsListEntry[] = [];
    let visitedDirectories = 0;
    let visitedEntries = 0;
    const walk = async (directory: FileHandle, relative: string, depth: number): Promise<void> => {
      if (results.length >= maxEntries) return;
      if (depth > workLimits.maxDepth) throw new LinuxProcfsListError('WORK_LIMIT');
      if (++visitedDirectories > workLimits.maxVisitedDirectories) throw new LinuxProcfsListError('WORK_LIMIT');
      await options.onDirectoryPinned?.(relative);
      const stream = await opendir(`/proc/self/fd/${directory.fd}`, { bufferSize: DIRECTORY_BUFFER_SIZE });
      try {
        while (true) {
          const entry = await stream.read();
          if (entry === null || results.length >= maxEntries) return;
          if (++visitedEntries > workLimits.maxVisitedEntries) throw new LinuxProcfsListError('WORK_LIMIT');
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          if (Buffer.byteLength(child) > workLimits.maxRelativePathBytes) throw new LinuxProcfsListError('WORK_LIMIT');
          if (entry.isDirectory()) {
            if (!include(child + '/placeholder.md')) continue;
            let nested: FileHandle;
            try { nested = await openDirectory(directory, entry.name); }
            catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') continue;
              throw error;
            }
            try { await walk(nested, child, depth + 1); }
            finally { await nested.close(); }
          } else if (entry.isFile() && include(child)) {
            let leaf: FileHandle;
            try { leaf = await open(`/proc/self/fd/${directory.fd}/${entry.name}`, LEAF_FLAGS); }
            catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') continue;
              throw error;
            }
            try {
              const info = await leaf.stat();
              if (!info.isFile()) continue;
              results.push({ path: child, size: info.size, mtime: info.mtime });
            } finally { await leaf.close(); }
          }
        }
      } finally {
        await stream.close();
      }
    };
    await walk(current, '', 0);
    return results;
  } finally {
    const closing = handles.reverse();
    const results = await Promise.allSettled(closing.map(handle => handle.close()));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
