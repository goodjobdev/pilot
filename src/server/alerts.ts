import { mkdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import { atomicWrite,HttpError } from './board-store';

export interface AlertSubscription { endpoint: string; keys: { p256dh: string; auth: string }; created: string }
export interface AlertPayload { title: string; body: string; url: string; tag: string }
export type AlertTransport = (subscription: AlertSubscription,payload: AlertPayload)=>Promise<void>;

const maxSubscriptions = 20;
const defaultCooldownMs = 10000;

function validSubscription(value: unknown): value is AlertSubscription {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof candidate.endpoint !== 'string' || candidate.endpoint.length > 2000) return false;
  if (!/^https:\/\//.test(candidate.endpoint)) return false;
  const keys = candidate.keys;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false;
  return keys.p256dh.length > 20 && keys.p256dh.length <= 200 && keys.auth.length > 8 && keys.auth.length <= 100;
}

/**
 * Phone alerts.
 *
 * Holds the VAPID key pair and the devices that asked for notifications, and sends
 * short payloads that never contain document text — only which project needs a person
 * and where to go. Keys live beside the data (0600) and are never logged.
 */
export class AlertStore {
  private vapid: { publicKey: string; privateKey: string } | null = null;
  private subscriptions = new Map<string, AlertSubscription>();
  private lastSent = new Map<string, number>();
  constructor(private readonly dataRoot: string,private readonly options: { subject?: string; transport?: AlertTransport; cooldownMs?: number } = {}) {}
  private paths() {
    const dir = join(this.dataRoot,'alerts');
    return { dir, keys: join(dir,'vapid.json'), subscriptions: join(dir,'subscriptions.json') };
  }
  get enabled(): boolean { return this.vapid !== null; }
  get publicKey(): string | null { return this.vapid?.publicKey ?? null; }
  get count(): number { return this.subscriptions.size; }
  /** Loads or creates the key pair and the subscription list. */
  async init(): Promise<void> {
    const { dir, keys, subscriptions } = this.paths();
    await mkdir(dir,{ recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await readFile(keys,'utf8')) as { publicKey?: unknown; privateKey?: unknown };
      if (typeof stored.publicKey === 'string' && typeof stored.privateKey === 'string') this.vapid = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    } catch {
      const generated = webpush.generateVAPIDKeys();
      this.vapid = { publicKey: generated.publicKey, privateKey: generated.privateKey };
      await atomicWrite(keys,JSON.stringify(this.vapid));
    }
    try {
      const stored = JSON.parse(await readFile(subscriptions,'utf8')) as { subscriptions?: unknown };
      if (Array.isArray(stored.subscriptions)) for (const entry of stored.subscriptions) if (validSubscription(entry)) this.subscriptions.set(entry.endpoint,entry);
    } catch {
      await atomicWrite(subscriptions,JSON.stringify({ subscriptions: [] }));
    }
  }
  private async persist(): Promise<void> {
    await atomicWrite(this.paths().subscriptions,JSON.stringify({ subscriptions: [...this.subscriptions.values()] },null,2));
  }
  async subscribe(input: unknown): Promise<{ count: number }> {
    if (!validSubscription(input)) throw new HttpError(400,'A push subscription needs an HTTPS endpoint and its keys');
    if (this.subscriptions.size >= maxSubscriptions && !this.subscriptions.has(input.endpoint)) throw new HttpError(429,'Too many alert devices');
    this.subscriptions.set(input.endpoint,{ endpoint: input.endpoint, keys: input.keys, created: new Date().toISOString() });
    await this.persist();
    return { count: this.subscriptions.size };
  }
  async unsubscribe(endpoint: unknown): Promise<{ count: number }> {
    if (typeof endpoint !== 'string') throw new HttpError(400,'An endpoint is required');
    if (this.subscriptions.delete(endpoint)) await this.persist();
    return { count: this.subscriptions.size };
  }
  /**
   * Sends one payload to every device. A device the push service reports as gone is
   * dropped rather than retried forever, and the optional key throttles repeats of the
   * same kind of event for one project.
   */
  async notify(payload: AlertPayload,options: { key?: string } = {}): Promise<{ sent: number; failed: number; skipped: boolean }> {
    if (!this.enabled || this.subscriptions.size === 0) return { sent: 0, failed: 0, skipped: true };
    const cooldown = this.options.cooldownMs ?? defaultCooldownMs;
    if (options.key) {
      const previous = this.lastSent.get(options.key) ?? 0;
      if (Date.now() - previous < cooldown) return { sent: 0, failed: 0, skipped: true };
      this.lastSent.set(options.key,Date.now());
    }
    const send = this.options.transport ?? this.defaultTransport();
    let sent = 0,failed = 0,removed = false;
    for (const subscription of [...this.subscriptions.values()]) {
      try { await send(subscription,payload); sent += 1; }
      catch (error) {
        failed += 1;
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) { this.subscriptions.delete(subscription.endpoint); removed = true; }
      }
    }
    if (removed) await this.persist();
    return { sent, failed, skipped: false };
  }
  private defaultTransport(): AlertTransport {
    const vapid = this.vapid;
    if (!vapid) throw new HttpError(503,'Alerts are not configured');
    const subject = this.options.subject ?? 'mailto:owner@localhost';
    return async (subscription,payload) => {
      await webpush.sendNotification(subscription as unknown as webpush.PushSubscription,JSON.stringify(payload),{
        vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 3600
      });
    };
  }
}
