import { createHash } from 'node:crypto';
import {
  ACCEPTED_IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, readImageSize, sniffImageType,
  type AcceptedImageType
} from '../../shared/images';

/** Recover an existing media id from canonical stored bytes. Never write or inline those bytes. */
export function projectStoredImage(data: unknown, mimeType: unknown): { id: string; mimeType: string } | null {
  if (typeof data !== 'string' || data.length > MAX_IMAGE_BASE64_CHARS || data.length % 4 !== 0 ||
      typeof mimeType !== 'string' || !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(mimeType) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.byteLength > MAX_IMAGE_BYTES || bytes.toString('base64') !== data ||
      sniffImageType(bytes) !== mimeType) return null;
  const size = readImageSize(bytes, mimeType as AcceptedImageType);
  if (!size || size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION ||
      size.width * size.height > MAX_IMAGE_PIXELS) return null;
  return { id: createHash('sha256').update(bytes).digest('hex'), mimeType };
}
