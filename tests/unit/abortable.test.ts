import test from 'node:test';
import assert from 'node:assert/strict';
import { abortableDelay } from '../../src/server/agents/abortable';

const timers = () => process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;

test('abortableDelay resolves after its duration', async () => {
  const started = Date.now();
  await abortableDelay(20);
  assert.ok(Date.now() - started >= 15, 'the wait really waited');
});

test('abortableDelay rejects with the signal reason and clears its timer', async () => {
  const before = timers();
  const controller = new AbortController();
  const reason = new Error('cancelled by the owner');
  const pending = abortableDelay(60000, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  // Nothing holds the process for the rest of the minute: the long timer was cleared.
  assert.ok(timers() <= before, 'an aborted wait leaves no timer behind');
});

test('abortableDelay rejects before waiting when the signal is already aborted, and a non-positive wait is immediate', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  const started = Date.now();
  await assert.rejects(abortableDelay(60000, controller.signal), /already cancelled/);
  assert.ok(Date.now() - started < 1000);
  await abortableDelay(0);
  await abortableDelay(Number.NaN);
  await abortableDelay(-5);
});
