import { createHash } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Hash a fixed Cloudflare Workers destination without exposing an account ID to the model. */
export function cloudflareWorkerResourceDigest(accountId: string, workerName: string): string {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(workerName)) throw new Error('Invalid Cloudflare Worker destination.');
  return createHash('sha256').update(JSON.stringify(['cloudflare-worker-v1', accountId, workerName])).digest('hex');
}

/**
 * Experimental read-only Cloudflare Workers version inspection. Deployment is deliberately disabled:
 * version GET cannot establish the full migration transition. It is not installed in Pilot and its
 * credential callback must be supplied by a separately authenticated, owner-configured integration.
 * It never accepts a URL, token, account, script name, or command from a model. It performs no retry.
 * An injected fetch is trusted with the bearer token and must enforce transport security itself;
 * redirect: 'error' and response checks cannot constrain a malicious custom transport.
 * A provider acknowledgement is not a health check, a revocable lease, or proof that the deployed
 * code cannot perform other actions. GET version resources may contain sensitive binding metadata;
 * the bounded response is parsed in memory and never returned or logged.
 */
export class CloudflareWorkerDeployTransport {
  readonly resourceDigest: string;
  private readonly base: string;
  constructor(private readonly options: { accountId: string; workerName: string; token: () => Promise<string>; fetch?: typeof fetch }) {
    this.resourceDigest = cloudflareWorkerResourceDigest(options.accountId, options.workerName);
    this.base = 'https://api.cloudflare.com/client/v4/accounts/' + options.accountId + '/workers/scripts/' + options.workerName;
  }

  private async request(path: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    let token: string;
    try { token = await this.options.token(); } catch { throw new Error('Cloudflare deployment credentials are unavailable.'); }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{10,256}$/.test(token)) throw new Error('Cloudflare deployment credentials are unavailable.');
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(15000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await (this.options.fetch ?? fetch)(this.base + path, { method: 'GET', headers: { authorization: 'Bearer ' + token, accept: 'application/json' }, redirect: 'error', signal: combined });
      // Do not trust a custom transport to have honored redirect: 'error'. Only accept the
      // exact JSON media type, not attacker-controlled types containing that substring.
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (response.redirected || !response.ok || mediaType !== 'application/json' || !response.body) throw new Error('unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); throw new Error('oversize'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')) as unknown;
    } catch { throw new Error('Cloudflare deployment response is unavailable or unverified.'); }
  }

  async inspect(input: { resourceDigest: string; versionId: string; signal?: AbortSignal }): Promise<{ resourceDigest: string; versionId: string }> {
    if (input.resourceDigest !== this.resourceDigest || !UUID.test(input.versionId)) throw new Error('The Worker target or version does not match.');
    const raw = await this.request('/versions/' + input.versionId, input.signal);
    const envelope = raw as { success?: unknown; result?: { id?: unknown; resources?: { bindings?: unknown; script_runtime?: { exports?: unknown } } } } | null;
    if (!envelope || envelope.success !== true || envelope.result?.id !== input.versionId) throw new Error('The Worker version could not be verified.');
    // A conservative prototype restriction, NOT proof of safe resource changes. Cloudflare's
    // version GET documentation says tombstoned exports are omitted, so even an empty export map
    // cannot rule out an irreversible Durable Object deletion. Some valid Workers omit these fields.
    // This experimental adapter must not be installed until there is an authoritative migration
    // check and a separately reviewed, pinned integration. Deployed code can itself cause effects.
    const resources = envelope.result.resources, exports = resources?.script_runtime?.exports;
    if (!Array.isArray(resources?.bindings) || resources.bindings.length !== 0 || !exports || typeof exports !== 'object' || Array.isArray(exports) || Object.values(exports).some(value => !value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'worker' || ![undefined, 'created'].includes((value as { state?: string }).state)))
      throw new Error('The Worker version has unverified bindings or resource changes.');
    return { resourceDigest: this.resourceDigest, versionId: input.versionId };
  }

  async deploy(input: { resourceDigest: string; versionId: string; signal?: AbortSignal }): Promise<{ resourceDigest: string; versionId: string; deploymentId: string }> {
    if (input.resourceDigest !== this.resourceDigest || !UUID.test(input.versionId)) throw new Error('The Worker target or version does not match.');
    // GET omits tombstoned exports and cannot rule out irreversible namespace deletion. There is
    // deliberately no provider write request until that transition can be established safely.
    throw new Error('Cloudflare Worker deployment is unavailable: the full migration transition cannot be verified.');
  }
}
