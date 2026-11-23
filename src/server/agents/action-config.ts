import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseSpendEndpoint } from './accepted-spend';

/**
 * The owner-configured targets for the two installed consequential adapters, resolved from the
 * deployment environment or an explicit host option. Each is default off: no switch, no target.
 *
 * Provisioning's approved root is refused when it is relative, a symbolic link, not a directory, or
 * overlaps the data root (which holds the control store and credentials) or any registered project.
 * Spending requires one HTTPS endpoint (plain HTTP only for a loopback stub), one account identifier,
 * one fixed currency and both caps. Nothing here reads or stores a credential.
 */

export const PROVISION_TARGET_ID = 'pilot-provision';
export const SPEND_TARGET_ID = 'pilot-spend';

function overlaps(a: string, b: string): boolean {
  const inside = (base: string, target: string) => {
    const rel = relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

export async function resolveProvisionConfiguration(input: {
  enabled: boolean;
  configured: unknown;
  hasControlStore: boolean;
  dataRoot: string;
  projectRoots: readonly string[];
}): Promise<{ root: string } | undefined> {
  if (!input.enabled) return undefined;
  if (!input.hasControlStore) throw new Error('Provisioning requires the durable control store, so no provisioning tool was installed.');
  if (typeof input.configured !== 'string' || input.configured.trim() === '' || !isAbsolute(input.configured))
    throw new Error('Provisioning needs an absolute owner-approved root: set DASHBOARD_PROVISION_ROOT or the provision.root option.');
  const configured = resolve(input.configured);
  const info = await lstat(configured).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error('The approved provisioning root must be an existing real directory, not a symbolic link.');
  const root = await realpath(configured);
  const dataRoot = await realpath(resolve(input.dataRoot)).catch(() => resolve(input.dataRoot));
  if (overlaps(root, dataRoot)) throw new Error('The approved provisioning root must not overlap the data root, which holds the control store and credentials.');
  for (const project of input.projectRoots) {
    if (typeof project !== 'string' || project === '') continue;
    if (overlaps(root, await realpath(resolve(project)).catch(() => resolve(project))))
      throw new Error('The approved provisioning root must not overlap a registered project root.');
  }
  return { root };
}

export async function resolveSpendConfiguration(input: {
  enabled: boolean;
  hasControlStore: boolean;
  endpoint: unknown;
  accountId: unknown;
  currency: unknown;
  projectCapMinor: unknown;
  chargeCapMinor: unknown;
  timeoutMs: unknown;
}): Promise<{ endpoint: string; accountId: string; currency: string; projectCapMinor: number; chargeCapMinor: number; timeoutMs: number } | undefined> {
  if (!input.enabled) return undefined;
  if (!input.hasControlStore) throw new Error('Spending requires the durable control store, so no spend tool was installed.');
  const endpoint = parseSpendEndpoint(input.endpoint);
  const accountId = typeof input.accountId === 'string' ? input.accountId : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(accountId)) throw new Error('Spending needs an owner-configured billing account: set DASHBOARD_SPEND_ACCOUNT_ID or the spend.accountId option.');
  const currency = typeof input.currency === 'string' ? input.currency : '';
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Spending needs one fixed three-letter currency: set DASHBOARD_SPEND_CURRENCY or the spend.currency option.');
  const cap = (raw: unknown, label: string) => {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000_000) throw new Error(label + ' must be a whole number of minor units from 1 to 1000000000000.');
    return value;
  };
  const projectCapMinor = cap(input.projectCapMinor, 'DASHBOARD_SPEND_PROJECT_CAP_MINOR');
  const chargeCapMinor = cap(input.chargeCapMinor, 'DASHBOARD_SPEND_CHARGE_CAP_MINOR');
  // The budget constructor owns the relationship between the two caps; this only checks the unit.
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : Number(input.timeoutMs ?? 10_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('DASHBOARD_SPEND_TIMEOUT_MS must be a whole number from 1 to 120000.');
  return { endpoint, accountId, currency, projectCapMinor, chargeCapMinor, timeoutMs };
}
