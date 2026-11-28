import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { SessionLifecycleStore, adoptRunningSessions, SESSION_LIFECYCLE_UNCERTAINTY_ACK_KIND } from '../../src/server/state/session-lifecycle';
import { SessionLifecycleError } from '../../src/shared/session-lifecycle';

const PROJECT = 'project-a', SESSION = 'session-a';
const NOW = () => new Date('2026-01-01T00:00:00.000Z');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-uncertain-ack-'));
  const control = new ControlStore(root);
  const lifecycle = new SessionLifecycleStore(control, { clock: NOW });
  lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'original-submission' });
  adoptRunningSessions(lifecycle, NOW());
  return { root, control, lifecycle, async close() { control.close(); await rm(root, { recursive: true, force: true }); } };
}

function errorCode(error: unknown, code: string) {
  assert.ok(error instanceof SessionLifecycleError);
  assert.equal(error.code, code);
  return true;
}

test('uncertain acknowledgement requires owner and verified terminal submission; preserves history and identity', async () => {
  const f = await fixture();
  try {
    const before = f.lifecycle.read(PROJECT, SESSION);
    const history = f.lifecycle.attention(PROJECT);
    await assert.rejects(f.lifecycle.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: before.revision, actor: 'agent' }, async () => true), (e) => errorCode(e, 'INVALID'));
    await assert.rejects(f.lifecycle.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: before.revision - 1, actor: 'owner' }, async () => true), (e) => errorCode(e, 'CONFLICT'));
    await assert.rejects(f.lifecycle.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: before.revision, actor: 'owner' }), (e) => errorCode(e, 'NEEDS_ATTENTION'));
    await assert.rejects(f.lifecycle.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: before.revision, actor: 'owner' }, async () => false), (e) => errorCode(e, 'NEEDS_ATTENTION'));
    await assert.rejects(f.lifecycle.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: before.revision, actor: 'owner' }, async () => { throw new Error('verification unavailable'); }), (e) => errorCode(e, 'NEEDS_ATTENTION'));
    assert.deepEqual(f.lifecycle.read(PROJECT, SESSION), before, 'refusals write nothing');
    assert.throws(() => f.lifecycle.markRunning({ projectId: PROJECT, sessionId: SESSION, requestId: 'must-not-overwrite' }), (e) => errorCode(e, 'NEEDS_ATTENTION'));
    assert.deepEqual(f.lifecycle.read(PROJECT, SESSION), before, 'markRunning cannot overwrite uncertainty');
    let calls = 0;
    const ack = await f.lifecycle.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: before.revision, actor: 'owner' }, async ({ record }) => {
      calls++; assert.equal(record.requestId, 'original-submission'); assert.equal(record.state, 'interrupted'); return true;
    });
    assert.equal(calls, 1);
    assert.equal(ack.state, 'idle'); assert.equal(ack.uncertain, false);
    assert.equal(ack.revision, before.revision + 1);
    assert.equal(ack.requestId, 'original-submission');
    assert.equal(ack.attempt, before.attempt);
    assert.equal(ack.reason, null);
    const ackOperation = f.control.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid DESC LIMIT 1').get(PROJECT, SESSION, 'session.lifecycle') as { id: string };
    assert.equal((f.control.getOperation(ackOperation.id, { projectId: PROJECT, sessionId: SESSION }).input as { reason: string | null }).reason, null);
    const ackOutboxRow = f.control.db.prepare('SELECT id FROM outboxes WHERE operation_id=?').get(ackOperation.id) as { id: string };
    const ackOutbox = f.control.getOutbox(ackOutboxRow.id, { projectId: PROJECT, sessionId: SESSION });
    assert.deepEqual(ackOutbox.payload, { version: 1, sessionId: SESSION, revision: ack.revision, acknowledgement: { kind: SESSION_LIFECYCLE_UNCERTAINTY_ACK_KIND, actor: 'owner', fromRevision: before.revision, requestId: 'original-submission' } }, 'owner audit metadata shares the lifecycle admission');
    assert.equal(f.lifecycle.read(PROJECT, SESSION).state, 'idle');
    assert.deepEqual(f.lifecycle.read(PROJECT, SESSION), ack);
    const priorRow = f.control.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND idempotency_key=?').get(PROJECT, SESSION, 'lifecycle.r2') as { id: string };
    const priorRecord = f.control.getOperation(priorRow.id, { projectId: PROJECT, sessionId: SESSION }).input as { state: string };
    assert.equal(priorRecord.state, 'interrupted', 'the prior interrupted history remains retained');
    assert.deepEqual(history[0].revision, before.revision);
    assert.equal((f.control.db.prepare('SELECT count(*) AS n FROM operations WHERE project_id=? AND session_id=? AND kind=?').get(PROJECT, SESSION, 'session.lifecycle') as { n: number }).n, 3);
    assert.deepEqual(await f.lifecycle.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: ack.revision, actor: 'owner' }, async () => { throw new Error('idempotent marker must not verify'); }), ack);
    f.control.close();
    const reopened = new ControlStore(f.root);
    try {
      const recovered = new SessionLifecycleStore(reopened, { clock: NOW });
      assert.deepEqual(recovered.read(PROJECT, SESSION), ack, 'the acknowledged state and audit marker survive reopen');
      assert.deepEqual(await recovered.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: ack.revision, actor: 'owner' }, async () => { throw new Error('persisted ack must not verify'); }), ack);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('uncertain acknowledgement rejects a corrupt persisted owner marker', async () => {
  const f = await fixture();
  try {
    const before = f.lifecycle.read(PROJECT, SESSION);
    const ack = await f.lifecycle.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: before.revision, actor: 'owner' }, async () => true);
    const row = f.control.db.prepare('SELECT id,operation_id FROM outboxes ORDER BY rowid DESC LIMIT 1').get() as { id: string; operation_id: string };
    f.control.db.prepare('UPDATE outboxes SET payload_json=? WHERE id=?').run(JSON.stringify({ version: 1, sessionId: SESSION, revision: ack.revision, acknowledgement: { kind: SESSION_LIFECYCLE_UNCERTAINTY_ACK_KIND, actor: 'agent', fromRevision: before.revision, requestId: 'original-submission' } }), row.id);
    assert.throws(() => f.lifecycle.read(PROJECT, SESSION), (error: unknown) => error instanceof SessionLifecycleError && error.code === 'STORAGE');
  } finally { await f.close(); }
});

test('uncertain acknowledgement verifies before CAS and refuses a concurrent winner without overwriting it', async () => {
  const f = await fixture();
  try {
    const before = f.lifecycle.read(PROJECT, SESSION);
    await assert.rejects(f.lifecycle.acknowledgeUncertainty({ projectId: PROJECT, sessionId: SESSION, revision: before.revision, actor: 'owner' }, async () => {
      f.lifecycle.write({ ...before, revision: before.revision + 1, state: 'idle', reason: null, uncertain: false, activityAt: NOW().toISOString(), updatedAt: NOW().toISOString() });
      return true;
    }), (e) => errorCode(e, 'CONFLICT'));
    assert.equal(f.lifecycle.read(PROJECT, SESSION).revision, before.revision + 1);
  } finally { await f.close(); }
});
