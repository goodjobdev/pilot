import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { ApprovalStore } from '../../src/server/state/approval-store';
import { ApprovalError } from '../../src/shared/approvals';
import { DeliveryLedger, DeliveryError, deliveryIdempotencyKey } from '../../src/server/state/delivery';
import { reconcileDeliveries } from '../../src/server/main';

const PROJECT = 'project-a', SESSION = 'session-a', QUESTION = '11111111-1111-4111-8111-111111111111';
const scope = { projectId: PROJECT, sessionId: SESSION };
const question = (over: Record<string, unknown> = {}) => ({ ...scope, questionId: QUESTION, text: 'Should I proceed?', askedAt: 1700000000000, ...over });
const answer = (over: Record<string, unknown> = {}) => ({ ...scope, questionId: QUESTION, text: 'Yes, proceed.', answeredAt: 1700000060000, ...over });
/** The raw stored rows, so a refusal can be shown to have changed no bytes. */
const rows = (store: ControlStore, sql: string, ...params: (string | number)[]) => JSON.stringify(store.db.prepare(sql).all(...params));

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-delivery-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function refuses(code: string, pattern: RegExp) {
  return (error: unknown) => error instanceof DeliveryError && error.code === code && pattern.test(error.message);
}

test('the idempotency key is derived from the question id and the delivery kind', () => {
  const key = deliveryIdempotencyKey('question', QUESTION);
  assert.equal(key, deliveryIdempotencyKey('question', QUESTION), 'the derivation is stable');
  assert.notEqual(key, deliveryIdempotencyKey('answer', QUESTION), 'the kinds do not share a key');
  assert.notEqual(key, deliveryIdempotencyKey('question', '11111111-1111-4111-8111-111111111112'));
  assert.match(key, /^question\.[a-f0-9]{48}$/);
});

test('a duplicate admission is unchanged, creates no second outbox row, and a conflicting duplicate is refused', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const first = ledger.admitQuestion(question());
    assert.equal(first.existing, false);
    assert.equal(first.operation.state, 'pending');
    assert.equal(first.outbox.state, 'pending');
    assert.equal(first.outbox.kind, 'question.notify');
    assert.deepEqual(first.outbox.payload, { version: 1, delivery: 'question', questionId: QUESTION, tag: 'question:' + QUESTION, requestId: null });

    const duplicate = ledger.admitQuestion(question());
    assert.equal(duplicate.existing, true);
    assert.equal(duplicate.operation.id, first.operation.id);
    assert.equal(duplicate.operation.revision, first.operation.revision, 'a duplicate admission writes nothing');
    assert.equal(duplicate.outbox.id, first.outbox.id);
    assert.equal(rows(store, 'SELECT count(*) AS n FROM outboxes WHERE operation_id=?', first.operation.id), JSON.stringify([{ n: 1 }]));

    const before = {
      operation: rows(store, 'SELECT * FROM operations WHERE id=?', first.operation.id),
      outbox: rows(store, 'SELECT * FROM outboxes WHERE id=?', first.outbox.id)
    };
    // A different body under the same key is a conflict, never a silent overwrite.
    assert.throws(() => ledger.admitQuestion(question({ text: 'Something else entirely?' })), refuses('CONFLICT', /different content/));
    assert.throws(() => ledger.admitQuestion(question({ askedAt: 1700000000001 })), refuses('CONFLICT', /different content/));
    assert.equal(rows(store, 'SELECT * FROM operations WHERE id=?', first.operation.id), before.operation, 'the refused admission changed no operation bytes');
    assert.equal(rows(store, 'SELECT * FROM outboxes WHERE id=?', first.outbox.id), before.outbox, 'the refused admission changed no outbox bytes');
    store.close();
  });
});

test('a delivery interrupted between admit and acknowledge reconciles exactly once on reopen', async () => {
  await fixture(async (root) => {
    let store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const admitted = ledger.admitQuestion(question());
    // The process dies here: the operation is pending and its outbox is undelivered.
    store.close();

    store = new ControlStore(root);
    ledger = new DeliveryLedger(store);
    const interrupted = ledger.reconcileOnStartup();
    assert.equal(interrupted.entries.length, 1);
    assert.deepEqual({ ...interrupted.entries[0], operationId: 'x' }, {
      operationId: 'x', operationKind: 'question.delivery', delivery: 'question', questionId: QUESTION,
      projectId: PROJECT, sessionId: SESSION, operationState: 'pending', outboxState: 'pending',
      disposition: 'redeliver-idempotent', redeliver: true, idempotency: 'question-tagged-notification',
      reason: 'the delivery is tagged by the question id, so re-sending it collapses onto the same notification'
    });
    assert.deepEqual({ ...interrupted.counts }, { pendingOperations: 1, undeliveredOutboxRows: 1, redeliverIdempotent: 1, completeAcknowledgement: 0, needsOperatorAttention: 0 });

    const delivered = ledger.markDelivered(QUESTION, { deliveryId: 'synthetic-1' });
    assert.equal(delivered.existing, false);
    assert.equal(delivered.completed, true);
    assert.equal(delivered.operation.state, 'succeeded');
    assert.equal(delivered.outbox.state, 'delivered');
    assert.deepEqual(delivered.outbox.receipt, { deliveryId: 'synthetic-1' });
    assert.deepEqual(delivered.operation.receipt, { deliveryId: 'synthetic-1' });

    // Exactly once: the second acknowledgement reconciles without another write.
    const replay = ledger.markDelivered(QUESTION, { deliveryId: 'synthetic-1' });
    assert.equal(replay.existing, true);
    assert.equal(replay.completed, false);
    assert.equal(replay.operation.revision, delivered.operation.revision);
    assert.equal(replay.outbox.revision, delivered.outbox.revision);
    assert.equal(delivered.outbox.revision, 2, 'the outbox was acknowledged exactly once');
    assert.deepEqual(ledger.reconcileOnStartup().entries, [], 'a settled delivery is not pending work');
    assert.equal(ledger.reconcileOnStartup().counts.pendingOperations, 0);
    store.close();
  });
});

test('a crash after the acknowledgement reconciles by completing the operation, not by re-sending', async () => {
  await fixture(async (root) => {
    let store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const admitted = ledger.admitQuestion(question());
    // The exact durable state markDelivered leaves when it dies between its two writes.
    const receipt = { deliveryId: 'synthetic-window' };
    const acknowledged = store.acknowledgeOutbox(admitted.outbox.id, scope, admitted.outbox.revision, receipt);
    assert.equal(acknowledged.outbox.state, 'delivered');
    assert.equal(acknowledged.operation.state, 'pending');
    store.close();

    store = new ControlStore(root);
    ledger = new DeliveryLedger(store);
    const interrupted = ledger.reconcileOnStartup();
    assert.equal(interrupted.entries.length, 1);
    assert.equal(interrupted.entries[0].disposition, 'complete-acknowledgement');
    assert.equal(interrupted.entries[0].redeliver, false, 'nothing is re-sent for an acknowledged delivery');
    assert.equal(interrupted.entries[0].operationState, 'pending');
    assert.equal(interrupted.entries[0].outboxState, 'delivered');
    assert.deepEqual(interrupted.counts, { pendingOperations: 1, undeliveredOutboxRows: 0, redeliverIdempotent: 0, completeAcknowledgement: 1, needsOperatorAttention: 0 });

    const delivered = ledger.markDelivered(QUESTION, receipt);
    assert.equal(delivered.completed, true);
    assert.equal(delivered.operation.state, 'succeeded');
    assert.equal(delivered.outbox.revision, 2, 'no second acknowledgement was written');
    assert.deepEqual(ledger.reconcileOnStartup().entries, []);
    store.close();
  });
});

test('conflicting delivery evidence is rejected and changes neither linked record', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const admitted = ledger.admitQuestion(question());
    ledger.markDelivered(QUESTION, { deliveryId: 'synthetic-1' });
    const before = {
      operation: rows(store, 'SELECT * FROM operations WHERE id=?', admitted.operation.id),
      outbox: rows(store, 'SELECT * FROM outboxes WHERE id=?', admitted.outbox.id)
    };
    assert.throws(() => ledger.markDelivered(QUESTION, { deliveryId: 'synthetic-2' }), refuses('CONFLICT', /different evidence/));
    assert.throws(() => ledger.markDelivered(QUESTION, 'synthetic-1'), refuses('CONFLICT', /different evidence/));
    assert.equal(rows(store, 'SELECT * FROM operations WHERE id=?', admitted.operation.id), before.operation);
    assert.equal(rows(store, 'SELECT * FROM outboxes WHERE id=?', admitted.outbox.id), before.outbox);
    assert.throws(() => ledger.markDelivered(QUESTION, { when: new Date() }), refuses('INVALID', /receipt is invalid/));
    assert.equal(rows(store, 'SELECT * FROM operations WHERE id=?', admitted.operation.id), before.operation);
    assert.throws(() => ledger.markDelivered('99999999-9999-4999-8999-999999999999', { deliveryId: 'x' }), refuses('NOT_FOUND', /No question delivery is recorded/));
    store.close();
  });
});

test('an answer is recorded at most once per question and survives a reopen', async () => {
  await fixture(async (root) => {
    let store = new ControlStore(root), ledger = new DeliveryLedger(store);
    assert.throws(() => ledger.answerQuestion(answer()), refuses('UNKNOWN_QUESTION', /never admitted in this project\/session scope/));
    // A question asked in another project is foreign here, so its answer is refused too.
    const other = ledger.admitQuestion(question({ projectId: 'project-b' }));
    assert.equal(other.existing, false);
    assert.throws(() => ledger.answerQuestion(answer()), refuses('UNKNOWN_QUESTION', /never admitted/));

    const asked = ledger.admitQuestion(question());
    const first = ledger.answerQuestion(answer());
    assert.equal(first.existing, false);
    assert.equal(first.operation.state, 'pending');
    assert.equal(first.outbox.kind, 'answer.deliver');
    assert.equal((first.outbox.payload as { requestId: string }).requestId, 'answer:' + QUESTION);

    const retry = ledger.answerQuestion(answer());
    assert.equal(retry.existing, true);
    assert.equal(retry.operation.id, first.operation.id);
    assert.equal(retry.operation.revision, first.operation.revision);

    const before = rows(store, 'SELECT * FROM operations WHERE id=?', first.operation.id);
    assert.throws(() => ledger.answerQuestion(answer({ text: 'No, stop.' })), refuses('ANSWER_CONFLICT', /already has an answer/));
    assert.equal(rows(store, 'SELECT * FROM operations WHERE id=?', first.operation.id), before, 'the refused answer changed nothing');

    store.close();
    store = new ControlStore(root);
    ledger = new DeliveryLedger(store);
    const persisted = store.getOperation(first.operation.id, scope);
    assert.equal((persisted.input as { text: string }).text, 'Yes, proceed.');
    assert.equal(ledger.answerQuestion(answer()).existing, true, 'the recorded answer is still the one that exists');
    assert.throws(() => ledger.answerQuestion(answer({ text: 'No, stop.' })), refuses('ANSWER_CONFLICT', /already has an answer/));
    assert.equal(asked.operation.id, store.getOperation(asked.operation.id, scope).id);
    store.close();
  });
});

/**
 * The crash window the wiring introduced: the ledger holds an answer and the transcript write never
 * happened. The harness sends a fresh `answeredAt` on every request, so an answer's identity has to
 * be its text — otherwise the natural retry is refused forever and the question can never be
 * answered.
 */
test('an answer is identified by its text: a same-text retry reconciles, a different answer is refused, and the recorded text is available to the reconciliation path only', async () => {
  await fixture(async (root) => {
    let store = new ControlStore(root), ledger = new DeliveryLedger(store);
    ledger.admitQuestion(question());
    const first = ledger.answerQuestion(answer());
    assert.equal(first.existing, false);
    const before = rows(store, 'SELECT * FROM operations WHERE id=?', first.operation.id);

    // A same-text retry is the same answer, even though the harness stamped it with a new instant.
    const retry = ledger.answerQuestion(answer({ answeredAt: 1700000060001 }));
    assert.equal(retry.existing, true);
    assert.equal(retry.operation.id, first.operation.id);
    assert.equal(retry.operation.revision, first.operation.revision, 'the retry wrote nothing');
    assert.equal(rows(store, 'SELECT * FROM operations WHERE id=?', first.operation.id), before, 'the recorded answer is byte-identical after the retry');
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM operations WHERE kind=?').get('answer.delivery') as { n: number }).n, 1, 'the retry created no second answer row');

    // A genuinely different answer is still refused, and changes nothing.
    assert.throws(() => ledger.answerQuestion(answer({ text: 'No, stop.', answeredAt: 1700000060002 })), refuses('ANSWER_CONFLICT', /already has an answer/));
    assert.throws(() => ledger.answerQuestion(answer({ text: 'No, stop.' })), refuses('ANSWER_CONFLICT', /already has an answer/));
    assert.equal(rows(store, 'SELECT * FROM operations WHERE id=?', first.operation.id), before, 'the refused answer changed nothing');
    assert.deepEqual(ledger.deliveries(scope).answers.map((entry) => entry.questionId), [QUESTION]);

    // The ledger can hand its own recorded text to a caller that has to finish the record it
    // committed to; the owner-visible projection still returns no text at all.
    const recorded = ledger.recordedAnswer({ ...scope, questionId: QUESTION });
    assert.deepEqual(recorded, { text: 'Yes, proceed.', answeredAt: new Date(1700000060000).toISOString() });
    assert.equal(ledger.recordedAnswer({ ...scope, questionId: '44444444-4444-4444-8444-444444444444' }), null);
    assert.equal(ledger.recordedAnswer({ projectId: 'project-b', sessionId: SESSION, questionId: QUESTION }), null, 'the recorded text is scoped');
    const view = ledger.deliveries(scope);
    assert.ok(!JSON.stringify(view).includes('Yes, proceed.'), 'the owner view exposes no answer text');
    assert.equal(view.answers[0].delivered, false);
    assert.equal(view.answers[0].receipt, null);

    // After a restart the outstanding answer is still the recorded one, still re-sendable through
    // the ordinary idempotent path, and its text is still readable by that path alone.
    store.close();
    store = new ControlStore(root);
    ledger = new DeliveryLedger(store);
    assert.deepEqual(ledger.recordedAnswer({ ...scope, questionId: QUESTION }), recorded, 'the recorded text survives a reopen');
    const report = ledger.reconcileOnStartup();
    assert.deepEqual(report.entries.map((entry) => [entry.delivery, entry.questionId, entry.disposition, entry.redeliver]), [
      ['answer', QUESTION, 'redeliver-idempotent', true],
      ['question', QUESTION, 'redeliver-idempotent', true]
    ]);
    assert.ok(!JSON.stringify(report).includes('Yes, proceed.'), 'the reconciliation report carries no answer text');
    // The first attempt's evidence is the acknowledgement the re-delivery would write.
    const settled = ledger.markDelivered(QUESTION, { submissionId: 'submission-1', requestId: 'answer-input:' + QUESTION }, { kind: 'answer', scope });
    assert.equal(settled.operation.state, 'succeeded');
    assert.equal(ledger.deliveries(scope).answers[0].delivered, true);
    assert.equal(ledger.answerQuestion(answer({ answeredAt: 1700000060003 })).existing, true, 'the answer is still the recorded one after the re-delivery');
    store.close();
  });
});

/**
 * A channel that had devices and delivered to none of them reports `{sent:0,failed:n,skipped:false}`,
 * which is not a delivery. The start must leave the row outstanding — exactly as it does for a
 * deliberate skip — so the notification is retried instead of being recorded as acknowledged.
 */
test('a re-send the channel could not deliver to any device leaves the row outstanding', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const admitted = ledger.admitQuestion(question());
    const before = rows(store, 'SELECT * FROM outboxes WHERE operation_id=?', admitted.operation.id);

    const lost = await reconcileDeliveries({
      ledger,
      notify: async () => ({ sent: 0, failed: 1, skipped: false }),
      projectName: () => 'Project A'
    });
    assert.deepEqual(lost.counts, { pendingOperations: 1, undeliveredOutboxRows: 1, redeliverIdempotent: 1, completeAcknowledgement: 0, needsOperatorAttention: 0 });
    assert.deepEqual(lost.actions, { redelivered: 0, completed: 0, outstanding: 1, needsOperatorAttention: 0 });
    assert.deepEqual(lost.attention, []);
    assert.equal(rows(store, 'SELECT * FROM outboxes WHERE operation_id=?', admitted.operation.id), before, 'an undelivered re-send wrote nothing');
    assert.equal(ledger.deliveries(scope).questions[0].delivered, false);
    assert.equal(ledger.deliveries(scope).questions[0].receipt, null);

    // One device that really received it is a delivery, and the same row settles.
    const delivered = await reconcileDeliveries({
      ledger,
      notify: async () => ({ sent: 1, failed: 0, skipped: false }),
      projectName: () => undefined
    });
    assert.deepEqual(delivered.actions, { redelivered: 1, completed: 0, outstanding: 0, needsOperatorAttention: 0 });
    assert.equal(ledger.deliveries(scope).questions[0].delivered, true);
    assert.deepEqual(ledger.deliveries(scope).questions[0].receipt, { sent: 1, failed: 0, skipped: false });
    store.close();
  });
});

test('delivery lookups are scoped: the same question id in two projects is ambiguous without a scope', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const inA = ledger.admitQuestion(question());
    const inB = ledger.admitQuestion(question({ projectId: 'project-b' }));
    assert.throws(() => ledger.markDelivered(QUESTION, { deliveryId: 'x' }), refuses('AMBIGUOUS', /more than one scope/));
    const scoped = ledger.markDelivered(QUESTION, { deliveryId: 'x' }, { scope: { projectId: 'project-b' } });
    assert.equal(scoped.operation.projectId, 'project-b');
    assert.equal(scoped.operation.id, inB.operation.id);
    assert.equal(store.getOperation(inA.operation.id, scope).state, 'pending', 'the other scope is untouched');
    assert.throws(() => ledger.markDelivered(QUESTION, { deliveryId: 'x' }, { scope: { projectId: 'project-c' } }), refuses('NOT_FOUND', /in the requested scope/));
    store.close();
  });
});

test('an uncertain delivery is reported for an operator and never replayed', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const admitted = ledger.admitQuestion(question());
    store.updateOperation(admitted.operation.id, scope, admitted.operation.revision, 'unknown');
    const report = ledger.reconcileOnStartup();
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].disposition, 'needs-operator-attention');
    assert.equal(report.entries[0].redeliver, false);
    assert.equal(report.entries[0].idempotency, null);
    assert.match(report.entries[0].reason, /the operation ended as 'unknown' with an outbox in state 'pending'/);
    assert.deepEqual(report.counts, { pendingOperations: 0, undeliveredOutboxRows: 1, redeliverIdempotent: 0, completeAcknowledgement: 0, needsOperatorAttention: 1 });
    assert.throws(() => ledger.markDelivered(QUESTION, { deliveryId: 'x' }), refuses('NEEDS_ATTENTION', /ended as 'unknown'/));
    store.close();
  });
});

test('the reconciliation report is deterministic, frozen and read-only', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), ledger = new DeliveryLedger(store);
    ledger.admitQuestion(question());
    const answered = ledger.admitQuestion(question({ questionId: '22222222-2222-4222-8222-222222222222', text: 'Which provider?' }));
    ledger.answerQuestion(answer({ questionId: '22222222-2222-4222-8222-222222222222' }));
    ledger.admitQuestion(question({ projectId: 'project-b' }));
    store.updateOperation(answered.operation.id, scope, answered.operation.revision, 'unknown');

    const before = await readFile(join(root, 'control.sqlite'));
    const first = ledger.reconcileOnStartup();
    const second = ledger.reconcileOnStartup();
    assert.deepEqual(first, second, 'two consecutive calls over unchanged storage are identical');
    assert.deepEqual(first, JSON.parse(JSON.stringify(first)), 'nothing in the report is unstable or undefined');
    assert.equal(first.entries.length, 4);
    // A stable order: delivery channel, then question id, then the durable operation id.
    assert.deepEqual(first.entries.map((entry) => entry.delivery + '/' + entry.questionId + '/' + entry.disposition), [
      'answer/22222222-2222-4222-8222-222222222222/redeliver-idempotent',
      'question/11111111-1111-4111-8111-111111111111/redeliver-idempotent',
      'question/11111111-1111-4111-8111-111111111111/redeliver-idempotent',
      'question/22222222-2222-4222-8222-222222222222/needs-operator-attention'
    ]);
    // One scope has the uncertain operation; the other rows are idempotent re-sends.
    assert.deepEqual(first.counts, { pendingOperations: 3, undeliveredOutboxRows: 4, redeliverIdempotent: 3, completeAcknowledgement: 0, needsOperatorAttention: 1 });
    assert.deepEqual(first.entries.filter((entry) => entry.projectId === 'project-b').map((entry) => entry.sessionId), [SESSION]);

    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.counts));
    assert.ok(Object.isFrozen(first.entries));
    assert.ok(first.entries.every((entry) => Object.isFrozen(entry)));
    assert.equal(first.readOnly, true);
    assert.match(first.redeliveryPolicy, /Nothing in this report is replayed/);
    // The ledger is a receipt ledger, not the source of truth for question text.
    assert.ok(!JSON.stringify(first).includes('Which provider?'));
    assert.ok(!JSON.stringify(first).includes('Should I proceed?'));
    // Read-only: reconciliation is two SELECT passes and no write at all.
    assert.deepEqual(await readFile(join(root, 'control.sqlite')), before, 'reconciliation left the durable store byte-identical');
    store.close();

    const reopened = new ControlStore(root);
    assert.deepEqual(new DeliveryLedger(reopened).reconcileOnStartup(), first, 'the report is the same after a reopen');
    reopened.close();
  });
});

test('an idempotent re-send is claimed only after the stored payload is validated against its delivery', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const intact = ledger.admitQuestion(question({ questionId: '33333333-3333-4333-8333-333333333333' }));
    const wrongTag = ledger.admitQuestion(question());
    const asked = ledger.admitQuestion(question({ questionId: '22222222-2222-4222-8222-222222222222' }));
    const recorded = ledger.answerQuestion(answer({ questionId: '22222222-2222-4222-8222-222222222222' }));
    const payload = (operationId: string) => store.db.prepare('SELECT payload_json FROM outboxes WHERE operation_id=?').get(operationId) as { payload_json: string };
    const tamper = (operationId: string, value: unknown) => store.db.prepare('UPDATE outboxes SET payload_json=? WHERE operation_id=?').run(JSON.stringify(value), operationId);
    // A tag that no longer names this question: the tag is the whole idempotency claim, because it is
    // what collapses a re-send onto the same effect, so this row is never re-sent.
    tamper(wrongTag.operation.id, { version: 1, delivery: 'question', questionId: QUESTION, tag: 'question:someone-else', requestId: null });
    // A payload that is not the delivery payload at all, which only a real decode can catch.
    tamper(recorded.operation.id, { version: 2, delivery: 'answer', questionId: '22222222-2222-4222-8222-222222222222', tag: 'answer:22222222-2222-4222-8222-222222222222', requestId: 'answer:22222222-2222-4222-8222-222222222222' });
    const rows = (operationId: string) => JSON.stringify(store.db.prepare('SELECT * FROM outboxes WHERE operation_id=?').all(operationId));
    const before = new Map([intact, wrongTag, asked, recorded].map((row) => [row.operation.id, rows(row.operation.id)]));

    const report = ledger.reconcileOnStartup();
    assert.equal(report.entries.length, 4);
    const byOperation = (operationId: string) => report.entries.find((entry) => entry.operationId === operationId)!;
    // The intact rows make the flag actionable: they are what the automated re-sender would re-send.
    for (const row of [intact, asked]) {
      assert.equal(byOperation(row.operation.id).disposition, 'redeliver-idempotent');
      assert.equal(byOperation(row.operation.id).redeliver, true);
    }
    for (const row of [wrongTag, recorded]) {
      assert.equal(byOperation(row.operation.id).disposition, 'needs-operator-attention', 'a payload that does not match is never called idempotent');
      assert.equal(byOperation(row.operation.id).redeliver, false);
      assert.equal(byOperation(row.operation.id).idempotency, null);
    }
    assert.match(byOperation(wrongTag.operation.id).reason, /does not match this delivery/);
    assert.match(byOperation(recorded.operation.id).reason, /not a readable delivery payload/);
    assert.deepEqual(report.counts, { pendingOperations: 4, undeliveredOutboxRows: 4, redeliverIdempotent: 2, completeAcknowledgement: 0, needsOperatorAttention: 2 });
    // The report is a read: a row it refuses was not re-sent and not rewritten.
    for (const row of [intact, wrongTag, asked, recorded]) assert.equal(rows(row.operation.id), before.get(row.operation.id));
    assert.equal(payload(intact.operation.id).payload_json.includes('question:33333333-3333-4333-8333-333333333333'), true, 'the intact payload still names its own question');
    store.close();
  });
});

test('reconcileOnStartup is read-only, including the write-ahead sidecar', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const asked = ledger.admitQuestion(question());
    ledger.answerQuestion(answer());
    store.updateOperation(asked.operation.id, scope, asked.operation.revision, 'unknown');
    // Everything written above is in the sidecar until a checkpoint, so its bytes are the evidence
    // that reconciliation neither wrote nor forced one.
    const sidecar = join(root, 'control.sqlite-wal');
    assert.ok((await stat(sidecar)).size > 0, 'the -wal sidecar holds the frames written above');
    const before = { main: await readFile(join(root, 'control.sqlite')), wal: await readFile(sidecar) };
    const first = ledger.reconcileOnStartup(), second = ledger.reconcileOnStartup();
    assert.deepEqual(first, second);
    assert.equal(first.entries.length, 2, 'the report had real rows to classify: ' + JSON.stringify(first.counts));
    assert.deepEqual(await readFile(join(root, 'control.sqlite')), before.main, 'reconciliation left the database byte-identical');
    assert.deepEqual(await readFile(sidecar), before.wal, 'reconciliation left the write-ahead sidecar byte-identical');
    store.close();
  });
});

test('a crash that half-wrote an acknowledgement is completed from the stored evidence, and the owner view reports it', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root), ledger = new DeliveryLedger(store);
    const settledId = '33333333-3333-4333-8333-333333333333';
    const admitted = ledger.admitQuestion(question());
    const receipt = { sent: 1, failed: 0, skipped: false };
    store.acknowledgeOutbox(admitted.outbox.id, scope, admitted.outbox.revision, receipt);
    // The crash window: the outbox carries the evidence and only the operation state is missing.
    assert.equal(ledger.deliveries(scope).questions[0].delivered, false);
    assert.equal(ledger.reconcileOnStartup().entries[0].disposition, 'complete-acknowledgement');

    const completed = ledger.completeAcknowledgement(QUESTION, { kind: 'question', scope });
    assert.equal(completed.completed, true);
    assert.equal(completed.operation.state, 'succeeded');
    assert.deepEqual(completed.outbox.receipt, receipt, 'the evidence is the outbox\'s own, not invented');
    // Nothing is written twice, and a row with nothing acknowledged is refused rather than guessed at.
    const again = ledger.completeAcknowledgement(QUESTION, { kind: 'question', scope });
    assert.equal(again.existing, true);
    assert.equal(again.completed, false);
    assert.equal(again.outbox.revision, completed.outbox.revision);
    const open = ledger.admitQuestion(question({ questionId: settledId }));
    assert.throws(() => ledger.completeAcknowledgement(settledId, { kind: 'question', scope }), refuses('NEEDS_ATTENTION', /no acknowledged outbox to complete/));

    ledger.answerQuestion(answer());
    const view = ledger.deliveries(scope);
    const delivered = view.questions.find((entry) => entry.questionId === QUESTION)!;
    assert.equal(delivered.delivery, 'question');
    assert.equal(delivered.delivered, true);
    assert.equal(delivered.operationState, 'succeeded');
    assert.equal(delivered.outboxState, 'delivered');
    assert.equal(typeof delivered.acknowledgedAt, 'string');
    assert.deepEqual(delivered.receipt, receipt);
    const unanswered = view.questions.find((entry) => entry.questionId === settledId)!;
    assert.equal(unanswered.delivered, false);
    assert.equal(unanswered.receipt, null);
    assert.equal(unanswered.acknowledgedAt, null);
    assert.equal(view.answers.length, 1);
    assert.equal(view.answers[0].delivery, 'answer');
    assert.equal(view.answers[0].delivered, false);
    assert.deepEqual(view.unreadable, []);
    // It is a receipt ledger for the owner, not a second copy of the transcript or a path listing.
    assert.ok(!JSON.stringify(view).includes('Should I proceed?'));
    assert.ok(!JSON.stringify(view).includes('Yes, proceed.'));
    assert.ok(!JSON.stringify(view).includes(root));
    assert.deepEqual(view.scope, scope);
    assert.deepEqual(ledger.deliveries({ projectId: PROJECT, sessionId: 'session-b' }), { scope: { projectId: PROJECT, sessionId: 'session-b' }, questions: [], answers: [], unreadable: [] });
    assert.equal(ledger.hasQuestion(QUESTION, scope), true);
    assert.equal(ledger.hasQuestion(settledId, scope), true);
    assert.equal(ledger.hasQuestion('44444444-4444-4444-8444-444444444444', scope), false);
    assert.equal(ledger.hasQuestion(QUESTION, { projectId: 'project-b', sessionId: SESSION }), false, 'a question is only admitted in its own scope');
    store.close();
  });
});

/**
 * The control store's checked transaction, exercised as the approval lifecycle uses it. It lives in
 * this file because the delivery ledger and the approval lifecycle share that one transaction: the
 * expected-revision predicate is the only thing between a check and a double-spend, and the
 * approval-store test file is outside this change's file boundary.
 */
test('consume refuses as a conflict when the record moves out of the pre-check\'s view, and keeps the interfering state', async () => {
  await fixture(async (root) => {
    const store = new ControlStore(root);
    const moment = '2025-12-31T23:00:00.000Z';
    const at = () => new Date(moment);
    const target = { remote: 'git@github.com:owner/repo.git', branch: 'main', commitSha: 'a'.repeat(40) };
    const approvals = new ApprovalStore(store, { clock: at, nonce: () => 'a'.repeat(64) });
    const record = approvals.create({ kind: 'push', scope: { projectId: 'project-a' }, target, expiresAt: '2025-12-31T23:30:00.000Z' });
    // The interfering write happens between consume's own pre-checks and the compare-and-swap inside
    // the store's transaction — the window a second writer would occupy — so the pre-check's revision
    // is stale by the time the write is attempted.
    let interfered = false;
    const interfering = new ApprovalStore(store, { clock: () => { if (!interfered) { interfered = true; store.db.prepare('UPDATE operations SET revision=revision+1 WHERE id=?').run(record.id); } return at(); } });
    assert.throws(
      () => interfering.consume({ id: record.id, scope: { projectId: 'project-a' }, kind: 'push', target, consumedBy: 'owner' }),
      (error: unknown) => error instanceof ApprovalError && error.code === 'CONFLICT' && /changed while it was being written/.test(error.message)
    );
    assert.equal(interfered, true, 'the interference really happened during consume');
    // The refused write changed nothing: the row keeps exactly the interfering state.
    const row = store.db.prepare('SELECT state,revision,receipt_json FROM operations WHERE id=?').get(record.id) as { state: string; revision: number; receipt_json: string | null };
    assert.equal(row.state, 'pending', 'the refused consume left the record pending');
    assert.equal(row.revision, 2, 'the interfering revision is the one the row kept');
    assert.equal(row.receipt_json, null, 'the refused consume wrote no receipt');
    assert.equal(new ApprovalStore(store, { clock: at }).read({ projectId: 'project-a' }, record.id).state, 'pending');
    // The record is still consumable exactly once by a reader whose view is current.
    assert.equal(approvals.consume({ id: record.id, scope: { projectId: 'project-a' }, kind: 'push', target, consumedBy: 'owner' }).approval.state, 'consumed');
    assert.throws(
      () => approvals.consume({ id: record.id, scope: { projectId: 'project-a' }, kind: 'push', target, consumedBy: 'owner' }),
      (error: unknown) => error instanceof ApprovalError && error.code === 'CONSUMED'
    );
    store.close();
  });
});
