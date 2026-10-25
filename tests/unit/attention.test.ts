import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENTION_LIST_CAP, ATTENTION_PAGE_LIMIT, ATTENTION_SEVERITY,
  AttentionCursorError, attentionAgeLabel, compareAttentionItems, countAttentionItems, decodeAttentionCursor,
  encodeAttentionCursor, pageAttentionItems, parseAttentionLimit, sortAttentionItems,
  type AttentionItem
} from '../../src/shared/attention';

function question(id: string, at: string | null, projectId = 'p1'): AttentionItem {
  return {
    id: 'question:' + id,
    kind: 'question',
    severity: ATTENTION_SEVERITY.question,
    projectId,
    sessionId: 's1',
    at,
    context: 'Question ' + id,
    actions: ['open'],
    questionId: id
  };
}
function approval(id: string, at: string, projectId = 'p1'): AttentionItem {
  return {
    id: 'approval:' + id,
    kind: 'approval',
    severity: ATTENTION_SEVERITY.approval,
    projectId,
    sessionId: null,
    at,
    context: 'Approval ' + id,
    actions: ['consume', 'revoke'],
    approvalId: id,
    approvalKind: 'spend',
    scope: { projectId },
    target: { amountMinor: 1, currency: 'AUD' },
    expiresAt: '2026-10-25T12:00:00.000Z'
  };
}
function failure(sessionId: string, at: string, projectId = 'p1'): AttentionItem {
  return {
    id: 'failure:' + sessionId,
    kind: 'failure',
    severity: ATTENTION_SEVERITY.failure,
    projectId,
    sessionId,
    at,
    context: 'The run failed.',
    actions: ['retry'],
    lifecycleRevision: 3,
    reason: 'The run failed.'
  };
}
function interrupted(sessionId: string, at: string, projectId = 'p1'): AttentionItem {
  return {
    id: 'interrupted:' + sessionId,
    kind: 'interrupted',
    severity: ATTENTION_SEVERITY.interrupted,
    projectId,
    sessionId,
    at,
    context: 'The process stopped.',
    actions: [],
    lifecycleRevision: 4,
    reason: 'The process stopped.',
    uncertain: true
  };
}

test('attention orders by severity, then age, then id and does not mutate its input', () => {
  const items = [
    question('q-2', '2026-10-25T09:00:00.000Z'),
    question('q-1', '2026-10-25T08:00:00.000Z'),
    approval('a-1', '2026-10-25T07:00:00.000Z'),
    failure('s-1', '2026-10-25T10:00:00.000Z'),
    interrupted('s-2', '2026-10-25T11:00:00.000Z'),
    question('q-3', '2026-10-25T08:00:00.000Z')
  ];
  const before = items.map(item => item.id);
  const sorted = sortAttentionItems(items);
  assert.deepEqual(sorted.map(item => item.kind), ['interrupted', 'failure', 'approval', 'question', 'question', 'question']);
  // The two questions share an instant, so the id breaks the tie; the older question comes first.
  assert.deepEqual(sorted.slice(3).map(item => item.id), ['question:q-1', 'question:q-3', 'question:q-2']);
  assert.deepEqual(items.map(item => item.id), before, 'the caller\'s array is not reordered');
});

test('the exact count is computed from every item, including above the listed cap', () => {
  const small = [question('q-1', '2026-10-25T08:00:00.000Z'), failure('s-1', '2026-10-25T09:00:00.000Z')];
  assert.deepEqual(countAttentionItems(small), { open: 2, byKind: { question: 1, approval: 0, failure: 1, interrupted: 0 }, capped: false, complete: true });
  assert.equal(countAttentionItems(small, false).complete, false, 'a partial count is not an exact one');
  const many = Array.from({ length: ATTENTION_LIST_CAP + 5 }, (_, index) => question('q-' + index, '2026-10-25T08:00:00.000Z'));
  const count = countAttentionItems(many);
  assert.equal(count.open, ATTENTION_LIST_CAP + 5);
  assert.equal(count.capped, true);
});

test('a page holds 20 items by default and its cursor continues exactly where it stopped', () => {
  const items = Array.from({ length: 45 }, (_, index) => question('q-' + String(index).padStart(2, '0'), '2026-10-25T08:' + String(index).padStart(2, '0') + ':00.000Z'));
  const first = pageAttentionItems(items);
  assert.equal(first.items.length, ATTENTION_PAGE_LIMIT);
  assert.equal(first.page.limit, 20);
  assert.equal(first.page.hasMore, true);
  assert.equal(first.page.capped, false);
  assert.ok(first.page.nextCursor);
  const second = pageAttentionItems(items, { cursor: decodeAttentionCursor(first.page.nextCursor) });
  assert.equal(second.items.length, 20);
  const third = pageAttentionItems(items, { cursor: decodeAttentionCursor(second.page.nextCursor) });
  assert.equal(third.items.length, 5);
  assert.equal(third.page.hasMore, false);
  assert.equal(third.page.nextCursor, null);
  const seen = [...first.items, ...second.items, ...third.items].map(item => item.id);
  assert.equal(new Set(seen).size, 45, 'no item is repeated and none is skipped');
});

test('two items with the same severity and instant are separated by the id tie-break', () => {
  const left = question('b-question', '2026-10-25T08:00:00.000Z');
  const right = question('a-question', '2026-10-25T08:00:00.000Z');
  assert.ok(compareAttentionItems(right, left) < 0);
  const page = pageAttentionItems([left, right], { limit: 1 });
  assert.deepEqual(page.items.map(item => item.id), ['question:a-question']);
  const next = pageAttentionItems([left, right], { limit: 1, cursor: decodeAttentionCursor(page.page.nextCursor!) });
  assert.deepEqual(next.items.map(item => item.id), ['question:b-question']);
  assert.equal(next.page.hasMore, false);
});

test('a stale cursor keeps its keyset position after the item that produced it is resolved', () => {
  const items = [
    approval('a-1', '2026-10-25T07:00:00.000Z'),
    approval('a-2', '2026-10-25T08:00:00.000Z'),
    approval('a-3', '2026-10-25T09:00:00.000Z'),
    approval('a-4', '2026-10-25T10:00:00.000Z')
  ];
  const first = pageAttentionItems(items, { limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ['approval:a-1', 'approval:a-2']);
  // The item the cursor named is consumed (or revoked) before the next page is read.
  const remaining = items.filter(item => item.id !== 'approval:a-2');
  const next = pageAttentionItems(remaining, { limit: 2, cursor: decodeAttentionCursor(first.page.nextCursor!) });
  assert.deepEqual(next.items.map(item => item.id), ['approval:a-3', 'approval:a-4']);
  assert.equal(next.page.hasMore, false);
});

test('the listed list stops at the cap while the count stays exact and pages say so', () => {
  const items = Array.from({ length: ATTENTION_LIST_CAP + 7 }, (_, index) => approval('a-' + String(index).padStart(3, '0'), new Date(Date.parse('2026-10-25T00:00:00.000Z') + index * 1000).toISOString()));
  const openCount = countAttentionItems(items).open;
  const seen: string[] = [];
  let cursor: ReturnType<typeof decodeAttentionCursor> | null = null;
  for (let page = 0; page < 10; page += 1) {
    const result = pageAttentionItems(items, { cursor, limit: 20, openCount });
    seen.push(...result.items.map(item => item.id));
    assert.equal(result.page.capped, true);
    if (result.page.nextCursor === null) break;
    cursor = decodeAttentionCursor(result.page.nextCursor);
  }
  assert.equal(seen.length, ATTENTION_LIST_CAP);
  assert.equal(new Set(seen).size, ATTENTION_LIST_CAP);
  assert.equal(openCount, ATTENTION_LIST_CAP + 7);
});

test('a cursor or a page size this module cannot read is refused, not silently reset', () => {
  assert.throws(() => decodeAttentionCursor('not-a-cursor'), AttentionCursorError);
  assert.throws(() => decodeAttentionCursor(''), AttentionCursorError);
  assert.throws(() => decodeAttentionCursor(btoa('{"v":2,"severity":0,"at":"2026-10-25T00:00:00.000Z","id":"x"}')), AttentionCursorError);
  assert.throws(() => decodeAttentionCursor(btoa('{"v":1,"severity":9,"at":"2026-10-25T00:00:00.000Z","id":"x"}')), AttentionCursorError);
  assert.throws(() => parseAttentionLimit('0'), AttentionCursorError);
  assert.throws(() => parseAttentionLimit('101'), AttentionCursorError);
  assert.throws(() => parseAttentionLimit('1.5'), AttentionCursorError);
  assert.equal(parseAttentionLimit(undefined), 20);
  assert.equal(parseAttentionLimit('100'), 100);
});

test('a question with no recorded instant sorts last as unknown, not as an epoch age', () => {
  const unknown = question('q-unknown', null);
  const early = question('q-early', '2026-10-25T08:00:00.000Z');
  const later = question('q-later', '2026-10-25T09:00:00.000Z');
  const sorted = sortAttentionItems([unknown, later, early]);
  assert.deepEqual(sorted.map(item => item.id), ['question:q-early', 'question:q-later', 'question:q-unknown']);
  assert.equal(attentionAgeLabel(null, Date.parse('2026-10-25T10:00:00.000Z')), 'age unknown');
  assert.equal(attentionAgeLabel('2026-10-25T09:30:00.000Z', Date.parse('2026-10-25T10:00:00.000Z')), '30 min');
  // A null-instant item still pages by keyset, with the same stable id tie-break.
  const page = pageAttentionItems([unknown, early], { limit: 1 });
  assert.deepEqual(page.items.map(item => item.id), ['question:q-early']);
  const next = pageAttentionItems([unknown, early], { limit: 1, cursor: decodeAttentionCursor(page.page.nextCursor!) });
  assert.deepEqual(next.items.map(item => item.id), ['question:q-unknown']);
  assert.equal(next.page.hasMore, false);
});

test('a cursor round-trips through its encoded form', () => {
  const item = interrupted('session-1', '2026-10-25T08:00:00.000Z');
  const cursor = decodeAttentionCursor(encodeAttentionCursor(item));
  assert.deepEqual(cursor, { v: 1, severity: ATTENTION_SEVERITY.interrupted, at: item.at, id: item.id });
});
