import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnosticProjection, effectiveConfig } from '../../src/server/effective-config';

const hosted = (overrides: NodeJS.ProcessEnv = {}) => effectiveConfig({
  DASHBOARD_MODE: 'hosted',
  DASHBOARD_ORIGIN: 'https://pilot.example.test',
  CF_ACCESS_TEAM: 'https://team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'synthetic-audience',
  DASHBOARD_OWNER: 'owner@example.test',
  ...overrides
});

test('valid local configuration defaults to explicit loopback and generated origin', () => {
  const config = effectiveConfig({ DASHBOARD_MODE: 'local' });
  assert.equal(config.mode, 'local');
  assert.equal(config.port, 4317);
  assert.equal(config.origin, 'http://127.0.0.1:4317');
  assert.deepEqual(config.allowedHosts, ['127.0.0.1:4317']);
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.exposure, 'host-loopback');
});

test('local port 80 uses its canonical HTTP origin and exact Host', () => {
  const config = effectiveConfig({ DASHBOARD_MODE: 'local', PORT: '80' });
  assert.equal(config.port, 80);
  assert.equal(config.origin, 'http://127.0.0.1');
  assert.deepEqual(config.allowedHosts, ['127.0.0.1']);
});

test('valid hosted loopback and explicit private-container profiles parse', () => {
  const loopback = hosted();
  assert.equal(loopback.mode, 'hosted');
  assert.equal(loopback.bindHost, '127.0.0.1');
  assert.equal(loopback.allowedHosts[0], 'pilot.example.test');

  const container = hosted({
    DASHBOARD_EXPOSURE: 'container-private-interface',
    DASHBOARD_BIND: '0.0.0.0'
  });
  assert.equal(container.exposure, 'container-private-interface');
  assert.equal(container.bindHost, '0.0.0.0');
});

test('local mode rejects wildcard/nonloopback bindings and container or tunnel exposure', () => {
  assert.throws(() => effectiveConfig({ DASHBOARD_MODE: 'local', DASHBOARD_BIND: '0.0.0.0' }), /host-loopback/);
  assert.throws(() => effectiveConfig({ DASHBOARD_MODE: 'local', DASHBOARD_BIND: '192.168.1.10' }), /host-loopback/);
  assert.throws(() => effectiveConfig({
    DASHBOARD_MODE: 'local', DASHBOARD_EXPOSURE: 'container-private-interface'
  }), /Local mode requires host-loopback/);
  assert.throws(() => effectiveConfig({
    DASHBOARD_MODE: 'local', DASHBOARD_ORIGIN: 'https://pilot.example.test'
  }), /Hosted identity settings/);
});

test('hosted identity, mode and exposure profiles fail closed', () => {
  assert.throws(() => effectiveConfig({}), /DASHBOARD_MODE explicitly/);
  assert.throws(() => effectiveConfig({ DASHBOARD_MODE: 'development' }), /DASHBOARD_MODE explicitly/);
  assert.throws(() => effectiveConfig({ DASHBOARD_MODE: 'local', DASHBOARD_EXPOSURE: 'tunnel' }), /DASHBOARD_EXPOSURE/);
  assert.throws(() => effectiveConfig({
    DASHBOARD_MODE: 'hosted', DASHBOARD_ORIGIN: 'https://pilot.example.test',
    CF_ACCESS_TEAM: 'https://team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud'
  }), /requires DASHBOARD_ORIGIN/);
  assert.throws(() => hosted({ DASHBOARD_BIND: '192.168.1.10' }), /host-loopback exposure/);
  assert.throws(() => hosted({
    DASHBOARD_EXPOSURE: 'container-private-interface', DASHBOARD_BIND: '127.0.0.1'
  }), /requires hosted mode and DASHBOARD_BIND=0.0.0.0/);
});

test('invalid ports, bind literals, IPv6, and noncanonical origins are rejected', () => {
  for (const PORT of ['0', '65536', '1.5', '4317junk']) {
    assert.throws(() => effectiveConfig({ DASHBOARD_MODE: 'local', PORT }), /port/);
  }
  for (const DASHBOARD_BIND of ['localhost', '::1', '[::1]', '127.000.0.1', '127.0.0.999']) {
    assert.throws(() => effectiveConfig({ DASHBOARD_MODE: 'local', DASHBOARD_BIND }), /IPv4 literal/);
  }
  for (const DASHBOARD_ORIGIN of [
    'https://pilot.example.test/path',
    'https://pilot.example.test/',
    'https://user@pilot.example.test'
  ]) {
    assert.throws(() => hosted({ DASHBOARD_ORIGIN }), /origin/);
  }
  assert.throws(() => hosted({ DASHBOARD_ORIGIN: 'http://pilot.example.test' }), /HTTPS origin/);
});

test('allowed Host is an exact origin singleton and never expands from aliases or forwarding headers', () => {
  assert.equal(hosted({ DASHBOARD_ALLOWED_HOSTS: 'pilot.example.test' }).allowedHosts[0], 'pilot.example.test');
  for (const DASHBOARD_ALLOWED_HOSTS of [
    '*', 'pilot.example.test,alias.example.test', 'alias.example.test', 'pilot.example.test:443'
  ]) {
    assert.throws(() => hosted({ DASHBOARD_ALLOWED_HOSTS }), /exact canonical origin host/);
  }
  const config = hosted({ 'X_FORWARDED_HOST': 'attacker.example.test' });
  assert.deepEqual(config.allowedHosts, ['pilot.example.test']);
  assert.equal(new URL(config.origin).host, 'pilot.example.test');
});

test('data and browse paths are normalized and malformed paths fail before use', () => {
  const config = effectiveConfig({
    DASHBOARD_MODE: 'local', DASHBOARD_DATA: './tmp/data', DASHBOARD_ROOTS: './docs:/tmp/other'
  });
  assert.ok(config.dataRoot.startsWith('/'));
  assert.equal(config.browseRoots.length, 2);
  const nul = String.fromCharCode(0);
  assert.throws(() => effectiveConfig({ DASHBOARD_MODE: 'local', DASHBOARD_DATA: nul }), /valid path/);
  assert.throws(() => effectiveConfig({ DASHBOARD_MODE: 'local', DASHBOARD_ROOTS: '/tmp' + nul + 'root' }), /invalid path/);
});

test('effective configuration and all collection fields are immutable', () => {
  const config = hosted();
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.security));
  assert.ok(Object.isFrozen(config.allowedHosts));
  assert.ok(Object.isFrozen(config.browseRoots));
  assert.throws(() => { (config as { port: number }).port = 1; }, TypeError);
  assert.throws(() => { (config.security as { token: string }).token = 'changed'; }, TypeError);
});

test('diagnostics expose effective policy without session or authentication secrets', () => {
  const config = hosted({
    CF_ACCESS_AUD: 'synthetic-sensitive-audience',
    DASHBOARD_OWNER: 'private-owner@example.test',
    CF_ACCESS_TEAM: 'https://private-team.cloudflareaccess.com'
  });
  const diagnostic = diagnosticProjection(config);
  const serialized = JSON.stringify(diagnostic);
  assert.equal(diagnostic.effective.host, 'pilot.example.test');
  assert.equal(diagnostic.effective.bind, '127.0.0.1');
  assert.equal(diagnostic.known.hostPolicy, 'exact-canonical-origin');
  assert.equal(diagnostic.attested.surroundingNetworkSafety, 'operator-attested-not-inferred');
  for (const secret of [config.security.token, 'synthetic-sensitive-audience', 'private-owner@example.test', 'private-team']) {
    assert.equal(serialized.includes(secret), false);
  }
});
