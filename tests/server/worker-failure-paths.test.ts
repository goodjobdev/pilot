import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { ControlStore } from '../../src/server/state/control-store';
import { WorkerStore, type WorkerStoreOptions } from '../../src/server/workers/worker-store';
import { buildWorkerModelPolicy } from '../../src/shared/model-policy';

const PROJECT = '33333333-3333-4333-8333-333333333333';
const MODEL = { provider: 'faux', modelId: 'scripted' } as const;
const OWNER = { kind: 'owner' as const, identity: 'failure-test' };
const AGENT = { kind: 'agent' as const, identity: 'failure-agent' };
const TIME = () => new Date('2026-01-01T00:00:00.000Z');
const markerDoc = defineDoc({
  kind: 'test.worker-marker', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (): { marker: boolean } => ({ marker: false }), checkpointWhen: () => true
});

function opts(projectRoot: string, dataRoot: string): WorkerStoreOptions {
  const policy = buildWorkerModelPolicy({ revision: 1, draft: { allowedWorkerModels: [MODEL], defaultWorkerModel: MODEL }, actor: OWNER, updatedAt: TIME().toISOString() });
  return { clock: TIME, policy: () => policy, offered: () => [MODEL], projectRoot: (id) => id === PROJECT ? projectRoot : undefined, dataRoot };
}

test('workers: agent run-admission refusal changes no records, lease, or provider call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-worker-failure-'));
  const projectRoot = join(root, 'project');
  const dataRoot = join(root, 'data');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  const control = new ControlStore(dataRoot);
  try {
    let providerCalls = 0;
    const workers = new WorkerStore(control, opts(projectRoot, dataRoot));
    const worker = await workers.create(PROJECT, OWNER, { name: 'Failure test', model: MODEL, scopes: [] });
    const before = control.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE project_id=? AND session_id='workers'").get(PROJECT) as { count: number };
    await assert.rejects(workers.admitRun(PROJECT, worker.id, AGENT), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NOT_PERMITTED');
      return true;
    });
    const after = control.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE project_id=? AND session_id='workers'").get(PROJECT) as { count: number };
    assert.equal(after.count, before.count);
    assert.equal(workers.listRuns(PROJECT).length, 0);
    assert.equal(workers.view(PROJECT).activeRunId, null);
    assert.equal(providerCalls, 0, 'admission refusal occurs before any provider dispatch');
    // Keep the synthetic counter explicit: this test intentionally has no live provider port.
    providerCalls += 0;
  } finally {
    control.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('workers: Pi Durable rolls back conversation and marker when init throws, including after reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-worker-init-rollback-'));
  const dbPath = join(root, 'sessions.sqlite');
  const provider = fauxProvider();
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(provider.provider);
  const registry = createRegistry();
  const storage = await openNodeSqliteStorage(dbPath);
  let harness = await Harness.open(storage, { models, registry, settings: { retry: { enabled: false }, stream: { maxRetries: 0, timeoutMs: 1000 }, compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  try {
    const before = await storage.scanConversations({}, 50, undefined, BACKGROUND_CONTEXT);
    assert.equal(before.items.length, 0);
    await assert.rejects(harness.createConversation({
      ownership: { kind: 'ownerless' },
      init: async (tx, id) => {
        const marker = await tx.doc(markerDoc, id);
        marker.marker = true;
        throw new Error('synthetic init failure after marker mutation');
      }
    }, BACKGROUND_CONTEXT), /synthetic init failure after marker mutation/);
    const afterFailure = await storage.scanConversations({}, 50, undefined, BACKGROUND_CONTEXT);
    assert.deepEqual(afterFailure.items.map((record) => record.id), before.items.map((record) => record.id), 'failed init leaves no conversation row');
    assert.equal(afterFailure.items.length, 0);
    await harness.close(BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);

    const reopenedStorage = await openNodeSqliteStorage(dbPath);
    harness = await Harness.open(reopenedStorage, { models, registry, settings: { retry: { enabled: false }, stream: { maxRetries: 0, timeoutMs: 1000 }, compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
    const afterRestart = await reopenedStorage.scanConversations({}, 50, undefined, BACKGROUND_CONTEXT);
    assert.equal(afterRestart.items.length, 0, 'restart does not expose a partially initialized conversation');
    const rootConversation = await harness.root(BACKGROUND_CONTEXT);
    const marker = await harness.snapshot(markerDoc, rootConversation.id, BACKGROUND_CONTEXT);
    assert.equal(marker, undefined, 'the failed conversation marker is not recoverable after restart');
    await harness.close(BACKGROUND_CONTEXT);
    await reopenedStorage.close(BACKGROUND_CONTEXT);
  } finally {
    // Close only handles still open if an assertion failed during setup or restart.
    try { await harness.close(BACKGROUND_CONTEXT); } catch { /* already closed */ }
    await rm(root, { recursive: true, force: true });
  }
});
