import { z } from 'zod';
import { canonicalJson } from './control-state';

/**
 * The acceptance model: what a unit of work *proved*, on which revision, and who may accept it.
 *
 * This module is pure — no Node built-ins and no framework. It defines the closed sets, the strict
 * fail-closed validation of every record, the honesty rules the evidence is checked by, and the one
 * renderer that turns a completion record into the Markdown file written next to the work. The
 * durable storage and the Markdown write live in `src/server/state/acceptance-store.ts`; minting an
 * identity, reading the clock and writing files are the caller's job, so validation stays
 * deterministic and testable.
 *
 * Nothing here performs a commit, push, deploy, spend, provision or publish. An acceptance records
 * a decision about an artifact; performing anything with it stays a separate, explicit step.
 */

export const ACCEPTANCE_RECORD_VERSION = 1 as const;

/* --------------------------------------------------------------------------------------------- *
 * The policy: who may accept, and which action classes may be decided without asking the owner.
 * --------------------------------------------------------------------------------------------- */

/** The closed mode set. An unknown mode fails closed rather than being interpreted. */
export const ACCEPTANCE_MODES = ['owner-only', 'agent-may-accept'] as const;
export type AcceptanceMode = (typeof ACCEPTANCE_MODES)[number];

/**
 * The closed set of action classes an acceptance can be about. It is the same vocabulary the
 * approval kinds use, so one consequential action has one name in this build rather than two.
 */
export const ACCEPTANCE_ACTION_CLASSES = ['commit', 'push', 'deploy', 'spend', 'provision', 'publish'] as const;
export type AcceptanceActionClass = (typeof ACCEPTANCE_ACTION_CLASSES)[number];

/** `ask` requires an owner decision; `full-auto` lets an accepting agent decide the class itself. */
export const ACCEPTANCE_CLASS_DECISIONS = ['ask', 'full-auto'] as const;
export type AcceptanceClassDecision = (typeof ACCEPTANCE_CLASS_DECISIONS)[number];

/** Who or what is acting: the owner, or a named agent. The kind is closed; the identity is not. */
export const ACCEPTANCE_ACTOR_KINDS = ['owner', 'agent'] as const;
export type AcceptanceActorKind = (typeof ACCEPTANCE_ACTOR_KINDS)[number];
export type AcceptanceActor = { readonly kind: AcceptanceActorKind; readonly identity: string };

/** The immutable policy as it is stored durably: a mode and one decision per action class. */
export type AcceptancePolicyDefinition = {
  readonly version: 1;
  readonly mode: AcceptanceMode;
  readonly actionClasses: Readonly<Record<AcceptanceActionClass, AcceptanceClassDecision>>;
};

/**
 * What a reader sees. `recorded` is false exactly when the durable store holds no policy row: the
 * documented default is then in force and is reported as the default, never as a stored fact — with
 * a named absence, so an unconfigured instance is never presented as a configured one.
 */
export type AcceptancePolicy = AcceptancePolicyDefinition & {
  readonly revision: number;
  readonly recorded: boolean;
  readonly absenceReason: string | null;
  readonly absenceDetail: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
};

/** The named absence of a policy row, and the fixed sentence that goes with it. */
export const ACCEPTANCE_POLICY_ABSENCE = Object.freeze({ notRecorded: 'no-policy-recorded-yet' });
export const ACCEPTANCE_POLICY_ABSENCE_DETAIL =
  'The durable store holds no acceptance policy yet, so the documented default is in force: owner-only, with every action class asking the owner.';

/**
 * The documented default: owner-only and every class asking. It is the safe direction, so an
 * instance that has never been configured cannot let an agent accept anything.
 */
export function defaultAcceptancePolicy(): AcceptancePolicyDefinition {
  return Object.freeze({
    version: ACCEPTANCE_RECORD_VERSION,
    mode: 'owner-only' as const,
    actionClasses: freezeClasses(
      Object.fromEntries(ACCEPTANCE_ACTION_CLASSES.map((name) => [name, 'ask' as const])) as Record<AcceptanceActionClass, AcceptanceClassDecision>
    )
  }) as AcceptancePolicyDefinition;
}
function freezeClasses(value: Record<AcceptanceActionClass, AcceptanceClassDecision>): Readonly<Record<AcceptanceActionClass, AcceptanceClassDecision>> {
  return Object.freeze(value);
}

/* --------------------------------------------------------------------------------------------- *
 * The completion record: the evidence a unit of work produced.
 * --------------------------------------------------------------------------------------------- */

/** Documented bounds. Every one of them is enforced, and none of them is silently rounded. */
export const ACCEPTANCE_MAX_EVIDENCE_ITEMS = 20;
export const ACCEPTANCE_MAX_COMMANDS = 50;
export const ACCEPTANCE_MAX_COMMAND_LENGTH = 500;
export const ACCEPTANCE_MAX_OUTPUT_BYTES = 8192;
export const ACCEPTANCE_MAX_INLINE_DIFF_BYTES = 16384;
export const ACCEPTANCE_MAX_TEXT_LENGTH = 2000;
/** The read cap on how many completion records one project's view reports. */
export const ACCEPTANCE_MAX_EVIDENCE_READ = 200;

/** The named absences a completion record may carry where a count could not be read. */
export const ACCEPTANCE_ABSENCE_REASONS = Object.freeze({
  outputNotRecorded: 'command-output-not-recorded',
  outputCarriesNoCounts: 'command-output-carries-no-count-lines',
  commandNotRun: 'command-not-run'
});
export const ACCEPTANCE_ABSENCE_DETAILS = Object.freeze({
  outputNotRecorded: 'No output was recorded for this command, so its pass and fail counts are reported as an absence rather than assumed good.',
  outputCarriesNoCounts: 'The recorded output carries no count line, so its pass and fail counts are reported as an absence rather than assumed good.',
  commandNotRun: 'The record says this command was not run, so no result is asserted for it and its counts are reported as an absence rather than read from output that is not this record\'s result.'
});
/** The two line markers this build reads counts from, and the count names it understands. */
export const ACCEPTANCE_COUNT_LINE = /^[ \t]*(?:#|\u2139)[ \t]*(tests|pass|fail|failures|skip|skipped)[ \t]+([0-9]+)[ \t]*$/u;
export type AcceptanceCounts = { readonly passed: number; readonly failed: number; readonly skipped: number };

/** The outcome of one recorded command. `not-run` is a legal answer and asserts no result. */
export const ACCEPTANCE_OUTCOMES = ['passed', 'failed', 'not-run'] as const;
export type AcceptanceOutcome = (typeof ACCEPTANCE_OUTCOMES)[number];

/** What a caller claims about one command. A claim is checked against the recorded output. */
export type TestEvidenceClaim = {
  readonly command: string;
  readonly outcome: AcceptanceOutcome;
  /** The output the command really printed (the tail, within the documented bound), or null. */
  readonly output: string | null;
  /** Counts the caller believes it read. They are checked, never trusted: the record stores what the output carries. */
  readonly counts: AcceptanceCounts | null;
};
/** What the record stores about one command: the output, the counts read from it, or a named absence. */
export type TestEvidence = {
  readonly command: string;
  readonly outcome: AcceptanceOutcome;
  readonly output: string | null;
  readonly counts: AcceptanceCounts | null;
  readonly absenceReason: string | null;
};

/** The diff summary, and the full diff either inlined inside the bound or referenced. */
export type DiffClaim = {
  readonly files: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly text: string | null;
  readonly reference: string | null;
};
export type DiffSummary = DiffClaim;

export const ACCEPTANCE_REVIEW_VERDICTS = ['approved', 'changes-requested', 'blocked'] as const;
export type AcceptanceReviewVerdict = (typeof ACCEPTANCE_REVIEW_VERDICTS)[number];
export type AcceptanceReview = {
  readonly verdict: AcceptanceReviewVerdict;
  readonly reviewer: AcceptanceActor;
  readonly at: string;
  readonly note: string | null;
};

/** Whether the work is a bounded coding job or a named session. */
export const ACCEPTANCE_SUBJECT_KINDS = ['job', 'session'] as const;
export type AcceptanceSubjectKind = (typeof ACCEPTANCE_SUBJECT_KINDS)[number];
export type AcceptanceSubject = { readonly kind: AcceptanceSubjectKind; readonly id: string };

/** The exact artifact identity a record was produced from. */
export type ArtifactIdentity = { readonly revision: string; readonly commit: string | null };

/** What a caller submits as evidence. The identity, the project and the absence reasons are the store's. */
export type CompletionRecordRequest = {
  readonly sessionId: string | null;
  readonly subject: AcceptanceSubject;
  readonly artifact: ArtifactIdentity;
  readonly commands: readonly string[];
  readonly diff: DiffClaim;
  readonly tests: readonly TestEvidenceClaim[];
  readonly review: AcceptanceReview | null;
  readonly producedAt: string;
};
/** The frozen record as it is stored and read back. */
export type CompletionRecord = {
  readonly version: 1;
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly subject: AcceptanceSubject;
  readonly artifact: ArtifactIdentity;
  readonly commands: readonly string[];
  readonly diff: DiffSummary;
  readonly tests: readonly TestEvidence[];
  readonly review: AcceptanceReview | null;
  readonly producedAt: string;
  readonly frozen: true;
};

/* --------------------------------------------------------------------------------------------- *
 * The acceptance: a durable, single-use, revision-bound decision.
 * --------------------------------------------------------------------------------------------- */

export type AcceptanceRequest = {
  readonly evidenceId: string;
  readonly artifact: ArtifactIdentity;
  readonly actionClass: AcceptanceActionClass;
  readonly actor: AcceptanceActor;
};
export type AcceptanceRecord = {
  readonly version: 1;
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly subject: AcceptanceSubject;
  readonly evidenceId: string;
  readonly artifact: ArtifactIdentity;
  readonly actionClass: AcceptanceActionClass;
  readonly acceptedBy: {
    readonly kind: AcceptanceActorKind;
    readonly identity: string;
    /** The policy rule that permitted an agent's acceptance; null when the owner accepted. */
    readonly policyRule: string | null;
  };
  readonly policy: {
    readonly revision: number;
    readonly recorded: boolean;
    readonly mode: AcceptanceMode;
    readonly classDecision: AcceptanceClassDecision;
  };
  readonly acceptedAt: string;
  readonly singleUse: true;
};

/** The rule an agent acceptance is recorded under, so the record says *why* it was allowed. */
export function agentPolicyRule(actionClass: AcceptanceActionClass): string {
  return 'agent-may-accept:' + actionClass + '=full-auto';
}

/** Failed-closed reasons. Each refusal carries one of these codes and a precise, path-free message. */
export type AcceptanceErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ALREADY_ACCEPTED'
  | 'ARTIFACT_CHANGED'
  | 'NOT_PERMITTED'
  | 'STORAGE'
  | 'CORRUPT';
export class AcceptanceError extends Error {
  constructor(message: string, public readonly code: AcceptanceErrorCode) {
    super(message);
    this.name = 'AcceptanceError';
  }
}

/* --------------------------------------------------------------------------------------------- *
 * Strict parsing, in this module's own words.
 * --------------------------------------------------------------------------------------------- */

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
/**
 * An actor identity is a bounded identifier that may also be an owner's e-mail address, because the
 * hosted owner identity is exactly that. It is recorded verbatim, so it is still bounded and
 * printable and can never be a path.
 */
export const ACCEPTANCE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const actorIdentity = z.string().min(1).max(160).regex(ACCEPTANCE_IDENTITY_PATTERN);
const revisionIdentity = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const commitSha = z.string().regex(/^[a-f0-9]{40}$/);
const isoInstant = z.string().datetime();
/** A reference names where the full diff lives: contained, no whitespace, no parent segment. */
const referenceText = z.string().min(1).max(300).regex(/^[^\s\u0000-\u001f\u007f]+$/);

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  return (issue.path.length ? issue.path.map(String).join('.') + ': ' : '') + issue.message;
}
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new AcceptanceError(label + ' is invalid: ' + firstIssue(error), 'INVALID');
    throw error;
  }
}
/** A command is one printable line: a control character would break the record it is rendered into. */
const commandText = z.string().min(1).max(ACCEPTANCE_MAX_COMMAND_LENGTH).regex(/^[^\u0000-\u001f\u007f]+$/);

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
function isFuture(text: string, now: Date): boolean {
  return Date.parse(text) > now.getTime();
}

/** One actor: the owner or a named agent. The identity is an identifier so it can be recorded. */
export function parseAcceptanceActor(value: unknown, label = 'actor'): AcceptanceActor {
  const parsed = parseStrict(
    z.strictObject({ kind: z.enum(ACCEPTANCE_ACTOR_KINDS), identity: actorIdentity }),
    value,
    label + ' (requires kind, identity)'
  );
  return Object.freeze({ kind: parsed.kind, identity: parsed.identity }) as AcceptanceActor;
}

/** One decision per action class, and nothing else: a missing class is not defaulted. */
function actionClassesSchema(): z.ZodTypeAny {
  return z.strictObject(
    Object.fromEntries(
      ACCEPTANCE_ACTION_CLASSES.map((name) => [name, z.enum(ACCEPTANCE_CLASS_DECISIONS)])
    ) as unknown as Record<AcceptanceActionClass, z.ZodTypeAny>
  );
}
/** One policy definition from a caller: the closed mode and a decision for every action class. */
export function parseAcceptancePolicy(value: unknown, label = 'policy'): AcceptancePolicyDefinition {
  const parsed = parseStrict(
    z.strictObject({ mode: z.enum(ACCEPTANCE_MODES), actionClasses: actionClassesSchema() }),
    value,
    label + ' (requires mode, actionClasses with ' + ACCEPTANCE_ACTION_CLASSES.join(', ') + ')'
  );
  return Object.freeze({
    version: ACCEPTANCE_RECORD_VERSION,
    mode: parsed.mode,
    actionClasses: freezeClasses(parsed.actionClasses as Record<AcceptanceActionClass, AcceptanceClassDecision>)
  }) as AcceptancePolicyDefinition;
}
/** One policy definition exactly as it is read back from durable storage. */
export function validateStoredAcceptancePolicy(value: unknown): AcceptancePolicyDefinition {
  const parsed = parseStrict(
    z.strictObject({ version: z.literal(ACCEPTANCE_RECORD_VERSION), mode: z.enum(ACCEPTANCE_MODES), actionClasses: actionClassesSchema() }),
    value,
    'stored acceptance policy'
  );
  return Object.freeze({
    version: ACCEPTANCE_RECORD_VERSION,
    mode: parsed.mode,
    actionClasses: freezeClasses(parsed.actionClasses as Record<AcceptanceActionClass, AcceptanceClassDecision>)
  }) as AcceptancePolicyDefinition;
}

/** A policy update: what the caller read, the new policy, and who is changing it. */
export function parseAcceptancePolicyUpdate(value: unknown): { revision: number; policy: AcceptancePolicyDefinition; actor: AcceptanceActor } {
  const parsed = parseStrict(
    z.strictObject({ revision: z.number().int().nonnegative(), policy: z.unknown(), actor: z.unknown() }),
    value,
    'acceptance policy update (requires revision, policy, actor)'
  );
  return Object.freeze({
    revision: parsed.revision,
    policy: parseAcceptancePolicy(parsed.policy),
    actor: parseAcceptanceActor(parsed.actor)
  });
}

function artifactSchema() {
  return z.strictObject({ revision: revisionIdentity, commit: commitSha.nullable() });
}
/** The exact artifact identity: a revision, and the commit it was produced from or null. */
export function parseArtifactIdentity(value: unknown, label = 'artifact'): ArtifactIdentity {
  const parsed = parseStrict(artifactSchema(), value, label + ' (requires revision, and commit or null)');
  return Object.freeze({ revision: parsed.revision, commit: parsed.commit }) as ArtifactIdentity;
}

/**
 * Reads the pass, fail and skipped counts from one command's recorded output.
 *
 * The format is deliberately narrow and documented: a line whose whole content is a marker
 * (`#` for TAP, the info glyph this repository's own test runner prints) followed by one of
 * `tests`, `pass`, `fail`, `skip`/`skipped` and a whole number. Nothing else is a count line, so
 * prose or a log line cannot be read as a result. A missing or unreadable count is an *absence*:
 * it is reported by name and never defaulted to zero.
 */
export function readCounts(output: string | null): { readonly counts: AcceptanceCounts } | { readonly absence: string } {
  if (output === null || output.trim() === '') return { absence: ACCEPTANCE_ABSENCE_REASONS.outputNotRecorded };
  let tests: number | null = null, passed: number | null = null, failed: number | null = null, skipped: number | null = null;
  for (const line of output.split('\n')) {
    const match = ACCEPTANCE_COUNT_LINE.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isInteger(value) || value < 0) continue;
    if (match[1] === 'tests') tests = value;
    else if (match[1] === 'pass') passed = value;
    else if (match[1] === 'fail' || match[1] === 'failures') failed = value;
    else skipped = value;
  }
  if (passed === null || failed === null) return { absence: ACCEPTANCE_ABSENCE_REASONS.outputCarriesNoCounts };
  const counts = Object.freeze({ passed, failed, skipped: skipped ?? 0 });
  // A `tests` line that is smaller than the counters it summarises is a contradiction inside the
  // output itself; the record refuses it rather than picking one of the two numbers.
  if (tests !== null && tests < passed + failed + counts.skipped)
    throw new AcceptanceError('The recorded output summarises ' + tests + ' tests but counts ' + passed + ' passed, ' + failed + ' failed and ' + counts.skipped + ' skipped; the evidence contradicts itself', 'INVALID');
  return { counts };
}

/**
 * Checks one claimed result and returns what the record stores for it.
 *
 * The counts a record carries are **read from the recorded output**, never taken on trust, and the
 * outcome it states is reconciled with those same counts. A claim is an assertion to be checked: a
 * claim with no readable output is refused, a claim that contradicts the output is refused, a claim
 * about a command the record does not say was run is refused, and a claim of a result for a command
 * the caller itself says was not run is refused. A result whose output cannot be read is stored as
 * a named absence, and so is a command the record says was not run — output recorded beside a
 * not-run command is not this record's result, so it is never stored as one.
 */
export function checkTestEvidence(claim: TestEvidenceClaim, commands: readonly string[]): TestEvidence {
  if (!commands.includes(claim.command))
    throw new AcceptanceError('The evidence records a result for `' + claim.command + '`, which is not one of the commands this record says were run', 'INVALID');
  if (claim.outcome === 'not-run' && claim.counts !== null && (claim.counts.passed !== 0 || claim.counts.failed !== 0))
    throw new AcceptanceError('The evidence claims ' + claim.counts.passed + ' passed and ' + claim.counts.failed + ' failed for `' + claim.command + '`, which it also says was not run', 'INVALID');
  const output = claim.output;
  if (output !== null && byteLength(output) > ACCEPTANCE_MAX_OUTPUT_BYTES)
    throw new AcceptanceError('The recorded output for `' + claim.command + '` is larger than the documented ' + ACCEPTANCE_MAX_OUTPUT_BYTES + ' byte bound; record only its tail', 'INVALID');
  const reading = readCounts(output);
  // A command the record says was not run asserts no result: whatever output was recorded beside it
  // is reported as a named absence, never stored as the counts of a run this record does not claim.
  if (claim.outcome === 'not-run')
    return Object.freeze({
      command: claim.command, outcome: 'not-run' as const, output, counts: null,
      absenceReason: 'absence' in reading ? reading.absence : ACCEPTANCE_ABSENCE_REASONS.commandNotRun
    });
  if (claim.counts !== null && (output === null || output.trim() === ''))
    throw new AcceptanceError('The evidence claims counts for `' + claim.command + '` with no recorded output to check them against; record the output, or claim no counts so the absence is named', 'INVALID');
  if ('absence' in reading) {
    if (claim.counts !== null)
      throw new AcceptanceError(
        'The evidence claims ' + claim.counts.passed + ' passed, ' + claim.counts.failed + ' failed and ' + claim.counts.skipped + ' skipped for `' + claim.command + '`, but its recorded output carries no count line to check them against',
        'INVALID'
      );
    return Object.freeze({ command: claim.command, outcome: claim.outcome, output, counts: null, absenceReason: reading.absence });
  }
  if (claim.counts !== null) {
    const claimed = claim.counts, read = reading.counts;
    if (claimed.passed !== read.passed || claimed.failed !== read.failed || claimed.skipped !== read.skipped)
      throw new AcceptanceError(
        'The evidence claims ' + claimed.passed + ' passed, ' + claimed.failed + ' failed and ' + claimed.skipped + ' skipped for `' + claim.command + '`, but its recorded output reports ' + read.passed + ' passed, ' + read.failed + ' failed and ' + read.skipped + ' skipped',
        'INVALID'
      );
  }
  // The outcome is reconciled with the very counts this record is about to carry: a record never
  // stores 'passed' beside a failure, nor 'failed' beside a run with no failure, because either one
  // would report a result its own evidence contradicts.
  const counts = reading.counts;
  if (claim.outcome === 'passed' && counts.failed > 0)
    throw new AcceptanceError(
      'The evidence records `' + claim.command + '` as passed, but its own recorded output reports ' + counts.failed + ' failed; a record stores the outcome its evidence supports',
      'INVALID'
    );
  if (claim.outcome === 'failed' && counts.failed === 0)
    throw new AcceptanceError(
      'The evidence records `' + claim.command + '` as failed, but its own recorded output reports no failure (' + counts.passed + ' passed, 0 failed); a record stores the outcome its evidence supports',
      'INVALID'
    );
  return Object.freeze({ command: claim.command, outcome: claim.outcome, output, counts: reading.counts, absenceReason: null });
}

/** The diff claim: a complete summary, and the full diff inlined inside the bound or referenced. */
export function parseDiffClaim(value: unknown, label = 'diff'): DiffClaim {
  const parsed = parseStrict(
    z.strictObject({
      files: z.number().int().nonnegative(),
      linesAdded: z.number().int().nonnegative(),
      linesRemoved: z.number().int().nonnegative(),
      text: z.string().min(1).nullable(),
      reference: referenceText.nullable()
    }),
    value,
    label + ' (requires files, linesAdded, linesRemoved, text or null, reference or null)'
  );
  if (parsed.text !== null && byteLength(parsed.text) > ACCEPTANCE_MAX_INLINE_DIFF_BYTES)
    throw new AcceptanceError(
      'The inlined diff is larger than the documented ' + ACCEPTANCE_MAX_INLINE_DIFF_BYTES + ' byte bound; reference the full diff instead of inlining it',
      'INVALID'
    );
  if (parsed.text === null && parsed.reference === null)
    throw new AcceptanceError('The diff is neither inlined nor referenced, so the record would summarise a full diff it does not carry; inline it or reference it', 'INVALID');
  if (parsed.reference !== null && (parsed.reference.startsWith('/') || parsed.reference.split('/').includes('..') || parsed.reference.includes('\\')))
    throw new AcceptanceError('The diff reference must be a contained relative reference, never an absolute path or a parent segment', 'INVALID');
  return Object.freeze({
    files: parsed.files, linesAdded: parsed.linesAdded, linesRemoved: parsed.linesRemoved, text: parsed.text, reference: parsed.reference
  }) as DiffClaim;
}

function parseReview(value: unknown): AcceptanceReview | null {
  if (value === null || value === undefined) return null;
  const parsed = parseStrict(
    z.strictObject({ verdict: z.enum(ACCEPTANCE_REVIEW_VERDICTS), reviewer: z.unknown(), at: isoInstant, note: z.string().max(ACCEPTANCE_MAX_TEXT_LENGTH).nullable() }),
    value,
    'review (requires verdict, reviewer, at, note or null)'
  );
  return Object.freeze({
    verdict: parsed.verdict,
    reviewer: parseAcceptanceActor(parsed.reviewer, 'review reviewer'),
    at: parsed.at,
    note: parsed.note
  }) as AcceptanceReview;
}

function parseSubject(value: unknown): AcceptanceSubject {
  const parsed = parseStrict(
    z.strictObject({ kind: z.enum(ACCEPTANCE_SUBJECT_KINDS), id: identifier }),
    value,
    'subject (requires kind, id)'
  );
  return Object.freeze({ kind: parsed.kind, id: parsed.id }) as AcceptanceSubject;
}

/**
 * Validates a completion-record request: unknown fields, unknown kinds, oversized parts, a diff that
 * is neither inlined nor referenced, a result the caller contradicts itself about, and a production
 * instant in the future all fail closed. The identity, the project and the named absences are the
 * store's business, not the caller's.
 */
export function validateCompletionRecordRequest(value: unknown, now: Date): CompletionRecordRequest {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new AcceptanceError('The acceptance clock is not a valid instant', 'STORAGE');
  const parsed = parseStrict(
    z.strictObject({
      sessionId: identifier.nullable().optional(),
      subject: z.unknown(),
      artifact: z.unknown(),
      commands: z.array(commandText).min(1).max(ACCEPTANCE_MAX_COMMANDS),
      diff: z.unknown(),
      tests: z.array(z.unknown()).min(1).max(ACCEPTANCE_MAX_EVIDENCE_ITEMS),
      review: z.unknown().optional(),
      producedAt: isoInstant
    }),
    value,
    'completion record (requires subject, artifact, commands, diff, tests, producedAt)'
  );
  const subject = parseSubject(parsed.subject);
  const sessionId = parsed.sessionId ?? null;
  // A record whose subject is a session names that session: two different answers would make the
  // durable record describe work it cannot be reconciled with.
  if (subject.kind === 'session' && sessionId !== subject.id)
    throw new AcceptanceError('The record is about session ' + subject.id + ' but names ' + (sessionId === null ? 'no session' : 'session ' + sessionId) + '; the subject and the session must be the same', 'INVALID');
  if (isFuture(parsed.producedAt, now))
    throw new AcceptanceError('producedAt must not be in the future; evidence is recorded from work that has happened', 'INVALID');
  const commands = Object.freeze([...parsed.commands]);
  const diff = parseDiffClaim(parsed.diff);
  const claims: TestEvidenceClaim[] = parsed.tests.map((entry, index) => {
    const item = parseStrict(
      z.strictObject({ command: commandText, outcome: z.enum(ACCEPTANCE_OUTCOMES), output: z.string().nullable().optional(), counts: z.unknown().optional() }),
      entry,
      'test evidence at position ' + index + ' (requires command, outcome, output or null, counts or null)'
    );
    const counts = item.counts === undefined || item.counts === null ? null : parseStrict(
      z.strictObject({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }),
      item.counts,
      'counts for ' + item.command + ' (requires passed, failed, skipped)'
    );
    return Object.freeze({
      command: item.command,
      outcome: item.outcome,
      output: item.output ?? null,
      counts: counts === null ? null : Object.freeze({ passed: counts.passed, failed: counts.failed, skipped: counts.skipped })
    }) as TestEvidenceClaim;
  });
  return Object.freeze({
    sessionId,
    subject,
    artifact: parseArtifactIdentity(parsed.artifact),
    commands,
    diff,
    tests: Object.freeze(claims),
    review: parseReview(parsed.review),
    producedAt: parsed.producedAt
  });
}

/** Validates a frozen record exactly as it is read back from durable storage. */
export function validateCompletionRecord(value: unknown): CompletionRecord {
  const parsed = parseStrict(
    z.strictObject({
      version: z.literal(ACCEPTANCE_RECORD_VERSION),
      id: identifier,
      projectId: identifier,
      sessionId: identifier.nullable(),
      subject: z.unknown(),
      artifact: z.unknown(),
      commands: z.array(z.string().min(1)).min(1).max(ACCEPTANCE_MAX_COMMANDS),
      diff: z.unknown(),
      tests: z.array(z.unknown()).min(1).max(ACCEPTANCE_MAX_EVIDENCE_ITEMS),
      review: z.unknown().nullable(),
      producedAt: isoInstant,
      frozen: z.literal(true)
    }),
    value,
    'completion record'
  );
  const subject = parseSubject(parsed.subject);
  if (subject.kind === 'session' && parsed.sessionId !== subject.id)
    throw new AcceptanceError('Stored completion record names a subject and a session that disagree', 'CORRUPT');
  const commands = Object.freeze([...parsed.commands]);
  const diff = parseDiffClaim(parsed.diff, 'stored diff');
  const tests = parsed.tests.map((entry, index) => {
    const item = parseStrict(
      z.strictObject({
        command: z.string().min(1).max(ACCEPTANCE_MAX_COMMAND_LENGTH),
        outcome: z.enum(ACCEPTANCE_OUTCOMES),
        output: z.string().max(ACCEPTANCE_MAX_OUTPUT_BYTES * 4).nullable(),
        counts: z.strictObject({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).nullable(),
        absenceReason: z.string().max(120).nullable()
      }),
      entry,
      'stored test evidence at position ' + index
    );
    if (!commands.includes(item.command)) throw new AcceptanceError('A stored completion record holds a result for a command it does not list as run', 'CORRUPT');
    // Counts and a named absence are mutually exclusive, and one of them is always present: a stored
    // result is never silently "fine" without the evidence that made it so.
    if ((item.counts === null) === (item.absenceReason === null))
      throw new AcceptanceError('A stored completion record holds a result with neither counts nor a named absence, or with both', 'CORRUPT');
    if (item.absenceReason !== null && !(Object.values(ACCEPTANCE_ABSENCE_REASONS) as readonly string[]).includes(item.absenceReason))
      throw new AcceptanceError('A stored completion record holds an unknown absence reason', 'CORRUPT');
    return Object.freeze({
      command: item.command, outcome: item.outcome, output: item.output, counts: item.counts === null ? null : Object.freeze({ ...item.counts }), absenceReason: item.absenceReason
    }) as TestEvidence;
  });
  return Object.freeze({
    version: ACCEPTANCE_RECORD_VERSION,
    id: parsed.id,
    projectId: parsed.projectId,
    sessionId: parsed.sessionId,
    subject,
    artifact: parseArtifactIdentity(parsed.artifact, 'stored artifact'),
    commands,
    diff,
    tests: Object.freeze(tests),
    review: parseReview(parsed.review),
    producedAt: parsed.producedAt,
    frozen: true
  }) as CompletionRecord;
}

/** The acceptance request: which evidence, which artifact, which action class, and who is deciding. */
export function parseAcceptanceRequest(value: unknown): AcceptanceRequest {
  const parsed = parseStrict(
    z.strictObject({ evidenceId: identifier, artifact: z.unknown(), actionClass: z.enum(ACCEPTANCE_ACTION_CLASSES), actor: z.unknown() }),
    value,
    'acceptance request (requires evidenceId, artifact, actionClass, actor)'
  );
  return Object.freeze({
    evidenceId: parsed.evidenceId,
    artifact: parseArtifactIdentity(parsed.artifact),
    actionClass: parsed.actionClass,
    actor: parseAcceptanceActor(parsed.actor)
  });
}

/** Validates a stored acceptance exactly as it is read back from durable storage. */
export function validateAcceptanceRecord(value: unknown): AcceptanceRecord {
  const parsed = parseStrict(
    z.strictObject({
      version: z.literal(ACCEPTANCE_RECORD_VERSION),
      id: identifier,
      projectId: identifier,
      sessionId: identifier.nullable(),
      subject: z.unknown(),
      evidenceId: identifier,
      artifact: z.unknown(),
      actionClass: z.enum(ACCEPTANCE_ACTION_CLASSES),
      acceptedBy: z.strictObject({ kind: z.enum(ACCEPTANCE_ACTOR_KINDS), identity: actorIdentity, policyRule: z.string().min(1).max(160).nullable() }),
      policy: z.strictObject({ revision: z.number().int().nonnegative(), recorded: z.boolean(), mode: z.enum(ACCEPTANCE_MODES), classDecision: z.enum(ACCEPTANCE_CLASS_DECISIONS) }),
      acceptedAt: isoInstant,
      singleUse: z.literal(true)
    }),
    value,
    'acceptance record'
  );
  // The record says why it was allowed: an agent acceptance always carries the permitting rule, and
  // an owner acceptance never claims one.
  if (parsed.acceptedBy.kind === 'agent' && parsed.acceptedBy.policyRule === null)
    throw new AcceptanceError('A stored agent acceptance carries no policy rule, so it cannot say what permitted it', 'CORRUPT');
  if (parsed.acceptedBy.kind === 'owner' && parsed.acceptedBy.policyRule !== null)
    throw new AcceptanceError('A stored owner acceptance claims a policy rule, which an owner decision never needs', 'CORRUPT');
  return Object.freeze({
    version: ACCEPTANCE_RECORD_VERSION,
    id: parsed.id,
    projectId: parsed.projectId,
    sessionId: parsed.sessionId,
    subject: parseSubject(parsed.subject),
    evidenceId: parsed.evidenceId,
    artifact: parseArtifactIdentity(parsed.artifact, 'stored acceptance artifact'),
    actionClass: parsed.actionClass,
    acceptedBy: Object.freeze({ ...parsed.acceptedBy }),
    policy: Object.freeze({ ...parsed.policy }),
    acceptedAt: parsed.acceptedAt,
    singleUse: true
  }) as AcceptanceRecord;
}

/**
 * The acceptance decision itself, as a pure function of the policy and the actor.
 *
 * - The owner may always accept.
 * - An agent may accept only where the mode is `agent-may-accept` **and** the action class is
 *   `full-auto`; the rule that permitted it is returned so the record can carry it.
 * - Everything else is refused with the reason, before anything is written.
 */
export function decideAcceptance(input: { actor: AcceptanceActor; actionClass: AcceptanceActionClass; policy: AcceptancePolicy }):
  { readonly permitted: true; readonly policyRule: string | null } | { readonly permitted: false; readonly message: string } {
  const { actor, actionClass, policy } = input;
  if (actor.kind === 'owner') return Object.freeze({ permitted: true as const, policyRule: null });
  if (policy.mode !== 'agent-may-accept')
    return Object.freeze({
      permitted: false as const,
      message: 'The acceptance policy is owner-only, so an acceptance by agent ' + actor.identity + ' is refused outright; the owner must accept this artifact'
    });
  if (policy.actionClasses[actionClass] !== 'full-auto')
    return Object.freeze({
      permitted: false as const,
      message: 'The acceptance policy asks the owner to decide a ' + actionClass + ', so an acceptance by agent ' + actor.identity + ' is refused; the owner must decide this class'
    });
  return Object.freeze({ permitted: true as const, policyRule: agentPolicyRule(actionClass) });
}

/* --------------------------------------------------------------------------------------------- *
 * The Markdown evidence format.
 * --------------------------------------------------------------------------------------------- */

/** A fence long enough to contain the block it wraps, so a diff or output cannot break the file. */
function fence(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}
function block(text: string): string {
  const marker = fence(text);
  return marker + '\n' + text.replace(/\n$/, '') + '\n' + marker;
}
function actorLabel(actor: AcceptanceActor): string {
  return actor.kind + ' `' + actor.identity + '`';
}

/**
 * The durable Markdown record written next to the work.
 *
 * It is deterministic: the same record always renders to the same bytes, so the store can tell a
 * file it wrote from a hand-edited one. It carries the record's identity, the artifact it was
 * produced from, the commands, the diff summary and the full diff by reference (or inlined when it
 * fits), every test result with the counts read from its own output, the review verdict when there
 * is one, and the acceptance when there is one. The control store stays authoritative; this file is
 * the record an operator can read in the repository.
 */
export function acceptanceMarkdown(record: CompletionRecord, acceptance: AcceptanceRecord | null = null): string {
  const lines: string[] = [];
  lines.push('# Completion record ' + record.id, '');
  lines.push('> Written by Pilot from the durable completion record. The control store is authoritative;');
  lines.push('> this file is its rendering, and recording the same evidence again rewrites it.', '');
  lines.push('| Field | Value |', '|---|---|');
  lines.push('| Project | `' + record.projectId + '` |');
  lines.push('| Session | ' + (record.sessionId === null ? 'none' : '`' + record.sessionId + '`') + ' |');
  lines.push('| Work | ' + record.subject.kind + ' `' + record.subject.id + '` |');
  lines.push('| Artifact revision | `' + record.artifact.revision + '` |');
  lines.push('| Commit | ' + (record.artifact.commit === null ? 'not committed' : '`' + record.artifact.commit + '`') + ' |');
  lines.push('| Produced at | ' + record.producedAt + ' |');
  lines.push('| Frozen | yes — the record is written once and has no update path |', '');
  lines.push('## Commands run', '');
  record.commands.forEach((command, index) => lines.push((index + 1) + '. `' + command + '`'));
  lines.push('', '## Diff', '');
  lines.push('- Files: ' + record.diff.files);
  lines.push('- Lines: +' + record.diff.linesAdded + ' / -' + record.diff.linesRemoved);
  lines.push('- Full diff: ' + (record.diff.text === null ? 'by reference — `' + record.diff.reference + '`' : 'inlined below'), '');
  if (record.diff.text !== null) lines.push(block(record.diff.text), '');
  lines.push('## Test evidence', '');
  for (const test of record.tests) {
    lines.push('### `' + test.command + '`', '');
    lines.push('- Outcome: ' + test.outcome);
    if (test.counts !== null) lines.push('- Counts (read from the recorded output): ' + test.counts.passed + ' passed, ' + test.counts.failed + ' failed, ' + test.counts.skipped + ' skipped');
    else lines.push('- Counts: not asserted — ' + String(test.absenceReason) + ' — ' + (ACCEPTANCE_ABSENCE_DETAILS as Record<string, string>)[String(test.absenceReason)]);
    if (test.output !== null && test.output.trim() !== '') lines.push('- Recorded output:', '', block(test.output), '');
    else lines.push('- Recorded output: none', '');
  }
  lines.push('## Review', '');
  if (record.review === null) lines.push('No review verdict is recorded for this evidence.', '');
  else {
    lines.push('- Verdict: ' + record.review.verdict + ' by ' + actorLabel(record.review.reviewer) + ' at ' + record.review.at);
    lines.push('- Note: ' + (record.review.note === null ? 'none' : record.review.note), '');
  }
  lines.push('## Acceptance', '');
  if (acceptance === null) lines.push('No acceptance is recorded for this evidence.', '');
  else {
    lines.push('- Accepted artifact: revision `' + acceptance.artifact.revision + '`, commit ' + (acceptance.artifact.commit === null ? 'not committed' : '`' + acceptance.artifact.commit + '`'));
    lines.push('- Accepted by: ' + actorLabel({ kind: acceptance.acceptedBy.kind, identity: acceptance.acceptedBy.identity }) + ' at ' + acceptance.acceptedAt);
    lines.push('- Action class: ' + acceptance.actionClass);
    lines.push('- Policy: revision ' + acceptance.policy.revision + (acceptance.policy.recorded ? '' : ' (the documented default, not a stored row)') + ', mode ' + acceptance.policy.mode + ', ' + acceptance.actionClass + '=' + acceptance.policy.classDecision);
    lines.push('- Rule that permitted it: ' + (acceptance.acceptedBy.policyRule === null ? 'the owner decides, so no rule was needed' : '`' + acceptance.acceptedBy.policyRule + '`'));
    lines.push('- Single use: yes — acceptance `' + acceptance.id + '` is the only one for this evidence');
    lines.push('');
  }
  const rendered = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return rendered.endsWith('\n') ? rendered : rendered + '\n';
}

/** The canonical form of a validated request, used to derive the record's identity deterministically. */
export function canonicalEvidenceInput(input: { projectId: string; request: CompletionRecordRequest }): string {
  return canonicalJson({ projectId: input.projectId, request: input.request });
}
