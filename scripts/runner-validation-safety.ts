import { stat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Refuse redirects instead of overriding an operator's selected runtime or TLS settings. */
export function checkLocalSelection(socket: string, selected: string, env: NodeJS.ProcessEnv, tlsMaterial: unknown) {
  if (!isAbsolute(socket) || socket.includes('\n') || socket.includes('\0')) throw Error('An absolute local Unix socket is required');
  const endpoint = 'unix://' + socket;
  if (selected !== endpoint) throw Error('Selected Docker context does not match the explicitly approved local socket');
  if (env.DOCKER_HOST && env.DOCKER_HOST !== endpoint) throw Error('DOCKER_HOST does not match the approved local socket');
  if (env.DOCKER_TLS || env.DOCKER_TLS_VERIFY || env.DOCKER_CERT_PATH || (tlsMaterial && Object.keys(tlsMaterial as object).length))
    throw Error('TLS configuration is present; validation refuses to override user security settings');
  return endpoint;
}
export async function verifySocket(socket: string) {
  if (!(await stat(socket)).isSocket()) throw Error('Approved endpoint is not a local Unix socket');
  return realpath(socket);
}
/** Every CLI timeout is also bounded by the remaining phase budget. */
export function remainingTimeout(deadline: number, now = Date.now(), cap = 2000) {
  const remaining = deadline - now;
  if (remaining <= 0) throw Error('Validation phase deadline reached');
  return Math.max(1, Math.min(cap, remaining));
}
export function allocatedNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !/^pilot-runner-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x)))
    throw Error('Invalid invocation resource ledger');
  return [...new Set(value)];
}
/** Never remove mounted roots unless removal succeeded and the runtime confirms absence. */
export async function cleanupContainers(names: string[], docker: (...args: string[]) => Promise<string>) {
  const failures: string[] = [];
  for (const name of names) {
    try { await docker('rm', '-f', name); }
    catch { failures.push(name); }
  }
  const present = new Set((await docker('ps', '-a', '--format', '{{.Names}}')).trim().split('\n'));
  // Docker rm may refuse an already absent --rm container. Absence proves that case harmless.
  const remaining = names.filter(name => present.has(name));
  if (remaining.length) throw Error('Allocated containers remain; mounted roots must be retained');
  return { absent: names.length, removalRefusals: failures.length };
}
