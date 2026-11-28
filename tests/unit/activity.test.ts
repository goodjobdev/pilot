import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolEvents, toolOutcomeLabel } from '../../src/shared/activity';
import { LIVE_TOOL_TIMING_REASONS } from '../../src/shared/actions';
import type { AgentEntry, AgentToolResultMeta } from '../../src/shared/agent';

/**
 * The measured activity projection, tested on its own: every outcome, instant and duration comes from
 * what the transcript records, and nothing is paired, subtracted, inferred or leaked.
 *
 * The entries are synthetic and disposable; no harness, provider or project is opened.
 */
function entry({ rawKind, ...overrides }: Partial<AgentEntry> & { rawKind: string }): AgentEntry {
  return {
    id: 'entry', kind: 'other', at: null, text: '', thinking: '', tools: [],
    stopReason: null, error: null, data: null, toolResult: null,
    ...overrides, rawKind
  };
}
function result(overrides: { at: number | null; meta?: Partial<AgentToolResultMeta> | null; diagnostics?: unknown[] }): AgentEntry {
  const meta: AgentToolResultMeta | null = overrides.meta === null ? null : {
    name: 'record_note', isError: false, durationMs: null, ...(overrides.meta ?? {})
  };
  return entry({ rawKind: 'pi.tool-result', kind: 'tool', at: overrides.at, ...(meta === null ? {} : { toolResult: meta }), data: overrides.diagnostics === undefined ? null : { diagnostics: overrides.diagnostics } });
}

test('a failed tool reports its recorded instants and the duration the harness measured', () => {
  const call = entry({ rawKind: 'pi.assistant', kind: 'assistant', at: 1700000000000, tools: [{ name: 'record_note', args: '{"text":"/Users/private/plan.md"}' }] });
  const failed = result({ at: 1700000000012, meta: { isError: true, durationMs: 12 }, diagnostics: [{ severity: 'error', code: 'blocked', message: 'a private path /Users/private/plan.md' }] });
  const events = toolEvents([call, failed], 50);
  assert.deepEqual(events.invocations, [{ name: 'record_note', at: 1700000000000, atReason: null }]);
  assert.deepEqual(events.results, [{
    name: 'record_note', outcome: 'failed', certainty: 'certain', protocol: 'blocked',
    errors: 1, warnings: 0, notices: 0,
    at: 1700000000012, atReason: null, durationMs: 12, durationReason: null
  }]);
  // The call is never given the result. The arguments, the diagnostic message and every path stay out.
  const serialised = JSON.stringify(events);
  assert.ok(!serialised.includes('/Users/private'), 'no path is carried');
  assert.ok(!serialised.includes('private path'), 'no diagnostic message is carried');
  assert.ok(!serialised.includes('"args"'), 'no tool argument is carried');
});

test('interruption and abort are uncertain; only an abandoned call is proven not to have run', () => {
  const interrupted = toolEvents([result({ at: 10, meta: { isError: true, durationMs: null }, diagnostics: [{ severity: 'error', code: 'interrupted', message: 'Tool record_note was interrupted and may have partially run' }] })], 50).results[0];
  assert.deepEqual([interrupted.outcome, interrupted.certainty, interrupted.protocol], ['interrupted', 'uncertain', 'interrupted']);
  assert.deepEqual([interrupted.durationMs, interrupted.durationReason], [null, LIVE_TOOL_TIMING_REASONS.noDuration]);

  const aborted = toolEvents([result({ at: 11, meta: { isError: true }, diagnostics: [{ severity: 'error', code: 'aborted', message: 'Tool record_note was aborted' }] })], 50).results[0];
  // The harness emits `aborted` after a non-restart abort even in the execute phase, so the effect is
  // unknown. The outcome stays `cancelled`, but its certainty must not imply a safe replay.
  assert.deepEqual([aborted.outcome, aborted.certainty, aborted.protocol], ['cancelled', 'uncertain', 'aborted']);

  const abandoned = toolEvents([result({ at: 12, meta: { isError: true }, diagnostics: [{ severity: 'error', code: 'abandoned', message: 'Tool record_note was not started' }] })], 50).results[0];
  // `abandoned` is the phase-proven case: the call was not started because its caller ended with a
  // restart, so its cancellation is certain.
  assert.deepEqual([abandoned.outcome, abandoned.certainty, abandoned.protocol], ['cancelled', 'certain', 'abandoned']);
});

test('the outcome label never makes a warning look like a failure or an abort look safe to replay', () => {
  assert.equal(toolOutcomeLabel({ outcome: 'warned', certainty: 'certain', protocol: 'completed' }), 'warned · completed (not failed)');
  assert.equal(toolOutcomeLabel({ outcome: 'cancelled', certainty: 'uncertain', protocol: 'aborted' }), 'cancelled (uncertain) · aborted');
  assert.equal(toolOutcomeLabel({ outcome: 'cancelled', certainty: 'certain', protocol: 'abandoned' }), 'cancelled · abandoned');
  assert.equal(toolOutcomeLabel({ outcome: 'interrupted', certainty: 'uncertain', protocol: 'interrupted' }), 'interrupted (uncertain)');
  assert.equal(toolOutcomeLabel({ outcome: 'ok', certainty: 'certain', protocol: 'completed' }), 'ok');
  assert.equal(toolOutcomeLabel({ outcome: 'failed', certainty: 'certain', protocol: 'error' }), 'failed · error');
});

test('ok, warned and unclassifiable results are told apart from the protocol alone', () => {
  const ok = toolEvents([result({ at: 20, meta: { isError: false, durationMs: 0 } })], 50).results[0];
  assert.deepEqual([ok.outcome, ok.certainty, ok.protocol, ok.durationMs], ['ok', 'certain', 'completed', 0]);

  const warned = toolEvents([result({ at: 21, meta: { isError: false }, diagnostics: [{ severity: 'warn', code: 'truncated', message: 'bounded' }] })], 50).results[0];
  assert.deepEqual([warned.outcome, warned.certainty, warned.protocol, warned.warnings], ['warned', 'certain', 'completed', 1]);

  const unknown = toolEvents([result({ at: 22, meta: null })], 50).results[0];
  assert.deepEqual([unknown.outcome, unknown.certainty, unknown.protocol, unknown.name], ['ok', 'uncertain', 'unknown', null]);
});

test('an absent instant or duration is null with its named reason, and a negative duration is refused', () => {
  const missing = result({ at: null, meta: { isError: false, durationMs: null } });
  const events = toolEvents([entry({ rawKind: 'pi.assistant', kind: 'assistant', at: null, tools: [{ name: 'read_notes', args: '{}' }] }), missing], 50);
  assert.deepEqual([events.invocations[0].at, events.invocations[0].atReason], [null, LIVE_TOOL_TIMING_REASONS.noInstant]);
  assert.deepEqual([events.results[0].at, events.results[0].atReason], [null, LIVE_TOOL_TIMING_REASONS.noInstant]);
  assert.deepEqual([events.results[0].durationMs, events.results[0].durationReason], [null, LIVE_TOOL_TIMING_REASONS.noDuration]);

  const negative = toolEvents([result({ at: 30, meta: { isError: false, durationMs: -20 } })], 50).results[0];
  assert.equal(negative.durationMs, null, 'a negative duration is never reported as elapsed time');
});

test('the two lists are bounded independently and the omission counts say exactly what was withheld', () => {
  const calls = [1, 2, 3].map((n) => entry({ id: 'call-' + n, rawKind: 'pi.assistant', kind: 'assistant', at: 100 + n, tools: [{ name: 'tool-' + n, args: '{"secret":"x"}' }] }));
  const results = [1, 2].map((n) => result({ at: 200 + n, meta: { name: 'tool-' + n, isError: false, durationMs: n } }));
  const events = toolEvents([...calls, ...results], 1);
  assert.deepEqual(events.invocations.map((call) => call.name), ['tool-3'], 'the newest call is kept');
  assert.deepEqual(events.results.map((item) => item.name), ['tool-2'], 'the newest result is kept');
  assert.deepEqual(events.omitted, { invocations: 2, results: 1 });
  assert.equal(events.truncated, true);

  const all = toolEvents([...calls, ...results], 10);
  assert.deepEqual(all.omitted, { invocations: 0, results: 0 });
  assert.equal(all.truncated, false);
  assert.equal(all.invocations.length, 3);
  assert.equal(all.results.length, 2);

  // A zero bound is a real empty list, not `slice(-0)`, which would return everything.
  const none = toolEvents([...calls, ...results], 0);
  assert.deepEqual(none.invocations, []);
  assert.deepEqual(none.results, []);
  assert.deepEqual(none.omitted, { invocations: 3, results: 2 });
  assert.equal(none.truncated, true);
  // The helper refuses an invalid count instead of silently using a different bound. The projection
  // normalizes its caps first, so this is a programming error rather than a user refusal.
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => toolEvents([...calls], bad), RangeError);
});
