import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, chmodSync, writeFileSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CloudflareConnectionStore } from '../../src/server/state/cloudflare-connection-store';

const owner = { kind: 'owner', identity: 'fixture' }, target = { accountId: 'a'.repeat(32), workerName: 'fixture-worker' };
const token = 'synthetic_secret_token', replacement = 'rotated_secret_token';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pilot-cf-store-')), data = join(root, 'data'), project = join(root, 'project');
  mkdirSync(data); mkdirSync(project);
  return { root, data, project, path: join(data, 'credentials', 'cloudflare-connections.sqlite'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const change = (revision: number, credential: unknown, extra = {}) => ({ projectId: 'project', connectionId: 'connection', revision, target, credential, actor: owner, ...extra });

test('revisioned owner configuration is default-disabled, sanitized and bound to an exact Worker', () => {
  const f = fixture(), store = new CloudflareConnectionStore(f.data, [f.project]);
  try {
    const first = store.write(change(0, { kind: 'replace', token }));
    assert.equal(first.enabled, false); assert.equal(first.credentialConfigured, true);
    assert.equal(first.authority, 'https://api.cloudflare.com');
    assert.doesNotMatch(JSON.stringify(first), new RegExp(`${token}|${target.accountId}|${target.workerName}`));
    assert.deepEqual(store.read('project', 'connection'), first);
    assert.equal(store.read('other-project', 'connection'), null);
    const second = store.write(change(1, { kind: 'keep' }, { enabled: true }));
    assert.equal(second.enabled, true); assert.equal(second.targetDigest, first.targetDigest);
    const changed = store.write(change(2, { kind: 'replace', token: replacement }, { target: { ...target, workerName: 'different' }, enabled: true }));
    assert.notEqual(changed.targetDigest, first.targetDigest);
    assert.doesNotMatch(JSON.stringify(changed), new RegExp(`${token}|${replacement}`));
    assert.throws(() => store.write(change(3, { kind: 'remove' }, { enabled: true })), /credential is required/i);
    const removed = store.write(change(3, { kind: 'remove' }));
    assert.equal(removed.enabled, false); assert.equal(removed.credentialConfigured, false);
    assert.throws(() => store.write(change(4, { kind: 'keep' }, { enabled: true })), /credential is required/i);
    assert.throws(() => store.write(change(4, { kind: 'keep' }, { actor: { kind: 'agent', identity: 'fixture' } })), /Only the owner/);
    assert.throws(() => store.write(change(4, { kind: 'keep' }, { url: 'https://example.invalid' })), /Invalid Cloudflare/);
  } finally { store.close(); f.cleanup(); }
});

test('independent handles reject stale revisions, including after disabling or rotation', () => {
  const f = fixture(), first = new CloudflareConnectionStore(f.data, [f.project]), second = new CloudflareConnectionStore(f.data, [f.project]);
  try {
    first.write(change(0, { kind: 'replace', token }, { enabled: true }));
    first.write(change(1, { kind: 'replace', token: replacement }));
    assert.throws(() => second.write(change(1, { kind: 'keep' }, { enabled: true })), /revision conflict/);
    assert.equal(second.read('project', 'connection')?.enabled, false);
    second.write(change(2, { kind: 'remove' }));
    assert.throws(() => first.write(change(2, { kind: 'keep' }, { enabled: true })), /revision conflict/);
  } finally { first.close(); second.close(); f.cleanup(); }
});

test('private filesystem permissions and project-root exclusions fail closed', () => {
  const f = fixture();
  try {
    assert.throws(() => new CloudflareConnectionStore(f.project, [f.project]), /outside every project/);
    const store = new CloudflareConnectionStore(f.data, [f.project]); store.close();
    assert.equal(statSync(join(f.data, 'credentials')).mode & 0o777, 0o700);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    chmodSync(join(f.data, 'credentials'), 0o755);
    assert.throws(() => new CloudflareConnectionStore(f.data, [f.project]), /insecure/);
    chmodSync(join(f.data, 'credentials'), 0o700);
    chmodSync(f.path, 0o644);
    assert.throws(() => new CloudflareConnectionStore(f.data, [f.project]), /insecure/);
    unlinkSync(f.path); symlinkSync(join(f.project, 'not-a-database'), f.path);
    assert.throws(() => new CloudflareConnectionStore(f.data, [f.project]), /insecure/);
  } finally { f.cleanup(); }
});

test('corrupt database and invalid stored rows fail closed without exposing secrets', () => {
  const f = fixture();
  try {
    const store = new CloudflareConnectionStore(f.data, [f.project]);
    store.write(change(0, { kind: 'replace', token })); store.close();
    const raw = new DatabaseSync(f.path); raw.prepare('UPDATE connections SET enabled=3').run(); raw.close();
    const reopened = new CloudflareConnectionStore(f.data, [f.project]);
    try { assert.throws(() => reopened.read('project', 'connection'), /unavailable or corrupt/); } finally { reopened.close(); }
    assert.ok(readFileSync(f.path).includes(Buffer.from(token)));
    const dropped = new DatabaseSync(f.path); dropped.exec('DROP TABLE connections'); dropped.close();
    assert.throws(() => new CloudflareConnectionStore(f.data, [f.project]), /unavailable or corrupt/);
    writeFileSync(f.path, 'invalid sqlite database');
    assert.throws(() => new CloudflareConnectionStore(f.data, [f.project]), /unavailable or corrupt/);
  } finally { f.cleanup(); }
});

test('concurrent processes cannot both update the same previous revision', async () => {
  const f = fixture(), store = new CloudflareConnectionStore(f.data, [f.project]);
  store.write(change(0, { kind: 'replace', token })); store.close();
  const script = `
    import { CloudflareConnectionStore } from './src/server/state/cloudflare-connection-store.ts';
    const store = new CloudflareConnectionStore(process.argv[1], [process.argv[2]]);
    console.log('ready');
    process.stdin.once('data', () => {
      try { store.write({projectId:'project',connectionId:'connection',revision:1,target:{accountId:'${target.accountId}',workerName:'fixture-worker'},credential:{kind:'keep'},actor:{kind:'owner',identity:'fixture'}}); console.log('written'); }
      catch (error) { console.log(error.message === 'Cloudflare connection revision conflict.' ? 'conflict' : 'unexpected'); }
      store.close();
    });
  `;
  const children = Array.from({ length: 2 }, () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.data, f.project], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }));
  try {
    const outputs = children.map(child => {
      let output = ''; child.stdout.on('data', chunk => { output += chunk; });
      return () => output;
    });
    // Bounded: an unresponsive child must fail the test rather than hang it.
    const bounded = (child: ReturnType<typeof spawn>, ms: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not report readiness in time')), ms);
      once(child.stdout!, 'data').then(() => { clearTimeout(timer); resolve(); }, (error: unknown) => { clearTimeout(timer); reject(error); });
    });
    await Promise.all(children.map(child => bounded(child, 20000)));
    const exits = children.map(child => once(child, 'exit'));
    for (const child of children) child.stdin.end('go');
    await Promise.all(exits);
    assert.deepEqual(outputs.map(output => output().trim().split('\n').at(-1)).sort(), ['conflict', 'written']);
    const reopened = new CloudflareConnectionStore(f.data, [f.project]);
    try { assert.equal(reopened.read('project', 'connection')?.revision, 2); } finally { reopened.close(); }
  } finally { for (const child of children) child.kill(); f.cleanup(); }
});

test('reopening rejects unexpected triggers, views, and indexes while accepting the primary-key autoindex', () => {
  for (const sql of [
    "CREATE TRIGGER hostile BEFORE UPDATE ON connections BEGIN SELECT RAISE(FAIL, 'unexpected trigger'); END",
    'CREATE VIEW hostile AS SELECT token FROM connections',
    'CREATE INDEX hostile ON connections(token)'
  ]) {
    const f = fixture();
    try {
      const store = new CloudflareConnectionStore(f.data, [f.project]);
      store.write(change(0, { kind: 'replace', token })); store.close();
      const clean = new CloudflareConnectionStore(f.data, [f.project]);
      assert.equal(clean.read('project', 'connection')?.revision, 1); clean.close();
      const raw = new DatabaseSync(f.path); raw.exec(sql); raw.close();
      assert.throws(() => new CloudflareConnectionStore(f.data, [f.project]), error => {
        assert.match(String(error), /unavailable or corrupt/);
        assert.doesNotMatch(String(error), new RegExp(token));
        return true;
      });
    } finally { f.cleanup(); }
  }
});

test('an already open store refuses schema changes from another handle before reading or writing', () => {
  const f = fixture(), store = new CloudflareConnectionStore(f.data, [f.project]);
  try {
    store.write(change(0, { kind: 'replace', token }));
    const raw = new DatabaseSync(f.path);
    try {
      for (const [create, drop] of [
        ["CREATE TRIGGER hostile BEFORE UPDATE ON connections BEGIN SELECT RAISE(FAIL, 'unexpected trigger'); END", 'DROP TRIGGER hostile'],
        ['CREATE VIEW hostile AS SELECT token FROM connections', 'DROP VIEW hostile'],
        ['CREATE INDEX hostile ON connections(token)', 'DROP INDEX hostile']
      ]) {
        raw.exec(create);
        assert.throws(() => store.read('project', 'connection'), /unavailable or corrupt/);
        assert.throws(() => store.write(change(1, { kind: 'replace', token: replacement })), /unavailable or corrupt/);
        raw.exec(drop);
      }
      assert.equal(store.read('project', 'connection')?.revision, 1);
      assert.equal(store.write(change(1, { kind: 'keep' })).revision, 2);
    } finally { raw.close(); }
  } finally { store.close(); f.cleanup(); }
});

test('schema DDL attempted inside the store\'s own read and write transaction windows cannot land', () => {
  const f = fixture(), store = new CloudflareConnectionStore(f.data, [f.project]);
  try {
    store.write(change(0, { kind: 'replace', token }, { enabled: true }));
    // Test-only access to the store's private connection. The transactions below are opened on that
    // connection to model the store's own BEGIN / BEGIN IMMEDIATE windows, which cannot be
    // interleaved from outside without adding a production hook; no production hook is added.
    const own = (store as unknown as { db: DatabaseSync }).db, other = new DatabaseSync(f.path);
    const trigger = "CREATE TRIGGER hostile BEFORE UPDATE ON connections BEGIN SELECT RAISE(FAIL, 'unexpected trigger'); END";
    try {
      other.exec('PRAGMA busy_timeout=50');
      // The store keeps rollback-journal mode, so a deferred BEGIN plus a read pins SHARED for the
      // whole window: a competing commit needs EXCLUSIVE and fails instead of landing mid-check.
      own.exec('BEGIN');
      assert.equal((own.prepare('SELECT count(*) AS n FROM connections').get() as { n?: unknown }).n, 1);
      assert.throws(() => other.exec(trigger), /locked|busy/i);
      own.exec('COMMIT');
      assert.equal(store.read('project', 'connection')?.revision, 1);
      // BEGIN IMMEDIATE reserves the write window for one connection.
      own.exec('BEGIN IMMEDIATE');
      assert.throws(() => other.exec('CREATE INDEX hostile ON connections(token)'), /locked|busy/i);
      own.exec('ROLLBACK');
      assert.equal(store.read('project', 'connection')?.revision, 1);
      // Only after the store's window ends can an object be committed, and it is refused then.
      other.exec('CREATE VIEW hostile AS SELECT token FROM connections');
      assert.throws(() => store.read('project', 'connection'), /unavailable or corrupt/);
      assert.throws(() => store.write(change(1, { kind: 'keep' })), /unavailable or corrupt/);
      other.exec('DROP VIEW hostile');
      assert.equal(store.read('project', 'connection')?.revision, 1);
      assert.equal(store.write(change(1, { kind: 'keep' })).revision, 2);
    } finally { other.close(); }
  } finally { store.close(); f.cleanup(); }
});
