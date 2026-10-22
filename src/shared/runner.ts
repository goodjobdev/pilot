import { z } from 'zod';
import { canonicalJson } from './control-state';

/**
 * The bounded coding runner: one typed job, a fixed recipe allowlist, and the containment a job runs
 * under.
 *
 * A **job** is a request to run *one* fixed recipe inside *one* workspace directory, under limits the
 * caller must state and this module bounds. It is not a shell: there is no command text, no argument a
 * caller can choose, no environment and no second step. The recipe allowlist is closed and lives here,
 * so the command line a job produces is a constant of this build rather than something a caller
 * composed.
 *
 * The **workspace** is a relative reference inside the registered project's own root, and nothing
 * else. It is validated here for its shape (relative, no '..', no backslash, printable, bounded) and
 * again in the server half (src/server/state/runner-broker.ts), where the containment helper refuses a
 * symlink at every component and the resolved directory must still be inside the root. A reference
 * that resolves outside the approved root is refused, never rewritten.
 *
 * The **states** are a closed set, and each says exactly what the durable record proves:
 *
 * - 'pending': submitted and validated, claimed by nobody. Nothing has run.
 * - 'claimed': one named owner holds a lease on it. **Nothing has run yet** — the durable record is
 *   written to 'running' before any container is started, so a job that is merely 'claimed' is
 *   provably unexecuted. That is what makes a reclaim (after an expired lease) and an explicit
 *   settlement of a claimed job safe: neither can repeat an execution that never began.
 * - 'running': a run began. The record is durable *before* the container starts, so this state is the
 *   evidence that an execution may have happened. It carries the claim of the owner that started it,
 *   and it carries a result only once the run reported one.
 * - 'settled': the job is finished and its result is recorded — the exit code, the bounded output, the
 *   duration and the exact command that ran. A settled job is never run again.
 * - 'attention': terminal, and it needs an operator. Either the run began and no result was ever
 *   recorded (a crash, or a port that could not report), or a claimed job was explicitly settled
 *   without ever being started. This build never guesses an outcome it cannot establish, and never
 *   re-runs a job to find out.
 *
 * The **revision** rule is the same as the queue's: one revision per mutation, and the durable store's
 * unique index is the compare-and-swap, so two writers that read the same revision cannot both win.
 * The claim race and the run-versus-settle race are both decided there and not by timing.
 *
 * The **result** is bounded in bytes at both ends: the execution port stops storing output beyond the
 * documented transport bound, and the broker stores at most the job's own cap for each stream. The cap
 * is measured in the bytes the output occupies inside the stored record, so a stream of control
 * characters cannot inflate a record past the control store's own payload bound.
 *
 * This module is pure apart from the control-store JSON helper it reuses: no Node built-ins and no
 * framework. The durable half is src/server/state/runner-broker.ts; the operator-facing description is
 * docs/RUNNER.md.
 */

export const RUNNER_VERSION = 1 as const;

/**
 * The closed recipe set. A recipe is a name for one fixed command line; it takes no arguments from the
 * caller, so no caller text can reach a command line, a shell or an interpreter.
 */
export const RUNNER_RECIPES = ['test-run', 'noop-probe'] as const;
export type RunnerRecipeId = (typeof RUNNER_RECIPES)[number];

/**
 * The exact argv each recipe runs, as data, so the broker, the port and the tests all read one
 * declaration and a job's result records the same argv that was executed. There is no shell: the
 * container's entry process is argv[0] and every later element is a literal argument.
 */
export const RUNNER_RECIPE_COMMANDS: Readonly<Record<RunnerRecipeId, readonly string[]>> = Object.freeze({
  'test-run': Object.freeze(['node', '--test']),
  'noop-probe': Object.freeze(['/bin/echo', 'pilot-runner-probe'])
});

/** What each recipe is for, in one line, for the owner and for the descriptor. */
export const RUNNER_RECIPE_SUMMARIES: Readonly<Record<RunnerRecipeId, string>> = Object.freeze({
  'test-run': 'runs the workspace own Node test suite (node --test) with the container default discovery and no arguments from the caller',
  'noop-probe': 'runs /bin/echo pilot-runner-probe, so an owner can prove the container, its image and its mount work before trusting a longer job'
});

/** The closed state set. An unknown state fails closed rather than being interpreted. */
export const RUNNER_JOB_STATES = ['pending', 'claimed', 'running', 'settled', 'attention'] as const;
export type RunnerJobState = (typeof RUNNER_JOB_STATES)[number];

/**
 * The closed set of operator-attention reasons. Each says as much as the durable record allows and no
 * more:
 *
 * - 'job-interrupted': the record says a run began and no result was ever recorded, so whether the
 *   container ran, how far it got and what it left behind cannot be established from here. The job is
 *   never re-run to find out.
 * - 'job-not-run': the job was claimed and settled without a run ever beginning. The record proves
 *   this, because a run writes 'running' before it starts a container.
 */
export const RUNNER_ATTENTION_REASONS = ['job-interrupted', 'job-not-run'] as const;
export type RunnerAttentionReason = (typeof RUNNER_ATTENTION_REASONS)[number];

/** The fixed, path-free sentences that go with those reasons. */
export const RUNNER_ATTENTION_DETAILS: Readonly<Record<RunnerAttentionReason, string>> = Object.freeze({
  'job-interrupted': 'The durable record shows this job began running and no result was ever recorded, so whether it executed, how far it got and what it left in the workspace cannot be established from here. Inspect the workspace before submitting another job; this build never re-runs a job to find out what happened.',
  'job-not-run': 'The durable record shows this job was claimed and never started — a run writes the running state before it starts a container — so nothing executed. An operator decides whether to submit it again; the claim is kept in the record as the evidence of who held it.'
});

/**
 * The bounds every job limit is checked against. A value outside them is **refused**, never clamped: a
 * caller that asks for a limit this build cannot enforce is told so instead of being quietly given a
 * smaller one.
 */
export const RUNNER_LIMIT_BOUNDS = Object.freeze({
  timeoutMs: Object.freeze({ min: 100, max: 300_000 }),
  outputBytes: Object.freeze({ min: 256, max: 8_192 }),
  memoryBytes: Object.freeze({ min: 16 * 1024 * 1024, max: 1024 * 1024 * 1024 }),
  cpus: Object.freeze({ min: 1, max: 2 }),
  pids: Object.freeze({ min: 8, max: 128 })
});
/** What a job gets when it states no limits. Every field is still bounded above. */
export const RUNNER_DEFAULT_LIMITS: RunnerLimits = Object.freeze({
  timeoutMs: 60_000,
  outputBytes: 4_096,
  memoryBytes: 256 * 1024 * 1024,
  cpus: 1,
  pids: 64
});
/** The longest workspace reference this build accepts, in characters. */
export const RUNNER_MAX_WORKSPACE_LENGTH = 200;
/** The most jobs one project may hold. A submission beyond it is refused with the record unchanged. */
export const RUNNER_MAX_JOBS = 50;
/** How long one claim lasts by default. It is the whole of this build's liveness evidence. */
export const RUNNER_DEFAULT_LEASE_MS = 60_000;
/** The longest lease this build accepts, so one claim cannot hold a job longer than this. */
export const RUNNER_MAX_LEASE_MS = 60 * 60 * 1000;
/** Where the single job workspace is mounted inside the container. Fixed, so a recipe can rely on it. */
export const RUNNER_CONTAINER_WORKSPACE_PATH = '/workspace';
/** The most output the execution port will buffer for one stream before it stops storing it. */
export const RUNNER_MAX_OUTPUT_BYTES = RUNNER_LIMIT_BOUNDS.outputBytes.max;
/** The documented maximum size of one stored job record, in bytes (the control store's own cap). */
export const RUNNER_MAX_RECORD_BYTES = 64 * 1024;
/** The identifier rule, shared with the named-session, lifecycle and queue identifier rules. */
export const RUNNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/** The name the single job workspace mount carries in the containment report. */
export const RUNNER_WORKSPACE_MOUNT = 'workspace';

/** Failed-closed reasons. Each refusal carries one of these codes and a precise, path-free message. */
export type RunnerErrorCode = 'INVALID' | 'NOT_FOUND' | 'OUTSIDE_ROOT' | 'ILLEGAL' | 'CONFLICT' | 'BOUNDED' | 'UNAVAILABLE' | 'CORRUPT' | 'STORAGE';
export class RunnerError extends Error {
  constructor(message: string, public readonly code: RunnerErrorCode) {
    super(message);
    this.name = 'RunnerError';
  }
}

/** The limits one job runs under, every one of them bounded and enforced by the container. */
export type RunnerLimits = {
  /** The wall clock a run may take, enforced by the broker and honoured by the port. */
  readonly timeoutMs: number;
  /** The bytes each output stream may occupy inside the stored record. */
  readonly outputBytes: number;
  /** The container memory cap, in bytes. */
  readonly memoryBytes: number;
  /** The container CPU cap, in whole CPUs. */
  readonly cpus: number;
  /** The container PID cap. */
  readonly pids: number;
};

/** One claim: who holds the job, and until when. The lease is the whole of the liveness evidence. */
export type RunnerClaim = {
  readonly owner: string;
  readonly claimedAt: string;
  /** The instant the claim stops authorising a run, and the instant it becomes reclaimable. */
  readonly leaseExpiresAt: string;
};

/** The exact command one run executed, recorded so a result is never separated from what produced it. */
export type RunnerCommand = {
  readonly recipe: RunnerRecipeId;
  readonly argv: readonly string[];
};

/** The closed outcome set. 'timed-out' is a known outcome: this build stopped the run at its wall clock. */
export const RUNNER_OUTCOMES = ['succeeded', 'failed', 'timed-out'] as const;
export type RunnerOutcome = (typeof RUNNER_OUTCOMES)[number];

/**
 * What a finished run reported, bounded and path-free.
 *
 * - exitCode is the process exit code, and it is null exactly when the run was stopped at its wall
 *   clock: the code a killed container reports is not the command's own outcome, so it is not recorded
 *   as one.
 * - stdout and stderr are the stored prefixes. stdoutBytes and stderrBytes are the bytes the stream
 *   produced as far as the port counted them, so a truncated stream still says how much there was.
 *   truncated says output was dropped, and capBytes says what the job asked to keep.
 * - No field carries an environment, a credential or an absolute path: the command is the recipe's own
 *   argv, and the workspace is recorded on the job as the relative reference it was submitted as.
 */
export type RunnerJobResult = {
  readonly recipe: RunnerRecipeId;
  readonly outcome: RunnerOutcome;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly capBytes: number;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly commands: readonly RunnerCommand[];
};

/** A named operator-attention state: why this job needs a person and not another attempt. */
export type RunnerAttention = {
  readonly reason: RunnerAttentionReason;
  readonly detail: string;
};

/** One job, exactly as it is stored and read back. Every field is required and strictly validated. */
export type RunnerJobRecord = {
  readonly version: typeof RUNNER_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly recipe: RunnerRecipeId;
  /** The workspace reference the caller submitted: relative, and never an absolute path. */
  readonly workspace: string;
  readonly limits: RunnerLimits;
  readonly state: RunnerJobState;
  readonly revision: number;
  readonly claim: RunnerClaim | null;
  readonly result: RunnerJobResult | null;
  readonly attention: RunnerAttention | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * The containment a job may run under, as the execution port reports it. The broker refuses to run
 * anything unless every required property is present and exact, and there is deliberately no branch
 * anywhere in this build that runs a job in-process, in the application container or on the host.
 *
 * The report is the port's statement about the run it is about to perform: this code builds the
 * command line that carries these properties, and the port verifies the runtime is reachable and the
 * image is present before it answers. It is a containment report, not an audit of the kernel.
 */
export type RunnerContainment = {
  readonly runtime: string;
  readonly image: string;
  /** 'none' means the container has no network interface at all, not a filtered one. */
  readonly network: string;
  readonly rootFilesystem: 'read-only' | 'writable';
  /** The uid:gid the container processes run as. A zero uid is refused. */
  readonly user: string;
  readonly capabilities: string;
  readonly noNewPrivileges: boolean;
  /** Whether the container runtime's own control socket is reachable from inside the container. */
  readonly dockerSocket: boolean;
  /** Every host path the container may see, by name. The job workspace is the only one. */
  readonly mounts: readonly string[];
  readonly maxMemoryBytes: number;
  readonly maxCpus: number;
  readonly maxPids: number;
  readonly maxWallClockMs: number;
};

/** The properties every job requires, in the owner's words, with why each one matters. */
export const RUNNER_REQUIRED_PROPERTIES: readonly { readonly name: string; readonly why: string }[] = Object.freeze([
  Object.freeze({ name: 'no-network', why: 'a job must not reach the network, a provider or another service on the host; the container is created with no interface rather than a filtered one' }),
  Object.freeze({ name: 'read-only-root', why: 'the job must not be able to modify the image or anything outside the single workspace it was given' }),
  Object.freeze({ name: 'non-root-user', why: 'the job must not run as uid 0 inside its own namespace' }),
  Object.freeze({ name: 'no-capabilities', why: 'a job must not hold a capability the container runtime would otherwise keep by default' }),
  Object.freeze({ name: 'no-new-privileges', why: 'a setuid or setcap binary inside the image must not be able to raise privileges' }),
  Object.freeze({ name: 'no-docker-socket', why: 'the container runtime socket is root on the host; a job that could reach it would be outside every other limit' }),
  Object.freeze({ name: 'workspace-only-mount', why: 'the single workspace is the only host path the job may see, so a job cannot read a project or a host path it was not given' }),
  Object.freeze({ name: 'memory-cap', why: 'a job must not be able to exhaust the host memory' }),
  Object.freeze({ name: 'cpu-cap', why: 'a job must not be able to monopolise the host CPUs' }),
  Object.freeze({ name: 'pid-cap', why: 'a job must not be able to fork without bound' }),
  Object.freeze({ name: 'wall-clock-cap', why: 'a job must be stopped at a stated wall clock even if it never exits by itself' })
]);

/**
 * Which required properties a containment report fails, by name. Empty means the report satisfies every
 * one of them. The check is deliberately data-driven from one place, so a property cannot be dropped
 * from the broker without being dropped from the list the tests read.
 */
export function runnerContainmentProblems(containment: RunnerContainment): readonly string[] {
  const problems: string[] = [];
  const positive = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0;
  if (typeof containment.runtime !== 'string' || containment.runtime.trim() === '') problems.push('no-runtime');
  if (typeof containment.image !== 'string' || containment.image.trim() === '') problems.push('no-image');
  if (containment.network !== 'none') problems.push('no-network');
  if (containment.rootFilesystem !== 'read-only') problems.push('read-only-root');
  if (!/^[1-9][0-9]*:[0-9]+$/.test(String(containment.user))) problems.push('non-root-user');
  if (containment.capabilities !== 'none') problems.push('no-capabilities');
  if (containment.noNewPrivileges !== true) problems.push('no-new-privileges');
  if (containment.dockerSocket !== false) problems.push('no-docker-socket');
  if (!Array.isArray(containment.mounts) || containment.mounts.length !== 1 || containment.mounts[0] !== RUNNER_WORKSPACE_MOUNT) problems.push('workspace-only-mount');
  if (!positive(containment.maxMemoryBytes)) problems.push('memory-cap');
  if (!positive(containment.maxCpus)) problems.push('cpu-cap');
  if (!positive(containment.maxPids)) problems.push('pid-cap');
  if (!positive(containment.maxWallClockMs)) problems.push('wall-clock-cap');
  return Object.freeze(problems);
}

/**
 * Refuse to run anything unless the containment report satisfies every required property. The reason
 * names each property that failed and why it matters, and it never degrades to a weaker run: there is
 * no fallback to executing in-process, in the application container or on the host.
 */
export function assertRunnerContainment(containment: RunnerContainment): RunnerContainment {
  const problems = runnerContainmentProblems(containment);
  if (problems.length === 0) return containment;
  const named = problems.map((problem) => {
    const required = RUNNER_REQUIRED_PROPERTIES.find((property) => property.name === problem);
    return problem + (required === undefined ? '' : ' (' + required.why + ')');
  });
  throw new RunnerError(
    'The coding runner cannot establish the containment a job requires, so nothing was run: ' + named.join('; ') +
      '. There is no fallback to running the job in this process, in the application container or on the host.',
    'UNAVAILABLE'
  );
}

/** Whether the limits a job asks for are ones this containment can enforce. */
export function runnerLimitProblems(limits: RunnerLimits, containment: RunnerContainment): readonly string[] {
  const problems: string[] = [];
  if (limits.memoryBytes > containment.maxMemoryBytes) problems.push('memoryBytes');
  if (limits.cpus > containment.maxCpus) problems.push('cpus');
  if (limits.pids > containment.maxPids) problems.push('pids');
  if (limits.timeoutMs > containment.maxWallClockMs) problems.push('timeoutMs');
  return Object.freeze(problems);
}

/**
 * Refuse limits the containment cannot enforce. The refusal names each field and the largest value the
 * runtime reported it can enforce, so an owner knows what to ask for instead of being silently given
 * less than they asked for.
 */
export function assertRunnerLimits(limits: RunnerLimits, containment: RunnerContainment): void {
  const problems = runnerLimitProblems(limits, containment);
  if (problems.length === 0) return;
  const largest: Readonly<Record<string, number>> = Object.freeze({
    memoryBytes: containment.maxMemoryBytes,
    cpus: containment.maxCpus,
    pids: containment.maxPids,
    timeoutMs: containment.maxWallClockMs
  });
  throw new RunnerError(
    'This runtime cannot enforce the limits this job asks for, so nothing was run: ' +
      problems.map((field) => field + ' is ' + limits[field as keyof RunnerLimits] + ' but the runtime reports at most ' + largest[field]).join('; ') +
      '. The job is left exactly as it is; submit a job within those limits or raise the runtime own limits.',
    'INVALID'
  );
}

const textPattern = /^[^\u0000-\u001f\u007f]+$/;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const path = issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
  // The schema library's own wording for an unknown key names the key and its internal phrasing, so it
  // is replaced by this application's own words — exactly as the registry and the routes do.
  return path + (issue.code === 'unrecognized_keys' ? 'it carries a field this request does not accept' : issue.message);
}
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string, code: RunnerErrorCode = 'INVALID'): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new RunnerError(label + ' is invalid: ' + firstIssue(error), code);
    throw error;
  }
}
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}
function identifierSchema(label: string) {
  return z.string().regex(RUNNER_ID_PATTERN, label + ' must be 1-160 characters from A-Za-z0-9._:-');
}

/** The recipe a job asks for: one of the closed allowlist, and never a command line. */
export function parseRunnerRecipe(value: unknown, label = 'recipe'): RunnerRecipeId {
  return parseStrict(z.enum(RUNNER_RECIPES), value, label + ' must be one of ' + RUNNER_RECIPES.join(', '));
}
export function parseRunnerIdentifier(value: unknown, label: string): string {
  return parseStrict(identifierSchema(label), value, label);
}
/** A job id: an identifier, exactly as the session, queue and approval identifiers are. */
export function parseRunnerJobId(value: unknown, label = 'jobId'): string {
  return parseRunnerIdentifier(value, label);
}
/** The owner that holds a claim: a named identity, recorded in the claim and in no other place. */
export function parseRunnerOwner(value: unknown, label = 'owner'): string {
  return parseRunnerIdentifier(value, label);
}
/**
 * A workspace reference: a relative path inside the registered project's own root. The shape is checked
 * here and the real filesystem containment is checked in the server half; a reference that escapes the
 * root is refused here rather than resolved and rewritten.
 */
export function parseRunnerWorkspace(value: unknown, label = 'workspace'): string {
  const text = parseStrict(
    z.string().min(1).max(RUNNER_MAX_WORKSPACE_LENGTH).regex(textPattern, 'a workspace reference must be printable text'),
    value,
    label + ' must be 1-' + RUNNER_MAX_WORKSPACE_LENGTH + ' characters of printable text'
  );
  const refuse = (why: string): never => {
    throw new RunnerError(
      'The workspace reference ' + JSON.stringify(text) + ' is refused: ' + why + '. A job workspace is a relative path inside the registered project root.',
      'OUTSIDE_ROOT'
    );
  };
  if (text.startsWith('/')) refuse('it is an absolute path');
  if (text.includes('\\')) refuse('it contains a backslash');
  if (text.split('/').some((segment) => segment === '' || segment === '..')) refuse('it holds an empty or parent segment');
  return text;
}
/** The revision a caller read, exactly as the queue validates one. */
export function parseRunnerRevision(value: unknown, label = 'revision'): number {
  return parseStrict(z.number().int().nonnegative(), value, label + ' must be a whole number of zero or more');
}

const limitsShape = z.strictObject({
  timeoutMs: z.unknown().optional(),
  outputBytes: z.unknown().optional(),
  memoryBytes: z.unknown().optional(),
  cpus: z.unknown().optional(),
  pids: z.unknown().optional()
});
const LIMIT_UNITS: Readonly<Record<keyof RunnerLimits, string>> = Object.freeze({
  timeoutMs: 'milliseconds', outputBytes: 'bytes', memoryBytes: 'bytes', cpus: 'whole CPUs', pids: 'processes'
});
function boundedLimit(name: keyof RunnerLimits, value: unknown): number {
  if (value === undefined || value === null) return RUNNER_DEFAULT_LIMITS[name];
  const bound = RUNNER_LIMIT_BOUNDS[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < bound.min || value > bound.max)
    throw new RunnerError(
      'The job limits are invalid: ' + name + ' must be a whole number from ' + bound.min + ' to ' + bound.max + ' ' + LIMIT_UNITS[name] +
        ', and ' + JSON.stringify(value) + ' is outside that. A limit larger than this build can enforce is refused rather than reduced.',
      'INVALID'
    );
  return value;
}
/**
 * One job's limits: each field bounded, and an absent one filled from the documented defaults. An
 * unknown field is refused, and a value outside its bound is refused with the bound named — never
 * clamped, so a caller is never quietly given a weaker or a stronger limit than it asked for.
 */
export function parseRunnerLimits(value: unknown, label = 'limits'): RunnerLimits {
  if (value === undefined || value === null) return RUNNER_DEFAULT_LIMITS;
  const exact = parseStrict(limitsShape, value, 'The job limits');
  return Object.freeze({
    timeoutMs: boundedLimit('timeoutMs', exact.timeoutMs),
    outputBytes: boundedLimit('outputBytes', exact.outputBytes),
    memoryBytes: boundedLimit('memoryBytes', exact.memoryBytes),
    cpus: boundedLimit('cpus', exact.cpus),
    pids: boundedLimit('pids', exact.pids)
  });
}

/** One validated job request: the recipe, the workspace reference and the bounded limits. */
export type RunnerJobRequest = {
  readonly recipe: RunnerRecipeId;
  readonly workspace: string;
  readonly limits: RunnerLimits;
};
const requestShape = z.strictObject({ recipe: z.unknown(), workspace: z.unknown(), limits: z.unknown().optional() });
/**
 * The strict request a submission must be. An unknown field, an unknown recipe, a workspace that is
 * not a contained relative reference and a limit outside its bound all fail closed here, before
 * anything is written.
 */
export function runnerJobRequest(value: unknown): RunnerJobRequest {
  const exact = parseStrict(requestShape, value, 'The coding job request');
  return Object.freeze({
    recipe: parseRunnerRecipe(exact.recipe),
    workspace: parseRunnerWorkspace(exact.workspace),
    limits: parseRunnerLimits(exact.limits)
  });
}

const limitsSchema = z.strictObject({
  timeoutMs: z.number().int().positive().max(RUNNER_LIMIT_BOUNDS.timeoutMs.max),
  outputBytes: z.number().int().positive().max(RUNNER_LIMIT_BOUNDS.outputBytes.max),
  memoryBytes: z.number().int().positive().max(RUNNER_LIMIT_BOUNDS.memoryBytes.max),
  cpus: z.number().int().positive().max(RUNNER_LIMIT_BOUNDS.cpus.max),
  pids: z.number().int().positive().max(RUNNER_LIMIT_BOUNDS.pids.max)
});
const claimSchema = z.strictObject({
  owner: identifierSchema('a claim owner'),
  claimedAt: z.string().datetime(),
  leaseExpiresAt: z.string().datetime()
});
const commandSchema = z.strictObject({
  recipe: z.enum(RUNNER_RECIPES),
  argv: z.array(z.string().min(1).max(200)).min(1).max(16)
});
const resultSchema = z.strictObject({
  recipe: z.enum(RUNNER_RECIPES),
  outcome: z.enum(RUNNER_OUTCOMES),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(RUNNER_MAX_OUTPUT_BYTES * 8),
  stderr: z.string().max(RUNNER_MAX_OUTPUT_BYTES * 8),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  capBytes: z.number().int().positive().max(RUNNER_LIMIT_BOUNDS.outputBytes.max),
  durationMs: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  commands: z.array(commandSchema).min(1).max(1)
});
const attentionSchema = z.strictObject({
  reason: z.enum(RUNNER_ATTENTION_REASONS),
  detail: z.string().min(1).max(800).regex(textPattern, 'a detail must be printable text')
});
const recordSchema = z.strictObject({
  version: z.literal(RUNNER_VERSION),
  id: identifierSchema('a job id'),
  projectId: identifierSchema('a project id'),
  recipe: z.enum(RUNNER_RECIPES),
  workspace: z.string().min(1).max(RUNNER_MAX_WORKSPACE_LENGTH).regex(textPattern, 'a workspace reference must be printable text'),
  limits: limitsSchema,
  state: z.enum(RUNNER_JOB_STATES),
  revision: z.number().int().nonnegative(),
  claim: claimSchema.nullable(),
  result: resultSchema.nullable(),
  attention: attentionSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

/** What each state requires of the three optional fields, so no combination can mean two things. */
const STATE_FIELDS: Readonly<Record<RunnerJobState, { claim: boolean; result: boolean; attention: boolean }>> = Object.freeze({
  pending: { claim: false, result: false, attention: false },
  claimed: { claim: true, result: false, attention: false },
  running: { claim: true, result: false, attention: false },
  settled: { claim: true, result: true, attention: false },
  attention: { claim: true, result: false, attention: true }
});

/**
 * The strict validation every job record goes through, on the way in and on the way out of storage.
 * Everything here fails closed with a precise reason:
 *
 * - the claim, result and attention fields must match the job's own state, so a settled job cannot
 *   exist without the result it settled on and a running job cannot claim an outcome it never got;
 * - the result must be for this job's own recipe and must record the allowlist's own argv, so a stored
 *   result can never describe a command this build would not run;
 * - 'timed-out' is exactly the outcome with no exit code, because a killed container's code is not the
 *   command's outcome;
 * - a workspace reference that is not a contained relative path is refused, so no stored record can
 *   carry an absolute path;
 * - the record must fit the documented byte bound, which is the control store's own payload cap.
 */
export function validateRunnerJobRecord(value: unknown, code: RunnerErrorCode = 'INVALID'): RunnerJobRecord {
  const record = parseStrict(recordSchema, value, 'The coding job record', code);
  const fields = STATE_FIELDS[record.state];
  if (fields.claim !== (record.claim !== null))
    throw new RunnerError('The coding job record is invalid: a ' + record.state + ' job ' + (fields.claim ? 'must carry the claim that holds it' : 'must not carry a claim'), code);
  if (fields.result !== (record.result !== null))
    throw new RunnerError('The coding job record is invalid: a ' + record.state + ' job ' + (fields.result ? 'must carry the result it settled on' : 'must not carry a result'), code);
  if (fields.attention !== (record.attention !== null))
    throw new RunnerError('The coding job record is invalid: a ' + record.state + ' job ' + (fields.attention ? 'must carry the named reason it needs attention' : 'must not carry an operator-attention reason'), code);
  try {
    parseRunnerWorkspace(record.workspace, 'The stored workspace reference');
  } catch (error) {
    throw new RunnerError('The coding job record is invalid: ' + (error as Error).message, code);
  }
  if (record.claim !== null) {
    const claimed = Date.parse(record.claim.claimedAt), expires = Date.parse(record.claim.leaseExpiresAt);
    if (!Number.isFinite(claimed) || !Number.isFinite(expires) || expires <= claimed)
      throw new RunnerError('The coding job record is invalid: the claim on job ' + record.id + ' expires at or before it was taken, so it would authorise nothing', code);
    if (expires - claimed > RUNNER_MAX_LEASE_MS)
      throw new RunnerError('The coding job record is invalid: the claim on job ' + record.id + ' lasts longer than the documented ' + RUNNER_MAX_LEASE_MS + 'ms maximum', code);
  }
  if (record.result !== null) {
    const result = record.result;
    if (result.recipe !== record.recipe)
      throw new RunnerError('The coding job record is invalid: job ' + record.id + ' is a ' + record.recipe + ' job but its result is for ' + result.recipe, code);
    const expected = RUNNER_RECIPE_COMMANDS[result.recipe];
    const recorded = result.commands[0].argv;
    if (recorded.length !== expected.length || recorded.some((argument, index) => argument !== expected[index]))
      throw new RunnerError(
        'The coding job record is invalid: the recorded command ' + JSON.stringify(recorded) + ' is not the allowlist own ' + JSON.stringify(expected) + ' for ' + result.recipe,
        code
      );
    if ((result.outcome === 'timed-out') !== (result.exitCode === null))
      throw new RunnerError('The coding job record is invalid: a ' + result.outcome + ' result ' + (result.outcome === 'timed-out' ? 'must' : 'must not') + ' carry a null exit code', code);
    if (result.capBytes !== record.limits.outputBytes)
      throw new RunnerError('The coding job record is invalid: the result of job ' + record.id + ' was capped at ' + result.capBytes + ' bytes but the job asks for ' + record.limits.outputBytes, code);
    if (Date.parse(result.endedAt) < Date.parse(result.startedAt))
      throw new RunnerError('The coding job record is invalid: the result of job ' + record.id + ' ends before it started', code);
  }
  let encoded: string;
  try {
    encoded = canonicalJson(record);
  } catch (error) {
    throw new RunnerError('The coding job record is invalid: it is not bounded JSON data (' + (error as Error).message + ')', code);
  }
  if (new TextEncoder().encode(encoded).byteLength > RUNNER_MAX_RECORD_BYTES)
    throw new RunnerError('The coding job record is invalid: it exceeds the documented ' + RUNNER_MAX_RECORD_BYTES + ' byte bound', 'BOUNDED');
  return deepFreeze(record);
}

/**
 * Which state changes are legal. Every operation performs exactly one of these, and anything else fails
 * closed. The table is the whole authority on transitions.
 *
 * - 'claimed' to 'claimed' is the same owner renewing its lease or a new owner reclaiming a claim whose
 *   lease has expired. Both are safe because nothing has run yet: a run writes 'running' first.
 * - 'claimed' to 'attention' is an explicit settlement of a job that never started, which is how an
 *   owner resolves a claim that cannot run without waiting for a lease to expire.
 * - Nothing leaves 'settled' or 'attention': a settled job is never run again, and an attention job is
 *   never re-run to discover an outcome this build could not establish.
 */
export const RUNNER_JOB_TRANSITIONS: Readonly<Record<RunnerJobState, readonly RunnerJobState[]>> = Object.freeze({
  pending: Object.freeze(['claimed'] as const),
  claimed: Object.freeze(['claimed', 'running', 'attention'] as const),
  running: Object.freeze(['settled', 'attention'] as const),
  settled: Object.freeze([] as const),
  attention: Object.freeze([] as const)
});
export function isLegalRunnerTransition(from: RunnerJobState, to: RunnerJobState): boolean {
  return RUNNER_JOB_TRANSITIONS[from].includes(to);
}
/** Refuse a state change the table does not hold, with the states that are legal named in the reason. */
export function assertRunnerTransition(from: RunnerJobState, to: RunnerJobState, jobId: string): void {
  if (isLegalRunnerTransition(from, to)) return;
  const allowed = RUNNER_JOB_TRANSITIONS[from];
  throw new RunnerError(
    'Job ' + jobId + ' is ' + from + ' and cannot become ' + to +
      (allowed.length === 0 ? '; ' + from + ' is terminal, so the job is never run again' : '; a ' + from + ' job can only become ' + allowed.join(', ')),
    'ILLEGAL'
  );
}

/** The record a job is submitted as: pending, at the first revision it may be read at. */
export function submittedRunnerJob(input: {
  readonly id: string;
  readonly projectId: string;
  readonly request: RunnerJobRequest;
  readonly now: Date;
}): RunnerJobRecord {
  const at = input.now.getTime();
  if (!Number.isFinite(at)) throw new RunnerError('The runner clock is not a valid instant', 'INVALID');
  const timestamp = new Date(at).toISOString();
  return validateRunnerJobRecord({
    version: RUNNER_VERSION,
    id: parseRunnerJobId(input.id),
    projectId: parseRunnerIdentifier(input.projectId, 'projectId'),
    recipe: input.request.recipe,
    workspace: input.request.workspace,
    limits: input.request.limits,
    state: 'pending' as const,
    revision: 1,
    claim: null,
    result: null,
    attention: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * The next revision of a job, from the current one and one change, with everything re-validated. It is
 * the only constructor of a new revision: nothing else may raise a revision, and the transition it
 * performs must be one the table holds.
 */
export function nextRunnerJob(
  current: RunnerJobRecord,
  change: {
    readonly state: RunnerJobState;
    readonly claim: RunnerClaim | null;
    readonly result: RunnerJobResult | null;
    readonly attention: RunnerAttention | null;
    readonly now: Date;
  }
): RunnerJobRecord {
  const at = change.now.getTime();
  if (!Number.isFinite(at)) throw new RunnerError('The runner clock is not a valid instant', 'INVALID');
  assertRunnerTransition(current.state, change.state, current.id);
  return validateRunnerJobRecord({
    version: RUNNER_VERSION,
    id: current.id,
    projectId: current.projectId,
    recipe: current.recipe,
    workspace: current.workspace,
    limits: current.limits,
    state: change.state,
    revision: current.revision + 1,
    claim: change.claim,
    result: change.result,
    attention: change.attention,
    createdAt: current.createdAt,
    updatedAt: new Date(at).toISOString()
  });
}

/**
 * The largest prefix of one output stream that may be stored under a byte cap, where the cap counts the
 * bytes the text occupies inside the stored record (so a control character, which the record escapes,
 * is charged for what it really costs). Nothing is cut inside a code point, and the answer says whether
 * anything was dropped.
 */
export function truncateRunnerOutput(text: string, cap: number): { readonly text: string; readonly truncated: boolean } {
  if (typeof text !== 'string') return Object.freeze({ text: '', truncated: true });
  let kept = '', used = 0;
  for (const character of text) {
    const cost = escapedLength(character);
    if (used + cost > cap) return Object.freeze({ text: kept, truncated: true });
    kept += character;
    used += cost;
  }
  return Object.freeze({ text: kept, truncated: false });
}
function escapedLength(character: string): number {
  const encoded = JSON.stringify(character);
  return encoded.length - 2;
}

/** The size one record occupies when the control store stores it, so the bound can be checked directly. */
export function runnerRecordBytes(record: RunnerJobRecord): number {
  return new TextEncoder().encode(canonicalJson(record)).byteLength;
}

/**
 * The next job an owner may claim: the oldest job that is not terminal, in submission order. A job that
 * is running is the head until it is settled, exactly as a claimed queue entry is its queue's effective
 * head: skipping over it would run later work before earlier work.
 */
export function runnerJobHead(jobs: readonly RunnerJobRecord[]): RunnerJobRecord | null {
  for (const job of jobs) if (job.state === 'pending' || job.state === 'claimed' || job.state === 'running') return job;
  return null;
}

/** What a claim would do, or why it is refused. */
export type RunnerClaimVerdict =
  | { readonly kind: 'free' | 'renew' | 'reclaim'; readonly job: RunnerJobRecord }
  | { readonly kind: 'refused'; readonly code: RunnerErrorCode; readonly reason: string };

/**
 * The claim verdict for one project's jobs, which must be in submission order:
 *
 * - the head is pending: it is claimed;
 * - the head is claimed by this owner: the lease is renewed;
 * - the head is claimed by another owner whose lease has expired: it is reclaimed. The lease is the
 *   whole of this build's liveness evidence, and a reclaim is safe because a job that is merely claimed
 *   has provably not run — a run writes 'running' before it starts a container;
 * - the head is claimed with a live lease, or is running: refused. A live claim is never stolen, and a
 *   running job is never claimed, because claiming it could run it a second time.
 */
export function runnerClaimVerdict(jobs: readonly RunnerJobRecord[], input: { readonly owner: string; readonly now: Date }): RunnerClaimVerdict {
  const owner = parseRunnerOwner(input.owner);
  const at = input.now.getTime();
  if (!Number.isFinite(at)) throw new RunnerError('The runner clock is not a valid instant', 'INVALID');
  const head = runnerJobHead(jobs);
  if (head === null)
    return Object.freeze({ kind: 'refused' as const, code: 'ILLEGAL' as const, reason: 'This project holds no coding job to claim: every job is settled or awaits an operator' });
  if (head.state === 'running')
    return Object.freeze({
      kind: 'refused' as const,
      code: 'ILLEGAL' as const,
      reason: 'Job ' + head.id + ' began running and awaits its result or an operator; a running job is never claimed, because claiming it could run it a second time'
    });
  if (head.state === 'pending') return Object.freeze({ kind: 'free' as const, job: head });
  const claim = head.claim!;
  if (claim.owner === owner) return Object.freeze({ kind: 'renew' as const, job: head });
  // One expiry, one rule, no branch that can never be taken: past the lease the claim is reclaimable,
  // and before it the claim stands.
  if (at >= Date.parse(claim.leaseExpiresAt)) return Object.freeze({ kind: 'reclaim' as const, job: head });
  return Object.freeze({
    kind: 'refused' as const,
    code: 'CONFLICT' as const,
    reason:
      'Job ' + head.id + ' is claimed by ' + claim.owner + ' until ' + claim.leaseExpiresAt +
      ', and that lease is still live, so a live claim is never stolen: this build cannot observe whether that owner is still running, and a live lease is the only liveness evidence there is'
  });
}

/** What a run would do, or why it is refused. */
export type RunnerRunVerdict =
  | { readonly kind: 'run'; readonly job: RunnerJobRecord }
  | { readonly kind: 'refused'; readonly code: RunnerErrorCode; readonly reason: string };

/**
 * The run verdict for one job: only a claimed job runs, only the owner of its claim may run it, and
 * never on an expired lease — the job may already belong to another owner by then. A job that is
 * settled or awaiting an operator is never run again, and a pending job has not been claimed at all.
 */
export function runnerRunVerdict(job: RunnerJobRecord, input: { readonly owner: string; readonly now: Date }): RunnerRunVerdict {
  const owner = parseRunnerOwner(input.owner);
  const at = input.now.getTime();
  if (!Number.isFinite(at)) throw new RunnerError('The runner clock is not a valid instant', 'INVALID');
  if (job.state !== 'claimed') {
    const allowed = RUNNER_JOB_TRANSITIONS[job.state];
    return Object.freeze({
      kind: 'refused' as const,
      code: 'ILLEGAL' as const,
      reason:
        'Job ' + job.id + ' is ' + job.state + ' and cannot be run' +
        (allowed.length === 0
          ? '; ' + job.state + ' is terminal, so the job is never run again'
          : job.state === 'pending'
            ? '; only a claimed job is run, so claim it first'
            : '; only a claimed job is run')
    });
  }
  const claim = job.claim!;
  if (claim.owner !== owner)
    return Object.freeze({
      kind: 'refused' as const,
      code: 'ILLEGAL' as const,
      reason: 'Job ' + job.id + ' is claimed by ' + claim.owner + ', not by ' + owner + '; only the owner of a claim may run it; the record is unchanged'
    });
  if (at >= Date.parse(claim.leaseExpiresAt))
    return Object.freeze({
      kind: 'refused' as const,
      code: 'ILLEGAL' as const,
      reason: 'The claim on job ' + job.id + ' expired at ' + claim.leaseExpiresAt + '; the runner never runs on an expired lease, because the job may already belong to another owner; claim it again first'
    });
  return Object.freeze({ kind: 'run' as const, job });
}

/** What settling one job would do, or why it is refused. */
export type RunnerSettleVerdict =
  | { readonly kind: 'settle' }
  | { readonly kind: 'attention'; readonly reason: RunnerAttentionReason }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly code: RunnerErrorCode; readonly reason: string };

/**
 * The settle verdict for one job, decided from the durable record alone:
 *
 * - a run that recorded a result is settled on it;
 * - a run that recorded nothing becomes 'job-interrupted': whether it executed cannot be established,
 *   and it is never re-run to find out;
 * - a claimed job becomes 'job-not-run': the record proves nothing executed, because a run writes
 *   'running' before it starts a container. Settling a claimed job is how an owner resolves a claim
 *   that cannot run without waiting for its lease to expire — and it cannot launder an execution, since
 *   a run racing it loses the compare-and-swap and executes nothing;
 * - a settled or attention job is a no-op, and a pending job has nothing to settle.
 */
export function runnerSettleVerdict(job: RunnerJobRecord): RunnerSettleVerdict {
  if (job.state === 'settled' || job.state === 'attention') return Object.freeze({ kind: 'unchanged' as const });
  if (job.state === 'pending')
    return Object.freeze({
      kind: 'refused' as const,
      code: 'ILLEGAL' as const,
      reason: 'Job ' + job.id + ' is pending and has not been claimed, so there is nothing to settle; claim it first, or leave it pending for a dispatcher'
    });
  if (job.state === 'claimed') return Object.freeze({ kind: 'attention' as const, reason: 'job-not-run' as const });
  return job.result === null
    ? Object.freeze({ kind: 'attention' as const, reason: 'job-interrupted' as const })
    : Object.freeze({ kind: 'settle' as const });
}

/** What the owner reads for one project: the jobs, the allowlist and the bounds this build enforces. */
export type RunnerView = {
  readonly readOnly: true;
  readonly projectId: string;
  readonly jobs: readonly RunnerJobRecord[];
  readonly recipes: readonly RunnerRecipeId[];
  readonly limits: {
    readonly defaults: RunnerLimits;
    readonly bounds: typeof RUNNER_LIMIT_BOUNDS;
    readonly jobs: number;
    readonly leaseMs: number;
  };
  readonly truncated: boolean;
};

/** The owner-visible read of one project's jobs: the records, the allowlist and the documented bounds. */
export function runnerView(input: { readonly projectId: string; readonly jobs: readonly RunnerJobRecord[]; readonly truncated: boolean }): RunnerView {
  return Object.freeze({
    readOnly: true as const,
    projectId: parseRunnerIdentifier(input.projectId, 'projectId'),
    jobs: Object.freeze(input.jobs.map((job) => validateRunnerJobRecord(job, 'CORRUPT'))),
    recipes: RUNNER_RECIPES,
    limits: Object.freeze({ defaults: RUNNER_DEFAULT_LIMITS, bounds: RUNNER_LIMIT_BOUNDS, jobs: RUNNER_MAX_JOBS, leaseMs: RUNNER_DEFAULT_LEASE_MS }),
    truncated: input.truncated
  });
}
