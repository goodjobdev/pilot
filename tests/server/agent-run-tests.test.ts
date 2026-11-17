import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTestJobId, runAgentTests } from '../../src/server/agents/run-tests';
import type { RunnerBroker } from '../../src/server/state/runner-broker';
import type { RunnerJobRecord } from '../../src/shared/runner';

type Broker = Pick<RunnerBroker, 'submit' | 'claim' | 'run'>;
const job = (state: 'pending' | 'claimed' | 'settled') => ({
  id: jobId, projectId: base.projectId, recipe: 'test-run', workspace: base.workspace, state,
  claim: state === 'pending' ? null : { owner: base.owner }, result: state === 'settled' ? { outcome: 'succeeded' } : null
}) as RunnerJobRecord;

function fixture() {
  const calls: { op: string; input: Record<string, unknown> }[] = [];
  const broker = {
    async submit(input: Record<string, unknown>) { calls.push({ op: 'submit', input }); return job('pending'); },
    async claim(input: Record<string, unknown>) { calls.push({ op: 'claim', input }); return job('claimed'); },
    async run(input: Record<string, unknown>) { calls.push({ op: 'run', input }); return job('settled'); }
  } as unknown as Broker;
  return { calls, broker };
}
const base = { projectId: 'project', conversationId: 'conversation', taskId: 'task', owner: 'agent-owner', workspace: '.', reserveJob: async () => {} }; // synthetic orchestration fixture only
const jobId = agentTestJobId(base.projectId, base.conversationId, base.taskId);

test('test execution uses a fixed recipe and exact job claim, checking authority at each boundary', async () => {
  const { broker, calls } = fixture(); let checks = 0;
  const result = await runAgentTests({ ...base, broker, authorize: async () => { checks++; } });
  assert.equal(checks, 4);
  assert.deepEqual(calls.map(call => call.op), ['submit', 'claim', 'run']);
  assert.deepEqual(calls[0].input, { projectId: 'project', recipe: 'test-run', workspace: '.', jobId });
  assert.equal(calls[1].input.expectedJobId, jobId);
  assert.equal(calls[2].input.jobId, jobId);
  assert.deepEqual(result, { status: 'settled', job: job('settled') });
});

test('delegated runner receives a live effect-boundary authorization callback',async()=>{
  const {broker}=fixture();let checks=0;
  broker.run=async(input)=>{assert.ok(input.beforeExecute);await input.beforeExecute();throw Error('synthetic refusal');};
  const result=await runAgentTests({...base,broker,authorize:async()=>{if(++checks===5)throw Error('revoked at effect');}});
  assert.equal(checks,5);assert.equal(result.status,'needs-inspection');
});

test('revocation before submission has no effect; later revocation preserves the durable job ID', async () => {
  for (const failAt of [1, 2, 3, 4]) {
    const { broker, calls } = fixture(); let checks = 0;
    const promise = runAgentTests({ ...base, broker, authorize: async () => { if (++checks === failAt) throw Error('revoked'); } });
    if (failAt <= 2) await assert.rejects(promise, /revoked/);
    else {
      const result = await promise;
      assert.equal(result.status, 'needs-inspection');
      if (result.status === 'needs-inspection') { assert.equal(result.jobId, jobId); assert.equal(result.stage, failAt === 3 ? 'submitted' : 'claimed'); }
    }
    assert.deepEqual(calls.map(call => call.op), failAt <= 2 ? [] : failAt === 3 ? ['submit'] : ['submit', 'claim']);
  }
});

test('claim refusal or uncertain execution is never retried and identifies the durable record', async () => {
  for (const failAt of ['claim', 'run'] as const) {
    const { broker, calls } = fixture();
    broker[failAt] = async () => { throw Error('sensitive runtime error'); };
    const result = await runAgentTests({ ...base, broker, authorize: async () => {} });
    assert.equal(result.status, 'needs-inspection');
    if (result.status === 'needs-inspection') {
      assert.equal(result.jobId, jobId); assert.equal(result.stage, failAt === 'claim' ? 'submitted' : 'run');
      assert.doesNotMatch(result.message, /sensitive/);
    }
    assert.deepEqual(calls.map(call => call.op), failAt === 'claim' ? ['submit'] : ['submit', 'claim']);
  }
});

test('job budget exhaustion or revocation after reservation admits no runner job', async () => {
  for (const fail of ['budget', 'revoke'] as const) {
    const { broker, calls } = fixture(); let checks = 0, reservations = 0;
    const promise = runAgentTests({ ...base, broker,
      authorize: async () => { if (++checks === 2 && fail === 'revoke') throw Error('revoked'); },
      reserveJob: async () => { reservations++; if (fail === 'budget') throw Error('budget exhausted'); }
    });
    await assert.rejects(promise, fail === 'budget' ? /budget exhausted/ : /revoked/);
    assert.equal(reservations, 1); assert.deepEqual(calls, []);
  }
});

test('a runner that ignores cancellation does not turn an abandoned invocation into normal success', async () => {
  const { broker } = fixture(), controller = new AbortController();
  broker.run = async () => { controller.abort(); return job('settled'); };
  const result = await runAgentTests({ ...base, broker, signal: controller.signal, authorize: async () => {} });
  assert.equal(result.status, 'needs-inspection');
  if (result.status === 'needs-inspection') { assert.equal(result.stage, 'run'); assert.equal(result.jobId, jobId); }
});

test('cancellation between claim and run keeps the claim and starts nothing', async () => {
  const { broker, calls } = fixture(); const controller = new AbortController(); let checks = 0;
  const result = await runAgentTests({ ...base, broker, signal: controller.signal, authorize: async () => { if (++checks === 4) controller.abort(); } });
  assert.equal(result.status, 'needs-inspection');
  if (result.status === 'needs-inspection') assert.equal(result.stage, 'claimed');
  assert.deepEqual(calls.map(call => call.op), ['submit', 'claim']);
});

test('mismatched broker records fail closed without advancing or reporting success', async () => {
  for (const op of ['submit', 'claim', 'run'] as const) {
    for (const field of ['id', 'projectId', 'recipe', 'workspace', 'state', ...(op === 'submit' ? [] : ['claim']), ...(op === 'run' ? ['result'] : [])]) {
      const { broker, calls } = fixture();
      const original = broker[op].bind(broker);
      (broker as any)[op] = async (input: any) => ({ ...await original(input), [field]: field === 'claim' || field === 'result' ? null : 'mismatch' });
      const result = await runAgentTests({ ...base, broker, authorize: async () => {} });
      assert.equal(result.status, 'needs-inspection', `${op}.${field}`);
      if (result.status === 'needs-inspection') assert.equal(result.jobId, jobId);
      assert.deepEqual(calls.map(call => call.op), op === 'submit' ? ['submit'] : op === 'claim' ? ['submit', 'claim'] : ['submit', 'claim', 'run']);
    }
  }
});
