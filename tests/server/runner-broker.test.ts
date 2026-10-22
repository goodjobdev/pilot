import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import {
  RunnerBroker, createProjectWorkspaceResolver, dockerRunnerPort, dockerRunArgv,
  type RunnerExecution, type RunnerExecutionRequest, type RunnerPort
} from '../../src/server/state/runner-broker';
import {
  RUNNER_DEFAULT_LEASE_MS, RUNNER_DEFAULT_LIMITS, RUNNER_MAX_JOBS, RUNNER_MAX_RECORD_BYTES, RunnerError,
  runnerContainmentProblems, runnerJobRequest, runnerRecordBytes, submittedRunnerJob,
  type RunnerContainment, type RunnerJobRecord
} from '../../src/shared/runner';

/**
 * The bounded coding runner, over a disposable root and a synthetic port.
 *
 * **No container is started anywhere in this file and no container runtime is contacted.** The broker's
 * only execution path is its port, so the suite drives the durability, the races, the bounds and every
 * fail-closed rule through a port it controls; the one test that exercises the real port points it at a
 * fake binary that only records its own arguments. Nothing here reads or writes a live project.
 */

const RUNNER_AT = Date.parse('2025-01-01T00:00:00.000Z');

/** The containment every required property of a job is checked against. */
function containment(overrides: Partial<RunnerContainment> = {}): RunnerContainment {
  return Object.freeze({
    runtime: 'fake-runtime', image: 'pilot-runner:test', network: 'none', rootFilesystem: 'read-only' as const,
    user: '10001:10001', capabilities: 'none', noNewPrivileges: true, dockerSocket: false,
    mounts: Object.freeze(['workspace']) as readonly string[],
    maxMemoryBytes: 1024 * 1024 * 1024, maxCpus: 2, maxPids: 128, maxWallClockMs: 300_000,
    ...overrides
  });
}
/** One scripted execution. */
function execution(overrides: Partial<RunnerExecution> = {}): RunnerExecution {
  return Object.freeze({
    exitCode: 0, stdout: 'probe\n', stderr: '', stdoutBytes: 6, stderrBytes: 0,
    stdoutTruncated: false, stderrTruncated: false, timedOut: false, durationMs: 3,
    startedAt: new Date(RUNNER_AT).toISOString(), endedAt: new Date(RUNNER_AT + 3).toISOString(),
    ...overrides
  });
}

type Stub = {
  calls: string[]; executions: number; aborts: number;
  containment: RunnerContainment; establishRefusal: Error | null;
  behaviour: (input: RunnerExecutionRequest) => Promise<RunnerExecution>;
};

type Fixture = {
  root: string; data: string; projectId: string; projectPath: string;
  store: ControlStore; port: RunnerPort; stub: Stub; clock: { now: number };
  broker: RunnerBroker;
  cleanup(): Promise<void>;
};

function optionsFor(f: { projectId: string; projectPath: string; clock: { now: number } }) {
  return {
    workspace: createProjectWorkspaceResolver({ projectRoot: (id) => (id === f.projectId ? f.projectPath : undefined) }),
    projectKnown: (id: string) => id === f.projectId,
    clock: () => new Date(f.clock.now)
  };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-runner-'));
  const data = join(root, 'data'), projectPath = join(root, 'workspaces', 'project'), outside = join(root, 'outside');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(join(projectPath, 'pkg', 'nested'), { recursive: true, mode: 0o755 });
  await mkdir(outside, { recursive: true, mode: 0o755 });
  // A symlink inside the project root that leads out of it: a job workspace is never one.
  await symlink(outside, join(projectPath, 'escape'));
  const store = new ControlStore(data);
  const stub: Stub = {
    calls: [], executions: 0, aborts: 0,
    containment: containment(), establishRefusal: null,
    behaviour: async () => execution()
  };
  const port: RunnerPort = {
    async establish() {
      stub.calls.push('establish');
      if (stub.establishRefusal) throw stub.establishRefusal;
      return stub.containment;
    },
    async execute(input) {
      stub.calls.push('execute:' + input.job.recipe);
      stub.executions += 1;
      input.signal.addEventListener('abort', () => { stub.aborts += 1; }, { once: true });
      return stub.behaviour(input);
    }
  };
  const projectId = randomUUID(), clock = { now: RUNNER_AT };
  const broker = new RunnerBroker(store, port, optionsFor({ projectId, projectPath, clock }));
  return {
    root, data, projectId, projectPath, store, port, stub, clock, broker,
    cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); }
  };
}

/** Submit one job with the documented defaults, so each test states only what it is about. */
async function submitJob(f: Fixture, overrides: { recipe?: 'test-run' | 'noop-probe'; workspace?: string; limits?: unknown } = {}): Promise<RunnerJobRecord> {
  return f.broker.submit({ projectId: f.projectId, recipe: overrides.recipe ?? 'noop-probe', workspace: overrides.workspace ?? '.', limits: overrides.limits });
}

function isRunnerError(code: string, pattern?: RegExp) {
  return (error: unknown) => error instanceof RunnerError && error.code === code && (pattern === undefined || pattern.test(error.message));
}

test('a coding job is a validated request: unknown fields, unknown recipes, out-of-root workspaces and oversized limits fail closed', async () => {
  const f = await fixture();
  try {
    // The request model refuses everything before a record can exist.
    assert.throws(() => runnerJobRequest({ recipe: 'npm test', workspace: '.' }), isRunnerError('INVALID', /recipe must be one of test-run, noop-probe/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe' }), isRunnerError('INVALID', /workspace/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '.', shell: 'rm -rf /' }), isRunnerError('INVALID', /does not accept/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '../outside' }), isRunnerError('OUTSIDE_ROOT', /parent segment/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '/etc' }), isRunnerError('OUTSIDE_ROOT', /absolute path/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: 'pkg/../../outside' }), isRunnerError('OUTSIDE_ROOT'));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: 'pkg\\nested' }), isRunnerError('OUTSIDE_ROOT', /backslash/));
    // Limits: refused with the bound named, never clamped.
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '.', limits: { timeoutMs: 10_000_000 } }), isRunnerError('INVALID', /timeoutMs must be a whole number from 100 to 300000 milliseconds/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '.', limits: { outputBytes: 10 * 1024 * 1024 } }), isRunnerError('INVALID', /outputBytes must be a whole number from 256 to 8192 bytes/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '.', limits: { memoryBytes: 64 * 1024 * 1024 * 1024 } }), isRunnerError('INVALID', /memoryBytes/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '.', limits: { cpus: 99 } }), isRunnerError('INVALID', /cpus must be a whole number from 1 to 2/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '.', limits: { pids: 99_999 } }), isRunnerError('INVALID', /pids/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '.', limits: { surprise: 1 } }), isRunnerError('INVALID', /does not accept/));
    assert.throws(() => runnerJobRequest({ recipe: 'noop-probe', workspace: '.', limits: { cpus: 1.5 } }), isRunnerError('INVALID', /cpus/));
    // An absent limit takes the documented default, and a partial object fills only what it names.
    assert.deepEqual(runnerJobRequest({ recipe: 'noop-probe', workspace: '.' }).limits, RUNNER_DEFAULT_LIMITS);
    assert.equal(runnerJobRequest({ recipe: 'noop-probe', workspace: '.', limits: { cpus: 2 } }).limits.cpus, 2);
    assert.equal(runnerJobRequest({ recipe: 'noop-probe', workspace: '.', limits: { cpus: 2 } }).limits.timeoutMs, RUNNER_DEFAULT_LIMITS.timeoutMs);

    // The broker refuses the same things, and the durable record stays empty.
    await assert.rejects(submitJob(f, { recipe: 'test-run', workspace: '../outside' }), isRunnerError('OUTSIDE_ROOT'));
    await assert.rejects(submitJob(f, { workspace: 'escape' }), isRunnerError('OUTSIDE_ROOT', /Symlinks are not permitted/));
    await assert.rejects(submitJob(f, { workspace: 'does-not-exist' }), isRunnerError('NOT_FOUND'));
    await assert.rejects(submitJob(f, { workspace: '/etc' }), isRunnerError('OUTSIDE_ROOT'));
    await assert.rejects(submitJob(f, { limits: { memoryBytes: 64 * 1024 * 1024 * 1024 } }), isRunnerError('INVALID'));
    await assert.rejects(f.broker.submit({ projectId: randomUUID(), recipe: 'noop-probe', workspace: '.' }), isRunnerError('NOT_FOUND', /is not registered/));
    assert.deepEqual(f.broker.read(f.projectId).jobs, [], 'a refused submission wrote nothing');
    assert.throws(() => f.broker.read(randomUUID()), isRunnerError('NOT_FOUND', /is not registered/));
    assert.equal(f.stub.executions, 0, 'no refused request ran anything');

    // A valid submission is stored as the relative reference it was submitted as, and never as a path.
    const job = await submitJob(f, { workspace: 'pkg/nested', limits: { timeoutMs: 5_000 } });
    assert.deepEqual([job.state, job.revision, job.workspace, job.limits.timeoutMs], ['pending', 1, 'pkg/nested', 5_000]);
    assert.ok(!JSON.stringify(job).includes(f.projectPath), 'the stored record carries no filesystem path');
    assert.deepEqual(f.broker.read(f.projectId).jobs.map((candidate) => candidate.id), [job.id]);
    assert.deepEqual([f.broker.read(f.projectId).readOnly, f.broker.read(f.projectId).recipes], [true, ['test-run', 'noop-probe']]);
    assert.throws(() => f.broker.readJob(f.projectId, randomUUID()), isRunnerError('NOT_FOUND', /holds no coding job/));
  } finally { await f.cleanup(); }
});

test('a claim race yields exactly one winner, and a live claim is never stolen', async () => {
  const f = await fixture();
  try {
    const job = await submitJob(f);
    const second = new RunnerBroker(f.store, f.port, optionsFor(f));
    const race = await Promise.allSettled([
      f.broker.claim({ projectId: f.projectId, owner: 'dispatcher-a' }),
      second.claim({ projectId: f.projectId, owner: 'dispatcher-b' })
    ]);
    assert.equal(race.filter((entry) => entry.status === 'fulfilled').length, 1, 'exactly one claim won');
    const loser = race.find((entry) => entry.status === 'rejected') as PromiseRejectedResult;
    assert.ok(loser.reason instanceof RunnerError && loser.reason.code === 'CONFLICT', 'the loser is refused as a conflict');
    const stored = f.broker.readJob(f.projectId, job.id);
    assert.equal(stored.state, 'claimed');
    assert.ok(['dispatcher-a', 'dispatcher-b'].includes(stored.claim!.owner), 'the winner is one of the two');
    assert.ok(Date.parse(stored.claim!.leaseExpiresAt) > Date.parse(stored.claim!.claimedAt), 'the claim carries a lease');
    // One submission and one claim: the loser wrote nothing at all.
    const operations = f.store.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE project_id=? AND session_id='runner' AND kind='runner.job'").get(f.projectId) as { count: number };
    assert.equal(operations.count, 2, 'the store holds one record per revision that really happened');

    // A live claim is never stolen, and its owner renews it.
    const other = stored.claim!.owner === 'dispatcher-a' ? 'dispatcher-b' : 'dispatcher-a';
    await assert.rejects(f.broker.claim({ projectId: f.projectId, owner: other }), isRunnerError('CONFLICT', /a live claim is never stolen/));
    const renewed = await f.broker.claim({ projectId: f.projectId, owner: stored.claim!.owner });
    assert.deepEqual([renewed.revision, renewed.claim!.owner], [stored.revision + 1, stored.claim!.owner]);
    // Past the lease it is reclaimable, which is safe because nothing has run yet.
    f.clock.now += RUNNER_DEFAULT_LEASE_MS + 1_000;
    const reclaimed = await f.broker.claim({ projectId: f.projectId, owner: other });
    assert.deepEqual([reclaimed.state, reclaimed.claim!.owner, reclaimed.revision], ['claimed', other, renewed.revision + 1]);
    assert.equal(f.stub.executions, 0, 'claiming runs nothing');
  } finally { await f.cleanup(); }
});

test('a run the port cannot report leaves the job running, and reconciliation names operator attention without a rerun', async () => {
  const f = await fixture();
  try {
    const job = await submitJob(f);
    await f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' });
    // The port reports nothing: this is a crash mid-run, and a port refusal looks identical from here,
    // so this build records no outcome at all rather than inventing one.
    f.stub.behaviour = async () => { throw new Error('the port died mid-run'); };
    await assert.rejects(
      f.broker.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' }),
      isRunnerError('UNAVAILABLE', /never re-run automatically/)
    );
    const running = f.broker.readJob(f.projectId, job.id);
    assert.deepEqual([running.state, running.result, running.attention], ['running', null, null], 'the record proves a run began and records no outcome');
    assert.equal(f.stub.executions, 1, 'the run really started once');
    // A running job is never claimed again and never run again.
    await assert.rejects(f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' }), isRunnerError('ILLEGAL', /a running job is never claimed/));
    await assert.rejects(f.broker.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' }), isRunnerError('ILLEGAL', /cannot be run/));

    // A fresh broker over the same store is the restart: it settles from what the record proves.
    const restarted = new RunnerBroker(f.store, f.port, optionsFor(f));
    assert.deepEqual(await restarted.reconcile(), { settled: 0, attention: 1, unchanged: 0 });
    const attention = restarted.readJob(f.projectId, job.id);
    assert.deepEqual([attention.state, attention.attention!.reason], ['attention', 'job-interrupted']);
    assert.match(attention.attention!.detail, /never re-runs a job to find out what happened/);
    assert.equal(f.stub.executions, 1, 'reconciliation never re-ran the job');
    assert.deepEqual(await restarted.reconcile(), { settled: 0, attention: 0, unchanged: 0 }, 'reconciliation is idempotent');
    await assert.rejects(restarted.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' }), isRunnerError('ILLEGAL', /is terminal, so the job is never run again/));
    assert.equal(f.stub.executions, 1, 'an operator-attention job is never re-run');
  } finally { await f.cleanup(); }
});

test('a settled job is never run again, and a settle raced against a run executes nothing', async () => {
  const f = await fixture();
  try {
    const job = await submitJob(f);
    await f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' });
    const ran = await f.broker.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' });
    assert.deepEqual([ran.state, ran.result!.outcome, ran.result!.exitCode, ran.result!.stdout], ['settled', 'succeeded', 0, 'probe\n']);
    assert.deepEqual(ran.result!.commands, [{ recipe: 'noop-probe', argv: ['/bin/echo', 'pilot-runner-probe'] }], 'the result records the allowlist own command');
    assert.equal(f.stub.executions, 1, 'the job ran exactly once');
    await assert.rejects(f.broker.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' }), isRunnerError('ILLEGAL', /is terminal, so the job is never run again/));
    await assert.rejects(f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' }), isRunnerError('ILLEGAL', /holds no coding job to claim/));
    const again = await f.broker.settle({ projectId: f.projectId, jobId: job.id });
    assert.deepEqual([again.outcome, again.changed, again.record.revision], ['unchanged', false, ran.revision], 'settling a settled job writes nothing');
    assert.deepEqual(await f.broker.reconcile(), { settled: 0, attention: 0, unchanged: 0 });
    assert.equal(f.stub.executions, 1);

    // A settle raced against a run: the store's unique index picks exactly one winner, and the loser
    // writes nothing — and therefore executes nothing.
    const second = await submitJob(f);
    await f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' });
    const race = await Promise.allSettled([
      f.broker.settle({ projectId: f.projectId, jobId: second.id }),
      f.broker.run({ projectId: f.projectId, jobId: second.id, owner: 'dispatcher' })
    ]);
    assert.equal(race.filter((entry) => entry.status === 'fulfilled').length, 1, 'the store picked exactly one winner');
    const settleOutcome = race[0], runOutcome = race[1];
    if (settleOutcome.status === 'fulfilled') {
      assert.deepEqual([settleOutcome.value.record.state, settleOutcome.value.record.attention!.reason], ['attention', 'job-not-run']);
      assert.equal(runOutcome.status, 'rejected');
      assert.ok((runOutcome as PromiseRejectedResult).reason instanceof RunnerError && (runOutcome as PromiseRejectedResult).reason.code === 'CONFLICT');
      assert.equal(f.stub.executions, 1, 'the run that lost the compare-and-swap executed nothing');
      assert.equal(f.broker.readJob(f.projectId, second.id).state, 'attention');
    } else {
      assert.equal(runOutcome.status, 'fulfilled');
      assert.equal((runOutcome as PromiseFulfilledResult<RunnerJobRecord>).value.state, 'settled');
      assert.equal(f.stub.executions, 2, 'the run that won executed exactly once');
      assert.ok((settleOutcome as PromiseRejectedResult).reason instanceof RunnerError && (settleOutcome as PromiseRejectedResult).reason.code === 'CONFLICT');
    }
  } finally { await f.cleanup(); }
});

test('output is truncated at the byte cap, and a stored record stays inside the control store bound', async () => {
  const f = await fixture();
  try {
    const job = await submitJob(f, { limits: { outputBytes: 256 } });
    await f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' });
    f.stub.behaviour = async () => execution({ stdout: 'a'.repeat(4_000), stderr: 'b'.repeat(4_000), stdoutBytes: 4_000, stderrBytes: 4_000 });
    const ran = await f.broker.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' });
    const result = ran.result!;
    assert.equal(result.capBytes, 256);
    assert.equal(result.stdout.length, 256, 'the stored stdout is cut at the cap');
    assert.equal(new TextEncoder().encode(result.stdout).byteLength, 256);
    assert.equal(result.truncated, true, 'the result says output was dropped');
    assert.deepEqual([result.stdoutBytes, result.stderrBytes], [4_000, 4_000], 'the stream still says how much it produced');
    assert.equal(ran.state, 'settled');

    // A stream of control characters costs what it really costs in the record, so it cannot inflate one.
    const second = await submitJob(f, { limits: { outputBytes: 256 } });
    await f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' });
    f.stub.behaviour = async () => execution({ stdout: '\u0001'.repeat(50_000), stdoutBytes: 50_000, stdoutTruncated: true });
    const escaped = await f.broker.run({ projectId: f.projectId, jobId: second.id, owner: 'dispatcher' });
    assert.equal(escaped.result!.truncated, true);
    assert.ok(JSON.stringify(escaped.result!.stdout).length - 2 <= 256, 'the stored text occupies no more than the cap once escaped');
    assert.ok(runnerRecordBytes(escaped) <= RUNNER_MAX_RECORD_BYTES, 'the whole record stays inside the documented bound');
  } finally { await f.cleanup(); }
});

test('the broker enforces the wall clock, and a run it stopped keeps what the port reported', async () => {
  const f = await fixture();
  try {
    const job = await submitJob(f, { limits: { timeoutMs: 100 } });
    await f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' });
    // A port that honours the abort reports promptly with the output it had.
    f.stub.behaviour = (input) => new Promise<RunnerExecution>((done) => {
      input.signal.addEventListener('abort', () => done(execution({ exitCode: null, stdout: 'partial\n', stdoutBytes: 8, timedOut: true, durationMs: 100 })), { once: true });
    });
    const started = Date.now();
    const ran = await f.broker.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' });
    const elapsed = Date.now() - started;
    assert.equal(ran.state, 'settled');
    assert.deepEqual([ran.result!.outcome, ran.result!.exitCode], ['timed-out', null], 'a timed-out run records no exit code');
    assert.equal(ran.result!.stdout, 'partial\n', 'what the run reported before it was stopped is kept');
    assert.ok(elapsed >= 100, 'the broker waited at least the job wall clock');
    assert.equal(f.stub.aborts, 1, 'the port was aborted exactly once');

    // A port that ignores the abort cannot hold a job open: the bounded grace ends it anyway.
    const second = await submitJob(f, { limits: { timeoutMs: 100 } });
    await f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' });
    f.stub.behaviour = () => new Promise<RunnerExecution>(() => { /* never reports */ });
    const stubbornStart = Date.now();
    const stubborn = await f.broker.run({ projectId: f.projectId, jobId: second.id, owner: 'dispatcher' });
    const stubbornElapsed = Date.now() - stubbornStart;
    assert.deepEqual([stubborn.result!.outcome, stubborn.result!.exitCode, stubborn.result!.stdout], ['timed-out', null, '']);
    assert.ok(stubbornElapsed < 2_000, 'the grace after an abort is bounded, not a second wait');
    assert.ok(stubborn.result!.durationMs >= 100, 'a run the port never reported still records the wall clock this build waited');
    assert.ok(Date.parse(stubborn.result!.endedAt) >= Date.parse(stubborn.result!.startedAt), 'the recorded instants are in order');
    assert.equal(stubborn.state, 'settled');
  } finally { await f.cleanup(); }
});

test('a job is never run when the container properties cannot be established, and nothing falls back to the host', async () => {
  const f = await fixture();
  try {
    const job = await submitJob(f);
    // A runtime that cannot be contained refuses the claim: the job is left unclaimed and nothing ran.
    f.stub.containment = containment({ network: 'bridge', dockerSocket: true });
    await assert.rejects(f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' }), isRunnerError('UNAVAILABLE', /no-network/));
    assert.deepEqual([f.broker.readJob(f.projectId, job.id).state, f.stub.executions], ['pending', 0], 'the job is left unclaimed and nothing ran');
    // A runtime that is not there at all refuses the same way.
    f.stub.establishRefusal = new RunnerError('The container runtime did not answer, so no job can be contained.', 'UNAVAILABLE');
    await assert.rejects(f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' }), isRunnerError('UNAVAILABLE'));
    assert.equal(f.stub.executions, 0, 'a runner that cannot contain a job executes nothing anywhere');

    // The same at run time: the claim is taken, and then the properties cannot be established.
    f.stub.establishRefusal = null;
    f.stub.containment = containment();
    await f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' });
    f.stub.containment = containment({ rootFilesystem: 'writable', capabilities: 'SYS_ADMIN', mounts: ['workspace', 'docker-socket'] });
    await assert.rejects(
      f.broker.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' }),
      isRunnerError('UNAVAILABLE', /read-only-root/)
    );
    assert.deepEqual([f.broker.readJob(f.projectId, job.id).state, f.stub.executions], ['claimed', 0], 'nothing ran and the job is left claimed');
    // Limits the runtime says it cannot enforce are refused too, with its own ceiling named.
    f.stub.containment = containment({ maxMemoryBytes: 64 * 1024 * 1024, maxWallClockMs: 1_000 });
    await assert.rejects(
      f.broker.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' }),
      isRunnerError('INVALID', /memoryBytes is 268435456 but the runtime reports at most 67108864/)
    );
    assert.equal(f.stub.executions, 0, 'nothing ran');
    // There is no fallback anywhere: the port is the only execution path, and it was never called.
    assert.deepEqual(f.stub.calls.filter((call) => call.startsWith('execute')), []);
    // An owner can resolve a claim that cannot run, and the record says exactly why.
    const settled = await f.broker.settle({ projectId: f.projectId, jobId: job.id });
    assert.deepEqual([settled.record.state, settled.record.attention!.reason], ['attention', 'job-not-run']);
    assert.equal(f.stub.executions, 0, 'settling a claim runs nothing');
  } finally { await f.cleanup(); }
});

test('jobs and their outcomes are durable across a reopen, and the per-project bound is enforced', async () => {
  const f = await fixture();
  try {
    const job = await submitJob(f);
    await f.broker.claim({ projectId: f.projectId, owner: 'dispatcher' });
    await f.broker.run({ projectId: f.projectId, jobId: job.id, owner: 'dispatcher' });
    f.store.close();
    const reopened = new ControlStore(f.data);
    try {
      const broker = new RunnerBroker(reopened, f.port, optionsFor(f));
      const readBack = broker.readJob(f.projectId, job.id);
      assert.deepEqual([readBack.id, readBack.state, readBack.result!.exitCode, readBack.result!.stdout, readBack.result!.outcome], [job.id, 'settled', 0, 'probe\n', 'succeeded']);
      assert.deepEqual(broker.read(f.projectId).jobs.map((candidate) => candidate.id), [job.id]);
      assert.deepEqual(await broker.reconcile(), { settled: 0, attention: 0, unchanged: 0 }, 'a settled job is left exactly as it is');
      assert.equal(f.stub.executions, 1);
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }

  // The per-project bound is a refusal with the record unchanged, and the list stays bounded.
  const g = await fixture();
  try {
    for (let index = 0; index < RUNNER_MAX_JOBS; index += 1) await submitJob(g);
    assert.equal(g.broker.read(g.projectId).jobs.length, RUNNER_MAX_JOBS);
    assert.equal(g.broker.read(g.projectId).truncated, false);
    await assert.rejects(submitJob(g), isRunnerError('BOUNDED', /documented maximum of 50 coding jobs/));
    assert.equal(g.broker.read(g.projectId).jobs.length, RUNNER_MAX_JOBS, 'a refused submission wrote nothing');
  } finally { await g.cleanup(); }
});

test('the real docker port builds the documented containment command line, and fails closed when it cannot contain a job', async () => {
  // The command line *is* the containment: every required property is one flag, exactly one host path
  // is mounted, and the image and the allowlist argv are the last words.
  const argv = dockerRunArgv({
    image: 'pilot-runner:test', user: '10001:10001', tmpfsBytes: 16 * 1024 * 1024,
    workspace: '/tmp/ws', containerName: 'pilot-runner-job', limits: RUNNER_DEFAULT_LIMITS, recipe: 'noop-probe'
  });
  const pairs: readonly (readonly [string, string])[] = [
    ['--network', 'none'], ['--user', '10001:10001'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'],
    ['--pids-limit', String(RUNNER_DEFAULT_LIMITS.pids)], ['--memory', String(RUNNER_DEFAULT_LIMITS.memoryBytes) + 'b'],
    ['--memory-swap', String(RUNNER_DEFAULT_LIMITS.memoryBytes) + 'b'], ['--cpus', String(RUNNER_DEFAULT_LIMITS.cpus)],
    ['--tmpfs', '/tmp:rw,noexec,nosuid,size=' + 16 * 1024 * 1024],
    ['--volume', '/tmp/ws:/workspace:rw'], ['--workdir', '/workspace'], ['--name', 'pilot-runner-job']
  ];
  for (const [flag, value] of pairs) {
    const at = argv.indexOf(flag);
    assert.ok(at >= 0, 'the command line carries ' + flag);
    assert.equal(argv[at + 1], value, flag + ' is ' + value);
  }
  assert.ok(argv.includes('--read-only'), 'the root filesystem is read-only');
  assert.ok(argv.includes('--rm'), 'a finished container is removed');
  assert.equal(argv.filter((argument) => argument === '--volume').length, 1, 'exactly one host path is mounted');
  assert.deepEqual(argv.slice(-3), ['pilot-runner:test', '/bin/echo', 'pilot-runner-probe'], 'the image and the allowlist argv are the last words');
  assert.ok(!argv.some((argument) => /docker\.sock/.test(argument)), 'the runtime socket is never mounted');
  assert.ok(!argv.includes('-e') && !argv.includes('--env'), 'no environment is passed to a job');
  assert.ok(!argv.includes('-c') && !argv.includes('sh'), 'no shell is involved');

  // A fake binary records the argv the port really spawns. No container is started anywhere: the script
  // only logs its arguments and prints what the port parses.
  const root = await mkdtemp(join(tmpdir(), 'pilot-docker-'));
  const log = join(root, 'calls.log');
  const fake = join(root, 'fake-docker');
  await writeFile(fake, '#!/bin/sh\nprintf "%s|" "$@" >> ' + JSON.stringify(log) + '\nprintf "\\n" >> ' + JSON.stringify(log) + '\ncase "$1" in\n  version) echo 27.0.0 ;;\n  image) case "$3" in pilot-runner:test) echo sha256:test ;; *) exit 1 ;; esac ;;\n  info) case "$3" in *MemTotal*) echo 8589934592 ;; *) echo 8 ;; esac ;;\n  run) echo "probe-output" ;;\nesac\nexit 0\n', { mode: 0o755 });
  try {
    const port = dockerRunnerPort({ image: 'pilot-runner:test', docker: fake });
    const reported = await port.establish();
    assert.deepEqual(runnerContainmentProblems(reported), [], 'the port reports every required property');
    assert.deepEqual([reported.network, reported.rootFilesystem, reported.capabilities, reported.user, reported.mounts], ['none', 'read-only', 'none', '10001:10001', ['workspace']]);
    const job = submittedRunnerJob({ id: randomUUID(), projectId: 'pilot', request: runnerJobRequest({ recipe: 'noop-probe', workspace: '.' }), now: new Date(RUNNER_AT) });
    const executed = await port.execute({ job, workspace: '/tmp/ws', containerName: 'pilot-runner-' + job.id, signal: new AbortController().signal });
    assert.deepEqual([executed.exitCode, executed.stdout, executed.timedOut], [0, 'probe-output\n', false]);
    const runLine = (await readFile(log, 'utf8')).split('\n').find((line) => line.startsWith('run|'));
    assert.ok(runLine !== undefined, 'the port really spawned the container command line');
    for (const fragment of ['--network|none|', '--read-only|', '--cap-drop|ALL|', '--security-opt|no-new-privileges|', '--volume|/tmp/ws:/workspace:rw|', '|pilot-runner:test|/bin/echo|pilot-runner-probe|']) {
      assert.ok(runLine!.includes(fragment), 'the spawned command line carries ' + fragment);
    }
    // A binary that is not there, an image that is not loaded and no configured image at all each fail
    // closed, and none of them runs anything on the host.
    await assert.rejects(dockerRunnerPort({ image: 'pilot-runner:test', docker: join(root, 'missing-docker') }).establish(), isRunnerError('UNAVAILABLE', /did not answer/));
    await assert.rejects(dockerRunnerPort({ image: 'pilot-runner:absent', docker: fake }).establish(), isRunnerError('UNAVAILABLE', /is not present in the container runtime/));
    await assert.rejects(dockerRunnerPort({}).establish(), isRunnerError('UNAVAILABLE', /no runner image is configured/));
    await assert.rejects(dockerRunnerPort({ image: '--privileged', docker: fake }).establish(), isRunnerError('UNAVAILABLE', /not a plain image name/));
  } finally { await rm(root, { recursive: true, force: true }); }
});
