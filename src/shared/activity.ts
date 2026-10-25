import type { AgentEntry } from './agent';
import {
  LIVE_TOOL_TIMING_REASONS,
  type LiveToolCertainty,
  type LiveToolInvocation,
  type LiveToolOutcome,
  type LiveToolProtocol,
  type LiveToolResult
} from './actions';

/**
 * The measured tool activity of one conversation, derived from what the transcript really records.
 *
 * The honesty rules:
 *
 * - A call and a result stay in two lists. The transcript view this build maps carries no reliable
 *   call identity, so no result is attributed to a call and no call is given a result.
 * - An instant is the entry's recorded timestamp, or null with a named reason. Nothing is guessed.
 * - A duration is the harness's own `durationMs` on the result message, or null with a named reason.
 *   Two recorded instants are never subtracted: a recovered transcript can mix instants from more
 *   than one process, and clock skew could make such a subtraction negative.
 * - An outcome comes only from the protocol: the harness's own error flag and the diagnostic codes
 *   it writes. `interrupted` is uncertain by construction. `aborted` is a cancellation whose effect
 *   is not proven, so it is also uncertain: the harness emits it after a non-restart abort even in
 *   the execute phase. Only `abandoned` is a phase-proven cancellation with no execution, so only it
 *   is certain. Diagnostic messages, tool arguments and tool output are never read into the payload.
 */

const MAX_TOOL_NAME_LENGTH = 60;
const MAX_REPORTED_EVENTS = 100_000;

type ToolFacts = {
  errors: number;
  warnings: number;
  notices: number;
  isError: boolean | null;
  interrupted: boolean;
  aborted: boolean;
  abandoned: boolean;
  blocked: boolean;
  unavailable: boolean;
  invalidArguments: boolean;
};

function factsOf(entry: AgentEntry): ToolFacts {
  let errors = 0, warnings = 0, notices = 0;
  let interrupted = false, aborted = false, abandoned = false;
  let blocked = false, unavailable = false, invalidArguments = false;
  const diagnostics = entry.data === null ? null : entry.data.diagnostics;
  if (Array.isArray(diagnostics)) {
    for (const diagnostic of diagnostics) {
      if (!diagnostic || typeof diagnostic !== 'object') { notices += 1; continue; }
      const severity = (diagnostic as { severity?: unknown }).severity;
      if (severity === 'error') errors += 1;
      else if (severity === 'warn') warnings += 1;
      else notices += 1;
      const code = (diagnostic as { code?: unknown }).code;
      if (code === 'interrupted') interrupted = true;
      else if (code === 'aborted') aborted = true;
      else if (code === 'abandoned') abandoned = true;
      else if (code === 'blocked') blocked = true;
      else if (code === 'tool_unavailable') unavailable = true;
      else if (code === 'invalid_arguments') invalidArguments = true;
    }
  }
  return {
    errors, warnings, notices,
    isError: entry.toolResult?.isError ?? null,
    interrupted, aborted, abandoned, blocked, unavailable, invalidArguments
  };
}

/**
 * Classify one result from the protocol only.
 *
 * `interrupted` wins over every other signal: the harness writes it when a restart ended a call that
 * may have partially run, so it must never read as a failure or a success. `aborted` is a cancellation
 * the owner knows about, but its effect is not proven, so its certainty is `uncertain`. `abandoned` is
 * the one phase-proven case: the call was not started because its caller ended with a restart, so it
 * is certain. Otherwise the error flag and the diagnostic severities decide.
 */
function classify(facts: ToolFacts): { outcome: LiveToolOutcome; certainty: LiveToolCertainty; protocol: LiveToolProtocol } {
  if (facts.interrupted) return { outcome: 'interrupted', certainty: 'uncertain', protocol: 'interrupted' };
  if (facts.aborted) return { outcome: 'cancelled', certainty: 'uncertain', protocol: 'aborted' };
  if (facts.abandoned) return { outcome: 'cancelled', certainty: 'certain', protocol: 'abandoned' };
  const protocol: LiveToolProtocol = facts.blocked ? 'blocked'
    : facts.unavailable ? 'tool-unavailable'
      : facts.invalidArguments ? 'invalid-arguments'
        : facts.errors > 0 || facts.isError === true ? 'error'
          : facts.isError === false ? 'completed' : 'unknown';
  const outcome: LiveToolOutcome = facts.errors > 0 || facts.isError === true ? 'failed' : facts.warnings > 0 ? 'warned' : 'ok';
  // With no flag and no protocol code, a clean result is the transcript's only signal, not proof: the
  // outcome is reported but its certainty is named as uncertain rather than invented as fact.
  const certainty: LiveToolCertainty = outcome === 'ok' && facts.isError === null && protocol === 'unknown' ? 'uncertain' : 'certain';
  return { outcome, certainty, protocol };
}

/**
 * The owner-visible label for one result's outcome. Shared by both surfaces, so the palette and the
 * timeline cannot describe the same result differently. A warned result completed with warnings; the
 * label says so rather than letting the short word read as a failure. An uncertain cancellation keeps
 * its protocol name, so an abort never implies a safe replay.
 */
export function toolOutcomeLabel(result: Pick<LiveToolResult, 'outcome' | 'certainty' | 'protocol'>): string {
  const base = result.outcome + (result.certainty === 'uncertain' ? ' (uncertain)' : '');
  if (result.outcome === 'warned') return base + ' · completed (not failed)';
  if (result.protocol === 'completed' || result.protocol === result.outcome) return base;
  return base + ' · ' + result.protocol;
}

function truncateName(name: string | null): string | null {
  if (name === null || name === '') return null;
  return name.slice(0, MAX_TOOL_NAME_LENGTH);
}

function instantOf(entry: AgentEntry): number | null {
  return typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at >= 0 ? entry.at : null;
}

/**
 * Read the bounded tool activity of one conversation.
 *
 * The newest `cap` calls and the newest `cap` results are kept, and `omitted` says exactly how many
 * older events each list withheld. A cap of 0 keeps no event at all. A negative, fractional or
 * non-numeric cap is a programming error: the projection normalizes its own caps before it calls
 * this function, so this one refuses an invalid count instead of silently substituting another.
 */
export function toolEvents(entries: readonly AgentEntry[], cap: number): {
  invocations: LiveToolInvocation[];
  results: LiveToolResult[];
  truncated: boolean;
  omitted: { invocations: number; results: number };
} {
  if (!Number.isInteger(cap) || cap < 0) throw new RangeError('The toolEvents cap must be a non-negative integer');
  const bound = Math.min(cap, MAX_REPORTED_EVENTS);
  const invocations: LiveToolInvocation[] = [], results: LiveToolResult[] = [];
  for (const entry of entries) {
    const at = instantOf(entry);
    const atReason = at === null ? LIVE_TOOL_TIMING_REASONS.noInstant : null;
    for (const tool of entry.tools ?? []) {
      if (typeof tool.name === 'string' && tool.name !== '') {
        invocations.push(Object.freeze({ name: truncateName(tool.name) as string, at, atReason }));
      }
    }
    if (entry.rawKind !== 'pi.tool-result') continue;
    const facts = factsOf(entry);
    const classified = classify(facts);
    const measured = entry.toolResult?.durationMs ?? null;
    // A duration is only a measurement when it is a finite, non-negative count of milliseconds.
    const durationMs = typeof measured === 'number' && Number.isFinite(measured) && measured >= 0 ? measured : null;
    results.push(Object.freeze({
      name: truncateName(entry.toolResult?.name ?? null),
      outcome: classified.outcome,
      certainty: classified.certainty,
      protocol: classified.protocol,
      errors: facts.errors,
      warnings: facts.warnings,
      notices: facts.notices,
      at,
      atReason,
      durationMs,
      durationReason: durationMs === null ? LIVE_TOOL_TIMING_REASONS.noDuration : null
    }));
  }
  const omitted = {
    invocations: Math.max(0, invocations.length - bound),
    results: Math.max(0, results.length - bound)
  };
  // `slice(-0)` is `slice(0)`, which would return the whole list. A zero bound is therefore an
  // explicit empty result, not a special case that the array method can silently defeat.
  return {
    invocations: bound === 0 ? [] : invocations.slice(-bound),
    results: bound === 0 ? [] : results.slice(-bound),
    truncated: omitted.invocations > 0 || omitted.results > 0,
    omitted
  };
}
