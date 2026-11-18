import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from './gateway.js';
import { createRoute as submitPort, revokeRoute } from './management-ui.js';

const owner = 'owner@example.test';
const controlHost = 'control.example.com';
const previewDomain = 'preview.example.net';
const dashboardOrigin = 'https://dashboard.example.org';
const csrfHeaders = { 'x-gateway-csrf': 'same-origin', 'content-type': 'application/json' };
async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function request(port, { method = 'GET', path = '/', host = controlHost, origin = `https://${controlHost}`, headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...(origin ? { origin } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function fixture({ peerName = owner, peerNodeId = 'owner-device-1', unauthenticated = false } = {}) {
  const upstream = http.createServer((_req, res) => res.end('preview'));
  const upstreamPort = await listen(upstream);
  const core = createGateway({ owner, ownerDeviceIds: ['owner-device-1'], excludedNodeIds: ['oracle-node', 'gateway-node'], controlHost, previewDomain, previewPorts: [4301, 4302], dashboardOrigin, containerAddress: '127.0.0.1', allowedPorts: [upstreamPort, 4310], verifyPeer: async (address) => address && !unauthenticated ? { name: peerName, nodeId: peerNodeId } : null });
  const gatewayPort = await listen(core.server);
  return { upstream, core, gatewayPort, upstreamPort };
}

test('management HTML, JS and CSS are owner-only, same-origin, CSP-protected and host-bound', async (t) => {
  const f = await fixture(); t.after(async () => { await close(f.core.server); await close(f.upstream); });
  const html = await request(f.gatewayPort, { origin: null });
  assert.equal(html.status, 200); assert.match(html.body, /<select id="port"/); assert.match(html.body, /value="4310"/);
  for (const path of ['/', '/management.js', '/management.css']) {
    const browserGet = await request(f.gatewayPort, { path, origin: null });
    assert.equal(browserGet.status, 200, `GET ${path} without Origin`);
    const browserHead = await request(f.gatewayPort, { method: 'HEAD', path, origin: null });
    assert.equal(browserHead.status, 200, `HEAD ${path} without Origin`);
    assert.equal(browserHead.body, '');
    assert.equal((await request(f.gatewayPort, { path, origin: 'https://evil.example' })).status, 403);
  }
  assert.match(html.headers['content-security-policy'], /default-src 'none'/); assert.match(html.headers['content-security-policy'], /script-src 'self'/);
  assert.match(html.headers['content-security-policy'], /connect-src 'self'/); assert.match(html.headers['content-security-policy'], /frame-ancestors 'none'/);
  const js = await request(f.gatewayPort, { path: '/management.js' }); assert.equal(js.status, 200); assert.match(js.body, /export async function createRoute/);
  assert.equal((await request(f.gatewayPort, { path: '/management.css' })).status, 200);
  for (const path of ['/', '/management.js']) {
    assert.equal((await request(f.gatewayPort, { path, host: 'wrong.example.test' })).status, 404);
    assert.equal((await request(f.gatewayPort, { path, origin: 'https://evil.example' })).status, 403);
    assert.equal((await request(f.gatewayPort, { method: 'POST', path })).status, 405);
  }
});

test('forged and non-owner peers cannot read management HTML or JavaScript', async (t) => {
  for (const identity of [{ peerName: 'attacker@example.test' }, { peerNodeId: 'unapproved-device' }, { peerNodeId: 'gateway-node' }]) {
    const f = await fixture(identity); t.after(async () => { await close(f.core.server); await close(f.upstream); });
    for (const path of ['/', '/management.js']) {
      const response = await request(f.gatewayPort, { path, headers: { 'x-tailscale-user-login': owner, 'x-forwarded-for': '127.0.0.1' } });
      assert.equal(response.status, 403);
    }
  }
});

test('preview uses recognized PSL sites distinct from gateway control and dashboard', async () => {
  const base = { owner, ownerDeviceIds: ['owner-device-1'], excludedNodeIds: ['oracle-node', 'gateway-node'], dashboardOrigin: 'https://dashboard.example.co.uk', containerAddress: '127.0.0.1', allowedPorts: [4310], verifyPeer: async () => ({ name: owner, nodeId: 'owner-device-1' }) };
  const { dashboardOrigin: _dashboardOrigin, ...withoutDashboardOrigin } = base;
  assert.throws(() => createGateway({ ...withoutDashboardOrigin, controlHost: 'ui.example.co.uk', previewDomain: 'route.other.co.uk', previewPorts: [4301, 4302] }), /invalid controlHost, previewDomain, or dashboardOrigin/);
  assert.throws(() => createGateway({ ...base, controlHost: 'ui.example.co.uk', previewDomain: 'route.example.co.uk', previewPorts: [4301, 4302] }), /different browser site/);
  assert.doesNotThrow(() => createGateway({ ...base, controlHost: 'ui.example.co.uk', previewDomain: 'route.other.co.uk', previewPorts: [4301, 4302] }), 'control and dashboard may intentionally share a site');
  assert.throws(() => createGateway({ ...base, controlHost: 'ui.control.example.com', previewDomain: 'route.owner.github.io', previewPorts: [4301, 4302], dashboardOrigin: 'https://dashboard.owner.github.io' }), /different browser site/);
  assert.throws(() => createGateway({ ...base, controlHost: 'ui.owner.github.io', previewDomain: 'route.owner.github.io', previewPorts: [4301, 4302] }), /different browser site/);
  assert.throws(() => createGateway({ ...base, controlHost: 'ui.tailnet.ts.net', previewDomain: 'route.tailnet.ts.net', previewPorts: [4301, 4302] }), /different browser site/);
  assert.doesNotThrow(() => createGateway({ ...base, controlHost: 'ui.tailnet-one.ts.net', previewDomain: 'route.tailnet-two.ts.net', previewPorts: [4301, 4302] }));
  assert.throws(() => createGateway({ ...base, controlHost: 'ui.example.unknownzz', previewDomain: 'route.other.com', previewPorts: [4301, 4302] }), /recognized public suffixes/);
  assert.throws(() => createGateway({ ...base, controlHost: 'com', previewDomain: 'route.other.com', previewPorts: [4301, 4302] }), /recognized public suffixes/);
  for (const dashboardOrigin of ['http://dashboard.example.org', 'https://dashboard.example.unknownzz', 'https://dashboard.example.org/path', 'https://dashboard.example.org/foo/..', 'https://dashboard.example.org?', 'https://dashboard.example.org#', 'not-an-origin']) {
    assert.throws(() => createGateway({ ...base, controlHost: 'ui.control.example.com', previewDomain: 'route.preview.example.net', previewPorts: [4301, 4302], dashboardOrigin }), /DASHBOARD_ORIGIN|recognized public suffixes/);
  }
});

test('route API rejects cross-site Origin, missing CSRF and unapproved ports; selected port is the only submitted destination', async (t) => {
  const f = await fixture(); t.after(async () => { await close(f.core.server); await close(f.upstream); });
  assert.equal((await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', origin: 'https://evil.example', headers: csrfHeaders, body: JSON.stringify({ port: f.upstreamPort }) })).status, 403);
  assert.equal((await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', origin: null, headers: csrfHeaders, body: JSON.stringify({ port: f.upstreamPort }) })).status, 403);
  assert.equal((await request(f.gatewayPort, { method: 'DELETE', path: '/__gateway/routes/12345678-1234-1234-1234-123456789abc', origin: null, headers: { 'x-gateway-csrf': 'same-origin' } })).status, 403);
  assert.equal((await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: f.upstreamPort }) })).status, 403);
  assert.equal((await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', headers: csrfHeaders, body: JSON.stringify({ port: 1 }) })).status, 400);
  const calls = [];
  const route = await submitPort(f.upstreamPort, async (path, options) => {
    calls.push({ path, options });
    return { ok: true, json: async () => ({ id: '12345678-1234-1234-1234-123456789abc', port: f.upstreamPort, origin: 'https://preview-placeholder', path: '/' }) };
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), { port: f.upstreamPort });
  assert.equal(calls[0].path, '/__gateway/routes'); assert.equal(route.port, f.upstreamPort);
  assert.equal((await request(f.gatewayPort, { method: 'GET', path: '/__gateway/routes', host: 'wrong.example.test' })).status, 404);
});

test('revocation removes a mapping and extracted UI behavior issues only the guarded DELETE', async (t) => {
  const f = await fixture(); t.after(async () => { await close(f.core.server); await close(f.upstream); });
  const created = await request(f.gatewayPort, { method: 'POST', path: '/__gateway/routes', headers: csrfHeaders, body: JSON.stringify({ port: f.upstreamPort }) });
  assert.equal(created.status, 201); const route = JSON.parse(created.body);
  let preview = await request(f.gatewayPort, { host: route.host, origin: route.origin }); assert.equal(preview.status, 200);
  let call;
  await revokeRoute(route.id, async (path, options) => { call = { path, options }; return { ok: true }; });
  assert.equal(call.path, `/__gateway/routes/${route.id}`); assert.equal(call.options.method, 'DELETE');
  assert.equal(call.options.headers['x-gateway-csrf'], 'same-origin');
  assert.equal((await request(f.gatewayPort, { method: 'DELETE', path: `/__gateway/routes/${route.id}`, headers: { 'x-gateway-csrf': 'same-origin' } })).status, 204);
  preview = await request(f.gatewayPort, { host: route.host, origin: route.origin }); assert.equal(preview.status, 404);
});

test('all management resources and APIs require an owner session and unsupported methods fail closed', async (t) => {
  const denied = await fixture({ unauthenticated: true });
  t.after(async () => { await close(denied.core.server); await close(denied.upstream); });
  for (const path of ['/', '/management.js', '/management.css', '/__gateway/routes']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await request(denied.gatewayPort, { method, path, headers: csrfHeaders, body: method === 'POST' ? JSON.stringify({ port: denied.upstreamPort }) : '' });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  }
  const f = await fixture(); t.after(async () => { await close(f.core.server); await close(f.upstream); });
  for (const path of ['/', '/management.js', '/management.css', '/__gateway/routes']) {
    assert.equal((await request(f.gatewayPort, { method: 'OPTIONS', path })).status, 405);
  }
  assert.equal((await request(f.gatewayPort, { method: 'PUT', path: '/' })).status, 405);
});
