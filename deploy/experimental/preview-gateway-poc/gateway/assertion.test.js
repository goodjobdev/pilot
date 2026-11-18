import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createAssertionVerifier } from './assertion.js';
import { createGateway } from './gateway.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
let serial = 0;
function request(overrides = {}) {
  const claim = { iat: 10_000, exp: 15_000, jti: `unique-request-${++serial}`, login: 'owner@example.test', nodeId: 'approved-node', method: 'GET', rawUrl: '/asset?x=%2F', host: 'preview.example.test', ...overrides };
  const data = Buffer.from(JSON.stringify(claim));
  return { headers: { host: claim.host, 'x-pilot-ingress-assertion': `${data.toString('base64url')}.${sign(null, data, privateKey).toString('base64url')}` }, method: claim.method, url: claim.rawUrl };
}
function verifier(time = 10_500) {
  return createAssertionVerifier({ publicKey, ownerLogin: 'owner@example.test', allowedNodeIds: ['approved-node'], now: () => time });
}

test('private socket mode refuses to start without an exact peer credential verifier', () => {
  assert.throws(() => createGateway({ owner: 'owner@example.test', ownerDeviceIds: ['approved-node'], excludedNodeIds: ['gateway', 'host'], controlHost: 'control.example.com', previewDomain: 'preview.example.net', dashboardOrigin: 'https://dashboard.example.org', containerAddress: '127.0.0.1', allowedPorts: [3000], assertionVerifier: verifier(), privateSocketOnly: true }), /exact peer credential verification/);
});

test('accepts one fresh assertion only from private request source and binds all request attributes', () => {
  const v = verifier();
  assert.deepEqual(v.verifyRequest(request(), true), { login: 'owner@example.test', nodeId: 'approved-node' });
  assert.equal(v.verifyRequest(request(), false), null);
});

test('rejects absent, replayed, expired, future, and overlong-lived assertions', () => {
  const v = verifier();
  assert.equal(v.verifyRequest({ headers: {}, method: 'GET', url: '/' }, true), null);
  const replay = request();
  assert.ok(v.verifyRequest(replay, true));
  assert.equal(v.verifyRequest(replay, true), null);
  for (const overrides of [{ iat: 1, exp: 2 }, { iat: 20_000, exp: 22_000 }, { iat: 9_000, exp: 20_000 }]) {
    assert.equal(verifier().verifyRequest(request(overrides), true), null);
  }
});

test('rejects changed host, method, raw path, user, and node identity', () => {
  for (const [claim, mutate] of [
    [{}, (r) => { r.headers.host = 'changed.example.test'; }],
    [{}, (r) => { r.method = 'POST'; }],
    [{}, (r) => { r.url = '/changed?x=%2F'; }],
    [{ login: 'attacker@example.test' }, () => {}],
    [{ nodeId: 'unapproved-node' }, () => {}],
  ]) {
    const r = request(claim); mutate(r); assert.equal(verifier().verifyRequest(r, true), null);
  }
});

test('bounds replay state and fails closed when its configured capacity is reached', () => {
  const v = createAssertionVerifier({ publicKey, ownerLogin: 'owner@example.test', allowedNodeIds: ['approved-node'], now: () => 10_500, maxReplayEntries: 1 });
  assert.ok(v.verifyRequest(request(), true));
  assert.equal(v.verifyRequest(request(), true), null);
  assert.equal(v.seen.size, 1);
});

test('rejects modified signatures and malformed tokens', () => {
  const v = verifier(); const r = request(); r.headers['x-pilot-ingress-assertion'] += 'x';
  assert.equal(v.verifyRequest(r, true), null);
  assert.equal(v.verifyRequest({ headers: { 'x-pilot-ingress-assertion': 'bad' }, method: 'GET', url: '/' }, true), null);
});
