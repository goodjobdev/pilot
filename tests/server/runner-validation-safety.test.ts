import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLocalSelection, verifySocket, remainingTimeout, allocatedNames, cleanupContainers } from '../../scripts/runner-validation-safety';
const socket = '/tmp/synthetic-docker.sock', endpoint = 'unix://' + socket;
const name = 'pilot-runner-12345678-1234-1234-1234-123456789abc';
test('local selection refuses remote contexts, environment redirects and TLS overrides', () => {
  assert.equal(checkLocalSelection(socket, endpoint, {}, {}), endpoint);
  assert.equal(checkLocalSelection(socket, endpoint, { DOCKER_HOST: endpoint, DOCKER_CONFIG: '/synthetic/config' }, {}), endpoint);
  for (const selected of ['ssh://synthetic', 'tcp://192.0.2.1:2375', 'unix:///tmp/other.sock'])
    assert.throws(() => checkLocalSelection(socket, selected, {}, {}), /context/);
  assert.throws(() => checkLocalSelection(socket, endpoint, { DOCKER_HOST: 'ssh://synthetic' }, {}), /DOCKER_HOST/);
  for (const key of ['DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
    assert.throws(() => checkLocalSelection(socket, endpoint, { [key]: 'synthetic' }, {}), /security/);
  assert.throws(() => checkLocalSelection(socket, endpoint, {}, { docker: ['synthetic.pem'] }), /security/);
  assert.throws(() => checkLocalSelection('relative.sock', endpoint, {}, {}), /absolute/);
});
test('a filesystem file cannot impersonate a local runtime socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-socket-test-'));
  try { const file = join(root, 'file'); await writeFile(file, 'synthetic'); await assert.rejects(verifySocket(file), /Unix socket/); }
  finally { await rm(root, { recursive: true }); }
});
test('each CLI call respects the remaining phase budget', () => {
  assert.equal(remainingTimeout(10000, 1000), 2000);
  assert.equal(remainingTimeout(10000, 9999), 1);
  assert.throws(() => remainingTimeout(10000, 10000), /deadline/);
  assert.throws(() => remainingTimeout(10000, 10001), /deadline/);
});
test('resource ledger accepts only allocated runner container names', () => {
  assert.deepEqual(allocatedNames([name, name]), [name]);
  for (const value of [null, ['other-container'], ['--all'], [1]]) assert.throws(() => allocatedNames(value), /ledger/);
});
test('cleanup removes only allocated names and confirms absence', async () => {
  const calls: string[][] = [];
  const result = await cleanupContainers([name], async (...args) => { calls.push(args); return args[0] === 'ps' ? 'unrelated-container\n' : ''; });
  assert.deepEqual(calls, [['rm', '-f', name], ['ps', '-a', '--format', '{{.Names}}']]);
  assert.deepEqual(result, { absent: 1, removalRefusals: 0 });
});
test('cleanup reports removal refusals and refuses root deletion when containers remain or status fails', async () => {
  const absent = await cleanupContainers([name], async (...args) => { if (args[0] === 'rm') throw Error('already absent'); return ''; });
  assert.equal(absent.removalRefusals, 1);
  await assert.rejects(cleanupContainers([name], async (...args) => { if (args[0] === 'rm') throw Error('removal refused'); return name; }), /retained|remain/);
  await assert.rejects(cleanupContainers([name], async () => { throw Error('runtime unavailable'); }), /unavailable/);
});
