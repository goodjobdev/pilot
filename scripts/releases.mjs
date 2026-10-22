/**
 * The release operator's tool: record a candidate, create a disposable isolated preview from it,
 * promote it, and roll back to the recorded previous release.
 *
 * Every command reads the durable release records from the control store of one data root. A command
 * that would change anything does nothing at all without an explicit --execute:
 *
 * - 'candidate create' records one immutable candidate. A candidate id is never reused for different
 *   content, and a candidate is never modified: a changed build needs a new candidate id.
 * - 'preview create' would create one disposable preview from a candidate. A preview has its own data
 *   root under the designated preview root, no production credentials, no tunnel, no network and no
 *   published port, a bounded lifetime and hard caps; a preview is never promoted, and the store
 *   refuses a placement that cannot establish every one of those properties.
 * - 'preview discard' removes only what the preview created (its container and its own data root) and
 *   records the removal.
 * - 'promote' points the service at a candidate's staged release directory by swapping the 'current'
 *   symlink atomically, and records the candidate, the release that was previously active (the
 *   rollback target), the instant and the actor at the next revision.
 * - 'rollback' returns to that recorded previous release, and is refused unless the target release can
 *   read the storage schema actually on disk; a newer on-disk schema points at the encrypted backup
 *   restore path instead of starting a service that would misread the data.
 *
 * Nothing here deletes a release directory or an image, and nothing here starts, stops or reconfigures
 * the running service: after a promotion the operator restarts it deliberately. See docs/RELEASES.md.
 */
import { spawn } from 'node:child_process';
import { lstat,mkdir,rename,rm,symlink,unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
/**
 * The store, the release module and the model are loaded lazily, so this file has one honest failure
 * mode: run with plain 'node' and the TypeScript sources cannot be interpreted, and the operator gets
 * one sentence telling them the command that works instead of a parser stack trace.
 */
async function runtime() {
  try {
    const [control, store, release, model, lock, server] = await Promise.all([
      import('../src/server/state/control-store.ts'),
      import('../src/server/state/release-store.ts'),
      import('../src/server/release.ts'),
      import('../src/shared/releases.ts'),
      import('../src/server/service-lock.ts'),
      import('../src/server/main.ts')
    ]);
    return {
      ControlStore: control.ControlStore, ReleaseStore: store.ReleaseStore,
      SUPPORTED_SCHEMA_IDS: release.SUPPORTED_SCHEMA_IDS, observeStorageSchema: release.observeStorageSchema,
      loadReleaseManifest: release.loadReleaseManifest, schemaVersionForId: release.schemaVersionForId,
      ReleaseError: model.ReleaseError, RELEASE_PREVIEW_LIMITS_DOCUMENTED: model.RELEASE_PREVIEW_LIMITS_DOCUMENTED,
      rollbackCompatibility: model.rollbackCompatibility, validatePreviewPlacement: model.validatePreviewPlacement,
      inspectServiceLock: lock.inspectServiceLock,
      restorePauseRefusal: server.restorePauseRefusal, dataRootStartBlockers: server.dataRootStartBlockers
    };
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' || code === 'ERR_UNKNOWN_FILE_EXTENSION')
      throw new Error('This tool reads the application sources, so it needs the repository TypeScript toolchain: run "pnpm exec tsx scripts/releases.mjs <command> ..." instead of plain node.');
    throw error;
  }
}

/** The documented preview bounds, as a literal so 'help' needs no TypeScript support at all. */
const PREVIEW_LIMITS_DOCUMENTED = 'memory 64MiB-8GiB, CPU 0.1-4, PIDs 16-512, lifetime 1 minute - 24 hours';

/** The container the preview runs in: the candidate's artifact, run for smoke testing only. */
const PREVIEW_CONTAINER_PORT = 4317;
const PREVIEW_CONTAINER_USER = '10001:10001';
const PREVIEW_TMPFS_BYTES = 64 * 1024 * 1024;
const PREVIEW_DATA_MOUNT = '/data';
const DOCKER_CLI_TIMEOUT_MS = 60_000;
/** The release directory and pointer names inside the release root. */
const CURRENT_POINTER = 'current';
const RELEASE_ID_OR_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/**
 * The exact command line one preview runs under, and the facts that command line establishes. It is
 * built here and nowhere else, so the placement the store validates is the placement this argv really
 * creates:
 *
 * - '--network none': the preview has no interface at all, so it cannot reach the live tunnel, a
 *   provider or any other service, and it publishes no port anywhere;
 * - exactly one '--volume <preview data root>:/data:rw' and no other host path, so the live data root
 *   and the production credentials directory are not mounted and are unreachable from it;
 * - no '--env-file' and no inherited environment: the preview is given two fixed, non-secret values
 *   and nothing from the deployment;
 * - '--cap-drop ALL', '--security-opt no-new-privileges', a non-root user and a read-only root
 *   filesystem: no capability is kept and none can be gained;
 * - '--pids-limit', '--memory' (with '--memory-swap' pinned to it) and '--cpus': the hard caps.
 */
export function previewArgs(request) {
  const environment = previewEnvironmentName(request.previewId);
  const tmpfs = '/tmp:rw,noexec,nosuid,size=' + PREVIEW_TMPFS_BYTES;
  const argv = Object.freeze([
    'run', '--rm', '--detach',
    '--name', environment,
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--user', PREVIEW_CONTAINER_USER,
    '--tmpfs', tmpfs,
    '--pids-limit', String(request.limits.pids),
    '--memory', String(request.limits.memoryBytes) + 'b',
    '--memory-swap', String(request.limits.memoryBytes) + 'b',
    '--cpus', String(request.limits.cpus),
    '--volume', join(request.previewRoot, request.previewId, 'data') + ':' + PREVIEW_DATA_MOUNT + ':rw',
    '--env', 'DASHBOARD_MODE=local',
    '--env', 'DASHBOARD_DATA=' + PREVIEW_DATA_MOUNT,
    '--env', 'DASHBOARD_RELEASE=' + request.releaseId,
    request.artifact.reference
  ]);
  const placement = {
    environment,
    dataRoot: join(request.previewRoot, request.previewId, 'data'),
    mountedHostPaths: [join(request.previewRoot, request.previewId, 'data')],
    credentials: [],
    tunnel: null,
    published: [],
    resourceCap: request.limits,
    lifetimeMs: request.lifetimeMs
  };
  return Object.freeze({ argv, placement });
}
/** The preview's container name. It is derived from the preview id, so it is identifiable and bounded. */
export function previewEnvironmentName(previewId) {
  if (typeof previewId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(previewId))
    throw new Error('A preview id must be 1-120 characters from A-Za-z0-9._:-');
  return 'pilot-preview-' + previewId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
}
/** The command that removes one preview container. It removes the container and nothing else. */
export function previewRemoveArgv(previewId) {
  return Object.freeze(['rm', '--force', previewEnvironmentName(previewId)]);
}
/** The immutable release directory a promotion points the service at, and the pointer it swaps. */
export function promotionPaths(request, options) {
  if (typeof request.releaseId !== 'string' || !RELEASE_ID_OR_DIRECTORY.test(request.releaseId))
    throw new Error('A release candidate must declare an opaque release id before anything can be pointed at it');
  const releaseRoot = resolve(options.releaseRoot);
  return Object.freeze({ target: join(releaseRoot, request.releaseId), pointer: join(releaseRoot, CURRENT_POINTER) });
}

/** Run one container command, bounded, and report its exit status rather than its output text. */
function runCli(binary, argv, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(binary, [...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.stdout?.resume();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); done({ code: null, error, stderr }); });
    child.once('close', (code) => { clearTimeout(timer); done({ code, error: null, stderr }); });
  });
}

/**
 * The preview container port: it creates the preview's own data root, starts the container the argv
 * above describes, and removes the container and that root on discard. A missing runtime, a missing
 * image or a failed start refuses the preview (the store then keeps only the reservation), and it
 * never runs the image on the host instead.
 */
export function dockerPreviewPort(options = {}) {
  const docker = (options.docker ?? '').trim() === '' ? 'docker' : options.docker.trim();
  return {
    async establish(request) {
      const { argv, placement } = previewArgs(request);
      // Validate the placement against the exact rules the store enforces *before* creating anything,
      // so a placement the store would refuse never leaves a data root behind. The rules live in the
      // shared model, so this is the same validation, not a second one.
      const { validatePreviewPlacement } = await import('../src/shared/releases.ts');
      validatePreviewPlacement(placement, {
        previewRoot: request.previewRoot,
        liveDataRoot: request.liveDataRoot,
        requestedLifetimeMs: request.lifetimeMs,
        requestedLimits: request.limits
      });
      await mkdir(placement.dataRoot, { recursive: true, mode: 0o700 });
      try {
        const version = await runCli(docker, ['version', '--format', '{{.Server.Version}}'], DOCKER_CLI_TIMEOUT_MS);
        if (version.code !== 0) throw new Error('the container runtime did not answer, so no preview container was created and nothing was run on the host instead');
        const started = await runCli(docker, argv, DOCKER_CLI_TIMEOUT_MS);
        if (started.code !== 0) throw new Error('the preview container did not start (the runtime reported a failure), so no preview was created and nothing was run on the host instead');
        return placement;
      } catch (error) {
        // A refused preview must not strand its data root: remove exactly what this call created.
        try { await rm(placement.dataRoot, { recursive: true, force: true }); } catch { /* the failure below is what is reported */ }
        throw error;
      }
    },
    async discard(request) {
      const placement = request.preview.placement;
      const report = { removed: [], environmentRemoved: false };
      const removed = await runCli(docker, previewRemoveArgv(request.preview.previewId), DOCKER_CLI_TIMEOUT_MS);
      report.environmentRemoved = removed.code === 0;
      if (placement !== null) {
        try { await rm(placement.dataRoot, { recursive: true, force: true }); report.removed = [placement.dataRoot]; }
        catch { /* the removal is reported by what is left, not by a claim */ }
      }
      return report;
    }
  };
}

/**
 * The promotion port: it swaps the 'current' symlink to the candidate's own immutable release
 * directory, atomically, and removes nothing at all. The staged directory must already exist: this
 * port never builds, copies or deletes a release.
 */
export function releasePromotionPort(options = {}) {
  if (typeof options.releaseRoot !== 'string' || options.releaseRoot === '')
    throw new Error('A release root is required to promote: it is the directory holding the immutable release directories and the current pointer');
  return {
    async activate(request) {
      const { target, pointer } = promotionPaths(request, { releaseRoot: options.releaseRoot });
      const staged = await lstat(target).catch(() => null);
      if (staged === null || !staged.isDirectory())
        throw new Error('the release directory for this candidate is not staged under the release root, so there is nothing to point the service at');
      const staging = join(resolve(options.releaseRoot), '.' + CURRENT_POINTER + '.' + randomUUID());
      await symlink(target, staging, 'dir');
      try { await rename(staging, pointer); }
      catch (error) { try { await unlink(staging); } catch { /* the failed staging link is reported above */ } throw error; }
      return { pointer: target, removed: [], activatedAt: new Date().toISOString() };
    }
  };
}

/** Whether a control store already exists at this data root, so a read-only command creates nothing. */
async function controlStoreExists(dataRoot) {
  try { const info = await lstat(join(resolve(dataRoot), 'control.sqlite')); return info.isFile() && !info.isSymbolicLink(); }
  catch { return false; }
}

/**
 * The startability pre-flight of one promote or rollback. Every refusal happens while the pointer is
 * still untouched, so the tool never reports success for a root the service would then refuse to
 * start against. It observes, in order:
 *
 * - the service lock, with the reviewed inspectServiceLock: ANY classification other than 'absent'
 *   refuses, because a promotion must not leave a locked root with a moved pointer (a crash that left
 *   '/data/service.lock' behind made the new container and then the rollback both refuse to start);
 * - the restore pause marker, which refuses a restored root an operator has not promoted;
 * - the staged '<release-root>/<releaseId>/release.json', read with the reviewed manifest loader, so
 *   a mis-staged directory is caught before the switch rather than after it;
 * - schema compatibility, with the same rollbackCompatibility rule a rollback obeys, run on a
 *   promotion too, so a candidate whose schema does not match the on-disk schema is refused.
 *
 * It returns { ok: true, details } or { ok: false, reason, code }. It is the single place these checks
 * live: the CLI uses it for the dry run and the plan, and injects the same function as the store's
 * canActivate so every caller is refused before the pointer moves.
 */
export async function activationPreflight({ dataRoot, releaseRoot, target, action, rt }) {
  const verb = action === 'rollback' ? 'rolled back' : 'promoted';
  // 1. The service lock. Any evidence refuses, exactly as startup refuses to acquire a held lock.
  let lock;
  try { lock = await rt.inspectServiceLock(dataRoot); }
  catch { lock = { classification: 'unreadable', reason: 'the service lock could not be inspected' }; }
  if (lock.classification !== 'absent')
    return {
      ok: false, code: 'CONFLICT',
      reason: 'The target data root carries service-lock evidence (' + lock.classification + ': ' + lock.reason + '), so nothing is ' + verb + ' while a lock is present and the pointer is left untouched. Clearing a stale lock is a deliberate operator action: there is no automatic recovery and no age- or PID-based takeover. After a kill that left the lock: stop the supervisor so nothing can restart the service (systemctl --user stop pilot, docker compose stop dashboard), confirm no Pilot process remains (pgrep -fl server.mjs), keep a copy of the record if you want the evidence, remove exactly that file (rm \'<data root>/service.lock\'), and start the service again. See docs/DEPLOYMENT.md (The service lock).'
    };
  // 2. A restored root an operator has not promoted is paused; a promotion or rollback targets a live root.
  const pauseRefusal = await rt.restorePauseRefusal(dataRoot).catch(() => null);
  if (pauseRefusal !== null)
    return { ok: false, code: 'CONFLICT', reason: pauseRefusal + ' Nothing was ' + verb + ' and no pointer moved.' };
  // 3. The staged release manifest: the candidate must name the exact released build that is staged.
  const manifestPath = join(resolve(releaseRoot), target.releaseId, 'release.json');
  let loaded;
  try { loaded = await rt.loadReleaseManifest({ DASHBOARD_RELEASE_MANIFEST: manifestPath }); }
  catch (error) {
    return { ok: false, code: 'NOT_FOUND', reason: 'The staged release manifest at ' + manifestPath + ' could not be read (' + (error?.message ?? String(error)) + '), so the tool cannot prove the release it would point at is the released build. Nothing was ' + verb + ' and no pointer moved.' };
  }
  if (loaded.status !== 'present')
    return { ok: false, code: 'NOT_FOUND', reason: 'The staged release directory for ' + target.releaseId + ' does not carry a valid release manifest at ' + manifestPath + ' (' + (loaded.reason ?? loaded.status) + '), so the tool cannot prove the release it would point at is the released build. Nothing was ' + verb + ' and no pointer moved.' };
  const manifest = loaded.manifest;
  if (manifest.releaseId !== target.releaseId)
    return { ok: false, code: 'CONFLICT', reason: 'The staged release manifest declares releaseId ' + manifest.releaseId + ', which does not match the candidate release id ' + target.releaseId + ', so the build staged there is not the release this candidate names. Nothing was ' + verb + ' and no pointer moved.' };
  if (manifest.schemaId !== target.schemaId)
    return { ok: false, code: 'CONFLICT', reason: 'The staged release manifest declares schemaId ' + manifest.schemaId + ', which does not match the candidate schema id ' + target.schemaId + '. Nothing was ' + verb + ' and no pointer moved.' };
  if (manifest.sourceDigest !== target.sourceDigest)
    return { ok: false, code: 'CONFLICT', reason: 'The staged release manifest ' + (manifest.sourceDigest === undefined ? 'declares no source digest' : 'declares source digest ' + manifest.sourceDigest) + ', which does not match the candidate source digest ' + target.sourceDigest + '. Nothing was ' + verb + ' and no pointer moved.' };
  // 4. Schema compatibility, by the same rule a rollback obeys: the release being pointed at must be
  // able to read the schema actually on disk. A newer, older, unknown or unobservable schema refuses.
  const observed = rt.observeStorageSchema(dataRoot);
  const observedForRule = observed.state === 'present' ? { state: 'present', version: observed.version } : { state: observed.state };
  const compatibility = rt.rollbackCompatibility({ target, observed: observedForRule, schemaVersionFor: rt.schemaVersionForId });
  if (!compatibility.compatible)
    return { ok: false, code: 'INCOMPATIBLE', reason: (action === 'rollback' ? '' : 'The promotion is refused: ') + compatibility.reason };
  return {
    ok: true,
    details: {
      serviceLock: lock.classification,
      restorePaused: false,
      stagedRelease: { path: manifestPath, releaseId: manifest.releaseId, schemaId: manifest.schemaId, sourceDigest: manifest.sourceDigest ?? null },
      compatibility
    }
  };
}

/* ----------------------------------------------------------------------------------------------- *
 * The command line
 * ----------------------------------------------------------------------------------------------- */

const USAGE = [
  'Usage: pnpm exec tsx scripts/releases.mjs <command> --data <live data root> [options]',
  '',
  'Read-only:',
  '  status                     --data <root>',
  '  candidates                 --data <root>',
  '  previews                   --data <root>',
  '',
  'Changes something (require --execute; without it nothing is written or created):',
  '  candidate create           --data <root> --id <id> --release <releaseId> --schema <schemaId>',
  '                             --source <source digest> --repository <image repository>',
  '                             --identity <digest or tag> [--kind digest|immutable-tag]',
  '                             --environment <target environment> [--created-at <instant>]',
  '  preview create             --data <root> --preview-root <directory outside the data root>',
  '                             --id <previewId> --candidate <candidateId> --lifetime-ms <ms>',
  '                             --memory-bytes <n> --cpus <n> --pids <n>',
  '  preview discard            --data <root> --id <previewId> [--revision <n>] [--preview-root <dir>]',
  '  promote                    --data <root> --candidate <candidateId> --expect-revision <n>',
  '                             --actor <identity> --release-root <directory holding releases>',
  '  rollback                   --data <root> --expect-revision <n> --actor <identity>',
  '                             --release-root <directory holding releases>',
  '',
  'A preview is disposable and is never promoted. The documented bounds are: ' + PREVIEW_LIMITS_DOCUMENTED + '.',
  'See docs/RELEASES.md for the procedure and what a refusal means.'
].join('\n');

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const name = token.slice(2);
    if (name === 'execute' || name === 'help') { flags.set(name, 'true'); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('The option --' + name + ' needs a value');
    flags.set(name, value);
    index++;
  }
  return { flags, positional };
}
function required(flags, name, command) {
  const value = flags.get(name);
  if (value === undefined || value === '') throw new Error(command + ' needs --' + name);
  return value;
}
function integer(flags, name, command) {
  const raw = required(flags, name, command);
  if (!/^[0-9]+$/.test(raw)) throw new Error('--' + name + ' must be a whole number');
  return Number(raw);
}
function dataRootOf(flags) {
  return resolve(required(flags, 'data', 'every command'));
}
/** The store, built with the preview and promotion ports this tool really uses. */
function releaseStoreFor(dataRoot, flags, rt, pending) {
  const store = new rt.ControlStore(dataRoot);
  const previewRoot = flags.get('preview-root');
  const releaseRoot = flags.get('release-root');
  return {
    store,
    releases: new rt.ReleaseStore(store, {
      ...(previewRoot === undefined ? {} : { previewRoot: resolve(previewRoot) }),
      previewPort: dockerPreviewPort({ docker: flags.get('docker') }),
      ...(releaseRoot === undefined ? {} : { promotionPort: releasePromotionPort({ releaseRoot: resolve(releaseRoot) }) }),
      // The store's own pre-flight: it runs the same observation between its stale-revision check and
      // the activation, so no caller — this CLI or any other — moves the pointer on an unstartable root.
      canActivate: async () => pending.target === null || pending.releaseRoot === null
        ? { ok: true }
        : activationPreflight({ dataRoot, releaseRoot: pending.releaseRoot, target: pending.target, action: pending.action, rt })
    })
  };
}
function previewRequestFrom(flags) {
  return {
    previewId: required(flags, 'id', 'preview create'),
    candidateId: required(flags, 'candidate', 'preview create'),
    lifetimeMs: integer(flags, 'lifetime-ms', 'preview create'),
    limits: {
      memoryBytes: integer(flags, 'memory-bytes', 'preview create'),
      cpus: Number(required(flags, 'cpus', 'preview create')),
      pids: integer(flags, 'pids', 'preview create')
    }
  };
}

async function run(argv, dependencies = {}) {
  const command = argv[0];
  const { flags } = parseArgs(argv.slice(1));
  if (command === undefined || command === 'help' || flags.has('help')) return { usage: USAGE };
  const dataRoot = dataRootOf(flags);
  const execute = flags.has('execute');
  const rt = dependencies.runtime ?? await runtime();
  const readOnly = command === 'status' || command === 'candidates' || command === 'previews';
  // A read-only command on a root with no control store must create nothing at all: no data root, no
  // control.sqlite, no lock. It reports the absence and stays read-only.
  if (readOnly && !(await controlStoreExists(dataRoot))) {
    const startBlockers = await rt.dataRootStartBlockers(dataRoot).catch(() => []);
    const base = { dataRoot, controlStore: 'absent', schema: rt.observeStorageSchema(dataRoot), supportedSchemaIds: [...rt.SUPPORTED_SCHEMA_IDS], startBlockers };
    const note = 'No control store exists at this data root, so there are no release records and nothing was created.';
    if (command === 'status') return { ...base, candidateCount: 0, previews: [], promotion: null, rollbackTarget: null, compatibility: null, note };
    if (command === 'candidates') return { ...base, candidates: [], note };
    return { ...base, previews: [], note };
  }
  const pending = { action: null, target: null, releaseRoot: null };
  const { store, releases } = releaseStoreFor(dataRoot, flags, rt, pending);
  try {
    if (command === 'status') {
      const status = releases.status();
      return {
        dataRoot,
        schema: rt.observeStorageSchema(dataRoot),
        supportedSchemaIds: [...rt.SUPPORTED_SCHEMA_IDS],
        candidateCount: releases.candidates().length,
        previews: releases.previews().map((preview) => ({ previewId: preview.previewId, state: preview.state, candidateId: preview.candidateId })),
        promotion: status.promotion === null ? null : {
          revision: status.promotion.revision, action: status.promotion.action, candidateId: status.promotion.candidateId,
          releaseId: status.promotion.releaseId, schemaId: status.promotion.schemaId, actor: status.promotion.actor,
          createdAt: status.promotion.createdAt, pointer: status.promotion.pointer,
          artifact: status.promotion.artifact
        },
        rollbackTarget: status.rollbackTarget,
        compatibility: status.compatibility,
        startBlockers: await rt.dataRootStartBlockers(dataRoot).catch(() => [])
      };
    }
    if (command === 'candidates') return { dataRoot, candidates: releases.candidates() };
    if (command === 'previews') return { dataRoot, previews: releases.previews() };
    if (command === 'candidate') {
      const action = argv[1];
      if (action !== 'create') throw new Error('Unknown candidate command: ' + String(action));
      const kind = flags.get('kind') ?? 'digest';
      const identity = required(flags, 'identity', 'candidate create');
      const repository = required(flags, 'repository', 'candidate create');
      const request = {
        candidateId: required(flags, 'id', 'candidate create'),
        releaseId: required(flags, 'release', 'candidate create'),
        schemaId: required(flags, 'schema', 'candidate create'),
        sourceDigest: required(flags, 'source', 'candidate create'),
        environment: required(flags, 'environment', 'candidate create'),
        createdAt: flags.get('created-at') ?? new Date().toISOString(),
        artifact: {
          repository,
          kind,
          identity,
          reference: kind === 'digest' ? repository + '@' + identity : repository + ':' + identity
        }
      };
      if (!execute) return { command: 'candidate create', wouldRecord: request, note: 'Nothing was written. Re-run with --execute to record this immutable candidate.' };
      return { command: 'candidate create', candidate: releases.createCandidate(request) };
    }
    if (command === 'preview') {
      const action = argv[1];
      if (action === 'create') {
        const request = previewRequestFrom(flags);
        const candidate = releases.candidate(request.candidateId);
        const previewRoot = resolve(required(flags, 'preview-root', 'preview create'));
        const plan = previewArgs({
          previewId: request.previewId, releaseId: candidate.releaseId, artifact: candidate.artifact,
          limits: request.limits, lifetimeMs: request.lifetimeMs, previewRoot
        });
        if (!execute) return {
          command: 'preview create', wouldCreate: { request, environment: plan.placement.environment },
          docker: ['docker', ...plan.argv], placement: plan.placement,
          note: 'Nothing was created. This preview is disposable and is never promoted; re-run with --execute to create it.'
        };
        return { command: 'preview create', preview: await releases.createPreview(request) };
      }
      if (action === 'discard') {
        const id = required(flags, 'id', 'preview discard');
        const before = releases.preview(id);
        if (!execute) return { command: 'preview discard', wouldDiscard: { previewId: id, state: before.state, revision: before.revision }, note: 'Nothing was removed. Re-run with --execute to remove the container and the preview data root.' };
        const revision = flags.get('revision');
        return { command: 'preview discard', preview: await releases.discardPreview({ previewId: id, ...(revision === undefined ? {} : { revision: Number(revision) }) }) };
      }
      throw new Error('Unknown preview command: ' + String(action));
    }
    if (command === 'promote') {
      const candidateId = required(flags, 'candidate', 'promote');
      const expectedRevision = integer(flags, 'expect-revision', 'promote');
      const actor = required(flags, 'actor', 'promote');
      const candidate = releases.candidate(candidateId);
      const status = releases.status();
      if (status.revision !== expectedRevision)
        throw new rt.ReleaseError('The promotion is stale: revision ' + expectedRevision + ' was read but the promotion history is at revision ' + status.revision + '. Re-read the status and promote again. Nothing was promoted.', 'CONFLICT');
      const releaseRoot = resolve(required(flags, 'release-root', 'promote'));
      const paths = promotionPaths({ releaseId: candidate.releaseId }, { releaseRoot });
      const staged = await lstat(paths.target).catch(() => null);
      if (staged === null || !staged.isDirectory())
        throw new rt.ReleaseError('The release directory for this candidate is not staged under the release root, so there is nothing to point the service at: stage the build at ' + paths.target + ' first. Nothing was promoted.', 'NOT_FOUND');
      // Pre-flight before anything is written or swapped, including for the dry run, so the plan
      // shows exactly the startability the switch depends on.
      const preflight = await activationPreflight({ dataRoot, releaseRoot, target: candidate, action: 'promote', rt });
      if (!preflight.ok) throw new rt.ReleaseError(preflight.reason, preflight.code ?? 'UNAVAILABLE');
      if (!execute) return {
        command: 'promote', candidate, preflight: preflight.details,
        wouldRecord: { revision: status.revision + 1, previousReleaseId: status.target?.releaseId ?? null, actor },
        wouldPoint: paths, note: 'Nothing was promoted. The service is not restarted by this tool: re-run with --execute, then restart it deliberately.'
      };
      pending.action = 'promote'; pending.target = candidate; pending.releaseRoot = releaseRoot;
      return { command: 'promote', promotion: await releases.promote({ candidateId, expectedRevision, actor }) };
    }
    if (command === 'rollback') {
      const expectedRevision = integer(flags, 'expect-revision', 'rollback');
      const actor = required(flags, 'actor', 'rollback');
      const status = releases.status();
      if (status.revision !== expectedRevision)
        throw new rt.ReleaseError('The rollback is stale: revision ' + expectedRevision + ' was read but the promotion history is at revision ' + status.revision + '. Re-read the status and roll back again. Nothing was promoted.', 'CONFLICT');
      if (status.rollbackTarget === null)
        throw new rt.ReleaseError('No previous release is recorded, so there is nothing to roll back to. Nothing was promoted.', 'NOT_FOUND');
      if (status.compatibility !== null && status.compatibility.compatible === false) throw new rt.ReleaseError(status.compatibility.reason, 'INCOMPATIBLE');
      const releaseRoot = resolve(required(flags, 'release-root', 'rollback'));
      const target = status.rollbackTarget;
      const preflight = await activationPreflight({ dataRoot, releaseRoot, target, action: 'rollback', rt });
      if (!preflight.ok) throw new rt.ReleaseError(preflight.reason, preflight.code ?? 'UNAVAILABLE');
      if (!execute) return {
        command: 'rollback', preflight: preflight.details,
        wouldRecord: { revision: status.revision + 1, releaseId: target.releaseId, actor },
        compatibility: status.compatibility, note: 'Nothing was promoted. Re-run with --execute, then restart the service deliberately.'
      };
      pending.action = 'rollback'; pending.target = target; pending.releaseRoot = releaseRoot;
      return { command: 'rollback', promotion: await releases.rollback({ expectedRevision, actor }) };
    }
    throw new Error('Unknown command: ' + command + '\n\n' + USAGE);
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2))
    .then((result) => {
      if (result && typeof result === 'object' && 'usage' in result) console.log(String(result.usage));
      else console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error?.name === 'ReleaseError' ? 'Refused: ' + error.message : 'Failed: ' + (error?.message ?? String(error)));
      process.exitCode = 1;
    });
}

export { parseArgs, run, USAGE, previewRequestFrom };
