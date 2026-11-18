import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayConfig, parsePorts, RESERVED_LISTENER_PORTS } from './config.js';

const base = {
  TAILNET_OWNER_LOGIN: 'owner@example.test',
  TAILNET_ALLOWED_REMOTE_NODE_IDS: 'device-a,device-b',
  TAILNET_GATEWAY_NODE_ID: 'gateway',
  TAILNET_HOST_NODE_ID: 'pilot',
  PREVIEW_CONTROL_HOST: 'control.example.net',
  PREVIEW_DOMAIN: 'gateway.tailnet-example.ts.net',
  PREVIEW_PORTS: '4301,4302',
  DASHBOARD_ORIGIN: 'https://dashboard.example.org',
  PREVIEW_PRIVATE_IPV4: '127.0.0.1',
  PREVIEW_ALLOWED_PORTS: '5173,8080',
};

test('config carries the listener ports the ingress binds', () => {
  const config = buildGatewayConfig(base);
  assert.deepEqual(config.previewPorts, [4301, 4302]);
  assert.deepEqual(config.allowedPorts, [5173, 8080]);
  assert.equal(config.previewDomain, 'gateway.tailnet-example.ts.net');
  assert.deepEqual(config.excludedNodeIds, ['gateway', 'pilot']);
});

test('listener ports must be unprivileged, distinct and not reserved', () => {
  for (const port of RESERVED_LISTENER_PORTS) {
    assert.throws(() => parsePorts(String(port), { listeners: true }), /reserved|unprivileged/);
  }
  assert.throws(() => parsePorts('4301,4301', { listeners: true }), /distinct/);
  assert.throws(() => parsePorts('70000', { listeners: true }), /numeric|distinct/);
  assert.throws(() => parsePorts('', { listeners: true }), /distinct|numeric/);
  assert.throws(() => parsePorts('4301,', { listeners: true }), /numeric|distinct/);
});

test('upstream allowlist is separate from listener ports', () => {
  const config = buildGatewayConfig({ ...base, PREVIEW_ALLOWED_PORTS: '4319' });
  assert.deepEqual(config.allowedPorts, [4319]);
  assert.throws(() => buildGatewayConfig({ ...base, PREVIEW_PORTS: '4319' }), /reserved/);
});

test('missing configuration refuses instead of guessing', () => {
  for (const name of Object.keys(base)) {
    const env = { ...base };
    delete env[name];
    assert.throws(() => buildGatewayConfig(env), new RegExp(name));
  }
});
