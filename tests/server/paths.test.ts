import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { safePath } from '../../src/server/paths';

test('safePath tolerates concurrent real-parent creation and still refuses symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-safe-path-'));
  try {
    const paths = await Promise.all(Array.from({ length: 64 }, () => safePath(root, 'credentials/projects/key', true)));
    assert.ok(paths.every((path) => path === join(root, 'credentials/projects/key')));
    for (const directory of [join(root, 'credentials'), join(root, 'credentials/projects')]) {
      const stat = await lstat(directory);
      assert.ok(stat.isDirectory());
      assert.equal(stat.isSymbolicLink(), false);
    }

    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'linked'));
    await assert.rejects(safePath(root, 'linked/credentials/key', true), /Symlinks are not permitted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
