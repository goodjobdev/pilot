import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dockerfile = new URL('../../deploy/pilot/Dockerfile', import.meta.url);
const smoke = new URL('../../deploy/pilot/pnpm-store-smoke.sh', import.meta.url);

test('Pilot provisions pnpm package-manager storage on the writable data volume', async () => {
  const source = await readFile(dockerfile, 'utf8');
  assert.match(source, /PNPM_HOME=\/data\/pnpm/);
  assert.match(source, /mkdir -p \/app \/data\/pnpm/);
  assert.match(source, /chown -R pilot:pilot \/app \/data/);
  assert.match(source, /chmod 0750 \/data\/pnpm/);
  assert.doesNotMatch(source, /ENV PATH="\/data\/pnpm/);
  assert.match(source, /USER 10001:10001/);
});

test('production-like pnpm smoke validates pinned version in a disposable project', async () => {
  const source = await readFile(smoke, 'utf8');
  assert.match(source, /--read-only/);
  assert.match(source, /--user 10001:10001/);
  assert.match(source, /--volume "\$volume:\/data"/);
  assert.match(source, /rm -rf \/data\/pnpm && touch \/data\/\.legacy-volume-marker && test ! -e \/data\/pnpm/);
  assert.match(source, /case ":\$PATH:" in \*:\/data\/pnpm:\*/);
  assert.match(source, /command -v pnpm/);
  assert.match(source, /"packageManager": "pnpm@12\.10\.1"/);
  assert.match(source, /pnpm check/);
  assert.match(source, /package-manager-store/);
});
