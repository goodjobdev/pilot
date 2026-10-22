/**
 * Offline tools for one Pilot data root: a full-state encrypted backup, an isolated paused restore,
 * and the deliberate promotion that ends a restore's pause.
 *
 * What is captured is the complete application state under the data root: the catalog and every
 * board, the documentation and its media, the immutable image media store (media/<sha256>.bin, one
 * object per accepted image), the durable control store (operations, receipts, outbox,
 * approvals, sessions and their lifecycle) and the agent session databases. What is deliberately
 * excluded is listed in every manifest with a reason: the credentials directory is never included
 * and this tool has no opt-in to include it, the alert signing key and device endpoints are not
 * included, the application's own bounded board-snapshot history is not included, and the service
 * lock is never part of a backup, and the child fork worktrees under forks/ are a named exclusion
 * (they are derived from the project repository, which is its own backup) rather than an entry this
 * tool failed to recognise.
 *
 * An archive's author holds the passphrase, so an archive can always be crafted deliberately. The
 * containment rules — the payload path allowlist, the strict-inside-the-staging-root check below and
 * the paused root — exist so that even such an archive cannot write outside the destination directory
 * or make a restored root serve itself. They do not make an archive's contents trustworthy.
 *
 * SQLite databases are captured consistently through SQLite itself (VACUUM INTO) rather than by a
 * byte copy of the database file: the store runs in WAL mode, so committed rows can live in the -wal
 * sidecar and a naive copy of the main file can miss them entirely.
 *
 * The archive is one streamed, passphrase-encrypted file (scripts/backup-crypto.mjs documents the
 * scheme). A restore verifies before it writes, stages its output beside the destination and moves it
 * into place, and leaves the restored root paused behind a marker that startup refuses to serve until
 * an operator promotes it.
 */
import { createHash,randomBytes } from 'node:crypto';
import { constants,createReadStream } from 'node:fs';
import { chmod,lstat,mkdir,mkdtemp,open,readdir,readFile,realpath,rename,rm,rmdir,unlink,writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename,dirname,join,resolve,sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARCHIVE_FORMAT,ARCHIVE_FORMAT_VERSION,KDF_PARAMETERS,NONCE_BYTES,PASSPHRASE_ENV,PASSPHRASE_STDIN_ENV,SALT_BYTES,PayloadReader,buildHeader,digestFile,encodeRecord,isAuthenticationFailure,openArchive,resolvePassphrase,writeArchive } from './backup-crypto.mjs';
import { AUTHENTICATION_FAILURE } from './backup-crypto.mjs';
import { acquireServiceLock,inspectServiceLock } from '../src/server/service-lock.ts';
import { SUPPORTED_SCHEMA_IDS,UNRELEASED_LOCAL,observeStorageSchema,resolveRelease } from '../src/server/release.ts';

/** The marker a restore writes; startup refuses to serve a root that carries it. */
export const PAUSED_MARKER = 'RESTORE-PAUSED.json';
const PAUSED_FORMAT = 'pilot-restore-pause';
const PAUSED_VERSION = 1;
/** How each SQLite database in the archive was captured. */
export const DATABASE_COPY_METHOD = 'sqlite-vacuum-into';
const LEGACY_MANIFEST_VERSION = 1;
const MANIFEST_MAX_FILES = 20_000;
const PAYLOAD_PATH_MAX = 1_024;
const RECORD_MANIFEST = 'manifest';
const RECORD_FILE = 'file';
const RECORD_END = 'end';
const MAX_HEADER_MARKER_BYTES = 4_096;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LOCK_IDENTITY = /^[A-Za-z0-9._:-]{1,120}$/;
const LOCK_IDENTITY_RULE = 'must be 1-120 characters from A-Za-z0-9._:- because it is recorded in the service lock';
const SQLITE_SUFFIXES = new Set(['.sqlite','.sqlite3']);
/** One object of the immutable media store: the sha256 of the bytes it holds, and nothing else. */
const MEDIA_OBJECT = /^[a-f0-9]{64}\.bin$/;
/** Documentation and the media the wiki may serve. Mirrors src/shared/docs.ts (assetTypes) and DocStore. */
const DOCUMENT_EXTENSIONS = new Set(['.md','.mdx','.png','.jpg','.jpeg','.gif','.webp','.avif','.svg','.html','.htm']);
/** Derived or vendored folders hold nothing the application owns. Mirrors the application's own exclusions. */
const generatedSegments = new Set(['node_modules','dist','build','out','target','coverage','vendor','venv','.git','.astro','.svelte-kit','.next','.nuxt','.turbo','.cache','test-results','playwright-report','.runway','.kilo','.pi-web','tmp']);
const GENERATED_LIST = 'node_modules, dist, build, out, target, coverage, vendor, venv, .git, .astro, .svelte-kit, .next, .nuxt, .turbo, .cache, test-results, playwright-report, .runway, .kilo, .pi-web and tmp';
const payloadSegment = '[A-Za-z0-9._-]{1,200}';
const PAYLOAD_PATTERNS = [
  /^catalog\.json$/,
  /^control\.sqlite$/,
  new RegExp('^settings\\/' + payloadSegment + '\\.json$'),
  new RegExp('^agents\\/[a-f0-9-]{36}\\/' + payloadSegment + '\\.sqlite$'),
  new RegExp('^media\\/[a-f0-9]{64}\\.bin$'),
  new RegExp('^projects\\/[a-f0-9-]{36}\\/(?:' + payloadSegment + '\\/)*' + payloadSegment + '\\.(?:md|mdx|png|jpg|jpeg|gif|webp|avif|svg|html|htm)$')
];

const digest = data => createHash('sha256').update(data).digest('hex');
const extensionOf = name => { const dot = name.lastIndexOf('.'); return dot <= 0 ? '' : name.slice(dot).toLowerCase(); };
const isDirectoryDatabase = name => SQLITE_SUFFIXES.has(extensionOf(name));
const isCapturedDocument = name => DOCUMENT_EXTENSIONS.has(extensionOf(name));
const isGenerated = relative => relative.split('/').slice(0,-1).some(part => generatedSegments.has(part) || (part.startsWith('.') && part !== '.github'));
const quoteLiteral = value => "'" + value.replaceAll("'","''") + "'";

/**
 * Where one archived path lands in the restored root. Project files are held in the archive under
 * 'projects/<id>/...' and are restored into this root's own 'workspaces/<id>/...', which is what keeps
 * a restored catalog from ever pointing at the live data root's project trees.
 */
export function restoredPath(path) {
  const match = /^projects\/([a-f0-9-]{36})\/(.+)$/.exec(path);
  return match ? 'workspaces/' + match[1] + '/' + match[2] : path;
}

/** One segment of a payload path: an empty, '.' or '..' segment never names a real file here. */
const isSafeSegment = segment => segment.length > 0 && segment !== '.' && segment !== '..';

/**
 * A path this archive may hold. Everything else is refused, so a crafted manifest cannot escape the
 * restore root. The grammar admits no backslash and no leading slash, and every segment must be a real
 * name, so a '.', '..' or empty segment is refused exactly as the legacy branch's safe() refuses it:
 * the allowlist and that branch agree, rather than the allowlist being the weaker of the two.
 */
export function isPayloadPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > PAYLOAD_PATH_MAX) return false;
  if (path.includes('\\') || path.startsWith('/') || path.includes('\u0000')) return false;
  if (!path.split('/').every(isSafeSegment)) return false;
  return PAYLOAD_PATTERNS.some(pattern => pattern.test(path));
}
function isInside(root,path) { return path === root || path.startsWith(root + sep); }

/**
 * Where one archived path may land inside a staging root: the second containment layer behind the
 * allowlist. The path is mapped and then '..' hops are resolved, and the result must be strictly
 * inside the staging root, so a manifest that somehow passed the allowlist still cannot name a target
 * outside it. The refusal names no path: a crafted archive must not be able to use this error text as
 * an oracle. This matters because an archive's author holds the passphrase (docs/BACKUP.md).
 */
export function stagedTarget(stage,path) {
  const root = resolve(stage),target = resolve(root,restoredPath(path));
  if (target === root || !isInside(root,target))
    throw new Error('Refusing to place an archived path outside the restore destination: the archive is corrupted or was deliberately crafted, and nothing was written outside the destination.');
  return target;
}

/** Contained, symlink-free resolution used when reading the legacy plaintext format. */
async function safe(root,relative) {
  if (relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Unsafe backup path');
  let at = root;
  for (const part of relative.split('/')) { at = join(at,part); const info = await lstat(at); if (info.isSymbolicLink()) throw new Error('Symlinks are never followed in back up data'); }
  return at;
}
/** Every documentation or media file under a root, never following a symlink. */
async function walk(root,relative = '') {
  const result = [];
  for (const entry of await readdir(join(root,relative),{ withFileTypes: true })) {
    const path = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('A symbolic link inside planning data is never followed');
    if (entry.isDirectory()) result.push(...await walk(root,path));
    else if (entry.isFile() && isCapturedDocument(entry.name)) result.push(path);
  }
  return result;
}
async function isRegularFile(path) {
  try { const info = await lstat(path); return info.isFile() && !info.isSymbolicLink(); } catch { return false; }
}
async function newDirectory(path,options = {}) { await mkdir(path,{ mode: 0o700, ...options }); return realpath(path); }
async function hashFile(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length; }
  return { size,sha256: hash.digest('hex') };
}
async function writeAll(handle,buffer) {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer,written,buffer.length - written);
    if (bytesWritten === 0) throw new Error('A restored file could not be written');
    written += bytesWritten;
  }
}

/** The lock identity of the root being backed up: the manifest identity when available, mirroring startup. */
async function rootIdentity(root,env) {
  let releaseId = UNRELEASED_LOCAL,schemaId = SUPPORTED_SCHEMA_IDS[0],source = 'unreleased-local';
  let release;
  try { release = await resolveRelease(env,'local'); }
  catch (error) { release = { state: 'invalid',reason: (error).message }; }
  if (release.state === 'released') { releaseId = release.identity.releaseId; schemaId = release.identity.schemaId; source = 'release-manifest'; }
  else if (release.state === 'invalid') {
    // An invalid manifest is never silently downgraded: it is recorded, and the identity falls back
    // to the same bounded operator value startup would use.
    source = 'invalid-release-manifest';
    releaseId = validateIdentity('DASHBOARD_RELEASE',env.DASHBOARD_RELEASE ?? UNRELEASED_LOCAL);
  } else releaseId = validateIdentity('DASHBOARD_RELEASE',env.DASHBOARD_RELEASE ?? UNRELEASED_LOCAL);
  const named = env.DASHBOARD_ROOT_ID;
  const rootId = named === undefined ? createHash('sha256').update(root).digest('hex').slice(0,16) : validateIdentity('DASHBOARD_ROOT_ID',named);
  return { rootId,releaseId,schemaId,source };
}
function validateIdentity(name,value) {
  if (!LOCK_IDENTITY.test(value)) throw new Error(name + ' ' + LOCK_IDENTITY_RULE);
  return value;
}

/**
 * The complete source list for one root, plus the explicit exclusion list. Only known application
 * state is captured: an unrecognised data-root entry is reported as excluded instead of being
 * copied blindly, so the manifest states plainly what a preview of this archive does not contain.
 */
async function collectSources(root,catalog) {
  const entries = [];
  const excluded = [
    { path: 'credentials/',reason: 'provider API keys, provider sign-in tokens and project deploy keys are secrets: a restored root has none, this tool has no opt-in to include them, and a fresh sign-in plus new deploy keys are required afterwards' },
    { path: 'alerts/',reason: 'the private VAPID signing key (alerts/vapid.json) and the device push endpoints that belong to it; a restored root re-establishes alerts by enabling them again on each device' },
    { path: 'repositories/',reason: 'agent git worktrees: derived from the project repository, which is its own backup' },
    { path: 'forks/',reason: 'child fork worktrees (forks/<projectId>/<childSessionId>): derived state, each one being a commit of the project repository checked out again and held as a git worktree registered inside that repository, which is itself excluded because it is its own backup — so a restored root could not reuse the directory either, and losing it costs no commit. The fork records themselves are captured in control.sqlite; creating the fork again is what produces a worktree' },
    { path: 'service.lock',reason: 'the live service lock is ownership evidence for the process holding this root, and a backup is never taken while one is held' },
    { path: PAUSED_MARKER,reason: 'the restore pause marker of a restored root, not application data' },
    { path: 'snapshots/',reason: 'the bounded board revision history this application writes itself (snapshots/<projectId>/<timestamp>-<uuid>.md, the newest 20 per project, the older ones pruned automatically): it is derived from the boards that are captured, so a restore rebuilds it as boards are edited, and it is not the board a project is served from' },
    { path: GENERATED_LIST,reason: 'generated or vendored folders hold nothing the application owns' }
  ];
  const rootEntries = await readdir(root,{ withFileTypes: true });
  // The `media` entry is kept rather than skipped outright, because the container itself is validated
  // before its contents are read: a symlink or a non-directory must never be read as an empty store.
  const mediaEntry = rootEntries.find(entry => entry.name === 'media');
  for (const entry of rootEntries) {
    const name = entry.name;
    if (name === 'catalog.json' || name === 'control.sqlite' || name === 'workspaces' || name === 'agents' || name === 'settings' || name === 'media') continue;
    if (excluded.some(item => item.path.replace(/\/$/,'') === name)) continue;
    excluded.push({ path: name,reason: entry.isSymbolicLink()
      ? 'a symbolic link at the data root is never followed'
      : 'not captured by this tool: only catalog.json, control.sqlite, settings/, agents/ and the registered projects are application state; review it deliberately' });
  }
  const catalogPath = join(root,'catalog.json');
  if (!await isRegularFile(catalogPath)) throw new Error('The data root carries no catalog.json, so it is not a Pilot data root');
  entries.push({ path: 'catalog.json',kind: 'file',source: catalogPath });
  const controlPath = join(root,'control.sqlite');
  if (await isRegularFile(controlPath)) entries.push({ path: 'control.sqlite',kind: 'database',source: controlPath });
  const settings = join(root,'settings');
  for (const entry of await readdir(settings,{ withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink() || !entry.isFile() || extensionOf(entry.name) !== '.json') continue;
    const path = 'settings/' + entry.name;
    if (!isPayloadPath(path)) { excluded.push({ path,reason: 'a settings file outside the documented shape is not captured' }); continue; }
    entries.push({ path,kind: 'file',source: join(settings,entry.name) });
  }
  const agents = join(root,'agents');
  for (const entry of await readdir(agents,{ withFileTypes: true }).catch(() => [])) {
    const projectId = entry.name;
    if (entry.isSymbolicLink() || !entry.isDirectory() || !uuid.test(projectId)) {
      excluded.push({ path: 'agents/' + projectId,reason: 'an agent entry outside the documented shape is not captured' });
      continue;
    }
    for (const file of await readdir(join(agents,projectId),{ withFileTypes: true })) {
      const relative = 'agents/' + projectId + '/' + file.name;
      if (file.isSymbolicLink() || !file.isFile()) { excluded.push({ path: relative,reason: 'only regular agent session databases are captured' }); continue; }
      if (!isDirectoryDatabase(file.name)) { excluded.push({ path: relative,reason: 'not an agent session database' }); continue; }
      if (!isPayloadPath(relative)) { excluded.push({ path: relative,reason: 'a database name outside the documented shape is not captured' }); continue; }
      entries.push({ path: relative,kind: 'database',source: join(agents,projectId,file.name) });
    }
  }
  // The immutable image media store the application itself writes: one content-addressed object per
  // accepted image, under media/<sha256-of-the-stored-bytes>.bin. Its shape is exact, so an entry
  // outside it is reported as excluded rather than copied blindly. Losing this directory would lose
  // every stored image, which is why it is part of the complete state a backup captures.
  const media = join(root,'media');
  // The container is validated before its contents are read. A `media` that is a symbolic link is never
  // followed — following it would archive objects from outside the data root — and a `media` that is not
  // a directory cannot hold objects at all, so neither may be read as an empty store: the manifest would
  // then claim a complete capture of `media/` that never happened. Both fail the whole backup closed, the
  // way every other symlink inside planning data does (docs/BACKUP.md).
  if (mediaEntry && mediaEntry.isSymbolicLink())
    throw new Error('The data root entry media is a symbolic link, and nothing inside planning data is followed, so media/ cannot be captured: replace it with a real directory before taking a backup');
  if (mediaEntry && !mediaEntry.isDirectory())
    throw new Error('The data root entry media is not a directory, so media/ cannot be captured in full: move it aside before taking a backup');
  const mediaEntries = await readdir(media,{ withFileTypes: true }).catch(error => {
    // A data root that never stored an image simply has no media directory: that is not a failure, and
    // nothing is claimed for it. A media directory that exists but cannot be read cannot be captured in
    // full, so the backup is refused rather than reporting a complete capture it did not make.
    if (error.code === 'ENOENT') return [];
    throw new Error('The media directory could not be read, so this backup would not capture it in full: ' + error.message);
  });
  for (const entry of mediaEntries) {
    const path = 'media/' + entry.name;
    if (entry.isSymbolicLink() || !entry.isFile()) { excluded.push({ path,reason: 'only regular media objects are captured' }); continue; }
    if (!MEDIA_OBJECT.test(entry.name) || !isPayloadPath(path)) { excluded.push({ path,reason: 'a media entry outside the documented <sha256>.bin shape is not captured' }); continue; }
    entries.push({ path,kind: 'file',source: join(media,entry.name) });
  }
  for (const project of catalog.projects) {
    if (!uuid.test(project.id)) throw new Error('The catalog holds an invalid project ID');
    if (project.managed) {
      for (const relative of await walk(project.path)) {
        if (isGenerated(relative)) continue;
        const path = 'projects/' + project.id + '/' + relative;
        if (!isPayloadPath(path)) throw new Error('A project file outside the documented documentation and media shapes cannot be archived: ' + path);
        entries.push({ path,kind: 'file',source: await safe(project.path,relative) });
      }
    } else {
      const base = join(project.path,'docs','dashboard');
      await safe(project.path,'docs/dashboard');
      for (const relative of await walk(base)) {
        const path = 'projects/' + project.id + '/docs/dashboard/' + relative;
        if (!isPayloadPath(path)) throw new Error('A project file outside the documented documentation and media shapes cannot be archived: ' + path);
        entries.push({ path,kind: 'file',source: await safe(base,relative) });
      }
    }
  }
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error('Two source files map to the same archive path: ' + entry.path);
    seen.add(entry.path);
  }
  if (entries.length > MANIFEST_MAX_FILES) throw new Error('This data root holds more than ' + MANIFEST_MAX_FILES + ' files, which is beyond what one archive records');
  return { entries,excluded };
}

/** Capture a live SQLite database consistently through SQLite itself, never by copying the file bytes. */
async function vacuumInto(source,target) {
  let database;
  try { database = new DatabaseSync(source,{ readOnly: true }); }
  catch (error) { throw new Error('The SQLite database ' + basename(source) + ' could not be opened read-only: ' + error.message); }
  try { database.exec('VACUUM INTO ' + quoteLiteral(target)); }
  catch (error) { throw new Error('The SQLite database ' + basename(source) + ' could not be copied through SQLite (VACUUM INTO): ' + error.message); }
  finally { database.close(); }
  await chmod(target,0o600);
}
/** Every database is copied into the scratch area first, so later passes read one consistent copy. */
async function stageDatabases(entries,scratch) {
  let index = 0;
  for (const entry of entries) {
    if (entry.kind !== 'database') continue;
    const target = join(scratch,'database-' + (index++) + '-copy.sqlite');
    await vacuumInto(entry.source,target);
    entry.source = target;
  }
}

/**
 * An offline snapshot of the complete application state under one data root, written as a single
 * encrypted archive. The service lock is taken through the reviewed module (one lock protocol) and
 * any existing lock evidence refuses the backup without touching it.
 */
export async function backup(source,archive,options = {}) {
  const env = options.env ?? process.env;
  const root = await realpath(source);
  const target = resolve(archive);
  if (isInside(root,target)) throw new Error('The archive must be written outside the data root it backs up: ' + target + ' is inside ' + root);
  // An archive is created exclusively: an existing file is never overwritten. That exclusive create is
  // also what makes cleanup safe — writeArchive removes the partial archive it created itself, and this
  // tool never unlinks an archive path it did not create, so a file that appeared at that path
  // concurrently is left alone.
  if (await lstat(target).catch(() => undefined) !== undefined)
    throw new Error('Refusing to write over ' + target + ': it already exists. Give a new archive path so no earlier backup is touched.');
  const identity = await rootIdentity(root,env);
  const inspection = await inspectServiceLock(root,{ releaseId: identity.releaseId,schemaId: identity.schemaId });
  if (inspection.classification !== 'absent')
    throw new Error('Refusing to back up ' + root + ': ' + inspection.reason + '. Stop the service that owns this root first; a lock is evidence and is never cleared automatically.');
  let lock;
  try {
    lock = await acquireServiceLock({ root,purpose: 'backup',rootId: identity.rootId,releaseId: identity.releaseId,schemaId: identity.schemaId });
  } catch (error) {
    if ((error).code === 'EEXIST')
      throw new Error('Refusing to back up ' + root + ': ' + join(root,'service.lock') + ' appeared while this backup was starting, so this root may be in use. Nothing was written and that lock was left untouched.');
    throw error;
  }
  const passphrase = await resolvePassphrase({ passphrase: options.passphrase,env,readStdin: options.readPassphrase });
  const scratch = await mkdtemp(join(tmpdir(),'pilot-backup-copy-'));
  try {
    const raw = await readFile(await safe(root,'catalog.json'),'utf8');
    const catalog = JSON.parse(raw);
    if (catalog.version !== 1 || !Array.isArray(catalog.projects)) throw new Error('Unsupported catalog');
    const sources = await collectSources(root,catalog);
    await stageDatabases(sources.entries,scratch);
    const created = (options.now ?? (() => new Date()))().toISOString();
    const app = { releaseId: identity.releaseId,schemaId: identity.schemaId,source: identity.source };
    const storage = observeStorageSchema(root);
    const files = [];
    for (const entry of sources.entries) {
      const { size,sha256 } = await hashFile(entry.source);
      // The digest recorded in the manifest is the one archivePayload re-checks as it streams the
      // source, so a source that changes between these two reads fails the backup here instead of
      // producing an archive that only a restore would reject.
      entry.size = size;
      entry.sha256 = sha256;
      files.push({ path: entry.path,size,sha256 });
    }
    const manifest = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_FORMAT_VERSION,
      created,
      databaseCopyMethod: DATABASE_COPY_METHOD,
      root: { rootId: identity.rootId },
      app,
      storage: { controlSchema: storage.state === 'present' ? { state: 'present',version: storage.version } : { state: storage.state } },
      files,
      excluded: sources.excluded
    };
    const salt = randomBytes(SALT_BYTES),nonce = randomBytes(NONCE_BYTES);
    const header = buildHeader({ created,kdf: KDF_PARAMETERS,salt,nonce,app });
    const body = archivePayload({ manifest,entries: sources.entries });
    const written = await writeArchive(target,{ header,body,passphrase });
    return { archive: target,formatVersion: ARCHIVE_FORMAT_VERSION,created,app,rootId: identity.rootId,databaseCopyMethod: DATABASE_COPY_METHOD,storage: manifest.storage,projects: catalog.projects.length,files,excluded: sources.excluded,bytes: written.bytes,digest: await digestFile(target) };
  } finally {
    // The passphrase buffer is the only copy this process holds; the lock is released last, after
    // every writer this tool opened is closed, so the lock outlives them.
    passphrase.fill(0);
    await rm(scratch,{ recursive: true,force: true }).catch(() => {});
    await lock.release();
  }
}

/**
 * The manifest record first, then each file's record and its bytes, then the end record. Each source is
 * hashed as it is streamed and must match both the size and the sha256 its manifest entry records, so a
 * source that changed between the earlier hash pass and this read fails the backup instead of writing
 * an archive whose own manifest disagrees with the bytes inside it — a disagreement that would
 * otherwise surface only at restore. This function is exported so a test can drive that check with a
 * source it changes deliberately, without racing a real backup.
 */
export async function* archivePayload(input) {
  yield encodeRecord({ kind: RECORD_MANIFEST,format: ARCHIVE_FORMAT,version: ARCHIVE_FORMAT_VERSION,manifest: input.manifest });
  for (const entry of input.entries) {
    yield encodeRecord({ kind: RECORD_FILE,path: entry.path,size: entry.size });
    const hash = createHash('sha256');
    let written = 0;
    for await (const chunk of createReadStream(entry.source)) { hash.update(chunk); written += chunk.length; yield chunk; }
    const sha256 = hash.digest('hex');
    if (written !== entry.size || sha256 !== entry.sha256)
      throw new Error('The source changed while it was being archived: ' + entry.path + ' was ' + entry.size + ' bytes with sha256 ' + entry.sha256 + ' when it was hashed, and ' + written + ' bytes with sha256 ' + sha256 + ' when it was read');
  }
  yield encodeRecord({ kind: RECORD_END,files: input.entries.length });
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('The archive payload carries no manifest');
  if (manifest.format !== ARCHIVE_FORMAT) throw new Error('The archive payload manifest is not a Pilot backup manifest');
  if (manifest.version !== ARCHIVE_FORMAT_VERSION) throw new Error('Unsupported archive payload version ' + JSON.stringify(manifest.version) + ': this tool reads version ' + ARCHIVE_FORMAT_VERSION);
  if (typeof manifest.created !== 'string' || Number.isNaN(Date.parse(manifest.created))) throw new Error('The archive payload manifest carries no usable creation time');
  if (!Array.isArray(manifest.files) || manifest.files.length > MANIFEST_MAX_FILES) throw new Error('The archive payload manifest carries no usable file list');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object') throw new Error('The archive payload manifest holds a malformed file entry');
    if (!isPayloadPath(entry.path)) throw new Error('The archive manifest names a path this tool never writes: ' + String(entry.path));
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('The archive manifest carries no usable size for ' + entry.path);
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('The archive manifest carries no usable digest for ' + entry.path);
    if (seen.has(entry.path)) throw new Error('The archive manifest names the same path twice: ' + entry.path);
    seen.add(entry.path);
  }
  if (!seen.has('catalog.json')) throw new Error('The archive manifest carries no catalog.json, so it is not a complete backup');
  if (manifest.excluded !== undefined && !Array.isArray(manifest.excluded)) throw new Error('The archive manifest carries no usable exclusion list');
  return manifest;
}

/**
 * Refuse a destination inside a data root the service is using. The evidence is read through the
 * reviewed lock module, so the same classification startup, promotion and backup act on acts here, and
 * the message names no path: any destination inside a live root is refused, whatever it is called.
 * Only ancestors that exist and are real directories are inspected; nothing is created or changed.
 */
async function assertOutsideLiveDataRoots(target) {
  for (let at = dirname(target);at !== sep && at !== dirname(at);at = dirname(at)) {
    let info;
    try { info = await lstat(at); } catch { info = undefined; }
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    let inspection;
    try { inspection = await inspectServiceLock(at); } catch { inspection = undefined; }
    if (inspection && inspection.classification !== 'absent')
      throw new Error('Refusing to restore into a directory inside a data root that carries lock evidence: a restore creates a separate root and never writes inside the root a service is using. Restore into a new, separate directory outside every existing data root.');
  }
}

/** Refuse any destination that sits inside a live data root, is a live data root, or is not an empty directory. Nothing is written before this. */
async function assertRestorableDestination(target) {
  if (target === sep || target === '') throw new Error('A restore needs a destination directory');
  await assertOutsideLiveDataRoots(target);
  let info;
  try { info = await lstat(target); }
  catch (error) { if ((error).code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink()) throw new Error('Refusing to restore into ' + target + ': it is a symbolic link');
  if (!info.isDirectory()) throw new Error('Refusing to restore into ' + target + ': it exists and is not a directory');
  if (await isRegularFile(join(target,'service.lock')))
    throw new Error('Refusing to restore into ' + target + ': it already carries service.lock evidence, so it is a live data root. Restore into a new, separate directory and never over the root the service is using.');
  const entries = await readdir(target);
  if (entries.length) throw new Error('Refusing to restore into ' + target + ': it is not empty (' + entries.length + ' entries). A restore never overwrites or merges into existing data.');
  await rmdir(target);
}

/** Rewrite the archived catalog for its new root: project paths become workspaces inside the restored root. */
async function adoptCatalog(stage,newRoot) {
  const path = join(stage,'catalog.json');
  let text;
  try { text = await readFile(path,'utf8'); }
  catch { throw new Error('The archive carries no catalog.json'); }
  let catalog;
  try { catalog = JSON.parse(text); }
  catch { throw new Error('The archived catalog.json is not valid JSON'); }
  if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.projects)) throw new Error('The archived catalog.json is not a version-1 catalog');
  for (const project of catalog.projects) {
    if (!uuid.test(project.id)) throw new Error('The archived catalog holds an invalid project ID');
    if (!await isRegularFile(join(stage,'workspaces',project.id,'docs','dashboard','board.md')))
      throw new Error('The archive is incomplete: project ' + project.id + ' carries no board');
    project.path = join(newRoot,'workspaces',project.id);
    project.managed = true;
  }
  await writeFile(path,JSON.stringify(catalog,null,2) + '\n',{ mode: 0o600 });
  return catalog;
}

/**
 * The staging root a verify-only run maps every archived path into. Nothing is ever created there: it
 * exists so that verification and restoration run the same mapping and collision checks, and the two
 * cannot drift apart.
 */
const VIRTUAL_STAGE_ROOT = sep + 'pilot-verify-staging-root-that-is-never-created';

/** Create one staged file exclusively, after its parent directory exists. */
async function openStaged(target) {
  await mkdir(dirname(target),{ recursive: true,mode: 0o700 });
  return open(target,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),0o600);
}

/**
 * Stage one encrypted archive: authenticate and verify everything, then write it into the staging root.
 * A null stage verifies without writing anything at all, which is the read-only 'verify' command. Both
 * modes walk the same records, check the same manifest and header grammar, and verify the same digests.
 */
async function stageArchive(source,stage,options) {
  const writing = stage !== null;
  const stageRoot = stage ?? VIRTUAL_STAGE_ROOT;
  const env = options.env ?? process.env;
  if (!await isRegularFile(source)) throw new Error('The archive ' + source + ' is not a regular file');
  const archiveDigest = await digestFile(source);
  const passphrase = await resolvePassphrase({ passphrase: options.passphrase,env,readStdin: options.readPassphrase });
  let archive;
  try { archive = await openArchive(source,{ passphrase }); }
  finally { passphrase.fill(0); }
  try {
    const reader = new PayloadReader(archive.plaintext());
    const unreadable = 'so the passphrase is wrong, or the archive is corrupted or truncated. Nothing was written to the destination.';
    let first;
    try { first = JSON.parse(await reader.readLine()); }
    catch (error) {
      if (isAuthenticationFailure(error)) throw error;
      throw new Error('The archive payload does not begin with a readable manifest record, ' + unreadable);
    }
    if (!first || first.kind !== RECORD_MANIFEST) throw new Error('The archive payload does not begin with its manifest record');
    // Every archived path is mapped before anything is written, so a crafted manifest cannot collide
    // two of its entries into one restored file.
    const landed = new Set();
    if (first.format !== ARCHIVE_FORMAT || first.version !== ARCHIVE_FORMAT_VERSION) throw new Error('The archive payload record names an unsupported format');
    const manifest = validateManifest(first.manifest);
    let index = 0;
    for (;;) {
      let record;
      try { record = JSON.parse(await reader.readLine()); }
      catch (error) {
        if (isAuthenticationFailure(error)) throw error;
        throw new Error('The archive payload is unreadable at file ' + index + ', ' + unreadable);
      }
      if (!record || typeof record !== 'object') throw new Error('The archive payload carries a malformed record at file ' + index);
      if (record.kind === RECORD_END) {
        if (record.files !== manifest.files.length) throw new Error('The archive records ' + record.files + ' files but its manifest marks ' + manifest.files.length + ': the archive is corrupted or was altered');
        break;
      }
      if (record.kind !== RECORD_FILE) throw new Error('The archive payload carries an unknown record kind ' + JSON.stringify(record.kind));
      const entry = manifest.files[index];
      if (!entry || entry.path !== record.path || entry.size !== record.size)
        throw new Error('The archive payload does not match its manifest at file ' + index + ': the archive is corrupted or was altered');
      const target = stagedTarget(stageRoot,entry.path);
      if (landed.has(target)) throw new Error('Two archived paths land on the same restored file: ' + entry.path);
      landed.add(target);
      const handle = writing ? await openStaged(target) : null;
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of reader.readExactly(entry.size)) { hash.update(chunk); bytes += chunk.length; if (handle) await writeAll(handle,chunk); }
      } finally { if (handle) await handle.close(); }
      if (bytes !== entry.size) throw new Error('The archive payload ended inside ' + entry.path + ': the archive is truncated');
      if (hash.digest('hex') !== entry.sha256)
        throw new Error('The archived bytes of ' + entry.path + ' do not match the digest its manifest records: the archive is corrupted or was altered. Nothing was written to the destination.');
      index += 1;
    }
    // Authentication is only proven once the payload was consumed to its end, which is what makes the
    // stream's tag verify. Doing this here means a wrong passphrase or a tampered archive refuses
    // before the staged root is moved into place.
    await reader.drain();
    if (!archive.authenticated()) throw new Error(AUTHENTICATION_FAILURE);
    return { manifest,archiveDigest,archiveName: basename(source),formatVersion: ARCHIVE_FORMAT_VERSION };
  } finally { await archive.close().catch(() => {}); }
}

/**
 * Stage a version-1 plaintext directory backup, the format this tool wrote before the archive was
 * encrypted. It is read-only support kept deliberately: an operator holding an older backup can still
 * restore it, and the branch is explicit rather than a silent reinterpretation of a newer format.
 */
async function stageLegacy(source,stage) {
  const root = await realpath(source);
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('A version-1 backup is a plaintext directory');
  const manifestBytes = await readFile(await safe(root,'manifest.json'));
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('The version-1 backup carries no readable manifest.json'); }
  if (manifest.version !== LEGACY_MANIFEST_VERSION || !Array.isArray(manifest.files) || manifest.files.length > MANIFEST_MAX_FILES)
    throw new Error('Unsupported backup manifest: this tool reads the version-1 plaintext directory format and the version-' + ARCHIVE_FORMAT_VERSION + ' encrypted archive');
  // Backups made before the wiki stored board paths relative to docs/dashboard; canonicalise them on
  // the way in so one code path handles both shapes.
  const canonical = path => {
    const match = /^(projects\/[a-f0-9-]{36}\/)(.+)$/.exec(path);
    if (!match) return path;
    const rest = match[2];
    return rest === 'board.md' || rest.startsWith('sources/') ? match[1] + 'docs/dashboard/' + rest : path;
  };
  const files = [];
  const data = new Map();
  for (const entry of manifest.files) {
    const path = canonical(entry.path);
    if (!isPayloadPath(path)) throw new Error('A version-1 backup names a path this tool never writes: ' + String(entry.path));
    if (data.has(path)) throw new Error('A version-1 backup names the same path twice: ' + path);
    const bytes = await readFile(await safe(root,entry.path));
    if (digest(bytes) !== entry.sha256) throw new Error('The version-1 backup failed its checksum for ' + entry.path + ': nothing was written');
    data.set(path,bytes);
    files.push({ path,size: bytes.length,sha256: entry.sha256 });
  }
  const restored = new Set();
  for (const [path,bytes] of data) {
    const target = stagedTarget(stage,path);
    if (restored.has(target)) throw new Error('Two archived paths land on the same restored file: ' + path);
    restored.add(target);
    await mkdir(dirname(target),{ recursive: true,mode: 0o700 });
    await writeFile(target,bytes,{ flag: 'wx',mode: 0o600 });
  }
  return {
    manifest: { format: ARCHIVE_FORMAT,version: LEGACY_MANIFEST_VERSION,created: manifest.created,files,excluded: [],legacyPlaintext: true },
    archiveDigest: digest(manifestBytes),
    archiveName: basename(root),
    formatVersion: LEGACY_MANIFEST_VERSION
  };
}

/**
 * Restore one archive into an isolated, paused data root. The destination is refused unless it is
 * absent or an empty directory, it is refused when it or any of its ancestors carries lock evidence
 * (it may not sit inside a live data root at all); the archive is authenticated and every manifest
 * digest verified before anything is moved into place; and a failure removes the staging area so no
 * half-restored root is left behind. The staging root is paused from its first byte, so a root that
 * only a crash could leave behind is already paused, and the restored root always carries the marker.
 */
export async function restore(source,destination,options = {}) {
  const target = resolve(destination);
  await assertRestorableDestination(target);
  const parent = dirname(target);
  await mkdir(parent,{ recursive: true,mode: 0o700 });
  const scratch = await mkdtemp(join(parent,'.pilot-restore-'));
  const stage = join(scratch,'stage');
  await mkdir(stage,{ mode: 0o700 });
  const markerPath = join(stage,PAUSED_MARKER);
  const restoredAt = new Date().toISOString();
  // The pause marker is the first thing the staging root holds, before a single archive byte is
  // written: a partial tree that a crash can leave behind is therefore already paused, and a tree with
  // a catalog but no control store is never served as if it were a complete restore. Its final counts
  // replace these provisional values once every check has passed, and startup refuses the staging tree
  // in either state because the marker's presence is the signal.
  await writeFile(markerPath,JSON.stringify({
    format: PAUSED_FORMAT,
    version: PAUSED_VERSION,
    created: restoredAt,
    complete: false,
    archive: null,
    backup: null,
    credentials: 'absent'
  },null,2) + '\n',{ flag: 'wx',mode: 0o600 });
  try {
    const sourcePath = resolve(source);
    const info = await lstat(sourcePath).catch(() => undefined);
    if (!info) throw new Error('The backup to restore from does not exist: ' + sourcePath);
    if (info.isSymbolicLink()) throw new Error('Refusing to restore from ' + sourcePath + ': it is a symbolic link. Point at the archive or the version-1 directory itself.');
    const staged = info.isDirectory() ? await stageLegacy(sourcePath,stage) : await stageArchive(sourcePath,stage,options);
    const catalog = await adoptCatalog(stage,target);
    // The marker is refreshed in place with the final facts: it now names the archive it came from
    // (its name, the path it was restored from and its sha256, so 'promote' can re-check it), the
    // backup's creation time and file count, and it is marked complete.
    const marker = {
      format: PAUSED_FORMAT,
      version: PAUSED_VERSION,
      created: restoredAt,
      complete: true,
      archive: { name: staged.archiveName,path: sourcePath,sha256: staged.archiveDigest,formatVersion: staged.formatVersion },
      backup: { created: staged.manifest.created,files: staged.manifest.files.length,rootId: staged.manifest.root?.rootId ?? null,app: staged.manifest.app ?? null },
      credentials: 'absent'
    };
    await writeFile(markerPath,JSON.stringify(marker,null,2) + '\n',{ mode: 0o600 });
    await rename(stage,target);
    await rm(scratch,{ recursive: true,force: true }).catch(() => {});
    return {
      root: target,
      projects: catalog.projects.length,
      files: staged.manifest.files.length,
      formatVersion: staged.formatVersion,
      paused: true,
      marker,
      credentials: 'absent'
    };
  } catch (error) {
    await rm(scratch,{ recursive: true,force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Re-check the archive one restored root came from, when its marker names one and that file is still
 * there. Read-only: nothing is written. A marker this tool did not write, or one whose archive has
 * since been moved away, is not re-checked — the operator may have archived it elsewhere — but an
 * archive that is present and no longer matches the digest the marker recorded refuses the promotion,
 * so a root cannot be promoted silently on bytes that have changed since it was restored.
 */
async function assertArchiveUnchanged(archive) {
  if (!archive || typeof archive !== 'object') return;
  const { path,sha256 } = archive;
  if (typeof path !== 'string' || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return;
  if (!await isRegularFile(path)) return;
  if (await digestFile(path) !== sha256)
    throw new Error('Refusing to promote: the archive this root was restored from no longer matches the digest its restore marker recorded, so the restore cannot be trusted. Restore again from a verified archive, review the result and promote that root instead.');
}

/**
 * Deliberate promotion of a restored root: the one action that removes the pause marker. It refuses
 * anything that is not a paused, unused, structurally readable root whose archive still matches, so
 * promoting is an explicit operator decision and never an accident of starting the service.
 */
export async function promote(root) {
  const requested = resolve(root);
  const info = await lstat(requested).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error('Promotion needs an existing, non-symlink data root directory: ' + requested);
  const canonical = await realpath(requested);
  const markerPath = join(canonical,PAUSED_MARKER);
  const markerInfo = await lstat(markerPath).catch(() => undefined);
  if (!markerInfo) throw new Error('Refusing to promote ' + canonical + ': it carries no ' + PAUSED_MARKER + ', so it is not a paused restored root');
  if (markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.size > MAX_HEADER_MARKER_BYTES)
    throw new Error('Refusing to promote ' + canonical + ': ' + PAUSED_MARKER + ' is not the regular marker file a restore writes. Review it deliberately instead.');
  let marker;
  try { marker = JSON.parse(await readFile(markerPath,'utf8')); }
  catch { throw new Error('Refusing to promote ' + canonical + ': ' + PAUSED_MARKER + ' is unreadable, so this is not a marker this tool wrote. Review it deliberately instead.'); }
  if (!marker || marker.format !== PAUSED_FORMAT || marker.version !== PAUSED_VERSION)
    throw new Error('Refusing to promote ' + canonical + ': ' + PAUSED_MARKER + ' is not a version-' + PAUSED_VERSION + ' restore marker. Review it deliberately instead.');
  const lock = await inspectServiceLock(canonical);
  if (lock.classification !== 'absent')
    throw new Error('Refusing to promote ' + canonical + ': ' + lock.reason + '. Stop every Pilot process before promoting a restored root.');
  let catalog;
  try { catalog = JSON.parse(await readFile(join(canonical,'catalog.json'),'utf8')); }
  catch { throw new Error('Refusing to promote ' + canonical + ': its catalog.json is missing or unreadable'); }
  if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.projects)) throw new Error('Refusing to promote ' + canonical + ': its catalog.json is not a version-1 catalog');
  const schema = observeStorageSchema(canonical);
  if (schema.state === 'malformed') throw new Error('Refusing to promote ' + canonical + ': its durable control store is unreadable (' + schema.reason + ')');
  await assertArchiveUnchanged(marker.archive);
  await unlink(markerPath);
  return { root: canonical,promoted: true,marker,controlSchema: schema.state === 'present' ? schema.version : null };
}

/**
 * Read-only verification of one encrypted archive: exactly the authentication and the per-file digest
 * checks a restore runs, with no staging root and no write anywhere. It answers the operator's question
 * before any restore exists — "is this archive still intact, and will it restore?" — and it never
 * creates, moves, renames or deletes a file.
 */
export async function verifyArchive(source,options = {}) {
  const archive = resolve(source);
  const info = await lstat(archive).catch(() => undefined);
  if (!info) throw new Error('The archive to verify does not exist');
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error('Verifying needs the encrypted single-file archive: a version-1 plaintext directory backup carries no authentication and is checked by restoring it into an isolated directory instead');
  const staged = await stageArchive(archive,null,options);
  return {
    archive,
    verified: true,
    formatVersion: staged.formatVersion,
    created: staged.manifest.created,
    files: staged.manifest.files.length,
    rootId: staged.manifest.root?.rootId ?? null,
    archiveDigest: staged.archiveDigest,
    excluded: Array.isArray(staged.manifest.excluded) ? staged.manifest.excluded : []
  };
}

const USAGE = [
  'Usage:',
  '  node scripts/data-tools.mjs backup DATA_ROOT NEW_ARCHIVE_FILE',
  '  node scripts/data-tools.mjs verify ARCHIVE',
  '  node scripts/data-tools.mjs restore ARCHIVE NEW_ISOLATED_DATA_ROOT',
  '  node scripts/data-tools.mjs promote ISOLATED_DATA_ROOT',
  '',
  'Stop the service that owns the data root before a backup: a held service lock refuses it.',
  'The passphrase comes from ' + PASSPHRASE_ENV + ' in the environment, or from stdin when',
  PASSPHRASE_STDIN_ENV + '=1 is set. It is never taken from the command line, because a command',
  'line is visible in the process table and the shell history.',
  '',
  'verify reads an archive and writes nothing: it authenticates the whole archive and checks every',
  'payload digest, so an archive can be trusted (or refused) before a restore is attempted.',
  '',
  'restore writes a paused root: review the restored data, then run the promote command to remove',
  'the ' + PAUSED_MARKER + ' marker and start the service.'
].join('\n');

async function main(argv) {
  const [command,...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') { console.log(USAGE); return 0; }
  if (command === 'backup' && rest.length === 2) {
    const result = await backup(rest[0],rest[1]);
    console.log('Verified encrypted backup written: ' + result.archive + ' (' + result.files.length + ' files, ' + result.bytes + ' bytes, sha256 ' + result.digest + ').');
    console.log('It carries no credentials: copy it somewhere else as well, and treat the passphrase as the only key to it.');
    return 0;
  }
  if (command === 'verify' && rest.length === 1) {
    const result = await verifyArchive(rest[0]);
    console.log('Verified ' + result.archive + ': it authenticates as a whole, every payload digest matches its manifest and nothing was written (' + result.files + ' files, sha256 ' + result.archiveDigest + ').');
    return 0;
  }
  if (command === 'restore' && rest.length === 2) {
    const result = await restore(rest[0],rest[1]);
    console.log('Restored ' + result.files + ' files into ' + result.root + ' (' + result.projects + ' projects). The root is PAUSED: it carries ' + PAUSED_MARKER + ' and startup will refuse to serve it.');
    console.log('A restored root has no provider or deploy credentials: sign in again and generate new project deploy keys.');
    console.log('Review the restored data, then promote it: node scripts/data-tools.mjs promote ' + result.root);
    return 0;
  }
  if (command === 'promote' && rest.length === 1) {
    const result = await promote(rest[0]);
    console.log('Promoted ' + result.root + ': ' + PAUSED_MARKER + ' was removed deliberately. Start the service when you are ready.');
    return 0;
  }
  console.error(USAGE);
  return 1;
}

// Only a direct invocation runs the command line; importing this module is inert.
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  process.exitCode = await main(process.argv.slice(2)).catch(error => { console.error(error.message); return 1; });
}
