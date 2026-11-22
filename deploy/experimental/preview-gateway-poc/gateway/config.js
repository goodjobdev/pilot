/** Assemble the gateway core configuration from the reviewed environment. */
export const RESERVED_LISTENER_PORTS = [22, 443, 4319];

function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`required environment variable ${name} is unset`);
  return value;
}

export function parsePorts(value, { listeners }) {
  const parts = String(value ?? '').split(',').map((part) => part.trim());
  const ports = parts.map((part) => (/^[0-9]{1,5}$/.test(part) ? Number(part) : NaN));
  if (!parts.length || parts.some((part) => !/^[0-9]{1,5}$/.test(part)) ||
      ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
      new Set(ports).size !== ports.length) {
    throw new Error('port list must be distinct numeric ports');
  }
  if (listeners) {
    if (ports.length > 32 || ports.some((port) => port < 1024 || RESERVED_LISTENER_PORTS.includes(port))) {
      throw new Error('listener ports must be unprivileged, distinct and not reserved');
    }
  }
  return ports;
}

/**
 * Build the createGateway options. `previewPorts` is the listener set the Go
 * ingress binds (same env var), so the core can never hand out a port the
 * ingress is not listening on.
 */
export function buildGatewayConfig(env) {
  const allowedPorts = parsePorts(required(env, 'PREVIEW_ALLOWED_PORTS'), { listeners: false });
  const previewPorts = parsePorts(required(env, 'PREVIEW_PORTS'), { listeners: true });
  const ownerIds = required(env, 'TAILNET_ALLOWED_REMOTE_NODE_IDS').split(',').map((value) => value.trim());
  return {
    owner: required(env, 'TAILNET_OWNER_LOGIN'),
    ownerDeviceIds: ownerIds,
    excludedNodeIds: [required(env, 'TAILNET_GATEWAY_NODE_ID'), required(env, 'TAILNET_HOST_NODE_ID')],
    controlHost: required(env, 'PREVIEW_CONTROL_HOST'),
    previewDomain: required(env, 'PREVIEW_DOMAIN'),
    previewPorts,
    dashboardOrigin: required(env, 'DASHBOARD_ORIGIN'),
    containerAddress: required(env, 'PREVIEW_PRIVATE_IPV4'),
    allowedPorts,
  };
}
