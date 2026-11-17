import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStaticArtifact, LIMITS } from '../../prototypes/static-artifact.mjs';

const file = (path, text = '') => ({ path, type: 'file', bytes: Buffer.from(text) });
const root = () => file('index.html', 'hello');
const invalid = (entries) => assert.throws(() => createStaticArtifact(entries), /Invalid static artifact/);

test('canonical manifest has bytewise order, specified encoding and domain-separated digest', () => {
  const entries = [file('z.txt', 'z'), root(), file('A/a.txt', 'a'), { path: 'A', type: 'directory' }];
  const artifact = createStaticArtifact(entries);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { version: 1, totalBytes: 7, files: [
    { path: 'A/a.txt', size: 1, sha256: hash('a') },
    { path: 'index.html', size: 5, sha256: hash('hello') },
    { path: 'z.txt', size: 1, sha256: hash('z') },
  ] };
  assert.deepEqual(artifact.manifest, manifest);
  assert.equal(artifact.releaseId, hash('pilot-static-artifact-manifest-v1\0' + JSON.stringify(manifest)));
  assert.equal(artifact.releaseId, createStaticArtifact([...entries].reverse()).releaseId);
  assert.notEqual(artifact.releaseId, hash(JSON.stringify(manifest)));
  assert.notEqual(artifact.releaseId, createStaticArtifact([root(), file('z.txt', 'x'), file('A/a.txt', 'a')]).releaseId);
});

test('caller and returned bytes cannot mutate private snapshot or frozen manifest', () => {
  const bytes = Buffer.from('hello');
  const artifact = createStaticArtifact([{ path: 'index.html', type: 'file', bytes }]);
  bytes.fill(0);
  const first = artifact.readFiles();
  assert.equal(first[0].bytes.toString(), 'hello');
  first[0].bytes.fill(0);
  assert.equal(artifact.readFiles()[0].bytes.toString(), 'hello');
  assert.throws(() => { artifact.manifest.files[0].size = 100; }, TypeError);
  assert.throws(() => { artifact.manifest.files.push({}); }, TypeError);
});

test('rejects traversal, unsupported characters, duplicates and case-folded component collisions', () => {
  for (const path of ['/a', '../a', 'a/../b', './a', 'a//b', 'a/', 'a\\b', 'a\0b', 'é', 'x\ny', '']) invalid([root(), file(path)]);
  for (const entries of [
    [root(), root()], [root(), file('INDEX.HTML')],
    [root(), file('Foo/a'), file('foo/b')],
    [root(), file('a'), file('a/b')], [root(), file('a/b'), file('a')],
    [root(), { path: 'a', type: 'directory' }, { path: 'a', type: 'directory' }],
  ]) invalid(entries);
  invalid([file('not-index.html')]);
});

test('rejects links, special types, modes and other metadata', () => {
  for (const entry of [
    { path: 'link', type: 'symlink', bytes: Buffer.alloc(0) },
    { path: 'hard', type: 'hardlink', bytes: Buffer.alloc(0) },
    { path: 'device', type: 'device' },
    { ...file('a'), mode: 0o644 }, { ...file('a'), linkTarget: 'index.html' },
    { path: 'a', type: 'directory', mode: 0o755 },
    { path: 'a', type: 'file', bytes: 'not bytes' },
    { path: 'a', type: 'file', bytes: new Uint8Array(new SharedArrayBuffer(1)) },
  ]) invalid([root(), entry]);
});

test('enforces entry, path, file and total limits', () => {
  invalid([root(), file('a'.repeat(LIMITS.pathBytes + 1))]);
  invalid([root(), { path: 'big', type: 'file', bytes: Buffer.alloc(LIMITS.fileBytes + 1) }]);
  invalid([root(), ...Array.from({ length: LIMITS.entries }, (_, i) => file(`f${i}`))]);
  invalid([root(), ...Array.from({ length: 8 }, (_, i) => ({ path: `f${i}`, type: 'file', bytes: Buffer.alloc(LIMITS.fileBytes) }))]);
  assert.equal(createStaticArtifact([{ path: 'index.html', type: 'file', bytes: Buffer.alloc(LIMITS.fileBytes) }]).manifest.totalBytes, LIMITS.fileBytes);
});

test('uses intrinsic typed-array bounds rather than overridden properties', () => {
  const bytes = Buffer.alloc(LIMITS.fileBytes + 1);
  Object.defineProperty(bytes, 'byteLength', { value: 1 });
  invalid([{ path: 'index.html', type: 'file', bytes }]);
});

test('rejects proxies without invoking traps, including changing array lengths', () => {
  let traps = 0;
  const entries = new Proxy([root()], {
    get(target, key) {
      traps++;
      if (key === 'length') return traps < 3 ? 1 : LIMITS.entries * 1000;
      return Reflect.get(target, key);
    },
  });
  invalid(entries);
  const entry = new Proxy(root(), { ownKeys() { traps++; throw new Error('trap'); } });
  invalid([entry]);
  const bytes = new Proxy(Buffer.alloc(0), { get() { traps++; throw new Error('trap'); } });
  invalid([{ path: 'index.html', type: 'file', bytes }]);
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  invalid(revoked.proxy);
  assert.equal(traps, 0);
});

test('rejects accessor entries and fields without invoking shape-mutating getters', () => {
  let calls = 0;
  const entries = [root()];
  Object.defineProperty(entries, '0', { get() { calls++; return root(); } });
  invalid(entries);
  for (const key of ['path', 'type', 'bytes']) {
    const entry = root();
    Object.defineProperty(entry, key, { get() { calls++; entry.mode = 0o644; return key === 'path' ? 'index.html' : key === 'type' ? 'file' : Buffer.alloc(0); } });
    invalid([entry]);
    assert.equal(Object.hasOwn(entry, 'mode'), false);
  }
  const sparse = new Array(1);
  Object.setPrototypeOf(sparse, { 0: root() });
  invalid(sparse);
  invalid([{ ...root(), [Symbol('metadata')]: true }]);
  const hidden = root();
  Object.defineProperty(hidden, 'mode', { value: 0o644 });
  invalid([hidden]);
  assert.equal(calls, 0);
});
