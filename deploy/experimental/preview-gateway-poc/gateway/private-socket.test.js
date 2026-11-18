import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createGateway } from './gateway.js';
import { createAssertionVerifier } from './assertion.js';

const owner = 'owner@example.test';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
function assertion(method, rawUrl, host, jti) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 3000, jti, login: owner, nodeId: 'approved', method, rawUrl, host }));
  return `${payload.toString('base64url')}.${sign(null, payload, privateKey).toString('base64url')}`;
}
function call(socketPath, method, rawUrl, host, token, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: rawUrl, headers: { host, ...(token ? { 'x-pilot-ingress-assertion': token } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('private Unix socket enforces assertion and only exposes authenticated management routes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnet-bridge-'));
  const socketPath = path.join(dir, 'gateway.sock');
  const upgradedSockets = new Set();
  const upstream = http.createServer((_req, res) => res.end('preview-upstream'));
  upstream.on('upgrade', (_req, socket) => {
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  const core = createGateway({ owner, ownerDeviceIds: ['approved'], excludedNodeIds: ['gateway', 'host'], controlHost: 'control.example.com', previewDomain: 'preview.example.net', previewPorts: [4301, 4302], dashboardOrigin: 'https://dashboard.example.org', containerAddress: '127.0.0.1', allowedPorts: [port], assertionVerifier: createAssertionVerifier({ publicKey, ownerLogin: owner, allowedNodeIds: ['approved'] }), privateSocketOnly: true, verifyPrivateSource: (socket) => socket.remoteAddress === undefined });
  await new Promise((resolve, reject) => { core.server.once('error', reject); core.server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  t.after(async () => { for (const socket of upgradedSockets) socket.destroy(); await new Promise((resolve) => core.server.close(resolve)); for (const socket of upgradedSockets) socket.destroy(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });

  assert.equal((await call(socketPath, 'POST', '/__gateway/routes', 'control.example.com', null, { 'content-type': 'application/json', 'x-gateway-csrf': 'same-origin' }, JSON.stringify({ port }))).status, 403);
  const managementHtml = await call(socketPath, 'GET', '/', 'control.example.com', assertion('GET', '/', 'control.example.com', 'socket-ui-get-private-1'));
  assert.equal(managementHtml.status, 200, 'owner can GET management UI without Origin on the private socket');
  assert.match(managementHtml.body, /Pilot preview management/);
  assert.equal((await call(socketPath, 'HEAD', '/management.js', 'control.example.com', assertion('HEAD', '/management.js', 'control.example.com', 'socket-ui-head-private-1'))).status, 200);
  assert.equal((await call(socketPath, 'GET', '/', 'control.example.com', null)).status, 403, 'unauthenticated UI access is denied');
  assert.equal((await call(socketPath, 'GET', '/', 'control.example.com', assertion('GET', '/', 'control.example.com', 'socket-ui-origin-private-1'), { origin: 'https://attacker.example' })).status, 403, 'mismatched Origin is denied');
  assert.equal((await call(socketPath, 'GET', '/', 'wrong.example.com', assertion('GET', '/', 'wrong.example.com', 'socket-ui-host-private-1'))).status, 404, 'management UI remains host-bound');
  const createPath = '/__gateway/routes';
  const created = await call(socketPath, 'POST', createPath, 'control.example.com', assertion('POST', createPath, 'control.example.com', 'socket-test-create-1'), { 'content-type': 'application/json', 'x-gateway-csrf': 'same-origin', origin: 'https://control.example.com' }, JSON.stringify({ port }));
  assert.equal(created.status, 201);
  const route = JSON.parse(created.body);
  const wsPath = '/hmr?query=one';
  const handshake = await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath); let output = '';
    socket.on('connect', () => socket.write(`GET ${wsPath} HTTP/1.1\r\nHost: ${route.host}\r\nOrigin: ${route.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Pilot-Ingress-Assertion: ${assertion('GET', wsPath, route.host, 'socket-test-websocket-1')}\r\n\r\n`));
    socket.on('data', (chunk) => { output += chunk.toString(); if (output.includes('\r\n\r\n')) resolve({ output, socket }); });
    socket.on('error', reject); setTimeout(() => { socket.destroy(); reject(new Error('WS handshake timed out')); }, 1000).unref();
  });
  assert.match(handshake.output, /101 Switching Protocols/);
  const changedPath = '/other';
  assert.equal((await call(socketPath, 'GET', changedPath, route.host, assertion('GET', '/tampered', route.host, 'socket-test-bad-path'), { origin: route.origin })).status, 403);
  assert.equal(upgradedSockets.size, 1);
  assert.equal(core.routes.get(route.id).connections.size, 2);
  const trackedSockets = [...core.routes.get(route.id).connections];
  const clientClosed = new Promise((resolve) => handshake.socket.once('close', resolve));
  const revoked = await call(socketPath, 'DELETE', `/__gateway/routes/${route.id}`, 'control.example.com', assertion('DELETE', `/__gateway/routes/${route.id}`, 'control.example.com', 'socket-test-revoke-1'), { origin: 'https://control.example.com', 'x-gateway-csrf': 'same-origin' });
  assert.equal(revoked.status, 204);
  await Promise.race([clientClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('client WebSocket remained open after revoke')), 1000))]);
  assert.equal(core.routes.has(route.id), false);
  assert.ok(trackedSockets.every((socket) => socket.destroyed), 'client and upstream gateway sockets must be destroyed on route revoke');
});

test('TCP source cannot use a valid signed ingress assertion', async (t) => {
  const core = createGateway({ owner, ownerDeviceIds: ['approved'], excludedNodeIds: ['gateway', 'host'], controlHost: 'control.example.com', previewDomain: 'preview.example.net', previewPorts: [4301, 4302], dashboardOrigin: 'https://dashboard.example.org', containerAddress: '127.0.0.1', allowedPorts: [1234], assertionVerifier: createAssertionVerifier({ publicKey, ownerLogin: owner, allowedNodeIds: ['approved'] }), privateSocketOnly: true, verifyPrivateSource: (socket) => socket.remoteAddress === undefined });
  await new Promise((resolve) => core.server.listen(0, '127.0.0.1', resolve));
  const port = core.server.address().port;
  t.after(() => new Promise((resolve) => core.server.close(resolve)));
  const token = assertion('GET', '/', 'control.example.com', 'tcp-forgery-test');
  const status = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'control.example.com', 'x-pilot-ingress-assertion': token } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
  });
  assert.equal(status, 403);
});
