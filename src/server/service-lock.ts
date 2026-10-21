import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath, unlink, type FileHandle} from 'node:fs/promises';
import {resolve} from 'node:path';

export type LockPurpose = 'service' | 'backup' | 'restore';
export type ProcessObservation =
  | {state: 'active'; startIdentity?: string; bootIdentity?: string}
  | {state: 'dead'}
  | {state: 'inaccessible' | 'unknown'; reason?: string};

export interface LockIdentity {
  rootId: string;
  releaseId: string;
  schemaId: string;
  purpose: LockPurpose;
}
export interface ProcessIdentity {
  readonly pid: number;
  readonly startIdentity?: string;
  readonly bootIdentity?: string;
}
export interface ServiceLockMetadata extends LockIdentity {

  readonly version: 1;
  readonly root: string;
  readonly nonce: string;
  readonly createdAt: string;
  readonly process: ProcessIdentity;
}
export interface LockDependencies {
  now?: () => Date;
  nonce?: () => string;
  currentProcess?: () => ProcessIdentity;
  observeProcess?: (pid: number) => Promise<ProcessObservation> | ProcessObservation;
  /** Deterministic failure-injection seam; production callers should omit this. */
  initialize?: (handle: FileHandle, contents: string) => Promise<void>;
}
export type LockClassification = 'absent' | 'active' | 'proven-dead' | 'ambiguous';
export interface LockInspection {
  classification: LockClassification;
  metadata?: ServiceLockMetadata;
  reason: string;
  expectedVersionMatch?: boolean;
}
export interface AcquireOptions extends LockIdentity, LockDependencies {
  root: string;
}
export interface ServiceLockHandle {
  readonly metadata: ServiceLockMetadata;
  release(): Promise<void>;
}

const defaultCurrentProcess = (): ProcessIdentity => ({pid: process.pid});
const defaultObserveProcess = (_pid: number): ProcessObservation => ({
  state: 'unknown', reason: 'No portable process-start/boot observer is configured',
});
const lockPathFor = (root: string) => resolve(root, 'service.lock');

async function canonicalRoot(root: string): Promise<string> {
  const requested = resolve(root);
  const info = await lstat(requested);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Root must be a non-symlink directory');
  const canonical = await realpath(requested);
  return canonical;
}
function validMetadata(value: unknown): value is ServiceLockMetadata {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<ServiceLockMetadata>;
  return m.version === 1 && typeof m.root === 'string' && typeof m.rootId === 'string' &&
    typeof m.releaseId === 'string' && typeof m.schemaId === 'string' &&
    ['service', 'backup', 'restore'].includes(m.purpose ?? '') &&
    typeof m.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(m.nonce) &&
    typeof m.createdAt === 'string' && Number.isFinite(Date.parse(m.createdAt)) &&
    !!m.process && Number.isSafeInteger(m.process.pid) && m.process.pid! > 0 &&
    (m.process.startIdentity === undefined || typeof m.process.startIdentity === 'string') &&
    (m.process.bootIdentity === undefined || typeof m.process.bootIdentity === 'string');
}
/** Copy only the declared process-identity fields; never spread a caller-supplied object. */
function copyProcessIdentity(value: ProcessIdentity): ProcessIdentity {
  const copy: {pid: number; startIdentity?: string; bootIdentity?: string} = {pid: value.pid};
  if (value.startIdentity !== undefined) copy.startIdentity = value.startIdentity;
  if (value.bootIdentity !== undefined) copy.bootIdentity = value.bootIdentity;
  return copy;
}
/**
 * Validate the exact bytes that will land on disk before exclusive creation. Serialization can
 * diverge from the in-memory record (for example a dependency that supplies `toJSON`), and an
 * unreadable record would strand a successful acquisition: inspection would reject it and release
 * could never verify ownership. Refusing here keeps that outcome impossible.
 */
function metadataFromSerialized(json: string): ServiceLockMetadata {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error('Serialized lock metadata is not valid JSON'); }
  if (!validMetadata(parsed)) throw new Error('Serialized lock metadata is unreadable; refusing to create the lock');
  if (JSON.stringify(parsed) !== json) throw new Error('Serialized lock metadata diverges from the intended record');
  return parsed;
}
async function readLock(path: string): Promise<{metadata?: ServiceLockMetadata; reason?: string}> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {reason: 'absent'};
    return {reason: 'lock path cannot be inspected'};
  }
  if (!info.isFile() || info.isSymbolicLink()) return {reason: 'lock path is not a regular file'};
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return {reason: 'lock changed while being read'};
    if (opened.size > 16_384) return {reason: 'lock metadata exceeds size limit'};
    const text = await handle.readFile({encoding: 'utf8'});
    if (Buffer.byteLength(text, 'utf8') > 16_384) return {reason: 'lock metadata exceeds size limit'};
    const parsed: unknown = JSON.parse(text);
    if (!validMetadata(parsed)) return {reason: 'legacy or malformed lock metadata'};
    return {metadata: parsed};
  } catch { return {reason: 'lock metadata is unreadable or malformed'}; }
  finally { await handle?.close().catch(() => {}); }
}
async function classify(root: string, expected?: Pick<LockIdentity, 'releaseId' | 'schemaId'>,
  observer: (pid: number) => ProcessObservation | Promise<ProcessObservation> = defaultObserveProcess): Promise<LockInspection> {
  const path = lockPathFor(root), read = await readLock(path);
  if (!read.metadata) return read.reason === 'absent'
    ? {classification: 'absent', reason: 'No lock exists'}
    : {classification: 'ambiguous', reason: read.reason ?? 'Lock is ambiguous'};
  const m = read.metadata;
  if (m.root !== root) return {classification: 'ambiguous', metadata: m, reason: 'Lock names a different canonical root'};
  if (expected && (m.releaseId !== expected.releaseId || m.schemaId !== expected.schemaId)) {
    return {classification: 'ambiguous', metadata: m, reason: 'Expected release/schema identity mismatch', expectedVersionMatch: false};
  }
  let observation: ProcessObservation;
  try { observation = await observer(m.process.pid); }
  catch { observation = {state: 'inaccessible', reason: 'Process observation failed'}; }
  if (observation.state === 'dead') return {classification: 'proven-dead', metadata: m, reason: 'Recorded process is proven dead', expectedVersionMatch: true};
  if (observation.state !== 'active') return {classification: 'ambiguous', metadata: m, reason: observation.reason ?? 'Process status is unknown', expectedVersionMatch: true};
  if ((m.process.startIdentity && observation.startIdentity && m.process.startIdentity !== observation.startIdentity) ||
      (m.process.bootIdentity && observation.bootIdentity && m.process.bootIdentity !== observation.bootIdentity)) {
    return {classification: 'proven-dead', metadata: m, reason: 'PID is reused or recorded boot/process identity differs', expectedVersionMatch: true};
  }
  if ((m.process.startIdentity && !observation.startIdentity) || (m.process.bootIdentity && !observation.bootIdentity)) {
    return {classification: 'ambiguous', metadata: m, reason: 'Required process identity could not be verified', expectedVersionMatch: true};
  }
  return {classification: 'active', metadata: m, reason: 'Recorded process identity is active', expectedVersionMatch: true};
}

/** Read-only inspection. It never changes or removes service.lock. */
export async function inspectServiceLock(root: string, expected?: Pick<LockIdentity, 'releaseId' | 'schemaId'>,
  dependencies: Pick<LockDependencies, 'observeProcess'> = {}): Promise<LockInspection> {
  const canonical = await canonicalRoot(root);
  return classify(canonical, expected, dependencies.observeProcess ?? defaultObserveProcess);
}

/** Exclusive-create lock ownership. Existing evidence always blocks acquisition, even when proven dead. */
export async function acquireServiceLock(options: AcquireOptions): Promise<ServiceLockHandle> {
  const root = await canonicalRoot(options.root);
  const path = lockPathFor(root);
  const processIdentity = copyProcessIdentity((options.currentProcess ?? defaultCurrentProcess)());
  if (!Number.isSafeInteger(processIdentity.pid) || processIdentity.pid <= 0) throw new Error('Invalid current process identity');
  const metadata: ServiceLockMetadata = {
    version: 1, purpose: options.purpose, root, rootId: options.rootId,
    releaseId: options.releaseId, schemaId: options.schemaId,
    nonce: (options.nonce ?? randomUUID)(), createdAt: (options.now ?? (() => new Date()))().toISOString(),
    process: processIdentity,
  };
  if (!validMetadata(metadata)) throw new Error('Invalid lock metadata');
  const json = JSON.stringify(metadata);
  const serialized = json + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > 16_384) throw new Error('Lock metadata exceeds size limit');
  const stored = metadataFromSerialized(json);
  const capturedNonce = stored.nonce;
  const publicMetadata: ServiceLockMetadata = Object.freeze({
    ...stored, process: Object.freeze(copyProcessIdentity(stored.process)),
  });
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const lockHandle = handle;
    if (options.initialize) await options.initialize(lockHandle, serialized);
    else await lockHandle.writeFile(serialized, {encoding: 'utf8'});
    await lockHandle.sync();
    const ownedStat = await lockHandle.stat();
    let released = false;
    return {
      metadata: publicMetadata,
      async release() {
        if (released) return;
        try {
          const current = await lstat(path);
          if (!current.isFile() || current.isSymbolicLink() || current.dev !== ownedStat.dev || current.ino !== ownedStat.ino) {
            throw new Error('Refusing to release a replacement lock');
          }
          const contents = await readLock(path);
          if (!contents.metadata || contents.metadata.nonce !== capturedNonce || contents.metadata.root !== root) {
            throw new Error('Refusing to release a lock with mismatched ownership metadata');
          }
          // Unlink is pathname-based and cooperative, not an OS fence.
          await unlink(path);
          released = true;
        } finally { await lockHandle.close(); }
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}
