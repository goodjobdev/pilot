import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoundedFileBuffer, readLinuxProcfsRegularFileBeneath, validateLinuxReadPath } from '../../src/server/linux-procfs-read';

const linuxOnly = { skip: process.platform !== 'linux' ? 'requires an actual Linux kernel and procfs' : false };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-procfs-read-'));
  return { root, cleanup: () => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })) };
}

async function openDescriptorCount(): Promise<number> {
  return (await import('node:fs/promises')).readdir('/proc/self/fd').then(entries => entries.length);
}

test('bounded buffer reader handles controlled short reads and rejects early EOF or growth', async () => {
  const source = Buffer.from('controlled short reads');
  let calls = 0;
  const result = await readBoundedFileBuffer(BigInt(source.length), source.length, async (target, offset, length, position) => {
    calls++;
    const count = Math.min(2, length, source.length - position);
    source.copy(target, offset, position, position + count);
    return count;
  });
  assert.ok(calls > 2);
  assert.deepEqual(result, source);

  await assert.rejects(readBoundedFileBuffer(4n, 4, async () => 0), /shorter|changed/i);
  await assert.rejects(readBoundedFileBuffer(0n, 0, async () => -1), /Invalid read result/);
  await assert.rejects(readBoundedFileBuffer(0n, 0, async (_target, _offset, length) => length), /grew|changed/i);
});

test('Linux procfs read rejects unavailable platforms explicitly', async () => {
  if (process.platform === 'linux') return;
  await assert.rejects(readLinuxProcfsRegularFileBeneath('/tmp', 'file', 10), /unavailable/);
});

test('path limits reject excessive depth and size before platform access', async () => {
  await assert.rejects(readLinuxProcfsRegularFileBeneath('/tmp', Array(128).fill('x').join('/'), 10), /traversal limit/);
  await assert.rejects(readLinuxProcfsRegularFileBeneath('/tmp', 'x'.repeat(4096), 10), /traversal limit/);
  validateLinuxReadPath('/', 'x'.repeat(4094)); // encoded absolute traversal path is exactly 4096 bytes
  assert.throws(() => validateLinuxReadPath('/', 'x'.repeat(4095)), /traversal limit/);
  validateLinuxReadPath('/', 'é'.repeat(2047)); // UTF-8: 1 + 1 + 4094 bytes = 4096
  assert.throws(() => validateLinuxReadPath('/', 'é'.repeat(2048)), /traversal limit/);
});

test('Linux traversal accepts the component limit and refuses one above it', linuxOnly, async () => {
  const { root, cleanup } = await fixture();
  try {
    const count = 128 - root.split('/').filter(Boolean).length;
    const parts = [...Array(count - 1).fill('d'), 'file'];
    const target = join(root, ...parts);
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(target, 'ok');
    assert.equal((await readLinuxProcfsRegularFileBeneath(root, parts.join('/'), 10)).toString(), 'ok');
    await assert.rejects(readLinuxProcfsRegularFileBeneath(root, ['d', ...parts].join('/'), 10), /traversal limit/);
  } finally { await cleanup(); }
});

test('Linux procfs traversal reads bounded regular files and rejects unsafe paths', linuxOnly, async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(join(root, 'file.txt'), 'known bytes');
    assert.equal((await readLinuxProcfsRegularFileBeneath(root, 'file.txt', 11)).toString(), 'known bytes');
    await assert.rejects(readLinuxProcfsRegularFileBeneath(root, 'file.txt', 10), /limit/);
    for (const path of ['', '/etc/passwd', '../outside', 'a//b', 'a/./b', 'a/../b', 'a\\b']) {
      await assert.rejects(readLinuxProcfsRegularFileBeneath(root, path, 100), /Unsafe relative path/);
    }
    await assert.rejects(readLinuxProcfsRegularFileBeneath(root, 'file.txt', -1), /maxBytes/);
  } finally {
    await cleanup();
  }
});

test('Linux procfs traversal rejects symlinked root ancestry, parents, and leaf', linuxOnly, async () => {
  const { root, cleanup } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'pilot-procfs-out-'));
  try {
    await mkdir(join(root, 'inside'));
    await writeFile(join(root, 'inside', 'safe'), 'safe');
    await mkdir(join(outside, 'nested'));
    await writeFile(join(outside, 'secret'), 'outside-secret');
    await symlink(outside, join(root, 'linked-dir'));
    await symlink(join(outside, 'secret'), join(root, 'linked-file'));
    await assert.rejects(readLinuxProcfsRegularFileBeneath(join(root, 'linked-dir'), 'secret', 100));
    await assert.rejects(readLinuxProcfsRegularFileBeneath(join(root, 'linked-dir', 'nested'), 'secret', 100));
    await assert.rejects(readLinuxProcfsRegularFileBeneath(root, 'linked-dir/secret', 100));
    await assert.rejects(readLinuxProcfsRegularFileBeneath(root, 'linked-file', 100));
    assert.equal((await readLinuxProcfsRegularFileBeneath(root, 'inside/safe', 100)).toString(), 'safe');
  } finally {
    await cleanup();
    await (await import('node:fs/promises')).rm(outside, { recursive: true, force: true });
  }
});

test('Linux procfs traversal pins a FIFO with O_PATH and refuses it before I/O', linuxOnly, async () => {
  const { root, cleanup } = await fixture();
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [join(root, 'pipe')]);
    await assert.rejects(readLinuxProcfsRegularFileBeneath(root, 'pipe', 100), /regular file/);
  } finally {
    await cleanup();
  }
});

test('Linux procfs traversal remains anchored across parent symlink swaps', linuxOnly, async () => {
  const { root, cleanup } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'pilot-procfs-race-out-'));
  const parent = join(root, 'parent');
  const parked = join(root, 'parked');
  let stop = false;
  let swaps = 0;
  let successfulReads = 0;
  let churn: Promise<void> | undefined;
  try {
    await mkdir(parent);
    await writeFile(join(parent, 'file'), 'inside');
    await writeFile(join(outside, 'file'), 'outside-secret');
    churn = (async () => {
      while (!stop) {
        try {
          await rename(parent, parked);
          await symlink(outside, parent);
          await unlink(parent);
          await rename(parked, parent);
          swaps++;
        } catch {
          try { await lstat(parked); await rename(parked, parent); } catch { /* retry */ }
        }
      }
    })();
    for (let i = 0; i < 1000 && successfulReads < 5; i++) {
      let result: Buffer;
      try {
        result = await readLinuxProcfsRegularFileBeneath(root, 'parent/file', 100);
      } catch { /* a concurrent rename may make the requested entry temporarily absent */ continue; }
      assert.equal(result.toString(), 'inside');
      successfulReads++;
    }
    stop = true;
    await churn;
    assert.ok(swaps > 0, 'the race fixture must perform at least one swap');
    assert.ok(successfulReads > 0, 'the race fixture must complete at least one read');
  } finally {
    stop = true;
    await churn;
    await cleanup();
    await (await import('node:fs/promises')).rm(outside, { recursive: true, force: true });
  }
});

test('Linux procfs traversal closes descriptors on success and refusal', linuxOnly, async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(join(root, 'file'), 'small');
    const before = await openDescriptorCount();
    for (let i = 0; i < 10; i++) {
      await readLinuxProcfsRegularFileBeneath(root, 'file', 20);
      await assert.rejects(readLinuxProcfsRegularFileBeneath(root, 'missing', 20));
    }
    const after = await openDescriptorCount();
    assert.ok(after <= before + 1, `descriptor count grew from ${before} to ${after}`);
  } finally {
    await cleanup();
  }
});
