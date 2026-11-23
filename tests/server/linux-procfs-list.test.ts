import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, opendir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DocStore } from '../../src/server/docs-store';
import { HttpError } from '../../src/server/board-store';
import { LinuxProcfsListError, listLinuxProcfsRegularFilesBeneath } from '../../src/server/linux-procfs-list';
import type { LinuxProcfsListEntry, LinuxProcfsListOptions } from '../../src/server/linux-procfs-list';
import type { Project } from '../../src/shared/model';

const linuxOnly = { skip: process.platform !== 'linux' ? 'requires the production Linux procfs listing backend' : false };

async function fixture(run: (root: string, project: Project) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-docstore-list-'));
  const project: Project = { id: randomUUID(), name: 'Disposable fixture', path: root, managed: false, repository: '', created: new Date().toISOString() };
  try { await run(root, project); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function fdCount(): Promise<number> {
  const directory = await opendir('/proc/self/fd');
  let count = 0;
  try {
    while (await directory.read() !== null) count++;
  } finally { await directory.close(); }
  return count;
}

test('default DocStore.list preserves filtering and sorted output; cap does not assume enumeration order', linuxOnly, async () => {
  await fixture(async (root, project) => {
    await writeFile(join(root, 'README.md'), 'readme');
    await mkdir(join(root, 'docs/dashboard'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'z.md'), 'z');
    await writeFile(join(root, 'docs/b.md'), 'b');
    await writeFile(join(root, 'docs/a.md'), 'a');
    await writeFile(join(root, 'docs/dashboard/board.md'), 'managed');
    await writeFile(join(root, 'node_modules/dependency.md'), 'excluded');
    await writeFile(join(root, 'notes.txt'), 'excluded');

    const all = await new DocStore().list(project);
    assert.deepEqual(all.map(entry => entry.path), ['README.md', 'docs/a.md', 'docs/b.md', 'z.md']);
    assert.ok(all.every(entry => Number.isInteger(entry.bytes) && entry.modified.length > 0));
    const capped = await new DocStore({ listLimit: 2 }).list(project);
    assert.equal(capped.length, 2);
    assert.deepEqual(capped.map(entry => entry.path), [...capped.map(entry => entry.path)].sort());
    assert.ok(capped.every(entry => all.some(item => item.path === entry.path)));
  });
});

test('descriptor-pinned listing does not follow a swapped parent or symlink leaf', linuxOnly, async () => {
  await fixture(async (root) => {
    const parent = join(root, 'docs');
    const outside = join(root, 'outside');
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(join(parent, 'safe.md'), 'safe');
    await writeFile(join(outside, 'secret.md'), 'secret');
    await symlink(join(outside, 'secret.md'), join(parent, 'linked.md'));
    let swapped = false;
    const entries = await listLinuxProcfsRegularFilesBeneath(root, 5000, path => path.startsWith('docs/') && (path.endsWith('.md') || path.endsWith('/placeholder.md')), {
      onDirectoryPinned: async relative => {
        if (relative !== 'docs' || swapped) return;
        swapped = true;
        await rename(parent, join(root, 'docs-original'));
        await symlink(outside, parent);
      }
    });
    assert.equal(swapped, true);
    assert.deepEqual(entries.map(entry => entry.path), ['docs/safe.md']);
  });
});

test('default DocStore.list maps backend unavailability to 503 without pathname fallback', linuxOnly, async () => {
  await fixture(async (root, project) => {
    await writeFile(join(root, 'visible.md'), 'visible');
    class UnavailableStore extends DocStore {
      protected override async listBeneath(): Promise<LinuxProcfsListEntry[]> {
        throw new LinuxProcfsListError('BACKEND_UNAVAILABLE');
      }
    }
    await assert.rejects(new UnavailableStore().list(project), error =>
      error instanceof HttpError && error.status === 503 && error.code === 'DOC_LIST_UNAVAILABLE'
    );
  });
});

test('DocStore.list maps real traversal-budget exhaustion to 503', linuxOnly, async () => {
  await fixture(async (root, project) => {
    await writeFile(join(root, 'visible.md'), 'visible');
    class LowBudgetStore extends DocStore {
      protected override listBeneath(rootPath: string, limit: number, include: (path: string) => boolean): Promise<LinuxProcfsListEntry[]> {
        return listLinuxProcfsRegularFilesBeneath(rootPath, limit, include, { workLimits: { maxVisitedEntries: 0 } });
      }
    }
    await assert.rejects(new LowBudgetStore().list(project), error =>
      error instanceof HttpError && error.status === 503 && error.code === 'DOC_LIST_LIMIT'
    );
  });
});

test('deep traversal fails closed at its depth budget', linuxOnly, async () => {
  await fixture(async root => {
    let path = root;
    for (let depth = 0; depth < 66; depth++) {
      path = join(path, 'd');
      await mkdir(path);
    }
    await writeFile(join(path, 'page.md'), 'deep');
    await assert.rejects(
      listLinuxProcfsRegularFilesBeneath(root, 5000, candidate => candidate.endsWith('.md') || candidate.endsWith('/placeholder.md')),
      error => error instanceof LinuxProcfsListError && error.code === 'WORK_LIMIT'
    );
  });
});

test('entry, directory, and relative-path work budgets fail closed without leaking descriptors', linuxOnly, async () => {
  await fixture(async root => {
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/page.md'), 'page');
    await writeFile(join(root, 'long-name.md'), 'x');
    const before = await fdCount();
    const expectWorkLimit = (workLimits: LinuxProcfsListOptions['workLimits']) =>
      assert.rejects(listLinuxProcfsRegularFilesBeneath(root, 5000, () => true, { workLimits }),
        error => error instanceof LinuxProcfsListError && error.code === 'WORK_LIMIT');
    await expectWorkLimit({ maxVisitedEntries: 0 });
    await expectWorkLimit({ maxVisitedDirectories: 0 });
    await expectWorkLimit({ maxDepth: 0 });
    await expectWorkLimit({ maxRelativePathBytes: 2 });
    await assert.rejects(listLinuxProcfsRegularFilesBeneath(root, 5000, () => true, {
      workLimits: { maxVisitedEntries: 200_001 }
    }), /Invalid listing work limit/);
    assert.equal(await fdCount(), before);
  });
});

test('DocStore.list closes descriptors when the result cap returns early', linuxOnly, async () => {
  await fixture(async (root, project) => {
    for (let index = 0; index < 8; index++) await writeFile(join(root, `page-${index}.md`), 'page');
    const before = await fdCount();
    for (let index = 0; index < 20; index++) {
      assert.equal((await new DocStore({ listLimit: 1 }).list(project)).length, 1);
    }
    assert.equal(await fdCount(), before);
  });
});

test('descriptor-pinned listing closes descriptors after success and traversal errors', linuxOnly, async () => {
  await fixture(async (root) => {
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/page.md'), 'page');
    await writeFile(join(root, 'not-a-directory'), 'file');
    const before = await fdCount();
    for (let index = 0; index < 10; index++) {
      await listLinuxProcfsRegularFilesBeneath(root, 5000, () => true);
      await assert.rejects(listLinuxProcfsRegularFilesBeneath(join(root, 'not-a-directory', 'child'), 5000, () => true));
      await assert.rejects(listLinuxProcfsRegularFilesBeneath(root, 5000, () => true, {
        onDirectoryPinned: relative => { if (relative === 'docs') throw new Error('injected traversal failure'); }
      }), /injected traversal failure/);
    }
    assert.equal(await fdCount(), before);
  });
});
