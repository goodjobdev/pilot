import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createGateway } from './gateway.js';

const owner = 'owner@example.test';
const controlHost = 'control.example.com';
const previewDomain = 'preview.example.net';
const dashboardOrigin = 'https://dashboard.example.org';
const ownerHttpHeaders = { 'x-gateway-csrf': 'same-origin', 'content-type': 'application/json' };
async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function request(port, { method = 'GET', path = '/', host = controlHost, origin = `https://${controlHost}`, headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...(origin ? { origin } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function fixture({ peerName = owner, peerNodeId = 'owner-device-1', ttlMs = 5000, wsHandshakeTimeoutMs = 10_000, onUpstream, onUpgrade } = {}) {
  const upstream = http.createServer((req, res) => onUpstream ? onUpstream(req, res) : (res.setHeader('set-cookie', 'private=secret'), res.end('preview')));
  if (onUpgrade) upstream.on('upgrade', onUpgrade);
  const upstreamPort = await listen(upstream);
  let now = 1000;
  const core = createGateway({ owner, ownerDeviceIds: ['owner-device-1'], excludedNodeIds: ['oracle-node', 'gateway-node'], controlHost, previewDomain, previewPorts: [4301, 4302], dashboardOrigin, containerAddress: '127.0.0.1', allowedPorts: [upstreamPort], ttlMs, wsHandshakeTimeoutMs,
    now: () => now, verifyPeer: async (address) => address ? { name: peerName, ...(peerNodeId ? { nodeId: peerNodeId } : {}) } : null });
  const gatewayPort = await listen(core.server);
  return { upstream, core, gatewayPort, upstreamPort, setNow: (v) => { now = v; } };
}
async function createRoute(f) {
  const result = await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', headers: ownerHttpHeaders, body: JSON.stringify({ port: f.upstreamPort }) });
  assert.equal(result.status, 201, result.body); return JSON.parse(result.body);
}
function wsRequest(client, route, path = '/hmr') {
  client.write(`GET ${path} HTTP/1.1\r\nHost: ${route.host}\r\nOrigin: ${route.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
}

test('owner can create route; browser navigation/root-relative assets work and secrets are stripped', async (t) => {
  const f = await fixture(); t.after(async () => { await close(f.core.server); await close(f.upstream); });
  let received;
  f.upstream.removeAllListeners('request');
  f.upstream.on('request', (req, res) => { received = req.headers; res.setHeader('set-cookie', 'session=secret'); res.end(`path:${req.url}`); });
  const route = await createRoute(f);
  assert.equal(route.host, `${previewDomain}:${route.previewPort}`);
  assert.equal(route.origin, `https://${route.host}`);
  assert.ok([4301, 4302].includes(route.previewPort));
  const response = await request(f.gatewayPort, { path: '/src/main.js', host: route.host, origin: route.origin, headers: { authorization: 'Bearer secret', cookie: 'session=secret', 'x-tailscale-user-login': owner } });
  assert.equal(response.status, 200); assert.equal(response.body, 'path:/src/main.js');
  assert.equal(received.authorization, undefined); assert.equal(received.cookie, undefined); assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal((await request(f.gatewayPort, { path: '/index.html', host: route.host, origin: null })).status, 200);
});

test('spoofed identity headers and non-owner identities cannot authenticate', async (t) => {
  const f = await fixture({ peerName: 'intruder@example.test' }); t.after(async () => { await close(f.core.server); await close(f.upstream); });
  const res = await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', headers: { ...ownerHttpHeaders, 'x-tailscale-user-login': owner }, body: JSON.stringify({ port: f.upstreamPort }) });
  assert.equal(res.status, 403);
});

test('same-owner Oracle/gateway devices and missing or ambiguous node identity cannot manage routes', async (t) => {
  for (const peerNodeId of ['oracle-node', 'gateway-node', null, ['owner-device-1', 'oracle-node']]) {
    const f = await fixture({ peerNodeId }); t.after(async () => { await close(f.core.server); await close(f.upstream); });
    const res = await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', headers: ownerHttpHeaders, body: JSON.stringify({ port: f.upstreamPort }) });
    assert.equal(res.status, 403);
  }
});

test('strict host/origin, allowed port, expiry, and route revocation', async (t) => {
  const f = await fixture({ ttlMs: 1000 }); t.after(async () => { await close(f.core.server); await close(f.upstream); });
  assert.equal((await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', host: 'evil.test', headers: ownerHttpHeaders, body: '{}' })).status, 404);
  assert.equal((await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', origin: 'https://evil.test', headers: ownerHttpHeaders, body: '{}' })).status, 403);
  assert.equal((await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', headers: ownerHttpHeaders, body: '{"port":1}' })).status, 400);
  const route = await createRoute(f);
  assert.equal((await request(f.gatewayPort, { path: '/', host: route.host, origin: 'https://evil.test' })).status, 403);
  assert.equal((await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', host: route.host, origin: route.origin, headers: ownerHttpHeaders, body: '{}' })).status, 404);
  assert.equal((await request(f.gatewayPort, { method: 'DELETE', path: `/__gateway/routes/${route.id}`, headers: { 'x-gateway-csrf': 'same-origin' } })).status, 204);
  assert.equal((await request(f.gatewayPort, { path: '/', host: route.host, origin: route.origin })).status, 404);
  const expiring = await createRoute(f); f.setNow(2001);
  assert.equal((await request(f.gatewayPort, { path: '/', host: expiring.host, origin: expiring.origin })).status, 404);
});

test('upstream redirects and cookies are not exposed', async (t) => {
  const f = await fixture({ onUpstream: (_req, res) => { res.writeHead(302, { location: 'https://evil.test/', 'set-cookie': 'x=y' }); res.end(); } });
  t.after(async () => { await close(f.core.server); await close(f.upstream); });
  const route = await createRoute(f); const result = await request(f.gatewayPort, { path: '/', host: route.host, origin: route.origin });
  assert.equal(result.status, 502); assert.equal(result.headers.location, undefined); assert.equal(result.headers['set-cookie'], undefined);
});

test('websocket rejects bad origin and supports root-relative HMR path', async (t) => {
  const wsServer = http.createServer(); let receivedPath;
  wsServer.on('upgrade', (req, socket) => { receivedPath = req.url; socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n'); });
  const wsPort = await listen(wsServer);
  const gateway = createGateway({ owner, ownerDeviceIds: ['owner-device-1'], excludedNodeIds: ['oracle-node', 'gateway-node'], controlHost, previewDomain, previewPorts: [4301, 4302], dashboardOrigin, containerAddress: '127.0.0.1', allowedPorts: [wsPort], verifyPeer: async () => ({ name: owner, nodeId: 'owner-device-1' }) });
  const gatewayPort = await listen(gateway.server); t.after(async () => { await close(gateway.server); await close(wsServer); });
  const route = JSON.parse((await request(gatewayPort, { method: 'POST', path: '/__gateway/routes', headers: ownerHttpHeaders, body: JSON.stringify({ port: wsPort }) })).body);
  // Use a direct handshake helper to ensure a malicious Origin is actually sent.
  async function rawHandshake(origin) {
    return new Promise((resolve) => {
      const socket = net.connect(gatewayPort, '127.0.0.1'); let result = '';
      socket.on('connect', () => socket.write(`GET /@vite/client?direct HTTP/1.1\r\nHost: ${route.host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      socket.on('data', (b) => { result += b.toString(); socket.destroy(); }); socket.on('close', () => resolve(result)); setTimeout(() => socket.destroy(), 300).unref();
    });
  }
  assert.equal(await rawHandshake('https://attacker.test'), '');
  assert.match(await rawHandshake(route.origin), /101 Switching Protocols/);
  assert.equal(receivedPath, '/@vite/client?direct');
});

test('revoking a route terminates an established websocket on both sides', async (t) => {
  const peerSockets = new Set();
  const f = await fixture({ onUpgrade: (_req, socket) => { peerSockets.add(socket); socket.once('close', () => peerSockets.delete(socket)); socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n'); } });
  t.after(async () => { for (const s of peerSockets) s.destroy(); await close(f.core.server); await close(f.upstream); });
  const route = await createRoute(f); const activeRoute = f.core.routes.get(route.id); const client = net.connect(f.gatewayPort, '127.0.0.1'); let response = '';
  await new Promise((resolve, reject) => { client.on('connect', () => wsRequest(client, route)); client.on('data', (b) => { response += b.toString(); if (response.includes('\r\n\r\n')) resolve(); }); client.on('error', reject); setTimeout(() => reject(new Error('no WS response')), 1000).unref(); });
  assert.match(response, /101 Switching Protocols/); const tracked = [...activeRoute.connections]; assert.equal(tracked.length, 2);
  assert.equal((await request(f.gatewayPort, { method: 'DELETE', path: `/__gateway/routes/${route.id}`, headers: { 'x-gateway-csrf': 'same-origin' } })).status, 204);
  await Promise.race([new Promise((resolve) => client.once('close', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('WS client remained open')), 1000))]);
  assert.ok(tracked.every((s) => s.destroyed));
});

test('websocket handshake timeout closes the client when upstream stalls', async (t) => {
  let hangingSocket;
  const f = await fixture({ wsHandshakeTimeoutMs: 100, onUpgrade: (_req, socket) => { hangingSocket = socket; } });
  t.after(async () => { hangingSocket?.destroy(); await close(f.core.server); await close(f.upstream); });
  const route = await createRoute(f); const client = net.connect(f.gatewayPort, '127.0.0.1'); const closed = new Promise((resolve) => client.once('close', resolve));
  client.on('connect', () => wsRequest(client, route, '/@vite/client'));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('stalled WS remained open')), 1000))]);
  assert.ok(hangingSocket);
});

test('client disconnect during a stalled websocket handshake aborts upstream work', async (t) => {
  const peers = new Set();
  const f = await fixture({ onUpgrade: (_req, socket) => { peers.add(socket); socket.once('close', () => peers.delete(socket)); } });
  t.after(async () => { for (const socket of peers) socket.destroy(); await close(f.core.server); await close(f.upstream); });
  const route = await createRoute(f); const routeState = f.core.routes.get(route.id); const client = net.connect(f.gatewayPort, '127.0.0.1');
  client.on('connect', () => wsRequest(client, route));
  const deadline = Date.now() + 1000; while (routeState.connections.size < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(routeState.connections.size, 2);
  const clientClosed = new Promise((resolve) => client.once('close', resolve)); client.end();
  await Promise.race([clientClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('client did not disconnect')), 1000))]);
  const deadline2 = Date.now() + 1000; while (routeState.connections.size && Date.now() < deadline2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(routeState.connections.size, 0);
});

test('HTTP client cancellation aborts the upstream request', async (t) => {
  let upstreamClosedResolve; let startedResolve;
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; }); const started = new Promise((resolve) => { startedResolve = resolve; });
  const f = await fixture({ onUpstream: (_req, res) => { res.writeHead(200); res.write('first'); startedResolve(); res.on('close', upstreamClosedResolve); } });
  t.after(async () => { await close(f.core.server); await close(f.upstream); }); const route = await createRoute(f);
  const req = http.get({ host: '127.0.0.1', port: f.gatewayPort, path: '/stream', headers: { host: route.host, origin: route.origin } }, (res) => res.once('data', () => req.destroy()));
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream did not start')), 1000))]);
  await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not canceled')), 1000))]);
});

test('upstream stream failure after headers destroys downstream without appending JSON', async (t) => {
  const f = await fixture({ onUpstream: (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); setTimeout(() => res.socket.destroy(), 20); } });
  t.after(async () => { await close(f.core.server); await close(f.upstream); }); const route = await createRoute(f); const chunks = [];
  const status = await new Promise((resolve, reject) => {
    let responseStarted = false;
    const req = http.get({ host: '127.0.0.1', port: f.gatewayPort, path: '/', headers: { host: route.host, origin: route.origin } }, (res) => {
      responseStarted = true; res.on('data', (c) => chunks.push(c)); res.on('close', () => resolve(res.statusCode)); res.on('error', () => {});
    });
    req.on('error', (error) => { if (!responseStarted) reject(error); });
  });
  assert.equal(status, 200); const body = Buffer.concat(chunks).toString(); assert.match(body, /^partial/); assert.doesNotMatch(body, /upstream unavailable|\{"error"/);
});
