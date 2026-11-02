import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import { emptyBoard, type Project } from '../../src/shared/model';
import { serializeBoard } from '../../src/shared/markdown';
import type { AgentScope } from '../../src/shared/agent-registry';

test('migration preserves owner removals and a later grant works without changing the model or selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-planning-selection-'));
  const project: Project = { id: randomUUID(), name: 'Fixture', path: join(root, 'project'), managed: true, repository: '', created: '' };
  await mkdir(join(project.path, 'docs/dashboard'), { recursive: true });
  await writeFile(join(project.path, 'docs/plan.md'), '# Plan\nVerified source evidence.\n');
  await writeFile(join(project.path, 'docs/dashboard/board.md'), serializeBoard(emptyBoard()));
  const fake = fauxProvider({ provider: 'selection-faux', models: [{ id: 'fixture' }] });
  const providers = new ProviderStore(root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'selection-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  let scopes: readonly AgentScope[] = [];
  const options = { dataRoot: root, enabled: true, providers, privileges: { authority: async () => ({ agentId: 'fixture-agent', scopes, projects: [project.id], emptyReason: null }) } };
  let host = new HarnessHost(options);
  try {
    const opened = await (host as any).open(project);
    const agent = await opened.conversation.agent(BACKGROUND_CONTEXT);
    await opened.conversation.configure({ extensions: agent.extensions.filter((e: { name: string }) => e.name !== 'planning'), tools: { remove: [{ name: 'read_notes' }, { name: 'read_board' }] }, instructions: 'Retain these owner instructions.' }, BACKGROUND_CONTEXT);
    await host.close(); host = new HarnessHost(options);
    let current = await (host as any).open(project);
    const check = async () => {
      const state = await current.conversation.viewState(BACKGROUND_CONTEXT);
      try {
        const selection = state.value.docs['pi.agent'];
        assert.deepEqual(selection.tools.remove, ['read_notes', 'read_board']);
        assert.equal(selection.instructions, 'Retain these owner instructions.');
        assert.equal(selection.model.provider, 'selection-faux');
      } finally { state.dispose(); }
    };
    await check();
    scopes = ['read_docs', 'write_docs'];
    fake.setResponses([
      () => fauxAssistantMessage([fauxToolCall('read_doc', { path: 'docs/plan.md' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Granted read complete.')
    ]);
    await host.submit(project, { text: 'Read the plan', mode: 'followUp' });
    const deadline = Date.now() + 10000;
    while (!(await host.view(project)).entries.some(e => e.text.includes('Granted read complete.'))) {
      if (Date.now() > deadline) throw Error('Faux selection run timed out');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok((await host.view(project)).entries.some(e => e.text.includes('Verified source evidence.')));
    const selected = await current.conversation.agent(BACKGROUND_CONTEXT);
    assert.ok(selected.tools.some((t: { name: string }) => t.name === 'write_board'));
    assert.ok(!selected.tools.some((t: { name: string }) => t.name === 'read_board'));
    await check();
    await host.close(); host = new HarnessHost(options); current = await (host as any).open(project);
    await check();
    assert.equal(fake.state.callCount, 2);
  } finally { await host.close(); await providers.close(); await rm(root, { recursive: true, force: true }); }
});
