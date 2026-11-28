import { createHash } from 'node:crypto';

/**
 * Global experimental barrier identity for one configured push branch. This hash does not establish
 * that the configured digest corresponds to a real or canonical repository; the trusted integration
 * must resolve and verify it. Different assertions for the same repository remain different keys.
 */
export function pushResourceKey(repositoryDigest: string, branch: string): string {
  if (!/^[a-f0-9]{64}$/.test(repositoryDigest) || typeof branch !== 'string' || branch.length < 1 || branch.length > 200)
    throw new Error('Invalid push resource identity.');
  return 'resource-' + createHash('sha256').update(JSON.stringify(['pilot-push-resource-v1', repositoryDigest, branch])).digest('hex');
}
