/**
 * The operator-configured Faux acceptance delay and restricted `record_note` test seams.
 *
 * These values open deterministic cancellation windows in tests: `beforeWriteMs` holds the call
 * before the append and `afterWriteMs` holds it after the append, before the harness settles. They
 * are never reachable from a model, a provider, a tool argument or an HTTP request. The environment
 * form additionally needs `DASHBOARD_AGENT_TEST_SEAMS=on`, so an ordinary deployment cannot enable
 * it with one variable.
 *
 * The note seam validator is used by startup and `createApp`. The Faux acceptance setting is a
 * supported operator setting and is validated by the same startup and app paths.
 */
export const NOTE_DELAY_MAX_MS = 60000;
export const ACCEPTANCE_FAUX_WORKER_DELAY_MAX_MS = 15000;

/** Choose the pre-submit delay. The programmatic worker seam takes precedence. */
export function selectWorkerPreSubmitDelay(model: { provider: string; modelId: string }, workerOpenDelayMs: number | undefined, acceptanceDelayMs: number | undefined): number {
  return workerOpenDelayMs ?? (model.provider === 'faux' && model.modelId === 'faux-1' ? acceptanceDelayMs ?? 0 : 0);
}
/** Parse the operator-configured acceptance setting. Unset means zero; empty is invalid. */
export function acceptanceFauxWorkerDelayFromEnvironment(env: NodeJS.ProcessEnv): number {
  const raw = env.DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS;
  if (raw === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(raw))
    throw new Error('DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS must be an integer from 0 to ' + ACCEPTANCE_FAUX_WORKER_DELAY_MAX_MS + ' milliseconds');
  const parsed = Number(raw);
  if (String(parsed) !== raw || !Number.isSafeInteger(parsed) || parsed > ACCEPTANCE_FAUX_WORKER_DELAY_MAX_MS)
    throw new Error('DASHBOARD_ACCEPTANCE_FAUX_WORKER_DELAY_MS must be an integer from 0 to ' + ACCEPTANCE_FAUX_WORKER_DELAY_MAX_MS + ' milliseconds');
  return parsed;
}

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
      ? noteDelayFromEnvironment(env, 'DASHBOARD_AGENT_NOTE_AFTER_WRITE_MS')
      : noteDelayMs(options.recordNoteAfterWriteMs, 'recordNoteAfterWriteMs')
  });
}
