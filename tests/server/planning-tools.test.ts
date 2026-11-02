import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { planningExtension } from '../../src/server/agents/harness-host';
import { BoardStore } from '../../src/server/board-store';
import { DocStore } from '../../src/server/docs-store';
import { emptyBoard, newTask, type Project } from '../../src/shared/model';
import { serializeBoard } from '../../src/shared/markdown';
import { agentScopeVocabulary, authorizeToolUse } from '../../src/shared/agent-registry';

test('planning tools contain reads and use checked board revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-planning-'));
  try {
    const project: Project = { id: 'fixture', name: 'Fixture', path: join(root, 'project'), managed: true, repository: '', created: '' };
    await mkdir(join(project.path, 'docs/dashboard'), { recursive: true });
    await writeFile(join(project.path, 'docs/plan.md'), '# Plan\nSource evidence\n');
    await writeFile(join(project.path, 'docs/dashboard/board.md'), serializeBoard(emptyBoard()));
    await writeFile(join(root, 'outside.md'), 'secret');
    await symlink(join(root, 'outside.md'), join(project.path, 'docs/link.md'));
    await mkdir(join(root, 'data'), { mode: 0o700 });
    const boards = new BoardStore(join(root, 'data'));
    const extension = planningExtension(project, new DocStore(), boards);
    const call = async (name: string, args: unknown) => {
      const tool = extension.tools!.find(item => item.name === name)!;
      const execute = tool.execute as unknown as (args: unknown, api: unknown, context: unknown) => Promise<{ output: { text: string }[] }>;
      return JSON.parse((await execute(args, {}, {})).output[0].text);
    };
    const listed = await call('list_docs', {});
    assert.ok(listed.documents.some((item: { path: string }) => item.path === 'docs/plan.md'));
    assert.ok(!listed.documents.some((item: { path: string }) => item.path === 'docs/link.md'));
    assert.match((await call('read_doc', { path: 'docs/plan.md' })).text, /Source evidence/);
    await assert.rejects(() => call('read_doc', { path: '../outside.md' }));
    await assert.rejects(() => call('read_doc', { path: 'docs/link.md' }));
    const before = await call('read_board', {});
    const task = { ...newTask(randomUUID(), 'Evidence-based task'), specs: [{ path: 'docs/plan.md', anchor: null }] };
    const updated = await call('write_board', { revision: before.revision, operation: { op: 'putTask', task } });
    assert.notEqual(updated.revision, before.revision);
    await assert.rejects(() => call('write_board', { revision: before.revision, operation: { op: 'putTask', task } }));
    await assert.rejects(() => call('write_board', { revision: updated.revision, operation: { op: 'removeTask', id: task.id, confirmEdges: true } }));
    assert.deepEqual((await boards.read(project)).board.tasks.map(item => item.id), [task.id]);
    const longText = '# Long plan\n' + 'Read all evidence.\n'.repeat(1500);
    await writeFile(join(project.path, 'docs/long.md'), longText);
    const firstPage = await call('read_doc', { path: 'docs/long.md' });
    const secondPage = await call('read_doc', { path: 'docs/long.md', offset: firstPage.nextOffset });
    assert.equal(firstPage.text.length, 16000);
    assert.equal(firstPage.text + secondPage.text, longText);
    assert.equal(secondPage.nextOffset, null);
    const second = { ...newTask(randomUUID(), 'Second task'), specs: [{ path: 'docs/plan.md', anchor: null }] };
    const edge = { id: randomUUID(), source: task.id, target: second.id, kind: 'blocks' };
    const batch = await call('write_board', { revision: updated.revision, operations: [{ op: 'putTask', task: second }, { op: 'putEdge', edge }] });
    assert.equal(batch.applied, 2);
    assert.equal((await boards.read(project)).board.relationships.length, 1);
    const third = { ...newTask(randomUUID(), 'Must not partially commit'), specs: [{ path: 'docs/plan.md', anchor: null }] };
    await assert.rejects(() => call('write_board', { revision: batch.revision, operations: [{ op: 'putTask', task: third }, { op: 'removeTask', id: task.id, confirmEdges: true }] }));
    await assert.rejects(() => call('write_board', { revision: batch.revision, operation: { op: 'putTask', task: { ...third, specs: [{ path: 'docs/missing.md', anchor: null }] } } }));
    assert.equal((await boards.read(project)).revision, batch.revision);
    await assert.rejects(() => call('write_board', { revision: batch.revision, operation: { op: 'putTask', task: third }, operations: [] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('planning scope mappings deny absent grants and report optional file edit', () => {
  for (const name of ['list_docs', 'read_doc', 'read_board']) {
    assert.equal(authorizeToolUse({ scopes: [], tool: name }).permitted, false);
    assert.equal(authorizeToolUse({ scopes: ['read_docs'], tool: name }).permitted, true);
  }
  assert.equal(authorizeToolUse({ scopes: ['read_docs'], tool: 'write_board' }).permitted, false);
  assert.equal(authorizeToolUse({ scopes: ['write_docs'], tool: 'write_board' }).permitted, true);
  assert.equal(agentScopeVocabulary().find(item => item.scope === 'file_edit')?.installed, false);
  assert.equal(agentScopeVocabulary(true).find(item => item.scope === 'file_edit')?.installed, true);
});
