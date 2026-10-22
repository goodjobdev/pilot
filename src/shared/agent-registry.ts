import { z } from 'zod';
import { boundedJson } from './control-state';

/**
 * The agent record and its privilege scopes.
 *
 * This module is pure — no Node built-ins and no framework — so the client can read exactly the
 * closed scope vocabulary and exactly the record shape the server validates. The durable half is
 * 'src/server/state/agent-store.ts', the bounded file-edit capability the 'file_edit' scope governs
 * is 'src/server/state/file-edit-tool.ts', and the operator-facing description is 'docs/AGENTS.md'.
 *
 * Three properties this file is responsible for, and nothing else:
 *
 * 1. The scope vocabulary is closed and described. Every scope has one human-readable description,
 *    and a value outside the set is refused rather than ignored.
 * 2. A record is validated strictly and frozen. Unknown fields, an unknown scope, a model the
 *    instance does not offer, a workspace subpath that escapes the project root, and a budget
 *    outside its documented bound all fail closed, with a precise and path-free reason.
 * 3. Default deny. An agent has exactly the scopes its allowlist names. authorizeToolUse is the one
 *    place that decision is made, and the authoritative dispatch path calls it — the interface is
 *    never the enforcement point.
 */

export const AGENT_RECORD_VERSION = 1 as const;
/** The control store's own payload cap applies to the record: it is stored as bounded JSON. */
export const AGENT_MAX_RECORD_BYTES = 64 * 1024;
/** The documented name rule, the same shape the session registry uses for its own names. */
export const AGENT_NAME_MIN_LENGTH = 1;
export const AGENT_NAME_MAX_LENGTH = 80;
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,79}$/;
/** The documented id rule, shared with the control store's own record identifier rule. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const AGENT_DESCRIPTION_MAX_LENGTH = 400;
export const AGENT_WORKSPACE_SUBPATH_MAX_LENGTH = 400;
/** One instance cannot grow an unbounded registry. */
export const AGENT_MAX_AGENTS = 200;
/** One agent can never name more scopes than the closed vocabulary holds. */
export const AGENT_MAX_SCOPES = 16;

/**
 * The closed scope vocabulary. A scope is a capability, not a label: an agent has exactly the scopes
 * this list names in its allowlist, and everything else is refused at dispatch.
 */
export const AGENT_SCOPES = [
  'read_notes',
  'record_note',
  'ask_question',
  'read_docs',
  'write_docs',
  'file_read',
  'file_edit',
  'run_tests',
  'fork',
  'accept',
  'commit',
  'push',
  'deploy',
  'spend',
  'provision',
  'publish'
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/** One description per scope, in the interface's own words. Every scope has exactly one. */
export const AGENT_SCOPE_DESCRIPTIONS: Readonly<Record<AgentScope, string>> = Object.freeze({
  read_notes: 'Read this project\u2019s notes file back.',
  record_note: 'Append one line to this project\u2019s notes file.',
  ask_question: 'Ask the owner one question and end the turn until it is answered.',
  read_docs: 'Read the project\u2019s documentation.',
  write_docs: 'Write the project\u2019s documentation.',
  file_read: 'Read a file inside the project\u2019s connected repository worktree.',
  file_edit: 'Propose or apply one bounded edit to a file inside the project\u2019s connected repository worktree.',
  run_tests: 'Submit a bounded coding job from the fixed recipe allowlist.',
  fork: 'Branch a transcript and create a child worktree.',
  accept: 'Accept a completion record under the acceptance policy in force.',
  commit: 'Commit work in the project\u2019s repository.',
  push: 'Push a commit to a remote.',
  deploy: 'Deploy a release.',
  spend: 'Incur a cost through a provider or a paid service.',
  provision: 'Create infrastructure or another resource.',
  publish: 'Publish an artifact to a channel.'
});

/**
 * The scope that governs each tool this build exposes to a model. A tool this map does not name is
 * refused for every agent, which is what makes the decision default-deny rather than default-open:
 * a tool added later is unreachable by an agent until it is named here and granted.
 */
export const AGENT_TOOL_SCOPES: Readonly<Record<string, AgentScope>> = Object.freeze({
  ask_question: 'ask_question',
  record_note: 'record_note',
  read_notes: 'read_notes',
  read_docs: 'read_docs',
  write_docs: 'write_docs',
  file_read: 'file_read',
  file_edit: 'file_edit',
  run_tests: 'run_tests'
});

/** The declared budget bounds. A value outside its bound is refused, never reduced. */
export const AGENT_BUDGET_BOUNDS: Readonly<Record<'maxRequests' | 'maxOutputTokens' | 'maxJobsPerHour', { readonly min: number; readonly max: number }>> = Object.freeze({
  maxRequests: Object.freeze({ min: 1, max: 100_000 }),
  maxOutputTokens: Object.freeze({ min: 1, max: 1_000_000 }),
  maxJobsPerHour: Object.freeze({ min: 1, max: 1_000 })
});

export const AGENT_BUDGET_FIELDS = ['maxRequests', 'maxOutputTokens', 'maxJobsPerHour'] as const;
export type AgentBudgetField = (typeof AGENT_BUDGET_FIELDS)[number];

/** The actor a change is made by. Only an owner may widen a scope or create an agent. */
export const AGENT_ACTOR_KINDS = ['owner', 'agent'] as const;
export type AgentActorKind = (typeof AGENT_ACTOR_KINDS)[number];
export type AgentActor = { readonly kind: AgentActorKind; readonly identity: string };

export type AgentModelChoice = { readonly provider: string; readonly modelId: string };
/** A project id plus an optional subpath inside that project's own root. An empty subpath is the root. */
export type AgentWorkspaceScope = { readonly projectId: string; readonly subpath: string };
export type AgentBudgets = { readonly maxRequests: number | null; readonly maxOutputTokens: number | null; readonly maxJobsPerHour: number | null };

/** The stored record. 'revision' is the optimistic-concurrency token a change sends back. */
export type AgentRecord = {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly archived: boolean;
  readonly model: AgentModelChoice;
  readonly workspace: AgentWorkspaceScope;
  readonly budgets: AgentBudgets;
  readonly scopes: readonly AgentScope[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: AgentActor;
};

/** What the interface sends to create an agent: everything but the identity, revision and timestamps. */
export type AgentDraft = {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly model: AgentModelChoice;
  readonly workspace: AgentWorkspaceScope;
  readonly budgets: AgentBudgets;
  readonly scopes: readonly AgentScope[];
};
/** What a change sends: any subset of the draft's fields, and at least one of them. */
export type AgentPatch = Partial<AgentDraft>;

/** Failed-closed reasons. Each refusal carries one of these codes and a precise, path-free message. */
export type AgentErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'DUPLICATE_NAME'
  | 'MODEL_NOT_OFFERED'
  | 'WORKSPACE_NOT_IN_PROJECT'
  | 'BUDGET_OUT_OF_BOUNDS'
  | 'SCOPE_UNKNOWN'
  | 'NOT_PERMITTED'
  | 'CONFLICT'
  | 'CORRUPT'
  | 'STORAGE';
export class AgentError extends Error {
  constructor(message: string, public readonly code: AgentErrorCode) {
    super(message);
    this.name = 'AgentError';
  }
}

const opaquePattern = /^[^\s\u0000-\u001f\u007f]+$/;
const textPattern = /^[^\u0000-\u001f\u007f]+$/;
/** The same rule as textPattern, with the empty string allowed: an empty subpath is the project root. */
const emptyOrTextPattern = /^[^\u0000-\u001f\u007f]*$/;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const path = issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
  return path + issue.message;
}
/** Strict parsing: a ZodError becomes a precise, typed refusal rather than a stack trace. */
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string, code: AgentErrorCode = 'INVALID'): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new AgentError(label + ' is invalid: ' + firstIssue(error), code);
    throw error;
  }
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
/** Whether a value is one of the closed scope set. An unknown scope is refused, never dropped. */
export function isAgentScope(value: unknown): value is AgentScope {
  return typeof value === 'string' && (AGENT_SCOPES as readonly string[]).includes(value);
}

const scopeSchema = z.string().refine(isAgentScope, { message: 'a scope must be one of the closed vocabulary in AGENT_SCOPES' });
const actorSchema = z.strictObject({
  kind: z.enum(AGENT_ACTOR_KINDS),
  identity: z.string().min(1).max(160).regex(opaquePattern, 'an identity must be printable text')
});
const modelSchema = z.strictObject({
  provider: z.string().min(1).max(100).regex(opaquePattern, 'a provider id must be printable text'),
  modelId: z.string().min(1).max(200).regex(opaquePattern, 'a model id must be printable text')
});
const budgetsSchema = z.strictObject({
  maxRequests: z.number().int().nullable(),
  maxOutputTokens: z.number().int().nullable(),
  maxJobsPerHour: z.number().int().nullable()
});

export function parseAgentIdentifier(value: unknown, label = 'agentId'): string {
  return parseStrict(z.string().regex(AGENT_ID_PATTERN, label + ' must be 1-160 characters from A-Za-z0-9._:-'), value, label);
}
export function parseAgentName(value: unknown, label = 'name'): string {
  return parseStrict(
    z.string().regex(AGENT_NAME_PATTERN, label + ' must be ' + AGENT_NAME_MIN_LENGTH + '-' + AGENT_NAME_MAX_LENGTH + ' characters, start with a letter or digit, and use only letters, digits, space, . _ : -'),
    value,
    label
  );
}
export function parseAgentDescription(value: unknown, label = 'description'): string {
  return parseStrict(
    z.string().max(AGENT_DESCRIPTION_MAX_LENGTH).regex(emptyOrTextPattern, label + ' must be printable text of at most ' + AGENT_DESCRIPTION_MAX_LENGTH + ' characters, and an empty one is allowed'),
    value,
    label
  );
}
export function parseAgentActor(value: unknown, label = 'actor'): AgentActor {
  const parsed = parseStrict(actorSchema, value, label + ' (requires kind and identity)');
  return Object.freeze({ kind: parsed.kind, identity: parsed.identity }) as AgentActor;
}
/** The declared model: a provider/model pair. Whether this instance offers it is a separate check. */
export function parseAgentModel(value: unknown, label = 'model'): AgentModelChoice {
  const parsed = parseStrict(modelSchema, value, label + ' (requires provider and modelId)');
  return Object.freeze({ provider: parsed.provider, modelId: parsed.modelId }) as AgentModelChoice;
}
/**
 * The workspace scope: a project id plus an optional subpath inside that project's own root.
 *
 * The subpath is checked here for everything that could leave the root — an absolute path, a
 * backslash, a parent segment, an empty segment — and refused rather than normalised. Whether the
 * project exists at all is the store's business, not this parser's.
 */
export function parseAgentWorkspace(value: unknown, label = 'workspace'): AgentWorkspaceScope {
  const parsed = parseStrict(
    z.strictObject({
      projectId: z.string().regex(AGENT_ID_PATTERN, 'a project id must be 1-160 characters from A-Za-z0-9._:-'),
      subpath: z.string().max(AGENT_WORKSPACE_SUBPATH_MAX_LENGTH).regex(emptyOrTextPattern, 'a subpath must be printable text, and an empty one is the project root')
    }),
    value,
    label + ' (requires projectId and subpath; an empty subpath is the project root)'
  );
  const subpath = parsed.subpath;
  if (subpath !== '') {
    if (subpath.startsWith('/')) throw new AgentError(label + ' is invalid: a subpath must be relative to the project root, not absolute', 'INVALID');
    if (subpath.includes('\\')) throw new AgentError(label + ' is invalid: a subpath must not contain a backslash', 'INVALID');
    const segments = subpath.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
      throw new AgentError(label + ' is invalid: a subpath must be a relative path with no empty, current or parent segment', 'INVALID');
  }
  return Object.freeze({ projectId: parsed.projectId, subpath }) as AgentWorkspaceScope;
}
/** Every budget field is either null (no budget) or a whole number inside its documented bound. */
export function parseAgentBudgets(value: unknown, label = 'budgets'): AgentBudgets {
  const parsed = parseStrict(budgetsSchema, value, label + ' (requires maxRequests, maxOutputTokens and maxJobsPerHour, each a whole number or null)');
  const budgets: Record<AgentBudgetField, number | null> = { maxRequests: null, maxOutputTokens: null, maxJobsPerHour: null };
  for (const field of AGENT_BUDGET_FIELDS) {
    const candidate = parsed[field];
    if (candidate === null) continue;
    const bound = AGENT_BUDGET_BOUNDS[field];
    if (candidate < bound.min || candidate > bound.max)
      throw new AgentError(label + ' is invalid: ' + field + ' must be a whole number from ' + bound.min + ' to ' + bound.max + ', or null for no budget', 'BUDGET_OUT_OF_BOUNDS');
    budgets[field] = candidate;
  }
  return Object.freeze(budgets) as AgentBudgets;
}
/**
 * The scope allowlist, in canonical order with no repeat. A request may supply the scopes in any
 * order; the stored record is always canonical, so two runs over the same input produce the same
 * registry state.
 */
export function parseAgentScopes(value: unknown, label = 'scopes'): readonly AgentScope[] {
  const list = parseStrict(z.array(scopeSchema).max(AGENT_MAX_SCOPES), value, label + ' (an array of at most ' + AGENT_MAX_SCOPES + ' scopes from the closed vocabulary)', 'SCOPE_UNKNOWN');
  const unique = new Set(list as AgentScope[]);
  if (unique.size !== list.length) throw new AgentError(label + ' repeats a scope; an allowlist names each scope at most once', 'SCOPE_UNKNOWN');
  return canonicalAgentScopes([...unique]);
}
/** Sorts a scope list into the one canonical order: the vocabulary's own order. */
export function canonicalAgentScopes(scopes: readonly AgentScope[]): readonly AgentScope[] {
  const order = new Map<AgentScope, number>(AGENT_SCOPES.map((scope, index) => [scope, index]));
  return Object.freeze([...scopes].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0)));
}

const draftSchema = z.strictObject({
  name: z.unknown(),
  description: z.unknown(),
  enabled: z.boolean(),
  model: z.unknown(),
  workspace: z.unknown(),
  budgets: z.unknown(),
  scopes: z.unknown()
});
/** One creation request: every field required, and nothing else accepted. */
export function parseAgentDraft(value: unknown, label = 'agent'): AgentDraft {
  const parsed = parseStrict(draftSchema, value, label + ' (requires name, description, enabled, model, workspace, budgets and scopes)');
  return Object.freeze({
    name: parseAgentName(parsed.name, 'name'),
    description: parseAgentDescription(parsed.description, 'description'),
    enabled: parsed.enabled,
    model: parseAgentModel(parsed.model, 'model'),
    workspace: parseAgentWorkspace(parsed.workspace, 'workspace'),
    budgets: parseAgentBudgets(parsed.budgets, 'budgets'),
    scopes: parseAgentScopes(parsed.scopes, 'scopes')
  }) as AgentDraft;
}
const patchSchema = z.strictObject({
  name: z.unknown().optional(),
  description: z.unknown().optional(),
  enabled: z.boolean().optional(),
  model: z.unknown().optional(),
  workspace: z.unknown().optional(),
  budgets: z.unknown().optional(),
  scopes: z.unknown().optional()
});
/** One change request: any subset of the draft, at least one field, and nothing else accepted. */
export function parseAgentPatch(value: unknown, label = 'patch'): AgentPatch {
  const parsed = parseStrict(patchSchema, value, label + ' (any of name, description, enabled, model, workspace, budgets and scopes)');
  const patch: Record<string, unknown> = {};
  if (parsed.name !== undefined) patch.name = parseAgentName(parsed.name, 'name');
  if (parsed.description !== undefined) patch.description = parseAgentDescription(parsed.description, 'description');
  if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;
  if (parsed.model !== undefined) patch.model = parseAgentModel(parsed.model, 'model');
  if (parsed.workspace !== undefined) patch.workspace = parseAgentWorkspace(parsed.workspace, 'workspace');
  if (parsed.budgets !== undefined) patch.budgets = parseAgentBudgets(parsed.budgets, 'budgets');
  if (parsed.scopes !== undefined) patch.scopes = parseAgentScopes(parsed.scopes, 'scopes');
  if (Object.keys(patch).length === 0) throw new AgentError(label + ' is invalid: a change must name at least one field', 'INVALID');
  return Object.freeze(patch) as AgentPatch;
}

const recordSchema = z.strictObject({
  version: z.literal(AGENT_RECORD_VERSION),
  id: z.string().regex(AGENT_ID_PATTERN, 'an agent id must be 1-160 characters from A-Za-z0-9._:-'),
  name: z.string().regex(AGENT_NAME_PATTERN, 'a name must be 1-80 characters, start alphanumeric, and use only letters, digits, space, . _ : -'),
  description: z.string().max(AGENT_DESCRIPTION_MAX_LENGTH),
  enabled: z.boolean(),
  archived: z.boolean(),
  model: modelSchema,
  workspace: z.strictObject({ projectId: z.string().regex(AGENT_ID_PATTERN), subpath: z.string().max(AGENT_WORKSPACE_SUBPATH_MAX_LENGTH) }),
  budgets: budgetsSchema,
  scopes: z.array(scopeSchema).max(AGENT_MAX_SCOPES),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: actorSchema
});
/**
 * Validates a whole stored record: strict fields, a positive revision, an updated time no earlier
 * than the created time, a canonical scope allowlist, and every field inside its documented bound.
 * A record read back from storage that does not validate is corruption, never a record to interpret.
 */
export function validateAgentRecord(value: unknown, code: AgentErrorCode = 'INVALID'): AgentRecord {
  const parsed = parseStrict(recordSchema, value, 'agent record (requires version, id, name, description, enabled, archived, model, workspace, budgets, scopes, revision, createdAt, updatedAt, updatedBy)', code);
  if (Date.parse(parsed.updatedAt) < Date.parse(parsed.createdAt)) throw new AgentError('An agent record is updated before it was created', code);
  const scopes = parseAgentScopes(parsed.scopes, 'scopes');
  const record: AgentRecord = Object.freeze({
    version: AGENT_RECORD_VERSION,
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    enabled: parsed.enabled,
    archived: parsed.archived,
    model: Object.freeze({ provider: parsed.model.provider, modelId: parsed.model.modelId }) as AgentModelChoice,
    workspace: Object.freeze({ projectId: parsed.workspace.projectId, subpath: parsed.workspace.subpath }) as AgentWorkspaceScope,
    budgets: Object.freeze({ maxRequests: parsed.budgets.maxRequests, maxOutputTokens: parsed.budgets.maxOutputTokens, maxJobsPerHour: parsed.budgets.maxJobsPerHour }) as AgentBudgets,
    scopes,
    revision: parsed.revision,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    updatedBy: Object.freeze({ kind: parsed.updatedBy.kind, identity: parsed.updatedBy.identity }) as AgentActor
  });
  let encoded: string;
  try {
    encoded = boundedJson(record);
  } catch (error) {
    throw new AgentError('The agent record is not bounded JSON data: ' + (error as Error).message, code);
  }
  if (byteLength(encoded) > AGENT_MAX_RECORD_BYTES) throw new AgentError('The agent record exceeds ' + AGENT_MAX_RECORD_BYTES + ' bytes', code);
  return record;
}

/** The record one draft produces, with the identity, revision and timestamps its writer supplies. */
export function buildAgentRecord(input: {
  readonly id: string;
  readonly revision: number;
  readonly draft: AgentDraft;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: AgentActor;
}): AgentRecord {
  return validateAgentRecord({
    version: AGENT_RECORD_VERSION,
    id: input.id,
    name: input.draft.name,
    description: input.draft.description,
    enabled: input.draft.enabled,
    archived: input.archived,
    model: input.draft.model,
    workspace: input.draft.workspace,
    budgets: input.draft.budgets,
    scopes: input.draft.scopes,
    revision: input.revision,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy
  });
}

/* --------------------------------------------------------------------------------------------- *
 * The authorization decision, and the governance rule that decides a change.
 * --------------------------------------------------------------------------------------------- */

export type ToolUseVerdict = { readonly permitted: true; readonly scope: AgentScope } | { readonly permitted: false; readonly reason: string };

/**
 * Whether one tool call is permitted for one caller.
 *
 * 'scopes === null' means the caller is the owner acting under the authenticated session, who is not
 * an agent and has no allowlist to check. Every other caller is an agent, and an agent has only what
 * its allowlist names:
 *
 * - a tool this build declares no scope for is refused for every agent, so a tool added later is
 *   unreachable until it is named in AGENT_TOOL_SCOPES and granted;
 * - a tool whose scope is not in the allowlist is refused, and the reason names the scope and says
 *   what it would allow.
 *
 * This is the one decision the dispatch path makes, and it makes it server-side on every call.
 */
export function authorizeToolUse(input: { readonly scopes: readonly AgentScope[] | null; readonly tool: string }): ToolUseVerdict {
  const scope = AGENT_TOOL_SCOPES[input.tool];
  if (scope === undefined)
    return Object.freeze({
      permitted: false as const,
      reason: input.scopes === null
        ? 'No privilege scope governs the tool ' + input.tool + ', so this build refuses it for every caller'
        : 'No privilege scope governs the tool ' + input.tool + ', so an agent may not call it; only the owner\u2019s own dispatch may'
    });
  if (input.scopes === null) return Object.freeze({ permitted: true as const, scope });
  if (!input.scopes.includes(scope))
    return Object.freeze({
      permitted: false as const,
      reason: 'The ' + scope + ' scope is not in this agent\u2019s allowlist, so the tool ' + input.tool + ' is refused. Granting it would allow: ' + AGENT_SCOPE_DESCRIPTIONS[scope]
    });
  return Object.freeze({ permitted: true as const, scope });
}

/** Whether one allowlist contains another: every scope of 'inner' is also in 'outer'. */
export function scopesContained(inner: readonly AgentScope[], outer: readonly AgentScope[]): boolean {
  const allowed = new Set(outer);
  return inner.every((scope) => allowed.has(scope));
}

export type ScopeChangeVerdict = { readonly permitted: true } | { readonly permitted: false; readonly reason: string };

/**
 * The governance rule, as a pure function of the actor and the two allowlists.
 *
 * - The owner may change any scope. The owner is the authenticated session, not an agent, and
 *   nothing here narrows that.
 * - An agent may not create an agent. Creation by an agent is refused outright.
 * - An agent may not edit its own record. Editing the record that holds its own allowlist would let
 *   it widen itself, so it is refused outright.
 * - An agent may not widen another agent's scopes. A change it makes must stay inside the scopes it
 *   holds itself: an agent can pass on what it has and nothing more.
 *
 * The refusal is returned, never thrown by this function, so the caller decides what it means.
 */
export function decideScopeChange(input: {
  readonly actor: AgentActor;
  /** The scopes the actor itself holds. Required for an agent actor, ignored for the owner. */
  readonly actorScopes: readonly AgentScope[] | null;
  /** The record being changed, or null when the change creates one. */
  readonly current: AgentRecord | null;
  /** The allowlist the change would leave in force. */
  readonly next: readonly AgentScope[];
}): ScopeChangeVerdict {
  if (input.actor.kind === 'owner') return Object.freeze({ permitted: true as const });
  if (input.current === null)
    return Object.freeze({
      permitted: false as const,
      reason: 'An agent may not create another agent, so agent ' + input.actor.identity + ' is refused; only the owner creates agents'
    });
  if (input.current.id === input.actor.identity)
    return Object.freeze({
      permitted: false as const,
      reason: 'An agent may not edit its own record, so agent ' + input.actor.identity + ' is refused; the owner must make this change'
    });
  if (input.actorScopes === null)
    return Object.freeze({
      permitted: false as const,
      reason: 'Agent ' + input.actor.identity + ' is not a live agent of this registry, so it may change nothing'
    });
  if (!scopesContained(input.next, input.actorScopes))
    return Object.freeze({
      permitted: false as const,
      reason: 'The change would give ' + input.current.id + ' a scope agent ' + input.actor.identity + ' does not hold itself, so it is refused; an agent can pass on only what it has'
    });
  return Object.freeze({ permitted: true as const });
}

/** The closed vocabulary as the interface reads it: each scope beside the one line that describes it. */
export function agentScopeVocabulary(): readonly { readonly scope: AgentScope; readonly description: string }[] {
  return Object.freeze(AGENT_SCOPES.map((scope) => Object.freeze({ scope, description: AGENT_SCOPE_DESCRIPTIONS[scope] })));
}

/** One entry of the durable audit trail: what changed, by whom, and when. */
export type AgentAuditEntry = {
  readonly revision: number;
  readonly action: 'created' | 'updated' | 'archived';
  readonly changedBy: AgentActor;
  readonly changedAt: string;
};

/** What governs one project's dispatch: the agent bound to it, and the scopes in force. */
export type DispatchAuthority = {
  /** The agent whose scopes govern this dispatch, or null when the owner's own dispatch is in force. */
  readonly agentId: string | null;
  /** The scopes in force: null means the owner (unrestricted), an empty list means an agent allowed nothing. */
  readonly scopes: readonly AgentScope[] | null;
};

/**
 * Where the agent harness learns the privilege scopes in force.
 *
 * It is read **on every tool call**, so a scope change takes effect at dispatch immediately, and it is
 * read once when a project's harness is opened, so the tools the model is offered are the permitted
 * ones. Nothing else consults it: the interface reads records, never authority.
 */
export interface AgentPrivilegePort {
  authority(input: { readonly projectId: string }): Promise<DispatchAuthority>;
}

/** Whether a record may be dispatched into at all: an archived or disabled agent is never in force. */
export function agentInForce(record: AgentRecord): boolean {
  return record.enabled && !record.archived;
}

/** The scopes in force for one project, given every agent bound to it. Null means no agent is bound. */
export function scopesInForceFor(records: readonly AgentRecord[]): readonly AgentScope[] | null {
  const live = records.filter(agentInForce);
  if (live.length === 0) return null;
  // More than one enabled agent may name one project. Only the scopes every one of them allows are
  // then in force, which is the safe direction: an agent is never granted a scope by being one of
  // several. Binding a conversation to exactly one agent is follow-up work, and docs/AGENTS.md says so.
  return canonicalAgentScopes(AGENT_SCOPES.filter((scope) => live.every((record) => record.scopes.includes(scope))));
}
