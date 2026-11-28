#!/usr/bin/env node
/**
 * Owner route management over the gateway's private Unix socket.
 *
 * There is deliberately no browser control site in this design: the preview host
 * is a tailnet name and the only browser-facing surface is the per-port preview
 * itself. Route management is an owner action performed as the gateway service
 * UID against the mode-0600 socket, e.g.
 *
 *   docker exec -u <gateway-uid> <gateway-container> node /app/manage.mjs create --port 5173
 *   docker exec -u <gateway-uid> <gateway-container> node /app/manage.mjs revoke --id <uuid>
 *
 * The request still carries the management Host and Origin the core requires, so
 * the same origin/host checks apply as for any other management client.
 */
import http from 'node:http';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required environment variable ${name} is unset`);
  return value;
}

const controlHost = required('PREVIEW_CONTROL_HOST');
const socketPath = required('PREVIEW_CORE_SOCKET');

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      socketPath,
      method,
      path,
      headers: {
        host: controlHost,
        origin: `https://${controlHost}`,
        'x-gateway-csrf': 'same-origin',
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function main(argv) {
  const [action, ...rest] = argv;
  const flag = (name) => {
    const index = rest.indexOf(`--${name}`);
    return index === -1 ? undefined : rest[index + 1];
  };
  if (action === 'create') {
    const port = Number(flag('port'));
    if (!Number.isInteger(port)) throw new Error('create requires --port <upstream port>');
    const result = await call('POST', '/__gateway/routes', { port });
    process.stdout.write(`${result.status} ${result.body}\n`);
    if (result.status !== 201) process.exitCode = 1;
    return;
  }
  if (action === 'revoke') {
    const id = flag('id');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('revoke requires --id <uuid>');
    const result = await call('DELETE', `/__gateway/routes/${id}`);
    process.stdout.write(`${result.status} ${result.body}\n`);
    if (result.status !== 204) process.exitCode = 1;
    return;
  }
  throw new Error('usage: manage.mjs create --port <n> | revoke --id <uuid>');
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
