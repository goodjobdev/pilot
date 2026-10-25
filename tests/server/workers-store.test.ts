import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { WorkerService, WorkerStore, type WorkerPortResult, type WorkerRunPort, type WorkerStoreOptions } from '../../src/server/workers/worker-store';
import { inspectWorkerReport, writeWorkerReport } from '../../src/server/workers/report';
import { buildWorkerModelPolicy, type WorkerModelPolicy } from '../../src/shared/model-policy';
import { composeWorkerReport, workerReportPath } from '../../src/shared/workers';
import { WorkerError, WORKER_MAX_MODEL_TURNS, type WorkerRecord } from '../../src/shared/workers';
import { modelKey } from '../../src/shared/settings';

/**
 * The durable worker store and service, over disposable roots only.
 *
 * Every fixture is a fresh temporary project and data root with its own control store. No live
 * project, planning document or provider is read or written, and every model effect is a synthetic
 * port call. No test makes a network request.
 */

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';
const MODEL = { provider: 'faux', modelId: 'scripted' } as const;
const OTHER_MODEL = { provider: 'faux', modelId: 'other' } as const;
const ACTOR = { kind: 'owner' as const, identity: 'owner' };
const AGENT = { kind: 'agent' as const, identity: 'agent-1' };
const CLOCK = () => new Date('2026-01-01T00:00:00.000Z');

function policy(over: { models?: (typeof MODEL)[]; defaultModel?: typeof MODEL | null } = {}): WorkerModelPolicy {
  return buildWorkerModelPolicy({
    revision: 1,
    draft: { allowedWorkerModels: over.models ?? [MODEL], defaultWorkerModel: over.defaultModel === undefined ? (over.models ?? [MODEL])[0] ?? null : over.defaultModel },
    actor: ACTOR,
    updatedAt: CLOCK().toISOString()
  });
}

type Port = WorkerRunPort & {
  readonly calls: { projectId: string; workerId: string; runId: string; model: { provider: string; modelId: string }; prompt: string }[];
  cancelCalls: number;
  gate(): Promise<void>;
  openGate(): void;
  entered(): Promise<void>;
};

function syntheticPort(mode: 'complete' | 'gate' | 'fail' | 'late' | 'faulty', text = 'Observed two notes. No action taken.') : Port {
  const calls: Port['calls'] = [];
  let cancelCalls = 0;
  let openGate = () => {};
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  let enteredResolve = () => {};
  const enteredPromise = new Promise<void>((resolve) => { enteredResolve = resolve; });
  return {
    calls,
    get cancelCalls() { return cancelCalls; },
    gate: () => gate,
    openGate,
    entered: () => enteredPromise,
    async run(input): Promise<WorkerPortResult> {
      calls.push({ projectId: input.projectId, workerId: input.workerId, runId: input.runId, model: input.model, prompt: input.prompt });
      await input.onConversation(1000 + calls.length);
      const refusal = await input.beforeSubmit();
      if (refusal !== null) return { text: '', turns: 0, failed: true, reason: refusal };
      enteredResolve();
      if (mode === 'gate') { await gate; return { text, turns: 2 }; }
      if (mode === 'fail') return { text: '', turns: 1, failed: true, reason: 'The model is unavailable.' };
      if (mode === 'late') { await gate; }
      if (mode === 'faulty') return { text, turns: 9 };
      return { text, turns: 2 };
    },
    async cancel() { cancelCalls += 1; openGate(); }
  };
}

type Fixture = {
  root: string;
  projectRoot: string;
  dataRoot: string;
  store: ControlStore;
  workers: WorkerStore;
  service: WorkerService;
  port: Port;
  setPolicy(next: WorkerModelPolicy | null): void;
  reopen(): Promise<void>;
  close(): Promise<void>;
};

async function fixture(options: { mode?: 'complete' | 'gate' | 'fail' | 'late' | 'faulty'; policy?: WorkerModelPolicy | null; offered?: readonly (typeof MODEL)[] } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-workers-'));
  const projectRoot = join(root, 'project');
  const dataRoot = join(root, 'data');
  await mkdir(join(projectRoot, 'docs'), { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  let policyValue = options.policy === undefined ? policy() : options.policy;
  const offered = options.offered ?? [MODEL, OTHER_MODEL];
  let store = new ControlStore(dataRoot);
  const settings = (): WorkerStoreOptions => ({
    clock: CLOCK,
    policy: () => policyValue,
    offered: () => offered,
    projectRoot: (id) => id === PROJECT || id === OTHER_PROJECT ? projectRoot : undefined,
    dataRoot
  });
  let workers = new WorkerStore(store, settings());
  let port = syntheticPort(options.mode ?? 'complete');
  let service = new WorkerService(workers, port, settings());
  const f: Fixture = {
    root, projectRoot, dataRoot,
    get store() { return store; },
    get workers() { return workers; },
    get service() { return service; },
    get port() { return port; },
    setPolicy(next) { policyValue = next; },
    async reopen() {
      port.openGate();
      await service.idle();
      store.close();
      store = new ControlStore(dataRoot);
      workers = new WorkerStore(store, settings());
      port = syntheticPort(options.mode ?? 'complete');
      service = new WorkerService(workers, port, settings());
    },
    async close() { port.openGate(); await service.idle(); store.close(); await rm(root, { recursive: true, force: true }); }
  };
  return f;
}

async function refusal(promise: Promise<unknown>, code: WorkerError['code'], pattern?: RegExp): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof WorkerError) {
      assert.equal(error.code, code, error.message);
      if (pattern) assert.match(error.message, pattern);
      return error.message;
    }
    throw error;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

async function createWorker(f: Fixture, over: { name?: string; model?: typeof MODEL; scopes?: string[] } = {}): Promise<WorkerRecord> {
  return f.workers.create(PROJECT, ACTOR, { name: over.name ?? 'Reviewer', model: over.model ?? MODEL, scopes: over.scopes ?? ['record_note', 'read_notes'] });
}

test('workers: only the owner creates, and the pinned model never falls back', async () => {
  const f = await fixture({ policy: null });
  try {
    await refusal(f.workers.create(PROJECT, AGENT, { name: 'Agent worker' }), 'NOT_PERMITTED', /agent request is refused/);
    await refusal(f.workers.create(PROJECT, ACTOR, { name: 'No policy' }), 'MODEL_NOT_ALLOWED', /No owner worker model policy/);
    assert.equal(f.workers.listWorkers(PROJECT).length, 0, 'an agent attempt created nothing');
    f.setPolicy(policy());
    const created = await createWorker(f);
    assert.equal(modelKey(created.model), modelKey(MODEL));
    assert.deepEqual(created.scopes, ['record_note', 'read_notes']);
    assert.equal(created.budgets.maxModelTurns, WORKER_MAX_MODEL_TURNS);
    // A model outside the allowed set is refused, with no fallback and no record.
    await refusal(f.workers.create(PROJECT, ACTOR, { name: 'Wrong model', model: OTHER_MODEL }), 'MODEL_NOT_ALLOWED', /no fallback/);
    // A policy with no default refuses a request that names no model.
    f.setPolicy(policy({ models: [MODEL], defaultModel: null }));
    await refusal(f.workers.create(PROJECT, ACTOR, { name: 'No default' }), 'MODEL_NOT_ALLOWED', /no default/);
    // An uninstalled scope is refused by name, and the question scope is refused as unsupported.
    f.setPolicy(policy());
    await refusal(f.workers.create(PROJECT, ACTOR, { name: 'Uninstalled scope', scopes: ['read_docs'] }), 'SCOPE_NOT_INSTALLED', /read_docs/);
    await refusal(f.workers.create(PROJECT, ACTOR, { name: 'Question scope', scopes: ['ask_question'] }), 'SCOPE_NOT_INSTALLED', /no bounded owner answer path/);
    assert.equal(f.workers.listWorkers(PROJECT).length, 1);
  } finally { await f.close(); }
});

test('workers: three live workers per project, a unique live name, and revocation frees a slot', async () => {
  const f = await fixture();
  try {
    const one = await createWorker(f, { name: 'One' });
    await createWorker(f, { name: 'Two' });
    await createWorker(f, { name: 'Three' });
    await refusal(f.workers.create(PROJECT, ACTOR, { name: 'Four' }), 'LIMIT', /3 live workers/);
    await refusal(f.workers.create(PROJECT, ACTOR, { name: 'One' }), 'CONFLICT', /already has the name/);
    const revoked = await f.service.revoke(PROJECT, one.id, one.revision, ACTOR);
    assert.equal(revoked.worker.state, 'revoked');
    assert.equal(revoked.outcome, 'revoked');
    // A revoked record stays as immutable history and no longer counts.
    const replacement = await createWorker(f, { name: 'Four' });
    assert.equal(replacement.state, 'active');
    assert.equal(f.workers.listWorkers(PROJECT).length, 4);
    assert.equal(f.workers.view(PROJECT).liveWorkers, 3);
    await refusal(f.service.revoke(PROJECT, one.id, one.revision, AGENT), 'NOT_PERMITTED');
    await refusal(f.service.revoke(PROJECT, replacement.id, 99, ACTOR), 'CONFLICT', /nothing was revoked/);
  } finally { await f.close(); }
});

test('workers: one active run per project, a durable lease, and a busy refusal with no queue', async () => {
  const f = await fixture({ mode: 'gate' });
  try {
    const worker = await createWorker(f);
    const run = await f.service.start(PROJECT, worker.id, ACTOR);
    assert.equal(run.state, 'running');
    assert.equal(run.workerRevision, worker.revision);
    assert.equal(modelKey(run.model), modelKey(MODEL));
    assert.equal(run.requestId, 'worker-run:' + run.id + ':a1');
    await f.port.entered();
    await refusal(f.service.start(PROJECT, worker.id, ACTOR), 'BUSY', /no queue/);
    await refusal(f.service.start(OTHER_PROJECT, worker.id, ACTOR), 'NOT_FOUND');
    // The lease is durable in the control store, not only in memory.
    const held = f.store.db.prepare("SELECT input_json FROM operations WHERE session_id='workers' AND kind='workers.lease' ORDER BY rowid DESC LIMIT 1").get() as { input_json: string };
    assert.match(held.input_json, new RegExp('"state":"held"'));
    assert.match(held.input_json, new RegExp(run.id));
    f.port.openGate();
    await f.service.idle();
    assert.equal(f.workers.readRun(PROJECT, run.id).state, 'completed');
    // The lease is released, so the next run is admitted.
    const next = await f.service.start(PROJECT, worker.id, ACTOR);
    await f.service.idle();
    assert.equal(f.workers.readRun(PROJECT, next.id).state, 'completed');
  } finally { await f.close(); }
});

test('workers: every tool call rechecks revocation, model policy, project and scopes', async () => {
  const f = await fixture({ mode: 'gate' });
  try {
    const worker = await createWorker(f, { scopes: ['read_notes'] });
    const run = await f.service.start(PROJECT, worker.id, ACTOR);
    await f.port.entered();
    assert.equal(f.workers.guardTool(PROJECT, run.id, 'read_notes'), null);
    assert.match(f.workers.guardTool(PROJECT, run.id, 'ask_question') ?? '', /not in this worker’s allowlist|not in this worker/);
    assert.match(f.workers.guardTool(PROJECT, run.id, 'record_note') ?? '', /allowlist/);
    assert.match(f.workers.guardTool(PROJECT, run.id, 'file_edit') ?? '', /allowlist/);
    assert.match(f.workers.guardTool(PROJECT, run.id, 'unknown_tool') ?? '', /no worker scope/);
    // Removing the pinned model from the owner policy refuses the next tool call without a restart.
    f.setPolicy(policy({ models: [], defaultModel: null }));
    assert.match(f.workers.guardTool(PROJECT, run.id, 'read_notes') ?? '', /no longer allowed/);
    f.setPolicy(policy());
    await f.service.revoke(PROJECT, worker.id, worker.revision, ACTOR);
    assert.match(f.workers.guardTool(PROJECT, run.id, 'read_notes') ?? '', /no longer running|revoked/);
    await f.service.idle();
  } finally { await f.close(); }
});

test('workers: revocation cancels the active run cooperatively and blocks every new run', async () => {
  const f = await fixture({ mode: 'gate' });
  try {
    const worker = await createWorker(f);
    const run = await f.service.start(PROJECT, worker.id, ACTOR);
    await f.port.entered();
    const revoked = await f.service.revoke(PROJECT, worker.id, worker.revision, ACTOR);
    assert.equal(revoked.worker.state, 'revoked');
    assert.equal(revoked.cancelled, true);
    assert.equal(revoked.run?.state, 'cancelled');
    assert.equal(f.port.cancelCalls, 1);
    await f.service.idle();
    assert.equal(f.workers.readRun(PROJECT, run.id).state, 'cancelled');
    await refusal(f.service.start(PROJECT, worker.id, ACTOR), 'NOT_PERMITTED', /revoked/);
    // A run admitted before the revocation cannot pass the dispatch recheck: an admitted run is
    // refused by the same store rule if the owner revokes first.
    const second = await createWorker(f, { name: 'Second' });
    const admitted = await f.workers.admitRun(PROJECT, second.id, ACTOR);
    await f.service.revoke(PROJECT, second.id, second.revision, ACTOR);
    assert.equal(f.workers.readRun(PROJECT, admitted.id).state, 'cancelled');
    assert.equal(f.workers.guardTool(PROJECT, admitted.id, 'read_notes') !== null, true);
  } finally { await f.close(); }
});

test('workers: stop before the effect writes nothing, and stop after the effect keeps the report', async () => {
  const before = await fixture({ mode: 'gate' });
  try {
    const worker = await createWorker(before);
    const run = await before.service.start(PROJECT, worker.id, ACTOR);
    await before.port.entered();
    const stopped = await before.service.stop(PROJECT, run.id, ACTOR);
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.outcome, 'cancelled');
    await before.service.idle();
    const settled = before.workers.readRun(PROJECT, run.id);
    assert.equal(settled.state, 'cancelled');
    assert.equal(settled.report, null);
    await assert.rejects(readFile(join(before.projectRoot, 'docs/workers', worker.id, run.id + '.md'), 'utf8'), /ENOENT/);
    // Stop is idempotent and terminal: a second stop changes nothing and never reports a resume.
    const again = await before.service.stop(PROJECT, run.id, ACTOR);
    assert.equal(again.unchanged, true);
    assert.equal(again.outcome, 'terminal');
  } finally { await before.close(); }

  const after = await fixture({ mode: 'complete' });
  try {
    const worker = await createWorker(after);
    const run = await after.service.start(PROJECT, worker.id, ACTOR);
    await after.service.idle();
    const completed = after.workers.readRun(PROJECT, run.id);
    assert.equal(completed.state, 'completed');
    assert.ok(completed.report);
    const file = join(after.projectRoot, completed.report!.path);
    const text = await readFile(file, 'utf8');
    const stopped = await after.service.stop(PROJECT, run.id, ACTOR);
    assert.equal(stopped.unchanged, true);
    assert.equal(stopped.outcome, 'terminal');
    assert.equal(await readFile(file, 'utf8'), text, 'a committed report is not rolled back');
    assert.equal(after.workers.readRun(PROJECT, run.id).state, 'completed');
  } finally { await after.close(); }
});

test('workers: crash recovery interrupts a running run, releases its lease, and replays nothing', async () => {
  const f = await fixture({ mode: 'complete' });
  try {
    const worker = await createWorker(f);
    // Admit a run without dispatching it, exactly what a crash between admission and dispatch leaves.
    const run = await f.workers.admitRun(PROJECT, worker.id, ACTOR);
    await f.reopen();
    const report = await f.workers.recoverOnStartup();
    assert.equal(report.recoveredRuns, 1);
    assert.equal(report.releasedLeases, 1);
    const recovered = f.workers.readRun(PROJECT, run.id);
    assert.equal(recovered.state, 'interrupted');
    assert.match(recovered.reason ?? '', /cannot be proven.*not replayed/);
    assert.equal(recovered.report, null);
    assert.equal(f.workers.view(PROJECT).activeRunId, null);
    // The pass is idempotent and starts nothing.
    const second = await f.workers.recoverOnStartup();
    assert.equal(second.recoveredRuns, 0);
    assert.equal(second.releasedLeases, 0);
    assert.equal(f.workers.readRun(PROJECT, run.id).state, 'interrupted');
    // A fresh run is admitted after recovery, and the interrupted one is never resumed.
    const next = await f.service.start(PROJECT, worker.id, ACTOR);
    await f.service.idle();
    assert.equal(f.workers.readRun(PROJECT, next.id).state, 'completed');
  } finally { await f.close(); }
});

test('workers: the report is canonical Markdown, the database holds tracking only, and tampering is refused', async () => {
  const f = await fixture({ mode: 'complete' });
  try {
    const worker = await createWorker(f);
    const run = await f.service.start(PROJECT, worker.id, ACTOR);
    await f.service.idle();
    const completed = f.workers.readRun(PROJECT, run.id);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.report?.path, 'docs/workers/' + worker.id + '/' + run.id + '.md');
    const text = await readFile(join(f.projectRoot, completed.report!.path), 'utf8');
    assert.match(text, /^---\nworker_report: 1\n/);
    assert.match(text, /Untrusted evidence/);
    assert.match(text, /Observed two notes/);
    // SQLite keeps the path, hash and size, never the report content.
    const rows = f.store.db.prepare('SELECT input_json FROM operations').all() as { input_json: string }[];
    assert.ok(rows.every((row) => !row.input_json.includes('Observed two notes')), 'no report content is stored in the control store');
    assert.ok(rows.some((row) => row.input_json.includes(completed.report!.sha256)));
    // A byte-identical rewrite is idempotent; a different file is never overwritten.
    const same = await writeWorkerReport({ projectRoot: f.projectRoot, path: completed.report!.path, content: text });
    assert.equal(same.created, false);
    await writeFile(join(f.projectRoot, completed.report!.path), 'Owner edited this report.\n', 'utf8');
    await assert.rejects(
      writeWorkerReport({ projectRoot: f.projectRoot, path: completed.report!.path, content: text }),
      (error: unknown) => error instanceof WorkerError && error.code === 'REPORT_CONFLICT'
    );
    assert.equal(await readFile(join(f.projectRoot, completed.report!.path), 'utf8'), 'Owner edited this report.\n');
    // A symlink at the report path is refused and never followed.
    const dir = join(f.projectRoot, 'docs/workers', worker.id);
    const linkPath = join(dir, 'r-symlink.md');
    await symlink('/etc/hosts', linkPath);
    await assert.rejects(
      writeWorkerReport({ projectRoot: f.projectRoot, path: 'docs/workers/' + worker.id + '/r-symlink.md', content: 'x\n' }),
      (error: unknown) => error instanceof WorkerError && /symlink/i.test(error.message)
    );
    // The report is in this project only.
    await assert.rejects(readFile(join(f.projectRoot, 'docs/workers', worker.id, 'r-other.md')), /ENOENT/);
    await assert.rejects(async () => { f.workers.readRun(OTHER_PROJECT, run.id); }, (error: unknown) => error instanceof WorkerError && error.code === 'NOT_FOUND');
  } finally { await f.close(); }
});

test('workers: two simultaneous creations for the last slot admit exactly one', async () => {
  const f = await fixture();
  try {
    await createWorker(f, { name: 'One' });
    await createWorker(f, { name: 'Two' });
    const results = await Promise.allSettled([
      f.workers.create(PROJECT, ACTOR, { name: 'Three', model: MODEL, scopes: [] }),
      f.workers.create(PROJECT, ACTOR, { name: 'Four', model: MODEL, scopes: [] })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof WorkerError && rejected[0].reason.code === 'LIMIT');
    assert.equal(f.workers.view(PROJECT).liveWorkers, 3);
  } finally { await f.close(); }
});

test('workers: a revocation that races a new run leaves the worker revoked and no completed report', async () => {
  const f = await fixture({ mode: 'gate' });
  try {
    const worker = await createWorker(f);
    const results = await Promise.allSettled([
      f.service.start(PROJECT, worker.id, ACTOR),
      f.service.revoke(PROJECT, worker.id, worker.revision, ACTOR)
    ]);
    assert.equal(results[1].status, 'fulfilled', 'the revocation itself always succeeds');
    f.port.openGate();
    await f.service.idle();
    assert.equal((results[1] as PromiseFulfilledResult<{ worker: WorkerRecord }>).value.worker.state, 'revoked');
    const runs = f.workers.listRuns(PROJECT);
    for (const run of runs) {
      assert.notEqual(run.state, 'running');
      assert.notEqual(run.state, 'completed');
      assert.equal(run.report, null);
    }
    await refusal(f.service.start(PROJECT, worker.id, ACTOR), 'NOT_PERMITTED');
  } finally { await f.close(); }
});

test('workers: an unavailable model fails closed with no report and no automatic second attempt', async () => {
  const f = await fixture({ mode: 'complete' });
  try {
    const worker = await createWorker(f);
    // Replace the port with one that refuses the model exactly as an unavailable provider does.
    // The service records the failure; it never retries and never writes a report.
    const refusing = {
      calls: 0,
      async run(): Promise<WorkerPortResult> {
        refusing.calls += 1;
        throw new WorkerError('The pinned model is not available: no credential is saved. No request was sent.', 'MODEL_UNAVAILABLE');
      },
      async cancel(): Promise<void> {}
    };
    const service = new WorkerService(f.workers, refusing, { clock: CLOCK, policy: () => policy(), offered: () => [MODEL, OTHER_MODEL], projectRoot: () => f.projectRoot, dataRoot: f.dataRoot });
    const run = await service.start(PROJECT, worker.id, ACTOR);
    await service.idle();
    const settled = f.workers.readRun(PROJECT, run.id);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.report, null);
    assert.match(settled.reason ?? '', /not available|No request was sent/);
    assert.equal(refusing.calls, 1, 'exactly one attempt, with no automatic retry');
    assert.equal(f.workers.listRuns(PROJECT).length, 1);
  } finally { await f.close(); }
});

test('workers: the conversation binding is durable before submit and survives a restart', async () => {
  const f = await fixture({ mode: 'complete' });
  try {
    const worker = await createWorker(f);
    const run = await f.service.start(PROJECT, worker.id, ACTOR);
    await f.service.idle();
    const recorded = f.workers.conversationForRun(PROJECT, run.id);
    assert.ok(recorded, 'the conversation is bound to the run');
    assert.equal(f.workers.isWorkerConversation(PROJECT, recorded!.binding.conversationId), true);
    // The same binding is idempotent; a different conversation for one run conflicts.
    const same = await f.workers.recordConversation(PROJECT, run.id, recorded!.binding.conversationId);
    assert.equal(same.conversationId, recorded!.binding.conversationId);
    await refusal(f.workers.recordConversation(PROJECT, run.id, recorded!.binding.conversationId + 1), 'CONFLICT');
    await f.reopen();
    assert.equal(f.workers.isWorkerConversation(PROJECT, recorded!.binding.conversationId), true, 'the durable lookup survives the restart');
    assert.deepEqual(f.workers.workerConversationIds(PROJECT), [recorded!.binding.conversationId]);
  } finally { await f.close(); }
});

test('workers: a faulty provider turn count is recorded as measured, never clamped', async () => {
  const f = await fixture({ mode: 'faulty' });
  try {
    const worker = await createWorker(f);
    const run = await f.service.start(PROJECT, worker.id, ACTOR);
    await f.service.idle();
    const settled = f.workers.readRun(PROJECT, run.id);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.turns, 9);
    assert.equal(settled.report, null);
    assert.match(settled.reason ?? '', /8-turn budget/);
  } finally { await f.close(); }
});

test('workers: startup reconciles a report that survives a crash before it settles the run', async () => {
  const f = await fixture({ mode: 'complete' });
  try {
    const worker = await createWorker(f);
    const crashed = await f.workers.admitRun(PROJECT, worker.id, ACTOR);
    const content = composeWorkerReport({
      worker, run: crashed, body: 'Report written before the crash.', projectRoot: f.projectRoot, dataRoot: f.dataRoot, endedAt: CLOCK()
    });
    const written = await writeWorkerReport({ projectRoot: f.projectRoot, path: workerReportPath(worker.id, crashed.id), content });
    await f.reopen();
    const report = await f.workers.recoverOnStartup();
    assert.equal(report.recoveredRuns, 1);
    assert.equal(report.reportsChecked >= 1, true);
    const recovered = f.workers.readRun(PROJECT, crashed.id);
    assert.equal(recovered.state, 'completed', 'a valid report settles the run without a model replay');
    assert.equal(recovered.report?.sha256, written.sha256);
    assert.equal(recovered.report?.bytes, written.bytes);
    assert.equal(f.port.calls.length, 0);

    // A symlink at the canonical path is not a report: the run stays interrupted.
    const second = await f.workers.admitRun(PROJECT, worker.id, ACTOR);
    const { mkdir, symlink } = await import('node:fs/promises');
    await mkdir(join(f.projectRoot, 'docs/workers', worker.id), { recursive: true });
    await symlink('/etc/hosts', join(f.projectRoot, workerReportPath(worker.id, second.id)));
    await f.reopen();
    const after = await f.workers.recoverOnStartup();
    assert.equal(after.reportsUnavailable >= 1, true);
    assert.equal(f.workers.readRun(PROJECT, second.id).state, 'interrupted');
    assert.equal(f.workers.readRun(PROJECT, second.id).report, null);
  } finally { await f.close(); }
});

test('workers: an existing report path is read only as a bounded regular file', async () => {
  const f = await fixture();
  try {
    const worker = await createWorker(f);
    const base = join(f.projectRoot, 'docs/workers', worker.id);
    await mkdir(base, { recursive: true });
    await mkdir(join(base, 'r-dir.md'));
    const directory = await inspectWorkerReport({ projectRoot: f.projectRoot, path: 'docs/workers/' + worker.id + '/r-dir.md' });
    assert.equal(directory.exists, true);
    assert.equal(directory.exists && directory.valid, false);
    assert.match(directory.exists && !directory.valid ? directory.reason : '', /not a regular file/);
    await writeFile(join(base, 'r-big.md'), 'x'.repeat(64 * 1024 + 1));
    const oversize = await inspectWorkerReport({ projectRoot: f.projectRoot, path: 'docs/workers/' + worker.id + '/r-big.md' });
    assert.equal(oversize.exists, true);
    assert.equal(oversize.exists && oversize.valid, false);
    assert.match(oversize.exists && !oversize.valid ? oversize.reason : '', /larger than the report bound/);
    const missing = await inspectWorkerReport({ projectRoot: f.projectRoot, path: 'docs/workers/' + worker.id + '/r-missing.md' });
    assert.equal(missing.exists, false);
  } finally { await f.close(); }
});

test('workers: a manual or foreign report is not accepted as completion', async () => {
  const f = await fixture({ mode: 'complete' });
  try {
    const worker = await createWorker(f);
    const manual = await f.workers.admitRun(PROJECT, worker.id, ACTOR);
    // A manual Markdown file, not a worker report: it has no fixed header.
    await writeWorkerReport({ projectRoot: f.projectRoot, path: workerReportPath(worker.id, manual.id), content: '# Manual report\n\nThis was written by hand.' });
    await f.reopen();
    const report = await f.workers.recoverOnStartup();
    assert.equal(report.reportsUnavailable >= 1, true);
    assert.equal(f.workers.readRun(PROJECT, manual.id).state, 'interrupted');
    assert.equal(f.workers.readRun(PROJECT, manual.id).report, null);

    // A header for a different run is also not accepted.
    const foreign = await f.workers.admitRun(PROJECT, worker.id, ACTOR);
    const another = { ...foreign, id: 'r-foreign' };
    const text = composeWorkerReport({ worker, run: another, body: 'Foreign body.', projectRoot: f.projectRoot, dataRoot: f.dataRoot, endedAt: CLOCK() });
    await writeWorkerReport({ projectRoot: f.projectRoot, path: workerReportPath(worker.id, foreign.id), content: text });
    await f.reopen();
    await f.workers.recoverOnStartup();
    assert.equal(f.workers.readRun(PROJECT, foreign.id).state, 'interrupted');
  } finally { await f.close(); }
});

test('workers: a changed finished report is an owner-visible integrity warning', async () => {
  const f = await fixture({ mode: 'complete' });
  try {
    const worker = await createWorker(f);
    const run = await f.service.start(PROJECT, worker.id, ACTOR);
    await f.service.idle();
    const completed = f.workers.readRun(PROJECT, run.id);
    const intact = await f.workers.reportIntegrityFor(PROJECT);
    assert.equal(intact[run.id]?.state, 'intact');
    await writeFile(join(f.projectRoot, completed.report!.path), 'Owner edited this report.\n', 'utf8');
    const changed = await f.workers.reportIntegrityFor(PROJECT);
    assert.equal(changed[run.id]?.state, 'changed');
    assert.notEqual(changed[run.id]?.actualSha256, changed[run.id]?.expectedSha256);
    assert.equal(f.workers.readRun(PROJECT, run.id).state, 'completed', 'the canonical edit never changes the run state or file');
  } finally { await f.close(); }
});

test('workers: two store instances race one project lease and only one run is admitted', async () => {
  const f = await fixture();
  const second = new ControlStore(f.dataRoot);
  try {
    const worker = await createWorker(f);
    const options: WorkerStoreOptions = {
      clock: CLOCK,
      policy: () => policy(),
      offered: () => [MODEL, OTHER_MODEL],
      projectRoot: () => f.projectRoot,
      dataRoot: f.dataRoot
    };
    const other = new WorkerStore(second, options);
    const results = await Promise.allSettled([
      f.workers.admitRun(PROJECT, worker.id, ACTOR),
      other.admitRun(PROJECT, worker.id, ACTOR)
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof WorkerError && (rejected[0].reason.code === 'CONFLICT' || rejected[0].reason.code === 'BUSY'));
    assert.equal(f.workers.listRuns(PROJECT).length, 1);
    const held = f.store.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE session_id='workers' AND kind='workers.lease' AND input_json LIKE '%\"state\":\"held\"%'").get() as { count: number };
    assert.equal(held.count, 1);
  } finally { second.close(); await f.close(); }
});

test('workers: two simultaneous run admissions admit exactly one and refuse the other as busy', async () => {
  const f = await fixture({ mode: 'gate' });
  try {
    const worker = await createWorker(f);
    const results = await Promise.allSettled([
      f.service.start(PROJECT, worker.id, ACTOR),
      f.service.start(PROJECT, worker.id, ACTOR)
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof WorkerError && rejected[0].reason.code === 'BUSY');
    f.port.openGate();
    await f.service.idle();
    assert.equal(f.workers.listRuns(PROJECT).length, 1);
  } finally { await f.close(); }
});
