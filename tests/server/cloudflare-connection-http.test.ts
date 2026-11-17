import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, jwtVerify } from 'jose';
import { createApp } from '../../src/server/main';
import { hostedConfig, localConfig, type SecurityConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { AGENT_SCOPES } from '../../src/shared/agent-registry';

/**
 * The owner's Cloudflare connection configuration over HTTP.
 *
 * This route stores one revisioned record and nothing else: it makes no provider request, deploys
 * nothing, exposes no token getter and installs no agent tool. These tests use disposable roots and
 * synthetic credentials, and they check the refusals in the route's own words rather than the
 * store's internal ones: the owner-only boundary, the default-off switch, a stale revision, the
 * absence of a secret in any response or log, restart persistence and the unchanged agent surface.
 */

const accountId = 'a'.repeat(32), workerName = 'fixture-worker';
const ownerToken = 'synthetic_owner_token', rotatedToken = 'rotated_owner_token';
const target = { accountId, workerName };
const connectionPath = (projectId: string) => '/projects/' + projectId + '/cloudflare-connections/connection';

/** A Host header is forbidden in `fetch`, so the hosted test drives the listener through `node:http`. */
const rawFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<Response>((resolve, reject) => {
  const req = httpRequest(url, { method: init.method, headers: init.headers }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(new Response(body, { status: res.statusCode, headers: res.headers as Record<string, string> }))); });
  req.on('error', reject);
  req.end(init.body);
});

type App = Awaited<ReturnType<typeof createApp>>;
type Call = (path: string, method?: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown, headers?: Record<string, string>) => Promise<Response>;

async function listen(app: App, security: SecurityConfig): Promise<void> {
  await new Promise<void>(ok => app.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
}

interface Instance {
  readonly root: string;
  readonly security: SecurityConfig;
  readonly call: Call;
  readonly writes: Record<string, string>;
}

/** A real application on a disposable root, with the Cloudflare switch controlled per test. */
async function localInstance(t: TestContext, options: { enabled?: boolean; control?: boolean } = {}): Promise<Instance> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cf-http-'));
  const security = localConfig('http://127.0.0.1:0'), control = options.control ? new ControlStore(root) : undefined;
  const app = await createApp({
    dataRoot: root, browseRoots: [], security,
    ...(control ? { control, agents: 'on' as const, agentPauseMs: 50 } : {}),
    ...(options.enabled === undefined ? {} : { cloudflareConnection: { enabled: options.enabled } })
  });
  await listen(app, security);
  const auth = { 'x-dashboard-token': security.token }, writes = { ...auth, origin: security.origin, 'content-type': 'application/json' };
  const call: Call = (path, method = 'GET', body, headers = method === 'GET' ? auth : writes) =>
    fetch(security.origin + '/api' + path, method === 'GET' ? { headers } : { method, headers, body: JSON.stringify(body) });
  t.after(async () => { await app.close(); control?.close(); await rm(root, { recursive: true, force: true }); });
  return { root, security, call, writes };
}

async function registerProject(call: Call, name = 'Cloudflare fixture'): Promise<string> {
  const created = await call('/projects', 'POST', { name, managed: true, confirm: true });
  assert.equal(created.status, 201);
  return (await created.json() as { id: string }).id;
}

const secretFree = (text: string): void => {
  assert.equal(text.includes(ownerToken), false, 'no response may repeat the credential');
  assert.equal(text.includes(rotatedToken), false, 'no response may repeat a rotated credential');
  assert.equal(text.includes(accountId), false, 'no response may repeat the account id');
  assert.equal(text.includes(workerName), false, 'no response may repeat the script name');
};

test('the route is owner-only, default-off and never repeats a secret', async t => {
  // Default-off: the switch is absent, so nothing may be opened, created or reported as configured.
  const disabled = await localInstance(t);
  const disabledProject = await registerProject(disabled.call);
  const disabledRead = await disabled.call(connectionPath(disabledProject));
  assert.equal(disabledRead.status, 503);
  assert.match((await disabledRead.json() as { error: string }).error, /DASHBOARD_CLOUDFLARE_CONNECTION=on/);
  const disabledWrite = await disabled.call(connectionPath(disabledProject), 'POST', { revision: 0, target, credential: { kind: 'replace', token: ownerToken } });
  assert.equal(disabledWrite.status, 503);
  const disabledWriteText = await disabledWrite.text();
  assert.match((JSON.parse(disabledWriteText) as { error: string }).error, /DASHBOARD_CLOUDFLARE_CONNECTION=on/);
  secretFree(disabledWriteText);
  await assert.rejects(access(join(disabled.root, 'credentials')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

  const instance = await localInstance(t, { enabled: true });
  const projectId = await registerProject(instance.call), path = connectionPath(projectId);
  // A first read of an unconfigured connection is an empty record at revision 0, not an error.
  const first = await instance.call(path);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { connection: null });
  // An unregistered project is a 404 from the catalog, before a store is opened.
  assert.equal((await instance.call(connectionPath('00000000-0000-4000-8000-000000000000'))).status, 404);
  // Owner-only: the same session token, Host, origin and JSON content type as every other route.
  assert.equal((await fetch(instance.security.origin + '/api' + path)).status, 401);
  assert.equal((await instance.call(path, 'POST', { revision: 0, target, credential: { kind: 'replace', token: ownerToken } }, { ...instance.writes, origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await instance.call(path, 'POST', { revision: 0, target, credential: { kind: 'replace', token: ownerToken } })).status, 200);
  // A caller cannot name the actor or the project in the body: the route derives both.
  const withActor = await instance.call(path, 'POST', { revision: 1, target, credential: { kind: 'keep' }, actor: { kind: 'owner', identity: 'elsewhere' } });
  assert.equal(withActor.status, 422);
  // Any other method is refused after the capability check, and a token getter does not exist.
  assert.equal((await instance.call(path, 'DELETE', {})).status, 405);
  assert.equal((await instance.call(path + '/token')).status, 404);

  // The secret can be captured by an onlooker only if the route or its log line repeats it.
  const logged: string[] = [], original = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let created: Response, read: Response, stale: Response;
  try {
    created = await instance.call(path, 'PUT', { revision: 1, target, credential: { kind: 'replace', token: rotatedToken }, enabled: true });
    read = await instance.call(path);
    stale = await instance.call(path, 'POST', { revision: 1, target, credential: { kind: 'keep' }, enabled: false });
  } finally { console.log = original.log; console.error = original.error; }
  assert.equal(created.status, 200);
  const createdText = await created.text();
  secretFree(createdText);
  const view = JSON.parse(createdText);
  assert.deepEqual(Object.keys(view.connection).sort(), ['authority', 'connectionId', 'credentialConfigured', 'enabled', 'projectId', 'revision', 'targetDigest']);
  assert.equal(view.connection.revision, 2);
  assert.equal(view.connection.enabled, true);
  assert.equal(view.connection.credentialConfigured, true);
  assert.equal(view.connection.authority, 'https://api.cloudflare.com');
  assert.match(view.connection.targetDigest, /^[a-f0-9]{64}$/);
  assert.equal(read.status, 200);
  const readText = await read.text();
  secretFree(readText);
  assert.deepEqual(JSON.parse(readText).connection, view.connection);
  // A stale revision writes nothing and says so, without the secret.
  assert.equal(stale.status, 409);
  assert.match((await stale.json() as { error: string }).error, /revision conflict/);
  assert.equal(JSON.parse(await (await instance.call(path)).text()).connection.revision, 2);
  assert.equal(logged.join('\n').includes(ownerToken) || logged.join('\n').includes(rotatedToken), false, 'the credential is never logged');
  secretFree(logged.join('\n'));
});

test('credential replace, keep and remove are revision-checked, and enabling needs a credential', async t => {
  const instance = await localInstance(t, { enabled: true });
  const projectId = await registerProject(instance.call), path = connectionPath(projectId);
  const bodies: string[] = [];
  const send = async (method: 'POST' | 'PUT', body: unknown) => {
    const response = await instance.call(path, method, body);
    bodies.push(await response.clone().text());
    return response;
  };
  const first = await (await send('POST', { revision: 0, target, credential: { kind: 'replace', token: ownerToken } })).json() as { connection: { revision: number; enabled: boolean; credentialConfigured: boolean; targetDigest: string } };
  assert.equal(first.connection.revision, 1);
  assert.equal(first.connection.enabled, false);
  assert.equal(first.connection.credentialConfigured, true);
  assert.equal((await send('POST', { revision: 0, target, credential: { kind: 'keep' }, enabled: true })).status, 409);
  const rotated = await (await send('PUT', { revision: 1, target: { ...target, workerName: 'rotated-worker' }, credential: { kind: 'replace', token: rotatedToken }, enabled: true })).json() as { connection: { revision: number; enabled: boolean; targetDigest: string } };
  assert.equal(rotated.connection.revision, 2);
  assert.equal(rotated.connection.enabled, true);
  assert.notEqual(rotated.connection.targetDigest, first.connection.targetDigest);
  const removed = await (await send('POST', { revision: 2, target, credential: { kind: 'remove' } })).json() as { connection: { revision: number; enabled: boolean; credentialConfigured: boolean } };
  assert.equal(removed.connection.revision, 3);
  assert.equal(removed.connection.credentialConfigured, false);
  assert.equal(removed.connection.enabled, false);
  // Enabling without a stored credential is refused, and nothing was written.
  const enableWithoutCredential = await send('POST', { revision: 3, target, credential: { kind: 'keep' }, enabled: true });
  assert.equal(enableWithoutCredential.status, 422);
  assert.match((await enableWithoutCredential.json() as { error: string }).error, /credential is required/);
  assert.equal((await instance.call(path)).status, 200);
  // A malformed target and an unrecognised credential action are invalid requests, not storage faults.
  assert.equal((await send('POST', { revision: 3, target: { accountId: 'not-an-account', workerName }, credential: { kind: 'keep' } })).status, 422);
  assert.equal((await send('POST', { revision: 3, target, credential: { kind: 'discard' } })).status, 422);
  assert.equal((await send('POST', { revision: 3, target, credential: { kind: 'replace', token: 'short' } })).status, 422);
  assert.equal(JSON.parse(await (await instance.call(path)).text()).connection.revision, 3);
  for (const body of bodies) secretFree(body);
});

test('a configured connection survives a restart and its credential is reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-cf-restart-'));
  const open: App[] = [];
  // Each start is a separate process-like instance: its own local session token, the same data root.
  const boot = async () => {
    const security = localConfig('http://127.0.0.1:0');
    const app = await createApp({ dataRoot: root, browseRoots: [], security, cloudflareConnection: { enabled: true } });
    open.push(app);
    await listen(app, security);
    const auth = { 'x-dashboard-token': security.token }, writes = { ...auth, origin: security.origin, 'content-type': 'application/json' };
    const call: Call = (path, method = 'GET', body, headers = method === 'GET' ? auth : writes) =>
      fetch(security.origin + '/api' + path, method === 'GET' ? { headers } : { method, headers, body: JSON.stringify(body) });
    const stop = async () => { open.splice(open.indexOf(app), 1); await app.close(); };
    return { call, stop };
  };
  try {
    const first = await boot();
    const projectId = await registerProject(first.call), path = connectionPath(projectId);
    assert.equal((await first.call(path, 'POST', { revision: 0, target, credential: { kind: 'replace', token: ownerToken } })).status, 200);
    await first.stop();
    // A second instance reads the same durable record. Enabling with `keep` can only succeed if the
    // credential itself was persisted, which is the point of configuring it once.
    const second = await boot();
    const stored = await (await second.call(path)).json() as { connection: { revision: number; enabled: boolean; credentialConfigured: boolean } };
    assert.equal(stored.connection.revision, 1);
    assert.equal(stored.connection.credentialConfigured, true);
    assert.equal(stored.connection.enabled, false);
    assert.equal((await second.call(path, 'POST', { revision: 1, target, credential: { kind: 'keep' }, enabled: true })).status, 200);
    await second.stop();
    const third = await boot();
    const reopened = await (await third.call(path)).json() as { connection: { revision: number; enabled: boolean; credentialConfigured: boolean } };
    assert.equal(reopened.connection.revision, 2);
    assert.equal(reopened.connection.enabled, true);
    assert.equal(reopened.connection.credentialConfigured, true);
    await third.stop();
  } finally {
    // A failed assertion must not leave a listener or a database handle behind.
    for (const app of open) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a hosted write needs the session CSRF token, and Host and origin are enforced', async t => {
  const { publicKey, privateKey } = await generateKeyPair('RS256'), jwk = await exportJWK(publicKey);
  jwk.kid = 'test';
  const keys = createLocalJWKSet({ keys: [jwk] });
  const security = hostedConfig({ DASHBOARD_ORIGIN: 'https://dashboard.example.com', CF_ACCESS_TEAM: 'https://test.cloudflareaccess.com', CF_ACCESS_AUD: 'dashboard', DASHBOARD_OWNER: 'john@example.com' });
  security.verify = async token => (await jwtVerify(token, keys, { issuer: security.team, audience: security.audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'] })).payload;
  const root = await mkdtemp(join(tmpdir(), 'pilot-cf-hosted-'));
  const app = await createApp({ dataRoot: root, browseRoots: [], security, cloudflareConnection: { enabled: true } });
  await new Promise<void>(ok => app.server.listen(0, '127.0.0.1', ok));
  const origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  const sign = (email = 'john@example.com') => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(security.team!).setAudience(security.audience!).setSubject('owner-123').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const host = { host: 'dashboard.example.com' };
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await rawFetch(origin + '/api/projects', { headers: host })).status, 401);
  assert.equal((await rawFetch(origin + '/api/projects', { headers: { ...host, 'cf-access-jwt-assertion': await sign('other@example.com') } })).status, 403);
  const auth = { ...host, 'cf-access-jwt-assertion': await sign() };
  // One session response supplies both halves of the pair: the CSRF value and the cookie it signs.
  const sessionResponse = await rawFetch(origin + '/api/session', { headers: auth });
  const session = await sessionResponse.json() as { csrf: string };
  const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0];
  const write = { ...auth, origin: security.origin, 'content-type': 'application/json', cookie };
  const created = await rawFetch(origin + '/api/projects', { method: 'POST', headers: { ...write, 'x-dashboard-csrf': session.csrf }, body: JSON.stringify({ name: 'Hosted fixture', managed: true, confirm: true }) });
  assert.equal(created.status, 201);
  const projectId = (await created.json() as { id: string }).id, path = origin + '/api' + connectionPath(projectId), body = JSON.stringify({ revision: 0, target, credential: { kind: 'replace', token: ownerToken } });
  const withoutCsrf = await rawFetch(path, { method: 'POST', headers: write, body });
  assert.equal(withoutCsrf.status, 403);
  assert.equal((await withoutCsrf.json() as { code: string }).code, 'SESSION_CSRF');
  assert.equal((await rawFetch(path, { method: 'POST', headers: { ...write, origin: 'https://evil.example', 'x-dashboard-csrf': session.csrf }, body })).status, 403);
  assert.equal((await rawFetch(path, { method: 'POST', headers: { ...write, host: 'evil.example', 'x-dashboard-csrf': session.csrf }, body })).status, 403);
  const accepted = await rawFetch(path, { method: 'POST', headers: { ...write, 'x-dashboard-csrf': session.csrf }, body });
  assert.equal(accepted.status, 200);
  secretFree(await accepted.text());
});

test('the connection configuration adds no agent scope or harness capability', async t => {
  const instance = await localInstance(t, { enabled: true, control: true });
  await registerProject(instance.call);
  const agents = await (await instance.call('/agents')).json() as { scopes: { scope: string; description: string; installed: boolean }[] };
  assert.deepEqual(agents.scopes.map(entry => entry.scope), [...AGENT_SCOPES], 'the agent scope vocabulary is unchanged');
  assert.equal(JSON.stringify(agents.scopes).toLowerCase().includes('cloudflare'), false);
  const harness = await (await instance.call('/settings/harness')).json() as { settings: { capabilities: Record<string, unknown> }; effective: { capabilities: Record<string, unknown> } };
  assert.deepEqual(Object.keys(harness.settings.capabilities).sort(), ['codingTools', 'fileEdit', 'shell']);
  assert.deepEqual(Object.keys(harness.effective.capabilities).sort(), ['codingTools', 'fileEdit', 'shell']);
  assert.equal(JSON.stringify(harness).toLowerCase().includes('cloudflare'), false);
});
