import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isIPv4 } from 'node:net';
import { hostedConfig, localConfig, type SecurityConfig } from './security';

export type DashboardMode = 'local' | 'hosted';
export type DashboardExposure = 'host-loopback' | 'container-private-interface';

export interface EffectiveConfig {
  readonly mode: DashboardMode;
  readonly port: number;
  readonly origin: string;
  readonly allowedHosts: readonly [string];
  readonly exposure: DashboardExposure;
  readonly bindHost: '127.0.0.1' | '0.0.0.0';
  readonly dataRoot: string;
  readonly browseRoots: readonly string[];
  readonly security: Readonly<SecurityConfig>;
}

export interface EffectiveConfigDiagnostics {
  readonly configured: Readonly<{ host: string; exposure: DashboardExposure; bind: string }>;
  readonly effective: Readonly<{ host: string; exposure: DashboardExposure; bind: string }>;
  readonly known: Readonly<{
    mode: DashboardMode;
    canonicalOriginValidated: true;
    listenerLiteralValidated: true;
    hostPolicy: 'exact-canonical-origin';
  }>;
  readonly attested: Readonly<{
    surroundingNetworkSafety: 'operator-attested-not-inferred';
  }>;
}

/**
 * Parse all startup policy before callers open stores or perform filesystem work.
 * The surrounding network topology is deliberately not inferred from the listener.
 */
export function effectiveConfig(env: NodeJS.ProcessEnv): EffectiveConfig {
  const modeValue = env.DASHBOARD_MODE;
  if (modeValue !== 'local' && modeValue !== 'hosted') {
    throw new Error('Set DASHBOARD_MODE explicitly to local or hosted');
  }
  const mode: DashboardMode = modeValue;
  const portText = env.PORT ?? '4317';
  if (!/^[0-9]+$/.test(portText)) throw new Error('Invalid port');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');

  const exposureValue = env.DASHBOARD_EXPOSURE ?? 'host-loopback';
  if (exposureValue !== 'host-loopback' && exposureValue !== 'container-private-interface') {
    throw new Error('DASHBOARD_EXPOSURE must be host-loopback or container-private-interface');
  }
  const exposure: DashboardExposure = exposureValue;

  let security: SecurityConfig;
  if (mode === 'local') {
    const identityVariables = ['DASHBOARD_ORIGIN', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD', 'DASHBOARD_OWNER'];
    const contradictory = identityVariables.filter(name => env[name] !== undefined);
    if (contradictory.length) throw new Error('Hosted identity settings are not allowed in local mode');
    if (exposure !== 'host-loopback') throw new Error('Local mode requires host-loopback exposure');
    security = localConfig(new URL('http://127.0.0.1:' + port).origin);
  } else {
    // hostedConfig supplies the existing hosted identity/origin validation and creates the
    // ordinary per-process session secret. It performs no filesystem or provider operation.
    security = hostedConfig(env);
  }

  const originUrl = new URL(security.origin);
  if (originUrl.origin !== security.origin || originUrl.username || originUrl.password ||
      (mode === 'local' && (originUrl.protocol !== 'http:' || originUrl.hostname !== '127.0.0.1')) ||
      (mode === 'hosted' && originUrl.protocol !== 'https:')) {
    throw new Error('Dashboard origin must be a canonical origin for the selected mode');
  }

  const bindValue = env.DASHBOARD_BIND ?? '127.0.0.1';
  if (!isIPv4(bindValue) || bindValue.split('.').some(part => String(Number(part)) !== part)) {
    throw new Error('DASHBOARD_BIND must be a canonical IPv4 literal; IPv6 and hostnames are not supported');
  }
  if (exposure === 'host-loopback' && bindValue !== '127.0.0.1') {
    throw new Error('host-loopback exposure requires DASHBOARD_BIND=127.0.0.1');
  }
  if (exposure === 'container-private-interface' &&
      (mode !== 'hosted' || bindValue !== '0.0.0.0')) {
    throw new Error('container-private-interface requires hosted mode and DASHBOARD_BIND=0.0.0.0');
  }

  const host = originUrl.host;
  if (env.DASHBOARD_ALLOWED_HOSTS !== undefined && env.DASHBOARD_ALLOWED_HOSTS !== host) {
    throw new Error('DASHBOARD_ALLOWED_HOSTS must be the exact canonical origin host');
  }

  const dataValue = env.DASHBOARD_DATA ?? resolve(homedir(), '.local/share/project-dashboard');
  if (!dataValue || dataValue.includes('\0')) throw new Error('DASHBOARD_DATA must be a valid path');
  const dataRoot = resolve(dataValue);
  const browseRoots = (env.DASHBOARD_ROOTS ?? '').split(':').filter(Boolean).map(path => {
    if (path.includes('\0')) throw new Error('DASHBOARD_ROOTS contains an invalid path');
    return resolve(path);
  });

  const immutableSecurity = Object.freeze({ ...security });
  return Object.freeze({
    mode,
    port,
    origin: security.origin,
    allowedHosts: Object.freeze([host]) as readonly [string],
    exposure,
    bindHost: bindValue as EffectiveConfig['bindHost'],
    dataRoot,
    browseRoots: Object.freeze(browseRoots),
    security: immutableSecurity
  });
}

/** Secret-free, app-known diagnostics; network controls remain operator-attested facts. */
export function diagnosticProjection(config: EffectiveConfig): EffectiveConfigDiagnostics {
  const host = new URL(config.origin).host;
  return Object.freeze({
    configured: Object.freeze({ host, exposure: config.exposure, bind: config.bindHost }),
    effective: Object.freeze({ host: config.allowedHosts[0], exposure: config.exposure, bind: config.bindHost }),
    known: Object.freeze({
      mode: config.mode,
      canonicalOriginValidated: true,
      listenerLiteralValidated: true,
      hostPolicy: 'exact-canonical-origin'
    }),
    attested: Object.freeze({ surroundingNetworkSafety: 'operator-attested-not-inferred' })
  });
}
