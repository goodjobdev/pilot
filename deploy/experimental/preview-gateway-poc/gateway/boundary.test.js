import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePrivatePaths } from './boundary.js';

test('startup boundary fails closed when Linux UID and SO_PEERCRED support is unavailable', () => {
  if (process.platform !== 'linux') {
    assert.throws(() => validatePrivatePaths({ socketPath: '/tmp/core.sock', publicKeyPath: '/tmp/public.pem', serviceUid: 1001, pilotUid: 1002 }), /requires Linux UID and SO_PEERCRED support/);
  }
});

test('Linux startup accepts only protected UID-owned paths and no-follow public key files', (t) => {
  if (process.platform !== 'linux' || process.getuid() === 0) return t.skip('requires unprivileged Linux UID');
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.bridge-path-test-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyPath = path.join(dir, 'public.pem');
  fs.writeFileSync(keyPath, 'public-key', { mode: 0o600 });
  const socketPath = path.join(dir, 'core.sock');
  const options = { socketPath, publicKeyPath: keyPath, serviceUid: process.getuid(), pilotUid: process.getuid() + 1 };
  assert.equal(validatePrivatePaths(options).toString(), 'public-key');
  const keyLink = path.join(dir, 'key-link');
  fs.symlinkSync(keyPath, keyLink);
  assert.throws(() => validatePrivatePaths({ ...options, publicKeyPath: keyLink }));
  const socketLink = path.join(dir, 'socket-link');
  fs.symlinkSync(keyPath, socketLink);
  assert.throws(() => validatePrivatePaths({ ...options, socketPath: socketLink }));
  assert.throws(() => validatePrivatePaths({ ...options, pilotUid: process.getuid() }), /distinct/);
});
