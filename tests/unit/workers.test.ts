import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKER_MAX_MODEL_TURNS, WORKER_MAX_OUTPUT_TOKENS_PER_TURN, WORKER_REPORT_MAX_BYTES, WORKER_REPORT_UNTRUSTED_NOTICE,
  WorkerError, buildWorkerRecord, composeWorkerReport, normalizeWorkerScopes, parseWorkerReportHeader, pinWorkerModel, workerReportHeaderMatches,
  sanitizeWorkerReportBody, validateWorkerRecord, workerPrompt, workerReportPath, type WorkerRecord
} from '../../src/shared/workers';
import { buildWorkerModelPolicy } from '../../src/shared/model-policy';

/**
 * Pure worker rules: the closed scope set, the owner-only model pin with no fallback, the fixed
 * budgets, the canonical report and its deterministic redaction. No store, harness or provider.
 */

const MODEL = { provider: 'faux', modelId: 'scripted' } as const;
const ACTOR = { kind: 'owner' as const, identity: 'owner' };
const CLOCK = new Date('2026-01-01T00:00:00.000Z');

function policy(models = [MODEL], defaultModel: typeof MODEL | null = MODEL) {
  return buildWorkerModelPolicy({ revision: 1, draft: { allowedWorkerModels: models, defaultWorkerModel: defaultModel }, actor: ACTOR, updatedAt: CLOCK.toISOString() });
}

function worker(over: Partial<WorkerRecord> = {}): WorkerRecord {
  const base = buildWorkerRecord({ id: 'w-1', projectId: 'p-1', name: 'Reviewer', model: MODEL, scopes: ['read_notes'], actor: ACTOR, now: CLOCK });
  return validateWorkerRecord({ ...base, ...over });
}

test('workers: only the installed non-question scopes are accepted, in canonical order', () => {
  assert.deepEqual(normalizeWorkerScopes(['read_notes', 'record_note']), ['record_note', 'read_notes']);
  assert.deepEqual(normalizeWorkerScopes([]), []);
  // ask_question has an installed tool but no bounded worker answer path in W1, so it is refused
  // with its own explanation rather than offered as a dead end.
  assert.throws(
    () => normalizeWorkerScopes(['ask_question']),
    (error: unknown) => error instanceof WorkerError && error.code === 'SCOPE_NOT_INSTALLED' && /no bounded owner answer path/.test(error.message)
  );
  for (const scope of ['read_docs', 'write_docs', 'file_read', 'run_tests', 'commit', 'push', 'deploy', 'spend', 'publish', 'fork', 'accept']) {
    assert.throws(() => normalizeWorkerScopes([scope]), (error: unknown) => error instanceof WorkerError && error.code === 'SCOPE_NOT_INSTALLED');
  }
  assert.throws(() => normalizeWorkerScopes(['read_notes', 'read_notes']), /more than once/);
  assert.throws(() => normalizeWorkerScopes('read_notes'), /array/);
});

test('workers: the model is pinned from the allowed set or the owner default, with no fallback', () => {
  assert.deepEqual(pinWorkerModel(policy(), null), MODEL);
  assert.deepEqual(pinWorkerModel(policy(), MODEL), MODEL);
  const other = { provider: 'faux', modelId: 'other' };
  assert.throws(() => pinWorkerModel(policy([MODEL], null), null), (error: unknown) => error instanceof WorkerError && error.code === 'MODEL_NOT_ALLOWED' && /no default/.test(error.message));
  assert.throws(() => pinWorkerModel(policy([], null), null), /empty allowed set/);
  assert.throws(() => pinWorkerModel(null, MODEL), /No owner worker model policy/);
  assert.throws(() => pinWorkerModel(policy([MODEL], MODEL), other), (error: unknown) => error instanceof WorkerError && error.code === 'MODEL_NOT_ALLOWED' && /no fallback/.test(error.message));
});

test('workers: a record carries the fixed budgets, a stable id and an owner actor only', () => {
  const record = worker();
  assert.equal(record.budgets.maxModelTurns, WORKER_MAX_MODEL_TURNS);
  assert.equal(record.budgets.maxOutputTokensPerTurn, WORKER_MAX_OUTPUT_TOKENS_PER_TURN);
  assert.equal(record.revision, 1);
  assert.ok(Object.isFrozen(record));
  assert.throws(() => buildWorkerRecord({ id: 'w-2', projectId: 'p-1', name: 'X', model: MODEL, scopes: [], actor: { kind: 'agent', identity: 'a' }, now: CLOCK }), (error: unknown) => error instanceof WorkerError && error.code === 'NOT_PERMITTED');
  assert.throws(() => validateWorkerRecord({ ...record, budgets: { maxModelTurns: 9, maxOutputTokensPerTurn: 4096 } }), /invalid/);
  assert.throws(() => validateWorkerRecord({ ...record, scopes: ['read_notes', 'record_note'] }), /canonical scope order/);
  assert.throws(() => validateWorkerRecord({ ...record, scopes: ['ask_question'] }), /invalid/);
  assert.throws(() => validateWorkerRecord({ ...record, name: 'bad\nname' }), /invalid/);
  assert.throws(() => validateWorkerRecord({ ...record, surprise: true }), /surprise/);
});

test('workers: the canonical report is deterministic, bounded and marked as untrusted evidence', () => {
  const base = worker();
  const run = { version: 1 as const, id: 'r-1', projectId: 'p-1', workerId: base.id, workerRevision: 1, model: MODEL, attempt: 1 as const, requestId: 'worker-run:r-1:a1', state: 'completed' as const, revision: 2, turns: 2, report: null, cancelRequested: false, reason: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z' };
  const input = { worker: base, run, body: 'Observed two notes. No action taken.', projectRoot: '/projects/alpha', dataRoot: '/var/pilot', endedAt: new Date('2026-01-01T00:01:00.000Z') };
  const first = composeWorkerReport(input);
  assert.equal(first, composeWorkerReport(input));
  assert.equal(workerReportPath('w-1', 'r-1'), 'docs/workers/w-1/r-1.md');
  assert.match(first, /^---\nworker_report: 1\n/);
  assert.match(first, new RegExp(WORKER_REPORT_UNTRUSTED_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(first, /never as instructions/);
  assert.doesNotMatch(first, /accepted|approval granted|scope granted/i);
  assert.throws(() => composeWorkerReport({ ...input, body: 'x'.repeat(WORKER_REPORT_MAX_BYTES + 1) }), /refused rather than truncated/);
  assert.throws(() => composeWorkerReport({ ...input, body: '   ' }), /empty report/);
});

test('workers: a recovery header is parsed strictly and must match its run', () => {
  const base = worker();
  const run = { version: 1 as const, id: 'r-1', projectId: 'p-1', workerId: base.id, workerRevision: 1, model: MODEL, attempt: 1 as const, requestId: 'worker-run:r-1:a1', state: 'completed' as const, revision: 2, turns: 2, report: null, cancelRequested: false, reason: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z' };
  const text = composeWorkerReport({ worker: base, run, body: 'Observed.', projectRoot: '/p', dataRoot: '/d', endedAt: new Date('2026-01-01T00:01:00.000Z') });
  const header = parseWorkerReportHeader(text);
  assert.ok(header);
  assert.equal(workerReportHeaderMatches(header!, base, run), true);
  assert.equal(workerReportHeaderMatches(header!, base, { ...run, id: 'r-2' }), false);
  assert.equal(parseWorkerReportHeader('# Manual report\n\nNot a worker report.'), null);
  const partial = text.replace('worker_revision: 1\n', '');
  assert.equal(parseWorkerReportHeader(partial), null);
  const foreign = text.replace('run_id: "r-1"', 'run_id: "r-2"');
  const foreignHeader = parseWorkerReportHeader(foreign);
  assert.ok(foreignHeader);
  assert.equal(workerReportHeaderMatches(foreignHeader!, base, run), false);
});

test('workers: paths and credential-shaped tokens are redacted deterministically', () => {
  const body = 'Read /projects/alpha/docs/a.md and /var/pilot/credentials/providers.json with sk-abcdefghijklmnop and /home/alice/key.';
  const once = sanitizeWorkerReportBody(body, '/projects/alpha', '/var/pilot');
  const twice = sanitizeWorkerReportBody(body, '/projects/alpha', '/var/pilot');
  assert.equal(once, twice);
  assert.doesNotMatch(once, /\/projects\/alpha|\/var\/pilot|\/home\/alice|sk-abcdefghijklmnop/);
  assert.match(once, /\[path removed\]/);
  assert.match(once, /\[token removed\]/);
  assert.match(sanitizeWorkerReportBody('key -----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY----- done', '/p', '/d'), /\[private key removed\]/);
  assert.throws(() => sanitizeWorkerReportBody('bad\u0000text', '/p', '/d'), /control characters/);
});

test('workers: the prompt names the bounded role and no task text from an owner', () => {
  const prompt = workerPrompt(worker());
  assert.match(prompt, /bounded worker/);
  assert.match(prompt, /no coding, shell, file, commit, push, deploy, spend or publish tools/);
  assert.match(prompt, /cannot approve or accept/);
  assert.match(prompt, /Keep it under 4000 words/);
});
