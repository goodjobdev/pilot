/**
 * Bounded constants and pure decisions for the agent event stream.
 *
 * The server and the browser share these values so a frame the server refuses to send is
 * the same size the browser refuses to buffer, and so the reconnect schedule is testable
 * without a clock or a socket.
 */

/** The server's keep-alive comment interval. A comment is transport evidence, not progress. */
export const STREAM_HEARTBEAT_MS = 20_000;
/** Three heartbeat intervals would already be missed; 2 plus margin is the stale boundary. */
export const STREAM_STALE_AFTER_MS = STREAM_HEARTBEAT_MS * 2 + 5_000;
/** One complete `data:` frame, including its JSON snapshot, may not exceed this many UTF-8 bytes. */
export const MAX_STREAM_FRAME_BYTES = 4 * 1024 * 1024;
/** A reconnect starts no sooner than this and never waits longer than the cap below. */
export const STREAM_MIN_RETRY_MS = 1_000;
export const STREAM_MAX_RETRY_MS = 30_000;
/** Automatic attempts after a failed attempt, before the client waits for an owner reconnect. */
export const STREAM_MAX_ATTEMPTS = 6;
/**
 * A connection must stay transport-fresh for this long after its first snapshot before a
 * later drop resets the retry budget. A snapshot that is followed immediately by a drop must
 * not reset it, or a broken proxy could loop forever without ever reaching `offline`.
 */
export const STREAM_STABLE_RESET_MS = 10_000;
/** How long a refusal body may take to explain itself before the status alone is used. */
export const STREAM_REFUSAL_TIMEOUT_MS = 750;

/** A server `retry:` hint is advisory, so it is clamped rather than trusted. */
export function clampRetryHint(value: number | undefined, minimum = STREAM_MIN_RETRY_MS, maximum = STREAM_MAX_RETRY_MS): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

/**
 * Bounded exponential backoff. The only random input is the fraction added on top of the
 * scheduled pause, so a test can pass `() => 0` and get the exact lower bound.
 */
export function nextBackoff(
  attempt: number,
  hint: number | undefined,
  random: () => number,
  minimum = STREAM_MIN_RETRY_MS,
  maximum = STREAM_MAX_RETRY_MS
): number {
  const base = clampRetryHint(hint, minimum, maximum);
  const growth = Math.min(maximum, base * 2 ** Math.max(0, Math.floor(attempt) - 1));
  const sample = random();
  // A caller that injects a clock or a random source must not be able to make the pause NaN.
  const fraction = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  const jitter = Math.floor(growth * 0.2 * fraction);
  return Math.min(maximum, growth + jitter);
}

/** Transport freshness. Only a received frame (including a keep-alive comment) refreshes it. */
export function transportIsStale(lastFrameAt: number | null, now: number, staleAfterMs = STREAM_STALE_AFTER_MS): boolean {
  return lastFrameAt !== null && now - lastFrameAt > staleAfterMs;
}
