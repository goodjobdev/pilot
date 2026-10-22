import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { lstat,mkdir,mkdtemp,readFile,readlink,realpath,rm,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { ReleaseStore,type PreviewContainerPort,type ReleasePromotionPort } from '../../src/server/state/release-store';
import { SUPPORTED_SCHEMA_IDS,schemaVersionForId,type StorageSchemaObservation } from '../../src/server/release';
import {
  RELEASE_MAX_PREVIEWS,ReleaseError,assertFingerprint,matchReleaseIdentity,pathsOverlap,rollbackCompatibility,
  targetOf,type ReleaseEvent,type ReleaseTarget
} from '../../src/shared/releases';
import { acquireServiceLock } from '../../src/server/service-lock';
import { dataRootStartBlockers } from '../../src/server/main';
// The operator CLI itself, so the pre-flight is asserted through the real entry point, not a copy.
import { activationPreflight,dockerPreviewPort,previewArgs,releasePromotionPort,run } from '../../scripts/releases.mjs';

/**
 * The release store over a disposable root and synthetic ports.
 *
 * **No container is started anywhere in this file and no container runtime is contacted.** The store's
 * only execution paths are its ports, so the suite drives the durability, the immutability, the
 * isolation rules, the races and every fail-closed rule through ports it controls. Nothing here reads
 * or writes a live data root, a live project or a real release directory.
 */

const SCHEMA_ID = SUPPORTED_SCHEMA_IDS[0];
const AT = Date.parse('2026-01-01T00:00:00.000Z');
const instant = (ms: number) => new Date(ms).toISOString();
const DIGEST_A = 'a'.repeat(40), DIGEST_B = 'b'.repeat(40);
const fingerprintOf = (canonical: string) => 'sha256:' + createHash('sha256').update(canonical).digest('hex');

function artifactFor(version: string): Record<string, unknown> {
  return { repository: 'ghcr.io/owner/pilot', kind: 'immutable-tag', identity: 'v' + version, reference: 'ghcr.io/owner/pilot:v' + version };
}
function candidateRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateId: 'cand-a', releaseId: 'release-1', schemaId: SCHEMA_ID, sourceDigest: DIGEST_A,
    environment: 'hosted-vps', createdAt: instant(AT), artifact: artifactFor('1.0.0'), ...over
  };
}
function previewRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    previewId: 'preview-a', candidateId: 'cand-a', lifetimeMs: 60 * 60 * 1000,
    limits: { memoryBytes: 256 * 1024 * 1024, cpus: 0.5, pids: 32 }, ...over
  };
}

type PreviewFake = {
  establish: number; discard: number; requests: Record<string, unknown>[];
  placementOver: Record<string, unknown> | null; createDataRoot: boolean;
  removal: unknown | null; removalRefusal: Error | null;
};
type ActivationFake = {
  calls: Record<string, unknown>[]; refusal: Error | null; removal: string[] | null;
  over: Record<string, unknown> | null; onActivate: ((request: Record<string, unknown>) => Promise<void>) | null;
};
type Fixture = {
  root: string; liveRoot: string; previewRoot: string; store: ControlStore; releases: ReleaseStore;
  preview: PreviewFake; activation: ActivationFake; observe: { schema: StorageSchemaObservation };
  clock: { now: number }; artifacts: string[];
  countRows(kind: string): number; cleanup(): Promise<void>;
};

/**
 * A disposable root with a synthetic container port and a synthetic promotion port. The container
 * port really creates and removes the preview's own data root, so the isolation assertions are about
 * a directory that exists; it never touches the live root.
 */
async function fixture(options: { supportedSchemaIds?: readonly string[] } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-release-'));
  const liveRoot = join(root, 'data');
  await mkdir(liveRoot, { recursive: true, mode: 0o700 });
  const previewRoot = join(root, 'previews');
  await mkdir(previewRoot, { recursive: true, mode: 0o700 });
  const store = new ControlStore(liveRoot);
  const preview: PreviewFake = { establish: 0, discard: 0, requests: [], placementOver: null, createDataRoot: true, removal: null, removalRefusal: null };
  const activation: ActivationFake = { calls: [], refusal: null, removal: null, over: null, onActivate: null };
  const observe = { schema: { state: 'present', version: 1 } as StorageSchemaObservation };
  const clock = { now: AT };
  const previewPort: PreviewContainerPort = {
    async establish(request) {
      preview.establish += 1;
      preview.requests.push(request as unknown as Record<string, unknown>);
      const ownRoot = join(request.previewRoot, request.previewId, 'data');
      const base: Record<string, unknown> = {
        environment: 'pilot-preview-' + request.previewId,
        dataRoot: ownRoot,
        mountedHostPaths: [ownRoot],
        credentials: [],
        tunnel: null,
        published: [],
        resourceCap: request.limits,
        lifetimeMs: request.lifetimeMs
      };
      const placement = { ...base, ...(preview.placementOver ?? {}) };
      // A real port creates the preview's own data root; a test that violates isolation expects no side effect.
      if (preview.createDataRoot && placement.dataRoot === ownRoot) await mkdir(ownRoot, { recursive: true, mode: 0o700 });
      return placement;
    },
    async discard(request) {
      preview.discard += 1;
      if (preview.removalRefusal !== null) throw preview.removalRefusal;
      if (preview.removal !== null) return preview.removal;
      const dataRoot = request.preview.placement?.dataRoot;
      if (dataRoot === undefined) return { removed: [], environmentRemoved: false };
      await rm(dataRoot, { recursive: true, force: true });
      return { removed: [dataRoot], environmentRemoved: true };
    }
  };
  const promotionPort: ReleasePromotionPort = {
    async activate(request) {
      activation.calls.push(request as unknown as Record<string, unknown>);
      if (activation.onActivate !== null) await activation.onActivate(request as unknown as Record<string, unknown>);
      if (activation.refusal !== null) throw activation.refusal;
      return {
        pointer: join(root, 'releases', request.releaseId),
        removed: activation.removal ?? [],
        activatedAt: instant(clock.now),
        ...(activation.over ?? {})
      } as never;
    }
  };
  const releases = new ReleaseStore(store, {
    ...(options.supportedSchemaIds === undefined ? {} : { supportedSchemaIds: options.supportedSchemaIds }),
    previewRoot,
    liveDataRoot: liveRoot,
    clock: () => new Date(clock.now),
    observeSchema: () => observe.schema,
    previewPort,
    promotionPort,
    id: () => randomUUID()
  });
  return {
    root, liveRoot, previewRoot, store, releases, preview, activation, observe, clock,
    artifacts: [],
    countRows: (kind: string) => (store.db.prepare('SELECT count(*) AS n FROM operations WHERE kind=?').get(kind) as { n: number }).n,
    async cleanup() { store.close(); await rm(root, { recursive: true, force: true }); }
  };
}

/** Stage one artifact file for a candidate, so a test can prove nothing ever deletes it. */
async function stageArtifact(f: Fixture, candidateId: string): Promise<string> {
  const directory = join(f.root, 'artifacts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, candidateId + '.image');
  await writeFile(path, 'artifact of ' + candidateId, { mode: 0o600 });
  f.artifacts.push(path);
  return path;
}
async function artifactsStillThere(f: Fixture): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const path of f.artifacts) contents[path] = await readFile(path, 'utf8');
  return contents;
}
async function refuses(work: () => Promise<unknown> | unknown, pattern: RegExp, code?: string): Promise<ReleaseError> {
  let thrown: unknown;
  try { await work(); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof ReleaseError, 'expected a ReleaseError, got ' + String(thrown));
  const error = thrown as ReleaseError;
  assert.match(error.message, pattern);
  if (code !== undefined) assert.equal(error.code, code, 'wrong refusal code: ' + error.code + ' (' + error.message + ')');
  return error;
}

test('a candidate is validated strictly: unknown fields, a missing or malformed identity and an unknown schema all fail closed', async () => {
  const f = await fixture();
  try {
    const refused: [Record<string, unknown>, RegExp][] = [
      [candidateRequest({ extra: true }), /Unrecognized key|invalid/],
      [candidateRequest({ artifact: undefined }), /invalid/],
      [candidateRequest({ artifact: { repository: 'ghcr.io/owner/pilot', kind: 'digest', reference: 'ghcr.io/owner/pilot', identity: '' } }), /invalid/],
      [candidateRequest({ artifact: { repository: 'ghcr.io/owner/pilot', kind: 'digest', identity: 'sha256:zz', reference: 'ghcr.io/owner/pilot@sha256:zz' } }), /sha256 digest/],
      [candidateRequest({ artifact: { repository: 'ghcr.io/owner/pilot', kind: 'immutable-tag', identity: 'latest', reference: 'ghcr.io/owner/pilot:latest' } }), /moving tag/],
      [candidateRequest({ artifact: { repository: 'ghcr.io/owner/pilot', kind: 'immutable-tag', identity: 'tip-of-main', reference: 'ghcr.io/owner/pilot:tip-of-main' } }), /version-shaped/],
      [candidateRequest({ artifact: { repository: 'ghcr.io/owner/pilot', kind: 'immutable-tag', identity: 'v1.0.0', reference: 'ghcr.io/owner/pilot:v9.9.9' } }), /must address exactly its immutable identity/],
      [candidateRequest({ artifact: { repository: 'https://ghcr.io/owner/pilot', kind: 'immutable-tag', identity: 'v1.0.0', reference: 'https://ghcr.io/owner/pilot:v1.0.0' } }), /plain lowercase image repository/],
      [candidateRequest({ schemaId: 'pilot-state-2' }), /is not one this build supports/],
      [candidateRequest({ candidateId: '../escape' }), /opaque identity, never a path/],
      [candidateRequest({ sourceDigest: 'not-a-digest' }), /source digest/],
      [candidateRequest({ createdAt: '2026-01-01' }), /ISO-8601 UTC instant/],
      [candidateRequest({ environment: '' }), /invalid/]
    ];
    for (const [request, pattern] of refused) await refuses(() => f.releases.createCandidate(request), pattern);
    assert.equal(f.releases.candidates().length, 0, 'nothing invalid was recorded');
    assert.equal(f.countRows('release.candidate'), 0);
  } finally { await f.cleanup(); }
});

test('a candidate is immutable and durable: identical content reads back, different content under one id is refused', async () => {
  const f = await fixture();
  try {
    const recorded = f.releases.createCandidate(candidateRequest());
    assert.equal(recorded.version, 1);
    assert.match(recorded.fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(assertFingerprint(recorded, fingerprintOf, 'release candidate'), recorded.fingerprint, 'the record validates its own content');
    assert.deepEqual(f.releases.candidate('cand-a'), recorded);
    assert.equal(f.releases.candidates().length, 1);
    // The record and everything inside it is frozen; a mutation attempt changes nothing durable.
    assert.ok(Object.isFrozen(recorded) && Object.isFrozen(recorded.artifact));
    assert.throws(() => { (recorded as { releaseId: string }).releaseId = 'tampered'; });
    assert.equal(f.releases.candidate('cand-a').releaseId, 'release-1');
    // A repeat of the identical record reads back the stored one and writes nothing new.
    assert.deepEqual(f.releases.createCandidate(candidateRequest()), recorded);
    assert.equal(f.countRows('release.candidate'), 1, 'one operation per candidate');
    assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM outboxes WHERE kind='release.candidate-record'").get() as { n: number }).n, 1);
    assert.equal((f.store.db.prepare("SELECT state FROM operations WHERE kind='release.candidate'").get() as { state: string }).state, 'pending', 'a candidate never transitions');
    // The same id with different content is refused, and the stored record is unchanged.
    await refuses(() => f.releases.createCandidate(candidateRequest({ sourceDigest: DIGEST_B })), /immutable|different content/, 'CONFLICT');
    await refuses(() => f.releases.createCandidate(candidateRequest({ releaseId: 'release-9' })), /immutable|different content/);
    assert.equal(f.releases.candidate('cand-a').sourceDigest, DIGEST_A);
    assert.equal(f.releases.candidates().length, 1);
    // A restart cannot lose it: a second store over the same root reads the same record.
    const fingerprint = recorded.fingerprint;
    f.store.close();
    const reopened = new ControlStore(f.liveRoot);
    try {
      const after = new ReleaseStore(reopened, { previewRoot: f.previewRoot, liveDataRoot: f.liveRoot });
      assert.equal(after.candidate('cand-a').fingerprint, fingerprint, 'the candidate survives a restart');
      assert.equal(after.candidates().length, 1);
    } finally { reopened.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a preview is refused whenever any isolation property cannot be established, and no refused preview is ever active', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    const ownRoot = join(f.previewRoot, 'preview-a', 'data');
    const violations: [Record<string, unknown>, RegExp, string][] = [
      [{ dataRoot: f.liveRoot, mountedHostPaths: [f.liveRoot] }, /outside the designated preview root/, 'ISOLATION'],
      [{ dataRoot: ownRoot, mountedHostPaths: [f.liveRoot] }, /outside the preview's own data root/, 'CONTAINMENT'],
      [{ dataRoot: ownRoot, mountedHostPaths: [join(f.liveRoot, 'control.sqlite')] }, /outside the preview's own data root/, 'CONTAINMENT'],
      [{ dataRoot: ownRoot, mountedHostPaths: [] }, /mounts nothing at all/, 'ISOLATION'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], credentials: ['/srv/pilot/credentials/provider-keys.json'] }, /production credential path/, 'ISOLATION'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], tunnel: 'pilot-tunnel' }, /has no tunnel/, 'ISOLATION'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], published: [{ host: '0.0.0.0', port: 4317 }] }, /not loopback/, 'ISOLATION'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], published: [{ host: '10.0.0.5', port: 4317 }] }, /not loopback/, 'ISOLATION'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], published: [{ host: '127.0.0.1', port: 80 }] }, /unprivileged range/, 'ISOLATION'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], resourceCap: { cpus: 0.5, pids: 32 } }, /memoryBytes/, 'INVALID'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], resourceCap: { memoryBytes: 512 * 1024 * 1024, cpus: 0.5, pids: 32 } }, /wider than the preview request/, 'BOUNDED'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], lifetimeMs: 2 * 60 * 60 * 1000 }, /longer than the/, 'BOUNDED'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], lifetimeMs: 24 * 60 * 60 * 1000 + 1 }, /outside the documented bound/, 'BOUNDED'],
      [{ dataRoot: ownRoot, mountedHostPaths: [ownRoot], extra: true }, /Unrecognized key|invalid/, 'INVALID'],
      [{ dataRoot: 'not/absolute', mountedHostPaths: [ownRoot] }, /absolute POSIX data root/, 'ISOLATION']
    ];
    f.preview.createDataRoot = false;
    for (const [index, [over, pattern, code]] of violations.entries()) {
      f.preview.placementOver = over;
      const id = 'violation-' + index;
      await refuses(() => f.releases.createPreview(previewRequest({ previewId: id })), pattern, code);
      assert.equal(f.releases.previews().filter((preview) => preview.state === 'active').length, 0, 'a violating placement is never an active preview');
      assert.equal(f.releases.preview(id).placement, null, 'a refused placement is never recorded');
      assert.equal(f.releases.preview(id).state, 'creating', 'a refused preview leaves a reservation an operator can see and discard');
      // The reservation never held a container, and discarding it removes nothing but the record.
      assert.equal((await f.releases.discardPreview({ previewId: id })).removed.length, 0);
      assert.equal(f.releases.previews().filter((preview) => preview.state !== 'discarded').length, 0);
    }
    f.preview.placementOver = null;
    f.preview.createDataRoot = true;
    // A request this build cannot bound, and a candidate that does not exist, are refused too.
    await refuses(() => f.releases.createPreview(previewRequest({ lifetimeMs: 1000 })), /bounded lifetime/, 'BOUNDED');
    await refuses(() => f.releases.createPreview(previewRequest({ limits: { memoryBytes: 16 * 1024 * 1024, cpus: 1, pids: 32 } })), /must bound memory/, 'BOUNDED');
    await refuses(() => f.releases.createPreview(previewRequest({ candidateId: 'cand-missing' })), /no release candidate/, 'NOT_FOUND');
    // A preview is never promoted: promotion names a candidate, and the refusal names the candidate.
    const created = await f.releases.createPreview(previewRequest());
    assert.equal(created.state, 'active');
    assert.equal(created.promotable, false);
    assert.equal(created.disposable, true);
    await refuses(() => f.releases.promote({ candidateId: 'preview-a', expectedRevision: 0, actor: 'owner' }), /names a preview, not a release candidate/, 'NOT_FOUND');
    assert.equal(f.releases.promotions().length, 0);
  } finally { await f.cleanup(); }
});

test('a preview has its own data root, cannot reach the live data root, and a discard removes only what it created', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    const marker = join(f.liveRoot, 'LIVE-MARKER');
    await writeFile(marker, 'live data', { mode: 0o600 });
    const database = join(f.liveRoot, 'control.sqlite');
    const before = await readFile(database);
    const created = await f.releases.createPreview(previewRequest());
    assert.equal(created.state, 'active');
    assert.equal(created.createdAt, instant(AT));
    assert.equal(created.expiresAt, instant(AT + 60 * 60 * 1000));
    assert.equal(created.revision, 1);
    const placement = created.placement;
    assert.ok(placement !== null);
    assert.equal(await realpath(placement.dataRoot), await realpath(join(f.previewRoot, 'preview-a', 'data')), 'the preview data root is its own');
    assert.notEqual(await realpath(placement.dataRoot), await realpath(f.liveRoot));
    assert.equal(pathsOverlap(placement.dataRoot, f.liveRoot), false, 'the preview data root never overlaps the live data root');
    for (const mounted of placement.mountedHostPaths) assert.equal(pathsOverlap(mounted, f.liveRoot), false, 'no mounted path overlaps the live data root');
    assert.deepEqual(placement.credentials, []);
    assert.equal(placement.tunnel, null);
    assert.deepEqual(placement.published, []);
    assert.deepEqual(placement.resourceCap, previewRequest().limits);
    assert.equal((await stat(placement.dataRoot)).isDirectory(), true, 'the preview really has its own directory');
    // Creating a preview left the live root exactly as it was.
    assert.deepEqual(await readFile(database), before, 'the live control store was not read from or written by the preview');
    assert.equal(await readFile(marker, 'utf8'), 'live data');
    // A discard that claims to remove something outside the preview's own root is refused, and records nothing.
    f.preview.removal = { removed: [f.liveRoot], environmentRemoved: true };
    await refuses(() => f.releases.discardPreview({ previewId: 'preview-a', revision: created.revision }), /outside the preview's own data root/, 'CONTAINMENT');
    assert.equal(f.releases.preview('preview-a').state, 'active', 'a refused discard leaves the preview exactly as it was');
    assert.equal(await readFile(marker, 'utf8'), 'live data');
    // A stale discard revision is refused; the current one removes the container and the preview's own root.
    f.preview.removal = null;
    await refuses(() => f.releases.discardPreview({ previewId: 'preview-a', revision: 99 }), /stale/, 'CONFLICT');
    const discarded = await f.releases.discardPreview({ previewId: 'preview-a', revision: created.revision });
    assert.equal(discarded.state, 'discarded');
    assert.equal(discarded.discardedAt, instant(AT));
    assert.deepEqual(discarded.removed, [placement.dataRoot]);
    assert.equal(await stat(placement.dataRoot).then(() => 'there', () => 'gone'), 'gone', 'the preview data root was removed');
    assert.equal(await readFile(marker, 'utf8'), 'live data', 'a discard removes only what the preview created');
    assert.deepEqual(await readFile(database), before, 'the live control store is untouched by a discard');
    // Discarding again is idempotent and calls no port.
    const discards = f.preview.discard;
    assert.equal((await f.releases.discardPreview({ previewId: 'preview-a' })).state, 'discarded');
    assert.equal(f.preview.discard, discards, 'an already discarded preview is not discarded again');
    // A preview id is never reused for different content.
    await refuses(() => f.releases.createPreview(previewRequest({ lifetimeMs: 2 * 60 * 60 * 1000 })), /different content/, 'CONFLICT');
    // A preview whose lifetime has run out is reported as expired, and still discards cleanly.
    const later = await f.releases.createPreview(previewRequest({ previewId: 'preview-b' }));
    f.clock.now = AT + 61 * 60 * 1000;
    assert.equal(f.releases.preview('preview-b').state, 'expired');
    assert.equal((await f.releases.discardPreview({ previewId: 'preview-b', revision: later.revision })).state, 'discarded');
    // The documented bound on how many previews may exist at once is enforced.
    for (let index = 0; index < RELEASE_MAX_PREVIEWS; index++) await f.releases.createPreview(previewRequest({ previewId: 'preview-many-' + index }));
    const requested = f.preview.requests.length;
    await refuses(() => f.releases.createPreview(previewRequest({ previewId: 'preview-overflow' })), /documented maximum/, 'BOUNDED');
    assert.equal(f.preview.requests.length, requested, 'a refused preview never asks a port for anything');
  } finally { await f.cleanup(); }
});

test('a preview root that would contain the live data root can never yield a placement, and a failing port leaves only a reservation', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    // The operator points the preview root inside the live data root: every data root then overlaps it.
    const nestedRoot = join(f.liveRoot, 'previews');
    await mkdir(nestedRoot, { recursive: true, mode: 0o700 });
    const ownRoot = join(nestedRoot, 'preview-a', 'data');
    const nested = new ReleaseStore(f.store, {
      previewRoot: nestedRoot, liveDataRoot: f.liveRoot,
      previewPort: {
        establish: async () => ({ environment: 'nested', dataRoot: ownRoot, mountedHostPaths: [ownRoot], credentials: [], tunnel: null, published: [], resourceCap: previewRequest().limits, lifetimeMs: previewRequest().lifetimeMs }),
        discard: async () => ({ removed: [], environmentRemoved: false })
      }
    });
    await refuses(() => nested.createPreview(previewRequest()), /could read or write the live data/, 'ISOLATION');
    assert.equal(nested.previews().filter((preview) => preview.state === 'active').length, 0);
    // A port that cannot create the container leaves the reservation, and nothing is claimed to exist.
    const failing = new ReleaseStore(f.store, {
      previewRoot: f.previewRoot, liveDataRoot: f.liveRoot, clock: () => new Date(f.clock.now),
      previewPort: { establish: async () => { throw new Error('the runtime did not answer'); }, discard: async () => ({ removed: [], environmentRemoved: false }) }
    });
    await refuses(() => failing.createPreview(previewRequest({ previewId: 'preview-failing' })), /could not be established/, 'UNAVAILABLE');
    const reservation = f.releases.preview('preview-failing');
    assert.equal(reservation.state, 'creating');
    assert.equal(reservation.placement, null);
  } finally { await f.cleanup(); }
});

test('promotion records the previous release, refuses a stale revision, and deletes no previous artifact', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    f.releases.createCandidate(candidateRequest({ candidateId: 'cand-b', releaseId: 'release-2', sourceDigest: DIGEST_B, artifact: artifactFor('2.0.0') }));
    const firstArtifact = await stageArtifact(f, 'cand-a');
    const secondArtifact = await stageArtifact(f, 'cand-b');
    const before = await artifactsStillThere(f);
    const first = await f.releases.promote({ candidateId: 'cand-a', expectedRevision: 0, actor: 'owner' });
    assert.equal(first.action, 'promote');
    assert.equal(first.revision, 1);
    assert.equal(first.basedOnRevision, 0);
    assert.equal(first.previousRelease, null, 'the first promotion records no previous release');
    assert.equal(first.actor, 'owner');
    assert.match(first.pointer, /release-1$/);
    assert.equal(f.activation.calls.length, 1);
    // A stale revision is refused before anything is activated, and nothing is recorded.
    await refuses(() => f.releases.promote({ candidateId: 'cand-b', expectedRevision: 0, actor: 'owner' }), /stale/, 'CONFLICT');
    assert.equal(f.activation.calls.length, 1, 'a stale promotion never asks the port to do anything');
    assert.equal(f.releases.promotions().length, 1);
    // The current revision promotes, and the release that was previously active is the rollback target.
    const second = await f.releases.promote({ candidateId: 'cand-b', expectedRevision: 1, actor: 'owner' });
    assert.equal(second.revision, 2);
    assert.deepEqual(second.previousRelease, targetOf(first));
    const status = f.releases.status();
    assert.equal(status.revision, 2);
    assert.equal(status.target?.candidateId, 'cand-b');
    assert.equal(status.rollbackTarget?.candidateId, 'cand-a');
    assert.deepEqual(status.compatibility, { compatible: true, targetSchemaVersion: 1, onDiskSchemaVersion: 1 });
    // Promoting the release that is already active is refused.
    await refuses(() => f.releases.promote({ candidateId: 'cand-b', expectedRevision: 2, actor: 'owner' }), /already the promoted release/, 'CONFLICT');
    // The identity the running build reports is matched against the promoted candidate.
    assert.deepEqual(f.releases.matchRelease({ releaseId: 'release-2', schemaId: SCHEMA_ID }), { state: 'match' });
    assert.deepEqual(matchReleaseIdentity({ releaseId: 'release-1', schemaId: SCHEMA_ID }, targetOf(second)), {
      state: 'mismatch', differences: [{ field: 'releaseId', running: 'release-1', promoted: 'release-2' }]
    });
    assert.deepEqual(matchReleaseIdentity({ releaseId: 'release-2', schemaId: SCHEMA_ID, sourceDigest: DIGEST_A }, targetOf(second)), {
      state: 'mismatch', differences: [{ field: 'sourceDigest', running: DIGEST_A, promoted: DIGEST_B }]
    });
    assert.deepEqual(matchReleaseIdentity({ releaseId: 'release-2', schemaId: SCHEMA_ID, sourceDigest: DIGEST_B }, targetOf(second)), { state: 'match' });
    assert.deepEqual(matchReleaseIdentity({ releaseId: 'release-2', schemaId: SCHEMA_ID }, null), { state: 'not-promoted' });
    // Nothing deleted the previous artifact, and no promotion reported a removal.
    assert.deepEqual(await artifactsStillThere(f), before, 'every staged artifact is still there, byte for byte');
    assert.equal(await readFile(firstArtifact, 'utf8'), 'artifact of cand-a');
    assert.equal(await readFile(secondArtifact, 'utf8'), 'artifact of cand-b');
    for (const call of f.activation.calls) assert.equal(call.removed, undefined, 'no activation reported a removal');
    // A port that reports deleting an artifact is refused, and nothing is recorded.
    const recorded = f.releases.promotions().length;
    f.activation.removal = ['/srv/pilot/releases/release-2'];
    await refuses(() => f.releases.promote({ candidateId: 'cand-a', expectedRevision: 2, actor: 'owner' }), /never delete the previous artifact/, 'CONTAINMENT');
    assert.equal(f.releases.promotions().length, recorded, 'a promotion that removed an artifact is not recorded');
    assert.deepEqual(await artifactsStillThere(f), before);
  } finally { await f.cleanup(); }
});

test('reading the promotion for a report does not observe the storage schema', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    f.releases.createCandidate(candidateRequest({ candidateId: 'cand-b', releaseId: 'release-2', sourceDigest: DIGEST_B, artifact: artifactFor('2.0.0') }));
    await f.releases.promote({ candidateId: 'cand-a', expectedRevision: 0, actor: 'owner' });
    await f.releases.promote({ candidateId: 'cand-b', expectedRevision: 1, actor: 'owner' });
    let observed = 0;
    const counting = new ReleaseStore(f.store, {
      liveDataRoot: f.liveRoot,
      observeSchema: () => { observed += 1; return { state: 'present', version: 1 }; }
    });
    const promotion = counting.promotionStatus();
    assert.equal(promotion.revision, 2);
    assert.equal(promotion.rollbackTarget?.candidateId, 'cand-a');
    assert.deepEqual(counting.matchRelease({ releaseId: 'release-2', schemaId: SCHEMA_ID }), { state: 'match' });
    assert.equal(observed, 0, 'a readiness or release report must not observe the live schema or wait on its lock');
    assert.deepEqual(counting.status().compatibility, { compatible: true, targetSchemaVersion: 1, onDiskSchemaVersion: 1 });
    assert.equal(observed, 1, 'the operator status observes the schema once, so it can say what a rollback would do');
  } finally { await f.cleanup(); }
});

test('a promotion that races another actor is refused by the store compare-and-swap, and says what may already have happened', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    f.releases.createCandidate(candidateRequest({ candidateId: 'cand-b', releaseId: 'release-2', sourceDigest: DIGEST_B, artifact: artifactFor('2.0.0') }));
    // The race is made deterministic: the port itself commits the competing promotion while the first
    // promotion is inside its activation step.
    f.activation.onActivate = async () => {
      f.activation.onActivate = null;
      await f.releases.promote({ candidateId: 'cand-b', expectedRevision: 0, actor: 'other' });
    };
    await refuses(() => f.releases.promote({ candidateId: 'cand-a', expectedRevision: 0, actor: 'owner' }), /another actor recorded the promotion at revision 1 first.*may already have pointed the service/s, 'CONFLICT');
    const events = f.releases.promotions();
    assert.equal(events.length, 1, 'exactly one promotion is recorded');
    assert.equal(events[0]?.candidateId, 'cand-b');
    // The loser swapped the pointer first, so it re-points the service at the recorded winner before it
    // reports the conflict: the pointer and the record cannot be left disagreeing silently.
    assert.equal(f.activation.calls.length, 3, 'both actors asked the port, then the loser re-pointed the service at the recorded winner');
    assert.equal(f.activation.calls[2]?.releaseId, 'release-2', 'the last activation is the recorded promotion, so the pointer agrees with the record');
    assert.equal(f.activation.calls[2]?.action, 'promote');
  } finally { await f.cleanup(); }
});

test('a promotion history that has been tampered with is refused as corrupt rather than read as fact', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    const event = await f.releases.promote({ candidateId: 'cand-a', expectedRevision: 0, actor: 'owner' });
    f.store.db.prepare('UPDATE operations SET input_json=? WHERE kind=?').run(JSON.stringify({ ...event, actor: 'someone-else' }), 'release.promotion');
    await refuses(() => f.releases.status(), /fingerprint does not match its own content/, 'CORRUPT');
    await refuses(() => f.releases.promotions(), /corrupt/, 'CORRUPT');
  } finally { await f.cleanup(); }
});

test('a rollback is refused when the on-disk schema is newer than the target understands, and points at the backup restore path', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    f.releases.createCandidate(candidateRequest({ candidateId: 'cand-b', releaseId: 'release-2', sourceDigest: DIGEST_B, artifact: artifactFor('2.0.0') }));
    await f.releases.promote({ candidateId: 'cand-a', expectedRevision: 0, actor: 'owner' });
    await f.releases.promote({ candidateId: 'cand-b', expectedRevision: 1, actor: 'owner' });
    const activations = f.activation.calls.length;
    f.observe.schema = { state: 'present', version: 2 };
    const refusal = await refuses(() => f.releases.rollback({ expectedRevision: 2, actor: 'owner' }), /newer than release release-1 understands \(version 1\)/, 'INCOMPATIBLE');
    assert.match(refusal.message, /rolling back would start a service that misreads the data/);
    assert.match(refusal.message, /scripts\/restore\.mjs/, 'the refusal points at the encrypted backup restore path');
    assert.match(refusal.message, /nothing was promoted/);
    assert.equal(f.activation.calls.length, activations, 'a refused rollback never asks the port to do anything');
    assert.equal(f.releases.promotions().length, 2, 'a refused rollback records nothing');
    const compatibility = rollbackCompatibility({
      target: f.releases.status().rollbackTarget as ReleaseTarget,
      observed: { state: 'present', version: 2 }, schemaVersionFor: schemaVersionForId
    });
    assert.equal(compatibility.compatible, false);
    assert.deepEqual(f.releases.status().compatibility, compatibility);
    // An older on-disk schema is refused with its own reason: the target would refuse to start on it.
    f.observe.schema = { state: 'present', version: 0 };
    await refuses(() => f.releases.rollback({ expectedRevision: 2, actor: 'owner' }), /older than release release-1 expects/, 'INCOMPATIBLE');
    // A schema that cannot be observed is refused rather than assumed compatible.
    for (const state of ['absent', 'busy', 'malformed'] as const) {
      f.observe.schema = { state } as StorageSchemaObservation;
      await refuses(() => f.releases.rollback({ expectedRevision: 2, actor: 'owner' }), new RegExp('could not be observed \\(' + state + '\\)'), 'INCOMPATIBLE');
    }
    // A target release whose schema this build cannot map to a version is refused too.
    const unknownSchema = await fixture({ supportedSchemaIds: [SCHEMA_ID, 'pilot-state-2'] });
    try {
      unknownSchema.releases.createCandidate(candidateRequest({ schemaId: 'pilot-state-2' }));
      unknownSchema.releases.createCandidate(candidateRequest({ candidateId: 'cand-b', releaseId: 'release-2', sourceDigest: DIGEST_B, schemaId: 'pilot-state-2', artifact: artifactFor('2.0.0') }));
      await unknownSchema.releases.promote({ candidateId: 'cand-a', expectedRevision: 0, actor: 'owner' });
      await unknownSchema.releases.promote({ candidateId: 'cand-b', expectedRevision: 1, actor: 'owner' });
      await refuses(() => unknownSchema.releases.rollback({ expectedRevision: 2, actor: 'owner' }), /cannot map to a schema version/, 'INCOMPATIBLE');
      assert.equal(unknownSchema.releases.promotions().length, 2);
    } finally { await unknownSchema.cleanup(); }
  } finally { await f.cleanup(); }
});

test('a rollback to a compatible release succeeds, records the release it left, and deletes no artifact', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    f.releases.createCandidate(candidateRequest({ candidateId: 'cand-b', releaseId: 'release-2', sourceDigest: DIGEST_B, artifact: artifactFor('2.0.0') }));
    const firstArtifact = await stageArtifact(f, 'cand-a');
    const secondArtifact = await stageArtifact(f, 'cand-b');
    const before = await artifactsStillThere(f);
    const first = await f.releases.promote({ candidateId: 'cand-a', expectedRevision: 0, actor: 'owner' });
    const second = await f.releases.promote({ candidateId: 'cand-b', expectedRevision: 1, actor: 'owner' });
    f.clock.now = AT + 60_000;
    const rolled = await f.releases.rollback({ expectedRevision: 2, actor: 'operator' });
    assert.equal(rolled.action, 'rollback');
    assert.equal(rolled.revision, 3);
    assert.equal(rolled.candidateId, 'cand-a', 'the rollback returns to the recorded previous release');
    assert.deepEqual(rolled.previousRelease, targetOf(second), 'the rollback records the release it left');
    assert.equal(rolled.actor, 'operator');
    assert.match(rolled.pointer, /release-1$/);
    assert.equal(rolled.basedOnRevision, 2);
    const status = f.releases.status();
    assert.equal(status.target?.releaseId, 'release-1');
    assert.equal(status.rollbackTarget?.releaseId, 'release-2', 'a rollback is itself reversible');
    assert.deepEqual(status.compatibility, { compatible: true, targetSchemaVersion: 1, onDiskSchemaVersion: 1 });
    assert.deepEqual(f.releases.matchRelease({ releaseId: 'release-1', schemaId: SCHEMA_ID, sourceDigest: DIGEST_A }), { state: 'match' });
    const events: readonly ReleaseEvent[] = f.releases.promotions();
    assert.deepEqual(events.map((event) => [event.revision, event.basedOnRevision, event.action]), [[1, 0, 'promote'], [2, 1, 'promote'], [3, 2, 'rollback']]);
    assert.deepEqual(events[2]?.previousRelease, targetOf(second));
    assert.deepEqual(events[0]?.previousRelease, null);
    // A second rollback leaves the release this one restored.
    const back = await f.releases.rollback({ expectedRevision: 3, actor: 'operator' });
    assert.equal(back.action, 'rollback');
    assert.equal(back.candidateId, 'cand-b');
    assert.equal(f.releases.status().target?.releaseId, 'release-2');
    // Nothing was deleted at any point: both artifacts are exactly as they were staged.
    assert.deepEqual(await artifactsStillThere(f), before);
    assert.equal(await readFile(firstArtifact, 'utf8'), 'artifact of cand-a');
    assert.equal(await readFile(secondArtifact, 'utf8'), 'artifact of cand-b');
    // A rollback with nothing recorded before the first promotion is refused.
    const fresh = await fixture();
    try {
      fresh.releases.createCandidate(candidateRequest());
      await fresh.releases.promote({ candidateId: 'cand-a', expectedRevision: 0, actor: 'owner' });
      await refuses(() => fresh.releases.rollback({ expectedRevision: 1, actor: 'owner' }), /records no previous release/, 'NOT_FOUND');
      await refuses(() => fresh.releases.rollback({ expectedRevision: 0, actor: 'owner' }), /stale/, 'CONFLICT');
    } finally { await fresh.cleanup(); }
  } finally { await f.cleanup(); }
});

/* --------------------------------------------------------------------------------------------- *
 * The operator pre-flight: the tool itself verifies startability before the pointer moves
 * --------------------------------------------------------------------------------------------- */

type CliFixture = { readonly root: string; readonly data: string; readonly releaseRoot: string; cleanup(): Promise<void> };
async function cliFixture(): Promise<CliFixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-release-cli-'));
  const data = join(root, 'data'); await mkdir(data, { recursive: true, mode: 0o700 });
  const releaseRoot = join(root, 'releases'); await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
  return { root, data, releaseRoot, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}
async function cliCandidate(f: CliFixture, candidate: { id: string; release: string; digest: string; version: string }): Promise<void> {
  await run(['candidate', 'create', '--data', f.data, '--id', candidate.id, '--release', candidate.release, '--schema', SCHEMA_ID,
    '--source', candidate.digest, '--repository', 'ghcr.io/owner/pilot', '--identity', 'v' + candidate.version,
    '--kind', 'immutable-tag', '--environment', 'hosted-vps', '--execute']);
}
async function cliStage(f: CliFixture, directoryName: string, manifest: { releaseId: string; digest: string }): Promise<void> {
  const directory = join(f.releaseRoot, directoryName); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'release.json'), JSON.stringify({
    version: '0.1.0', releaseId: manifest.releaseId, schemaId: SCHEMA_ID,
    createdAt: '2026-01-01T00:00:00.000Z', sourceDigest: manifest.digest
  }) + '\n', { mode: 0o600 });
}
const pointerState = async (f: CliFixture): Promise<string> => lstat(join(f.releaseRoot, 'current')).then(() => 'there', () => 'gone');
/** The CLI return is a large union; these reads assert fields of one command's shape. */
const cliResult = (value: unknown): Record<string, any> => value as Record<string, any>;

test('the CLI pre-flight refuses a held service lock for both promote and rollback without moving the pointer', async () => {
  const f = await cliFixture();
  let held: Awaited<ReturnType<typeof acquireServiceLock>> | null = null;
  try {
    await cliCandidate(f, { id: 'cand-a', release: 'release-1', digest: DIGEST_A, version: '1.0.0' });
    await cliCandidate(f, { id: 'cand-b', release: 'release-2', digest: DIGEST_B, version: '2.0.0' });
    await cliStage(f, 'release-1', { releaseId: 'release-1', digest: DIGEST_A });
    await cliStage(f, 'release-2', { releaseId: 'release-2', digest: DIGEST_B });
    await run(['promote', '--data', f.data, '--candidate', 'cand-a', '--expect-revision', '0', '--actor', 'owner', '--release-root', f.releaseRoot, '--execute']);
    await run(['promote', '--data', f.data, '--candidate', 'cand-b', '--expect-revision', '1', '--actor', 'owner', '--release-root', f.releaseRoot, '--execute']);
    assert.equal(await readlink(join(f.releaseRoot, 'current')), join(f.releaseRoot, 'release-2'), 'the second promotion swapped the pointer');
    held = await acquireServiceLock({ root: f.data, purpose: 'service', rootId: 'local-root', releaseId: 'release-2', schemaId: SCHEMA_ID });
    await refuses(() => run(['rollback', '--data', f.data, '--expect-revision', '2', '--actor', 'owner', '--release-root', f.releaseRoot, '--execute']), /service-lock evidence/, 'CONFLICT');
    assert.equal(await readlink(join(f.releaseRoot, 'current')), join(f.releaseRoot, 'release-2'), 'a refused rollback leaves the pointer exactly where it was');
    await refuses(() => run(['promote', '--data', f.data, '--candidate', 'cand-a', '--expect-revision', '2', '--actor', 'owner', '--release-root', f.releaseRoot, '--execute']), /service-lock evidence/, 'CONFLICT');
    assert.equal(await readlink(join(f.releaseRoot, 'current')), join(f.releaseRoot, 'release-2'), 'a refused promotion leaves the pointer exactly where it was');
    const still = cliResult(await run(['status', '--data', f.data]));
    assert.equal(still.promotion.revision, 2, 'the promotion record is unchanged by the refusals');
    assert.ok((still.startBlockers as string[]).includes('service-lock-present'), 'status reports the lock as a start blocker too');
  } finally {
    if (held !== null) await held.release().catch(() => {});
    await f.cleanup();
  }
});

test('the store pre-flight refuses before it asks the promotion port to activate anything, for promote and rollback', async () => {
  const f = await fixture();
  const releaseRoot = join(f.root, 'releases'); await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
  try {
    f.releases.createCandidate(candidateRequest());
    f.releases.createCandidate(candidateRequest({ candidateId: 'cand-b', releaseId: 'release-2', sourceDigest: DIGEST_B, artifact: artifactFor('2.0.0') }));
    await mkdir(join(releaseRoot, 'release-1'), { recursive: true, mode: 0o700 });
    await mkdir(join(releaseRoot, 'release-2'), { recursive: true, mode: 0o700 });
    await f.releases.promote({ candidateId: 'cand-a', expectedRevision: 0, actor: 'owner' });
    await f.releases.promote({ candidateId: 'cand-b', expectedRevision: 1, actor: 'owner' });
    const real = releasePromotionPort({ releaseRoot });
    let calls = 0;
    const counting: ReleasePromotionPort = { async activate(request) { calls += 1; return real.activate(request); } };
    const gated = new ReleaseStore(f.store, {
      liveDataRoot: f.liveRoot, promotionPort: counting,
      canActivate: () => ({ ok: false, reason: 'the target data root carries service-lock evidence (ambiguous: a held lock)', code: 'CONFLICT' })
    });
    await refuses(() => gated.promote({ candidateId: 'cand-a', expectedRevision: 2, actor: 'owner' }), /service-lock evidence/, 'CONFLICT');
    await refuses(() => gated.rollback({ expectedRevision: 2, actor: 'owner' }), /service-lock evidence/, 'CONFLICT');
    assert.equal(calls, 0, 'a refused promotion and a refused rollback never ask the port to activate anything');
    assert.equal(await lstat(join(releaseRoot, 'current')).then(() => 'there', () => 'gone'), 'gone', 'neither refusal created a pointer');
    assert.equal(gated.promotions().length, 2, 'a refused pre-flight records nothing');
  } finally { await f.cleanup(); }
});

test('the CLI pre-flight refuses a restored root that is still paused', async () => {
  const f = await cliFixture();
  try {
    await cliCandidate(f, { id: 'cand-a', release: 'release-1', digest: DIGEST_A, version: '1.0.0' });
    await cliStage(f, 'release-1', { releaseId: 'release-1', digest: DIGEST_A });
    await writeFile(join(f.data, 'RESTORE-PAUSED.json'), JSON.stringify({ format: 'pilot-restore-pause', version: 1, created: '2026-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
    await refuses(() => run(['promote', '--data', f.data, '--candidate', 'cand-a', '--expect-revision', '0', '--actor', 'owner', '--release-root', f.releaseRoot, '--execute']), /RESTORE-PAUSED\.json/, 'CONFLICT');
    assert.equal(await pointerState(f), 'gone', 'a refused promotion creates no pointer');
  } finally { await f.cleanup(); }
});

test('the CLI pre-flight refuses a staged release.json that does not match the candidate', async () => {
  const f = await cliFixture();
  try {
    await cliCandidate(f, { id: 'cand-a', release: 'release-1', digest: DIGEST_A, version: '1.0.0' });
    await cliStage(f, 'release-1', { releaseId: 'release-9', digest: DIGEST_A });
    await refuses(() => run(['promote', '--data', f.data, '--candidate', 'cand-a', '--expect-revision', '0', '--actor', 'owner', '--release-root', f.releaseRoot, '--execute']), /does not match the candidate release id/, 'CONFLICT');
    assert.equal(await pointerState(f), 'gone', 'a mis-staged directory is caught before the switch');
  } finally { await f.cleanup(); }
});

/** A synthetic runtime for the pre-flight, so the schema rule is asserted without a real store or docker. */
function preflightRuntime(over: { lock?: unknown; schema: StorageSchemaObservation }): unknown {
  return {
    inspectServiceLock: async () => over.lock ?? { classification: 'absent', reason: 'No lock exists' },
    restorePauseRefusal: async () => null,
    loadReleaseManifest: async () => ({
      status: 'present', path: '/srv/releases/release-1/release.json',
      manifest: { version: '0.1.0', releaseId: 'release-1', schemaId: SCHEMA_ID, createdAt: '2026-01-01T00:00:00.000Z', sourceDigest: DIGEST_A }
    }),
    observeStorageSchema: () => over.schema,
    schemaVersionForId,
    rollbackCompatibility
  };
}
const TARGET_A = { candidateId: 'cand-a', releaseId: 'release-1', schemaId: SCHEMA_ID, sourceDigest: DIGEST_A, artifact: artifactFor('1.0.0') } as unknown as ReleaseTarget;

test('the pre-flight refuses a promotion or rollback whose schema does not match what is on disk', async () => {
  const newer = await activationPreflight({ dataRoot: '/data', releaseRoot: '/srv/releases', target: TARGET_A, action: 'promote', rt: preflightRuntime({ schema: { state: 'present', version: 2 } }) });
  assert.equal(newer.ok, false);
  assert.equal(newer.code, 'INCOMPATIBLE');
  assert.match(newer.reason, /^The promotion is refused: /);
  assert.match(newer.reason, /newer than release release-1 understands/);
  const unobservable = await activationPreflight({ dataRoot: '/data', releaseRoot: '/srv/releases', target: TARGET_A, action: 'rollback', rt: preflightRuntime({ schema: { state: 'busy', reason: 'storage schema is temporarily locked by another writer' } }) });
  assert.equal(unobservable.ok, false);
  assert.equal(unobservable.code, 'INCOMPATIBLE');
  assert.match(unobservable.reason, /could not be observed \(busy\)/);
  const compatible = await activationPreflight({ dataRoot: '/data', releaseRoot: '/srv/releases', target: TARGET_A, action: 'promote', rt: preflightRuntime({ schema: { state: 'present', version: 1 } }) });
  assert.equal(compatible.ok, true);
  // The lock check refuses ANY classification other than absent, for both actions.
  for (const action of ['promote', 'rollback'] as const) {
    const held = await activationPreflight({ dataRoot: '/data', releaseRoot: '/srv/releases', target: TARGET_A, action, rt: preflightRuntime({ lock: { classification: 'proven-dead', reason: 'Recorded process is proven dead' }, schema: { state: 'present', version: 1 } }) });
    assert.equal(held.ok, false);
    assert.equal(held.code, 'CONFLICT');
    assert.match(held.reason, /service-lock evidence \(proven-dead/);
  }
});

test('the preview port validates a placement before creating anything and removes what it created on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-preview-port-'));
  try {
    const liveRoot = join(root, 'data'); await mkdir(liveRoot, { recursive: true, mode: 0o700 });
    const nestedRoot = join(liveRoot, 'previews'); await mkdir(nestedRoot, { recursive: true, mode: 0o700 });
    const request = {
      previewId: 'preview-a', releaseId: 'release-1', artifact: artifactFor('1.0.0'),
      limits: previewRequest().limits, lifetimeMs: previewRequest().lifetimeMs as number,
      previewRoot: nestedRoot, liveDataRoot: liveRoot
    };
    // The placement is computed from the request, and the real port refuses it before creating the root.
    assert.equal(previewArgs(request).placement.dataRoot, join(nestedRoot, 'preview-a', 'data'));
    const nested = dockerPreviewPort({ docker: 'false' });
    await assert.rejects(() => nested.establish(request), /live data root/);
    assert.equal(await lstat(join(nestedRoot, 'preview-a', 'data')).then(() => 'there', () => 'gone'), 'gone', 'a refused placement creates no data root');
    // A valid placement whose runtime fails is cleaned up rather than left behind.
    const previewRoot = join(root, 'previews'); await mkdir(previewRoot, { recursive: true, mode: 0o700 });
    const failing = dockerPreviewPort({ docker: 'false' });
    await assert.rejects(() => failing.establish({ ...request, previewId: 'preview-b', previewRoot }), /did not answer|did not start/);
    assert.equal(await lstat(join(previewRoot, 'preview-b', 'data')).then(() => 'there', () => 'gone'), 'gone', 'a preview whose runtime failed leaves no data root behind');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the read-only commands create nothing on a root with no control store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-release-readonly-'));
  try {
    const absentRoot = join(root, 'data');
    for (const command of ['status', 'candidates', 'previews'] as const) {
      const result = cliResult(await run([command, '--data', absentRoot]));
      assert.equal(result.controlStore, 'absent', command + ' reports the absence');
      assert.equal(await lstat(absentRoot).then(() => 'there', () => 'gone'), 'gone', command + ' creates no data root');
    }
    assert.equal(await lstat(join(absentRoot, 'control.sqlite')).then(() => 'there', () => 'gone'), 'gone', 'no control store is created');
    const emptyRoot = join(root, 'empty'); await mkdir(emptyRoot, { recursive: true, mode: 0o700 });
    const status = cliResult(await run(['status', '--data', emptyRoot]));
    assert.equal(status.controlStore, 'absent', 'an existing empty directory is reported as absent, not initialized');
    assert.equal(await lstat(join(emptyRoot, 'control.sqlite')).then(() => 'there', () => 'gone'), 'gone', 'status does not initialize a control store');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a promotion history that exceeds what this build reads is refused rather than silently truncated', async () => {
  const f = await fixture();
  try {
    f.releases.createCandidate(candidateRequest());
    const insert = f.store.db.prepare('INSERT INTO operations (id,project_id,session_id,idempotency_key,kind,input_digest,input_json,state,revision,receipt_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    for (let index = 0; index < 1001; index += 1)
      insert.run('op-' + index, 'release-control', 'releases', 'release.promotion.' + index, 'release.promotion', 'd', '{}', 'pending', index, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    await refuses(() => f.releases.promotions(), /more than 1000 recorded events|silently truncated/, 'STORAGE');
    await refuses(() => f.releases.status(), /silently truncated/, 'STORAGE');
  } finally { await f.cleanup(); }
});

test('the release tool reports the same start blockers the doctor does, reusing the same mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-release-blockers-'));
  try {
    const data = join(root, 'data'); await mkdir(data, { recursive: true, mode: 0o700 });
    // An empty environment makes the probe 'unknown' deterministically: only the root's own evidence is asserted.
    assert.deepEqual(await dataRootStartBlockers(data, {}), [], 'a root with no lock and no pause marker blocks nothing');
    await writeFile(join(data, 'RESTORE-PAUSED.json'), '{}\n', { mode: 0o600 });
    assert.deepEqual(await dataRootStartBlockers(data, {}), ['restore-not-promoted']);
    await rm(join(data, 'RESTORE-PAUSED.json'));
    const held = await acquireServiceLock({ root: data, purpose: 'service', rootId: 'local-root', releaseId: 'release-1', schemaId: SCHEMA_ID });
    try { assert.deepEqual(await dataRootStartBlockers(data, {}), ['service-lock-present']); }
    finally { await held.release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

