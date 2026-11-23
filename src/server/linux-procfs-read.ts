import { constants } from 'node:fs';
import { open, statfs } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

const PROC_SUPER_MAGIC = 0x9fa0;
// Linux UAPI O_PATH; Node does not expose this flag in fs.constants.
const O_PATH = 0x200000;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_PATH_COMPONENTS = 128;
const MAX_PATH_BYTES = 4096;
const DIRECTORY_FLAGS = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LEAF_PIN_FLAGS = O_PATH | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

export class LinuxProcfsReadError extends Error {
  constructor(public readonly code: 'BACKEND_UNAVAILABLE' | 'NOT_REGULAR' | 'OVERSIZE' | 'CHANGED') {
    super((({ BACKEND_UNAVAILABLE: 'Linux procfs descriptor-relative reads are unavailable', NOT_REGULAR: 'Target is not a regular file', OVERSIZE: 'File exceeds the read limit', CHANGED: 'File changed while being read' }) as Record<typeof code, string>)[code]);
  }
}

function failClosed(): Error {
  return new LinuxProcfsReadError('BACKEND_UNAVAILABLE');
}

function sameObject(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  return sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Fill one size+1 buffer, tolerating short reads while detecting early EOF and growth. */
export async function readBoundedFileBuffer(
  initialSize: bigint,
  maxBytes: number,
  readAt: (buffer: Buffer, offset: number, length: number, position: number) => Promise<number>,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_READ_BYTES || initialSize < 0n || initialSize > BigInt(maxBytes)) {
    throw new LinuxProcfsReadError('OVERSIZE');
  }
  const expected = Number(initialSize);
  const buffer = Buffer.alloc(expected + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = await readAt(buffer, offset, buffer.length - offset, offset);
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - offset) {
      throw new Error('Invalid read result');
    }
    if (bytesRead === 0) {
      if (offset !== expected) throw new LinuxProcfsReadError('CHANGED');
      return buffer.subarray(0, offset);
    }
    offset += bytesRead;
    if (offset > expected) throw new LinuxProcfsReadError('CHANGED');
  }
  throw new LinuxProcfsReadError('CHANGED');
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

export function validateLinuxReadPath(rootAbsolute: string, relativePath: string): void {
  if (typeof rootAbsolute !== 'string' || typeof relativePath !== 'string') throw new Error('Unsafe path');
  // Reject oversized UTF-8 inputs before split() allocates a component array.
  if (Buffer.byteLength(rootAbsolute) + 1 + Buffer.byteLength(relativePath) > MAX_PATH_BYTES) {
    throw new Error('Path exceeds the traversal limit');
  }
  const rootParts = absoluteParts(rootAbsolute);
  const fileParts = relativeParts(relativePath);
  if (rootParts.length + fileParts.length > MAX_PATH_COMPONENTS) throw new Error('Path exceeds the traversal limit');
}

async function verifyProcfs(): Promise<void> {
  if (process.platform !== 'linux') throw failClosed();
  try {
    const info = await statfs('/proc');
    if (info.type !== PROC_SUPER_MAGIC) throw failClosed();

    // Check that the fixed procfs fd path resolves to the object actually held open.
    const held = await open('.', O_PATH | constants.O_DIRECTORY);
    try {
      const expected = await held.stat({ bigint: true });
      const viaProc = await open(`/proc/self/fd/${held.fd}`, O_PATH | constants.O_DIRECTORY);
      try {
        if (!sameObject(expected, await viaProc.stat({ bigint: true }))) throw failClosed();
      } finally {
        await viaProc.close();
      }
    } finally {
      await held.close();
    }
  } catch {
    throw failClosed();
  }
}

async function openDirectoryChild(parent: FileHandle, name: string): Promise<FileHandle> {
  const child = await open(`/proc/self/fd/${parent.fd}/${name}`, DIRECTORY_FLAGS);
  try {
    if (!(await child.stat()).isDirectory()) throw new Error('Path component is not a directory');
    return child;
  } catch (error) {
    await child.close();
    throw error;
  }
}

/**
 * Linux/procfs-only bounded read from a regular file traversed beneath a pinned root.
 * DocStore uses this for document bodies and allowlisted assets; MediaStore uses the hook-free
 * production entry point for stored images. Neither has a portable pathname fallback.
 * It does not assure the root's identity, prevent a pinned parent from being renamed, reject
 * mount crossings or hard links, or protect against same-UID mutation. It is read-only and
 * is not a general write/list containment primitive.
 */
export interface LinuxProcfsReadTestHooks {
  /** Runs after a directory descriptor has been pinned, before traversing its next component. */
  afterDirectoryPinned?: (relativePath: string, fd: number) => Promise<void> | void;
  /** Runs after the leaf O_PATH descriptor is pinned, before opening it for reading. */
  afterLeafPinned?: (fd: number) => Promise<void> | void;
}

export function readLinuxProcfsRegularFileBeneath(
  rootAbsolute: string,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer> {
  return readLinuxProcfsRegularFileBeneathInternal(rootAbsolute, relativePath, maxBytes);
}

/** Test-only synchronization seam; production callers use the hook-free function above. */
export function readLinuxProcfsRegularFileBeneathForTest(
  rootAbsolute: string,
  relativePath: string,
  maxBytes: number,
  hooks: LinuxProcfsReadTestHooks,
): Promise<Buffer> {
  return readLinuxProcfsRegularFileBeneathInternal(rootAbsolute, relativePath, maxBytes, hooks);
}

async function readLinuxProcfsRegularFileBeneathInternal(
  rootAbsolute: string,
  relativePath: string,
  maxBytes: number,
  testHooks?: LinuxProcfsReadTestHooks,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_READ_BYTES) {
    throw new Error(`maxBytes must be between 0 and ${MAX_READ_BYTES}`);
  }
  validateLinuxReadPath(rootAbsolute, relativePath);
  const rootParts = absoluteParts(rootAbsolute);
  const fileParts = relativeParts(relativePath);
  await verifyProcfs();

  const handles: FileHandle[] = [];
  try {
    let current = await open('/', DIRECTORY_FLAGS);
    handles.push(current);
    if (!(await current.stat()).isDirectory()) throw failClosed();
    let directoryPath = '';
    for (const part of rootParts) {
      const next = await openDirectoryChild(current, part);
      handles.push(next);
      current = next;
      directoryPath += '/' + part;
      await testHooks?.afterDirectoryPinned?.(directoryPath, current.fd);
    }

    for (const part of fileParts.slice(0, -1)) {
      const next = await openDirectoryChild(current, part);
      handles.push(next);
      current = next;
      directoryPath += '/' + part;
      await testHooks?.afterDirectoryPinned?.(directoryPath, current.fd);
    }

    const leafName = fileParts[fileParts.length - 1];
    // Pin the leaf without opening it for I/O; reject devices, FIFOs, sockets, and symlinks first.
    const pinnedLeaf = await open(`/proc/self/fd/${current.fd}/${leafName}`, LEAF_PIN_FLAGS);
    handles.push(pinnedLeaf);
    await testHooks?.afterLeafPinned?.(pinnedLeaf.fd);
    const before = await pinnedLeaf.stat({ bigint: true });
    if (!before.isFile()) throw new LinuxProcfsReadError('NOT_REGULAR');
    if (before.size > BigInt(maxBytes)) throw new LinuxProcfsReadError('OVERSIZE');

    // Only after fstat confirms a regular inode do we create a readable descriptor from its pinned fd.
    const leaf = await open(`/proc/self/fd/${pinnedLeaf.fd}`, READ_FLAGS);
    handles.push(leaf);
    const opened = await leaf.stat({ bigint: true });
    if (!opened.isFile() || !sameObject(before, opened)) throw new Error('Opened file does not match the pinned regular file');

    const bytes = await readBoundedFileBuffer(before.size, maxBytes, async (buffer, offset, length, position) => {
      return (await leaf.read(buffer, offset, length, position)).bytesRead;
    });

    const after = await leaf.stat({ bigint: true });
    if (!sameSnapshot(before, after) || !sameObject(opened, after) || BigInt(bytes.length) !== after.size) {
      throw new LinuxProcfsReadError('CHANGED');
    }
    return bytes;
  } finally {
    const closing = handles.reverse();
    const results = await Promise.allSettled(closing.map(handle => handle.close()));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
