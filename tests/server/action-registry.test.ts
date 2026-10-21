import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore, HttpError } from '../../src/server/board-store';
import { DocStore } from '../../src/server/docs-store';
import { ControlStore } from '../../src/server/state/control-store';
import { ApprovalStore } from '../../src/server/state/approval-store';
import { DeliveryLedger } from '../../src/server/state/delivery';
import { SessionRegistry, createSessionResourcePort, migrateLegacyConversations } from '../../src/server/state/session-registry';
import { SessionLifecycleService, SessionLifecycleStore, adoptRunningSessions, type SessionLifecycleActionResult, type SessionLifecyclePort } from '../../src/server/state/session-lifecycle';
import { QueueStore, type QueueResult, type QueueSubmissionRecord } from '../../src/server/state/queue-store';
import { ActionError, ActionRegistry, actionHandlerIds, assertActionRegistryConsistent, assertHandlerSet, liveActivity, normaliseActionScope, type ActionEnvironment, type ActionScope } from '../../src/server/state/action-registry';
import { ACTION_DESCRIPTORS, ACTION_IDS, ACTION_PRECONDITION_CODES, ACTION_REVISION_SOURCES, LIVE_RUN_DETAILS, LIVE_RUN_REASONS, LIVE_TOOL_DETAILS, LIVE_TOOL_REASONS, LIVE_TOOL_SOURCE, type ActionDescriptor, type ActionId, type ActionPreconditionCode } from '../../src/shared/actions';
import { SessionError, type SessionRecord } from '../../src/shared/sessions';
import { SessionLifecycleError } from '../../src/shared/session-lifecycle';
import { ApprovalError } from '../../src/shared/approvals';
import { QUEUE_MAX_ENTRIES, queueRequestId, type QueueView } from '../../src/shared/queue';
import { QueueError } from '../../src/shared/queue';
import { emptyBoard, newTask, type Project } from '../../src/shared/model';
import { serializeBoard } from '../../src/shared/markdown';
import type { AgentEntry, AgentView } from '../../src/shared/agent';

/**
 * The command registry: one typed action per capability this build really has, bound to the handler
 * that owns it.
 *
 * Everything here runs over a disposable root with its own control store, board, documentation and
 * workspace, and a synthetic lifecycle port. Nothing reads or writes a live project, a real planning
 * document, a provider or an agent store, and no model call is made.
 */

type Port = SessionLifecyclePort & { readonly calls: string[]; refusal: Error | null };

type Fixture = {
  root: string; workspaces: string; data: string;
  project: Project; taskId: string;
  store: ControlStore; sessions: SessionRegistry; lifecycleStore: SessionLifecycleStore;
  lifecycle: SessionLifecycleService; approvals: ApprovalStore; ledger: DeliveryLedger; port: Port;
  queue: QueueStore; queueClock: { now: number }; queueLedger: Map<string, QueueSubmissionRecord>; queueCalls: string[];
  environment: ActionEnvironment; actions: ActionRegistry;
  cleanup(): Promise<void>;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-actions-'));
  const workspaces = join(root, 'workspaces'), projectPath = join(workspaces, 'project'), data = join(root, 'data');
  await mkdir(join(projectPath, 'docs', 'spec'), { recursive: true, mode: 0o755 });
  await mkdir(data, { recursive: true, mode: 0o700 });
  const store = new ControlStore(data), boards = new BoardStore(data), docs = new DocStore();
  const project: Project = { id: randomUUID(), name: 'Registry workspace', path: projectPath, managed: false, repository: '', created: new Date().toISOString() };
  await boards.initialize(project, serializeBoard(emptyBoard()));
  const taskId = randomUUID();
  const snapshot = await boards.read(project);
  await boards.mutate(project, snapshot.revision, { op: 'putTask', task: newTask(taskId, 'Ship the release') });
  await docs.create(project, 'docs/spec/product.md', '# Product\n');
  const resources = createSessionResourcePort({
    browseRoots: [workspaces],
    project: (id) => (id === project.id ? project : undefined),
    taskIds: async (id) => (id === project.id ? (await boards.read(project)).board.tasks.map((task) => task.id) : []),
    documentServable: async (id, path) => {
      if (id !== project.id) return false;
      try { await docs.read(project, path); return true; } catch (error) { if (error instanceof HttpError && error.status === 404) return false; throw error; }
    }
  });
  const sessions = new SessionRegistry(store, resources);
  const lifecycleStore = new SessionLifecycleStore(store);
  const port: Port = {
    calls: [],
    refusal: null,
    authoriseDispatch() { port.calls.push('authorise'); if (port.refusal) throw port.refusal; },
    async resume({ requestId }) { port.calls.push('resume:' + requestId); },
    async retry({ requestId }) { port.calls.push('retry:' + requestId); },
    async cancel() { port.calls.push('cancel'); if (port.refusal) throw port.refusal; }
  };
  const lifecycle = new SessionLifecycleService(lifecycleStore, port);
  const approvals = new ApprovalStore(store), ledger = new DeliveryLedger(store);
  // The queue's dispatcher is synthetic: an in-memory transcript that is idempotent by request
  // identity, exactly as the durable harness is. No harness is opened and no model call is made.
  const queueLedger = new Map<string, QueueSubmissionRecord>(), queueCalls: string[] = [], queueClock = { now: Date.parse('2025-01-01T00:00:00.000Z') };
  const queue = new QueueStore(store, {
    authorise() { queueCalls.push('authorise'); },
    async submit({ requestId, entryId }) {
      queueCalls.push('submit:' + requestId);
      const existing = queueLedger.get(requestId);
      if (existing) return existing;
      const record: QueueSubmissionRecord = Object.freeze({ requestId, entryId, submissionId: 'submission-' + (queueLedger.size + 1), acceptedAt: new Date(queueClock.now).toISOString() });
      queueLedger.set(requestId, record);
      return record;
    },
    async lookup({ requestId }) { queueCalls.push('lookup:' + requestId); return queueLedger.get(requestId) ?? null; }
  }, { clock: () => new Date(queueClock.now) });
  const environment: ActionEnvironment = {
    control: {
      sessions, lifecycle, approvals, ledger, queue,
      // An attached image id resolves to the stored facts the queue records; an id the media store
      // does not hold is refused, which the HTTP tests drive against the real media store.
      media: { resolve: async (ids) => Object.freeze(ids.map((id) => Object.freeze({ id, mimeType: 'image/png' as const, bytes: 64, width: 8, height: 8 }))) },
      // The store is the authority on whether a durable lifecycle row exists at all: the projection
      // reads it rather than reporting the deterministic initial record as a state.
      lifecycleRecorded: (projectId, sessionId) => lifecycleStore.has(projectId, sessionId),
      migrate: (dryRun) => migrateLegacyConversations({
        registry: sessions, dryRun,
        legacy: { projects: async () => [{ id: project.id, name: project.name, path: project.path }], conversationFor: async () => null }
      })
    },
    doctor: async () => ({ report: { readOnly: true, guarantee: 'The doctor reads only.' }, unsafe: false }),
    agents: { enabled: true, read: async () => view() }
  };
  return {
    root, workspaces, data, project, taskId, store, sessions, lifecycleStore, lifecycle, approvals, ledger, port, queue, queueClock, queueLedger, queueCalls, environment,
    actions: new ActionRegistry(environment),
    cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); }
  };
}

function view(overrides: Partial<AgentView> = {}): AgentView {
  return { conversationId: '1', working: false, attempt: null, entries: [], partial: '', inbox: [], usage: { input: 0, output: 0, cost: 0 }, model: null, questions: [], updatedAt: new Date(0).toISOString(), ...overrides };
}
function entry(overrides: Partial<AgentEntry> & { rawKind: string }): AgentEntry {
  return { id: randomUUID(), kind: 'other', at: null, text: '', thinking: '', tools: [], stopReason: null, error: null, data: null, ...overrides };
}
function scopeOf(f: Fixture, sessionId?: string): ActionScope {
  return Object.freeze({ projectId: f.project.id, ...(sessionId === undefined ? {} : { sessionId }) });
}
/** The scope every one of an action's declared dimensions can be filled with in this fixture. */
async function scopeFor(f: Fixture, descriptor: ActionDescriptor): Promise<ActionScope> {
  const scope: { projectId?: string; sessionId?: string } = {};
  if (descriptor.requires.includes('project')) scope.projectId = f.project.id;
  if (descriptor.requires.includes('session')) {
    const existing = f.sessions.list(f.project.id);
    scope.sessionId = existing[0]?.id ?? (await f.sessions.create({ projectId: f.project.id, name: 'Scope fixture ' + randomUUID().slice(0, 8) })).id;
  }
  return Object.freeze(scope);
}
async function newSession(f: Fixture, name: string): Promise<SessionRecord> {
  return f.sessions.create({ projectId: f.project.id, name });
}
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error('expected a refusal, but the call succeeded');
}
async function actionRefusal(promise: Promise<unknown>, code: ActionError['code']): Promise<string> {
  const error = await refusal(promise);
  if (!(error instanceof ActionError)) throw error;
  assert.equal(error.code, code);
  return error.message;
}

test('the declared registry and its handlers are the same closed set, and no action is a stub', async () => {
  const f = await fixture();
  try {
    // The two directions, checked on what the code declares rather than asserted in prose.
    assertActionRegistryConsistent();
    assertHandlerSet(f.environment);
    assert.deepEqual(actionHandlerIds(f.environment), [...ACTION_IDS].sort());
    assert.deepEqual([...ACTION_IDS].sort(), ACTION_DESCRIPTORS.map((descriptor) => descriptor.id).sort());

    // Every declared precondition code is used by at least one action: the vocabulary has no dead word.
    const declared = new Set(ACTION_DESCRIPTORS.flatMap((descriptor) => descriptor.preconditions.map((precondition) => precondition.code)));
    for (const code of ACTION_PRECONDITION_CODES) assert.ok(declared.has(code), 'no action uses the precondition code ' + code);
    // Every action is offered on the palette of this build, and no action claims a surface that does not exist.
    for (const descriptor of ACTION_DESCRIPTORS) assert.deepEqual(descriptor.surfaces, ['palette'], 'no action claims an unimplemented surface');
    // Every revision parameter names the read its value comes from, so no client decides which
    // revision an action checks and none of them is left to a guess:
    for (const descriptor of ACTION_DESCRIPTORS) {
      for (const parameter of descriptor.parameters) {
        if (parameter.type === 'revision') {
          assert.ok(ACTION_REVISION_SOURCES.includes(parameter.revisionSource!), descriptor.id + ' declares where ' + parameter.name + ' comes from');
        } else {
          assert.equal(parameter.revisionSource, undefined, descriptor.id + ' declares no revision source on ' + parameter.name);
        }
      }
    }
    const lifecycleRevision = ACTION_DESCRIPTORS.filter((descriptor) => descriptor.id.startsWith('session.lifecycle.'));
    assert.equal(lifecycleRevision.length, 5);
    for (const descriptor of lifecycleRevision) {
      assert.equal(descriptor.parameters.find((parameter) => parameter.name === 'revision')!.revisionSource, 'session-lifecycle-revision');
    }
    for (const id of ['session.rename', 'session.link', 'session.unlink'] as const) {
      const descriptor = ACTION_DESCRIPTORS.find((candidate) => candidate.id === id)!;
      assert.equal(descriptor.parameters.find((parameter) => parameter.name === 'revision')!.revisionSource, 'session-record-revision');
    }
    // The queue's revision is read from the queue itself, so a client never guesses which revision an
    // edit checks and no queue action can be asked to write at a revision nobody read.
    const queueRevisionChecked = ACTION_DESCRIPTORS.filter((descriptor) => descriptor.parameters.some((parameter) => parameter.revisionSource === 'queue-revision'));
    assert.deepEqual(queueRevisionChecked.map((descriptor) => descriptor.id).sort(),
      ['queue.append', 'queue.cancel', 'queue.clear', 'queue.edit', 'queue.remove', 'queue.reorder']);
    // Only a queue action names the queue's own revision, and only the queue actions that change the
    // queue take one: a claim is serialised by the store's transaction, not by a client's revision.
    for (const descriptor of ACTION_DESCRIPTORS.filter((candidate) => candidate.id.startsWith('queue.'))) {
      const revision = descriptor.parameters.find((parameter) => parameter.type === 'revision');
      assert.equal(revision === undefined, !queueRevisionChecked.includes(descriptor), descriptor.id + ' takes a queue revision exactly when it changes the queue');
    }
  } finally { await f.cleanup(); }
});

test('every declared action is reachable and really acts through its own handler', async () => {
  const f = await fixture();
  const exercised: string[] = [];
  const drive = async (id: ActionId, params: unknown, scope: ActionScope): Promise<unknown> => {
    exercised.push(id);
    return f.actions.run(id, params, scope);
  };
  try {
    // Sessions: create really writes, rename/link/unlink really write a new revision.
    const created = await drive('session.create', { name: 'Second session' }, scopeOf(f)) as SessionRecord;
    assert.equal(created.name, 'Second session');
    assert.equal(f.sessions.read(f.project.id, created.id).id, created.id, 'creating a session really wrote it');
    // A declared model choice is a parameter that really works, not a field that can only be refused.
    const modelled = await drive('session.create', { name: 'Modelled session', model: { provider: 'scripted', modelId: 'scripted-1' } }, scopeOf(f)) as SessionRecord;
    assert.deepEqual(modelled.model, { provider: 'scripted', modelId: 'scripted-1' }, 'the model parameter is recorded with the session');
    const renamed = await drive('session.rename', { name: 'Renamed session', revision: created.revision }, scopeOf(f, created.id)) as SessionRecord;
    assert.deepEqual([renamed.name, renamed.revision], ['Renamed session', 2]);
    const linked = await drive('session.link', { link: { kind: 'task', taskId: f.taskId }, revision: renamed.revision }, scopeOf(f, created.id)) as SessionRecord;
    assert.equal(linked.links.length, 1);
    const unlinked = await drive('session.unlink', { link: { kind: 'task', taskId: f.taskId }, revision: linked.revision }, scopeOf(f, created.id)) as SessionRecord;
    assert.deepEqual(unlinked.links, []);
    assert.equal(f.sessions.read(f.project.id, created.id).revision, unlinked.revision, 'the registry holds the last revision');

    // The lifecycle: reconnect attaches, stop cancels, pause cancels and keeps the identity, resume
    // continues it, retry starts a new attempt.
    // A session with no durable lifecycle row reads at the deterministic revision 0, which is exactly
    // what a fresh client puts back, so the attach is a no-op at that revision.
    const fresh = f.lifecycleStore.read(f.project.id, created.id);
    assert.deepEqual([fresh.state, fresh.revision], ['idle', 0]);
    const reconnected = await drive('session.lifecycle.reconnect', { revision: fresh.revision }, scopeOf(f, created.id)) as SessionLifecycleActionResult;
    assert.deepEqual([reconnected.unchanged, reconnected.dispatched, reconnected.record.revision], [true, false, 0]);
    f.lifecycleStore.markRunning({ projectId: f.project.id, sessionId: created.id, requestId: 'drive-1' });
    const running = f.lifecycleStore.read(f.project.id, created.id);
    const stopped = await drive('session.lifecycle.stop', { revision: running.revision }, scopeOf(f, created.id)) as SessionLifecycleActionResult;
    assert.deepEqual([stopped.cancelled, stopped.dispatched, stopped.record.state], [true, false, 'idle']);
    f.lifecycleStore.markRunning({ projectId: f.project.id, sessionId: created.id, requestId: 'drive-2' });
    const beforePause = f.lifecycleStore.read(f.project.id, created.id);
    const paused = await drive('session.lifecycle.pause', { revision: beforePause.revision, reason: 'paused by the test' }, scopeOf(f, created.id)) as SessionLifecycleActionResult;
    assert.deepEqual([paused.cancelled, paused.record.state, paused.record.reason], [true, 'paused', 'paused by the test']);
    const resumed = await drive('session.lifecycle.resume', { revision: paused.record.revision }, scopeOf(f, created.id)) as SessionLifecycleActionResult;
    assert.deepEqual([resumed.dispatched, resumed.record.state, resumed.record.requestId], [true, 'running', 'drive-2']);
    assert.ok(f.port.calls.includes('resume:drive-2'), 'the handler really asked its port to resume');
    f.lifecycleStore.markSettled({ projectId: f.project.id, sessionId: created.id, outcome: 'failed' });
    const failed = f.lifecycleStore.read(f.project.id, created.id);
    const retried = await drive('session.lifecycle.retry', { revision: failed.revision }, scopeOf(f, created.id)) as SessionLifecycleActionResult;
    assert.deepEqual([retried.dispatched, retried.record.attempt], [true, failed.attempt + 1]);
    assert.ok(retried.record.requestId?.startsWith('retry:'), 'a retry derives a new request identity');

    // The migration: planned and applied, with the report the handler returned.
    const plan = await drive('session.migration.plan', {}, {}) as { dryRun: boolean; counts: { withoutConversation: number } };
    assert.deepEqual([plan.dryRun, plan.counts.withoutConversation], [true, 1]);
    assert.equal((await drive('session.migration.apply', {}, {}) as { dryRun: boolean }).dryRun, false);

    // The approvals: created, consumed against the exact target, and revoked.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const push = { remote: 'origin', branch: 'main', commitSha: 'a'.repeat(40) };
    const approval = await drive('approval.create', { kind: 'push', scope: { projectId: f.project.id }, target: push, expiresAt }, {}) as { id: string; nonce: string; state: string };
    assert.deepEqual([approval.state, typeof approval.nonce], ['pending', 'string']);
    const consumed = await drive('approval.consume', { id: approval.id, scope: { projectId: f.project.id }, kind: 'push', target: push, consumedBy: 'owner' }, {}) as { approval: { state: string }; target: { branch: string } };
    assert.deepEqual([consumed.approval.state, consumed.target.branch], ['consumed', 'main']);
    const revocable = await drive('approval.create', { kind: 'deploy', scope: { operation: 'release-9' }, target: { endpoint: 'https://example.invalid', releaseId: 'r1' }, expiresAt }, {}) as { id: string };
    assert.equal((await drive('approval.revoke', { id: revocable.id, scope: { operation: 'release-9' }, revokedBy: 'owner', reason: 'held back' }, {}) as { state: string }).state, 'revoked');

    // The two read-only reports.
    const doctor = await drive('doctor.report', {}, {}) as { readOnly: boolean; unsafe: boolean };
    assert.deepEqual([doctor.readOnly, doctor.unsafe], [true, false]);
    const reconciliation = await drive('delivery.reconciliation.report', {}, {}) as { readOnly: boolean; counts: { pendingOperations: number } };
    assert.deepEqual([reconciliation.readOnly, reconciliation.counts.pendingOperations], [true, 0]);

    // The queue: every one of the eleven operations driven through the registry, on a real session.
    const queueScope = scopeOf(f, created.id);
    const first = await drive('queue.append', { revision: 0, text: 'queued first' }, queueScope) as QueueResult;
    assert.deepEqual([first.outcome, first.record.revision, first.entry!.state], ['appended', 1, 'queued']);
    const second = await drive('queue.append', { revision: 1, text: 'queued second' }, queueScope) as QueueResult;
    const read = await drive('queue.read', {}, queueScope) as QueueView;
    assert.deepEqual([read.readOnly, read.revision, read.entries.map((entry) => entry.text)], [true, 2, ['queued first', 'queued second']]);
    assert.deepEqual(read.limits, { entries: QUEUE_MAX_ENTRIES, text: 2000, imagesPerEntry: 6, bytes: 65536 });
    const edited = await drive('queue.edit', { revision: 2, entryId: second.entry!.id, text: 'queued second, edited' }, queueScope) as QueueResult;
    assert.equal(edited.entry!.text, 'queued second, edited');
    const reordered = await drive('queue.reorder', { revision: edited.record.revision, entryId: second.entry!.id, position: 0 }, queueScope) as QueueResult;
    assert.deepEqual(reordered.record.entries.map((entry) => entry.id), [second.entry!.id, first.entry!.id]);
    // A claim goes to the head entry, and the instance is asked whether it can dispatch first.
    const claimed = await drive('queue.claim', { owner: 'registry-dispatcher' }, queueScope) as QueueResult;
    assert.deepEqual([claimed.outcome, claimed.entry!.id, claimed.entry!.state], ['claimed', second.entry!.id, 'claimed']);
    assert.ok(f.queueCalls.includes('authorise'), 'the handler asked whether this instance can dispatch before claiming');
    const released = await drive('queue.release', { entryId: second.entry!.id, owner: 'registry-dispatcher' }, queueScope) as QueueResult;
    assert.equal(released.entry!.state, 'queued');
    await drive('queue.claim', { owner: 'registry-dispatcher' }, queueScope);
    const submitted = await drive('queue.submit', { entryId: second.entry!.id, owner: 'registry-dispatcher' }, queueScope) as QueueResult;
    assert.deepEqual([submitted.outcome, submitted.entry!.state], ['submitted', 'submitted']);
    assert.equal(submitted.entry!.submission!.requestId, queueRequestId(second.entry!.id), 'the submission identity is derived from the entry id');
    assert.equal(f.queueLedger.size, 1, 'the handler really submitted, once');
    const reconciled = await drive('queue.reconcile', { entryId: second.entry!.id }, queueScope) as QueueResult;
    assert.deepEqual([reconciled.outcome, reconciled.entry!.state], ['settled', 'settled']);
    const cancelled = await drive('queue.cancel', { revision: reconciled.record.revision, entryId: first.entry!.id }, queueScope) as QueueResult;
    assert.equal(cancelled.entry!.state, 'cancelled');
    const cleared = await drive('queue.clear', { revision: cancelled.record.revision }, queueScope) as QueueResult;
    assert.deepEqual([cleared.outcome, cleared.removed, cleared.record.entries.map((entry) => entry.state)], ['cleared', 1, ['cancelled']], 'the settled entry is cleared and the cancelled one is not');
    const third = await drive('queue.append', { revision: cleared.record.revision, text: 'queued third', images: ['a'.repeat(64)] }, queueScope) as QueueResult;
    assert.deepEqual(third.entry!.images.map((image) => image.id), ['a'.repeat(64)], 'an attached image id is resolved to the stored facts the queue records');
    const removed = await drive('queue.remove', { revision: third.record.revision, entryId: third.entry!.id }, queueScope) as QueueResult;
    assert.deepEqual([removed.outcome, removed.removed, removed.record.entries.length], ['removed', 1, 1]);

    const distinct = [...new Set(exercised)].sort();
    assert.deepEqual(distinct, [...ACTION_IDS].sort(), 'every declared action was driven through the registry');
    assert.ok(exercised.length >= distinct.length, 'a driven action was recorded');
  } finally { await f.cleanup(); }
});

test('the parameter schema is the strict one the registry publishes, and every required parameter is real', async () => {
  const f = await fixture();
  try {
    for (const descriptor of ACTION_DESCRIPTORS) {
      const schema = f.actions.paramSchema(descriptor.id);
      // An unknown field is refused by the published schema, for every action.
      const unknown = schema.safeParse({ surprise: true });
      assert.equal(unknown.success, false, descriptor.id + ' must refuse an unknown parameter field');
      assert.ok((unknown as { error: { issues: { code: string }[] } }).error.issues.some((issue) => issue.code === 'unrecognized_keys'), descriptor.id + ' refuses the unknown field by name');
      assert.equal(f.actions.paramSchema(descriptor.id), schema, 'the schema is the same object on every read');
      const required = descriptor.parameters.filter((parameter) => parameter.required);
      if (required.length === 0) {
        assert.equal(schema.safeParse({}).success, true, descriptor.id + ' takes no parameter');
        continue;
      }
      // A required parameter really is required: omitting all of them is refused, and the reason names one.
      const message = await actionRefusal(f.actions.run(descriptor.id, {}, await scopeFor(f, descriptor)), 'INVALID');
      assert.ok(required.some((parameter) => message.includes(parameter.name)), descriptor.id + ' names the missing field: ' + message);
    }
  } finally { await f.cleanup(); }
});

test('the declared session model is a parameter that works end to end, in its declared shape only', async () => {
  const f = await fixture();
  try {
    // The registry publishes the shape the session model parses: {provider, modelId}, or null.
    const chosen = await f.actions.run('session.create', { name: 'Chosen model', model: { provider: 'scripted', modelId: 'scripted-1' } }, scopeOf(f)) as SessionRecord;
    assert.deepEqual(f.sessions.read(f.project.id, chosen.id).model, { provider: 'scripted', modelId: 'scripted-1' }, 'the declared choice is what the session holds');
    assert.equal((await f.actions.run('session.create', { name: 'No model', model: null }, scopeOf(f)) as SessionRecord).model, null, 'null is the declared absence of a choice');
    // The shape a text field would send if the value were not parsed is refused, naming the field:
    // a parameter that can only be refused is not offered, so this refusal is pinned by a test.
    const unparsed = await refusal(f.actions.run('session.create', { name: 'Wrong shape', model: 'scripted' }, scopeOf(f)));
    assert.ok(unparsed instanceof ActionError && unparsed.code === 'INVALID', 'an unparsed model is an invalid request');
    assert.match(unparsed.message, /the model field/, unparsed.message);
    // ...and the same for a choice that is really missing one of its two fields.
    const incomplete = await refusal(f.actions.run('session.create', { name: 'Half a choice', model: { provider: 'scripted' } }, scopeOf(f)));
    assert.ok(incomplete instanceof ActionError && incomplete.code === 'INVALID');
    assert.match(incomplete.message, /the model(\.modelId)? field/, incomplete.message);
  } finally { await f.cleanup(); }
});

test('the declared scope is what the caller must supply, and a missing dimension is a scope violation', async () => {
  const f = await fixture();
  try {
    const session = await newSession(f, 'Scope session');
    const global = ACTION_DESCRIPTORS.filter((descriptor) => descriptor.requires.length === 0).map((descriptor) => descriptor.id);
    const projected = ACTION_DESCRIPTORS.filter((descriptor) => descriptor.requires.includes('project')).map((descriptor) => descriptor.id);
    const sessionOnly = ACTION_DESCRIPTORS.filter((descriptor) => descriptor.requires.includes('session')).map((descriptor) => descriptor.id);

    assert.deepEqual(f.actions.list({}).actions.map((descriptor) => descriptor.id), ACTION_DESCRIPTORS.filter((descriptor) => descriptor.requires.length === 0).map((descriptor) => descriptor.id), 'with no scope, only actions that need none are offered');
    assert.deepEqual(f.actions.list({ projectId: f.project.id }).actions.map((descriptor) => descriptor.id), ACTION_DESCRIPTORS.filter((descriptor) => !descriptor.requires.includes('session')).map((descriptor) => descriptor.id), 'a project scope adds the project-scoped actions');
    assert.deepEqual(f.actions.list({ projectId: f.project.id, sessionId: session.id }).actions.map((descriptor) => descriptor.id), ACTION_DESCRIPTORS.map((descriptor) => descriptor.id), 'a session scope satisfies every declared scope');
    assert.deepEqual([f.actions.list({}).scope.projectId, f.actions.list({}).scope.sessionId], [null, null]);

    // Asking for an action whose declared dimension the request does not name is a scope violation,
    // refused before the handler and before the parameters.
    for (const id of sessionOnly) {
      const message = await actionRefusal(f.actions.run(id, {}, { projectId: f.project.id }), 'SCOPE');
      assert.match(message, /session scope/);
    }
    const projectMessage = await actionRefusal(f.actions.run('session.create', {}, {}), 'SCOPE');
    assert.match(projectMessage, /project scope/);

    // The scope the caller does name is really used: a session outside the project is refused by the handler.
    const unknown = await refusal(f.actions.run('session.lifecycle.stop', { revision: 0 }, { projectId: f.project.id, sessionId: randomUUID() }));
    assert.ok(unknown instanceof SessionError && unknown.code === 'NOT_FOUND', 'an unknown session is refused by the handler');

    // A scope that is not an identifier, or carries a field the registry does not accept, is invalid.
    assert.equal(await actionRefusal(f.actions.run('session.create', { name: 'x' }, { projectId: '../../etc' }), 'INVALID'), 'The action scope is invalid: projectId must be 1-160 characters, starting alphanumeric, from A-Za-z0-9._:-');
    await assert.rejects(async () => { await f.actions.run('session.create', { name: 'x' }, { projectId: f.project.id, extra: true } as unknown as ActionScope); }, (error: Error) => error instanceof ActionError && error.code === 'INVALID');
    assert.deepEqual(normaliseActionScope(undefined), {});
  } finally { await f.cleanup(); }
});

test('an unknown id and an action this instance cannot perform are both refused precisely', async () => {
  const f = await fixture();
  try {
    const unknown = await actionRefusal(f.actions.run('session.dance', {}, {}), 'UNKNOWN');
    assert.match(unknown, /Unknown action id "session.dance"/);
    assert.match(unknown, /this build defines \d+ actions/);
    await assert.rejects(async () => f.actions.describe(42), (error: Error) => error instanceof ActionError && error.code === 'UNKNOWN');
    await assert.rejects(async () => f.actions.describe('session.create.extra'), (error: Error) => error instanceof ActionError && error.code === 'UNKNOWN');

    // Without a durable control store the instance can really only run the read-only doctor, and it
    // says so: the unavailable actions are neither offered nor silently attempted.
    const bare: ActionEnvironment = { doctor: f.environment.doctor, agents: f.environment.agents };
    const bareRegistry = new ActionRegistry(bare);
    assert.deepEqual(actionHandlerIds(bare), [...ACTION_IDS].sort(), 'the handler set does not depend on what is available right now');
    assert.deepEqual(bareRegistry.list({ projectId: f.project.id, sessionId: randomUUID() }).actions.map((descriptor) => descriptor.id), ['doctor.report']);
    const unavailable = await actionRefusal(bareRegistry.run('session.create', { name: 'x' }, { projectId: f.project.id }), 'UNAVAILABLE');
    assert.match(unavailable, /the durable control store is not open on this instance/);
    const projection = await refusal(liveActivity(bare, { projectId: f.project.id }));
    assert.ok(projection instanceof ActionError && projection.code === 'UNAVAILABLE');
  } finally { await f.cleanup(); }
});

test('every declared precondition matches a refusal the handlers really produce', async () => {
  const f = await fixture();
  const covered = new Set<ActionPreconditionCode>();
  try {
    const session = await newSession(f, 'Precondition session');
    const scope = scopeOf(f, session.id);
    const unknownSession = scopeOf(f, randomUUID());
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    // SESSION_EXISTS: the handler refuses a session this project does not have.
    let error = await refusal(f.actions.run('session.lifecycle.stop', { revision: 0 }, unknownSession));
    assert.ok(error instanceof SessionError && error.code === 'NOT_FOUND'); covered.add('SESSION_EXISTS');
    // REVISION_MATCHES: a stale revision is a conflict that changes nothing.
    error = await refusal(f.actions.run('session.lifecycle.stop', { revision: 7 }, scope));
    assert.ok(error instanceof SessionLifecycleError && error.code === 'CONFLICT'); covered.add('REVISION_MATCHES');
    // STATE_PAUSED_OR_INTERRUPTED, STATE_FAILED and STATE_RUNNING: the three legal-jump rules.
    error = await refusal(f.actions.run('session.lifecycle.resume', { revision: 0 }, scope));
    assert.ok(error instanceof SessionLifecycleError && error.code === 'ILLEGAL' && /Only a paused or interrupted/.test(error.message)); covered.add('STATE_PAUSED_OR_INTERRUPTED');
    error = await refusal(f.actions.run('session.lifecycle.retry', { revision: 0 }, scope));
    assert.ok(error instanceof SessionLifecycleError && error.code === 'ILLEGAL' && /Only a failed/.test(error.message)); covered.add('STATE_FAILED');
    error = await refusal(f.actions.run('session.lifecycle.pause', { revision: 0 }, scope));
    assert.ok(error instanceof SessionLifecycleError && error.code === 'ILLEGAL' && /Only a running/.test(error.message)); covered.add('STATE_RUNNING');
    // INTERRUPTION_CERTAIN: a start-time adoption marks the generation uncertain, and resume refuses it.
    f.lifecycleStore.markRunning({ projectId: f.project.id, sessionId: session.id, requestId: 'uncertain-1' });
    adoptRunningSessions(f.lifecycleStore, new Date());
    const uncertain = f.lifecycleStore.read(f.project.id, session.id);
    assert.deepEqual([uncertain.state, uncertain.uncertain], ['interrupted', true]);
    error = await refusal(f.actions.run('session.lifecycle.resume', { revision: uncertain.revision }, scope));
    assert.ok(error instanceof SessionLifecycleError && error.code === 'NEEDS_ATTENTION'); covered.add('INTERRUPTION_CERTAIN');
    // DISPATCH_AVAILABLE: a port that cannot dispatch refuses before the record is touched.
    f.lifecycleStore.markRunning({ projectId: f.project.id, sessionId: session.id, requestId: 'dispatch-1' });
    const running = f.lifecycleStore.read(f.project.id, session.id);
    await f.actions.run('session.lifecycle.pause', { revision: running.revision }, scope);
    const paused = f.lifecycleStore.read(f.project.id, session.id);
    f.port.refusal = new HttpError(503, 'Agents are disabled on this instance');
    error = await refusal(f.actions.run('session.lifecycle.resume', { revision: paused.revision }, scope));
    assert.ok(error instanceof HttpError && error.status === 503); covered.add('DISPATCH_AVAILABLE');
    assert.equal(f.lifecycleStore.read(f.project.id, session.id).state, 'paused', 'a refused dispatch claimed no revision');
    f.port.refusal = null;
    // REASON_BOUNDED: enforced by the published parameter schema, before the handler runs.
    error = await refusal(f.actions.run('session.lifecycle.pause', { revision: paused.revision, reason: 'x'.repeat(400) }, scope));
    assert.ok(error instanceof ActionError && error.code === 'INVALID' && /the reason field/.test(error.message)); covered.add('REASON_BOUNDED');
    // NAME_VALID: the same, for the documented name rule.
    error = await refusal(f.actions.run('session.create', { name: 'not a name#' }, scopeOf(f)));
    assert.ok(error instanceof ActionError && error.code === 'INVALID' && /the name field/.test(error.message)); covered.add('NAME_VALID');
    // PROJECT_REGISTERED: an unregistered project is not a session scope.
    error = await refusal(f.actions.run('session.create', { name: 'Orphan' }, { projectId: randomUUID() }));
    assert.ok(error instanceof SessionError && error.code === 'NOT_FOUND'); covered.add('PROJECT_REGISTERED');
    // NAME_UNIQUE: two live sessions of one project cannot share a name.
    error = await refusal(f.actions.run('session.create', { name: 'Precondition session' }, scopeOf(f)));
    assert.ok(error instanceof SessionError && error.code === 'DUPLICATE_NAME'); covered.add('NAME_UNIQUE');
    // LINK_TARGET_RESOLVES: a task the board does not hold is refused exactly as a later link would be.
    error = await refusal(f.actions.run('session.create', { name: 'Bad link', links: [{ kind: 'task', taskId: randomUUID() }] }, scopeOf(f)));
    assert.ok(error instanceof SessionError && error.code === 'NOT_FOUND'); covered.add('LINK_TARGET_RESOLVES');

    // The approval request rules, each its own refusal.
    error = await refusal(f.actions.run('approval.create', { kind: 'merge', scope: { projectId: f.project.id }, target: {}, expiresAt }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'INVALID'); covered.add('REQUEST_KIND_VALID');
    error = await refusal(f.actions.run('approval.create', { kind: 'deploy', scope: {}, target: { endpoint: 'https://example.invalid', releaseId: 'r1' }, expiresAt }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'INVALID'); covered.add('REQUEST_SCOPE_NAMED');
    error = await refusal(f.actions.run('approval.create', { kind: 'deploy', scope: { projectId: f.project.id }, target: { endpoint: 'https://example.invalid' }, expiresAt }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'INVALID'); covered.add('REQUEST_TARGET_VALID');
    error = await refusal(f.actions.run('approval.create', { kind: 'deploy', scope: { projectId: f.project.id }, target: { endpoint: 'https://example.invalid', releaseId: 'r1' }, expiresAt: new Date(Date.now() - 1000).toISOString() }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'INVALID'); covered.add('EXPIRY_IN_THE_FUTURE');

    const push = { remote: 'origin', branch: 'main', commitSha: 'b'.repeat(40) };
    const approval = await f.actions.run('approval.create', { kind: 'push', scope: { projectId: f.project.id }, target: push, expiresAt }, {}) as { id: string };
    error = await refusal(f.actions.run('approval.consume', { id: randomUUID(), scope: { projectId: f.project.id }, kind: 'push', target: push, consumedBy: 'owner' }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'NOT_FOUND'); covered.add('APPROVAL_EXISTS');
    error = await refusal(f.actions.run('approval.consume', { id: approval.id, scope: { sessionId: 'other' }, kind: 'push', target: push, consumedBy: 'owner' }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'SCOPE'); covered.add('SCOPE_EXACT');
    error = await refusal(f.actions.run('approval.consume', { id: approval.id, scope: { projectId: f.project.id }, kind: 'deploy', target: { endpoint: 'https://example.invalid', releaseId: 'r1' }, consumedBy: 'owner' }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'KIND_MISMATCH'); covered.add('KIND_MATCHES');
    error = await refusal(f.actions.run('approval.consume', { id: approval.id, scope: { projectId: f.project.id }, kind: 'push', target: { ...push, branch: 'release' }, consumedBy: 'owner' }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'TARGET_MISMATCH'); covered.add('TARGET_EXACT');
    await f.actions.run('approval.consume', { id: approval.id, scope: { projectId: f.project.id }, kind: 'push', target: push, consumedBy: 'owner' }, {});
    error = await refusal(f.actions.run('approval.consume', { id: approval.id, scope: { projectId: f.project.id }, kind: 'push', target: push, consumedBy: 'owner' }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'CONSUMED'); covered.add('APPROVAL_PENDING');
    error = await refusal(f.actions.run('approval.revoke', { id: approval.id, scope: { projectId: f.project.id }, revokedBy: 'owner' }, {}));
    assert.ok(error instanceof ApprovalError && error.code === 'CONSUMED'); covered.add('APPROVAL_NOT_CONSUMED');

    // The queue's own preconditions, each a refusal its handler really produces.
    const queueScope = scopeOf(f, session.id);
    const queued = await f.actions.run('queue.append', { revision: 0, text: 'precondition input' }, queueScope) as QueueResult;
    const entryId = queued.entry!.id;
    // ENTRY_EXISTS: an entry the queue does not hold is refused as not found.
    error = await refusal(f.actions.run('queue.edit', { revision: queued.record.revision, entryId: randomUUID(), text: 'x' }, queueScope));
    assert.ok(error instanceof QueueError && error.code === 'NOT_FOUND'); covered.add('ENTRY_EXISTS');
    // TRANSITION_LEGAL: a queued entry cannot become submitted.
    error = await refusal(f.actions.run('queue.submit', { entryId, owner: 'precondition-dispatcher' }, queueScope));
    assert.ok(error instanceof QueueError && error.code === 'ILLEGAL' && /a queued entry can only become claimed, cancelled/.test(error.message)); covered.add('TRANSITION_LEGAL');
    // POSITION_IN_QUEUE: a position outside the queue is refused, and the record is unchanged.
    error = await refusal(f.actions.run('queue.reorder', { revision: queued.record.revision, entryId, position: 7 }, queueScope));
    assert.ok(error instanceof QueueError && error.code === 'INVALID' && /Position 7 is outside the queue/.test(error.message)); covered.add('POSITION_IN_QUEUE');
    assert.equal(f.queue.read(f.project.id, session.id).revision, queued.record.revision, 'a refused reorder raised no revision');
    // HEAD_CLAIMABLE: the head is claimed by one dispatcher, and no other dispatcher steals it.
    const claimed = await f.actions.run('queue.claim', { owner: 'precondition-dispatcher' }, queueScope) as QueueResult;
    assert.equal(claimed.entry!.state, 'claimed');
    error = await refusal(f.actions.run('queue.claim', { owner: 'another-dispatcher' }, queueScope));
    assert.ok(error instanceof QueueError && error.code === 'CONFLICT' && /a live claim is never stolen/.test(error.message)); covered.add('HEAD_CLAIMABLE');
    // ENTRY_EDITABLE: only a queued entry's text can be edited.
    error = await refusal(f.actions.run('queue.edit', { revision: claimed.record.revision, entryId, text: 'x' }, queueScope));
    assert.ok(error instanceof QueueError && error.code === 'ILLEGAL' && /Only a queued entry's text can be edited/.test(error.message)); covered.add('ENTRY_EDITABLE');
    // ENTRY_REMOVABLE: an entry a dispatcher holds is not removable.
    error = await refusal(f.actions.run('queue.remove', { revision: claimed.record.revision, entryId }, queueScope));
    assert.ok(error instanceof QueueError && error.code === 'ILLEGAL' && /can be removed/.test(error.message)); covered.add('ENTRY_REMOVABLE');
    // IN_FLIGHT_PRESERVED: an entry a dispatcher holds is the queue's effective head, so a reorder may
    // not move a later input ahead of it.
    const later = await f.actions.run('queue.append', { revision: claimed.record.revision, text: 'a later input' }, queueScope) as QueueResult;
    error = await refusal(f.actions.run('queue.reorder', { revision: later.record.revision, entryId: later.entry!.id, position: 0 }, queueScope));
    assert.ok(error instanceof QueueError && error.code === 'ILLEGAL' && /effective head until it settles or is explicitly reconciled/.test(error.message)); covered.add('IN_FLIGHT_PRESERVED');
    assert.equal(f.queue.read(f.project.id, session.id).entries[0].state, 'claimed', 'a refused reorder raised no revision and moved nothing');
    // CLAIM_OWNED: another owner cannot release or submit a claim it does not hold.
    error = await refusal(f.actions.run('queue.release', { entryId, owner: 'another-dispatcher' }, queueScope));
    assert.ok(error instanceof QueueError && error.code === 'ILLEGAL' && /is claimed by precondition-dispatcher/.test(error.message)); covered.add('CLAIM_OWNED');
    // LEASE_LIVE: past its lease the claim no longer authorises a submission.
    f.queueClock.now += 120_000;
    error = await refusal(f.actions.run('queue.submit', { entryId, owner: 'precondition-dispatcher' }, queueScope));
    assert.ok(error instanceof QueueError && error.code === 'ILLEGAL' && /expired at .* the queue never submits on an expired lease/.test(error.message)); covered.add('LEASE_LIVE');
    assert.equal(f.queue.read(f.project.id, session.id).entries[0].state, 'claimed', 'a refused submission changed nothing');

    // The limits this test does not drive, and why. A new code cannot be added without a decision.
    const undriven: Partial<Record<ActionPreconditionCode, string>> = {
      SESSION_LIMIT: 'the 200-session bound belongs to the session registry, which drives it in session-registry.test.ts; driving it here would write 200 records to prove a bound this registry only repeats',
      LINK_LIMIT: 'the 32-link bound belongs to the session registry, which drives it in session-registry.test.ts',
      QUEUE_BOUNDED: 'the queue bound is driven in queue.test.ts, where filling a queue to its documented maximum and to its byte bound belongs; driving it here would append 50 entries to prove a bound this registry only repeats'
    };
    for (const code of ACTION_PRECONDITION_CODES) {
      if (covered.has(code)) continue;
      assert.ok(undriven[code] !== undefined, 'the precondition ' + code + ' is neither driven nor documented as undriven');
    }
    for (const code of Object.keys(undriven) as ActionPreconditionCode[]) assert.ok(!covered.has(code), code + ' is documented as undriven but was driven');
    assert.deepEqual([...covered].sort(), ACTION_PRECONDITION_CODES.filter((code) => undriven[code] === undefined).sort(), 'every precondition that is not documented as undriven is driven by this test');
  } finally { await f.cleanup(); }
});

const CALL_AT = 1700000000000, RESULT_AT = 1700000000001;
const CALL = entry({ rawKind: 'pi.assistant', kind: 'assistant', at: CALL_AT, tools: [{ name: 'record_note', args: '{"text":"/etc/passwd is not prompt text this payload may carry"}' }] });
const RESULT = entry({ rawKind: 'pi.tool-result', kind: 'tool', at: RESULT_AT, data: { diagnostics: [{ severity: 'error', message: '/Users/private/plan.md could not be read' }, { severity: 'warn', message: 'bounded' }] } });
function environmentWith(f: Fixture, read: () => Promise<AgentView>): ActionEnvironment {
  return { control: f.environment.control, doctor: f.environment.doctor, agents: { enabled: true, read } };
}

test('the live projection reports the durable run state per session and never invents a tool entry', async () => {
  const f = await fixture();
  try {
    const session = await newSession(f, 'Projected session');
    // The run state is the durable lifecycle record, read per named session.
    f.lifecycleStore.markRunning({ projectId: f.project.id, sessionId: session.id, requestId: 'live-1' });
    f.lifecycleStore.markSettled({ projectId: f.project.id, sessionId: session.id, outcome: 'failed', reason: 'the generation failed' });
    const state = f.lifecycleStore.read(f.project.id, session.id);

    // 'unavailable on this instance': the harness is disabled, and the payload names the reason.
    const disabled: ActionEnvironment = { control: f.environment.control, doctor: f.environment.doctor, agents: { enabled: false, read: f.environment.agents.read } };
    const off = await liveActivity(disabled, { projectId: f.project.id });
    assert.deepEqual([off.readOnly, off.projectId], [true, f.project.id]);
    assert.deepEqual([off.harness.state, off.harness.reason, off.harness.detail], ['unavailable', LIVE_TOOL_REASONS.agentsDisabled, LIVE_TOOL_DETAILS.agentsDisabled]);
    assert.deepEqual([off.harness.source, off.harness.conversationId, off.harness.working], [null, null, null]);
    assert.deepEqual([off.harness.invocations, off.harness.results], [[], []]);
    assert.deepEqual(off.sessions.map((activity) => [activity.sessionId, activity.name, activity.run.state, activity.run.reason, activity.run.attempt]), [[session.id, 'Projected session', 'failed', 'the generation failed', state.attempt]]);

    // 'failed to read': the read was attempted and failed. The reason is fixed text, never the error.
    const secret = 'a harness error naming /Users/private/agents/session.sqlite';
    const broken = environmentWith(f, async () => { throw new Error(secret); });
    const failed = await liveActivity(broken, { projectId: f.project.id });
    assert.deepEqual([failed.harness.state, failed.harness.reason, failed.harness.detail], ['failed', LIVE_TOOL_REASONS.harnessReadFailed, LIVE_TOOL_DETAILS.harnessReadFailed]);
    assert.ok(!JSON.stringify(failed).includes('/Users/private'), 'a harness error is never echoed into the payload');

    // 'none yet': the harness reported a conversation, and its view carries no tool activity.
    const opened = await liveActivity(f.environment, { projectId: f.project.id });
    assert.deepEqual([opened.harness.state, opened.harness.reason], ['none', LIVE_TOOL_REASONS.noToolActivity]);
    assert.deepEqual([opened.harness.source, opened.harness.conversationId, opened.harness.sessionId], [LIVE_TOOL_SOURCE, '1', null], 'a conversation recorded under no named session says so by naming none');
    assert.deepEqual(opened.harness.invocations, []);

    // 'no conversation at all' is a different answer from 'a conversation with nothing in it yet':
    // the two payloads are distinguishable by name, not by an empty list either of them carries.
    const withoutConversation = await liveActivity(environmentWith(f, async () => view({ conversationId: '' })), { projectId: f.project.id });
    assert.deepEqual([withoutConversation.harness.state, withoutConversation.harness.reason, withoutConversation.harness.detail],
      ['no-conversation', LIVE_TOOL_REASONS.noConversation, LIVE_TOOL_DETAILS.noConversation]);
    assert.deepEqual([withoutConversation.harness.conversationId, withoutConversation.harness.invocations, withoutConversation.harness.results], [null, [], []]);
    assert.notDeepEqual(
      [withoutConversation.harness.state, withoutConversation.harness.reason],
      [opened.harness.state, opened.harness.reason],
      'no conversation and no tool activity are not the same answer'
    );

    // A session with no durable lifecycle row is reported as an absence, never as the state 'idle'
    // the store happens to read at — and the payload says the absence by name.
    const unrecorded = await newSession(f, 'Unrecorded session');
    const projection = await liveActivity(f.environment, { projectId: f.project.id });
    const absent = projection.sessions.find((entry) => entry.sessionId === unrecorded.id)!;
    assert.deepEqual([absent.run.recorded, absent.run.state, absent.run.absenceReason, absent.run.reason], [false, null, LIVE_RUN_REASONS.noRecord, null]);
    assert.deepEqual([absent.run.attempt, absent.run.revision], [0, 0], 'revision 0 is the revision a first write claims, not the result of one');
    assert.deepEqual([absent.run.activityAt, absent.run.updatedAt], [null, null], 'no instant is invented for a row that does not exist');
    assert.equal(absent.run.absenceDetail, LIVE_RUN_DETAILS.noRecord);
    assert.notEqual(absent.run.state, 'idle', 'an absent row is never reported as idle');
    assert.deepEqual(Object.keys(absent.run).sort(),
      ['absenceDetail', 'absenceReason', 'activityAt', 'attempt', 'reason', 'recorded', 'revision', 'state', 'uncertain', 'updatedAt'],
      'the run-state projection declares exactly its contract fields');
    // A session that really reads idle is still reported as the fact it is.
    const settled = projection.sessions.find((entry) => entry.sessionId === session.id)!;
    assert.deepEqual([settled.run.recorded, settled.run.state, settled.run.absenceReason], [true, 'failed', null]);

    // 'reported': what the harness really reports, and nothing else.
    const reported = environmentWith(f, async () => view({ conversationId: session.id, working: true, entries: [CALL, RESULT] }));
    const live = await liveActivity(reported, { projectId: f.project.id });
    assert.deepEqual([live.harness.state, live.harness.reason], ['reported', null]);
    assert.deepEqual([live.harness.source, live.harness.sessionId, live.harness.working], [LIVE_TOOL_SOURCE, session.id, true]);
    assert.deepEqual(live.harness.invocations, [{ name: 'record_note', at: CALL_AT }], 'a call is its name and its instant, never its arguments');
    assert.deepEqual(live.harness.results, [{ outcome: 'failed', errors: 1, warnings: 1, notices: 0, at: RESULT_AT }], 'a result is its diagnostic counts and the outcome they imply');
    const serialised = JSON.stringify(live);
    assert.ok(!serialised.includes('passwd'), 'the tool arguments are not carried');
    assert.ok(!serialised.includes('/Users/private'), 'a diagnostic message is not carried');
    assert.ok(!serialised.includes(f.root), 'the payload carries no filesystem path');

    // A tool result with no diagnostic counts as a clean one; a tool call with no result is not given one.
    const partial = environmentWith(f, async () => view({ conversationId: session.id, entries: [CALL, entry({ rawKind: 'pi.tool-result', kind: 'tool', at: RESULT_AT })] }));
    const quiet = await liveActivity(partial, { projectId: f.project.id });
    assert.deepEqual(quiet.harness.results, [{ outcome: 'ok', errors: 0, warnings: 0, notices: 0, at: RESULT_AT }]);
    assert.equal(quiet.harness.invocations.length, 1, 'one call was reported, and no outcome is attributed to it');
  } finally { await f.cleanup(); }
});

test('the live projection is bounded, distinguishes not-knowing, and declares exactly the contract fields', async () => {
  const f = await fixture();
  try {
    const first = await newSession(f, 'Bounded one'), second = await newSession(f, 'Bounded two');
    const twoCalls = environmentWith(f, async () => view({ conversationId: first.id, entries: [CALL, RESULT, CALL, RESULT] }));

    const capped = await liveActivity(twoCalls, { projectId: f.project.id, sessions: 1, toolEvents: 1 });
    assert.deepEqual([capped.truncated, capped.sessions.length], [true, 1]);
    assert.deepEqual([capped.harness.invocations.length, capped.harness.results.length, capped.harness.truncated], [1, 1, true], 'the bound keeps the most recent events and says it bit');
    assert.deepEqual(capped.limits, { sessions: 1, toolEvents: 1 });
    assert.equal(capped.sessions[0].sessionId, first.id);
    assert.notEqual(first.id, second.id);

    const full = await liveActivity(twoCalls, { projectId: f.project.id });
    assert.deepEqual(Object.keys(full).sort(), ['harness', 'limits', 'projectId', 'readOnly', 'sessions', 'truncated'], 'the payload declares exactly the contract fields and no others');
    assert.deepEqual(Object.keys(full.harness).sort(), ['conversationId', 'detail', 'invocations', 'reason', 'results', 'sessionId', 'source', 'state', 'truncated', 'working']);
    assert.deepEqual(full.limits, { sessions: 200, toolEvents: 50 });
    assert.equal(full.sessions.length, 2, 'both named sessions are reported');

    // The projection is scoped to one project and refuses to invent one.
    const missing = await refusal(liveActivity(f.environment, { projectId: undefined }));
    assert.ok(missing instanceof ActionError && missing.code === 'INVALID');
    const malformed = await refusal(liveActivity(f.environment, { projectId: '../../etc' }));
    assert.ok(malformed instanceof ActionError && malformed.code === 'INVALID');
    // A project this instance has no sessions for reports none: an empty list, never a fabricated entry.
    assert.deepEqual((await liveActivity(f.environment, { projectId: randomUUID() })).sessions, []);
  } finally { await f.cleanup(); }
});
