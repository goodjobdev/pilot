import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DocStore } from '../../src/server/docs-store';
import { HttpError } from '../../src/server/board-store';
import type { Project } from '../../src/shared/model';

const linuxOnly = { skip: process.platform !== 'linux' ? 'requires the production Linux procfs reader' : false };

test('default DocStore reader returns allowlisted bodies/assets and preserves missing/oversize/symlink failures', linuxOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-docstore-procfs-'));
  const project: Project = { id: randomUUID(), name: 'Disposable fixture', path: root, managed: false, repository: '', created: new Date().toISOString() };
  try {
    await mkdir(join(root, 'docs/assets'), { recursive: true });
    await writeFile(join(root, 'docs/readme.md'), '# Hi');
    await writeFile(join(root, 'docs/assets/mock.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const largeDocument = await open(join(root, 'docs/too-large.md'), 'w');
    await largeDocument.truncate(2 * 1024 * 1024 + 1);
    await largeDocument.close();
    const largeAsset = await open(join(root, 'docs/assets/large.png'), 'w');
    await largeAsset.truncate(8 * 1024 * 1024 + 1);
    await largeAsset.close();
    await mkdir(join(root, 'docs/folder.md'));
    await symlink(join(root, 'docs/readme.md'), join(root, 'docs/linked.md'));

    const store = new DocStore();
    assert.equal((await store.read(project, 'docs/readme.md')).text, '# Hi');
    const asset = await store.asset(project, 'docs/assets/mock.png');
    assert.equal(asset.type, 'image/png');
    assert.deepEqual(asset.bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const expectStatus = async (operation: Promise<unknown>, status: number) => {
      await assert.rejects(operation, error => error instanceof HttpError && error.status === status);
    };
    await expectStatus(store.read(project, 'docs/missing.md'), 404);
    await expectStatus(store.read(project, 'docs/folder.md'), 404);
    await expectStatus(store.read(project, 'docs/readme.md/child.md'), 404);
    await expectStatus(store.read(project, 'docs/too-large.md'), 413);
    await expectStatus(store.asset(project, 'docs/assets/large.png'), 413);
    await expectStatus(store.read(project, 'docs/linked.md'), 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
