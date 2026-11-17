import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { CloudflareWorkerDeployTransport, cloudflareWorkerResourceDigest } from '../../src/server/agents/cloudflare-worker-deploy';

const accountId = 'a'.repeat(32), workerName = 'fixture-worker';
const versionId = '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f', token = 'synthetic_test_token';
const resourceDigest = cloudflareWorkerResourceDigest(accountId, workerName);
const payload = { success: true, result: { id: versionId, resources: { bindings: [], script_runtime: { exports: {} } }, secret: token } };
const inspect = { resourceDigest, versionId };

function adapter(fetch: typeof globalThis.fetch) {
  return new CloudflareWorkerDeployTransport({ accountId, workerName, token: async () => token, fetch });
}

test('Worker inspection uses a fixed GET and projects only identity from a synthetic response', async () => {
  let requests = 0;
  const transport = adapter(async (url, init) => {
    requests++;
    assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/versions/${versionId}`);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  });
  const result = await transport.inspect(inspect);
  assert.deepEqual(result, inspect);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  await assert.rejects(transport.inspect({ ...inspect, versionId: '../example' }));
  await assert.rejects(transport.inspect({ ...inspect, resourceDigest: 'b'.repeat(64) }));
  assert.equal(requests, 1);
});

test('Worker inspection rejects redirects, misleading media types and secret-bearing transport errors', async () => {
  for (const response of [
    new Response(JSON.stringify(payload), { headers: { 'content-type': 'text/application/json' } }),
    new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json-malicious' } }),
    Object.defineProperty(new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }), 'redirected', { value: true })
  ]) {
    await assert.rejects(adapter(async () => response).inspect(inspect), error => {
      assert.equal((error as Error).message, 'Cloudflare deployment response is unavailable or unverified.');
      return true;
    });
  }
  await assert.rejects(adapter(async () => { throw new Error(token); }).inspect(inspect), error => {
    assert.doesNotMatch(String(error), new RegExp(token));
    return true;
  });
});

test('real fetch refuses same-origin and cross-origin redirects before either destination sees a request', async () => {
  let sourceHits = 0, destinationHits = 0;
  const sourceAuthorization: (string | undefined)[] = [];
  const destination = createServer((_req, res) => { destinationHits++; res.end('unexpected'); });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  const destinationPort = (destination.address() as AddressInfo).port;
  let crossOrigin = false;
  const source = createServer((req, res) => {
    if (req.url === '/destination') { destinationHits++; res.end('unexpected'); return; }
    sourceHits++; sourceAuthorization.push(req.headers.authorization);
    res.writeHead(302, { location: crossOrigin ? `http://127.0.0.1:${destinationPort}/destination` : '/destination' }); res.end();
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  const sourcePort = (source.address() as AddressInfo).port;
  try {
    // The injected transport is trusted: only this synthetic test maps the fixed Cloudflare URL to loopback.
    const localFetch: typeof fetch = async (_url, init) => fetch(`http://127.0.0.1:${sourcePort}/source`, init);
    const transport = adapter(localFetch);
    await assert.rejects(transport.inspect(inspect), /unavailable or unverified/);
    crossOrigin = true;
    await assert.rejects(transport.inspect(inspect), /unavailable or unverified/);
    assert.equal(sourceHits, 2); assert.deepEqual(sourceAuthorization, [`Bearer ${token}`, `Bearer ${token}`]);
    assert.equal(destinationHits, 0);
  } finally {
    source.closeAllConnections(); destination.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => destination.close(() => resolve()))]);
  }
});

test('streamed response accepts exactly 256 KiB and cancels on the first byte over', async () => {
  const limit = 256 * 1024;
  const base = JSON.stringify({ ...payload, padding: '' });
  const exact = JSON.stringify({ ...payload, padding: 'x'.repeat(limit - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(exact), limit);
  let cancelled = false;
  const response = (oversize: boolean) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(exact);
      controller.enqueue(bytes.subarray(0, 100)); controller.enqueue(bytes.subarray(100));
      if (oversize) controller.enqueue(new Uint8Array([32])); else controller.close();
    },
    cancel() { cancelled = true; }
  }), { headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await adapter(async () => response(false)).inspect(inspect), inspect);
  await assert.rejects(adapter(async () => response(true)).inspect(inspect), /unavailable or unverified/);
  assert.equal(cancelled, true);
});
