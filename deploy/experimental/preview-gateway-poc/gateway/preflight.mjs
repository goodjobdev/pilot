import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import psl from 'psl';

const allowedEnvironment = new Set([
  'HOME', 'NODE_ENV', 'PATH', 'HOSTNAME',
  'GATEWAY_SERVICE_UID', 'PILOT_SERVICE_UID', 'TSNET_STATE_DIR', 'TSNET_HOSTNAME',
  'TAILNET_OWNER_LOGIN', 'TAILNET_GATEWAY_NODE_ID', 'TAILNET_HOST_NODE_ID', 'TAILNET_ALLOWED_REMOTE_NODE_IDS',
  'INGRESS_ASSERTION_KEY_FILE', 'INGRESS_ASSERTION_PUBLIC_KEY_FILE', 'PREVIEW_CORE_SOCKET',
  'PREVIEW_DOMAIN', 'PREVIEW_PORTS', 'PREVIEW_CONTROL_HOST',
  'DASHBOARD_ORIGIN', 'PREVIEW_PRIVATE_IPV4', 'PREVIEW_ALLOWED_PORTS', 'PREVIEW_SITE_REVIEWED', 'PREVIEW_PORTS_REVIEWED',
]);
function privateIPv4(address) {
  const octets = address.split('.').map(Number);
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254);
}

const required = [
  'GATEWAY_SERVICE_UID', 'PILOT_SERVICE_UID', 'TSNET_STATE_DIR', 'TSNET_HOSTNAME',
  'TAILNET_OWNER_LOGIN', 'TAILNET_GATEWAY_NODE_ID', 'TAILNET_HOST_NODE_ID', 'TAILNET_ALLOWED_REMOTE_NODE_IDS',
  'INGRESS_ASSERTION_KEY_FILE', 'INGRESS_ASSERTION_PUBLIC_KEY_FILE', 'PREVIEW_CORE_SOCKET',
  'PREVIEW_DOMAIN', 'PREVIEW_PORTS', 'PREVIEW_CONTROL_HOST',
  'DASHBOARD_ORIGIN', 'PREVIEW_PRIVATE_IPV4', 'PREVIEW_ALLOWED_PORTS',
];

export function validateRuntimeConfig(env, { uid = process.getuid?.(), stat = fs.lstatSync } = {}) {
  for (const name of Object.keys(env)) {
    if ((/SECRET|PASSWORD|TOKEN|CREDENTIAL|PRIVATE_KEY/i.test(name) && !name.endsWith('_FILE')) || !allowedEnvironment.has(name)) {
      throw new Error(`environment variable ${name} is not permitted; pass key material through protected files`);
    }
  }
  for (const name of required) if (!String(env[name] ?? '').trim()) throw new Error(`required environment variable ${name} is unset`);
  const serviceUid = Number(env.GATEWAY_SERVICE_UID);
  const pilotUid = Number(env.PILOT_SERVICE_UID);
  if (!Number.isInteger(serviceUid) || serviceUid !== uid || serviceUid <= 0 || !Number.isInteger(pilotUid) || pilotUid <= 0 || pilotUid === serviceUid) throw new Error('gateway runtime UID must match configured non-root UID and differ from Pilot UID');
  if (env.PREVIEW_SITE_REVIEWED !== 'true') throw new Error('review and certify preview/control/dashboard site isolation before startup');
  if (env.PREVIEW_PORTS_REVIEWED !== 'true') throw new Error('review and certify the preview port allowlist before startup');
  if ([env.PREVIEW_CONTROL_HOST, env.PREVIEW_DOMAIN].some((host) => host.includes(':') || /[\s/]/.test(host))) throw new Error('control host and preview node name must be bare hostnames');
  // Previews are served on the gateway's own tailnet name, one port each.
  if (!env.PREVIEW_DOMAIN.toLowerCase().endsWith('.ts.net')) throw new Error('PREVIEW_DOMAIN must be the gateway node tailnet name');
  const listenerPorts = env.PREVIEW_PORTS.split(',').map((part) => part.trim());
  if (!listenerPorts.length || listenerPorts.length > 32 ||
      listenerPorts.some((port) => !/^[0-9]{4,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || ['443','4319','22'].includes(port)) ||
      new Set(listenerPorts).size !== listenerPorts.length) throw new Error('PREVIEW_PORTS must be distinct unprivileged listener ports');
  const registrableSite = (host) => {
    const parsed = psl.parse(host);
    if (parsed.error || !parsed.listed || !parsed.domain || !parsed.tld) throw new Error('control, preview, and dashboard must use recognized public suffixes');
    return parsed.domain;
  };
  let dashboard;
  try { dashboard = new URL(env.DASHBOARD_ORIGIN); } catch { throw new Error('DASHBOARD_ORIGIN must be an exact HTTPS origin'); }
  if (dashboard.protocol !== 'https:' || !dashboard.hostname || dashboard.username || dashboard.password || dashboard.pathname !== '/' || dashboard.search || dashboard.hash || dashboard.origin === 'null' || env.DASHBOARD_ORIGIN !== dashboard.origin) throw new Error('DASHBOARD_ORIGIN must be an exact HTTPS origin');
  if (registrableSite(env.PREVIEW_CONTROL_HOST.toLowerCase()) === registrableSite(env.PREVIEW_DOMAIN.toLowerCase()) || registrableSite(dashboard.hostname.toLowerCase()) === registrableSite(env.PREVIEW_DOMAIN.toLowerCase())) throw new Error('preview registrable site must differ from control and dashboard sites');
  const ports = env.PREVIEW_ALLOWED_PORTS.split(',').map((part) => part.trim());
  if (!ports.length || ports.some((port) => !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) || new Set(ports).size !== ports.length) throw new Error('PREVIEW_ALLOWED_PORTS must be an explicit unique numeric allowlist');
  const ids = env.TAILNET_ALLOWED_REMOTE_NODE_IDS.split(',').map((part) => part.trim());
  if (env.TAILNET_GATEWAY_NODE_ID === env.TAILNET_HOST_NODE_ID || !ids.length || ids.some((id) => !id) || new Set(ids).size !== ids.length || ids.includes(env.TAILNET_GATEWAY_NODE_ID) || ids.includes(env.TAILNET_HOST_NODE_ID)) throw new Error('reviewed remote node allowlist is invalid or includes an excluded node');
  if (net.isIP(env.PREVIEW_PRIVATE_IPV4) !== 4 || !privateIPv4(env.PREVIEW_PRIVATE_IPV4) || env.PREVIEW_PRIVATE_IPV4 !== '127.0.0.1') throw new Error('PREVIEW_PRIVATE_IPV4 must be 127.0.0.1 in the shared dashboard namespace');
  for (const [label, input, directory] of [
    ['tsnet state directory', env.TSNET_STATE_DIR, true],
    ['assertion private key', env.INGRESS_ASSERTION_KEY_FILE, false],
    ['preview core socket', env.PREVIEW_CORE_SOCKET, false],
  ]) {
    if (!path.isAbsolute(input) || input.includes('\0')) throw new Error(`${label} path must be absolute`);
    const target = directory ? input : path.dirname(input);
    const info = stat(target);
    if (!info.isDirectory() || (info.mode & 0o170000) !== 0o040000) throw new Error(`${label} parent must be a real directory`);
    if (target === input && (info.uid !== serviceUid || (info.mode & 0o777) !== 0o700)) throw new Error('tsnet state directory must be service-owned mode 0700');
    if (target !== input && ((info.uid !== serviceUid) || (info.mode & 0o077) !== 0)) throw new Error(`${label} parent must be service-owned and inaccessible to group/other`);
  }
  return true;
}
