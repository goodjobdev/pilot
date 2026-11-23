import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelKey, type ModelChoice } from '../../src/shared/settings';
import {
  buildWorkerModelPolicy,
  parseWorkerModelPolicyUpdate,
  sameWorkerModelPolicyDraft,
  validateWorkerModelPolicyDraft,
  validateWorkerModelPolicyRecord,
  WorkerModelPolicyError,
  type WorkerModelPolicy
} from '../../src/shared/model-policy';

/**
 * The pure worker model policy. It configures future owner-created workers only. These tests
 * make no provider call, open no harness and touch no filesystem.
 */

const STRONG: ModelChoice = { provider: 'openai', modelId: 'gpt-strong' };
const CHEAP: ModelChoice = { provider: 'openai', modelId: 'gpt-cheap' };
const OTHER: ModelChoice = { provider: 'anthropic', modelId: 'claude' };
const SAVED_GONE: ModelChoice = { provider: 'oldprovider', modelId: 'retired-model' };
const OWNER = { kind: 'owner' as const, identity: 'local' };

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

function previous(allowed: readonly ModelChoice[], defaultModel: ModelChoice | null): WorkerModelPolicy {
  return buildWorkerModelPolicy({
    revision: 3,
    draft: { allowedWorkerModels: allowed, defaultWorkerModel: defaultModel },
    actor: OWNER,
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
}

test('a draft is canonical, frozen, and keeps an explicit default', () => {
  const draft = validateWorkerModelPolicyDraft(
    { allowedWorkerModels: [STRONG, CHEAP], defaultWorkerModel: CHEAP },
    [STRONG, CHEAP]
  );
  assert.deepEqual(draft.allowedWorkerModels.map(modelKey), [modelKey(CHEAP), modelKey(STRONG)]);
  assert.equal(modelKey(draft.defaultWorkerModel!), modelKey(CHEAP));
  assert.ok(Object.isFrozen(draft));
  assert.ok(Object.isFrozen(draft.allowedWorkerModels));
  assert.ok(draft.allowedWorkerModels.every(Object.isFrozen));
});

test('a duplicate model is refused rather than silently collapsed', () => {
  const message = refused(
    () => validateWorkerModelPolicyDraft({ allowedWorkerModels: [CHEAP, CHEAP], defaultWorkerModel: null }, [CHEAP]),
    'DUPLICATE_MODEL'
  );
  assert.match(message, /appears more than once/);
});

test('a new model outside the catalog is refused, and nothing is substituted', () => {
  const message = refused(
    () => validateWorkerModelPolicyDraft({ allowedWorkerModels: [OTHER], defaultWorkerModel: OTHER }, [STRONG, CHEAP]),
    'MODEL_NOT_OFFERED'
  );
  assert.match(message, /not one this instance offers/);
  assert.match(message, /anthropic\/claude/);
});

test('a saved model that left the catalog is preserved for inspection and can be removed', () => {
  const saved = previous([SAVED_GONE], SAVED_GONE);
  // Keeping the unavailable entry is accepted: it was saved before.
  const kept = validateWorkerModelPolicyDraft({ allowedWorkerModels: [SAVED_GONE], defaultWorkerModel: SAVED_GONE }, [STRONG], saved);
  assert.deepEqual(kept.allowedWorkerModels.map(modelKey), [modelKey(SAVED_GONE)]);
  // Removing it is accepted.
  const removed = validateWorkerModelPolicyDraft({ allowedWorkerModels: [], defaultWorkerModel: null }, [STRONG], saved);
  assert.equal(removed.allowedWorkerModels.length, 0);
  // A *new* unknown model is still refused, even beside an unavailable saved entry.
  refused(
    () => validateWorkerModelPolicyDraft({ allowedWorkerModels: [SAVED_GONE, OTHER], defaultWorkerModel: null }, [STRONG], saved),
    'MODEL_NOT_OFFERED'
  );
});

test('removing the default from the allowed set is refused; clearing it explicitly is accepted', () => {
  const saved = previous([STRONG, CHEAP], CHEAP);
  const message = refused(
    () => validateWorkerModelPolicyDraft({ allowedWorkerModels: [STRONG], defaultWorkerModel: CHEAP }, [STRONG, CHEAP], saved),
    'DEFAULT_NOT_ALLOWED'
  );
  assert.match(message, /clear defaultWorkerModel explicitly/);
  assert.match(message, /not changed automatically/);
  const cleared = validateWorkerModelPolicyDraft({ allowedWorkerModels: [STRONG], defaultWorkerModel: null }, [STRONG, CHEAP], saved);
  assert.equal(cleared.defaultWorkerModel, null);
});

test('the write shape accepts no actor and no unknown field', () => {
  const message = refused(
    () => parseWorkerModelPolicyUpdate({
      revision: 0,
      policy: { allowedWorkerModels: [], defaultWorkerModel: null },
      actor: { kind: 'owner', identity: 'client-supplied' }
    }),
    'INVALID'
  );
  assert.match(message, /nrecognized key|actor/);
});

test('a stored record is validated without the live catalog, but its canonical shape is enforced', () => {
  const record = previous([STRONG, CHEAP], CHEAP);
  const read = validateWorkerModelPolicyRecord(record);
  assert.deepEqual(read.allowedWorkerModels.map(modelKey), record.allowedWorkerModels.map(modelKey));
  // Order is canonical even when the input is not.
  const unsorted = { ...record, allowedWorkerModels: [STRONG, CHEAP] };
  refused(() => validateWorkerModelPolicyRecord(unsorted), 'CORRUPT');
  // A default outside the stored set is corruption.
  refused(() => validateWorkerModelPolicyRecord({ ...record, defaultWorkerModel: OTHER }), 'CORRUPT');
});

test('same-content comparison ignores order and distinguishes a default change', () => {
  const saved = previous([STRONG, CHEAP], CHEAP);
  assert.equal(sameWorkerModelPolicyDraft(saved, { allowedWorkerModels: [CHEAP, STRONG], defaultWorkerModel: CHEAP }), true);
  assert.equal(sameWorkerModelPolicyDraft(saved, { allowedWorkerModels: [CHEAP, STRONG], defaultWorkerModel: STRONG }), false);
  assert.equal(sameWorkerModelPolicyDraft(saved, { allowedWorkerModels: [CHEAP], defaultWorkerModel: CHEAP }), false);
});
