// Internal worker. Invoke only through validate-runner-local.ts for endpoint checks, deadlines and cleanup.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, realpath, chmod } from 'node:fs/promises';
import { remainingTimeout } from './runner-validation-safety';
import { join } from 'node:path';
import { ControlStore } from '../src/server/state/control-store';
import { RunnerBroker, createProjectWorkspaceResolver, dockerRunnerPort } from '../src/server/state/runner-broker';
const exec = promisify(execFile);
const image = process.env.PILOT_VALIDATE_RUNNER_IMAGE;
assert.ok(image, 'Explicit locally built image required');
assert.ok(process.env.PILOT_VALIDATION_ROOT && process.env.PILOT_VALIDATION_DOCKER && process.env.PILOT_VALIDATION_DEADLINE, 'Supervisor required');
const root = await realpath(process.env.PILOT_VALIDATION_ROOT);
const deadline = Number(process.env.PILOT_VALIDATION_DEADLINE);
const binary = process.env.PILOT_VALIDATION_DOCKER;
const data = join(root, 'data'), project = join(root, 'project');
await mkdir(data); await mkdir(project); await chmod(root, 0o755);
const projectId = 'synthetic-validation';
const port = dockerRunnerPort({ image, docker: binary });
const options = { workspace: createProjectWorkspaceResolver({ projectRoot: id => id === projectId ? project : undefined }), projectKnown: (id: string) => id === projectId };
let store = new ControlStore(data);
let broker = new RunnerBroker(store, port, options);
const jobs: string[] = [], containers: string[] = [];
const docker = async (...args: string[]) => (await exec(binary, args, { timeout: remainingTimeout(deadline), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })).stdout;
async function run(name: string, source?: string, limits = {}) {
  const workspace = join(project, name); await mkdir(workspace); await chmod(workspace, 0o777);
  if (source) await writeFile(join(workspace, 'fixture.test.cjs'), source);
  const job = await broker.submit({ projectId, recipe: source ? 'test-run' : 'noop-probe', workspace: name, limits: { timeoutMs: 15000, ...limits } });
  jobs.push(job.id); containers.push('pilot-runner-' + job.id);
  // Persist before a claim or execution. The supervisor owns this ledger, outside the mounted project.
  await writeFile(join(root, 'containers.json'), JSON.stringify(containers));
  await broker.claim({ projectId, owner: 'local-validation' });
  return { job, pending: broker.run({ projectId, jobId: job.id, owner: 'local-validation' }) };
}
try {
  await port.establish();
  const probe = await run('probe');
  const probeResult = await probe.pending;
  assert.equal(probeResult.state, 'settled'); assert.equal(probeResult.result?.stdout, 'pilot-runner-probe\n');
  assert.equal(probeResult.result?.outcome, 'succeeded'); console.log('PASS noop-probe durable settlement');
  const containmentSource = `const {test}=require('node:test'); const a=require('node:assert/strict'); const fs=require('node:fs'); const net=require('node:net');
  test('synthetic containment', async()=>{
    a.equal(process.getuid(),10001); a.equal(process.getgid(),10001);
    const status=fs.readFileSync('/proc/self/status','utf8');
    a.match(status,/CapEff:\\s+0+\\n/); a.match(status,/NoNewPrivs:\\s+1/);
    a.throws(()=>fs.writeFileSync('/etc/pilot-synthetic','x'),e=>['EROFS','EACCES'].includes(e.code));
    a.throws(()=>fs.readFileSync(${JSON.stringify(join(root, 'outside', 'sentinel'))}),e=>e.code==='ENOENT');
    a.equal(fs.existsSync('/var/run/docker.sock'),false);
    fs.writeFileSync('/workspace/writable','synthetic'); fs.writeFileSync('/tmp/writable','synthetic');
    a.equal(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'268435456');
    a.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'64');
    a.equal(fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),'100000 100000');
    a.equal(fs.readFileSync('/sys/fs/cgroup/memory.swap.max','utf8').trim(),'0');
    const tmpMount=fs.readFileSync('/proc/mounts','utf8').split('\\n').find(x=>x.split(' ')[1]==='/tmp');
    a.ok(tmpMount); for(const flag of ['noexec','nosuid','size=16384k']) a.ok(tmpMount.includes(flag));
    a.deepEqual(Object.keys(require('node:os').networkInterfaces()),['lo']);
    await new Promise((resolve,reject)=>{ const s=net.connect({host:'192.0.2.1',port:9}); s.setTimeout(1000); s.on('connect',()=>{s.destroy();reject(Error('unexpected network'));}); s.on('timeout',()=>{s.destroy();reject(Error('network did not fail promptly'));}); s.on('error',e=>{try{a.equal(e.code,'ENETUNREACH');resolve();}catch(x){reject(x);}}); });
    await new Promise(r=>setTimeout(r,4000));
  });`;
  await mkdir(join(root, 'outside')); await writeFile(join(root, 'outside', 'sentinel'), 'synthetic');
  const success = await run('success', containmentSource);
  let inspected: any;
  for (let i = 0; i < 50; i++) {
    try { inspected = JSON.parse(await docker('inspect', 'pilot-runner-' + success.job.id))[0]; if (inspected.State.Running) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(inspected?.State.Running, 'Container must be inspected while running');
  const h = inspected.HostConfig;
  assert.equal(h.NetworkMode, 'none'); assert.equal(h.ReadonlyRootfs, true); assert.equal(inspected.Config.User, '10001:10001');
  assert.deepEqual(h.CapDrop, ['ALL']); assert.ok(h.SecurityOpt.includes('no-new-privileges'));
  assert.equal(h.Privileged, false); assert.equal(h.Memory, 268435456); assert.equal(h.MemorySwap, 268435456);
  assert.equal(h.NanoCpus, 1000000000); assert.equal(h.PidsLimit, 64);
  assert.deepEqual(h.Tmpfs, { '/tmp': 'rw,noexec,nosuid,size=16777216' });
  const binds = inspected.Mounts.filter((m: any) => m.Type === 'bind');
  assert.equal(binds.length, 1); assert.equal(binds[0].Destination, '/workspace'); assert.equal(binds[0].RW, true);
  assert.equal(binds[0].Source, join(project, 'success'));
  assert.ok(inspected.Mounts.every((m: any) => m.Type === 'bind' || (m.Type === 'tmpfs' && m.Destination === '/tmp')));
  const succeeded = await success.pending;
  assert.equal(succeeded.result?.outcome, 'succeeded', succeeded.result?.stdout + '\n' + succeeded.result?.stderr);
  console.log('PASS live inspect, cgroup limits, UID, capabilities, privilege guard, denied filesystem/network, writable workspace/tmp');
  const failure = await run('failure', "require('node:test').test('synthetic failure',()=>{throw Error('expected synthetic failure')})");
  assert.equal((await failure.pending).result?.outcome, 'failed'); console.log('PASS test-run failure');
  const truncation = await run('truncation', "require('node:test').test('output',()=>{console.log('x'.repeat(20000));console.error('y'.repeat(20000))})", { outputBytes: 256 });
  const truncated = (await truncation.pending).result!;
  assert.equal(truncated.outcome, 'succeeded'); assert.equal(truncated.truncated, true);
  // Node's default test reporter merges fixture console.error into TAP stdout.
  assert.ok(truncated.stdoutBytes > 40000);
  assert.ok(JSON.stringify(truncated.stdout).length - 2 <= 256); assert.ok(JSON.stringify(truncated.stderr).length - 2 <= 256);
  console.log('PASS bounded output truncation (test reporter merges fixture stderr into stdout)');
  const timeout = await run('timeout', "require('node:test').test('wait',async()=>{await new Promise(r=>setTimeout(r,60000))})", { timeoutMs: 2500 });
  let timeoutWasRunning = false;
  for (let i = 0; i < 20; i++) {
    try { if (JSON.parse(await docker('inspect', 'pilot-runner-' + timeout.job.id))[0].State.Running) { timeoutWasRunning = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(timeoutWasRunning, 'Timeout must stop a container observed running');
  const timed = await timeout.pending;
  assert.equal(timed.result?.outcome, 'timed-out'); assert.equal(timed.result?.exitCode, null);
  for (let i = 0; i < 30; i++) {
    const names = (await docker('ps', '-a', '--format', '{{.Names}}')).split('\n');
    if (!names.includes('pilot-runner-' + timeout.job.id)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const names = (await docker('ps', '-a', '--format', '{{.Names}}')).split('\n');
  for (const name of containers) assert.ok(!names.includes(name), 'Created container must be removed');
  console.log('PASS timeout removes container');
  const before = broker.read(projectId).jobs;
  store.close(); store = new ControlStore(data); broker = new RunnerBroker(store, port, options);
  assert.deepEqual(broker.read(projectId).jobs, before);
  assert.deepEqual(await broker.reconcile(), { settled: 0, attention: 0, unchanged: 0 });
  for (const jobId of jobs) await assert.rejects(broker.run({ projectId, jobId, owner: 'local-validation' }), /terminal/);
  assert.deepEqual(broker.read(projectId).jobs, before);
  console.log('PASS all five settled jobs survive reopen and refuse replay');
} finally {
  store.close();
  // The supervisor stops descendants, confirms container absence, then removes mounted roots.
}
