import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

/**
 * Remove only what this browser suite created: a random `attention-fixture-*.root` marker in the
 * ignored test output and the disposable `dashboard-browser-*` data root it names.
 *
 * Playwright can stop its web server with an uncatchable signal, so the server's own exit cleanup
 * is best effort. This teardown runs in the runner process after every test outcome. It refuses a
 * symlink, a marker that is not a private regular file, and any data path outside the system temp
 * folder or without the suite's own name prefix. An unclean runner kill can still leave both; they
 * hold no credentials, the next start retries the data removal, and an earlier marker of the same
 * pattern is removed.
 */
async function removeTree(path) {
  // The server may still be finishing a write when this runs. Retry a few times before deciding
  // that the directory is not removable in this teardown.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt === 4) return false;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  return false;
}
export default async function globalTeardown() {
  const directory = join(process.cwd(), 'test-results');
  const entries = await readdir(directory).catch(() => []);
  for (const name of entries) {
    if (!/^attention-fixture-[a-f0-9]{32}\.root$/.test(name)) continue;
    const marker = join(directory, name);
    const markerInfo = await lstat(marker).catch(() => null);
    if (markerInfo === null || markerInfo.isSymbolicLink() || !markerInfo.isFile()) continue;
    if ((markerInfo.mode & 0o077) !== 0) continue;
    const dataRoot = (await readFile(marker, 'utf8').catch(() => '')).trim();
    const resolved = resolve(dataRoot);
    const temporary = resolve(tmpdir());
    let removed = true;
    if (resolved.startsWith(temporary + sep) && /^dashboard-browser-[A-Za-z0-9]{6}$/.test(basename(resolved))) {
      const dataInfo = await lstat(resolved).catch(() => null);
      if (dataInfo !== null && dataInfo.isDirectory() && !dataInfo.isSymbolicLink()) removed = await removeTree(resolved);
    }
    // Keep the marker when the data root is still there, so the next start can retry and the
    // leftover is visible rather than silently forgotten.
    if (removed) await rm(marker, { force: true }).catch(() => {});
  }
}
