// Uninstalled, in-memory prototype; this is not a filesystem or archive reader.
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const LIMITS = Object.freeze({ entries: 1024, pathBytes: 240, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 });
const DOMAIN = 'pilot-static-artifact-manifest-v1\0';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('Invalid static artifact'); };

/**
 * Snapshot caller-supplied file bytes. Entries have exactly {path, type, bytes}
 * for files or {path, type} for directories. No metadata is accepted.
 * This does not establish provenance, a coherent filesystem snapshot, safe
 * archive traversal, or suitability for production deployment.
 */
export function createStaticArtifact(entries) {
  if (types.isProxy(entries) || !Array.isArray(entries)) fail();
  const entryCount = Object.getOwnPropertyDescriptor(entries, 'length').value;
  if (entryCount === 0 || entryCount > LIMITS.entries) fail();
  const paths = new Map();
  const explicit = new Set();
  const files = [];
  let totalBytes = 0;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    const element = Object.getOwnPropertyDescriptor(entries, String(entryIndex));
    if (!element || !Object.hasOwn(element, 'value')) fail();
    const entry = element.value;
    if (!entry || typeof entry !== 'object' || types.isProxy(entry) || Array.isArray(entry)) fail();
    const keys = Reflect.ownKeys(entry);
    const descriptors = Object.create(null);
    for (const key of keys) {
      if (key !== 'path' && key !== 'type' && key !== 'bytes') fail();
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
      descriptors[key] = descriptor.value;
    }
    const { path, type, bytes } = descriptors;
    if (typeof path !== 'string' || (type !== 'file' && type !== 'directory')) fail();
    const allowed = type === 'file' ? ['path', 'type', 'bytes'] : ['path', 'type'];
    if (keys.length !== allowed.length || allowed.some((key) => !Object.hasOwn(descriptors, key))) fail();
    // ASCII provides an unambiguous byte order and case-folding rule.
    if (path.length > LIMITS.pathBytes ||
        !/^[A-Za-z0-9._~/-]+$/.test(path)) fail();
    const components = path.split('/');
    if (components.some((component) => !component || component === '.' || component === '..')) fail();
    for (let i = 1; i <= components.length; i++) {
      const prefix = components.slice(0, i).join('/');
      const folded = prefix.toLowerCase();
      const existing = paths.get(folded);
      const kind = i === components.length ? type : 'directory';
      if (existing && (existing.path !== prefix || existing.type !== kind)) fail();
      if (i === components.length && explicit.has(folded)) fail();
      paths.set(folded, { path: prefix, type: kind });
      if (i === components.length) explicit.add(folded);
    }
    if (type === 'file') {
      if (types.isProxy(bytes) || !types.isUint8Array(bytes)) fail();
      const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
      const buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get.call(bytes);
      const offset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get.call(bytes);
      const length = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get.call(bytes);
      if (types.isSharedArrayBuffer(buffer) || length > LIMITS.fileBytes || totalBytes + length > LIMITS.totalBytes) fail();
      // Copy before hashing; no reference to mutable caller bytes is retained.
      const snapshot = Buffer.from(new Uint8Array(buffer, offset, length));
      totalBytes += snapshot.length;
      files.push({ path, bytes: snapshot });
    }
  }
  if (!files.some((file) => file.path === 'index.html')) fail();
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const manifest = Object.freeze({
    version: 1,
    totalBytes,
    files: Object.freeze(files.map(({ path, bytes }) => Object.freeze({ path, size: bytes.length, sha256: sha256(bytes) }))),
  });
  // Canonical encoding: UTF-8 JSON, properties in the order constructed above,
  // no whitespace, ASCII paths, lower-case hex digests; domain prefix is UTF-8.
  const releaseId = sha256(Buffer.concat([Buffer.from(DOMAIN, 'utf8'), Buffer.from(JSON.stringify(manifest), 'utf8')]));
  const revalidate = () => {
    if (files.length !== manifest.files.length || files.reduce((sum, file) => sum + file.bytes.length, 0) !== manifest.totalBytes ||
        files.some((file, i) => file.path !== manifest.files[i].path || file.bytes.length !== manifest.files[i].size || sha256(file.bytes) !== manifest.files[i].sha256)) fail();
  };
  return Object.freeze({
    manifest,
    releaseId,
    // Each read revalidates private primitive bytes and returns fresh copies.
    readFiles() {
      revalidate();
      return files.map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) }));
    },
  });
}
