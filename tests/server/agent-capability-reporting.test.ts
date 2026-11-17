import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import {
  AGENT_DEFAULT_INSTALLED_TOOLS,
  AGENT_TOOL_SCOPES,
  installedAgentScopes,
  scopeToolIsInstalled,
  unavailableAgentScopes,
  authorizeToolUse,
  type AgentScope,
  type InstalledCapabilities
} from '../../src/shared/agent-registry';

test('installed capability reporting distinguishes granted-but-uninstalled from installed-but-ungranted scopes', () => {
  const granted: readonly AgentScope[] = ['read_notes', 'file_edit', 'run_tests', 'commit'];
  const capabilities: InstalledCapabilities = { fileEdit: false, runTests: false, acceptedCommit: false };
  const installed = installedAgentScopes(capabilities);
  const unavailable = unavailableAgentScopes(capabilities).map(({ scope }) => scope);

  assert.ok(installed.includes('read_notes'));
  for (const scope of ['file_edit', 'run_tests', 'commit'] as const) {
    assert.ok(granted.includes(scope), `${scope} is explicitly granted`);
    assert.ok(unavailable.includes(scope), `${scope} is granted but has no installed tool`);
    assert.equal(scopeToolIsInstalled(scope, capabilities), false);
    // Authorization records the allowlist only; the harness separately requires an installed tool.
    assert.equal(authorizeToolUse({ scopes: granted, tool: Object.keys(AGENT_TOOL_SCOPES).find(name => AGENT_TOOL_SCOPES[name] === scope)! }).permitted, true);
  }

  const installedButUngrantable = installed.filter(scope => !granted.includes(scope));
  assert.ok(installedButUngrantable.includes('read_docs'), 'the installed planning tools are not implicitly granted');
  assert.equal(authorizeToolUse({ scopes: granted, tool: 'read_doc' }).permitted, false);
  assert.equal(authorizeToolUse({ scopes: granted, tool: 'write_board' }).permitted, false);
});

test('each optional capability switch installs only the corresponding tool scope', () => {
  const cases: readonly { scope: AgentScope; tool: string; capability: InstalledCapabilities }[] = [
    { scope: 'file_edit', tool: 'file_edit', capability: { fileEdit: true } },
    { scope: 'file_read', tool: 'read', capability: { fileRead: true } },
    { scope: 'file_write', tool: 'write', capability: { fileWrite: true } },
    { scope: 'shell', tool: 'bash', capability: { shell: true } },
    { scope: 'accept', tool: 'acceptance_accept', capability: { acceptance: true } },
    { scope: 'fork', tool: 'fork_create', capability: { fork: true } },
    { scope: 'run_tests', tool: 'run_tests', capability: { runTests: true } },
    { scope: 'commit', tool: 'commit_accepted', capability: { acceptedCommit: true } },
    { scope: 'push', tool: 'push_accepted', capability: { acceptedPush: true } },
    { scope: 'deploy', tool: 'deploy_accepted', capability: { acceptedDeploy: true } },
    { scope: 'provision', tool: 'provision_accepted', capability: { acceptedProvision: true } },
    { scope: 'spend', tool: 'spend_accepted', capability: { acceptedSpend: true } }
  ];

  for (const { scope, tool, capability } of cases) {
    assert.equal(AGENT_TOOL_SCOPES[tool], scope, `${tool} has the expected governing scope`);
    assert.equal(scopeToolIsInstalled(scope, capability), true, `${scope} is installed when its capability is enabled`);
    assert.ok(installedAgentScopes(capability).includes(scope));
    assert.equal(scopeToolIsInstalled(scope, {}), Object.values(AGENT_DEFAULT_INSTALLED_TOOLS).includes(scope),
      `${scope} is otherwise installed only when a default tool provides it`);
  }

  assert.deepEqual(installedAgentScopes({ fileRead: true, fileWrite: true }), [
    'read_notes', 'record_note', 'ask_question', 'read_docs', 'write_docs', 'file_read', 'file_write'
  ], 'read/write do not accidentally install shell or other opt-in capabilities');
});

test('the harness refuses installed-but-ungranted scopes without executing their tool', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-capability-harness-'));
  const project = { id: randomUUID(), name: 'Fixture', path: root, managed: true, repository: '', created: '' };
  const fake = fauxProvider({ provider: 'capability-faux', models: [{ id: 'fixture' }] });
  const providers = new ProviderStore(root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'capability-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  let executions = 0;
  const host = new HarnessHost({ dataRoot: root, enabled: true, providers,
    privileges: { authority: async () => ({ agentId: 'fixture', model: null, scopes: [], projects: [project.id], emptyReason: null }) },
    runnerTests: { broker: { submit: async () => { executions++; throw new Error('should be refused'); } } as never,
      checkSession: async () => {}, reserveJob: async () => {} }
  });
  t.after(async () => { await host.close(); await providers.close(); await rm(root, { recursive: true, force: true }); });
  fake.setResponses([() => fauxAssistantMessage([fauxToolCall('run_tests', {})], { stopReason: 'toolUse' }), () => fauxAssistantMessage('denied')]);
  await host.submit(project, { text: 'try tests', mode: 'followUp' });
  const end = Date.now() + 10000;
  while (!(await host.view(project)).entries.some(entry => entry.text === 'denied')) {
    if (Date.now() > end) throw Error('scripted run did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(executions, 0, 'installed-but-ungranted tool has no effect');
  assert.match(JSON.stringify((await host.view(project)).entries), /refus|not permitted|not available/i);

  // A granted scope with no adapter is not installed in this harness. A fabricated model call
  // cannot reach an executor, and the live capability vocabulary identifies it as unavailable.
  await host.close();
  const uninstalled = new HarnessHost({ dataRoot: join(root, 'uninstalled'), enabled: true, providers,
    privileges: { authority: async () => ({ agentId: 'fixture', model: null, scopes: ['read_notes', 'run_tests'], projects: [project.id], emptyReason: null }) }
  });
  try {
    let modelVisibleSystem = '';
    fake.setResponses([(context) => {
      modelVisibleSystem = JSON.stringify(context.messages.filter(message => message.role === 'system'));
      return fauxAssistantMessage([fauxToolCall('run_tests', {})], { stopReason: 'toolUse' });
    }, () => fauxAssistantMessage('uninstalled')]);
    await uninstalled.submit(project, { text: 'try unavailable tests', mode: 'followUp' });
    const deadline = Date.now() + 10000;
    while (!(await uninstalled.view(project)).entries.some(entry => entry.text === 'uninstalled')) {
      if (Date.now() > deadline) throw Error('uninstalled-tool run did not finish');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(executions, 0, 'granted-but-uninstalled tool never reaches an executor');
    assert.match(modelVisibleSystem, /scopes with an installed tool are: read_notes\./);
    assert.match(modelVisibleSystem, /scopes are granted but their tools are not currently usable in this instance: run_tests\./);
    assert.match(modelVisibleSystem, /path checks are not process isolation: another process can change a path between validation and use/);
    assert.ok(unavailableAgentScopes({}).some(({ scope }) => scope === 'run_tests'));
    assert.equal(scopeToolIsInstalled('run_tests', {}), false);
  } finally { await uninstalled.close(); }
});

test('owner dispatch sees the project-path limitation in the model-visible system message', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-owner-path-prompt-'));
  const project = { id: randomUUID(), name: 'Fixture', path: root, managed: true, repository: '', created: '' };
  const fake = fauxProvider({ provider: 'owner-path-faux', models: [{ id: 'fixture' }] });
  const providers = new ProviderStore(root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'owner-path-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  const host = new HarnessHost({ dataRoot: root, enabled: true, providers,
    privileges: { authority: async () => ({ agentId: null, model: null, scopes: null, projects: null, emptyReason: null }) }
  });
  t.after(async () => { await host.close(); await providers.close(); await rm(root, { recursive: true, force: true }); });
  let system = '';
  fake.setResponses([(context) => {
    system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    return fauxAssistantMessage('observed');
  }]);
  await host.submit(project, { text: 'inspect path limitations', mode: 'followUp' });
  const end = Date.now() + 10000;
  while (!(await host.view(project)).entries.some(entry => entry.text === 'observed')) {
    if (Date.now() > end) throw Error('scripted run did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(system, /owner.s own dispatch is in force/);
  assert.match(system, /path checks are not process isolation: another process can change a path between validation and use/);
});

test('fork limitation is included in the model-visible system message', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-fork-prompt-'));
  const project = { id: randomUUID(), name: 'Fixture', path: root, managed: true, repository: '', created: '' };
  const fake = fauxProvider({ provider: 'fork-prompt-faux', models: [{ id: 'fixture' }] });
  const providers = new ProviderStore(root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'fork-prompt-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  const host = new HarnessHost({ dataRoot: root, enabled: true, providers,
    coding: { enabled: false, shell: false, root: () => undefined, isFork: () => true },
    privileges: { authority: async () => ({ agentId: 'fixture', model: null, scopes: ['read_notes'], projects: [project.id], emptyReason: null }) }
  });
  t.after(async () => { await host.close(); await providers.close(); await rm(root, { recursive: true, force: true }); });
  let system = '';
  fake.setResponses([(context) => {
    system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    return fauxAssistantMessage('observed');
  }]);
  await host.submit(project, { text: 'inspect fork capabilities', mode: 'followUp' });
  const end = Date.now() + 10000;
  while (!(await host.view(project)).entries.some(entry => entry.text === 'observed')) {
    if (Date.now() > end) throw Error('scripted run did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(system, /action-driven child dispatch can refuse later work/);
  assert.match(system, /Shell remains uncontained/);
  assert.match(system, /commit, push, deploy, publish, provision and spend tools are unavailable/);
});
