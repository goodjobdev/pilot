import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cloudflareTargetDigest, parseCloudflareTarget, redactCloudflareTarget
} from '../../src/shared/cloudflare-target';

const worker = {
  version: 1 as const, revision: 1, environment: 'production' as const,
  destination: { kind: 'workers' as const, accountId: 'a'.repeat(32), scriptName: 'synthetic-worker' }
};

test('Cloudflare target parsing is strict, revisioned and default-off', () => {
  const parsed = parseCloudflareTarget(worker);
  assert.equal(parsed.enabled, false);
  assert.throws(() => parseCloudflareTarget({ ...worker, revision: 0 }));
  assert.throws(() => parseCloudflareTarget({ ...worker, surprise: true }));
  assert.throws(() => parseCloudflareTarget({ ...worker, environment: 'staging' }));
  assert.throws(() => parseCloudflareTarget({ ...worker, destination: { ...worker.destination, projectName: 'synthetic-pages' } }));
});

test('target digest canonically binds resource kind, identity and environment', () => {
  const digest = cloudflareTargetDigest(worker);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, cloudflareTargetDigest({ ...worker, enabled: true }));
  assert.notEqual(digest, cloudflareTargetDigest({
    ...worker, destination: { kind: 'workers', accountId: 'b'.repeat(32), scriptName: 'synthetic-worker' }
  }));
  assert.notEqual(digest, cloudflareTargetDigest({
    ...worker, destination: { kind: 'workers', accountId: 'a'.repeat(32), scriptName: 'other-worker' }
  }));
  assert.notEqual(digest, cloudflareTargetDigest({ ...worker, environment: 'preview' }));
  assert.notEqual(digest, cloudflareTargetDigest({
    ...worker, destination: { kind: 'pages', accountId: 'a'.repeat(32), projectName: 'synthetic-worker' }
  }));
});

test('redacted display omits provider account and resource identifiers', () => {
  const safe = redactCloudflareTarget(worker);
  assert.deepEqual(safe, {
    kind: 'workers', revision: 1, enabled: false,
    environment: 'production', targetDigest: cloudflareTargetDigest(worker)
  });
  assert.equal(JSON.stringify(safe).includes('synthetic-worker'), false);
  assert.equal(JSON.stringify(safe).includes('a'.repeat(32)), false);
});
