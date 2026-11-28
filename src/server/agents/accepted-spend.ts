import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { ArtifactIdentity } from '../../shared/acceptance';
import { parseAgentIdentifier } from '../../shared/agent-registry';
import { canonicalJson } from '../../shared/control-state';
import { readBoundedFile } from '../bounded-file-read';
import { AcceptanceStore } from '../state/acceptance-store';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionIntent, type AcceptedActionPort, type AcceptedActionReceipt } from '../state/accepted-action';
import { SpendBudget } from '../state/spend-budget';

/**
 * `spend` — one metered charge against one owner-configured billing endpoint.
 *
 * The owner supplies the endpoint, the account identifier, the fixed currency, the bearer credential
 * and two hard caps at deployment; the model supplies only a bounded amount in minor units. No URL,
 * token, account or currency is ever chosen by the model, and none of the endpoint, credential or
 * raw provider response is returned to it.
 *
 * What the adapter does:
 *
 * - Refuses an amount above the per-charge cap, or one that would exceed the per-project cap, before
 *   any request is sent. The cap is a durable reservation ledger re-checked in the same transaction
 *   (`SpendBudget`), not an in-memory counter.
 * - Sends exactly one `POST` with a stable `Idempotency-Key` derived from the accepted artifact, the
 *   owner-fixed account and currency, and a bearer credential read from a private file outside every
 *   project root. It never follows a redirect, requires the exact JSON media type, bounds the
 *   response and never retries.
 * - Requires a provider charge id in the response. A charge is only `succeeded` when that id is
 *   present and verified; the receipt records it.
 * - Treats every non-2xx status, redirect, timeout, lost response and unverifiable body as an
 *   **unknown** outcome: the executor records `unknown`, keeps the durable intent and the cap
 *   reservation, and nothing replays automatically.
 *
 * What it does not promise: provider-side exactly-once. The idempotency key is sent, but whether the
 * provider honours it, for how long, and with what scope is the provider's own contract and is not
 * verifiable from here. This is also not a global spending cap: it bounds only charges Pilot sends
 * through this one target, and other providers, other projects and direct provider activity are
 * outside it. Revocation is checked immediately before the request; it cannot cancel a request that
 * is already in flight.
 */

/** One charge is never larger than this, whatever the owner cap says. Mirrors the approval bound. */
export const SPEND_MAX_AMOUNT_MINOR = 1_000_000_000_000;
export const SPEND_MAX_RESPONSE_BYTES = 16 * 1024;
export const SPEND_CREDENTIAL_BYTES = 4096;
export const SPEND_CHARGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const tokenPattern = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const currencyPattern = /^[A-Z]{3}$/;

/** The private credential file, relative to the data root: never inside a project root. */
export const SPEND_CREDENTIAL_PATH = 'credentials/spend-billing.json';

const credential = z.strictObject({ version: z.literal(1), token: z.string().regex(tokenPattern) });

/**
 * Read the owner-configured bearer credential. It lives beside the other Pilot credentials, must be
 * a real private file (not a symlink, no group or world access) and is never logged or returned.
 */
export async function readSpendBillingToken(dataRoot: string): Promise<string> {
  const root = resolve(dataRoot), directory = join(root, 'credentials');
  const dir = await lstat(directory).catch(() => undefined);
  if (!dir || dir.isSymbolicLink() || !dir.isDirectory()) throw new Error('The billing credential directory is unavailable; the charge was not sent.');
  const path = join(directory, 'spend-billing.json');
  const info = await lstat(path).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw new Error('The billing credential file is missing or not private; the charge was not sent.');
  let parsed;
  try { parsed = credential.safeParse(JSON.parse((await readBoundedFile(path, SPEND_CREDENTIAL_BYTES)).toString('utf8'))); }
  catch { throw new Error('The billing credential file could not be read; the charge was not sent.'); }
  if (!parsed.success) throw new Error('The billing credential file is not a recognized token; the charge was not sent.');
  return parsed.data.token;
}

/** The immutable owner-configured billing target bound into the accepted artifact (no credential). */
export function spendTargetDigest(input: { projectId: string; targetId: string; endpoint: string; accountId: string; currency: string; targetRevision: number }): string {
  if (!Number.isSafeInteger(input.targetRevision) || input.targetRevision < 1 || !currencyPattern.test(input.currency)) throw new Error('Invalid spend target.');
  return createHash('sha256').update(canonicalJson(['pilot-spend-target-v1', input.projectId, input.targetId, input.endpoint, input.accountId, input.currency, input.targetRevision])).digest('hex');
}

/**
 * Parse the owner-configured endpoint. HTTPS only, except a plain-HTTP loopback address, which is
 * what a local stub uses; credentials in the URL, query-less identity assumptions and fragments are
 * refused so the request target is exactly the configured one.
 */
export function parseSpendEndpoint(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('The billing endpoint must be an absolute HTTPS URL (HTTP is allowed only for loopback).');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('The billing endpoint is not a valid URL.'); }
  if (url.username !== '' || url.password !== '' || url.hash !== '') throw new Error('The billing endpoint must not contain credentials or a fragment.');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('The billing endpoint must use HTTPS; plain HTTP is allowed only for a loopback stub.');
  return url.toString();
}

/** The stable provider-facing idempotency key for one accepted artifact. */
export function spendIdempotencyKey(artifactRevision: string): string {
  return 'charge-' + createHash('sha256').update(artifactRevision).digest('hex');
}

export type SpendBillingTransport = {
  /** Validate that a charge could be sent at all, before any reservation or intent exists. */
  check(): Promise<void>;
  charge(input: { amountMinor: number; currency: string; idempotencyKey: string; signal?: AbortSignal }): Promise<{ providerChargeId: string }>;
};

/**
 * The real billing request. One `fetch`, no retry loop, `redirect: 'manual'` so a redirect is a
 * refusal and never a followed request. A custom fetch is not accepted: the transport security this
 * adapter claims would then be the injected transport's claim, not this code's.
 */
export class HttpBillingTransport implements SpendBillingTransport {
  private readonly endpoint: string;
  constructor(private readonly options: { endpoint: string; accountId: string; token: () => Promise<string>; timeoutMs?: number }) {
    this.endpoint = parseSpendEndpoint(options.endpoint);
    if (!SPEND_CHARGE_ID_PATTERN.test(options.accountId)) throw new Error('The billing account identifier is invalid.');
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error('The billing request timeout must be 1-120000 milliseconds.');
  }

  /**
   * Read and validate the credential before anything is reserved or admitted. An unusable credential
   * is then a refusal with no reservation and no intent, rather than an `unknown` that burns the cap.
   */
  async check(): Promise<void> {
    const token = await this.options.token();
    if (!tokenPattern.test(token)) throw new Error('The billing credential is unavailable; no charge was sent and nothing was reserved.');
  }

  async charge(input: { amountMinor: number; currency: string; idempotencyKey: string; signal?: AbortSignal }): Promise<{ providerChargeId: string }> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > SPEND_MAX_AMOUNT_MINOR || !currencyPattern.test(input.currency) || !/^charge-[a-f0-9]{64}$/.test(input.idempotencyKey))
      throw new Error('The charge is not a bounded amount, currency and idempotency key.');
    input.signal?.throwIfAborted();
    const token = await this.options.token();
    if (!tokenPattern.test(token)) throw new Error('The billing credential is unavailable; the charge was not sent.');
    input.signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          accept: 'application/json',
          'idempotency-key': input.idempotencyKey
        },
        body: JSON.stringify({ version: 1, accountId: this.options.accountId, amountMinor: input.amountMinor, currency: input.currency }),
        redirect: 'manual',
        signal
      });
    } catch { throw new Error('The billing endpoint did not confirm the charge; its outcome is unknown.'); }
    // Do not follow or accept a redirect: the request was received somewhere, but this adapter has
    // no verified charge and must not send the charge again to wherever the redirect points.
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('The billing endpoint returned a redirect; the charge outcome is unknown and was not followed.');
    if (!response.ok) throw new Error('The billing endpoint did not confirm the charge (HTTP ' + response.status + '); its outcome is unknown.');
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json' || !response.body) throw new Error('The billing endpoint did not return a JSON charge receipt; its outcome is unknown.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > SPEND_MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); throw new Error('The billing receipt is larger than the bounded response.'); }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof Error && /bounded response/.test(error.message)) throw new Error('The billing endpoint returned an oversized receipt; its outcome is unknown.');
      throw new Error('The billing receipt could not be read; the charge outcome is unknown.');
    } finally { reader.releaseLock(); }
    let receipt: unknown;
    try { receipt = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')); }
    catch { throw new Error('The billing receipt is not valid JSON; the charge outcome is unknown.'); }
    const value = receipt as { chargeId?: unknown; amountMinor?: unknown; currency?: unknown } | null;
    if (!value || typeof value !== 'object' || typeof value.chargeId !== 'string' || !SPEND_CHARGE_ID_PATTERN.test(value.chargeId) ||
        (value.amountMinor !== undefined && value.amountMinor !== input.amountMinor) || (value.currency !== undefined && value.currency !== input.currency))
      throw new Error('The billing receipt does not name a verified provider charge; its outcome is unknown.');
    // A receipt must never become a way for the provider to echo the credential back to a model.
    if (value.chargeId.includes(token)) throw new Error('The billing receipt does not name a verified provider charge; its outcome is unknown.');
    return { providerChargeId: value.chargeId };
  }
}

export type SpendCaller = { projectId: string; sessionId: string; agentId: string; authorize: () => Promise<void> };
export type AcceptedSpendOutcome =
  | { readonly status: 'succeeded'; readonly receipt: AcceptedActionReceipt; readonly operationId: string }
  | { readonly status: 'refused' | 'uncertain'; readonly operationId: string | null; readonly message: string };

function recordedReceipt(value: unknown): AcceptedActionReceipt | null {
  const receipt = value as { targetId?: unknown; artifact?: { revision?: unknown; commit?: unknown }; externalId?: unknown } | null;
  if (!receipt || typeof receipt.targetId !== 'string' || !receipt.artifact || (receipt.artifact.commit !== null && typeof receipt.artifact.commit !== 'string') ||
      typeof receipt.artifact.revision !== 'string' || typeof receipt.externalId !== 'string' || !SPEND_CHARGE_ID_PATTERN.test(receipt.externalId)) return null;
  return { targetId: receipt.targetId, artifact: { revision: receipt.artifact.revision, commit: receipt.artifact.commit as string | null }, externalId: receipt.externalId };
}

/**
 * One owner-configured spend target for one project. The artifact names the exact amount and fixed
 * currency, so an acceptance covers one charge and no other. A repeat of the same artifact is refused
 * from the durable intent before anything is sent; an unknown outcome is never replayed.
 */
export class AcceptedSpendService {
  constructor(private readonly options: {
    projectId: string; targetId: string; targetRevision: number; endpoint: string; accountId: string; currency: string;
    acceptance: AcceptanceStore; executor: AcceptedActionExecutor; budget: SpendBudget; transport: SpendBillingTransport;
  }) {
    parseAgentIdentifier(options.projectId);
    parseSpendEndpoint(options.endpoint);
    if (!currencyPattern.test(options.currency)) throw new Error('The spend currency must be three uppercase letters.');
    spendTargetDigest({ projectId: options.projectId, targetId: options.targetId, endpoint: options.endpoint, accountId: options.accountId, currency: options.currency, targetRevision: options.targetRevision });
  }

  private amount(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > SPEND_MAX_AMOUNT_MINOR) throw new Error('The charge amount must be a whole number of minor units from 1 to ' + SPEND_MAX_AMOUNT_MINOR + '.');
    return value as number;
  }

  private port(caller: SpendCaller, amountMinor: number) {
    const { projectId, targetId, targetRevision, endpoint, accountId, currency, acceptance, budget, transport } = this.options;
    if (caller.projectId !== projectId) throw new Error('The configured spend project does not match.');
    const targetDigest = spendTargetDigest({ projectId, targetId, endpoint, accountId, currency, targetRevision });
    const contentRevision = 'charge-' + currency + '-' + amountMinor;
    const artifact = targetBoundArtifact({ projectId, actionClass: 'spend', targetId, targetRevision, targetDigest, contentRevision, commit: null });
    const checkAuthority = async () => {
      await caller.authorize();
      if (spendTargetDigest({ projectId, targetId, endpoint, accountId, currency, targetRevision }) !== targetDigest) throw new Error('The spend target changed.');
      await caller.authorize();
    };
    const effect: AcceptedActionPort = {
      authorize: async (intent: AcceptedActionIntent) => {
        await checkAuthority();
        const view = await acceptance.readEvidence({ projectId, evidenceId: intent.evidenceId });
        await checkAuthority();
        if (!view.acceptance || intent.agentId !== caller.agentId || intent.sessionId !== caller.sessionId) throw new Error('The session acceptance is unavailable.');
        return { allowed: true, acceptance: view.acceptance, policy: acceptance.readPolicy() };
      },
      check: async (intent: AcceptedActionIntent) => {
        if (intent.actionClass !== 'spend' || intent.targetId !== targetId || intent.targetRevision !== targetRevision || intent.targetDigest !== targetDigest ||
            intent.contentRevision !== contentRevision || intent.artifact.revision !== artifact.revision || intent.artifact.commit !== null || intent.resourceKey !== undefined)
          throw new Error('The spend intent is not the accepted target and amount.');
        await checkAuthority();
        // A credential this instance cannot use is refused before the cap is touched, so a certain
        // no-send can never look like an uncertain charge that consumed the project's budget.
        await transport.check();
        // The durable reservation is the hard cap and the per-charge idempotency barrier. It is
        // taken before the action intent is admitted, so an over-cap charge never becomes an intent.
        budget.reserve({ projectId, artifactRevision: intent.artifact.revision, amountMinor, currency });
        await checkAuthority();
      },
      execute: async (intent: AcceptedActionIntent, signal: AbortSignal | undefined, revalidate: () => Promise<void>) => {
        signal?.throwIfAborted(); await checkAuthority(); await revalidate(); signal?.throwIfAborted();
        const receipt = await transport.charge({ amountMinor, currency, idempotencyKey: spendIdempotencyKey(intent.artifact.revision), signal });
        if (!receipt || !SPEND_CHARGE_ID_PATTERN.test(receipt.providerChargeId)) throw new Error('The billing receipt could not be verified.');
        return { targetId, artifact, externalId: receipt.providerChargeId };
      }
    };
    return { targetDigest, contentRevision, artifact, checkAuthority, effect };
  }

  async preview(input: SpendCaller & { amountMinor: number }) {
    const amountMinor = this.amount(input.amountMinor), port = this.port(input, amountMinor);
    await port.checkAuthority();
    const committedMinor = this.options.budget.total(this.options.projectId), remainingMinor = this.options.budget.remaining(this.options.projectId);
    return {
      artifact: port.artifact,
      contentRevision: port.contentRevision,
      target: { id: this.options.targetId, revision: this.options.targetRevision, digest: port.targetDigest },
      amountMinor,
      currency: this.options.currency,
      projectCapMinor: this.options.budget.limits.projectCapMinor,
      chargeCapMinor: this.options.budget.limits.chargeCapMinor,
      committedMinor,
      remainingMinor,
      exceedsChargeCap: amountMinor > this.options.budget.limits.chargeCapMinor,
      exceedsProjectCap: amountMinor > remainingMinor
    };
  }

  async spend(input: SpendCaller & { amountMinor: number; evidenceId: string; acceptanceId: string; artifact: ArtifactIdentity; signal?: AbortSignal }): Promise<AcceptedSpendOutcome> {
    if (input.projectId !== this.options.projectId) throw new Error('The configured spend project does not match.');
    input.signal?.throwIfAborted();
    const amountMinor = this.amount(input.amountMinor), port = this.port(input, amountMinor);
    await port.checkAuthority();
    const recorded = this.options.executor.find({ projectId: this.options.projectId, artifact: input.artifact });
    if (recorded !== null) {
      // Never send a second request for the same accepted charge, whatever the earlier state is.
      const receipt = recorded.state === 'succeeded' ? recordedReceipt(recorded.receipt) : null;
      if (receipt !== null) return { status: 'refused', operationId: recorded.operationId, message: 'This exact charge already succeeded (provider charge ' + receipt.externalId + '); it was not sent again.' };
      return recorded.state === 'pending' || recorded.state === 'unknown'
        ? { status: 'uncertain', operationId: recorded.operationId, message: 'An earlier attempt for this exact charge may have happened. Inspect the durable intent and the provider; do not retry automatically.' }
        : { status: 'refused', operationId: recorded.operationId, message: 'This exact charge already has a durable intent that is not a verified success; it was not sent again. Inspect it before doing anything else.' };
    }
    const result = await this.options.executor.run({
      projectId: this.options.projectId, sessionId: input.sessionId, agentId: input.agentId, evidenceId: input.evidenceId, acceptanceId: input.acceptanceId,
      actionClass: 'spend', targetId: this.options.targetId, targetRevision: this.options.targetRevision, targetDigest: port.targetDigest,
      contentRevision: port.contentRevision, artifact: input.artifact
    }, port.effect, input.signal);
    // A repeat never reaches this point with a new request: it is answered from the durable intent
    // above, so there is deliberately no "repeated success" result for a charge.
    return result;
  }
}
