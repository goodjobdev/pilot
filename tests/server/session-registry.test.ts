import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore, HttpError } from '../../src/server/board-store';
import { DocStore } from '../../src/server/docs-store';
import { ControlStore } from '../../src/server/state/control-store';
import {
  LEGACY_SESSION_ID, SessionRegistry, createSessionResourcePort, legacyConversationPort, migrateLegacyConversations,
  type SessionResourcePort
} from '../../src/server/state/session-registry';
import { SessionError, legacySessionName, type SessionErrorCode, type SessionRecord } from '../../src/shared/sessions';
import { emptyBoard, newTask, type Project } from '../../src/shared/model';
import { serializeBoard } from '../../src/shared/markdown';

/**
 * Named sessions and the legacy-conversation migration, over disposable roots only. Every fixture is
 * a fresh temporary directory with its own control store, board, documentation and workspace;
 * nothing here reads or writes a live project, a real planning document, an agent store or a
 * provider.
 */

type Fixture = {
  root: string;
  workspaces: string;
  data: string;
  project: Project;
  taskId: string;
  projects: Map<string, Project>;
  store: ControlStore;
  boards: BoardStore;
  docs: DocStore;
  resources: SessionResourcePort;
  registry: SessionRegistry;
  cleanup(): Promise<void>;
};

async function fixture(name = 'Ops workspace'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-sessions-'));
  const workspaces = join(root, 'workspaces');
  const projectPath = join(workspaces, 'project');
  const data = join(root, 'data');
  await mkdir(join(projectPath, 'docs', 'spec'), { recursive: true, mode: 0o755 });
  await mkdir(data, { recursive: true, mode: 0o700 });
  const store = new ControlStore(data), boards = new BoardStore(data), docs = new DocStore();
  const project: Project = { id: randomUUID(), name, path: projectPath, managed: false, repository: '', created: new Date().toISOString() };
  const projects = new Map<string, Project>([[project.id, project]]);
  await boards.initialize(project, serializeBoard(emptyBoard()));
  const taskId = randomUUID();
  const snapshot = await boards.read(project);
  await boards.mutate(project, snapshot.revision, { op: 'putTask', task: newTask(taskId, 'Ship the release') });
  await docs.create(project, 'docs/spec/product.md', '# Product\n\nIntent.\n');
  const resources = createSessionResourcePort({
    browseRoots: [workspaces],
    project: (id) => projects.get(id),
    taskIds: async (id) => {
      const found = projects.get(id);
      if (!found || found.id !== project.id) return [];
      return (await boards.read(found)).board.tasks.map((task) => task.id);
    },
    documentServable: async (id, path) => {
      const found = projects.get(id);
      if (!found || found.id !== project.id) return false;
      try { await docs.read(found, path); return true; }
      catch (error) { if (error instanceof HttpError && error.status === 404) return false; throw error; }
    }
  });
  return {
    root, workspaces, data, project, taskId, projects, store, boards, docs, resources,
    registry: new SessionRegistry(store, resources),
    cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); }
  };
}

/** One asynchronous refusal, with its code and message. */
async function refusal(promise: Promise<unknown>, code: SessionErrorCode): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof SessionError) { assert.equal(error.code, code); return error.message; }
    throw error;
  }
  throw new Error('expected a refusal, but the call succeeded');
}
/** One synchronous refusal, with its code and message. */
function refusalSync(run: () => unknown, code: SessionErrorCode): string {
  try { run(); } catch (error) {
    if (error instanceof SessionError) { assert.equal(error.code, code); return error.message; }
    throw error;
  }
  throw new Error('expected a refusal, but the call succeeded');
}
const countOperations = (store: ControlStore): number => (store.db.prepare('SELECT count(*) AS n FROM operations WHERE kind=?').get('session.record') as { n: number }).n;
const countRows = (store: ControlStore, table: string, kind: string): number => (store.db.prepare('SELECT count(*) AS n FROM ' + table + ' WHERE kind=?').get(kind) as { n: number }).n;
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const names = (records: readonly SessionRecord[]): string[] => records.map((record) => record.name).sort();

test('sessions: a strict, frozen request model refuses unknown fields, bad ids, bad names and duplicate live names', async () => {
  const f = await fixture();
  try {
    const created = await f.registry.create({ projectId: f.project.id, name: 'Release train' });
    assert.equal(created.version, 1);
    assert.equal(created.revision, 1);
    assert.equal(created.id.length, 36);
    assert.equal(created.name, 'Release train');
    assert.equal(created.projectId, f.project.id);
    assert.equal(created.model, null);
    assert.deepEqual(created.links, []);
    assert.equal(created.createdAt, created.updatedAt);
    // Unknown or missing fields fail closed, and the reason names the field.
    assert.match(await refusal(f.registry.create({ projectId: f.project.id, name: 'Other', colour: 'red' }), 'INVALID'), /colour/);
    assert.match(await refusal(f.registry.create({ projectId: f.project.id }), 'INVALID'), /name/);
    // A malformed id and an unregistered project are different refusals.
    assert.match(await refusal(f.registry.create({ projectId: 'not a project', name: 'X' }), 'INVALID'), /projectId/);
    assert.match(await refusal(f.registry.create({ projectId: randomUUID(), name: 'X' }), 'NOT_FOUND'), /is not registered/);
    // The documented name rule: length, first character and charset.
    assert.match(await refusal(f.registry.create({ projectId: f.project.id, name: 'R'.repeat(81) }), 'INVALID'), /name/);
    assert.match(await refusal(f.registry.create({ projectId: f.project.id, name: 'bad/name' }), 'INVALID'), /name/);
    assert.match(await refusal(f.registry.create({ projectId: f.project.id, name: '-leading' }), 'INVALID'), /name/);
    assert.equal((await f.registry.create({ projectId: f.project.id, name: 'Fine ._:- 1' })).name, 'Fine ._:- 1');
    // The declared model choice is strict too: an unknown field inside it fails closed.
    assert.match(await refusal(f.registry.create({ projectId: f.project.id, name: 'Modelled', model: { provider: 'plus', modelId: 'plus-1', thinking: 'high' } }), 'INVALID'), /thinking/);
    const modelled = await f.registry.create({ projectId: f.project.id, name: 'Modelled', model: { provider: 'plus', modelId: 'plus-1' } });
    assert.deepEqual(modelled.model, { provider: 'plus', modelId: 'plus-1' });
    // A duplicate live name inside one project fails closed, and names the session that holds it.
    assert.match(await refusal(f.registry.create({ projectId: f.project.id, name: 'Release train' }), 'DUPLICATE_NAME'), /names are unique within a project/);
    assert.match(refusalSync(() => f.registry.rename({ projectId: f.project.id, sessionId: modelled.id, name: 'Release train', revision: modelled.revision }), 'DUPLICATE_NAME'), /names are unique/);
    // A missing or malformed session, and a malformed revision, are refused rather than guessed at.
    assert.match(refusalSync(() => f.registry.read(f.project.id, randomUUID()), 'NOT_FOUND'), /No session/);
    assert.match(refusalSync(() => f.registry.read(f.project.id, 'bad id!'), 'INVALID'), /sessionId/);
    assert.match(refusalSync(() => f.registry.rename({ projectId: f.project.id, sessionId: created.id, name: 'Later', revision: 0 }), 'INVALID'), /revision/);
    assert.match(refusalSync(() => f.registry.unlink({ projectId: f.project.id, sessionId: created.id, link: { kind: 'task', taskId: 'not-a-uuid' }, revision: 2 }), 'INVALID'), /taskId/);
    assert.match(refusalSync(() => f.registry.unlink({ projectId: f.project.id, sessionId: created.id, link: { kind: 'document', path: 'docs/spec/product.md', anchor: null, extra: true }, revision: 2 }), 'INVALID'), /extra/);
    // Three sessions exist, the listing is project-scoped, and an unknown project has none.
    assert.deepEqual(names(f.registry.list(f.project.id)), ['Fine ._:- 1', 'Modelled', 'Release train']);
    assert.deepEqual(f.registry.list(randomUUID()), []);
  } finally { await f.cleanup(); }
});

test('sessions: task and document links refuse what the board and the documentation store do not have', async () => {
  const f = await fixture();
  try {
    const session = await f.registry.create({ projectId: f.project.id, name: 'Linked' });
    // A task the board does not contain is not found, and the refusal names the task and the project.
    const missing = randomUUID();
    const absentTask = await refusal(f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'task', taskId: missing }, revision: 1 }), 'NOT_FOUND');
    assert.match(absentTask, /contains no task/);
    assert.ok(!absentTask.includes(f.project.path), 'a refusal leaks no filesystem path');
    // A task the board does contain is accepted, and the write is one revision.
    const linked = await f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'task', taskId: f.taskId }, revision: 1 });
    assert.equal(linked.revision, 2);
    assert.deepEqual(linked.links, [{ kind: 'task', taskId: f.taskId }]);
    // A documentation path the store cannot serve is not found...
    const absentDocument = await refusal(f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'document', path: 'docs/spec/missing.md', anchor: null }, revision: 2 }), 'NOT_FOUND');
    assert.match(absentDocument, /serves no document at that path/);
    assert.ok(!absentDocument.includes('missing.md'), 'a refusal quotes no path');
    // ...while a path that is not a servable documentation location is outside the approved roots.
    for (const path of ['../outside.md', '/etc/passwd', 'notes.txt', 'docs/dashboard/board.md', 'node_modules/x.md', '././..']) {
      const outside = await refusal(f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'document', path, anchor: null }, revision: 2 }), 'OUTSIDE_ROOTS');
      assert.match(outside, /outside the approved roots/);
      assert.ok(!outside.includes(path), 'a refusal quotes no path: ' + path);
    }
    // A servable document, with a spec anchor, is accepted and normalised.
    const withDocument = await f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'document', path: './docs/spec/product.md', anchor: 'intent' }, revision: 2 });
    assert.equal(withDocument.revision, 3);
    assert.deepEqual(withDocument.links, [
      { kind: 'document', path: 'docs/spec/product.md', anchor: 'intent' },
      { kind: 'task', taskId: f.taskId }
    ]);
    // Nothing was written for any refusal: the record is exactly what the accepted writes made it.
    assert.deepEqual(f.registry.read(f.project.id, session.id), withDocument);
    assert.equal(countOperations(f.store), 3, 'two accepted links and one create');
  } finally { await f.cleanup(); }
});

test('sessions: a workspace link must be inside the approved roots and must never follow a symlink out of them', async () => {
  const f = await fixture();
  try {
    const session = await f.registry.create({ projectId: f.project.id, name: 'Workspace' });
    const inside = join(f.workspaces, 'inside'), nested = join(f.workspaces, 'nested'), outside = join(f.root, 'outside');
    await mkdir(inside, { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(outside, { recursive: true });
    // A directory inside the approved roots is accepted, and its canonical location is stored.
    const linked = await f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'workspace', path: inside }, revision: 1 });
    assert.deepEqual(linked.links, [{ kind: 'workspace', path: await realpath(inside) }]);
    assert.equal(linked.revision, 2);
    // A symlink that leads out of the approved roots resolves outside them and is refused.
    await symlink(outside, join(f.workspaces, 'escape'));
    const escaped = await refusal(f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'workspace', path: join(f.workspaces, 'escape') }, revision: 2 }), 'OUTSIDE_ROOTS');
    assert.match(escaped, /outside the approved roots/);
    assert.ok(!escaped.includes(outside) && !escaped.includes('escape'), 'a refusal leaks no path');
    // A path outside the roots entirely, a path that does not exist, and a file rather than a
    // directory are all refused, with the reason that says which.
    assert.match(await refusal(f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'workspace', path: outside }, revision: 2 }), 'OUTSIDE_ROOTS'), /outside the approved roots/);
    assert.match(await refusal(f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'workspace', path: join(inside, 'file') }, revision: 2 }), 'NOT_FOUND'), /No workspace directory exists/);
    await writeFile(join(inside, 'file'), 'not a directory');
    assert.match(await refusal(f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'workspace', path: join(inside, 'file') }, revision: 2 }), 'OUTSIDE_ROOTS'), /not a directory/);
    // A relative path is never a workspace path.
    assert.match(await refusal(f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'workspace', path: 'workspaces/inside' }, revision: 2 }), 'INVALID'), /absolute path/);
    // A symlink that stays inside the roots is accepted, and what is stored is the real location.
    await symlink(nested, join(f.workspaces, 'alias'));
    const aliased = await f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'workspace', path: join(f.workspaces, 'alias') }, revision: 2 });
    assert.equal(aliased.revision, 3);
    assert.deepEqual(aliased.links, [
      { kind: 'workspace', path: await realpath(inside) },
      { kind: 'workspace', path: await realpath(nested) }
    ]);
  } finally { await f.cleanup(); }
});

test('sessions: a rename is revision-checked and idempotent, and a stale revision changes nothing', async () => {
  const f = await fixture();
  try {
    const created = await f.registry.create({ projectId: f.project.id, name: 'First' });
    const renamed = f.registry.rename({ projectId: f.project.id, sessionId: created.id, name: 'Second', revision: 1 });
    assert.equal(renamed.revision, 2);
    assert.equal(renamed.name, 'Second');
    assert.equal(renamed.createdAt, created.createdAt);
    // Renaming to the name it already has is a no-op at any revision, so a retry is idempotent.
    assert.deepEqual(f.registry.rename({ projectId: f.project.id, sessionId: created.id, name: 'Second', revision: 2 }), renamed);
    assert.deepEqual(f.registry.rename({ projectId: f.project.id, sessionId: created.id, name: 'Second', revision: 1 }), renamed);
    // A stale revision with a different name is refused, and the record is unchanged.
    const stale = refusalSync(() => f.registry.rename({ projectId: f.project.id, sessionId: created.id, name: 'Third', revision: 1 }), 'CONFLICT');
    assert.match(stale, /is at revision 2, not 1/);
    assert.match(stale, /wrote nothing and the record is unchanged/);
    assert.deepEqual(f.registry.read(f.project.id, created.id), renamed);
    // A revision ahead of the record is refused too, and the current name still wins.
    refusalSync(() => f.registry.rename({ projectId: f.project.id, sessionId: created.id, name: 'Fourth', revision: 9 }), 'CONFLICT');
    assert.equal(f.registry.read(f.project.id, created.id).name, 'Second');
    assert.equal(countOperations(f.store), 2, 'the create and exactly one rename were written');
  } finally { await f.cleanup(); }
});

test('sessions: linking and unlinking are revision-checked, and both are idempotent', async () => {
  const f = await fixture();
  try {
    const session = await f.registry.create({ projectId: f.project.id, name: 'Links' });
    const task = { kind: 'task', taskId: f.taskId } as const;
    const document = { kind: 'document', path: 'docs/spec/product.md', anchor: null } as const;
    const linked = await f.registry.link({ projectId: f.project.id, sessionId: session.id, link: task, revision: 1 });
    assert.equal(linked.revision, 2);
    // Linking a link the session already has is a no-op at any revision.
    assert.deepEqual(await f.registry.link({ projectId: f.project.id, sessionId: session.id, link: task, revision: 2 }), linked);
    assert.deepEqual(await f.registry.link({ projectId: f.project.id, sessionId: session.id, link: task, revision: 99 }), linked);
    const both = await f.registry.link({ projectId: f.project.id, sessionId: session.id, link: document, revision: 2 });
    assert.equal(both.revision, 3);
    assert.equal(both.links.length, 2);
    // A stale revision with a link that would change the record is refused, and nothing is written.
    const staleLink = await refusal(f.registry.link({ projectId: f.project.id, sessionId: session.id, link: { kind: 'workspace', path: f.workspaces }, revision: 1 }), 'CONFLICT');
    assert.match(staleLink, /the link wrote nothing and the record is unchanged/);
    assert.deepEqual(f.registry.read(f.project.id, session.id), both);
    // Unlinking is a revision-checked write, and unlinking what is not there is a no-op.
    const unlinked = f.registry.unlink({ projectId: f.project.id, sessionId: session.id, link: task, revision: 3 });
    assert.equal(unlinked.revision, 4);
    assert.deepEqual(unlinked.links, [{ kind: 'document', path: 'docs/spec/product.md', anchor: null }]);
    assert.deepEqual(f.registry.unlink({ projectId: f.project.id, sessionId: session.id, link: task, revision: 4 }), unlinked);
    assert.deepEqual(f.registry.unlink({ projectId: f.project.id, sessionId: session.id, link: { kind: 'task', taskId: randomUUID() }, revision: 1 }), unlinked);
    // A present link with a stale revision is a conflict, not a silent removal.
    const staleUnlink = refusalSync(() => f.registry.unlink({ projectId: f.project.id, sessionId: session.id, link: document, revision: 1 }), 'CONFLICT');
    assert.match(staleUnlink, /the unlink wrote nothing and the record is unchanged/);
    assert.deepEqual(f.registry.read(f.project.id, session.id), unlinked);
    assert.equal(countOperations(f.store), 4, 'a create, two links and one unlink were written');
  } finally { await f.cleanup(); }
});

test('sessions: records survive a reopen, and the registry reads only its own operations', async () => {
  const f = await fixture();
  try {
    const created = await f.registry.create({ projectId: f.project.id, name: 'Durable' });
    const linked = await f.registry.link({ projectId: f.project.id, sessionId: created.id, link: { kind: 'task', taskId: f.taskId }, revision: 1 });
    // A durable record of another kind in the very same scope is not a session.
    f.store.admit({
      scope: { projectId: f.project.id, sessionId: created.id },
      idempotencyKey: 'question.' + 'a'.repeat(48),
      kind: 'question.delivery',
      input: { version: 1, delivery: 'question', questionId: randomUUID(), text: 'Should I proceed?', askedAt: new Date().toISOString() },
      outbox: { kind: 'question.notify', payload: { version: 1, delivery: 'question', questionId: randomUUID(), tag: 't', requestId: null } }
    });
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM operations').get() as { n: number }).n, 3);
    assert.deepEqual(f.registry.list(f.project.id), [linked]);
    f.store.close();
    // Reopened from disk, the same record is read back, and reading is still core-only.
    const reopened = new ControlStore(f.data);
    try {
      const registry = new SessionRegistry(reopened, f.resources);
      assert.deepEqual(registry.read(f.project.id, created.id), linked);
      assert.deepEqual(registry.list(f.project.id), [linked]);
      assert.equal(registry.has(f.project.id, created.id), true);
      assert.equal(registry.has(f.project.id, randomUUID()), false);
      assert.deepEqual(registry.list(f.project.id).map((record) => record.links.length), [1]);
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});

test('migration: the legacy conversation is adopted once, a dry run changes nothing, and a project without one is untouched', async () => {
  const f = await fixture('Ops');
  const conversationFile = join(f.data, 'agents', f.project.id, 'session.sqlite');
  const silent = randomUUID();
  const calls = { task: 0, document: 0, workspace: 0 };
  // A counting port proves what the migration actually resolved: it must resolve workspace links and
  // nothing else, because it reads no board and no document to adopt a conversation.
  const registry = new SessionRegistry(f.store, {
    knownProject: (id) => f.resources.knownProject(id),
    containsTask: async (id, taskId) => { calls.task += 1; return f.resources.containsTask(id, taskId); },
    resolveDocument: async (id, path) => { calls.document += 1; return f.resources.resolveDocument(id, path); },
    resolveWorkspace: async (path) => { calls.workspace += 1; return f.resources.resolveWorkspace(path); }
  });
  const legacy = legacyConversationPort({
    dataRoot: f.data,
    projects: async () => [{ id: f.project.id, name: f.project.name, path: f.project.path }, { id: silent, name: 'No conversation', path: '' }]
  });
  try {
    // Neither project has a conversation store yet: nothing is planned, nothing is written.
    const empty = await migrateLegacyConversations({ registry, legacy, dryRun: true });
    assert.equal(empty.dryRun, true);
    assert.deepEqual(empty.counts, { projects: 2, conversations: 0, adopted: 0, alreadyAdopted: 0, withoutConversation: 2, refused: 0 });
    assert.deepEqual(await registry.list(f.project.id), []);
    // The app opens its harness, which creates the lazy conversation: the store appears on disk.
    await mkdir(join(f.data, 'agents', f.project.id), { recursive: true, mode: 0o700 });
    await writeFile(conversationFile, 'legacy conversation bytes');
    const transcript = digest(await readFile(conversationFile));
    const beforeBytes = await readFile(join(f.data, 'control.sqlite'));
    // A dry run reports exactly what it would create and changes nothing at all.
    const planned = await migrateLegacyConversations({ registry, legacy, dryRun: true });
    assert.deepEqual(planned.counts, { projects: 2, conversations: 1, adopted: 1, alreadyAdopted: 0, withoutConversation: 1, refused: 0 });
    const plannedAction = planned.actions.find((action) => action.projectId === f.project.id)!;
    assert.equal(plannedAction.action, 'adopt');
    assert.equal(plannedAction.sessionId, LEGACY_SESSION_ID);
    assert.match(plannedAction.reason, /would create session/);
    assert.deepEqual(planned, await migrateLegacyConversations({ registry, legacy, dryRun: true }), 'a dry run is deterministic');
    assert.equal(countOperations(f.store), 0, 'a dry run writes no session record');
    assert.deepEqual(await readFile(join(f.data, 'control.sqlite')), beforeBytes, 'a dry run leaves the control database bytes alone');
    assert.deepEqual(await registry.list(f.project.id), []);
    assert.equal(calls.task + calls.document, 0, 'a migration reads no board and no document');
    // The real run adopts it once, linking the project folder as a workspace.
    const applied = await migrateLegacyConversations({ registry, legacy, dryRun: false });
    assert.deepEqual(applied.counts, { projects: 2, conversations: 1, adopted: 1, alreadyAdopted: 0, withoutConversation: 1, refused: 0 });
    const adopted = registry.read(f.project.id, LEGACY_SESSION_ID);
    assert.equal(adopted.name, legacySessionName('Ops'));
    assert.equal(adopted.revision, 1);
    assert.equal(adopted.model, null, 'the migration declares no model choice');
    assert.equal(adopted.createdAt, adopted.updatedAt);
    assert.deepEqual(adopted.links, [{ kind: 'workspace', path: await realpath(f.project.path) }]);
    assert.equal(countOperations(f.store), 1);
    assert.equal(countRows(f.store, 'outboxes', 'session.registry'), 1);
    assert.equal(digest(await readFile(conversationFile)), transcript, 'the migration leaves the conversation store byte-identical');
    assert.ok(!JSON.stringify(applied).includes(f.data) && !JSON.stringify(applied).includes(f.project.path), 'the report carries no filesystem path');
    // Running it again produces the same registry state and duplicates nothing.
    const again = await migrateLegacyConversations({ registry, legacy, dryRun: false });
    assert.equal(again.counts.adopted, 0);
    assert.equal(again.counts.alreadyAdopted, 1);
    assert.match(again.actions.find((action) => action.projectId === f.project.id)!.reason, /already registered/);
    assert.deepEqual(registry.read(f.project.id, LEGACY_SESSION_ID), adopted, 'the second run changes nothing');
    assert.deepEqual(registry.list(f.project.id).map((record) => record.id), [LEGACY_SESSION_ID]);
    assert.equal(countOperations(f.store), 1, 'no second session and no second link');
    assert.equal(countRows(f.store, 'outboxes', 'session.registry'), 1);
    assert.deepEqual(again, await migrateLegacyConversations({ registry, legacy, dryRun: false }), 'a settled migration is deterministic');
    // The project without a conversation was never considered a session, and got no link either.
    assert.deepEqual(registry.list(silent), []);
    // Two dry runs and one write each read a plan, and the write resolves its own links again so a
    // caller's claim is never trusted: four resolutions, three of them read-only.
    assert.equal(calls.workspace, 4, 'only workspace links were resolved, and only for the adopt plans');
  } finally { await f.cleanup(); }
});

test('migration: a name another live session already holds is refused rather than renamed', async () => {
  const f = await fixture('Ops');
  const conversationFile = join(f.data, 'agents', f.project.id, 'session.sqlite');
  try {
    await mkdir(join(f.data, 'agents', f.project.id), { recursive: true, mode: 0o700 });
    await writeFile(conversationFile, 'legacy conversation bytes');
    const transcript = digest(await readFile(conversationFile));
    const taken = await f.registry.create({ projectId: f.project.id, name: legacySessionName('Ops') });
    const legacy = legacyConversationPort({ dataRoot: f.data, projects: async () => [{ id: f.project.id, name: f.project.name, path: f.project.path }] });
    const report = await migrateLegacyConversations({ registry: f.registry, legacy, dryRun: false });
    assert.deepEqual(report.counts, { projects: 1, conversations: 1, adopted: 0, alreadyAdopted: 0, withoutConversation: 0, refused: 1 });
    assert.match(report.actions[0].reason, /already named/);
    assert.ok(!report.actions[0].reason.includes(f.project.path), 'the refusal quotes no path');
    assert.equal(countOperations(f.store), 1, 'the refused migration wrote nothing');
    assert.deepEqual(f.registry.list(f.project.id).map((record) => record.id), [taken.id]);
    assert.equal(digest(await readFile(conversationFile)), transcript, 'the transcript is byte-identical');
  } finally { await f.cleanup(); }
});
