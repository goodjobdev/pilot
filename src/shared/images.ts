/**
 * Image rules shared by the server and the composer. Pure: no Node and no Durable import, so the
 * browser reads the same constants and types the server enforces.
 *
 * Everything here is byte-level. The format is sniffed from magic bytes, the declared pixel size is
 * read from the container header before anything is decoded, and metadata is read only far enough to
 * find an EXIF orientation tag and a GPS pointer. A client's content type and file name are never
 * consulted: `sniffImageType` answers what the bytes are, and nothing else does.
 */

/** The formats this application accepts, as sniffed content types. */
export type AcceptedImageType = 'image/jpeg' | 'image/png' | 'image/webp';
export const ACCEPTED_IMAGE_TYPES: readonly AcceptedImageType[] = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/** Bytes of one uploaded image, before any processing. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Pixels of one uploaded image, checked from the header before anything is decoded. */
export const MAX_IMAGE_PIXELS = 25_000_000;
/** Pixels on either side of one stored image, checked again after any resize. */
export const MAX_IMAGE_DIMENSION = 2000;
/** Images accepted in one message. */
export const MAX_IMAGES_PER_MESSAGE = 6;
/** The characters a base64 body may carry for one image (4 MiB of bytes, rounded up). */
export const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
/** The capability a stored image needs from the model that receives it. */
export const IMAGE_CAPABILITY = 'image';
/** A media id is the hex SHA-256 of the stored bytes: never a path, and never guessable into one. */
export const MEDIA_ID_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Why a *set* of images was refused, alongside the per-image codes above. A message-level refusal is
 * not a per-image one, so it carries one of these instead of a `MediaRefusalCode`.
 */
export type MediaBatchRefusalCode = 'too-many-images' | 'unknown-media';

/** The code a message carrying more images than one message may hold is refused with. */
export const TOO_MANY_IMAGES_CODE: MediaBatchRefusalCode = 'too-many-images';

/** The reason a message carrying more images than one message may hold is refused with. */
export function tooManyImagesReason(count: number): string {
  return 'A message may carry at most ' + MAX_IMAGES_PER_MESSAGE + ' images; this one carries ' + count +
    '. Remove ' + (count - MAX_IMAGES_PER_MESSAGE) + ' of them and send again.';
}

/**
 * One gesture's files, with a file it lists more than once taken once.
 *
 * A paste or a drop can hand the same File over twice (once through `items`, once through `files`),
 * and enqueueing it twice would produce two items and two uploads for one gesture. Identity and the
 * named-bytes signature both collapse, because the same File object always shares the signature.
 */
export function uniqueImageFiles(files: readonly File[]): File[] {
  const seen = new Set<string>(), result: File[] = [];
  for (const file of files) {
    const signature = [file.name, file.size, file.lastModified, file.type].join('\u0000');
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(file);
  }
  return result;
}

export interface ImageSize { width: number; height: number }
/** What the bytes declare about themselves. `null` orientation means no orientation tag is present. */
export interface ImageMetadata { exif: boolean; gps: boolean; orientation: number | null; other: boolean }
export interface ImageInspection { type: AcceptedImageType; width: number; height: number; pixels: number; metadata: ImageMetadata }

/** The sniffed type of these bytes, or `null` when they are not a JPEG, PNG or WebP. */
export function sniffImageType(bytes: Uint8Array): AcceptedImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  return null;
}

/** The declared pixel size from the container header, or `null` when the header cannot be read. */
export function readImageSize(bytes: Uint8Array, type: AcceptedImageType): ImageSize | null {
  if (type === 'image/png') return pngSize(bytes);
  if (type === 'image/jpeg') return jpegSize(bytes);
  return webpSize(bytes);
}

/** Everything the admission rules need: format, declared size and a metadata summary. */
export function inspectImage(bytes: Uint8Array): ImageInspection | null {
  const type = sniffImageType(bytes);
  if (type === null) return null;
  const size = readImageSize(bytes, type);
  if (size === null) return null;
  return { type, width: size.width, height: size.height, pixels: size.width * size.height, metadata: scanImageMetadata(bytes, type) };
}

/** What the bytes carry: whether EXIF is present, whether it points at a GPS IFD, an orientation tag, and any other annotation. */
export function scanImageMetadata(bytes: Uint8Array, type: AcceptedImageType): ImageMetadata {
  if (type === 'image/jpeg') return jpegMetadata(bytes);
  if (type === 'image/png') return pngMetadata(bytes);
  return webpMetadata(bytes);
}

/** Whether a model accepts image input, from its declared input modalities. An unknown model accepts nothing. */
export function modelAcceptsImages(model: { input?: readonly string[] } | null | undefined): boolean {
  return Array.isArray(model?.input) ? model!.input!.includes(IMAGE_CAPABILITY) : false;
}

/** Why an image was refused, as a stable code the composer can label. */
export type MediaRefusalCode = 'type' | 'bytes' | 'pixels' | 'decode' | 'dimension' | 'metadata' | 'vision';

/** One image the composer has selected: its upload state, its stored facts, or its refusal reason. */
export interface ImageDraft {
  key: string;
  name: string;
  declaredBytes: number;
  status: 'uploading' | 'ready' | 'refused';
  id?: string;
  mimeType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  note?: string;
  reason?: string;
  /** Set when the stored image's preview could not be fetched: its own condition, never a refusal. */
  previewError?: string;
}

/** One accepted image as the upload route reports it. */
export interface MediaView {
  id: string; mimeType: string; bytes: number; width: number; height: number;
  reencoded: boolean; note: string | null; requires: readonly string[];
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || !ascii(bytes, 12, 'IHDR')) return null;
  const width = u32be(bytes, 16), height = u32be(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    // Markers without a length: SOI, TEM and the restart markers.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    // Entropy-coded data begins after SOS, and an image without a frame header before it is malformed.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return null;
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) {
      if (at + 9 > bytes.length) return null;
      const height = (bytes[at + 5] << 8) | bytes[at + 6];
      const width = (bytes[at + 7] << 8) | bytes[at + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const size = u32le(bytes, at + 4), data = at + 8;
    if (id === 'VP8X') {
      if (data + 10 > bytes.length) return null;
      return { width: 1 + u24le(bytes, data + 4), height: 1 + u24le(bytes, data + 7) };
    }
    if (id === 'VP8 ') {
      if (data + 10 > bytes.length) return null;
      if (!(bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a)) return null;
      const width = u16le(bytes, data + 6) & 0x3fff, height = u16le(bytes, data + 8) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (id === 'VP8L') {
      if (data + 5 > bytes.length || bytes[data] !== 0x2f) return null;
      const bits = u32le(bytes, data + 1);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    // RIFF chunks are padded to an even size.
    at = data + size + (size % 2);
  }
  return null;
}

function jpegMetadata(bytes: Uint8Array): ImageMetadata {
  const result: ImageMetadata = { exif: false, gps: false, orientation: null, other: false };
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return result;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return result;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return result;
    const payload = at + 4;
    if (marker === 0xe1 && ascii(bytes, payload, 'Exif') && bytes[payload + 4] === 0 && bytes[payload + 5] === 0) {
      result.exif = true;
      mergeTiff(result, bytes, payload + 6);
    } else if (marker === 0xe1 && ascii(bytes, payload, 'http')) result.other = true;
    else if (marker === 0xfe || marker === 0xed) result.other = true;
    at += 2 + length;
  }
  return result;
}

function pngMetadata(bytes: Uint8Array): ImageMetadata {
  const result: ImageMetadata = { exif: false, gps: false, orientation: null, other: false };
  if (bytes.length < 8) return result;
  // A PNG chunk is a length, then its type, then its data: the length sits four bytes before the type.
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = u32be(bytes, at);
    const id = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = at + 8;
    if (size > bytes.length) return result;
    if (id === 'eXIf') { result.exif = true; mergeTiff(result, bytes, data); }
    else if (id === 'tEXt' || id === 'zTXt' || id === 'iTXt' || id === 'tIME') result.other = true;
    if (id === 'IEND') return result;
    at = data + size + 4;
  }
  return result;
}

function webpMetadata(bytes: Uint8Array): ImageMetadata {
  const result: ImageMetadata = { exif: false, gps: false, orientation: null, other: false };
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const size = u32le(bytes, at + 4), data = at + 8;
    if (size > bytes.length) return result;
    if (id === 'EXIF') { result.exif = true; mergeTiff(result, bytes, ascii(bytes, data, 'Exif') ? data + 6 : data); }
    else if (id === 'XMP ') result.other = true;
    at = data + size + (size % 2);
  }
  return result;
}

/** The orientation tag (0x0112) and the GPS IFD pointer (0x8825) of one TIFF header, wherever it sits. */
function mergeTiff(result: ImageMetadata, bytes: Uint8Array, start: number): void {
  if (start < 0 || start + 8 > bytes.length) return;
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  if (!little && !(bytes[start] === 0x4d && bytes[start + 1] === 0x4d)) return;
  const u16 = (at: number): number => little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1];
  const u32 = (at: number): number => little
    ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
    : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  const directory = start + u32(start + 4);
  if (directory + 2 > bytes.length) return;
  const entries = u16(directory);
  for (let index = 0; index < entries && index < 4096; index++) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > bytes.length) return;
    const tag = u16(entry);
    if (tag === 0x0112 && u16(entry + 2) === 3) result.orientation = u16(entry + 8);
    else if (tag === 0x8825) result.gps = true;
  }
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index++) if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}
function u32be(bytes: Uint8Array, at: number): number { return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0; }
function u32le(bytes: Uint8Array, at: number): number { return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0; }
function u24le(bytes: Uint8Array, at: number): number { return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16); }
function u16le(bytes: Uint8Array, at: number): number { return bytes[at] | (bytes[at + 1] << 8); }
