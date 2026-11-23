import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentStore } from '../../src/server/state/agent-store';
import { reserveNamedAgentTestJob } from '../../src/server/agents/job-budget';

const owner = { kind: 'owner', identity: 'fixture' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-job-budget-')), projectId = randomUUID();
  const control = new ControlStore(root), second = new ControlStore(root);
  const options = { models: () => [{ provider: 'faux', modelId: 'fixture' }], projectKnown: (id: string) => id === projectId };
  const agents = new AgentStore(control, options), other = new AgentStore(second, options);
  const agent = agents.create({ actor: owner, draft: { name: 'Runner', description: '', enabled: true, model: { provider: 'faux', modelId: 'fixture' }, workspace: { scope: { kind: 'projects', projectIds: [projectId] }, subpath: '' }, budgets: { maxRequests: null, maxOutputTokens: null, maxJobsPerHour: 2 }, scopes: ['run_tests'] } });
  const reserve = () => reserveNamedAgentTestJob({ control, agents, projectId, sessionId: 'session', agentId: agent.id });
  const count = () => Number((control.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind='agent.budget-job'").get() as { n: number }).n);
  return { root, control, second, agents, other, projectId, agent, reserve, count, cleanup: async () => { control.close(); second.close(); await rm(root, { recursive: true, force: true }); } };
}

test('job reservation requires an explicit matching binding and persists its rolling limit', async () => {
  const f = await fixture();
  try {
    assert.throws(f.reserve, /not bound/); assert.equal(f.count(), 0);
    f.agents.bindSession({ projectId: f.projectId, sessionId: 'session', revision: 0, agentId: f.agent.id, actor: owner });
    f.reserve(); f.reserve(); assert.throws(f.reserve, /rolling-hour job budget/); assert.equal(f.count(), 2);
    const reopened = new ControlStore(f.root);
    try {
      const agents = new AgentStore(reopened, { models: () => [], projectKnown: id => id === f.projectId });
      assert.throws(() => reserveNamedAgentTestJob({ control: reopened, agents, projectId: f.projectId, sessionId: 'session', agentId: f.agent.id }), /rolling-hour job budget/);
      assert.throws(() => reserveNamedAgentTestJob({ control: reopened, agents: f.agents, projectId: f.projectId, sessionId: 'session', agentId: f.agent.id }), /share the admission connection/);
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});

test('cross-connection revocation, rebinding or budget change between snapshot and admission consumes no job', async () => {
  for (const change of ['scope', 'binding', 'budget'] as const) {
    const f = await fixture();
    try {
      f.agents.bindSession({ projectId: f.projectId, sessionId: 'session', revision: 0, agentId: f.agent.id, actor: owner });
      const admit = f.control.admit.bind(f.control); let changed = false;
      f.control.admit = input => {
        if (!changed && input.kind === 'agent.budget-job') {
          changed = true;
          if (change === 'binding') f.other.bindSession({ projectId: f.projectId, sessionId: 'session', revision: 1, agentId: null, actor: owner });
          else f.other.update({ agentId: f.agent.id, revision: f.agent.revision, patch: change === 'scope' ? { scopes: [] } : { budgets: { ...f.agent.budgets, maxJobsPerHour: 1 } }, actor: owner });
        }
        return admit(input);
      };
      assert.throws(f.reserve, /authority or job budget changed/); assert.equal(f.count(), 0);
      if (change !== 'budget') assert.throws(f.reserve, /not bound/);
      else { f.reserve(); assert.throws(f.reserve, /rolling-hour job budget/); }
    } finally { await f.cleanup(); }
  }
});
