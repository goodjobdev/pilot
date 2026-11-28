import { z } from 'zod';
import { modelKey, type ModelChoice } from './settings';

/**
 * The owner's worker model policy.
 *
 * This record configures **future owner-created workers** only. It is not an orchestrator
 * setting and it does not run anything. The existing global default model, the per-session
 * model and the per-agent model remain the orchestrator controls they already are. Step 9
 * will enforce this policy when it creates a bounded worker; until then the record is
 * stored, validated and shown, and no worker dispatch exists.
 *
 * Storage is one control-store operation per revision (see `worker-model-policy-store.ts`),
 * keyed by the revision it produces. There is no new table and no new database.
 */
export const WORKER_MODEL_POLICY_VERSION = 1 as const;
export const WORKER_MODEL_POLICY_MAX_MODELS = 50;

export type WorkerModelPolicyActor = {
  readonly kind: 'owner' | 'agent';
  readonly identity: string;
};

export type WorkerModelPolicyDraft = {
  readonly allowedWorkerModels: readonly ModelChoice[];
  readonly defaultWorkerModel: ModelChoice | null;
};

export type WorkerModelPolicy = {
  readonly version: 1;
  readonly revision: number;
  readonly allowedWorkerModels: readonly ModelChoice[];
  readonly defaultWorkerModel: ModelChoice | null;
  readonly updatedBy: WorkerModelPolicyActor;
  readonly updatedAt: string;
};

/** One catalog entry as the interface sees it. A saved entry may be known false. */
export type WorkerModelOption = {
  readonly provider: string;
  readonly modelId: string;
  readonly name: string;
  readonly known: boolean;
  /** A credential is saved. This is not a health check, and no provider probe is made. */
  readonly credentialSaved: boolean;
  /** A fixed, read-only explanation of the credential state. */
  readonly credentialNote: string;
  readonly available: boolean;
  readonly unavailableReason: string | null;
};

export type WorkerModelPolicyView = {
  readonly policy: WorkerModelPolicy | null;
  readonly revision: number;
  readonly models: readonly WorkerModelOption[];
};

export type WorkerModelPolicyErrorCode =
  | 'INVALID'
  | 'CONFLICT'
  | 'NOT_PERMITTED'
  | 'MODEL_NOT_OFFERED'
  | 'DEFAULT_NOT_ALLOWED'
  | 'DUPLICATE_MODEL'
  | 'CORRUPT'
  | 'STORAGE';

export class WorkerModelPolicyError extends Error {
  constructor(message: string, public readonly code: WorkerModelPolicyErrorCode) {
    super(message);
    this.name = 'WorkerModelPolicyError';
  }
}

const opaquePattern = /^[^\s\u0000-\u001f\u007f]+$/;
const actorSchema = z.strictObject({
  kind: z.enum(['owner', 'agent']),
  identity: z.string().min(1).max(160).regex(opaquePattern, 'an identity must be printable text')
});
const modelSchema = z.strictObject({
  provider: z.string().min(1).max(100).regex(opaquePattern, 'a provider id must be printable text'),
  modelId: z.string().min(1).max(200).regex(opaquePattern, 'a model id must be printable text')
});
const draftSchema = z.strictObject({
  allowedWorkerModels: z.array(modelSchema).max(WORKER_MODEL_POLICY_MAX_MODELS),
  defaultWorkerModel: modelSchema.nullable()
});
const updateSchema = z.strictObject({
  revision: z.number().int().min(0),
  policy: z.unknown()
});
const recordSchema = z.strictObject({
  version: z.literal(WORKER_MODEL_POLICY_VERSION),
  revision: z.number().int().positive(),
  allowedWorkerModels: z.array(modelSchema).max(WORKER_MODEL_POLICY_MAX_MODELS),
  defaultWorkerModel: modelSchema.nullable(),
  updatedBy: actorSchema,
  updatedAt: z.string().datetime()
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const path = issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
  return path + issue.message;
}

function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string, code: 'INVALID' | 'CORRUPT' = 'INVALID'): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new WorkerModelPolicyError(label + ' is invalid: ' + firstIssue(error), code);
    throw error;
  }
}

/** A strict actor. The route never accepts one from a request body. */
export function parseWorkerModelPolicyActor(value: unknown, label = 'actor'): WorkerModelPolicyActor {
  const parsed = parseStrict(actorSchema, value, label + ' (requires kind and identity)');
  return Object.freeze({ kind: parsed.kind, identity: parsed.identity }) as WorkerModelPolicyActor;
}


function canonicalModels(models: readonly ModelChoice[]): readonly ModelChoice[] {
  return Object.freeze([...models].sort((left, right) => modelKey(left).localeCompare(modelKey(right))).map((model) => Object.freeze({ provider: model.provider, modelId: model.modelId })));
}

function assertUnique(models: readonly ModelChoice[]): void {
  const seen = new Set<string>();
  for (const model of models) {
    const key = modelKey(model);
    if (seen.has(key)) throw new WorkerModelPolicyError('The model ' + key + ' appears more than once in the allowed worker set; remove the duplicate', 'DUPLICATE_MODEL');
    seen.add(key);
  }
}

function assertKnown(model: ModelChoice, offered: readonly ModelChoice[], previous: WorkerModelPolicy | null): void {
  const key = modelKey(model);
  if (offered.some((entry) => modelKey(entry) === key)) return;
  // A model that was saved before is preserved even when the catalog no longer has it. The owner
  // must be able to inspect it and remove it. A *new* unknown model is refused.
  if (previous?.allowedWorkerModels.some((entry) => modelKey(entry) === key)) return;
  throw new WorkerModelPolicyError(
    'The model ' + key + ' is not one this instance offers, so it was not saved; choose a model from the offered list',
    'MODEL_NOT_OFFERED'
  );
}

/**
 * Validate a policy draft against this instance's catalog.
 *
 * - Every new model must be offered now.
 * - A model already saved is preserved even when the catalog no longer offers it, so it can be
 *   inspected and removed. A new unknown model is refused.
 * - The default must be null or a member of the resulting allowed set. Removing the default from
 *   the set without clearing it is refused; it is never cleared silently.
 */
export function validateWorkerModelPolicyDraft(
  value: unknown,
  offered: readonly ModelChoice[],
  previous: WorkerModelPolicy | null = null
): WorkerModelPolicyDraft {
  const parsed = parseStrict(draftSchema, value, 'worker model policy (requires allowedWorkerModels and defaultWorkerModel)');
  assertUnique(parsed.allowedWorkerModels);
  for (const model of parsed.allowedWorkerModels) assertKnown(model, offered, previous);
  const allowed = canonicalModels(parsed.allowedWorkerModels);
  const requestedDefault = parsed.defaultWorkerModel === null
    ? null
    : Object.freeze({ provider: parsed.defaultWorkerModel.provider, modelId: parsed.defaultWorkerModel.modelId }) as ModelChoice;
  if (requestedDefault !== null && !allowed.some((model) => modelKey(model) === modelKey(requestedDefault))) {
    throw new WorkerModelPolicyError(
      'The default worker model ' + modelKey(requestedDefault) + ' is not in allowedWorkerModels; add it to the allowed set or clear defaultWorkerModel explicitly. It was not changed automatically',
      'DEFAULT_NOT_ALLOWED'
    );
  }
  return Object.freeze({ allowedWorkerModels: allowed, defaultWorkerModel: requestedDefault }) as WorkerModelPolicyDraft;
}

/** Parse the one write shape. The actor is deliberately absent: the route derives it. */
export function parseWorkerModelPolicyUpdate(value: unknown): { readonly revision: number; readonly policy: unknown } {
  return parseStrict(updateSchema, value, 'worker model policy request (requires revision and policy)');
}

/** A stored record is validated without the live catalog: a now-unavailable entry is still a record. */
export function validateWorkerModelPolicyRecord(value: unknown): WorkerModelPolicy {
  const parsed = parseStrict(recordSchema, value, 'stored worker model policy', 'CORRUPT') as WorkerModelPolicy;
  assertUnique(parsed.allowedWorkerModels);
  const allowed = canonicalModels(parsed.allowedWorkerModels);
  if (allowed.some((model, index) => modelKey(model) !== modelKey(parsed.allowedWorkerModels[index]!))) {
    throw new WorkerModelPolicyError('A stored worker model policy is not in canonical model order', 'CORRUPT');
  }
  const defaultModel = parsed.defaultWorkerModel === null
    ? null
    : Object.freeze({ provider: parsed.defaultWorkerModel.provider, modelId: parsed.defaultWorkerModel.modelId }) as ModelChoice;
  if (defaultModel !== null && !allowed.some((model) => modelKey(model) === modelKey(defaultModel))) {
    throw new WorkerModelPolicyError('A stored worker model policy names a default outside its allowed set', 'CORRUPT');
  }
  return Object.freeze({
    version: WORKER_MODEL_POLICY_VERSION,
    revision: parsed.revision,
    allowedWorkerModels: allowed,
    defaultWorkerModel: defaultModel,
    updatedBy: Object.freeze({ kind: parsed.updatedBy.kind, identity: parsed.updatedBy.identity }),
    updatedAt: parsed.updatedAt
  }) as WorkerModelPolicy;
}

export function buildWorkerModelPolicy(input: {
  readonly revision: number;
  readonly draft: WorkerModelPolicyDraft;
  readonly actor: WorkerModelPolicyActor;
  readonly updatedAt: string;
}): WorkerModelPolicy {
  return validateWorkerModelPolicyRecord({
    version: WORKER_MODEL_POLICY_VERSION,
    revision: input.revision,
    allowedWorkerModels: canonicalModels(input.draft.allowedWorkerModels),
    defaultWorkerModel: input.draft.defaultWorkerModel,
    updatedBy: input.actor,
    updatedAt: input.updatedAt
  });
}

/** Whether a draft would change the stored policy. Used for an idempotent same-content no-op. */
export function sameWorkerModelPolicyDraft(policy: WorkerModelPolicy, draft: WorkerModelPolicyDraft): boolean {
  const left = policy.allowedWorkerModels.map(modelKey).join('\n');
  const right = draft.allowedWorkerModels.map(modelKey).join('\n');
  const leftDefault = policy.defaultWorkerModel === null ? null : modelKey(policy.defaultWorkerModel);
  const rightDefault = draft.defaultWorkerModel === null ? null : modelKey(draft.defaultWorkerModel);
  return left === right && leftDefault === rightDefault;
}
