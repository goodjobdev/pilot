import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import { RunnerBroker, createProjectWorkspaceResolver, type RunnerPort } from '../../src/server/state/runner-broker';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentStore } from '../../src/server/state/agent-store';
import { reserveNamedAgentTestJob } from '../../src/server/agents/job-budget';
import type { RunnerJobRecord, RunnerContainment } from '../../src/shared/runner';
import type { AgentScope } from '../../src/shared/agent-registry';

test('a model test call requires the live agent scope and project, and rechecks before execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-agent-tests-')), projectId = randomUUID(), path = join(root, 'project');
  await mkdir(path);
  const project = { id: projectId, name: 'Fixture', path, managed: true, repository: '', created: '' };
  const fake = fauxProvider({ provider: 'tests-faux', models: [{ id: 'fixture' }] });
  const providers = new ProviderStore(root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'tests-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  let scopes: readonly AgentScope[] = ['run_tests'], projects: string[] = [projectId], checks = 0, revokeAfterSubmit = false, rebindDuringCheck=false, authorityVersion=1;
  const calls: string[] = [];
  let record: RunnerJobRecord;
  const broker = {
    async submit(input: {jobId: string; projectId: string; workspace: string}) { calls.push('submit'); if (revokeAfterSubmit) scopes = []; return record = { id: input.jobId, projectId: input.projectId, workspace: input.workspace, recipe: 'test-run', state: 'pending', claim: null } as RunnerJobRecord; },
    async claim(input: {owner: string}) { calls.push('claim'); return record = { ...record, state: 'claimed', claim: { owner: input.owner, claimedAt: '', leaseExpiresAt: '' } }; },
    async run() { calls.push('run'); return { ...record, state: 'settled', result: { outcome: 'succeeded' } } as RunnerJobRecord; }
  } as unknown as Pick<RunnerBroker, 'submit' | 'claim' | 'run'>;
  const host = new HarnessHost({ dataRoot: root, enabled: true, providers,
    privileges: { authority: async () => ({ agentId: 'fixture', model: null, scopes, projects, emptyReason: null, authorityVersion:String(authorityVersion) }) },
    runnerTests: { broker, checkSession: async (id, sessionId) => { assert.equal(id, projectId); assert.equal(sessionId, '1'); checks++; if(rebindDuringCheck){rebindDuringCheck=false;authorityVersion+=2;} }, reserveJob: async () => {} }
  });
  t.after(async () => { await host.close(); await providers.close(); await rm(root, { recursive: true, force: true }); });
  const run = async (text: string) => {
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('run_tests', {})], { stopReason: 'toolUse' }), () => fauxAssistantMessage(text)]);
    await host.submit(project, { text: 'Run tests', mode: 'followUp' });
    const end = Date.now() + 10000;
    while (!(await host.view(project)).entries.some(entry => entry.text === text)) {
      if (Date.now() > end) throw Error('run did not finish');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await run('first finished'); assert.deepEqual(calls, ['submit', 'claim', 'run']); assert.equal(checks, 4);
  rebindDuringCheck=true; await run('binding restored'); assert.equal(calls.length,3,'rebind ABA cannot revive the dispatched call');
  scopes = []; await run('scope revoked'); assert.equal(calls.length, 3);
  scopes = ['run_tests']; projects = []; await run('project revoked'); assert.equal(calls.length, 3);
  projects = [projectId]; revokeAfterSubmit = true; await run('mid-call revoked'); assert.deepEqual(calls, ['submit', 'claim', 'run', 'submit']);
});

test('model call reaches the durable broker and synthetic runner without host commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-agent-runner-e2e-'));
  const path = join(root, 'project'), data = join(root, 'data'), projectId = randomUUID();
  await mkdir(path); await mkdir(data);
  const project = { id: projectId, name: 'Fixture', path, managed: true, repository: '', created: '' };
  const fake = fauxProvider({ provider: 'runner-faux', models: [{ id: 'fixture' }] });
  const providers = new ProviderStore(data, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'runner-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  const control = new ControlStore(data);
  const agents = new AgentStore(control, { models: () => [{ provider: 'runner-faux', modelId: 'fixture' }], projectKnown: id => id === projectId });
  const owner = { kind: 'owner', identity: 'fixture' };
  const agent = agents.create({ actor: owner, draft: { name: 'Runner', description: '', enabled: true, model: { provider: 'runner-faux', modelId: 'fixture' }, workspace: { scope: { kind: 'projects', projectIds: [projectId] }, subpath: '' }, budgets: { maxRequests: null, maxOutputTokens: null, maxJobsPerHour: 1 }, scopes: ['run_tests'] } });
  agents.bindSession({ projectId, sessionId: '1', revision: 0, agentId: agent.id, actor: owner });
  const containment: RunnerContainment = { runtime: 'synthetic', image: 'fixture', network: 'none', rootFilesystem: 'read-only', user: '10001:10001', capabilities: 'none', noNewPrivileges: true, dockerSocket: false, mounts: ['workspace'], maxMemoryBytes: 1024 * 1024 * 1024, maxCpus: 2, maxPids: 128, maxWallClockMs: 300000 };
  let executions = 0;
  const port: RunnerPort = {
    establish: async () => containment,
    execute: async input => {
      executions++; assert.equal(input.workspace, await realpath(path)); assert.equal(input.job.recipe, 'test-run');
      const now = new Date().toISOString();
      return { exitCode: 0, stdout: 'fixture passed', stderr: '', stdoutBytes: 14, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, timedOut: false, durationMs: 1, startedAt: now, endedAt: now };
    }
  };
  const broker = new RunnerBroker(control, port, { projectKnown: id => id === projectId, workspace: createProjectWorkspaceResolver({ projectRoot: id => id === projectId ? path : undefined }) });
  const host = new HarnessHost({ dataRoot: data, enabled: true, providers,
    privileges: { authority: async ({ projectId, sessionId }) => agents.versionedAuthorityForSession({ projectId, sessionId: sessionId ?? '' }) },
    runnerTests: { broker, checkSession: async (_id, sessionId) => { if (sessionId !== '1') throw Error('unsupported session'); }, reserveJob: async (projectId, sessionId, agentId) => reserveNamedAgentTestJob({ control, agents, projectId, sessionId, agentId }) }
  });
  t.after(async () => { await host.close(); await providers.close(); control.close(); await rm(root, { recursive: true, force: true }); });
  fake.setResponses([() => fauxAssistantMessage([fauxToolCall('run_tests', {})], { stopReason: 'toolUse' }), () => fauxAssistantMessage('completed')]);
  await host.submit(project, { text: 'Run the tests', mode: 'followUp' });
  const end = Date.now() + 10000;
  while (!(await host.view(project)).entries.some(entry => entry.text === 'completed')) {
    if (Date.now() > end) throw Error('run did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const jobs = broker.read(projectId).jobs;
  assert.equal(executions, 1); assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'settled');
  assert.equal(jobs[0].result?.outcome, 'succeeded'); assert.equal(jobs[0].result?.stdout, 'fixture passed');
  fake.setResponses([() => fauxAssistantMessage([fauxToolCall('run_tests', {})], { stopReason: 'toolUse' }), () => fauxAssistantMessage('budget refusal finished')]);
  await host.submit(project, { text: 'Run again', mode: 'followUp' });
  const end2 = Date.now() + 10000;
  while (!(await host.view(project)).entries.some(entry => entry.text === 'budget refusal finished')) {
    if (Date.now() > end2) throw Error('second run did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(executions, 1); assert.equal(broker.read(projectId).jobs.length, 1);
});
