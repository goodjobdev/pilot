import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { SpendBudget } from '../../src/server/state/spend-budget';
import { AcceptedSpendService, HttpBillingTransport, readSpendBillingToken } from '../../src/server/agents/accepted-spend';
import type { AgentScope } from '../../src/shared/agent-registry';

const accountId = 'fixture-account', token = 'fixture_billing_token_not_real_1234', targetId = 'pilot-spend';

type Mode = 'ok' | 'error' | 'redirect' | 'oversize' | 'timeout' | 'wrong-type';

/**
 * A local billing stub on 127.0.0.1. Every request the adapter makes is recorded here; no test
 * reaches the network and the token in these tests is a fixture, never a credential.
 */
async function billingStub() {
  const requests: { method: string; headers: Headers; body: string }[] = [];
  let mode: Mode = 'ok', charges = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method ?? '', headers: new Headers(request.headers as Record<string, string>), body });
      if (mode === 'timeout') return; // Hold the request open until the client's own deadline fires.
      if (mode === 'redirect') { response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }); response.end(); return; }
      if (mode === 'error') { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"chargeId":"should-not-be-read"}'); return; }
      if (mode === 'wrong-type') { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('{"chargeId":"ch_wrong_type"}'); return; }
      if (mode === 'oversize') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ chargeId: 'ch_oversize', padding: 'x'.repeat(20000) })); return; }
      charges += 1;
      const parsed = JSON.parse(body) as { amountMinor?: unknown; currency?: unknown };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ chargeId: 'ch_' + charges, amountMinor: parsed.amountMinor, currency: parsed.currency }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/charge';
  return {
    endpoint, requests,
    setMode: (value: Mode) => { mode = value; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}

async function fixture(billing: Awaited<ReturnType<typeof billingStub>>, caps = { projectCapMinor: 1000, chargeCapMinor: 500 }) {
  const base = await mkdtemp(join(tmpdir(), 'pilot-spend-fixture-')), source = join(base, 'source'), data = join(base, 'data');
  await Promise.all([mkdir(source), mkdir(data)]);
  await mkdir(join(data, 'credentials'), { mode: 0o700 });
  await writeFile(join(data, 'credentials', 'spend-billing.json'), JSON.stringify({ version: 1, token }), { mode: 0o600 });
  const projectId = randomUUID(), control = new ControlStore(data);
  const acceptance = new AcceptanceStore(control, { projectRoot: id => id === projectId ? source : undefined });
  acceptance.updatePolicy({ revision: 0, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'ask', deploy: 'ask', spend: 'full-auto', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
  let scopes: readonly AgentScope[] = ['accept', 'spend'];
  const caller = {
    projectId, sessionId: randomUUID(), agentId: 'agent',
    authorize: async () => { if (!scopes.includes('spend')) throw new Error('scope revoked'); }
  };
  const budget = new SpendBudget(control, caps);
  const service = (store: ControlStore, acceptanceStore: AcceptanceStore) => new AcceptedSpendService({
    projectId, targetId, targetRevision: 1, endpoint: billing.endpoint, accountId, currency: 'USD', acceptance: acceptanceStore,
    executor: new AcceptedActionExecutor(store), budget,
    transport: new HttpBillingTransport({ endpoint: billing.endpoint, accountId, token: () => readSpendBillingToken(data), timeoutMs: 200 })
  });
  const current = service(control, acceptance);
  const record = async (amountMinor: number) => {
    const preview = await current.preview({ ...caller, amountMinor });
    const evidence = await acceptance.recordEvidence({
      projectId,
      evidence: {
        sessionId: caller.sessionId, subject: { kind: 'session', id: caller.sessionId }, artifact: preview.artifact,
        commands: ['node --test'], diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: 'fixture claim', reference: null },
        tests: [{ command: 'node --test', outcome: 'passed', output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0', counts: { passed: 1, failed: 0, skipped: 0 } }],
        review: null, producedAt: '2026-01-01T00:00:00.000Z'
      }
    });
    const accepted = (await acceptance.accept({ authorizeAdmission: () => {}, projectId, request: { evidenceId: evidence.evidence.record.id, artifact: preview.artifact, actionClass: 'spend', actor: { kind: 'agent', identity: 'agent' } } })).acceptance;
    return { preview, evidenceId: evidence.evidence.record.id, acceptanceId: accepted.id };
  };
  return {
    base, source, data, projectId, control, acceptance, caller, budget, service: current, record,
    setScopes: (value: readonly AgentScope[]) => { scopes = value; },
    cleanup: async () => { control.close(); await rm(base, { recursive: true, force: true }); }
  };
}

test('a charge succeeds once with the accepted artifact as its idempotency key and never returns the credential', async () => {
  const billing = await billingStub(), f = await fixture(billing);
  try {
    const charge = await f.record(250);
    assert.equal(charge.preview.amountMinor, 250);
    assert.equal(charge.preview.currency, 'USD');
    const result = await f.service.spend({ ...f.caller, amountMinor: 250, evidenceId: charge.evidenceId, acceptanceId: charge.acceptanceId, artifact: charge.preview.artifact });
    assert.equal(result.status, 'succeeded');
    if (result.status !== 'succeeded') return;
    assert.equal(result.receipt.externalId, 'ch_1');
    assert.equal(billing.requests.length, 1);
    const request = billing.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('authorization'), 'Bearer ' + token);
    assert.equal(request.headers.get('content-type'), 'application/json');
    assert.match(request.headers.get('idempotency-key') ?? '', /^charge-[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(request.body), { version: 1, accountId, amountMinor: 250, currency: 'USD' });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    assert.doesNotMatch(JSON.stringify(await f.service.preview({ ...f.caller, amountMinor: 250 })), new RegExp(token + '|' + billing.endpoint));
  } finally { await f.cleanup(); await billing.close(); }
});

test('the same accepted charge is refused from its durable intent instead of sending a second request', async () => {
  const billing = await billingStub(), f = await fixture(billing);
  try {
    const charge = await f.record(250);
    assert.equal((await f.service.spend({ ...f.caller, amountMinor: 250, evidenceId: charge.evidenceId, acceptanceId: charge.acceptanceId, artifact: charge.preview.artifact })).status, 'succeeded');
    const repeat = await f.service.spend({ ...f.caller, amountMinor: 250, evidenceId: charge.evidenceId, acceptanceId: charge.acceptanceId, artifact: charge.preview.artifact });
    assert.equal(repeat.status, 'refused');
    assert.match(repeat.status === 'refused' || repeat.status === 'uncertain' ? repeat.message : '', /already succeeded|not sent again/);
    assert.equal(billing.requests.length, 1);
  } finally { await f.cleanup(); await billing.close(); }
});

test('the per-charge and per-project caps refuse before any request is sent', async () => {
  const billing = await billingStub(), f = await fixture(billing, { projectCapMinor: 800, chargeCapMinor: 500 });
  try {
    const overCharge = await f.record(600);
    assert.equal(overCharge.preview.exceedsChargeCap, true);
    await assert.rejects(f.service.spend({ ...f.caller, amountMinor: 600, evidenceId: overCharge.evidenceId, acceptanceId: overCharge.acceptanceId, artifact: overCharge.preview.artifact }), /per-charge spend cap/);
    assert.equal(billing.requests.length, 0);

    const first = await f.record(400);
    assert.equal((await f.service.spend({ ...f.caller, amountMinor: 400, evidenceId: first.evidenceId, acceptanceId: first.acceptanceId, artifact: first.preview.artifact })).status, 'succeeded');
    assert.equal(billing.requests.length, 1);
    const second = await f.record(500);
    assert.equal(second.preview.exceedsChargeCap, false);
    assert.equal(second.preview.exceedsProjectCap, true);
    await assert.rejects(f.service.spend({ ...f.caller, amountMinor: 500, evidenceId: second.evidenceId, acceptanceId: second.acceptanceId, artifact: second.preview.artifact }), /per-project spend cap/);
    assert.equal(billing.requests.length, 1);
    assert.equal(f.budget.total(f.projectId), 400);
  } finally { await f.cleanup(); await billing.close(); }
});

test('a non-2xx response, a redirect, an oversized or mistyped body and a timeout are unknown and never replayed', async () => {
  for (const mode of ['error', 'redirect', 'oversize', 'wrong-type', 'timeout'] as const) {
    const billing = await billingStub(), f = await fixture(billing);
    try {
      billing.setMode(mode);
      const charge = await f.record(200);
      const attempt = () => f.service.spend({ ...f.caller, amountMinor: 200, evidenceId: charge.evidenceId, acceptanceId: charge.acceptanceId, artifact: charge.preview.artifact });
      const result = await attempt();
      assert.equal(result.status, 'uncertain', mode);
      assert.equal(billing.requests.length, 1, mode);

      // The durable intent is the barrier: a repeat is never sent again.
      const repeat = await attempt();
      assert.notEqual(repeat.status, 'succeeded', mode);
      assert.equal(billing.requests.length, 1, mode);

      const reopened = new ControlStore(f.data);
      try {
        const afterRestart = new AcceptedSpendService({
          projectId: f.projectId, targetId, targetRevision: 1, endpoint: billing.endpoint, accountId, currency: 'USD',
          acceptance: new AcceptanceStore(reopened, { projectRoot: id => id === f.projectId ? f.source : undefined }),
          executor: new AcceptedActionExecutor(reopened), budget: new SpendBudget(reopened, { projectCapMinor: 1000, chargeCapMinor: 500 }),
          transport: new HttpBillingTransport({ endpoint: billing.endpoint, accountId, token: () => readSpendBillingToken(f.data), timeoutMs: 200 })
        });
        assert.notEqual((await afterRestart.spend({ ...f.caller, amountMinor: 200, evidenceId: charge.evidenceId, acceptanceId: charge.acceptanceId, artifact: charge.preview.artifact })).status, 'succeeded', mode);
        assert.equal(billing.requests.length, 1, mode);
      } finally { reopened.close(); }
    } finally { await f.cleanup(); await billing.close(); }
  }
});

test('the transport itself names a redirect and an oversized receipt as refused, not followed', async () => {
  const billing = await billingStub();
  try {
    const transport = new HttpBillingTransport({ endpoint: billing.endpoint, accountId, token: async () => token, timeoutMs: 200 });
    const charge = { amountMinor: 200, currency: 'USD', idempotencyKey: 'charge-' + 'a'.repeat(64) };
    billing.setMode('redirect');
    await assert.rejects(transport.charge(charge), /redirect/);
    billing.setMode('oversize');
    await assert.rejects(transport.charge(charge), /oversized receipt/);
    billing.setMode('error');
    await assert.rejects(transport.charge(charge), /HTTP 500/);
    assert.equal(billing.requests.length, 3);
  } finally { await billing.close(); }
});

test('a revoked scope or a policy that no longer permits spend refuses with no request', async () => {
  const billing = await billingStub(), f = await fixture(billing);
  try {
    const charge = await f.record(200);
    f.setScopes(['accept']);
    await assert.rejects(f.service.spend({ ...f.caller, amountMinor: 200, evidenceId: charge.evidenceId, acceptanceId: charge.acceptanceId, artifact: charge.preview.artifact }), /scope revoked/);
    assert.equal(billing.requests.length, 0);

    f.setScopes(['accept', 'spend']);
    f.acceptance.updatePolicy({ revision: 1, policy: { mode: 'agent-may-accept', actionClasses: { commit: 'ask', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }, actor: { kind: 'owner', identity: 'fixture' } });
    await assert.rejects(f.service.spend({ ...f.caller, amountMinor: 200, evidenceId: charge.evidenceId, acceptanceId: charge.acceptanceId, artifact: charge.preview.artifact }), /does not authorize|policy/);
    assert.equal(billing.requests.length, 0);
  } finally { await f.cleanup(); await billing.close(); }
});

test('an unusable billing credential refuses before any reservation or request', async () => {
  const billing = await billingStub(), f = await fixture(billing);
  try {
    const prepared = await f.record(250);
    const before = f.budget.total(f.projectId);
    // A credential the instance cannot use must stop the charge before the cap is touched: an
    // `unknown` here would consume the project's budget and block the amount for nothing.
    await chmod(join(f.data, 'credentials', 'spend-billing.json'), 0o644);
    await assert.rejects(
      f.service.spend({ ...f.caller, amountMinor: 250, evidenceId: prepared.evidenceId, acceptanceId: prepared.acceptanceId, artifact: prepared.preview.artifact }),
      /credential/i
    );
    assert.equal(f.budget.total(f.projectId), before, 'no reservation was taken');
    assert.equal(billing.requests.length, 0, 'no request was sent');
  } finally { await f.cleanup(); billing.close(); }
});
