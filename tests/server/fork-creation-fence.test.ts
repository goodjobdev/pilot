import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { ForkCreationFence } from '../../src/server/state/fork-creation-fence';

test('a creation fence blocks other sessions, survives restart and only its holder releases it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-fork-fence-'));
  const one = new ControlStore(root), two = new ControlStore(root);
  try {
    const first = new ForkCreationFence(one), second = new ForkCreationFence(two);
    const held = first.acquire('project', 'parent');
    assert.doesNotThrow(() => second.assertDispatchable('project', 'parent'));
    assert.throws(() => second.assertDispatchable('project', 'child'), /requires operator review/);
    assert.doesNotThrow(() => second.assertDispatchable('another-project', 'child'));
    assert.throws(() => second.acquire('project', 'parent'), /requires operator review/);
    assert.throws(() => second.release('project', { ...held, token: '00000000-0000-0000-0000-000000000000' }), /changed/);
    one.close();
    const reopened = new ControlStore(root);
    try {
      const recovered = new ForkCreationFence(reopened);
      assert.equal(recovered.read('project')?.state, 'held');
      assert.throws(() => recovered.assertDispatchable('project', 'child'), /requires operator review/);
      recovered.release('project', held);
      assert.doesNotThrow(() => second.assertDispatchable('project', 'child'));
      const next = second.acquire('project', 'parent');
      assert.equal(next.revision, held.revision + 2);
      assert.throws(() => second.release('project', held), /changed/);
    } finally { reopened.close(); }
  } finally { one.close(); two.close(); await rm(root, { recursive: true, force: true }); }
});
