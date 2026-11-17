import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentStore } from '../../src/server/state/agent-store';
import { LocalTestRunner } from '../../src/server/state/local-test-runner';
import { localTestPort } from '../../src/server/agents/local-test-dispatch';

// The dispatch port is the enforcement a model call really reaches. These tests use disposable
// projects and the real local runner; no live project or integration worktree is touched.

const PROJECT = '44444444-4444-4444-8444-444444444444';
const passing = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { appendFileSync } from 'node:fs';",
  "appendFileSync('runs.log','run\\n');",
  "test('passes',()=>{ assert.equal(1,1); });",
  ''
].join('\n');

async function fixture(maxJobsPerHour: number | null, bind = true) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-local-dispatch-'));
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(project);
  await mkdir(data);
  await writeFile(join(project, 'pass.test.mjs'), passing);
  const control = new ControlStore(data);
  const agents = new AgentStore(control, { models: () => [{ provider: 'fixture', modelId: 'fixture' }], projectKnown: id => id === PROJECT });
  const owner = { kind: 'owner' as const, identity: 'fixture' };
  const agent = agents.create({ actor: owner, draft: { name: 'Runner', description: '', enabled: true, model: { provider: 'fixture', modelId: 'fixture' }, workspace: { scope: { kind: 'projects', projectIds: [PROJECT] }, subpath: '' }, budgets: { maxRequests: null, maxOutputTokens: null, maxJobsPerHour }, scopes: ['run_tests'] } });
  if (bind) agents.bindSession({ projectId: PROJECT, sessionId: '1', revision: 0, agentId: agent.id, actor: owner });
  const runner = new LocalTestRunner(control);
  const port = (isFork: boolean) => localTestPort({ control: () => control, agents: () => agents, runner: () => runner, projectRoot: id => id === PROJECT ? project : undefined, isFork: () => isFork });
  const authority = () => JSON.stringify(agents.versionedAuthorityForSession({ projectId: PROJECT, sessionId: '1' }));
  const request = (taskId: string, isFork = false, expectedAuthority = authority()) => port(isFork).run({ projectId: PROJECT, sessionId: '1', conversationId: 'conversation-one', agentId: agent.id, taskId, expectedAuthority });
  const runs = () => existsSync(join(project, 'runs.log')) ? readFileSync(join(project, 'runs.log'), 'utf8').split('\n').filter(Boolean).length : 0;
  return { root, project, control, agents, agent, runner, authority, request, runs };
}

test('the installed dispatch refuses stale authority, a revoked scope, an unbound session and a fork before anything runs', async t => {
  const f = await fixture(null);
  t.after(async () => { f.control.close(); await rm(f.root, { recursive: true, force: true }); });
  const owner = { kind: 'owner' as const, identity: 'fixture' };

  // A snapshot that no longer matches the durable authority is refused even though the tool ticket
  // was issued for it.
  const stale = f.authority();
  f.agents.update({ agentId: f.agent.id, revision: f.agent.revision, patch: { description: 'changed' }, actor: owner });
  await assert.rejects(f.request('stale', false, stale), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 403);
    assert.match((error as Error).message, /authority changed or is unavailable/);
    return true;
  });
  assert.equal(f.runs(), 0);

  // Revoking the scope, then unbinding the session, each refuses with a current snapshot.
  const current = f.agents.read(f.agent.id);
  f.agents.update({ agentId: current.id, revision: current.revision, patch: { scopes: [] }, actor: owner });
  await assert.rejects(f.request('no-scope'), (error: unknown) => (error as { status?: number }).status === 403);
  f.agents.bindSession({ projectId: PROJECT, sessionId: '1', revision: 1, agentId: null, actor: owner });
  await assert.rejects(f.request('unbound'), (error: unknown) => (error as { status?: number }).status === 403);

  // The fork refusal is about the working tree, not about the grant.
  const granted = f.agents.read(f.agent.id);
  f.agents.update({ agentId: granted.id, revision: granted.revision, patch: { scopes: ['run_tests'] }, actor: owner });
  f.agents.bindSession({ projectId: PROJECT, sessionId: '1', revision: 2, agentId: f.agent.id, actor: owner });
  await assert.rejects(f.request('fork', true), (error: unknown) => (error as { status?: number }).status === 409);
  assert.equal(f.runs(), 0, 'no refused invocation reached a process');
  assert.equal(f.runner.list(PROJECT).length, 0, 'no refused invocation wrote a durable job');
});

test('the installed dispatch runs the fixed recipe and enforces the rolling-hour limit', async t => {
  const f = await fixture(1);
  t.after(async () => { f.control.close(); await rm(f.root, { recursive: true, force: true }); });
  const first = await f.request('first') as { state: string; outcome: string };
  assert.equal(first.state, 'succeeded');
  assert.equal(first.outcome, 'succeeded');
  assert.equal(f.runs(), 1);
  await assert.rejects(f.request('second'), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 409);
    assert.match((error as Error).message, /rolling-hour job budget/);
    return true;
  });
  assert.equal(f.runs(), 1, 'the capped call never reached a process');
  assert.equal(f.runner.list(PROJECT).length, 1);
});

test('a duplicate invocation returns the durable record instead of starting a second run', async t => {
  const f = await fixture(null);
  t.after(async () => { f.control.close(); await rm(f.root, { recursive: true, force: true }); });
  const first = await f.request('duplicate') as { state: string };
  const second = await f.request('duplicate') as { state: string; note: string };
  assert.equal(second.state, first.state);
  assert.match(second.note, /already has a durable test job; it was not started again/);
  assert.equal(f.runs(), 1);
  assert.equal(f.runner.list(PROJECT).length, 1);
});
