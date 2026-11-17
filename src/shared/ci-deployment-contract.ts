import { createHash } from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Owner-authored exact identities only; these fields are identifiers, never URLs or commands. */
export const ciDeploymentTargetSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().positive().safe(),
  enabled: z.boolean().default(false),
  providerId: identifier,
  projectId: identifier,
  repositoryId: identifier,
  pipelineId: identifier,
  pipelineRevision: sha256,
  environmentId: identifier,
  environmentRevision: sha256
});

export const ciDeploymentArtifactSchema = z.strictObject({
  revision: sha256,
  digest: sha256
});

export const ciDeploymentBindingSchema = z.strictObject({
  version: z.literal(1),
  target: ciDeploymentTargetSchema,
  artifact: ciDeploymentArtifactSchema,
  previewId: identifier,
  actionId: identifier
});

export type DeepReadonly<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type CiDeploymentTarget = DeepReadonly<z.infer<typeof ciDeploymentTargetSchema>>;
export type CiDeploymentArtifact = DeepReadonly<z.infer<typeof ciDeploymentArtifactSchema>>;
export type CiDeploymentBinding = DeepReadonly<z.infer<typeof ciDeploymentBindingSchema>>;

/** Strictly validate and freeze the exact owner target; this does not resolve or authenticate it. */
export function parseCiDeploymentTarget(value: unknown): CiDeploymentTarget {
  return Object.freeze(ciDeploymentTargetSchema.parse(value));
}

/** Bind a preview/action identity to the exact selected config revisions and immutable artifact. */
export function bindCiDeploymentAction(input: unknown): CiDeploymentBinding {
  const binding = ciDeploymentBindingSchema.parse(input);
  return Object.freeze({
    ...binding,
    target: Object.freeze(binding.target),
    artifact: Object.freeze(binding.artifact)
  });
}

/** Stable comparison key for the complete binding; it is not a credential or durable receipt. */
export function ciDeploymentBindingDigest(value: unknown): string {
  const binding = bindCiDeploymentAction(value);
  return createHash('sha256').update(JSON.stringify([
    'pilot-ci-deployment-binding-v1',
    binding.target.enabled, binding.target.providerId,
    binding.target.projectId, binding.target.repositoryId,
    binding.target.pipelineId, binding.target.pipelineRevision,
    binding.target.environmentId, binding.target.environmentRevision,
    binding.target.revision, binding.artifact.revision, binding.artifact.digest,
    binding.previewId, binding.actionId
  ])).digest('hex');
}

/** Safe display projection intentionally contains only configuration revision and binding digest. */
export function redactCiDeploymentBinding(value: unknown): Readonly<{ targetRevision: number; bindingDigest: string }> {
  const binding = bindCiDeploymentAction(value);
  return Object.freeze({
    targetRevision: binding.target.revision,
    bindingDigest: ciDeploymentBindingDigest(binding)
  });
}
