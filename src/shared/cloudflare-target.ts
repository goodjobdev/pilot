import { createHash } from 'node:crypto';
import { z } from 'zod';

const accountId = z.string().regex(/^[a-f0-9]{32}$/);
const resourceName = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9_-]*$/);
const environment = z.enum(['production', 'preview']);

/** Cloudflare's two deployable resource types have intentionally non-interchangeable identities. */
export const cloudflareDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workers'), accountId, scriptName: resourceName }),
  z.strictObject({ kind: z.literal('pages'), accountId, projectName: resourceName })
]);

export const cloudflareTargetSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().positive().safe(),
  enabled: z.boolean().default(false),
  environment,
  destination: cloudflareDestinationSchema
});

export type CloudflareDestination = z.infer<typeof cloudflareDestinationSchema>;
export type CloudflareTarget = z.infer<typeof cloudflareTargetSchema>;

/** Parse a bounded owner-authored target; callers must still enforce owner auth and revision CAS. */
export function parseCloudflareTarget(value: unknown): CloudflareTarget {
  return cloudflareTargetSchema.parse(value);
}

/** Canonical target binding includes provider, kind, exact account/resource and environment. */
export function cloudflareTargetDigest(value: unknown): string {
  const target = parseCloudflareTarget(value), d = target.destination;
  const resource = d.kind === 'workers' ? d.scriptName : d.projectName;
  return createHash('sha256').update(JSON.stringify([
    'pilot-cloudflare-target-v1', d.kind, d.accountId, resource, target.environment
  ])).digest('hex');
}

/** Safe display form deliberately excludes the account and exact provider resource identifiers. */
export function redactCloudflareTarget(value: unknown): Readonly<{
  kind: CloudflareDestination['kind']; revision: number; enabled: boolean;
  environment: CloudflareTarget['environment']; targetDigest: string;
}> {
  const target = parseCloudflareTarget(value);
  return Object.freeze({
    kind: target.destination.kind,
    revision: target.revision,
    enabled: target.enabled,
    environment: target.environment,
    targetDigest: cloudflareTargetDigest(target)
  });
}
