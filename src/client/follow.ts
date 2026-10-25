/**
 * Follow-scroll rules for the agent transcript.
 *
 * The transcript follows new activity only while the reader is at or near its bottom. A reader who
 * has scrolled up keeps their place, and the entries that arrive meanwhile become a bounded count in
 * a "new activity" control. Every function here is pure: it takes what the scroller measured and the
 * state it held, and returns the next state. No DOM is read and no timer runs, so the rules are
 * testable without a browser and there is no age-, clock- or activity-progress estimate anywhere.
 *
 * The state belongs to exactly one project and session. The caller resets it on a switch and ignores
 * a callback that was queued for a previous identity, which is what keeps a previous session's count
 * from appearing in the next one.
 */

/** How close to the bottom still counts as "at the bottom", in CSS pixels. */
export const NEAR_BOTTOM_PX = 8;

/** The largest exact new activity the control reports. Above it the label says "99+". */
export const NEW_ACTIVITY_CAP = 99;

/** What the scroller itself reports. */
export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** Whether new activity is followed, and how many entries arrived while it was not. */
export interface FollowState {
  following: boolean;
  missed: number;
}

/**
 * The identity a follow state belongs to, built from both parts so two different project/session
 * pairs can never produce the same string (`a:b` with `c` and `a` with `b:c` are distinct).
 */
export function followIdentity(projectId: string, session: string): string {
  return projectId + '\u0000' + session;
}

/** The state a newly opened transcript starts from: follow, nothing counted. */
export function initialFollow(): FollowState {
  return { following: true, missed: 0 };
}

/**
 * Pixels between the reader's position and the bottom. A measurement that is not finite is treated
 * as far away, so a missing layout reading can never scroll the reader to the bottom by accident.
 */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  const { scrollTop, clientHeight, scrollHeight } = metrics;
  if (!Number.isFinite(scrollTop) || !Number.isFinite(clientHeight) || !Number.isFinite(scrollHeight)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

/** Whether the reader is at or near the bottom, within `threshold` pixels. */
export function isNearBottom(metrics: ScrollMetrics, threshold: number = NEAR_BOTTOM_PX): boolean {
  return distanceFromBottom(metrics) <= threshold;
}

/**
 * Whether a live measurement says the reader is still following.
 *
 * `lastFollowScrollTop` is the position this page last put the transcript at. Content that grows
 * below the reader leaves that position unchanged, so a following reader is still following even
 * when the distance to the new bottom is large. A reader who moved up changed the position itself,
 * which is the one signal that does not depend on a scroll event having been delivered yet. With no
 * recorded position there is nothing to compare, so the held state is trusted.
 */
export function readerStillFollowing(
  metrics: ScrollMetrics,
  lastFollowScrollTop: number | null,
  threshold: number = NEAR_BOTTOM_PX
): boolean {
  if (isNearBottom(metrics, threshold)) return true;
  if (lastFollowScrollTop === null || !Number.isFinite(lastFollowScrollTop)) return true;
  if (!Number.isFinite(metrics.scrollTop)) return true;
  return metrics.scrollTop >= lastFollowScrollTop - threshold;
}

/**
 * The state after the reader moved the transcript themselves.
 *
 * Reaching the bottom resumes following and clears the count, because there is nothing below the
 * reader left to announce. Leaving the bottom begins a pause with a new, empty count: only what
 * arrives from then on is new activity. A pause that stays paused keeps its count.
 */
export function readerScrolled(
  state: FollowState,
  metrics: ScrollMetrics,
  threshold: number = NEAR_BOTTOM_PX
): FollowState {
  if (isNearBottom(metrics, threshold)) {
    return state.following && state.missed === 0 ? state : initialFollow();
  }
  return state.following ? { following: false, missed: 0 } : state;
}

/**
 * The state after the number of transcript entries changed.
 *
 * While following nothing is counted: those entries are shown and scrolled to. While paused the
 * count grows by exactly the entries that arrived. It is bounded at one above the largest exact
 * number, so 99 is still reported exactly and only a larger count says "99+". A count is not a timer
 * and never decays: it changes only when an entry really arrived or the reader resumed.
 */
export function activityArrived(
  state: FollowState,
  previousCount: number,
  count: number,
  cap: number = NEW_ACTIVITY_CAP
): FollowState {
  if (!Number.isFinite(previousCount) || !Number.isFinite(count)) return state;
  const growth = count - previousCount;
  if (growth <= 0) return state;
  if (state.following) return state;
  const ceiling = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) + 1 : NEW_ACTIVITY_CAP + 1;
  const missed = Math.min(ceiling, state.missed + growth);
  return missed === state.missed ? state : { following: false, missed };
}

/**
 * The state after a frame added entries, judged by the scroller's live position.
 *
 * A reader whose move has not been handled as a scroll event yet must not be dragged to the bottom
 * by the frame that arrives in the meantime: the live position, not only the held state, decides.
 */
export function arrivalAfterFrame(
  state: FollowState,
  previousCount: number,
  count: number,
  live: ScrollMetrics,
  lastFollowScrollTop: number | null,
  threshold: number = NEAR_BOTTOM_PX
): FollowState {
  let current = state;
  if (current.following && !readerStillFollowing(live, lastFollowScrollTop, threshold)) {
    current = readerScrolled(current, live, threshold);
  }
  return activityArrived(current, previousCount, count);
}

/** The bounded count as a short label, or an empty string when nothing is counted. */
export function countLabel(missed: number, cap: number = NEW_ACTIVITY_CAP): string {
  const count = Number.isFinite(missed) ? Math.max(0, Math.floor(missed)) : 0;
  if (count === 0) return '';
  if (count > cap) return cap + '+ new activities';
  return count === 1 ? '1 new activity' : count + ' new activities';
}

/** The control's short visible text and its accessible name: what tapping it will do. */
export function indicatorLabel(state: FollowState, cap: number = NEW_ACTIVITY_CAP): string {
  const label = countLabel(state.missed, cap);
  if (label === '') return 'Jump to newest';
  return 'Show ' + label;
}
