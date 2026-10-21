import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { ApprovalStore } from '../../src/server/state/approval-store';
import { APPROVAL_MAX_LIFETIME_MS, ApprovalError } from '../../src/shared/approvals';

const T0 = '2026-01-01T00:00:00.000Z';
const PROJECT = 'project-a';
const sha = (letter: string, length = 40) => letter.repeat(length);
const pushTarget = { remote: 'git@github.com:owner/repo.git', branch: 'main', commitSha: sha('a') };
const request = (over: Record<string, unknown> = {}) => ({
  kind: 'push', scope: { projectId: PROJECT }, target: pushTarget, expiresAt: '2026-01-01T00:10:00.000Z', ...over
});
const consumeInput = (id: string, over: Record<string, unknown> = {}) => ({
  id, scope: { projectId: PROJECT }, kind: 'push', target: pushTarget, consumedBy: 'owner', ...over
});
/** A clock the test controls, so expiry is a fact rather than a race with the wall clock. */
function fixedClock(text = T0) {
  let now = Date.parse(text);
  return { clock: () => new Date(now), advance: (ms: number) => { now += ms; }, at: (text: string) => { now = Date.parse(text); } };
}
function refuses(code: string, pattern: RegExp) {
  return (error: unknown) => error instanceof ApprovalError && error.code === code && pattern.test(error.message);
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-approvals-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('creation fails closed on unknown fields, unknown kinds, missing target fields, a non-future expiry and too long a lifetime', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), time = fixedClock();
    const approvals = new ApprovalStore(store, { clock: time.clock });
    assert.throws(() => approvals.create({ ...request(), confirm: true }), refuses('INVALID', /approval request .* is invalid/));
    assert.throws(() => approvals.create({ ...request(), kind: 'transfer' }), refuses('INVALID', /Unknown approval kind; the closed set is commit, push, deploy, spend, provision, publish/));
    assert.throws(() => approvals.create(request({ target: { remote: pushTarget.remote, branch: 'main' } })), refuses('INVALID', /target for kind 'push' \(requires remote, branch, commitSha\) is invalid: commitSha/));
    assert.throws(() => approvals.create(request({ target: { ...pushTarget, depth: 1 } })), refuses('INVALID', /unrecognized key|unexpected/i));
    assert.throws(() => approvals.create(request({ target: { remote: 42, branch: 'main', commitSha: sha('a') } })), refuses('INVALID', /remote/));
    assert.throws(() => approvals.create(request({ scope: { operation: 'x', team: 'y' } })), refuses('INVALID', /scope is invalid/));
    assert.throws(() => approvals.create(request({ scope: {} })), refuses('INVALID', /name at least one of projectId, sessionId, operation/));
    assert.throws(() => approvals.create(request({ expiresAt: '2025-12-31T23:59:59.000Z' })), refuses('INVALID', /strictly in the future/));
    assert.throws(() => approvals.create(request({ expiresAt: T0 })), refuses('INVALID', /strictly in the future/));
    assert.throws(() => approvals.create(request({ expiresAt: 'not a timestamp' })), refuses('INVALID', /expiresAt is invalid/));
    assert.throws(() => approvals.create(request({ expiresAt: new Date(Date.parse(T0) + APPROVAL_MAX_LIFETIME_MS + 1).toISOString() })), refuses('INVALID', /exceeds the documented maximum of 3600000ms/));
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM operations').get() as { n: number }).n, 0, 'a refused request creates nothing');
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM outboxes').get() as { n: number }).n, 0);
    store.close();
  });
});

test('a created approval is pending, frozen, target-bound and scope-guarded', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), time = fixedClock();
    const approvals = new ApprovalStore(store, { clock: time.clock });
    const record = approvals.create(request());
    assert.equal(record.state, 'pending');
    assert.equal(record.kind, 'push');
    assert.equal(record.issuedAt, T0);
    assert.equal(record.expiresAt, '2026-01-01T00:10:00.000Z');
    assert.match(record.nonce, /^[a-f0-9]{64}$/);
    assert.deepEqual(record.scope, { projectId: PROJECT });
    assert.deepEqual(record.target, pushTarget);
    assert.equal(record.consumedAt, null); assert.equal(record.consumedBy, null); assert.equal(record.revokedAt, null);
    assert.ok(Object.isFrozen(record));
    assert.match(record.id, /^[a-f0-9-]{36}$/);

    assert.deepEqual(approvals.read({ projectId: PROJECT }, record.id), record);
    assert.deepEqual(approvals.read({ projectId: PROJECT }, record.id), record);
    // The query must name the approval's scope exactly: neither a wider nor a different one works.
    assert.throws(() => approvals.read({ projectId: PROJECT, operation: 'anything' }, record.id), refuses('SCOPE', /outside the requested scope/));
    assert.throws(() => approvals.read({ projectId: PROJECT, sessionId: 'session-x' }, record.id), refuses('SCOPE', /outside the requested scope/));
    assert.throws(() => approvals.read({ operation: 'anything' }, record.id), refuses('SCOPE', /outside the requested scope/));
    assert.throws(() => approvals.read({ projectId: 'project-b' }, record.id), refuses('SCOPE', /outside the requested scope/));
    assert.throws(() => approvals.read({ projectId: PROJECT }, '99999999-9999-4999-8999-999999999999'), refuses('NOT_FOUND', /No approval with id/));
    assert.throws(() => approvals.read({}, record.id), refuses('INVALID', /name at least one of/));
    assert.throws(() => approvals.read({ projectId: 'project b' }, record.id), refuses('INVALID', /projectId/));
    assert.deepEqual(approvals.listPending({ projectId: PROJECT }), [record]);
    assert.deepEqual(approvals.listPending({ projectId: 'project-b' }), []);
    assert.equal(approvals.listPending({ sessionId: 'session-x' }).length, 0);
    store.close();
  });
});

test('consumption requires an exact kind, scope and every target field', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), time = fixedClock();
    const approvals = new ApprovalStore(store, { clock: time.clock });
    const record = approvals.create(request());
    const snapshot = JSON.stringify([
      store.db.prepare('SELECT * FROM operations WHERE id=?').all(record.id),
      store.db.prepare('SELECT * FROM outboxes WHERE operation_id=?').all(record.id)
    ]);
    const pendingRows = () => JSON.stringify([
      store.db.prepare('SELECT * FROM operations WHERE id=?').all(record.id),
      store.db.prepare('SELECT * FROM outboxes WHERE operation_id=?').all(record.id)
    ]);
    assert.throws(() => approvals.consume(consumeInput(record.id, { kind: 'commit', target: { repository: 'r', branch: 'main', treeDigest: sha('b', 64) } })), refuses('KIND_MISMATCH', /authorises 'push', not 'commit'/));
    assert.throws(() => approvals.consume(consumeInput(record.id, { target: { ...pushTarget, commitSha: sha('b') } })), refuses('TARGET_MISMATCH', /differing fields: commitSha/));
    assert.throws(() => approvals.consume(consumeInput(record.id, { target: { remote: pushTarget.remote, branch: 'main', commitSha: sha('a'), force: true } })), refuses('INVALID', /unrecognized key|unexpected/i));
    assert.throws(() => approvals.consume(consumeInput(record.id, { target: { remote: pushTarget.remote, branch: 'main' } })), refuses('INVALID', /commitSha/));
    assert.throws(() => approvals.consume(consumeInput(record.id, { scope: { projectId: 'project-b' } })), refuses('SCOPE', /outside the requested scope/));
    assert.throws(() => approvals.consume(consumeInput(record.id, { consumedBy: 'not an id!' })), refuses('INVALID', /consumedBy/));
    assert.equal(approvals.read({ projectId: PROJECT }, record.id).state, 'pending', 'every refusal left the approval pending');
    // A refused consumption leaves both linked records byte-identical, read back from the store.
    assert.equal(pendingRows(), snapshot, 'no refused consumption wrote a byte');

    const consumed = approvals.consume(consumeInput(record.id));
    assert.deepEqual(Object.keys(consumed).sort(), ['approval', 'target'], 'consuming returns the record and the exact target, nothing else');
    assert.deepEqual(consumed.target, pushTarget);
    assert.equal(consumed.approval.state, 'consumed');
    assert.equal(consumed.approval.consumedBy, 'owner');
    assert.equal(consumed.approval.consumedAt, T0);
    assert.deepEqual(approvals.listPending({ projectId: PROJECT }), []);
    store.close();
  });
});

test('consumption is single use: a replay after a crash and reopen is refused', async () => {
  await fixture(async (root) => {
    let store = new ControlStore(root);
    const approvals = new ApprovalStore(store, { clock: fixedClock().clock });
    const record = approvals.create(request());
    approvals.consume(consumeInput(record.id));
    store.close();

    store = new ControlStore(root);
    const reopened = new ApprovalStore(store, { clock: fixedClock().clock });
    const persisted = reopened.read({ projectId: PROJECT }, record.id);
    assert.equal(persisted.state, 'consumed');
    assert.equal(persisted.consumedBy, 'owner');
    assert.throws(() => reopened.consume(consumeInput(record.id)), refuses('CONSUMED', /already consumed at 2026-01-01T00:00:00.000Z by owner; it is single use/));
    assert.throws(() => reopened.revoke({ id: record.id, scope: { projectId: PROJECT }, revokedBy: 'owner' }), refuses('CONSUMED', /a spent approval cannot be revoked/));
    assert.equal(reopened.read({ projectId: PROJECT }, record.id).state, 'consumed', 'the replay changed nothing');
    store.close();
  });
});

test('a crash between the check and the write leaves nothing consumed: the write is all or nothing', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), time = fixedClock();
    const approvals = new ApprovalStore(store, { clock: time.clock });
    const record = approvals.create(request());
    const before = JSON.stringify(store.db.prepare('SELECT * FROM operations WHERE id=?').all(record.id));
    // A storage fault inside the transaction stands in for a crash during the write.
    store.db.exec("CREATE TRIGGER refuse_consume BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");
    assert.throws(() => approvals.consume(consumeInput(record.id)), refuses('STORAGE', /refused the write for approval .*synthetic write failure/));
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM operations WHERE id=?').all(record.id)), before, 'the failed consume wrote no bytes');
    assert.equal(approvals.read({ projectId: PROJECT }, record.id).state, 'pending');
    store.db.exec('DROP TRIGGER refuse_consume;');
    assert.equal(approvals.consume(consumeInput(record.id)).approval.state, 'consumed', 'once the write can commit, the same approval is consumable exactly once');
    assert.throws(() => approvals.consume(consumeInput(record.id)), refuses('CONSUMED', /already consumed/));
    store.close();
  });
});

test('expiry and revocation are refused with precise reasons, and an expired record stays readable', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), time = fixedClock();
    const approvals = new ApprovalStore(store, { clock: time.clock });
    const short = approvals.create(request({ expiresAt: '2026-01-01T00:05:00.000Z' }));
    time.at('2026-01-01T00:05:00.000Z');
    assert.throws(() => approvals.consume(consumeInput(short.id)), refuses('EXPIRED', /expired at 2026-01-01T00:05:00.000Z; an expired approval cannot be consumed/));
    assert.deepEqual(approvals.listPending({ projectId: PROJECT }), [], 'an expired approval can never be consumed, so it is not listed');
    assert.equal(approvals.read({ projectId: PROJECT }, short.id).state, 'pending', 'and it is still readable by id');
    const revoked = approvals.revoke({ id: short.id, scope: { projectId: PROJECT }, revokedBy: 'owner', reason: 'superseded' });
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.revokedAt, '2026-01-01T00:05:00.000Z');
    assert.throws(() => approvals.consume(consumeInput(short.id)), refuses('REVOKED', /was revoked at 2026-01-01T00:05:00.000Z; it cannot be consumed/));
    assert.deepEqual(approvals.revoke({ id: short.id, scope: { projectId: PROJECT }, revokedBy: 'owner' }), revoked, 'revoking again returns the same record unchanged');

    const pending = approvals.create(request({ expiresAt: '2026-01-01T01:00:00.000Z' }));
    assert.deepEqual(approvals.listPending({ projectId: PROJECT }).map((entry) => entry.id), [pending.id]);
    assert.throws(() => approvals.revoke({ id: pending.id, scope: { projectId: 'project-b' }, revokedBy: 'owner' }), refuses('SCOPE', /outside the requested scope/));
    assert.throws(() => approvals.revoke({ id: pending.id, scope: { projectId: PROJECT }, revokedBy: 'owner', reason: '' }), refuses('INVALID', /reason/));
    assert.equal(approvals.revoke({ id: pending.id, scope: { projectId: PROJECT }, revokedBy: 'owner' }).state, 'revoked');
    assert.throws(() => approvals.consume(consumeInput(pending.id)), refuses('REVOKED', /was revoked at/));
    store.close();
  });
});

test('a scope with only a session or only an operation is created, read and listed through that dimension', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), time = fixedClock();
    const approvals = new ApprovalStore(store, { clock: time.clock });
    const session = approvals.create(request({ scope: { sessionId: 'session-a' } }));
    const operation = approvals.create(request({ scope: { operation: 'publish-run-7' } }));
    assert.deepEqual(approvals.read({ sessionId: 'session-a' }, session.id).id, session.id);
    assert.deepEqual(approvals.listPending({ sessionId: 'session-a' }).map((entry) => entry.id), [session.id]);
    assert.deepEqual(approvals.listPending({ operation: 'publish-run-7' }).map((entry) => entry.id), [operation.id]);
    assert.throws(() => approvals.read({ sessionId: 'session-b' }, session.id), refuses('SCOPE', /outside the requested scope/));
    assert.throws(() => approvals.consume(consumeInput(session.id)), refuses('SCOPE', /outside the requested scope/));
    assert.equal(approvals.consume(consumeInput(session.id, { scope: { sessionId: 'session-a' } })).approval.state, 'consumed');
    store.close();
  });
});

test('concurrent consumption of one approval is refused rather than double-spent', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), time = fixedClock();
    const approvals = new ApprovalStore(store, { clock: time.clock });
    const record = approvals.create(request());
    // Two independent handles over the same database, as two processes would be.
    const other = new ControlStore(root);
    const second = new ApprovalStore(other, { clock: time.clock });
    assert.equal(approvals.consume(consumeInput(record.id)).approval.state, 'consumed');
    assert.throws(() => second.consume(consumeInput(record.id)), refuses('CONSUMED', /already consumed/));
    other.close();
    store.close();
  });
});

test('a corrupt stored definition is refused instead of being interpreted', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), time = fixedClock();
    const approvals = new ApprovalStore(store, { clock: time.clock });
    const record = approvals.create(request());
    // Corruption written behind the store's back, as a damaged file would appear.
    store.db.prepare("UPDATE operations SET input_json=? WHERE id=?").run(JSON.stringify({ version: 1, kind: 'push' }), record.id);
    assert.throws(() => approvals.read({ projectId: PROJECT }, record.id), refuses('STORAGE', /Stored approval definition is corrupt/));
    assert.throws(() => approvals.listPending({ projectId: PROJECT }), refuses('STORAGE', /Stored approval definition is corrupt/));
    assert.throws(() => approvals.consume(consumeInput(record.id)), refuses('STORAGE', /Stored approval definition is corrupt/));
    store.close();
  });
});

test('the approval record and its outbox are linked durably and survive a reopen byte-identically', async () => {
  await fixture(async (root) => {
    let store = new ControlStore(root);
    const approvals = new ApprovalStore(store, { clock: fixedClock().clock });
    const record = approvals.create(request());
    const bytes = await readFile(join(root, 'control.sqlite'));
    const operations = JSON.stringify(store.db.prepare('SELECT * FROM operations WHERE id=?').all(record.id));
    const outboxes = JSON.stringify(store.db.prepare('SELECT * FROM outboxes WHERE operation_id=?').all(record.id));
    assert.equal(JSON.parse(outboxes).length, 1, 'one approval has exactly one lifecycle outbox row');
    store.close();

    store = new ControlStore(root);
    const reopened = new ApprovalStore(store, { clock: fixedClock().clock });
    assert.deepEqual(reopened.read({ projectId: PROJECT }, record.id), record, 'the record survives a reopen unchanged');
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM operations WHERE id=?').all(record.id)), operations);
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM outboxes WHERE operation_id=?').all(record.id)), outboxes);
    assert.ok(bytes.length > 0);
    store.close();
  });
});
