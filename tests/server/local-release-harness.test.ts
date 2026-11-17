import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fauxAssistantMessage,fauxProvider,fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { LocalReleaseStore } from '../../src/server/state/local-release-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { LocalDeployService } from '../../src/server/agents/local-deploy';
import { LocalPublishService } from '../../src/server/agents/local-publish';
import type { AgentScope } from '../../src/shared/agent-registry';

/**
 * The two release tools are really installed in the agent harness, and the existing `deploy` and
 * `publish` scopes still govern them. The preview tools are read-only, so this fixture needs no
 * acceptance and no effect: it proves the tool exists for a bound agent with the scope and is
 * refused at dispatch for an agent without it.
 */
test('the local deploy and publish preview tools are offered only to an agent whose scopes grant them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-local-release-harness-'));
  const projectRoot = join(root, 'project'), served = join(root, 'served'), data = join(root, 'data');
  await mkdir(join(projectRoot, 'dist'), { recursive: true });
  await mkdir(join(served, 'site'), { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(join(projectRoot, 'dist', 'index.html'), '<h1>release</h1>');
  await writeFile(join(projectRoot, 'README.md'), '# release\n');
  const projectId = randomUUID();
  const project = { id: projectId, name: 'Local release harness', path: projectRoot, managed: true, repository: '', created: '' };
  const control = new ControlStore(data);
  const acceptance = new AcceptanceStore(control, { projectRoot: (id) => (id === projectId ? projectRoot : undefined) });
  const store = new LocalReleaseStore(control);
  store.writeDestination({ projectId, kind: 'deploy', revision: 0, enabled: true, definition: { kind: 'deploy-local', artifactPath: 'dist', targetDirectory: join(served, 'site') }, actor: { kind: 'owner', identity: 'fixture' } });
  store.writeDestination({ projectId, kind: 'publish', revision: 0, enabled: true, definition: { kind: 'publish-local', publicationRoot: served }, actor: { kind: 'owner', identity: 'fixture' } });
  const executor = new AcceptedActionExecutor(control);
  const deploy = new LocalDeployService({ store, acceptance, executor, projectRoot: () => projectRoot, approvedRoots: [served] });
  const publish = new LocalPublishService({ store, acceptance, executor, projectRoot: () => projectRoot, approvedRoots: [served] });
  let previews = 0;
  let scopes: readonly AgentScope[] = ['deploy', 'publish'];
  const fake = fauxProvider({ provider: 'local-release-faux', models: [{ id: 'fixture' }] }), providers = new ProviderStore(root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'local-release-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  const host = new HarnessHost({
    dataRoot: root, enabled: true, providers,
    privileges: { authority: async () => ({ agentId: 'agent', model: null, scopes, projects: [projectId], emptyReason: null }) },
    localDeployTools: {
      preview: (input) => { previews += 1; return deploy.preview(input); },
      deploy: (input) => deploy.deploy(input)
    },
    localPublishTools: {
      preview: (input) => { previews += 1; return publish.preview(input); },
      publish: (input) => publish.publish(input)
    }
  });
  const wait = async (text: string) => {
    const end = Date.now() + 10000;
    while (!(await host.view(project)).entries.some((entry) => entry.text.includes(text))) {
      if (Date.now() > end) throw new Error('run did not finish');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const view = async () => JSON.stringify((await host.view(project)).entries);
  try {
    fake.setResponses([
      () => fauxAssistantMessage([fauxToolCall('deploy_preview', {})], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage([fauxToolCall('publish_preview', { files: ['README.md'] })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Release previews checked.')
    ]);
    await host.submit(project, { text: 'Preview the release targets', mode: 'followUp' });
    await wait('Release previews checked.');
    assert.equal(previews, 2);
    assert.match(await view(), /contentDigest/);

    scopes = ['accept'];
    fake.setResponses([
      () => fauxAssistantMessage([fauxToolCall('deploy_preview', {})], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Revoked release checked.')
    ]);
    await host.submit(project, { text: 'Try a revoked release', mode: 'followUp' });
    await wait('Revoked release checked.');
    assert.equal(previews, 2, 'a tool outside the granted scopes is refused at dispatch and reaches no service');
    assert.match(await view(), /refused|not permitted/i);
  } finally {
    await host.close();
    await providers.close();
    control.close();
    await rm(root, { recursive: true, force: true });
  }
});
