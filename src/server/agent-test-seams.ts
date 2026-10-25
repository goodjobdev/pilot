/**
 * The test-only `record_note` delay seams.
 *
 * These values open deterministic cancellation windows in tests. They are never reachable from a
 * model, a provider, a tool argument or an HTTP request. The environment form additionally needs
 * `DASHBOARD_AGENT_TEST_SEAMS=on`, so an ordinary deployment cannot enable it with one variable.
 *
 * The same validator is used by the entrypoint before it creates the data root and by `createApp`,
 * so a bad value fails closed on startup and a direct caller cannot bypass the bound.
 */
export const NOTE_DELAY_MAX_MS = 60000;

/** One delay value: a whole number from 0 to 60000 milliseconds. */
export function noteDelayMs(value: unknown, name: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > NOTE_DELAY_MAX_MS)
    throw new Error(name + ' must be a whole number from 0 to ' + NOTE_DELAY_MAX_MS + ' milliseconds');
  return parsed;
}

/** The delay named by one environment variable, with the explicit test-seam switch. */
export function noteDelayFromEnvironment(env: NodeJS.ProcessEnv, name: string): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return 0;
  if (env.DASHBOARD_AGENT_TEST_SEAMS !== 'on')
    throw new Error(name + ' is a test-only seam; set DASHBOARD_AGENT_TEST_SEAMS=on to use it');
  return noteDelayMs(raw, name);
}

/** Both resolved seams: host options win, otherwise the environment, otherwise zero. */
export function resolveNoteDelaySeams(
  options: { readonly recordNoteDelayMs?: unknown; readonly recordNoteAfterWriteMs?: unknown },
  env: NodeJS.ProcessEnv
): { readonly recordNoteDelayMs: number; readonly recordNoteAfterWriteMs: number } {
  return Object.freeze({
    recordNoteDelayMs: options.recordNoteDelayMs === undefined
      ? noteDelayFromEnvironment(env, 'DASHBOARD_AGENT_NOTE_DELAY_MS')
      : noteDelayMs(options.recordNoteDelayMs, 'recordNoteDelayMs'),
    recordNoteAfterWriteMs: options.recordNoteAfterWriteMs === undefined
      ? 0
      : noteDelayMs(options.recordNoteAfterWriteMs, 'recordNoteAfterWriteMs')
  });
}
