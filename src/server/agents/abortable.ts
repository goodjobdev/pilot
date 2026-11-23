/**
 * A wait that observes cancellation.
 *
 * It resolves after `ms`, or rejects with the signal's own reason when the signal aborts.
 * The timer and the abort listener are removed on either path, so an aborted wait holds no
 * handle and the caller settles promptly. A non-positive or non-finite duration is no wait:
 * an already-aborted signal still rejects.
 */
export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(signal?.reason ?? new Error('aborted'));
    };
    timer = setTimeout(() => { finish(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
