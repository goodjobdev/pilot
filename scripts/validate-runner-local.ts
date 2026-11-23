// Explicit, supervised local acceptance check. No default test invokes this file.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLocalSelection, verifySocket, remainingTimeout, allocatedNames, cleanupContainers } from './runner-validation-safety';
const exec = promisify(execFile);
const start = Date.now(), workDeadline = start + 60_000, cleanupDeadline = start + 85_000;
let evidenceRoot: string | undefined;
const totalTimer = setTimeout(() => {
  console.error('85-second total deadline reached; cleanup is incomplete. Retained evidence: ' + (evidenceRoot ?? 'no root allocated'));
  process.exit(1);
}, 85_000);
totalTimer.unref();
const socket = process.env.PILOT_VALIDATE_DOCKER_SOCKET;
if (!socket || !process.env.PILOT_VALIDATE_RUNNER_IMAGE) throw Error('Explicit PILOT_VALIDATE_DOCKER_SOCKET and PILOT_VALIDATE_RUNNER_IMAGE are required');
// These read-only calls use the operator's configuration. Nothing is allocated before selection checks.
const context = JSON.parse((await exec('docker', ['context', 'inspect'], { timeout: remainingTimeout(workDeadline), maxBuffer: 65536 })).stdout)[0];
const endpoint = checkLocalSelection(socket, context.Endpoints?.docker?.Host, process.env, context.TLSMaterial);
const canonicalSocket = await verifySocket(socket);
const env = { ...process.env };
// The selected endpoint already matches. Remove only routing aliases; keep DOCKER_CONFIG and security configuration.
delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST;
const direct = async (deadline: number, ...args: string[]) => {
  if (await verifySocket(socket) !== canonicalSocket) throw Error('Approved socket changed');
  return (await exec('docker', ['--host', endpoint, ...args], { env, timeout: remainingTimeout(deadline), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })).stdout;
};
await direct(workDeadline, 'version', '--format', '{{.Server.Version}}');
await direct(workDeadline, 'image', 'inspect', process.env.PILOT_VALIDATE_RUNNER_IMAGE, '--format', '{{.Id}}');
console.log('PASS selected context and environment match verified local socket; all execution uses explicit --host');
let earlyTermination = false;
const deferTermination = () => { earlyTermination = true; };
process.on('SIGTERM', deferTermination); process.on('SIGINT', deferTermination);
const root = await mkdtemp(join(tmpdir(), 'pilot-runner-acceptance-'));
evidenceRoot = root;
await chmod(root, 0o755);
const ledger = join(root, 'containers.json'), wrapper = join(root, 'local-docker');
await writeFile(ledger, '[]');
// This executable is also the broker's only Docker binary. It retains the user's Docker config.
await writeFile(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst fs=require('node:fs');\nconst env={...process.env};delete env.DOCKER_CONTEXT;delete env.DOCKER_HOST;\ntry { if(!fs.statSync(${JSON.stringify(socket)}).isSocket() || fs.realpathSync(${JSON.stringify(socket)})!==${JSON.stringify(canonicalSocket)})throw Error('Socket changed'); }catch(e){console.error('Local socket verification failed');process.exit(1)}\nconst remaining=${workDeadline}-Date.now();if(remaining<=0)process.exit(124);\nconst result=spawnSync('docker',['--host',${JSON.stringify(endpoint)},...process.argv.slice(2)],{env,stdio:'inherit',timeout:Math.min(20000,remaining),killSignal:'SIGKILL'});process.exit(result.status??1);\n`, { mode: 0o755 });
if (earlyTermination) {
  await rm(root, { recursive: true });
  console.error('Termination requested before worker execution; invocation roots removed');
  process.exit(1);
}
let stopped = false, failed = false, reason: string | undefined;
const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL('./validate-runner-worker.ts', import.meta.url))], {
  detached: true, stdio: 'inherit', env: { ...env, PILOT_VALIDATION_ROOT: root, PILOT_VALIDATION_DOCKER: wrapper, PILOT_VALIDATION_DEADLINE: String(workDeadline) }
});
const stop = (why: string) => {
  if (stopped) return;
  stopped = true; reason = why;
  // Stop the whole invocation group, including Docker clients, before cleanup starts.
  try { process.kill(-child.pid!, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
};
const onTerm = () => { failed = true; stop('Termination requested'); };
process.on('SIGTERM', onTerm); process.on('SIGINT', onTerm);
process.removeListener('SIGTERM', deferTermination); process.removeListener('SIGINT', deferTermination);
const timer = setTimeout(() => stop('60-second work deadline reached'), Math.max(1, workDeadline - Date.now()));
try {
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  if (code !== 0 || reason) { failed = true; console.error(reason ?? 'Acceptance worker failed'); }
} finally {
  clearTimeout(timer);
  // Eliminate any descendant clients even when the worker exited after an assertion failure.
  try { process.kill(-child.pid!, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  try {
    const names = allocatedNames(JSON.parse(await readFile(ledger, 'utf8')));
    const result = await cleanupContainers(names, (...args) => direct(cleanupDeadline, ...args));
    console.log(`CLEANUP confirmed ${result.absent} allocated containers absent; ${result.removalRefusals} removal calls refused (absence confirmed)`);
    await rm(root, { recursive: true });
    console.log('CLEANUP removed invocation roots');
  } catch (error) {
    failed = true;
    console.error('CLEANUP FAILED: ' + (error as Error).message);
    console.error('Retained invocation ledger and mounted roots at: ' + root);
  }
  process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onTerm);
  clearTimeout(totalTimer);
}
if (failed) process.exitCode = 1;
