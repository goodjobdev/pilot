import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeConfig } from './gateway/preflight.mjs';

const base = {
  GATEWAY_SERVICE_UID: '10002', PILOT_SERVICE_UID: '10001', TSNET_STATE_DIR: '/state', TSNET_HOSTNAME: 'node',
  TAILNET_OWNER_LOGIN: 'owner', TAILNET_GATEWAY_NODE_ID: 'gateway', TAILNET_HOST_NODE_ID: 'pilot', TAILNET_ALLOWED_REMOTE_NODE_IDS: 'device-a,device-b',
  INGRESS_ASSERTION_KEY_FILE: '/run/preview/keys/assertion.key', INGRESS_ASSERTION_PUBLIC_KEY_FILE: '/run/preview/keys/assertion.pub', PREVIEW_CORE_SOCKET: '/run/preview/socket/core.sock',
  PREVIEW_DOMAIN: 'gateway.tailnet-example.ts.net', PREVIEW_PORTS: '4301,4302',
  PREVIEW_CONTROL_HOST: 'control.example.net', DASHBOARD_ORIGIN: 'https://dashboard.example.org', PREVIEW_PRIVATE_IPV4: '127.0.0.1',
  PREVIEW_ALLOWED_PORTS: '3000,8080', PREVIEW_SITE_REVIEWED: 'true', PREVIEW_PORTS_REVIEWED: 'true',
};
const stat = (target) => target === '/state'
  ? { isDirectory: () => true, uid: 10002, mode: 0o040700 }
  : { isDirectory: () => true, uid: 10002, mode: 0o040700 };

test('accepts reviewed static deployment configuration and protected dirs', () => {
  assert.equal(validateRuntimeConfig(base, { uid: 10002, stat }), true);
});
test('accepts the base image version markers but not arbitrary variables', () => {
  assert.equal(validateRuntimeConfig({ ...base, NODE_VERSION: '24.22.3', YARN_VERSION: '1.22.22' }, { uid: 10002, stat }), true);
  assert.throws(() => validateRuntimeConfig({ ...base, NODE_OPTIONS: '--require=/tmp/x' }, { uid: 10002, stat }), /not permitted/);
});
test('rejects loose environment values and unreviewed site configuration', () => {
  assert.throws(() => validateRuntimeConfig({ ...base, TAILSCALE_AUTH_KEY: 'not-allowed' }, { uid: 10002, stat }), /not permitted/);
  assert.throws(() => validateRuntimeConfig({ ...base, PREVIEW_SITE_REVIEWED: 'false' }, { uid: 10002, stat }), /certify/);
});
test('rejects same-site preview, unreviewed ports, and a non-loopback target', () => {
  assert.throws(() => validateRuntimeConfig({ ...base, PREVIEW_CONTROL_HOST: 'gateway.tailnet-example.ts.net' }, { uid: 10002, stat }), /registrable site|different/);
  assert.throws(() => validateRuntimeConfig({ ...base, PREVIEW_DOMAIN: 'preview.example.net' }, { uid: 10002, stat }), /tailnet name/);
  assert.throws(() => validateRuntimeConfig({ ...base, PREVIEW_PORTS: '443,4319' }, { uid: 10002, stat }), /listener ports/);
  assert.throws(() => validateRuntimeConfig({ ...base, PREVIEW_PORTS: '4301,4301' }, { uid: 10002, stat }), /listener ports/);
  assert.throws(() => validateRuntimeConfig({ ...base, PREVIEW_PORTS_REVIEWED: 'false' }, { uid: 10002, stat }), /port allowlist/);
  assert.throws(() => validateRuntimeConfig({ ...base, PREVIEW_PRIVATE_IPV4: '10.0.0.2' }, { uid: 10002, stat }), /127.0.0.1/);
});
test('rejects UID mismatch, unsafe state mode, and non-certified port allowlist', () => {
  assert.throws(() => validateRuntimeConfig(base, { uid: 10001, stat }), /runtime UID/);
  assert.throws(() => validateRuntimeConfig(base, { uid: 10002, stat: () => ({ isDirectory: () => true, uid: 10002, mode: 0o040755 }) }), /mode 0700/);
  assert.throws(() => validateRuntimeConfig({ ...base, PREVIEW_ALLOWED_PORTS: '0,70000' }, { uid: 10002, stat }), /allowlist/);
});
