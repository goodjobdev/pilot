import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { localTestPort } from '../../src/server/agents/local-test-dispatch';
import { ProviderStore } from '../../src/server/providers';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentStore } from '../../src/server/state/agent-store';
import { LocalTestRunner } from '../../src/server/state/local-test-runner';

// The harness-level check: the installed `run_tests` tool, the ticketed named-agent requirement, and
// a real disposable project whose test really runs. Nothing here touches a live project.

const PROJECT = '55555555-5555-4555-8555-555555555555';
const PROJECT_OWNER = '66666666-6666-4666-8666-666666666666';
const passing = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { appendFileSync } from 'node:fs';",
  "appendFileSync('runs.log','run\\n');",
  "test('passes',()=>{ console.log('LOCAL-TEST-PASS-MARKER'); assert.equal(1,1); });",
  ''
].join('\n');

test('the installed tool needs a bound named agent, then runs the fixed recipe and reports its receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-local-harness-'));
  const data = join(root, 'data'), path = join(root, 'project'), ownerPath = join(root, 'owner-project');
  await mkdir(data);
  await mkdir(path);
  await mkdir(ownerPath);
  await writeFile(join(path, 'pass.test.mjs'), passing);
  await writeFile(join(ownerPath, 'pass.test.mjs'), passing);
  const project = { id: PROJECT, name: 'Fixture', path, managed: true, repository: '', created: '' };
  const ownerProject = { id: PROJECT_OWNER, name: 'Owner fixture', path: ownerPath, managed: true, repository: '', created: '' };
  const fake = fauxProvider({ provider: 'local-harness-faux', models: [{ id: 'fixture' }] });
  const providers = new ProviderStore(data, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'local-harness-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  const control = new ControlStore(data);
  const agents = new AgentStore(control, { models: () => [{ provider: 'local-harness-faux', modelId: 'fixture' }], projectKnown: id => id === project.id });
  const owner = { kind: 'owner' as const, identity: 'fixture' };
  const agent = agents.create({ actor: owner, draft: { name: 'Runner', description: '', enabled: true, model: { provider: 'local-harness-faux', modelId: 'fixture' }, workspace: { scope: { kind: 'projects', projectIds: [project.id] }, subpath: '' }, budgets: { maxRequests: null, maxOutputTokens: null, maxJobsPerHour: null }, scopes: ['run_tests'] } });
  const runner = new LocalTestRunner(control);
  const host = new HarnessHost({ dataRoot: data, enabled: true, providers,
    privileges: { authority: async ({ projectId, sessionId }) => agents.versionedAuthorityForSession({ projectId, sessionId: sessionId ?? '' }) },
    localTests: localTestPort({ control: () => control, agents: () => agents, runner: () => runner, projectRoot: id => id === project.id ? project.path : id === ownerProject.id ? ownerProject.path : undefined, isFork: () => false })
  });
  t.after(async () => { await host.close(); await providers.close(); control.close(); await rm(root, { recursive: true, force: true }); });
  const runs = () => existsSync(join(path, 'runs.log')) ? readFileSync(join(path, 'runs.log'), 'utf8').split('\n').filter(Boolean).length : 0;
  const say = async (target: typeof project, text: string) => {
    fake.setResponses([() => fauxAssistantMessage([fauxToolCall('run_tests', {})], { stopReason: 'toolUse' }), () => fauxAssistantMessage(text)]);
    await host.submit(target, { text: 'Run the tests', mode: 'followUp' });
    const end = Date.now() + 20000;
    while (!(await host.view(target)).entries.some(entry => entry.text === text)) {
      if (Date.now() > end) throw new Error('the scripted run did not finish');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return JSON.stringify((await host.view(target)).entries);
  };

  // The owner's own dispatch has no agent allowlist, so the capability refuses rather than running
  // under the owner's identity.
  const ownerDispatch = await say(ownerProject, 'owner finished');
  assert.match(ownerDispatch, /Bind a named agent with the run_tests scope/);
  assert.equal(existsSync(join(ownerPath, 'runs.log')), false, 'owner dispatch never started the recipe');
  assert.equal(runner.list(ownerProject.id).length, 0, 'owner dispatch wrote no durable job');

  // A project-level legacy rule is not enough: the installed path requires the session to be bound.
  const legacy = await say(project, 'legacy finished');
  assert.match(legacy, /authority changed or is unavailable/);
  assert.equal(runs(), 0, 'an unbound session never started the recipe');
  assert.equal(runner.list(project.id).length, 0, 'an unbound session wrote no durable job');

  // A named agent bound to the session can call the tool; the receipt is in the transcript.
  agents.bindSession({ projectId: project.id, sessionId: '1', revision: 0, agentId: agent.id, actor: owner });
  const granted = await say(project, 'granted finished');
  assert.ok(granted.includes('succeeded'), 'the receipt reports a completed run');
  assert.ok(granted.includes('LOCAL-TEST-PASS-MARKER'), 'the fixed recipe output is in the transcript');
  assert.equal(runs(), 1, 'the fixed recipe really ran');
  assert.equal(runner.list(project.id).length, 1);

  // Revoking the scope takes effect on the next call with no restart and no execution.
  const current = agents.read(agent.id);
  agents.update({ agentId: current.id, revision: current.revision, patch: { scopes: [] }, actor: owner });
  const revoked = await say(project, 'revoked finished');
  assert.match(revoked, /refus|not in this agent/i);
  assert.equal(runs(), 1);
  assert.equal(runner.list(project.id).length, 1);
});

test('the application installs the run_tests tool only when the local test switch is on', async t => {
  const boot = async (enabled: boolean) => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-local-wiring-'));
    const security = localConfig('http://127.0.0.1:0');
    const control = new ControlStore(root);
    const app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', control, ...(enabled ? { localTests: { enabled: true } } : {}) });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
    return { root, security, control, app };
  };
  const on = await boot(true);
  t.after(async () => { await on.app.close(); on.control.close(); await rm(on.root, { recursive: true, force: true }); });
  const onScopes = await (await fetch(on.security.origin + '/api/agents', { headers: { 'x-dashboard-token': on.security.token } })).json() as { scopes: { scope: string; installed: boolean }[] };
  assert.equal(onScopes.scopes.find(entry => entry.scope === 'run_tests')?.installed, true, 'the switch installs the tool');

  const off = await boot(false);
  t.after(async () => { await off.app.close(); off.control.close(); await rm(off.root, { recursive: true, force: true }); });
  const offScopes = await (await fetch(off.security.origin + '/api/agents', { headers: { 'x-dashboard-token': off.security.token } })).json() as { scopes: { scope: string; installed: boolean }[] };
  assert.equal(offScopes.scopes.find(entry => entry.scope === 'run_tests')?.installed, false, 'without the switch the tool does not exist');
});
