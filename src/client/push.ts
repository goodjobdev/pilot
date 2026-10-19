import { api } from './api';

export type AlertState = 'unsupported' | 'blocked' | 'off' | 'on';

export function alertsSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

function applicationServerKey(value: string): ArrayBuffer {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js');
}

/** Whether this device already holds a subscription for this instance. */
export async function alertState(): Promise<AlertState> {
  if (!alertsSupported()) return 'unsupported';
  const existing = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await existing?.pushManager.getSubscription();
  if (subscription) return 'on';
  return Notification.permission === 'denied' ? 'blocked' : 'off';
}

/**
 * Asks the browser for permission and registers this device, then tells the instance.
 * Browsers require a user gesture for the permission prompt, which is why this is called
 * from the button rather than on load.
 */
export async function enableAlerts(): Promise<{ count: number }> {
  if (!alertsSupported()) throw new Error('This browser cannot receive push alerts');
  const status = await api.alerts();
  if (!status.enabled || !status.publicKey) throw new Error('This instance has no alert keys yet');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed on this device');
  const worker = await registration();
  const subscription = await worker.pushManager.getSubscription()
    ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(status.publicKey) });
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser returned an incomplete subscription');
  return api.subscribeAlerts({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
}

export async function disableAlerts(): Promise<{ count: number }> {
  const worker = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await worker?.pushManager.getSubscription();
  if (!subscription) return { count: (await api.alerts()).subscriptions };
  const result = await api.unsubscribeAlerts(subscription.endpoint);
  await subscription.unsubscribe();
  return result;
}

/** Opens the interface at the project an alert pointed at, when the worker asks for it. */
export function onAlertNavigation(handler: (url: string) => void): () => void {
  if (!alertsSupported()) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === 'dashboard-alert' && typeof data.url === 'string') handler(data.url);
  };
  navigator.serviceWorker.addEventListener('message', listener);
  return () => navigator.serviceWorker.removeEventListener('message', listener);
}
