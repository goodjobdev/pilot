import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboxRequestController } from '../../src/client/inbox-request-controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function effects(state: { status: string; value: string }) {
  return {
    start: () => { state.status = 'loading'; },
    success: (value: string) => { state.status = 'loaded'; state.value = value; },
    failure: () => { state.status = 'unavailable'; state.value = ''; }
  };
}

test('inbox request controller waits for and suppresses a stale failure after a newer load', async () => {
  const controller = new InboxRequestController();
  const state = { status: 'idle', value: '' };
  const older = deferred<string>();
  const olderRun = controller.load(() => older.promise, effects(state));
  const newerRun = controller.load(async () => 'current questions', effects(state));

  assert.equal(await newerRun, 'loaded');
  assert.deepEqual(state, { status: 'loaded', value: 'current questions' });
  older.reject(new Error('older request failed'));
  assert.equal(await olderRun, 'stale'); // Promise settles only after the stale result has been discarded.
  assert.deepEqual(state, { status: 'loaded', value: 'current questions' });
});

test('inbox request controller invalidation prevents a previous project response from publishing', async () => {
  const controller = new InboxRequestController();
  const state = { status: 'idle', value: '' };
  const older = deferred<string>();
  const oldRun = controller.load(() => older.promise, effects(state));
  controller.invalidate();
  const newRun = controller.load(async () => 'project B questions', effects(state));

  assert.equal(await newRun, 'loaded');
  older.resolve('project A questions');
  assert.equal(await oldRun, 'stale');
  assert.deepEqual(state, { status: 'loaded', value: 'project B questions' });
});
