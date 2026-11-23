import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentBudgetLedger } from '../../src/server/state/agent-budget';

test('agent request reservations are global across projects and survive restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-agent-budget-'));
  const store = new ControlStore(root);
  try {
    const ledger = new AgentBudgetLedger(store);
    assert.equal(ledger.reserve({ agentId: 'agent-a', projectId: 'project-a', kind: 'request', limit: 2 }).ordinal, 1);
    assert.equal(ledger.reserve({ agentId: 'agent-a', projectId: 'project-b', kind: 'request', limit: 2 }).ordinal, 2);
    assert.throws(() => ledger.reserve({ agentId: 'agent-a', projectId: 'project-a', kind: 'request', limit: 2 }), /exhausted/);
    assert.equal(ledger.reserve({ agentId: 'agent-b', projectId: 'project-a', kind: 'request', limit: 2 }).ordinal, 1);
    store.close();
    const reopened = new ControlStore(root);
    try { assert.throws(() => new AgentBudgetLedger(reopened).reserve({ agentId: 'agent-a', projectId: 'project-b', kind: 'request', limit: 2 }), /exhausted/); }
    finally { reopened.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('the job limit is a rolling hour and counts reservations rather than reported success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-agent-jobs-')), store = new ControlStore(root);
  try {
    const ledger = new AgentBudgetLedger(store);
    ledger.reserve({ agentId: 'agent', projectId: 'project', kind: 'job', limit: 1 });
    assert.throws(() => ledger.reserve({ agentId: 'agent', projectId: 'project', kind: 'job', limit: 1 }), /rolling-hour/);
    store.db.prepare("UPDATE operations SET created_at=? WHERE kind='agent.budget-job'").run(new Date(Date.now() - 61 * 60 * 1000).toISOString());
    assert.equal(ledger.reserve({ agentId: 'agent', projectId: 'project', kind: 'job', limit: 1 }).ordinal, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('a competing store that wins the same slot cannot be double-counted or bypass the cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-agent-budget-race-'));
  const one = new ControlStore(root), two = new ControlStore(root);
  try {
    const first = new AgentBudgetLedger(one), second = new AgentBudgetLedger(two), original = one.admit.bind(one);
    let raced = false;
    one.admit = input => {
      if (!raced) { raced = true; second.reserve({ agentId: 'agent', projectId: 'project', kind: 'request', limit: 1 }); }
      return original(input);
    };
    assert.throws(() => first.reserve({ agentId: 'agent', projectId: 'project', kind: 'request', limit: 1 }), /exhausted/);
    assert.equal(raced, true);
    assert.throws(() => second.reserve({ agentId: 'agent', projectId: 'project', kind: 'request', limit: 1 }), /exhausted/);
  } finally { one.close(); two.close(); await rm(root, { recursive: true, force: true }); }
});
