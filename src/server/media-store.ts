/**
 * The immutable, authenticated media store.
 *
 * One accepted image becomes one object under `<data root>/media/<sha256>.bin`, mode 0o600, keyed by
 * the hash of the stored bytes, so identical bytes are one object and an existing object is never
 * rewritten. Nothing is ever deleted by this process: retention is the life of the data root, and
 * removing an object is a deliberate operator action (docs/MEDIA.md).
 *
 * Bytes are the only evidence. The format is sniffed from magic bytes, the declared pixel size is read
 * from the container header before anything is decoded, and the bytes are decoded, oriented, resized
 * and re-encoded through the documented `ImageProcessor` the pinned packages already ship
 * (`@earendil-works/pi-durable/images/node`). An image that cannot be decoded is refused rather than
 * stored unverified.
 *
 * The container is validated too: `<data root>/media` must be a real directory this process can
 * write, and it is never followed through a symlink, so an image is never written somewhere the
 * documented layout does not own and a broken data root is refused by name rather than as an
 * unclassified failure (docs/MEDIA.md).
 *
 * Metadata honesty: the processor returns an image within the limits unchanged when it is already
 * upright and small enough, and re-encodes it otherwise. A re-encoded image carries no metadata at all
 * because it is re-encoded from pixels. An image passed through unchanged keeps whatever it carried,
 * so an image whose EXIF points at a GPS IFD, or carries an orientation tag, is refused outright
 * rather than stored while claiming a stripping that did not happen.
 */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node';
import type { ImageLimits, ImageProcessor } from '@earendil-works/pi-durable/tools';
import { safePath } from './paths';
import {
  IMAGE_CAPABILITY,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MEDIA_ID_PATTERN,
  readImageSize,
  scanImageMetadata,
  sniffImageType,
  type AcceptedImageType,
  type MediaRefusalCode,
  type MediaView
} from '../shared/images';

/**
 * The base64 the processor may produce for one image: 4,500,000 characters, which is 4.29 MiB.
 *
 * That is deliberately *below* the pinned package's own default, which is
 * `DEFAULT_IMAGE_LIMITS.maxBytes = 4.5 * 1024 * 1024` = 4,718,592 characters (itself below
 * Anthropic's documented 5 MB inline limit), so this application is the stricter of the two and the
 * comment and the value agree exactly. The raw cap above is 4 MiB (4,194,304 bytes), so an image near
 * that cap is re-encoded down rather than sent whole.
 */
export const MAX_PREPARED_BASE64_BYTES = 4_500_000;

/**
 * The code a *container* refusal is reported with. The media directory not being a usable directory is
 * a server-side condition of the data root, not a refusal of one image, so it carries a code of its own
 * alongside the per-image ones above.
 */
export const MEDIA_CONTAINER_CODE = 'media-container';

/**
 * The media container `<data root>/media` is not a usable directory: a symlink, not a directory, or
 * one this process cannot write. Raised before any image work, and answered by the upload route as
 * `503` with code `media-container`.
 */
export class MediaContainerError extends Error {
  readonly code: string = MEDIA_CONTAINER_CODE;
  constructor(reason: string) { super(reason); this.name = 'MediaContainerError'; }
}

export interface MediaRefusal { ok: false; code: MediaRefusalCode; reason: string }
export interface MediaRecord extends MediaView { ok: true }
export type MediaAcceptance = MediaRecord | MediaRefusal;

/** Human-facing megabytes for one refusal, so the reason names the rule the caller broke. */
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(0);

export class MediaStore {
  private processor: Promise<ImageProcessor> | undefined;
  constructor(private readonly dataRoot: string) {}

  /** Photon loads once per process; the documented Node processor keeps its worker alive only while it works. */
  private images(): Promise<ImageProcessor> {
    this.processor ??= createNodePhotonImages();
    return this.processor;
  }

  /**
   * Validate and store one image, or refuse with the reason and a stable code. Nothing is written for
   * a refused image.
   */
  async accept(bytes: Uint8Array): Promise<MediaAcceptance> {
    // The container first: a data root whose media directory is a symlink, is not a directory, or
    // cannot be written refuses every image with its own reason, before any byte is decoded.
    await this.container();
    // A copy in a fresh, unpooled buffer: Photon transfers the buffer to its worker, and a Node
    // Buffer's pooled backing store cannot be transferred.
    const raw = new Uint8Array(bytes);
    if (raw.byteLength > MAX_IMAGE_BYTES) return refuse('bytes', 'An image may be at most ' + mb(MAX_IMAGE_BYTES) + ' MB. This one is bigger.');
    const type = sniffImageType(raw);
    if (type === null) return refuse('type', 'Only JPEG, PNG and WebP images are accepted; these bytes are not one.');
    const declared = readImageSize(raw, type);
    if (declared === null) return refuse('decode', 'This file is named or typed like an image, but its header is not a readable ' + label(type) + '.');
    if (declared.width * declared.height > MAX_IMAGE_PIXELS)
      return refuse('pixels', 'This image is ' + declared.width + 'x' + declared.height + ' (' + (declared.width * declared.height / 1e6).toFixed(1) + ' megapixels); at most ' + (MAX_IMAGE_PIXELS / 1e6).toFixed(0) + ' megapixels are accepted.');
    const prepared = await this.prepare(raw, type);
    if (prepared === undefined) return refuse('decode', 'These bytes could not be decoded, so the image was not stored.');
    const stored = new Uint8Array(Buffer.from(prepared.data, 'base64'));
    // The stored bytes are sniffed and measured again: bookkeeping is never trusted over the bytes.
    const storedType = sniffImageType(stored), storedSize = readImageSize(stored, storedType ?? type);
    if (storedType === null || storedSize === null) return refuse('decode', 'The processed image could not be verified, so it was not stored.');
    if (storedSize.width > MAX_IMAGE_DIMENSION || storedSize.height > MAX_IMAGE_DIMENSION || storedSize.width * storedSize.height > MAX_IMAGE_PIXELS)
      return refuse('dimension', 'This image is ' + storedSize.width + 'x' + storedSize.height + '; at most ' + MAX_IMAGE_DIMENSION + ' pixels on either side are accepted.');
    const reencoded = Boolean(prepared.resized || prepared.convertedFrom || !sameBytes(raw, stored));
    const metadata = scanImageMetadata(raw, type);
    // Fail closed: the processor returns an upright, small image unchanged, so any EXIF it carries
    // on that path cannot be removed. Refuse rather than store it while claiming a stripping.
    if (!reencoded && metadata.gps)
      return refuse('metadata', 'This image carries EXIF location data that cannot be removed without re-encoding it, so it was not stored.');
    if (!reencoded && metadata.orientation !== null)
      return refuse('metadata', 'This image carries an EXIF orientation that cannot be removed without re-encoding it, so it was not stored.');
    const id = createHash('sha256').update(stored).digest('hex');
    await this.write(id, stored);
    const note = describe(prepared, reencoded, metadata.exif, type, storedType);
    return { ok: true, id, mimeType: storedType, bytes: stored.byteLength, width: storedSize.width, height: storedSize.height, reencoded, note, requires: Object.freeze([IMAGE_CAPABILITY]) };
  }

  /**
   * The stored bytes and their sniffed type, or `null`. The id is a hash and never a path: an id that
   * is not 64 hex characters is unknown, and a stored path that is a symlink or outside the media
   * directory is refused by the same contained-path helper the rest of the application uses.
   */
  async get(id: string): Promise<{ bytes: Uint8Array; mimeType: AcceptedImageType } | null> {
    if (!MEDIA_ID_PATTERN.test(id)) return null;
    let path: string;
    try { path = await safePath(this.dataRoot, 'media/' + id + '.bin'); }
    catch { return null; }
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const bytes = new Uint8Array(await readFile(path));
      const type = sniffImageType(bytes);
      if (type === null) return null;
      return { bytes, mimeType: type };
    } catch { return null; }
  }

  /**
   * The container is a real directory this process can write, and it is never followed through a
   * symlink. A container that does not exist yet is not an error: the first accepted image creates it
   * 0700, exactly as this store always has. Everything else is refused by name.
   */
  private async container(): Promise<void> {
    const media = join(this.dataRoot, 'media');
    let info: Stats;
    try { info = await lstat(media); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new MediaContainerError('The media directory of this data root could not be inspected, so no image was stored: ' + (error as Error).message);
    }
    if (info.isSymbolicLink())
      throw new MediaContainerError('The media directory of this data root is a symbolic link, and a symlink is never followed, so no image was stored in it. Replace it with a real directory and try again.');
    if (!info.isDirectory())
      throw new MediaContainerError('The media directory of this data root is not a directory, so no image was stored in it. Move it aside and let the application create its own.');
    try { await access(media, constants.W_OK | constants.X_OK); }
    catch {
      throw new MediaContainerError('The media directory of this data root is not writable by this process, so no image was stored in it. It is written 0700, owned by the account that runs the application.');
    }
  }

  private async prepare(bytes: Uint8Array, type: AcceptedImageType) {
    const limits: ImageLimits = { maxWidth: MAX_IMAGE_DIMENSION, maxHeight: MAX_IMAGE_DIMENSION, maxBytes: MAX_PREPARED_BASE64_BYTES };
    try {
      const processor = await this.images();
      return await processor.prepare(bytes, type, limits);
    } catch {
      // A processor that cannot run (or cannot transfer its input) is a refusal, never an acceptance.
      return undefined;
    }
  }

  private async write(id: string, bytes: Uint8Array): Promise<void> {
    let path: string;
    try { path = await safePath(this.dataRoot, 'media/' + id + '.bin', true); }
    catch (error) {
      // A container that stopped being a usable directory between the check above and this write is
      // the same condition, and it is named the same way.
      throw new MediaContainerError('The media directory of this data root is not a usable directory, so no image was stored in it: ' + (error as Error).message);
    }
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Identical bytes are already the same object: it is never rewritten.
      if (code === 'EEXIST') return;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR' || code === 'EROFS')
        throw new MediaContainerError('The media directory of this data root could not be written, so no image was stored in it: ' + (error as Error).message);
      throw error;
    }
  }
}

function refuse(code: MediaRefusalCode, reason: string): MediaRefusal { return { ok: false, code, reason }; }
function label(type: AcceptedImageType): string { return type === 'image/jpeg' ? 'JPEG' : type === 'image/png' ? 'PNG' : 'WebP'; }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) if (a[index] !== b[index]) return false;
  return true;
}
function describe(prepared: Awaited<ReturnType<ImageProcessor['prepare']>>, reencoded: boolean, hadExif: boolean, from: AcceptedImageType, to: AcceptedImageType): string {
  const parts: string[] = [];
  if (prepared?.resized) parts.push('resized to ' + prepared.resized.to.width + '\u00d7' + prepared.resized.to.height);
  if (to !== from) parts.push('re-encoded from ' + label(from) + ' to ' + label(to));
  else if (reencoded) parts.push('re-encoded');
  if (reencoded && hadExif) parts.push('EXIF removed by re-encoding');
  return parts.join('; ');
}
