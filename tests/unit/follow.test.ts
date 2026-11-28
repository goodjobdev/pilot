import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEAR_BOTTOM_PX,
  NEW_ACTIVITY_CAP,
  activityArrived,
  activityCountUnknown,
  arrivalAfterFrame,
  countLabel,
  distanceFromBottom,
  followIdentity,
  indicatorLabel,
  initialFollow,
  isNearBottom,
  readerScrolled,
  readerStillFollowing,
  type ScrollMetrics,
} from '../../src/client/follow';

/**
 * The follow-scroll rules, without a browser.
 *
 * These tests hold the promise the transcript makes: follow only at the bottom, keep a paused
 * reader's place, count what arrived while paused, never invent a count, and never read this page's
 * own scroll or a layout shift as the reader leaving the bottom.
 */

const atBottom: ScrollMetrics = { scrollTop: 600, clientHeight: 400, scrollHeight: 1000 };
const readingAbove: ScrollMetrics = { scrollTop: 120, clientHeight: 400, scrollHeight: 1000 };

test('a new transcript starts following with nothing counted', () => {
  assert.deepEqual(initialFollow(), { following: true, missed: 0 });
});

test('a follow identity distinguishes two project/session pairs that would otherwise join the same', () => {
  assert.notEqual(followIdentity('a:b', 'c'), followIdentity('a', 'b:c'));
  assert.equal(followIdentity('p1', 'root'), followIdentity('p1', 'root'));
});

test('the bottom distance is measured in CSS pixels and clamped at zero', () => {
  assert.equal(distanceFromBottom(atBottom), 0);
  assert.equal(distanceFromBottom(readingAbove), 480);
  // A scroll position past the end is not a negative distance.
  assert.equal(distanceFromBottom({ scrollTop: 900, clientHeight: 400, scrollHeight: 1000 }), 0);
});

test('a missing measurement is never treated as the bottom', () => {
  for (const metrics of [
    { scrollTop: Number.NaN, clientHeight: 400, scrollHeight: 1000 },
    { scrollTop: 0, clientHeight: Number.POSITIVE_INFINITY, scrollHeight: 1000 },
    { scrollTop: 0, clientHeight: 400, scrollHeight: Number.NaN },
  ]) {
    assert.equal(distanceFromBottom(metrics), Number.POSITIVE_INFINITY);
    assert.equal(isNearBottom(metrics), false);
  }
});

test('the near-bottom threshold is about eight pixels and is inclusive', () => {
  assert.equal(NEAR_BOTTOM_PX, 8);
  assert.equal(isNearBottom({ scrollTop: 592, clientHeight: 400, scrollHeight: 1000 }), true);
  assert.equal(isNearBottom({ scrollTop: 591, clientHeight: 400, scrollHeight: 1000 }), false);
  assert.equal(isNearBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 }, 100), true);
});

test('scrolling up pauses following and starts an empty count', () => {
  const paused = readerScrolled(initialFollow(), readingAbove);
  assert.deepEqual(paused, { following: false, missed: 0 });
});

test('staying paused keeps the count; reaching the bottom resumes and clears it', () => {
  const paused = { following: false, missed: 7 };
  assert.deepEqual(readerScrolled(paused, { scrollTop: 100, clientHeight: 400, scrollHeight: 1000 }), paused);
  assert.deepEqual(readerScrolled(paused, atBottom), { following: true, missed: 0 });
});

test('a reader already following at the bottom keeps the same state object', () => {
  const following = initialFollow();
  assert.equal(readerScrolled(following, atBottom), following);
});

test('a live position still follows when only the content below grew', () => {
  // The page last put the reader at 600. New entries below made the transcript 400 px longer and
  // did not move the reader, so the distance to the bottom is large but the position is unchanged.
  const grown: ScrollMetrics = { scrollTop: 600, clientHeight: 400, scrollHeight: 1400 };
  assert.equal(readerStillFollowing(grown, 600), true);
  // A position that changed upward is a reader who left the bottom, whatever the event timing.
  assert.equal(readerStillFollowing(readingAbove, 600), false);
  // At the bottom the live measurement always wins.
  assert.equal(readerStillFollowing(atBottom, 600), true);
  // With no recorded position there is nothing to compare, so the held state is trusted.
  assert.equal(readerStillFollowing(readingAbove, null), true);
  assert.equal(readerStillFollowing({ scrollTop: Number.NaN, clientHeight: 400, scrollHeight: 1000 }, 600), true);
});

test('a frame that arrives before the reader move was handled does not follow', () => {
  // This is the race: the reader set the position to 120, the scroll event has not arrived, and the
  // state still says following. The frame must pause and count instead of dragging them down.
  const next = arrivalAfterFrame(initialFollow(), 4, 5, readingAbove, 600);
  assert.deepEqual(next, { following: false, missed: 1 });
});

test('a frame that arrives while the reader is still at the bottom follows', () => {
  const grown: ScrollMetrics = { scrollTop: 600, clientHeight: 400, scrollHeight: 1400 };
  const following = initialFollow();
  assert.equal(arrivalAfterFrame(following, 4, 5, grown, 600), following);
});

test('a paused reader counts every arrival, whether or not the position moved again', () => {
  const paused = { following: false, missed: 2 };
  assert.deepEqual(arrivalAfterFrame(paused, 4, 5, readingAbove, 600), { following: false, missed: 3 });
  assert.deepEqual(arrivalAfterFrame(paused, 4, 5, atBottom, 600), { following: false, missed: 3 });
});

test('arriving entries are never counted while following', () => {
  const following = initialFollow();
  assert.equal(activityArrived(following, 4, 9), following);
});

test('arriving entries grow the paused count by exactly what arrived', () => {
  assert.deepEqual(activityArrived({ following: false, missed: 0 }, 4, 5), { following: false, missed: 1 });
  assert.deepEqual(activityArrived({ following: false, missed: 1 }, 5, 8), { following: false, missed: 4 });
});

test('a shrinking or unchanged entry count never counts anything', () => {
  const paused = { following: false, missed: 3 };
  assert.equal(activityArrived(paused, 9, 9), paused);
  assert.equal(activityArrived(paused, 9, 6), paused);
  assert.equal(activityArrived(paused, Number.NaN, 6), paused);
  assert.equal(activityArrived(paused, 9, Number.POSITIVE_INFINITY), paused);
});

test('the count is exact at the cap and bounded one above it', () => {
  assert.equal(NEW_ACTIVITY_CAP, 99);
  const exact = activityArrived({ following: false, missed: 98 }, 0, 1);
  assert.deepEqual(exact, { following: false, missed: 99 });
  // One more arrival passes the cap; the stored count stops one above so 99 stays exact.
  const passed = activityArrived(exact, 1, 500);
  assert.deepEqual(passed, { following: false, missed: 100 });
  assert.equal(activityArrived(passed, 500, 900), passed);
  assert.equal(activityArrived({ following: false, missed: 0 }, 0, 6, 2).missed, 3);
  assert.equal(activityArrived({ following: false, missed: 0 }, 0, 6, 0).missed, 1);
});

test('the count label is exact at 99 and says 99+ only above it', () => {
  assert.equal(countLabel(0), '');
  assert.equal(countLabel(1), '1 new activity');
  assert.equal(countLabel(2), '2 new activities');
  assert.equal(countLabel(99), '99 new activities');
  assert.equal(countLabel(100), '99+ new activities');
  assert.equal(countLabel(400), '99+ new activities');
  assert.equal(countLabel(Number.NaN), '');
  assert.equal(countLabel(-3), '');
});

test('unknown new activity is named without inventing a count', () => {
  const paused = activityCountUnknown({ following: false, missed: 0 });
  assert.deepEqual(paused, { following: false, missed: 0, countUnknown: true });
  assert.equal(indicatorLabel(paused), 'New activity; count unavailable');
  assert.deepEqual(activityCountUnknown(initialFollow()), initialFollow());
});

test('the indicator names what tapping it will do', () => {
  assert.equal(indicatorLabel({ following: false, missed: 0 }), 'Jump to newest');
  assert.equal(indicatorLabel({ following: false, missed: 1 }), 'Show 1 new activity');
  assert.equal(indicatorLabel({ following: false, missed: 12 }), 'Show 12 new activities');
  assert.equal(indicatorLabel({ following: false, missed: 100 }), 'Show 99+ new activities');
});
