import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore, ControlStoreError } from '../../src/server/state/control-store';
import { WorkerModelPolicyStore } from '../../src/server/state/model-policy-store';
import { modelKey, type ModelChoice } from '../../src/shared/settings';
import { WorkerModelPolicyError } from '../../src/shared/model-policy';

/**
 * The durable worker model policy over a disposable root and the real control store.
 *
 * This suite makes no provider call, opens no harness and starts no worker. It proves the
 * record's revision CAS, owner-only write, catalog validation, preservation of an unavailable
 * saved entry, and that the reviewed three-table control schema is unchanged.
 */

const STRONG: ModelChoice = { provider: 'openai', modelId: 'gpt-strong' };
const CHEAP: ModelChoice = { provider: 'openai', modelId: 'gpt-cheap' };
const GONE: ModelChoice = { provider: 'oldprovider', modelId: 'retired-model' };
const OWNER = Object.freeze({ kind: 'owner' as const, identity: 'local' });

async function fixture(offered: readonly ModelChoice[] = [STRONG, CHEAP]) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-worker-policy-'));
  const store = new ControlStore(root);
  const policy = new WorkerModelPolicyStore(store, { models: () => offered });
  return {
    root,
    store,
    policy,
    draft: (allowed: readonly ModelChoice[], defaultModel: ModelChoice | null) => ({ allowedWorkerModels: allowed, defaultWorkerModel: defaultModel }),
    cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); }
  };
}

function refused(work: () => unknown, code: WorkerModelPolicyError['code']): string {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof WorkerModelPolicyError, 'the refusal is the policy own: ' + String(error));
    assert.equal(error.code, code, error.message);
    return error.message;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

test('a policy is absent until the owner creates revision 1, and the outbox is its audit evidence', async () => {
  const f = await fixture();
  try {
    assert.equal(f.policy.read(), null);
    const created = f.policy.update({ revision: 0, policy: f.draft([STRONG, CHEAP], CHEAP) }, OWNER);
    assert.equal(created.revision, 1);
    assert.equal(modelKey(created.defaultWorkerModel!), modelKey(CHEAP));
    assert.deepEqual(created.allowedWorkerModels.map(modelKey), [modelKey(CHEAP), modelKey(STRONG)]);
    assert.equal(created.updatedBy.kind, 'owner');
    assert.equal(f.policy.read()!.revision, 1);
    // One operation and one outbox row, both of this policy's own kind.
    const operation = f.store.db.prepare('SELECT kind FROM operations WHERE project_id=? AND session_id=?').get('settings', 'worker-policy') as { kind: string };
    assert.equal(operation.kind, 'settings.worker-model-policy');
    const outbox = f.store.db.prepare('SELECT kind FROM outboxes').get() as { kind: string };
    assert.equal(outbox.kind, 'settings.worker-model-policy');
    // Same content at the current revision is a no-op: no second row.
    const repeated = f.policy.update({ revision: 1, policy: f.draft([CHEAP, STRONG], CHEAP) }, OWNER);
    assert.equal(repeated.revision, 1);
    const count = f.store.db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number };
    assert.equal(count.count, 1);
  } finally {
    await f.cleanup();
  }
});

test('a stale revision is refused and writes nothing (sequential check)', async () => {
  const f = await fixture();
  try {
    const first = f.policy.update({ revision: 0, policy: f.draft([STRONG], STRONG) }, OWNER);
    const second = f.policy.update({ revision: first.revision, policy: f.draft([STRONG, CHEAP], CHEAP) }, OWNER);
    assert.equal(second.revision, 2);
    const message = refused(
      () => f.policy.update({ revision: 1, policy: f.draft([STRONG], null) }, OWNER),
      'CONFLICT'
    );
    assert.match(message, /revision 2, not 1/);
    assert.equal(f.policy.read()!.revision, 2);
    assert.equal(f.policy.read()!.allowedWorkerModels.length, 2);
    // A second writer that still holds revision 2 is refused after the first writes revision 3.
    // This is a sequential check. It does not claim a true concurrent interleave; the store's own
    // UNIQUE index is the CAS, and the next test exercises it over two connections.
    const winner = f.policy.update({ revision: 2, policy: f.draft([STRONG], STRONG) }, OWNER);
    assert.equal(winner.revision, 3);
    const loserMessage = refused(
      () => f.policy.update({ revision: 2, policy: f.draft([CHEAP], CHEAP) }, OWNER),
      'CONFLICT'
    );
    assert.match(loserMessage, /revision 3, not 2/);
    assert.deepEqual(f.policy.read()!.allowedWorkerModels.map(modelKey), [modelKey(STRONG)]);
  } finally {
    await f.cleanup();
  }
});

test('two control-store connections cannot admit the same policy key with different content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-worker-policy-cas-'));
  const first = new ControlStore(root);
  const second = new ControlStore(root);
  try {
    const scope = { projectId: 'settings', sessionId: 'worker-policy' };
    const admission = (claim: string) => ({
      scope,
      idempotencyKey: 'worker-model-policy.r1',
      kind: 'settings.worker-model-policy',
      input: { claim },
      outbox: { kind: 'settings.worker-model-policy', payload: { claim } }
    });
    first.admit(admission('first'));
    let refusal: unknown = null;
    try { second.admit(admission('second')); } catch (error) { refusal = error; }
    assert.ok(refusal instanceof ControlStoreError, 'the second admission is refused by the store');
    assert.equal(refusal.code, 'CONFLICT', refusal.message);
    const rows = first.db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number };
    assert.equal(rows.count, 1, 'the first admission is the only operation');
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('only an owner actor may change the policy', async () => {
  const f = await fixture();
  try {
    const message = refused(
      () => f.policy.update({ revision: 0, policy: f.draft([STRONG], STRONG) }, { kind: 'agent', identity: 'agent-1' }),
      'NOT_PERMITTED'
    );
    assert.match(message, /Only the owner/);
    assert.equal(f.policy.read(), null);
  } finally {
    await f.cleanup();
  }
});

test('a new unknown model is refused; a saved unavailable model is preserved and can be removed', async () => {
  const f = await fixture();
  try {
    f.policy.update({ revision: 0, policy: f.draft([STRONG], STRONG) }, OWNER);
    const unknown = refused(
      () => f.policy.update({ revision: 1, policy: f.draft([STRONG, GONE], null) }, OWNER),
      'MODEL_NOT_OFFERED'
    );
    assert.match(unknown, /oldprovider\/retired-model/);
    assert.equal(f.policy.read()!.revision, 1, 'the refused write changed nothing');
  } finally {
    await f.cleanup();
  }
  // Reopen with a catalog that no longer contains the saved model.
  const root = await mkdtemp(join(tmpdir(), 'pilot-worker-policy-gone-'));
  const store = new ControlStore(root);
  try {
    const before = new WorkerModelPolicyStore(store, { models: () => [STRONG, GONE] });
    before.update({ revision: 0, policy: { allowedWorkerModels: [STRONG, GONE], defaultWorkerModel: GONE } }, OWNER);
    const after = new WorkerModelPolicyStore(store, { models: () => [STRONG] });
    const read = after.read()!;
    assert.deepEqual(read.allowedWorkerModels.map(modelKey), [modelKey(GONE), modelKey(STRONG)]);
    // Keeping the unavailable entry is accepted, so the owner can inspect it. Changing the default
    // to a known model still keeps the unavailable entry, and writes a new revision.
    const kept = after.update({ revision: 1, policy: { allowedWorkerModels: [STRONG, GONE], defaultWorkerModel: STRONG } }, OWNER);
    assert.equal(kept.revision, 2);
    assert.deepEqual(kept.allowedWorkerModels.map(modelKey), [modelKey(GONE), modelKey(STRONG)]);
    // Removing it is accepted too.
    const removed = after.update({ revision: 2, policy: { allowedWorkerModels: [STRONG], defaultWorkerModel: STRONG } }, OWNER);
    assert.equal(removed.revision, 3);
    assert.deepEqual(removed.allowedWorkerModels.map(modelKey), [modelKey(STRONG)]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('removing the default from the allowed set is refused; clearing it explicitly is accepted', async () => {
  const f = await fixture();
  try {
    f.policy.update({ revision: 0, policy: f.draft([STRONG, CHEAP], CHEAP) }, OWNER);
    const message = refused(
      () => f.policy.update({ revision: 1, policy: f.draft([STRONG], CHEAP) }, OWNER),
      'DEFAULT_NOT_ALLOWED'
    );
    assert.match(message, /clear defaultWorkerModel explicitly/);
    assert.equal(f.policy.read()!.revision, 1, 'the refused write changed nothing');
    const cleared = f.policy.update({ revision: 1, policy: f.draft([STRONG], null) }, OWNER);
    assert.equal(cleared.defaultWorkerModel, null);
    assert.equal(cleared.revision, 2);
  } finally {
    await f.cleanup();
  }
});

test('the policy survives a close and reopen, and the control schema still has only three tables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-worker-policy-reopen-'));
  try {
    const firstStore = new ControlStore(root);
    const first = new WorkerModelPolicyStore(firstStore, { models: () => [STRONG, CHEAP] });
    first.update({ revision: 0, policy: { allowedWorkerModels: [STRONG, CHEAP], defaultWorkerModel: CHEAP } }, OWNER);
    firstStore.close();
    const secondStore = new ControlStore(root);
    try {
      const second = new WorkerModelPolicyStore(secondStore, { models: () => [STRONG, CHEAP] });
      const read = second.read()!;
      assert.equal(read.revision, 1);
      assert.equal(modelKey(read.defaultWorkerModel!), modelKey(CHEAP));
      const tables = (secondStore.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
      assert.deepEqual(tables, ['control_schema', 'operations', 'outboxes']);
    } finally {
      secondStore.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a tampered policy idempotency key or operation state is corruption', async () => {
  // Tampered key.
  const keyFixture = await fixture();
  try {
    keyFixture.policy.update({ revision: 0, policy: keyFixture.draft([STRONG], STRONG) }, OWNER);
    keyFixture.store.db.prepare("UPDATE operations SET idempotency_key='worker-model-policy.r999' WHERE project_id='settings' AND session_id='worker-policy'").run();
    const message = refused(() => keyFixture.policy.read(), 'CORRUPT');
    assert.match(message, /idempotency key/);
  } finally {
    await keyFixture.cleanup();
  }
  // Tampered operation state.
  const stateFixture = await fixture();
  try {
    stateFixture.policy.update({ revision: 0, policy: stateFixture.draft([STRONG], STRONG) }, OWNER);
    stateFixture.store.db.prepare("UPDATE operations SET state='succeeded' WHERE project_id='settings' AND session_id='worker-policy'").run();
    const message = refused(() => stateFixture.policy.read(), 'CORRUPT');
    assert.match(message, /not pending/);
  } finally {
    await stateFixture.cleanup();
  }
});
