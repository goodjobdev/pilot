import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentStore } from '../../src/server/state/agent-store';
import { AgentBudgetLedger, AgentBudgetExceeded } from '../../src/server/state/agent-budget';
import { LocalTestError, LocalTestRunner, localTestJobId } from '../../src/server/state/local-test-runner';

// These tests run the fixed `node --test` recipe against disposable projects. Nothing touches a live
// project, the integration worktree or a real planning document.

const PROJECT = '33333333-3333-4333-8333-333333333333';
const AGENT = 'agent-one';

const passing = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { appendFileSync } from 'node:fs';",
  "appendFileSync('runs.log','run\\n');",
  "test('passes',()=>{ console.log('LOCAL-TEST-PASS-MARKER'); assert.equal(1,1); });",
  ''
].join('\n');
const failing = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { appendFileSync } from 'node:fs';",
  "appendFileSync('runs.log','run\\n');",
  "test('fails',()=>{ assert.equal(1,2); });",
  ''
].join('\n');
// A real child process that outlives the test runner unless the whole process group is signalled.
const hanging = [
  "import test from 'node:test';",
  "import { spawn } from 'node:child_process';",
  "import { appendFileSync, writeFileSync } from 'node:fs';",
  "appendFileSync('runs.log','run\\n');",
  "test('hangs', async () => {",
  "  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });",
  "  writeFileSync('pids.json', JSON.stringify({ test: process.pid, child: child.pid }));",
  "  await new Promise(() => {});",
  "});",
  ''
].join('\n');
const loud = [
  "import test from 'node:test';",
  "test('loud',()=>{ process.stdout.write('o'.repeat(50000)); process.stderr.write('e'.repeat(50000)); });",
  ''
].join('\n');

async function projectWith(files: Record<string, string>): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-local-tests-'));
  const project = join(root, 'project');
  await mkdir(project);
  for (const [name, body] of Object.entries(files)) await writeFile(join(project, name), body);
  return { root, project };
}

async function withControl(root: string): Promise<ControlStore> {
  const data = join(root, 'data');
  await mkdir(data, { recursive: true });
  return new ControlStore(data);
}

function run(runner: LocalTestRunner, project: string, taskId: string, extra: Partial<Parameters<LocalTestRunner['run']>[0]> = {}) {
  return runner.run({ projectId: PROJECT, agentId: AGENT, conversationId: 'conversation-one', taskId, projectRoot: project, authorize: () => {}, reserveJob: () => {}, ...extra });
}

function runCount(project: string): number {
  const path = join(project, 'runs.log');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0;
}

async function waitForDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

async function waitForFile(path: string, timeoutMs = 15000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('the disposable fixture did not write ' + path);
}

test('the fixed recipe runs real node --test in the project root and records both outcomes', async t => {
  const pass = await projectWith({ 'pass.test.mjs': passing }), fail = await projectWith({ 'fail.test.mjs': failing });
  const control = await withControl(pass.root);
  t.after(async () => { control.close(); await rm(pass.root, { recursive: true, force: true }); await rm(fail.root, { recursive: true, force: true }); });
  const runner = new LocalTestRunner(control);
  const ok = await run(runner, pass.project, 'passing');
  assert.equal(ok.status, 'completed');
  assert.equal(ok.state, 'succeeded');
  assert.equal(ok.outcome, 'succeeded');
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(ok.commands, ['node', '--test']);
  assert.equal(ok.terminationConfirmed, true);
  assert.match(ok.stdout, /LOCAL-TEST-PASS-MARKER/);
  assert.match(ok.note, /exit code 0/);
  assert.equal(runCount(pass.project), 1, 'the project test really executed');

  const bad = await run(runner, fail.project, 'failing');
  assert.equal(bad.status, 'completed');
  assert.equal(bad.state, 'failed');
  assert.equal(bad.outcome, 'failed');
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.terminationConfirmed, true);
  assert.match(bad.stdout, /fails/, 'the failure output is recorded');
  assert.equal(runCount(fail.project), 1);

  const jobs = runner.list(PROJECT);
  assert.deepEqual(jobs.map(job => job.state), ['failed', 'succeeded']);
});

test('a wall-clock timeout stops the process group and records an unknown outcome that is not replayed', async t => {
  const { root, project } = await projectWith({ 'hang.test.mjs': hanging });
  const control = await withControl(root);
  t.after(async () => { control.close(); await rm(root, { recursive: true, force: true }); });
  const runner = new LocalTestRunner(control);
  const result = await run(runner, project, 'timeout', { limits: { timeoutMs: 1000 } });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.state, 'unknown');
  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.exitCode, null);
  assert.equal(result.terminationConfirmed, true);
  assert.ok(result.durationMs !== null && result.durationMs >= 900);
  assert.match(result.note, /best-effort/);
  const pids = JSON.parse(await readFile(join(project, 'pids.json'), 'utf8')) as { test: number; child: number };
  assert.ok(await waitForDeath(pids.test), 'the test runner process was terminated with its group');
  assert.ok(await waitForDeath(pids.child), 'a grandchild in the same process group was terminated too');

  // The durable record is the outcome; the same invocation does not start a second process.
  const before = runCount(project);
  const again = await run(runner, project, 'timeout', { limits: { timeoutMs: 1000 } });
  assert.equal(again.state, 'unknown');
  assert.match(again.note, /already has a durable test job; it was not started again/);
  assert.equal(runCount(project), before);
  assert.equal(runner.list(PROJECT).length, 1);
});

test('cancellation stops the process group and records an interrupted run', async t => {
  const { root, project } = await projectWith({ 'hang.test.mjs': hanging });
  const control = await withControl(root);
  t.after(async () => { control.close(); await rm(root, { recursive: true, force: true }); });
  const runner = new LocalTestRunner(control);
  const controller = new AbortController();
  const started = (async () => {
    await waitForFile(join(project, 'pids.json'));
    controller.abort();
  })();
  const result = await run(runner, project, 'cancelled', { signal: controller.signal });
  await started;
  assert.equal(result.status, 'uncertain');
  assert.equal(result.state, 'interrupted');
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminationConfirmed, true);
  const pids = JSON.parse(await readFile(join(project, 'pids.json'), 'utf8')) as { test: number; child: number };
  assert.ok(await waitForDeath(pids.test), 'the cancelled run was terminated with its group');
  assert.ok(await waitForDeath(pids.child), 'the cancelled run took its grandchild with it');
});

test('stdout is capped and the receipt still says how much the run produced', async t => {
  const { root, project } = await projectWith({ 'loud.test.mjs': loud });
  const control = await withControl(root);
  t.after(async () => { control.close(); await rm(root, { recursive: true, force: true }); });
  const result = await run(new LocalTestRunner(control), project, 'loud', { limits: { outputBytes: 512 } });
  assert.equal(result.stdoutTruncated, true);
  assert.equal(Buffer.byteLength(result.stdout), 512);
  assert.ok(result.stdoutBytes > 512, 'the receipt still counts what the stream produced');
  // Node's own test runner folds a test file's stderr into its stdout, so the application-side
  // stderr pipe usually stays empty here. The same bound is applied to it: the stored prefix is
  // never longer than the cap and the flag agrees with the counted bytes.
  assert.ok(Buffer.byteLength(result.stderr) <= 512);
  assert.equal(result.stderrTruncated, result.stderrBytes > 512);
  assert.ok(result.stderrBytes >= Buffer.byteLength(result.stderr));
});

test('revocation after the durable intent records that nothing ran, and before it leaves no record', async t => {
  const { root, project } = await projectWith({ 'pass.test.mjs': passing });
  const control = await withControl(root);
  t.after(async () => { control.close(); await rm(root, { recursive: true, force: true }); });
  const runner = new LocalTestRunner(control);

  // 1. authority passes, the intent is written, authority is re-read and revoked immediately before
  //    the spawn: the record says nothing ran and no process was created.
  let checks = 0;
  const refusedAfterIntent = await run(runner, project, 'revoked-late', { authorize: () => { if (++checks === 3) throw new Error('revoked'); } });
  assert.equal(refusedAfterIntent.status, 'refused');
  assert.equal(refusedAfterIntent.state, 'failed');
  assert.equal(refusedAfterIntent.outcome, 'not-started');
  assert.match(refusedAfterIntent.reason ?? '', /nothing ran/);
  assert.equal(runCount(project), 0);
  assert.equal(runner.list(PROJECT).length, 1);

  // 2. revoked in the intent's own transaction: nothing is admitted and nothing starts.
  let earlier = 0;
  await assert.rejects(run(runner, project, 'revoked-early', { authorize: () => { if (++earlier === 2) throw new Error('revoked'); } }), (error: unknown) => {
    assert.ok(error instanceof LocalTestError);
    assert.equal(error.code, 'REFUSED');
    return true;
  });
  assert.equal(runCount(project), 0);
  assert.equal(runner.list(PROJECT).length, 1, 'no second durable job was admitted');

  // 3. a refused reservation admits nothing and starts nothing.
  await assert.rejects(run(runner, project, 'no-budget', { reserveJob: () => { throw new Error('no job budget'); } }), /no job budget/);
  assert.equal(runCount(project), 0);
  assert.equal(runner.list(PROJECT).length, 1);
});

test('the rolling-hour job budget is enforced by the installed reservation path', async t => {
  const { root, project } = await projectWith({ 'pass.test.mjs': passing });
  const control = await withControl(root);
  t.after(async () => { control.close(); await rm(root, { recursive: true, force: true }); });
  const agents = new AgentStore(control, { models: () => [{ provider: 'fixture', modelId: 'fixture' }], projectKnown: id => id === PROJECT });
  const owner = { kind: 'owner' as const, identity: 'fixture' };
  const agent = agents.create({ actor: owner, draft: { name: 'Runner', description: '', enabled: true, model: { provider: 'fixture', modelId: 'fixture' }, workspace: { scope: { kind: 'projects', projectIds: [PROJECT] }, subpath: '' }, budgets: { maxRequests: null, maxOutputTokens: null, maxJobsPerHour: 1 }, scopes: ['run_tests'] } });
  agents.bindSession({ projectId: PROJECT, sessionId: '1', revision: 0, agentId: agent.id, actor: owner });
  const ledger = new AgentBudgetLedger(control);
  const reserveJob = () => { ledger.reserve({ agentId: agent.id, projectId: PROJECT, kind: 'job', limit: 1 }); };
  const runner = new LocalTestRunner(control);
  const first = await run(runner, project, 'budget-one', { agentId: agent.id, reserveJob });
  assert.equal(first.state, 'succeeded');
  await assert.rejects(run(runner, project, 'budget-two', { agentId: agent.id, reserveJob }), (error: unknown) => {
    assert.ok(error instanceof AgentBudgetExceeded);
    return true;
  });
  assert.equal(runCount(project), 1, 'the capped invocation never reached a process');
  assert.equal(runner.list(PROJECT).length, 1);
});

test('a duplicate invocation identity cannot create a second job, even concurrently', async t => {
  const { root, project } = await projectWith({ 'pass.test.mjs': passing });
  const control = await withControl(root);
  t.after(async () => { control.close(); await rm(root, { recursive: true, force: true }); });
  const runner = new LocalTestRunner(control);
  const jobId = localTestJobId({ projectId: PROJECT, conversationId: 'conversation-one', taskId: 'duplicate' });
  assert.match(jobId, /^agent-test-[a-f0-9]{64}$/);
  const [one, two] = await Promise.all([run(runner, project, 'duplicate'), run(runner, project, 'duplicate')]);
  const notes = [one.note, two.note].join('\n');
  assert.match(notes, /already has a durable test job|did not start a second process/);
  assert.equal(runCount(project), 1, 'only one process ran');
  assert.equal(runner.list(PROJECT).length, 1);
  assert.equal(runner.read(PROJECT, jobId)?.state, 'succeeded');
});

test('a killed application process leaves an uncertain job that is not re-run', async t => {
  const { root, project } = await projectWith({ 'hang.test.mjs': hanging });
  const data = join(root, 'data');
  await mkdir(data);
  const application = spawn(process.execPath, ['--import', 'tsx', 'tests/server/fixtures/local-test-runner-crash.ts', data, project, PROJECT, AGENT, 'conversation-one', 'interrupted'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  application.stderr?.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise<void>(resolve => application.once('close', () => resolve()));
  t.after(async () => { try { application.kill('SIGKILL'); } catch { /* already gone */ } });
  try {
    await waitForFile(join(project, 'pids.json'));
    const pids = JSON.parse(await readFile(join(project, 'pids.json'), 'utf8')) as { test: number; child: number };
    // The application process is killed while the fixed command is still running.
    assert.equal(application.kill('SIGKILL'), true);
    await closed;
    // Stop the now-orphaned process group so the disposable fixture is cleaned up.
    try { process.kill(-pids.test, 'SIGKILL'); } catch { /* the group is already gone */ }
    for (const pid of [pids.test, pids.child]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }

    const control = new ControlStore(data);
    t.after(() => control.close());
    const runner = new LocalTestRunner(control);
    assert.equal(runner.reconcile().recovered, 1, 'the interrupted intent becomes unknown once');
    assert.equal(runner.reconcile().recovered, 0, 'reconciliation is idempotent');
    const jobs = runner.list(PROJECT);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, 'unknown');
    assert.equal(jobs[0].status, 'uncertain');
    assert.match(jobs[0].reason ?? '', /not re-run/);

    const before = runCount(project);
    const replay = await run(runner, project, 'interrupted');
    assert.equal(replay.state, 'unknown');
    assert.match(replay.note, /already has a durable test job; it was not started again/);
    assert.equal(runCount(project), before, 'the interrupted invocation was not run again');
    assert.equal(runner.list(PROJECT).length, 1);
  } catch (error) {
    assert.fail((error as Error).message + (stderr === '' ? '' : '\nfixture stderr: ' + stderr));
  }
});
