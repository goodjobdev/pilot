#!/usr/bin/env node
/**
 * Read-only host preflight for the proposed separate local runner service.
 *
 * This collects facts an operator must verify on the target Linux host before any runner service is
 * installed. It changes nothing: it reads kernel, cgroup, namespace, seccomp and directory metadata
 * and prints a report. A passing report means "these particular facts were observed", not that the
 * service is isolated, authenticated, or safe. It cannot prove cgroup enforcement for a workload that
 * does not exist yet, descendant termination, peer credentials on a socket, ACLs without the tools to
 * read them, or that the host is not compromised.
 *
 * Usage:
 *   node scripts/runner-host-preflight.mjs [--expect-runner-uid N] [--expect-app-uid N]
 *                                          [--socket-parent DIR]
 *
 * Exit codes: 0 every required fact observed; 1 a required fact is missing or unproven;
 *             2 unsupported platform (not Linux).
 */
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(1);
  }
  return value;
};
const uid = (name) => {
  const raw = option(name);
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    console.error(`${name} must be a decimal UID`);
    process.exit(1);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 0xffffffff) {
    console.error(`${name} is outside the Linux UID range`);
    process.exit(1);
  }
  return value;
};

if (process.platform !== 'linux') {
  console.log(JSON.stringify({
    platform: process.platform,
    supported: false,
    reason: 'This preflight reads Linux kernel, cgroup and namespace state. It does not apply here, so nothing was checked and nothing passes.'
  }, null, 2));
  process.exit(2);
}

const checks = [];
const record = (id, required, status, detail) => checks.push({ id, required, status, detail });
const read = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
};

record('kernel', true, 'observed', read('/proc/sys/kernel/osrelease') ?? 'unreadable');

const controllers = read('/sys/fs/cgroup/cgroup.controllers');
if (controllers === null || controllers === undefined) {
  record('cgroup-v2', true, 'missing', 'No cgroup v2 hierarchy at /sys/fs/cgroup (cgroup.controllers is absent). Container or hybrid setup must be replaced before this design applies.');
} else {
  record('cgroup-v2', true, 'observed', `available controllers: ${controllers || '(none)'}`);
  for (const controller of ['cpu', 'memory', 'pids']) {
    record(`controller-${controller}`, true, controllers.split(/\s+/).includes(controller) ? 'observed' : 'missing',
      `The design requires the ${controller} controller to be available and delegated; availability alone does not enforce a limit.`);
  }
  record('controller-io', false, controllers.split(/\s+/).includes('io') ? 'observed' : 'missing',
    'Block-I/O ceilings are required only where the runtime supports them.');
  const subtree = read('/sys/fs/cgroup/cgroup.subtree_control');
  record('subtree-control', false, subtree === undefined ? 'unreadable' : 'observed',
    `cgroup.subtree_control: ${subtree ?? 'unreadable'}. Delegation for a service account must be verified by the operator; this script cannot change or prove it.`);
  try {
    accessSync('/sys/fs/cgroup', constants.W_OK);
    record('cgroup-writable-by-this-user', false, 'observed',
      'This principal can write the cgroup root. That is broader authority than the proposed service account should have; reviews must confirm which principal owns delegation.');
  } catch {
    record('cgroup-writable-by-this-user', false, 'denied', 'This principal cannot write /sys/fs/cgroup directly.');
  }
}

const maxUserNamespaces = read('/proc/sys/user/max_user_namespaces');
const userNamespaceClones = maxUserNamespaces === undefined ? undefined : Number(maxUserNamespaces);
record('user-namespaces', true,
  userNamespaceClones !== undefined && Number.isFinite(userNamespaceClones) && userNamespaceClones > 0 ? 'observed' : 'missing',
  `user.max_user_namespaces = ${maxUserNamespaces ?? 'unreadable'}; a positive value permits namespaces, it does not make them a sandbox.`);

const seccompActions = read('/proc/sys/kernel/seccomp/actions_avail');
record('seccomp', true,
  seccompActions !== undefined && /(errno|kill)/.test(seccompActions) ? 'observed' : 'missing',
  `seccomp actions available: ${seccompActions ?? 'unreadable'}. A syscall filter must still be applied per job and verified.`);

let lsm = '';
try {
  lsm = read('/sys/kernel/security/lsm') ?? '';
} catch {
  lsm = '';
}
record('lsm', false, lsm ? 'observed' : 'unreadable',
  `active LSMs: ${lsm || 'unreadable'}; the design requires a selected LSM policy, which this script does not verify.`);

const me = userInfo();
record('current-principal', true, 'observed', `this preflight runs as uid ${me.uid} gid ${me.gid}`);
const runnerUid = uid('--expect-runner-uid');
const appUid = uid('--expect-app-uid');
if (runnerUid === undefined || appUid === undefined) {
  record('principal-separation', true, 'unproven',
    'Pass --expect-runner-uid and --expect-app-uid. Without both, separation of the service principal from the application principal is not checked at all.');
} else {
  const distinct = runnerUid !== appUid && runnerUid !== 0 && appUid !== 0;
  record('principal-separation', true, distinct ? 'observed' : 'failed',
    distinct
      ? `configured runner uid ${runnerUid} and application uid ${appUid} differ and neither is root; this is configuration, not proof that the processes run as those UIDs.`
      : `runner uid ${runnerUid} and application uid ${appUid} must differ and must not be 0.`);
}

const socketParent = option('--socket-parent');
if (socketParent === undefined) {
  record('socket-parent', false, 'unchecked', 'Pass --socket-parent to inspect the directory that would hold the runner socket.');
} else {
  try {
    const info = statSync(socketParent);
    if (!info.isDirectory()) {
      record('socket-parent', true, 'failed', `${socketParent} is not a directory.`);
    } else {
      const worldWritable = (info.mode & 0o002) !== 0;
      const groupWritable = (info.mode & 0o020) !== 0;
      record('socket-parent', true, worldWritable ? 'failed' : 'observed',
        `${socketParent}: owner uid ${info.uid}, mode ${(info.mode & 0o777).toString(8)}${groupWritable ? ', group-writable' : ''}. A world-writable parent lets any local principal create the socket path first. POSIX mode bits do not show ACLs: read them with the host's ACL tools before trusting this directory.`);
    }
  } catch {
    record('socket-parent', true, 'failed', `${socketParent} cannot be inspected.`);
  }
}

let listening = 'unknown';
try {
  listening = readdirSync('/proc/self/fd').length > 0 ? 'readable' : 'readable';
} catch {
  listening = 'unreadable';
}
record('self-fd', false, listening, 'Reading /proc/self/fd succeeded or failed; it says nothing about peer credentials on an accepted socket.');

const failed = checks.filter((check) => check.required && check.status !== 'observed');
console.log(JSON.stringify({
  platform: 'linux',
  supported: true,
  conclusion: failed.length === 0
    ? 'Every required fact this script can observe was observed. This is not a security approval: peer authentication, cgroup enforcement, descendant termination, provenance and recovery remain unverified.'
    : 'Required facts are missing or unproven: ' + failed.map((check) => check.id).join(', ') + '. Do not install the runner service on this host in this state.',
  checks
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
