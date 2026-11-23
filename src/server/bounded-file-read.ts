import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export class BoundedFileReadError extends Error {
  constructor(public readonly code: 'OVERSIZE' | 'NOT_REGULAR' | 'SYMLINK' | 'UNSUPPORTED' | 'CHANGED') { super(code); }
}

/** Read from one opened leaf, refusing non-regular files and never consuming more than limit + 1 bytes. */
export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit === Number.MAX_SAFE_INTEGER) throw new RangeError('Invalid file read limit');
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW <= 0 ||
      typeof constants.O_NONBLOCK !== 'number' || constants.O_NONBLOCK <= 0)
    throw new BoundedFileReadError('UNSUPPORTED');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new BoundedFileReadError('SYMLINK');
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new BoundedFileReadError('NOT_REGULAR');
    if (info.size > BigInt(limit)) throw new BoundedFileReadError('OVERSIZE');
    const buffer = Buffer.allocUnsafe(Number(info.size) + 1);
    let total=0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) throw new BoundedFileReadError('OVERSIZE');
    const after = await handle.stat({ bigint: true });
    if (after.size > BigInt(limit)) throw new BoundedFileReadError('OVERSIZE');
    if (BigInt(total) !== info.size || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs)
      throw new BoundedFileReadError('CHANGED');
    return buffer.subarray(0,total);
  } finally { await handle.close(); }
}
