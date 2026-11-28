import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { ForkLifecycleFence } from '../../src/server/state/fork-lifecycle-fence';

test('a per-child lifecycle fence blocks dispatch and competing mutations across store reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-fork-lifecycle-'));
  const one = new ControlStore(root), two = new ControlStore(root);
  try {
    const a = new ForkLifecycleFence(one), b = new ForkLifecycleFence(two), held = a.acquire('project', 'child');
    assert.throws(() => b.acquire('project', 'child'), /operator review/);
    assert.throws(() => b.assertDispatchable('project', 'child'), /cannot dispatch/);
    assert.doesNotThrow(() => b.assertDispatchable('project', 'sibling'));
    assert.doesNotThrow(() => b.assertDispatchable('another-project', 'child'));
    one.close();
    const reopened = new ControlStore(root);
    try {
      const c = new ForkLifecycleFence(reopened);
      assert.throws(() => c.assertDispatchable('project', 'child'), /operator review/);
      assert.throws(() => c.release('project', 'child', { ...held, token: '00000000-0000-0000-0000-000000000000' }), /changed/);
      c.release('project', 'child', held);
      assert.doesNotThrow(() => b.assertDispatchable('project', 'child'));
      const next = b.acquire('project', 'child');
      assert.equal(next.revision, held.revision + 2);
      assert.throws(() => b.release('project', 'child', held), /changed/);
    } finally { reopened.close(); }
  } finally { one.close(); two.close(); await rm(root, { recursive: true, force: true }); }
});
