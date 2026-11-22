import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import psl from 'psl';

const MANAGEMENT_JS = readFileSync(new URL('./management-ui.js', import.meta.url), 'utf8');
const MANAGEMENT_CSS = 'body{font:1rem system-ui,sans-serif;line-height:1.5;margin:2rem auto;padding:0 1rem;max-width:48rem;color:#172033}form,li{display:flex;gap:.8rem;align-items:center;flex-wrap:wrap;margin:.8rem 0}button,select{font:inherit;padding:.4rem .7rem}#status{min-height:1.5em}a:focus,button:focus,select:focus{outline:3px solid #175cd3;outline-offset:2px}';
const MANAGEMENT_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'";

function registrableSite(host) {
  const parsed = psl.parse(host);
  if (parsed.error || !parsed.listed || !parsed.domain || !parsed.tld) throw new Error('controlHost, previewDomain, and dashboard origin must use recognized public suffixes');
  return parsed.domain;
}

function dashboardRegistrableSite(origin) {
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch { throw new Error('DASHBOARD_ORIGIN must be a valid HTTPS origin'); }
  if (parsedOrigin.protocol !== 'https:' || !parsedOrigin.hostname || parsedOrigin.username || parsedOrigin.password ||
      parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.origin === 'null' || origin !== parsedOrigin.origin) {
    throw new Error('DASHBOARD_ORIGIN must be a valid HTTPS origin');
  }
  return registrableSite(parsedOrigin.hostname.toLowerCase());
}

const ASSERTION_HEADER = 'x-pilot-ingress-assertion';
const MAX_BODY = 4096;
const MAX_HEADER_BYTES = 16 * 1024;

function privateIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const n = address.split('.').map(Number);
  return n[0] === 10 || n[0] === 127 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
    (n[0] === 192 && n[1] === 168) || (n[0] === 169 && n[1] === 254);
}

function cleanPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(path)) return null;
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  if (decoded.split('/').some((part) => part === '.' || part === '..') || decoded.includes('\\')) return null;
  return path;
}

function trustedHeaders(incoming, upgrade = false) {
  const headers = {};
  for (const key of ['accept', 'accept-language', 'content-type', 'user-agent', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    if (incoming.headers[key] && (!upgrade || key.startsWith('sec-websocket-'))) headers[key] = incoming.headers[key];
  }
  if (upgrade) headers.connection = 'Upgrade', headers.upgrade = 'websocket';
  return headers;
}

/**
 * Create a tailnet-only preview gateway core. `verifyPeer` must resolve the socket's
 * actual remote address to a cryptographically verified tailnet identity; headers are
 * intentionally never consulted. This core does not itself implement Tailscale/tsnet.
 */
export function createGateway({
  owner, ownerDeviceIds, excludedNodeIds, controlHost, previewDomain, previewPorts, dashboardOrigin, containerAddress, allowedPorts, verifyPeer,
  ttlMs = 10 * 60_000, maxRoutes = 64, wsHandshakeTimeoutMs = 10_000, now = Date.now,
  assertionVerifier = null, privateSocketOnly = false, verifyPrivateSource = null,
}) {
  if (!owner || !controlHost || !previewDomain || !dashboardOrigin || controlHost.includes(':') || previewDomain.includes(':') || /[\s/]/.test(controlHost) || /[\s/]/.test(previewDomain)) throw new Error('invalid controlHost, previewDomain, or dashboardOrigin');
  // Previews are selected by port on the gateway node's own tailnet name, so the
  // listener set is explicit, unprivileged and bounded.
  if (!Array.isArray(previewPorts) || !previewPorts.length || previewPorts.length > 32 ||
      previewPorts.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535 || [22, 443, 4319].includes(p)) ||
      new Set(previewPorts).size !== previewPorts.length) throw new Error('previewPorts must be distinct unprivileged listener ports');
  const controlSite = registrableSite(controlHost.toLowerCase());
  const previewSite = registrableSite(previewDomain.toLowerCase());
  const dashboardSite = dashboardRegistrableSite(dashboardOrigin);
  if (controlSite === previewSite || dashboardSite === previewSite) throw new Error('preview must use a different browser site from control and dashboard');
  if (!privateIPv4(containerAddress)) throw new Error('containerAddress must be a private IPv4 address');
  if (typeof verifyPeer !== 'function' && !assertionVerifier) throw new Error('a tailnet peer verifier or ingress assertion verifier is required');
  if (privateSocketOnly && typeof verifyPrivateSource !== 'function') throw new Error('private socket mode requires exact peer credential verification');
  if (!Array.isArray(ownerDeviceIds) || ownerDeviceIds.length === 0 || ownerDeviceIds.some((id) => typeof id !== 'string' || !id)) throw new Error('explicit ownerDeviceIds are required');
  if (!Array.isArray(excludedNodeIds) || excludedNodeIds.length < 2 || excludedNodeIds.some((id) => typeof id !== 'string' || !id) || new Set(excludedNodeIds).size < 2) throw new Error('excludedNodeIds must explicitly list distinct Oracle and gateway node IDs');
  if (ownerDeviceIds.some((id) => excludedNodeIds.includes(id))) throw new Error('ownerDeviceIds must exclude gateway/Oracle node IDs');
  if (!Array.isArray(allowedPorts) || !allowedPorts.length || allowedPorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('allowedPorts must be explicit numeric ports');
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60 * 60_000) throw new Error('ttlMs must be from 1s to 1h');
  if (!Number.isInteger(wsHandshakeTimeoutMs) || wsHandshakeTimeoutMs < 100 || wsHandshakeTimeoutMs > 10_000) throw new Error('wsHandshakeTimeoutMs must be from 100ms to 10s');

  const routes = new Map();
  const controlHostname = controlHost.toLowerCase();
  const previewHost = previewDomain.toLowerCase();
  const controlOrigin = `https://${controlHostname}`;

  async function peer(req) {
    if (assertionVerifier) {
      // Unix-domain sockets have no IP remoteAddress; TCP requests cannot use
      // this path. Deployment must listen only on a mode-0600 private socket.
      let privateSource = false;
      if (privateSocketOnly && req.socket.remoteAddress === undefined) {
        try { privateSource = verifyPrivateSource(req.socket) === true; } catch { privateSource = false; }
      }
      const result = assertionVerifier.verifyRequest(req, privateSource);
      return result ? { name: result.login, nodeId: result.nodeId } : null;
    }
    // Only the socket endpoint is passed. Never trust X-Forwarded-For or identity headers.
    const result = await verifyPeer(req.socket.remoteAddress);
    if (!result || typeof result.name !== 'string' || typeof result.nodeId !== 'string' || !result.nodeId) return null;
    return result;
  }
  function fail(res, status, message) {
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  }
  function hostAndOriginValid(req, expectedHost, expectedOrigin, originRequired) {
    if (typeof req.headers.host !== 'string' || req.headers.host.toLowerCase() !== expectedHost) return false;
    if (req.headers.origin === undefined) return !originRequired;
    return req.headers.origin === expectedOrigin;
  }
  function closeRoute(route) {
    clearTimeout(route.expiryTimer);
    for (const socket of route.connections) socket.destroy();
    route.connections.clear();
  }
  function removeRoute(id) {
    const route = routes.get(id);
    if (route) { routes.delete(id); closeRoute(route); }
  }
  function routeForHost(host) {
    for (const [id, route] of routes) {
      if (route.host === host) {
        if (route.expiresAt <= now()) { removeRoute(id); return null; }
        return route;
      }
    }
    return null;
  }
  async function body(req) {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY) throw new Error('body too large');
    }
    return JSON.parse(data || '{}');
  }
  function ownerAllowed(identity) { return identity?.name === owner && ownerDeviceIds.includes(identity.nodeId) && !excludedNodeIds.includes(identity.nodeId); }

  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES, headersTimeout: 10_000, requestTimeout: 30_000 }, async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://gateway.invalid').pathname;
      const controlPath = pathname.startsWith('/__gateway/');
      const managementAssetPath = pathname === '/' || pathname === '/management.js' || pathname === '/management.css';
      const isManagement = req.headers.host?.toLowerCase() === controlHostname && (controlPath || managementAssetPath);
      // A local owner action over the mode-0600 private socket (same service UID,
      // verified by SO_PEERCRED) authenticates management only; it never grants
      // preview traffic, which always requires a signed ingress assertion.
      const localOwner = isManagement && privateSocketOnly && req.socket.remoteAddress === undefined &&
        typeof verifyPrivateSource === 'function' && verifyPrivateSource(req.socket) === true &&
        !req.headers[ASSERTION_HEADER];
      const identity = localOwner ? { name: owner, nodeId: ownerDeviceIds[0] } : await peer(req);
      if (!ownerAllowed(identity)) return fail(res, 403, 'tailnet owner required');
      if (controlPath && !isManagement) return fail(res, 404, 'management route not found');
      let previewRoute = null;
      if (isManagement) {
        const safeMethod = req.method === 'GET' || req.method === 'HEAD';
        if (!hostAndOriginValid(req, controlHostname, controlOrigin, !safeMethod)) return fail(res, 403, 'invalid management host or origin');
      } else {
        previewRoute = routeForHost(req.headers.host?.toLowerCase());
        if (!previewRoute) return fail(res, 404, 'route not found or expired');
        const safeMethod = req.method === 'GET' || req.method === 'HEAD';
        if (!hostAndOriginValid(req, previewRoute.host, previewRoute.origin, !safeMethod)) return fail(res, 403, 'invalid preview host or origin');
      }
      if (isManagement && pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        const options = allowedPorts.map((port) => `<option value="${port}">${port}</option>`).join('');
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pilot preview management</title><link rel="stylesheet" href="/management.css"></head><body><main><h1>Preview management</h1><p>Choose an approved local port. This creates a temporary preview route only; no command is run.</p><form id="route-form"><label for="port">Allowed port</label><select id="port" name="port" required>${options}</select><button type="submit">Create preview</button></form><p id="status" role="status" aria-live="polite"></p><h2>Active previews</h2><ul id="routes"></ul></main><script type="module" src="/management.js"></script></body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': MANAGEMENT_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      if (isManagement && pathname === '/management.js' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': MANAGEMENT_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        return res.end(req.method === 'HEAD' ? undefined : MANAGEMENT_JS);
      }
      if (isManagement && pathname === '/management.css' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': MANAGEMENT_CSP, 'x-content-type-options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : MANAGEMENT_CSS);
      }
      if (pathname === '/__gateway/routes' && req.method === 'POST') {
        if (req.headers['x-gateway-csrf'] !== 'same-origin' || req.headers['content-type'] !== 'application/json') return fail(res, 403, 'CSRF check failed');
        const input = await body(req);
        const port = input.port;
        if (!Number.isInteger(port) || !allowedPorts.includes(port)) return fail(res, 400, 'port not authorized');
        if (routes.size >= maxRoutes) return fail(res, 429, 'route limit reached');
        const id = randomUUID();
        const expiresAt = now() + ttlMs;
        const used = new Set([...routes.values()].map((route) => route.previewPort));
        const previewPort = previewPorts.find((candidate) => !used.has(candidate));
        if (previewPort === undefined) return fail(res, 429, 'no preview port available');
        const host = `${previewHost}:${previewPort}`;
        const origin = `https://${host}`;
        const route = { id, port, previewPort, expiresAt, host, origin, connections: new Set(), expiryTimer: null };
        route.expiryTimer = setTimeout(() => removeRoute(id), ttlMs);
        route.expiryTimer.unref();
        routes.set(id, route);
        res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ id, expiresAt, host, origin, previewPort, path: '/' }));
      }
      const revoke = /^\/__gateway\/routes\/([0-9a-f-]{36})$/i.exec(pathname);
      if (revoke && req.method === 'DELETE') {
        if (req.headers['x-gateway-csrf'] !== 'same-origin') return fail(res, 403, 'CSRF check failed');
        removeRoute(revoke[1]);
        res.writeHead(204, { 'cache-control': 'no-store' }); return res.end();
      }
      if (isManagement) {
        const knownPath = managementAssetPath || pathname === '/__gateway/routes' || /^\/__gateway\/routes\/[0-9a-f-]{36}$/i.test(pathname);
        return fail(res, knownPath ? 405 : 404, knownPath ? 'method not allowed' : 'management route not found');
      }
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return fail(res, 405, 'method not allowed');
      const path = cleanPath(pathname);
      if (!path) return fail(res, 400, 'invalid path');
      proxyHttp(req, res, previewRoute, path);
    } catch {
      fail(res, 400, 'invalid request');
    }
  });

  // Bounds accepted frontend sockets, including upgraded WebSocket connections.
  server.maxConnections = 128;

  function proxyHttp(req, res, route, path) {
    const headers = trustedHeaders(req);
    headers.host = `${containerAddress}:${route.port}`;
    headers.connection = 'close';
    const upstream = http.request({ host: containerAddress, port: route.port, method: req.method, path: `${path}${new URL(req.url, 'http://gateway.invalid').search}`, headers, timeout: 10_000 }, (up) => {
      up.on('error', () => { if (res.headersSent) res.destroy(); else fail(res, 502, 'upstream unavailable'); });
      up.on('aborted', () => { if (res.headersSent) res.destroy(); else fail(res, 502, 'upstream unavailable'); });
      up.on('close', () => { if (!up.complete && !res.destroyed) { if (res.headersSent) res.destroy(); else fail(res, 502, 'upstream unavailable'); } });
      // Do not let apps set cookies or cause the browser to navigate outside this origin.
      if (up.statusCode >= 300 && up.statusCode < 400) { up.resume(); return fail(res, 502, 'upstream redirects are disabled'); }
      const out = {};
      for (const key of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'vary']) if (up.headers[key] !== undefined) out[key] = up.headers[key];
      out['cache-control'] = 'no-store';
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    });
    let completed = false;
    res.on('finish', () => { completed = true; });
    const cancel = () => { if (!completed) upstream.destroy(new Error('client disconnected')); };
    req.on('aborted', cancel);
    res.on('close', cancel);
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else fail(res, 502, 'upstream unavailable');
    });
    req.pipe(upstream);
  }

  server.on('upgrade', async (req, socket, head) => {
    let upstream;
    try {
      const identity = await peer(req);
      if (!ownerAllowed(identity) || req.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy();
      const route = routeForHost(req.headers.host?.toLowerCase());
      if (!route || !hostAndOriginValid(req, route.host, route.origin, true)) return socket.destroy();
      const url = new URL(req.url, 'http://gateway.invalid');
      const path = cleanPath(url.pathname);
      if (!path) return socket.destroy();
      const headers = trustedHeaders(req, true);
      headers.host = `${containerAddress}:${route.port}`;
      upstream = http.request({ host: containerAddress, port: route.port, method: 'GET', path: `${path}${url.search}`, headers, timeout: 10_000 });
      const clientSocket = socket;
      route.connections.add(clientSocket);
      let upstreamSocket;
      let pendingSocket;
      let upgraded = false;
      const cleanup = () => {
        route.connections.delete(clientSocket);
        if (upstreamSocket) route.connections.delete(upstreamSocket);
        if (pendingSocket) route.connections.delete(pendingSocket);
      };
      const abortPendingUpgrade = (error) => {
        if (!upgraded) {
          upstream.destroy(error);
          upstream.socket?.destroy(error);
          pendingSocket?.destroy(error);
        }
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy(error);
      };
      clientSocket.once('end', () => abortPendingUpgrade());
      clientSocket.once('close', () => { cleanup(); abortPendingUpgrade(); });
      clientSocket.once('error', (error) => abortPendingUpgrade(error));
      upstream.on('socket', (connectingSocket) => {
        pendingSocket = connectingSocket;
        if (!upgraded) route.connections.add(connectingSocket);
        connectingSocket.once('close', () => route.connections.delete(connectingSocket));
      });
      upstream.setTimeout(wsHandshakeTimeoutMs, () => { abortPendingUpgrade(new Error('websocket handshake timeout')); clientSocket.destroy(); });
      upstream.on('upgrade', (response, socketFromUpstream, upstreamHead) => {
        if (response.statusCode !== 101) { socketFromUpstream.destroy(); return clientSocket.destroy(); }
        upgraded = true;
        upstreamSocket = socketFromUpstream;
        route.connections.add(upstreamSocket);
        const lines = ['HTTP/1.1 101 Switching Protocols'];
        for (const key of ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
          const value = response.headers[key]; if (value) lines.push(`${key}: ${value}`);
        }
        clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) upstreamSocket.write(head);
        if (upstreamHead.length) clientSocket.write(upstreamHead);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
        upstreamSocket.once('close', () => { route.connections.delete(upstreamSocket); clientSocket.destroy(); });
      });
      upstream.on('response', (response) => { response.resume(); clientSocket.destroy(); });
      upstream.on('timeout', () => { abortPendingUpgrade(new Error('websocket handshake timeout')); clientSocket.destroy(); });
      upstream.on('error', () => clientSocket.destroy());
      upstream.end();
    } catch { upstream?.destroy(); socket.destroy(); }
  });

  // Route timers revoke mapped WebSocket sockets as well as access for new requests.
  server.on('close', () => { for (const route of routes.values()) closeRoute(route); routes.clear(); });
  return { server, routes };
}
