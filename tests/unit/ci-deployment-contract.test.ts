import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindCiDeploymentAction, ciDeploymentBindingDigest, parseCiDeploymentTarget, redactCiDeploymentBinding
} from '../../src/shared/ci-deployment-contract';
import type { CiDeploymentBinding } from '../../src/shared/ci-deployment-contract';

const target = {
  version: 1 as const, revision: 2, enabled: false, providerId: 'provider-synthetic',
  projectId: 'project-synthetic', repositoryId: 'repo-synthetic',
  pipelineId: 'pipeline-synthetic', pipelineRevision: 'a'.repeat(64),
  environmentId: 'environment-synthetic', environmentRevision: 'b'.repeat(64)
};
const binding = {
  version: 1 as const, target,
  artifact: { revision: 'c'.repeat(64), digest: 'd'.repeat(64) },
  previewId: 'preview-synthetic', actionId: 'action-synthetic'
};

function assertBindingIsDeepReadonly(value: CiDeploymentBinding): void {
  // @ts-expect-error returned target and nested state are immutable to TypeScript callers
  value.target.enabled = true;
  // @ts-expect-error returned artifact fields are immutable to TypeScript callers
  value.artifact.digest = 'e'.repeat(64);
}
void assertBindingIsDeepReadonly;

test('CI deployment target is strict and defaults to disabled', () => {
  assert.equal(parseCiDeploymentTarget({ ...target, enabled: undefined }).enabled, false);
  assert.throws(() => parseCiDeploymentTarget({ ...target, endpoint: 'https://example.invalid' }));
  assert.throws(() => parseCiDeploymentTarget({ ...target, pipelineId: 'https://example.invalid' }));
  assert.throws(() => parseCiDeploymentTarget({ ...target, providerId: 'https://example.invalid' }));
  assert.throws(() => parseCiDeploymentTarget({ ...target, pipelineRevision: 'mutable-main' }));
  assert.throws(() => parseCiDeploymentTarget({ ...target, revision: 0 }));
});

test('preview/action binding changes with exact target, environment, artifact and identity', () => {
  const digest = ciDeploymentBindingDigest(binding);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, ciDeploymentBindingDigest({ ...binding, target: { ...target, pipelineRevision: 'e'.repeat(64) } }));
  assert.notEqual(digest, ciDeploymentBindingDigest({ ...binding, target: { ...target, enabled: true } }));
  assert.notEqual(digest, ciDeploymentBindingDigest({ ...binding, target: { ...target, revision: 3 } }));
  assert.notEqual(digest, ciDeploymentBindingDigest({ ...binding, target: { ...target, providerId: 'other-provider' } }));
  assert.notEqual(digest, ciDeploymentBindingDigest({ ...binding, target: { ...target, environmentRevision: 'e'.repeat(64) } }));
  assert.notEqual(digest, ciDeploymentBindingDigest({ ...binding, artifact: { ...binding.artifact, revision: 'e'.repeat(64) } }));
  assert.notEqual(digest, ciDeploymentBindingDigest({ ...binding, artifact: { ...binding.artifact, digest: 'e'.repeat(64) } }));
  assert.notEqual(digest, ciDeploymentBindingDigest({ ...binding, previewId: 'other-preview' }));
  assert.notEqual(digest, ciDeploymentBindingDigest({ ...binding, actionId: 'other-action' }));
  assert.throws(() => bindCiDeploymentAction({ ...binding, extra: 'rejected' }));
});

test('display projection excludes owner target and artifact identifiers', () => {
  const safe = redactCiDeploymentBinding(binding);
  const rendered = JSON.stringify(safe);
  assert.equal(safe.targetRevision, 2);
  for (const secretLike of ['project-synthetic', 'pipeline-synthetic', 'environment-synthetic', 'preview-synthetic', 'action-synthetic', 'd'.repeat(64)])
    assert.equal(rendered.includes(secretLike), false);
});
