import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { ControlStore } from '../../src/server/state/control-store';
import { SessionRegistry, createSessionResourcePort } from '../../src/server/state/session-registry';
import { ApprovalStore } from '../../src/server/state/approval-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { QueueStore, type QueueSubmissionRecord } from '../../src/server/state/queue-store';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { FORK_ROOT_DIRECTORY, ForkStore, createForkWorktreePort, type ForkStoreOptions, type ForkTranscriptPort } from '../../src/server/state/fork-store';
import {
  FORK_CONTEXT_RULE, FORK_MAX_ENTRY_SCAN, FORK_MAX_FORKS, ForkError, createdForkRecord, forkContextEntries, forkDispatchRefusal,
  validateForkRecord, type ForkRecord
} from '../../src/shared/forks';
import { backup, verifyArchive } from '../../scripts/data-tools.mjs';
import type { Project } from '../../src/shared/model';

/**
 * Forks: a child transcript branched at a cutoff, a paused child, and a child worktree created from a
 * recorded commit.
 *
 * Everything here runs over a disposable root, a real disposable git repository and the application's
 * own harness with its synthetic scripted provider. No live project, no real planning document, no
 * network and no billed provider is touched: the harness this suite opens is the same one the server
 * opens, and its provider is the deterministic faux provider the build ships for exactly this purpose.
 */

const exec = promisify(execFile);
/** The passphrase the backup this suite drives is written with. It is never a real credential. */
const BACKUP_PASSPHRASE = 'a-sufficiently-long-backup-passphrase';
/** One git command with the environment the fork port itself uses: no system or global config, no prompt. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: '/nonexistent', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
  });
  return stdout.trim();
}
/** A real repository with one real base commit, and nothing else. */
async function initRepository(path: string, heading: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  await writeFile(join(path, 'README.md'), heading);
  await git(path, ['init', '-q']);
  await git(path, ['config', 'user.email', 'pilot@example.invalid']);
  await git(path, ['config', 'user.name', 'Pilot test']);
  await git(path, ['config', 'commit.gpgsign', 'false']);
  await git(path, ['add', '.']);
  await git(path, ['commit', '-q', '-m', 'base']);
  return await git(path, ['rev-parse', 'HEAD']);
}
async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}
async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('the condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function refusal(value: unknown): Promise<Error> {
  try { await value; } catch (error) { return error as Error; }
  throw new Error('expected a refusal, but the call succeeded');
}
async function forkRefusal(promise: unknown, code: ForkError['code']): Promise<string> {
  const error = await refusal(promise);
  if (!(error instanceof ForkError)) throw error;
  assert.equal(error.code, code);
  return error.message;
}

/** One project of the fixture, with the repository it forks from and the parent session a fork branches from. */
type Subject = { readonly project: Project; readonly repo: string; readonly baseCommit: string; readonly parentSessionId: string };

type Fixture = {
  root: string; data: string; repo: string; baseCommit: string; project: Project; parentSessionId: string;
  /** A second project of the same instance: one store serves both, exactly as the application does. */
  second: Subject;
  forkOptions: ForkStoreOptions;
  store: ControlStore; sessions: SessionRegistry; approvals: ApprovalStore; acceptance: AcceptanceStore;
  queue: QueueStore; queueClaims: string[]; agents: HarnessHost; forks: ForkStore; transcriptCalls: string[];
  cleanup(): Promise<void>;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-fork-'));
  const data = join(root, 'data'), workspaces = join(root, 'workspaces'), repo = join(workspaces, 'repo');
  await mkdir(data, { recursive: true, mode: 0o700 });
  // A real repository with a real base commit, and nothing else: the sentinel below is deliberately
  // left dirty, untracked and unstaged, so a fork that carried it would be caught.
  const baseCommit = await initRepository(repo, '# Base\n');
  const store = new ControlStore(data);
  const project: Project = { id: randomUUID(), name: 'Fork workspace', path: repo, managed: false, repository: '', created: new Date().toISOString() };
  // A second project of the same instance, with its own repository and its own fork root. One
  // ForkStore serves both projects, exactly as main.ts serves every project of an instance with one.
  const secondRepo = join(workspaces, 'repo-second');
  const secondBaseCommit = await initRepository(secondRepo, '# Second base\n');
  const secondProject: Project = { id: randomUUID(), name: 'Second fork workspace', path: secondRepo, managed: false, repository: '', created: new Date().toISOString() };
  const projects = new Map<string, Project>([[project.id, project], [secondProject.id, secondProject]]);
  /** The project one call names: a transcript call is always resolved to its own project. */
  const projectOf = (projectId: string): Project => {
    const found = projects.get(projectId);
    if (found === undefined) throw new Error('the fixture holds no project ' + projectId);
    return found;
  };
  const resources = createSessionResourcePort({
    browseRoots: [workspaces],
    project: (id) => { const found = projects.get(id); return found === undefined ? undefined : { id: found.id, path: found.path }; },
    taskIds: async () => [],
    documentServable: async () => false
  });
  const sessions = new SessionRegistry(store, resources);
  // Each parent is its project's own root conversation, adopted exactly as the legacy migration adopts it.
  const parentSessionId = String(ROOT_CONVERSATION_ID);
  await sessions.adopt({ projectId: project.id, sessionId: parentSessionId, name: 'Parent session', model: null, links: [] });
  const secondParentSessionId = String(ROOT_CONVERSATION_ID);
  await sessions.adopt({ projectId: secondProject.id, sessionId: secondParentSessionId, name: 'Second parent session', model: null, links: [] });
  const agents = new HarnessHost({ dataRoot: data, enabled: true, pauseMs: 0 });
  const transcriptCalls: string[] = [];
  // The production transcript path, wrapped so the suite can prove what was *not* called: no other
  // implementation of the cutoff rule is used anywhere in this file. Every call is resolved to the
  // project it names, so one store can be driven for two projects.
  const transcripts: ForkTranscriptPort = {
    parentSession: async ({ projectId, parentSessionId: parent }) => { transcriptCalls.push('parentSession'); return await agents.hasSession(projectOf(projectId), parent); },
    hasEntry: async ({ projectId, parentSessionId: parent, cutoffEntryId }) => { transcriptCalls.push('hasEntry'); return await agents.hasEntry(projectOf(projectId), parent, cutoffEntryId, FORK_MAX_ENTRY_SCAN); },
    fork: async ({ projectId, parentSessionId: parent, cutoffEntryId }) => { transcriptCalls.push('fork'); return await agents.forkTranscript(projectOf(projectId), parent, cutoffEntryId); },
    dispatch: async ({ projectId, childSessionId, requestId, text }) => { transcriptCalls.push('dispatch'); await agents.dispatchToSession(projectOf(projectId), childSessionId, { requestId, text }); }
  };
  const forkOptions: ForkStoreOptions = {
    projectFolder: (id) => projects.get(id)?.path,
    forkRootParent: join(data, FORK_ROOT_DIRECTORY),
    worktrees: createForkWorktreePort(),
    transcripts,
    sessions
  };
  const forks = new ForkStore(store, forkOptions);
  const approvals = new ApprovalStore(store);
  const acceptance = new AcceptanceStore(store, { projectRoot: (id) => (id === project.id ? repo : undefined) });
  // The queue's dispatcher is synthetic and counts its calls: nothing in this suite ever dispatches a
  // queued input, which is what "the child's queue is empty and the parent's is unclaimed by it" means.
  const queueClaims: string[] = [];
  const queue = new QueueStore(store, {
    authorise() { queueClaims.push('authorise'); },
    async submit({ requestId, entryId }): Promise<QueueSubmissionRecord> {
      queueClaims.push('submit:' + requestId);
      return { requestId, entryId, submissionId: 'submission-1', acceptedAt: new Date(0).toISOString() };
    }
  });
  return {
    root, data, repo, baseCommit, project, parentSessionId,
    second: { project: secondProject, repo: secondRepo, baseCommit: secondBaseCommit, parentSessionId: secondParentSessionId },
    forkOptions, store, sessions, approvals, acceptance, queue, queueClaims, agents, forks, transcriptCalls,
    cleanup: async () => { await agents.close(); store.close(); await rm(root, { recursive: true, force: true }); }
  };
}

/** One synthetic submission into one session, and the deterministic reply the scripted provider makes to it. */
async function submitTo(f: Fixture, subject: Pick<Subject, 'project' | 'parentSessionId'>, text: string): Promise<void> {
  await f.agents.submit(subject.project, { text, mode: 'followUp' });
  await waitFor(async () => {
    const view = await f.agents.sessionView(subject.project, subject.parentSessionId);
    if (view === null || view.working) return undefined;
    return view.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes(text)) ? view : undefined;
  });
}
/** One synthetic parent submission to the fixture's own project. */
async function parentSubmit(f: Fixture, text: string): Promise<void> {
  await submitTo(f, { project: f.project, parentSessionId: f.parentSessionId }, text);
}
/** The transcript of one session as this suite reads it: ids, in order, with their text. */
async function entriesOf(f: Fixture, subject: Pick<Subject, 'project' | 'parentSessionId'>): Promise<{ id: number; text: string }[]> {
  const view = await f.agents.sessionView(subject.project, subject.parentSessionId);
  assert.ok(view, 'the parent transcript must be readable');
  return view.entries.map((entry) => ({ id: Number(entry.id), text: entry.text }));
}
/** The parent transcript of the fixture's own project. */
async function parentEntries(f: Fixture): Promise<{ id: number; text: string }[]> {
  return await entriesOf(f, { project: f.project, parentSessionId: f.parentSessionId });
}
async function childEntries(f: Fixture, childSessionId: string): Promise<{ id: number; text: string }[]> {
  const view = await f.agents.sessionView(f.project, childSessionId);
  assert.ok(view, 'the child transcript must be readable');
  return view.entries.map((entry) => ({ id: Number(entry.id), text: entry.text }));
}
/** A fork of one project's parent at one cutoff, with every creation assertion this suite makes. */
async function createForkFor(f: Fixture, subject: Subject, cutoffEntryId: number, overrides: { target?: unknown; baseCommit?: string } = {}): Promise<ForkRecord> {
  const created = await f.forks.create({
    projectId: subject.project.id, parentSessionId: subject.parentSessionId,
    baseCommit: overrides.baseCommit ?? subject.baseCommit, cutoffEntryId, ...(overrides.target === undefined ? {} : { target: overrides.target })
  });
  assert.equal(created.created, true, 'the fixture fork was created');
  assert.equal(created.fork.state, 'paused', 'a child is created paused');
  assert.equal(created.fork.baseCommit, subject.baseCommit, 'the recorded base commit is the repository own commit');
  return created.fork;
}
/** A fork of the fixture's own project, which is also the first project of the fixture. */
async function createFork(f: Fixture, cutoffEntryId: number, overrides: { target?: unknown; baseCommit?: string } = {}): Promise<ForkRecord> {
  return await createForkFor(f, { project: f.project, repo: f.repo, baseCommit: f.baseCommit, parentSessionId: f.parentSessionId }, cutoffEntryId, overrides);
}

test('a fork record is strictly validated and every figure it refuses fails closed', () => {
  const base = {
    version: 1 as const, projectId: randomUUID(), parentSessionId: '1', cutoffEntryId: 4, childSessionId: '2',
    worktreePath: '/data/forks/project/2', baseCommit: 'a'.repeat(40), state: 'paused' as const, revision: 1,
    attention: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  const record = validateForkRecord(base);
  assert.deepEqual([record.state, record.revision, record.cutoffEntryId], ['paused', 1, 4]);
  // An unknown field is refused rather than ignored, so a stored record can never carry something the
  // model does not describe.
  assert.throws(() => validateForkRecord({ ...base, branch: 'work/pilot' }), (error: unknown) => error instanceof ForkError && error.code === 'INVALID');
  const { cutoffEntryId, ...withoutCutoff } = base;
  assert.throws(() => validateForkRecord(withoutCutoff), (error: unknown) => error instanceof ForkError && error.code === 'INVALID');
  // The attention field belongs to the failed state and to no other: a paused fork that carried a
  // reason would say it needs an operator while still being dispatchable-looking.
  assert.throws(() => validateForkRecord({ ...base, attention: { reason: 'worktree-dirty', detail: 'x' } }), (error: unknown) => error instanceof ForkError && error.code === 'INVALID');
  assert.throws(() => validateForkRecord({ ...base, state: 'failed' }), (error: unknown) => error instanceof ForkError && error.code === 'INVALID');
  // A fork cannot be its own parent, an unknown state is never interpreted, and a cutoff of zero is
  // not an entry of any transcript.
  assert.throws(() => validateForkRecord({ ...base, parentSessionId: '2' }), (error: unknown) => error instanceof ForkError && error.code === 'INVALID');
  assert.throws(() => validateForkRecord({ ...base, state: 'running' }), (error: unknown) => error instanceof ForkError && error.code === 'INVALID');
  assert.throws(() => validateForkRecord({ ...base, cutoffEntryId: 0 }), (error: unknown) => error instanceof ForkError && error.code === 'INVALID');
  // A base commit is a full lowercase commit id: an abbreviation, a branch name or an uppercase id is
  // refused so the record always names one immutable commit.
  for (const commit of ['a'.repeat(39), 'A'.repeat(40), 'HEAD', 'refs/heads/main']) {
    assert.throws(() => validateForkRecord({ ...base, baseCommit: commit }), (error: unknown) => error instanceof ForkError && error.code === 'INVALID', commit + ' is not a commit id');
  }
  // The context rule is one pure function: the cutoff is included and nothing after it is.
  const parent = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(forkContextEntries(parent, 3).map((entry) => entry.id), [1, 2, 3]);
  assert.deepEqual(forkContextEntries(parent, 5).map((entry) => entry.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(forkContextEntries(parent, 9), [], 'an entry the transcript does not hold yields no context, not a partial guess');
  assert.match(FORK_CONTEXT_RULE, /up to and including the cutoff entry/);
  assert.equal(forkDispatchRefusal({ ...record, state: 'active' }), null, 'only an active fork may be dispatched into');
  assert.match(String(forkDispatchRefusal(record)), /paused/);
  assert.match(String(forkDispatchRefusal({ ...record, state: 'discarded' })), /discarded/);
});

test('a fork branches the parent transcript at the cutoff and never past it', async () => {
  const f = await fixture();
  try {
    await parentSubmit(f, 'parent before the cutoff');
    const before = await parentEntries(f);
    const cutoff = before[before.length - 1].id;
    // Entries recorded *after* the cutoff, before the fork is created: this is what the child must not see.
    await parentSubmit(f, 'parent after the cutoff');
    const after = await parentEntries(f);
    assert.ok(after.length > before.length, 'the parent really recorded entries after the cutoff');
    const later = after.filter((entry) => entry.id > cutoff);
    assert.ok(later.some((entry) => entry.text.includes('parent after the cutoff')), 'the parent transcript holds the later entries');

    const fork = await createFork(f, cutoff);
    assert.equal(fork.cutoffEntryId, cutoff);
    assert.ok(f.transcriptCalls.includes('hasEntry'), 'the cutoff was checked against the real transcript before anything was created');
    const child = await childEntries(f, fork.childSessionId);
    assert.ok(child.some((entry) => entry.id === cutoff), 'the child sees the entry it branched at');
    assert.ok(child.some((entry) => entry.text.includes('parent before the cutoff')), 'the child sees the parent context up to the cutoff');
    assert.deepEqual(child.filter((entry) => entry.id > cutoff), [], 'the child holds no entry the parent recorded after the cutoff');
    assert.equal(child.some((entry) => entry.text.includes('parent after the cutoff')), false, 'nothing the parent recorded after the cutoff reached the child');
    // The parent is untouched by the fork: it still holds everything it recorded.
    const parentAgain = await parentEntries(f);
    assert.deepEqual(parentAgain.map((entry) => entry.id), after.map((entry) => entry.id), 'the fork wrote nothing into the parent transcript');
    // And the parent's queue is neither read nor claimed by the fork.
    assert.deepEqual(f.queueClaims, []);
  } finally { await f.cleanup(); }
});

test('the child worktree is created from the recorded commit and never carries the parent dirty state', async () => {
  const f = await fixture();
  try {
    // The sentinel: an untracked, unstaged file plus a staged change in the parent worktree, both left
    // exactly as they are. A fork that copied, stashed or inherited the working tree would carry them.
    const sentinel = join(f.repo, 'dirty-sentinel.txt');
    await writeFile(sentinel, 'parent only\n');
    await writeFile(join(f.repo, 'staged-only.txt'), 'staged in the parent\n');
    await git(f.repo, ['add', 'staged-only.txt']);
    const parentStatus = await git(f.repo, ['status', '--porcelain=v1', '--untracked-files=all']);
    assert.match(parentStatus, /dirty-sentinel\.txt/);
    assert.match(parentStatus, /staged-only\.txt/);
    await parentSubmit(f, 'parent before the cutoff');
    const entries = await parentEntries(f);
    const fork = await createFork(f, entries[entries.length - 1].id);

    assert.ok(await exists(fork.worktreePath), 'the child worktree exists at the path the record carries');
    assert.equal(await exists(join(fork.worktreePath, 'dirty-sentinel.txt')), false, 'the child worktree does not carry the parent untracked sentinel');
    assert.equal(await exists(join(fork.worktreePath, 'staged-only.txt')), false, 'the child worktree does not carry the parent staged change');
    assert.equal(await exists(join(fork.worktreePath, 'README.md')), true, 'the child worktree holds the recorded commit own tree');
    assert.equal(await readFile(sentinel, 'utf8'), 'parent only\n', 'the parent sentinel is untouched');
    assert.equal(await git(f.repo, ['status', '--porcelain=v1', '--untracked-files=all']), parentStatus, 'the parent worktree status is exactly what it was');
    assert.deepEqual(await git(f.repo, ['stash', 'list']), '', 'no stash was created anywhere');
    // The child is a real worktree of the parent repository, detached at the recorded base commit, and
    // it is clean: it inherited no dirty state at all.
    assert.equal(await git(fork.worktreePath, ['rev-parse', 'HEAD']), f.baseCommit, 'the child worktree is at the recorded base commit');
    assert.equal(await git(fork.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']), '', 'the child worktree is clean');
    // The parent's own checkout is untouched: the fork created no branch and moved nothing.
    assert.equal(await git(f.repo, ['rev-parse', 'HEAD']), f.baseCommit, 'the parent checkout still points at its own commit');
    assert.deepEqual((await readdir(join(f.data, FORK_ROOT_DIRECTORY, f.project.id))).sort(), [fork.childSessionId], 'the child lives inside the designated fork root');
  } finally { await f.cleanup(); }
});

test('one store keeps each project of an instance under its own fork root, whatever order they are used in', async () => {
  const f = await fixture();
  try {
    const dataRoot = await realpath(f.data);
    const rootA = join(dataRoot, FORK_ROOT_DIRECTORY, f.project.id);
    const rootB = join(dataRoot, FORK_ROOT_DIRECTORY, f.second.project.id);
    // The second project forks first. A store that cached one root for the whole store would hand its
    // root to the first project instead of letting that project resolve its own.
    await submitTo(f, f.second, 'second project parent before the cutoff');
    const entriesB = await entriesOf(f, f.second);
    const forkB = await createForkFor(f, f.second, entriesB[entriesB.length - 1].id);
    assert.equal(dirname(forkB.worktreePath), rootB, 'the second project child is under its own forks/<projectId> root');
    assert.equal(await exists(forkB.worktreePath), true, 'and that worktree really exists');

    // The first project now uses the same store, with an explicit target so the two worktrees are told
    // apart by name as well: this demonstration then does not depend on whether the two projects'
    // transcripts happen to produce the same child session id (each project has its own transcript).
    await parentSubmit(f, 'first project parent before the cutoff');
    const entriesA = await parentEntries(f);
    const forkA = await createFork(f, entriesA[entriesA.length - 1].id, { target: 'first-project-child' });
    assert.equal(dirname(forkA.worktreePath), rootA, 'the first project child is under its OWN root, not the one already cached');
    assert.equal(dirname(forkB.worktreePath), rootB, 'and the second project child is under its own root');
    assert.notEqual(forkA.worktreePath, forkB.worktreePath, 'the two projects share no worktree path, and so no root');
    assert.equal(forkA.worktreePath, join(rootA, 'first-project-child'));
    assert.equal(forkB.worktreePath, join(rootB, forkB.childSessionId));
    // The reproduction of the shared-cache bug, in both directions: the first project's child directory
    // is NOT under the second project's root — with one cached root, and the second project calling
    // root() first, it was created there — and the second project's child is not under the first's.
    assert.equal(await exists(join(rootB, 'first-project-child')), false, "the first project child is not under the second project root");
    assert.equal(await exists(join(rootA, forkB.childSessionId)), false, "the second project child is not under the first project root");
    // Each root holds exactly its own child.
    assert.deepEqual((await readdir(rootA)).sort(), ['first-project-child']);
    assert.deepEqual((await readdir(rootB)).sort(), [forkB.childSessionId]);
    // Each child is a real worktree of its own project repository, at its own recorded base commit.
    assert.equal(await git(forkA.worktreePath, ['rev-parse', 'HEAD']), f.baseCommit);
    assert.equal(await git(forkB.worktreePath, ['rev-parse', 'HEAD']), f.second.baseCommit);
    assert.equal(await git(f.repo, ['rev-parse', 'HEAD']), f.baseCommit, 'the first repository is untouched');
    assert.equal(await git(f.second.repo, ['rev-parse', 'HEAD']), f.second.baseCommit, 'the second repository is untouched');
    assert.equal(await readFile(join(f.second.repo, 'README.md'), 'utf8'), '# Second base\n');

    // A later fork of the project that resolved first still lands in that project own root: the cache
    // is per project, not one value per store.
    const forkB2 = await createForkFor(f, f.second, entriesB[entriesB.length - 1].id);
    assert.equal(dirname(forkB2.worktreePath), rootB);

    // A stored record is checked against the root its own project implies, not against a value one
    // store happens to hold: a fresh store over the same data root resolves the same roots, which is
    // what makes the check deterministic across restarts.
    const reopened = new ForkStore(f.store, f.forkOptions);
    assert.equal(reopened.read(f.project.id, forkA.childSessionId)!.worktreePath, forkA.worktreePath);
    assert.equal(reopened.read(f.second.project.id, forkB.childSessionId)!.worktreePath, forkB.worktreePath);
    const reopenedDiscard = await reopened.discard({ projectId: f.second.project.id, childSessionId: forkB2.childSessionId, revision: forkB2.revision });
    assert.deepEqual([reopenedDiscard.outcome, reopenedDiscard.removed, reopenedDiscard.fork.state], ['discarded', true, 'discarded'], 'a fresh store discards inside the same per-project root');

    // Discarding one project fork stays confined to that project root.
    const discardedA = await f.forks.discard({ projectId: f.project.id, childSessionId: forkA.childSessionId, revision: forkA.revision });
    assert.deepEqual([discardedA.outcome, discardedA.removed, discardedA.fork.state], ['discarded', true, 'discarded']);
    assert.equal(await exists(forkA.worktreePath), false, 'the discarded project worktree is gone');
    assert.deepEqual((await readdir(rootA)).sort(), [], 'the discarded project own root is empty');
    assert.equal(await exists(forkB.worktreePath), true, 'the other project worktree is untouched');
    assert.deepEqual((await readdir(rootB)).sort(), [forkB.childSessionId], 'the other project root is exactly as it was');
    assert.equal(f.forks.read(f.project.id, forkA.childSessionId)!.state, 'discarded');
    assert.equal(f.forks.read(f.second.project.id, forkB.childSessionId)!.state, 'paused', 'the other project fork record is untouched');
  } finally { await f.cleanup(); }
});

test('a paused child refuses to dispatch anything, and an explicit resume is what changes that', async () => {
  const f = await fixture();
  try {
    await parentSubmit(f, 'parent before the cutoff');
    const entries = await parentEntries(f);
    const fork = await createFork(f, entries[entries.length - 1].id);
    const before = await childEntries(f, fork.childSessionId);
    const callsBefore = [...f.transcriptCalls];

    // A dispatch attempt on a paused child is refused, and the transcript port was not reached at all —
    // so no submission, no admission and no model request of any kind could have happened.
    const message = await forkRefusal(f.forks.dispatchChild({ projectId: f.project.id, childSessionId: fork.childSessionId, text: 'never dispatched from a paused child' }), 'ILLEGAL');
    assert.match(message, /paused/);
    assert.deepEqual(f.transcriptCalls, callsBefore, 'a refused dispatch calls nothing at all');
    const after = await childEntries(f, fork.childSessionId);
    assert.deepEqual(after.map((entry) => entry.id), before.map((entry) => entry.id), 'the child transcript is unchanged');
    assert.equal((await f.agents.sessionView(f.project, fork.childSessionId))!.working, false, 'the child is not running');

    // The explicit resume lifts the pause, dispatches nothing, and grants nothing.
    const resumed = await f.forks.resume({ projectId: f.project.id, childSessionId: fork.childSessionId, revision: fork.revision });
    assert.deepEqual([resumed.outcome, resumed.fork.state, resumed.fork.revision], ['resumed', 'active', fork.revision + 1]);
    assert.deepEqual(f.transcriptCalls, callsBefore, 'a resume dispatches nothing');
    assert.equal((await f.forks.resume({ projectId: f.project.id, childSessionId: fork.childSessionId, revision: resumed.fork.revision })).outcome, 'unchanged', 'resuming an active fork is a legal no-op');
    assert.equal(f.forks.read(f.project.id, fork.childSessionId)!.revision, resumed.fork.revision, 'the no-op wrote no revision');

    // With the fork active the guarded dispatch really reaches the child, under a stable identity.
    const dispatched = await f.forks.dispatchChild({ projectId: f.project.id, childSessionId: fork.childSessionId, text: 'child work' });
    assert.equal(dispatched.requestId, 'fork:' + fork.childSessionId, 'the submission identity is derived from the fork alone');
    assert.ok(f.transcriptCalls.includes('dispatch'), 'the active fork really dispatched');
    const settled = await waitFor(async () => {
      const view = await f.agents.sessionView(f.project, fork.childSessionId);
      if (view === null || view.working) return undefined;
      return view.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('child work')) ? view : undefined;
    });
    assert.ok(settled.entries.length > before.length, 'the child really ran after its resume');
    // A discarded fork refuses to dispatch too, and a failed one needs an operator first.
    const discarded = await f.forks.discard({ projectId: f.project.id, childSessionId: fork.childSessionId, revision: resumed.fork.revision });
    assert.equal(discarded.fork.state, 'discarded');
    assert.match(await forkRefusal(f.forks.dispatchChild({ projectId: f.project.id, childSessionId: fork.childSessionId, text: 'after the discard' }), 'ILLEGAL'), /discarded/);
  } finally { await f.cleanup(); }
});

test('a fork inherits no approval, no accepted artifact, no grant and no queue', async () => {
  const f = await fixture();
  try {
    // Things the parent really holds, so "nothing was inherited" is a fact about a real state.
    f.approvals.create({
      kind: 'commit', scope: { projectId: f.project.id, sessionId: f.parentSessionId },
      target: { repository: 'origin', branch: 'main', treeDigest: 'a'.repeat(64) },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const evidence = await f.acceptance.recordEvidence({
      projectId: f.project.id,
      evidence: {
        sessionId: f.parentSessionId,
        subject: { kind: 'session', id: f.parentSessionId },
        artifact: { revision: 'b'.repeat(64), commit: null },
        commands: ['pnpm test'],
        diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: null, reference: 'docs/diff.patch' },
        tests: [{ command: 'pnpm test', outcome: 'passed', output: 'TAP version 13\n# tests 2\n# pass 2\n# fail 0\n# skipped 0', counts: { passed: 2, failed: 0, skipped: 0 } }],
        review: null,
        producedAt: new Date(Date.now() - 60_000).toISOString()
      }
    });
    const parentQueueBefore = await f.queue.append({ projectId: f.project.id, sessionId: f.parentSessionId, revision: 0, text: 'parent intent' });
    assert.equal(parentQueueBefore.record.revision, 1);

    await parentSubmit(f, 'parent before the cutoff');
    const entries = await parentEntries(f);
    const fork = await createFork(f, entries[entries.length - 1].id);
    const child = fork.childSessionId;

    // The child is a named session of the project with no link and no declared model: nothing was copied.
    const childSession = f.sessions.read(f.project.id, child);
    assert.deepEqual(childSession.links, [], 'the child session holds no link the parent held');
    assert.equal(childSession.model, null, 'the child declares no model of its own');
    assert.equal(childSession.name, 'Parent session fork ' + child, 'the child name says which session it branched from');

    // Approvals: the parent's is still pending, the child has none — an approval is target-bound and
    // single-use, so a fork cannot widen what the parent was granted.
    assert.equal(f.approvals.listPending({ projectId: f.project.id, sessionId: f.parentSessionId }).length, 1, 'the parent approval is untouched');
    assert.deepEqual(f.approvals.listPending({ projectId: f.project.id, sessionId: child }), [], 'the child holds no approval');
    assert.deepEqual(f.approvals.listPending({ projectId: f.project.id, sessionId: child }).map((record) => record.kind), [], 'and no kind of grant at all');

    // Accepted artifacts: exactly the parent's record exists, and the child has none.
    const view = await f.acceptance.readProject({ projectId: f.project.id });
    assert.deepEqual(view.evidence.map((entry) => entry.record.id), [evidence.evidence.record.id], 'the parent completion record is untouched');
    assert.equal(view.evidence.some((entry) => entry.record.subject.id === child), false, 'no accepted artifact names the child');
    assert.equal(view.evidence.some((entry) => entry.record.sessionId === child), false, 'and none is recorded under the child session');

    // The queue: the child reads empty at revision 0, and the parent's own queue is exactly as it was,
    // unclaimed by anything.
    const parentQueueAfter = f.queue.read(f.project.id, f.parentSessionId);
    assert.deepEqual([parentQueueAfter.revision, parentQueueAfter.entries.map((entry) => [entry.text, entry.state])], [1, [['parent intent', 'queued']]], 'the parent queue is untouched and unclaimed');
    const childQueue = f.queue.read(f.project.id, child);
    assert.deepEqual([childQueue.revision, childQueue.entries], [0, []], 'the child queue starts empty');
    assert.deepEqual(f.queueClaims, [], 'nothing claimed or submitted anything for either queue');
  } finally { await f.cleanup(); }
});

test('a discard refuses a dirty worktree, succeeds with an explicit force, and is target-bound', async () => {
  const f = await fixture();
  try {
    await parentSubmit(f, 'parent before the cutoff');
    const entries = await parentEntries(f);
    const fork = await createFork(f, entries[entries.length - 1].id);

    // A stale revision is a conflict that mutates nothing: the record and the worktree are untouched.
    const conflict = await forkRefusal(f.forks.discard({ projectId: f.project.id, childSessionId: fork.childSessionId, revision: fork.revision + 5 }), 'CONFLICT');
    assert.match(conflict, /revision/);
    assert.deepEqual([f.forks.read(f.project.id, fork.childSessionId)!.state, await exists(fork.worktreePath)], ['paused', true]);
    assert.ok(!conflict.includes(fork.worktreePath), 'a refusal never names a path');

    // A dirty child worktree is never removed implicitly: the fork becomes the named
    // operator-attention state and the worktree is left exactly where it is.
    const stray = join(fork.worktreePath, 'child-only.txt');
    await writeFile(stray, 'work only this worktree holds\n');
    const dirty = await f.forks.discard({ projectId: f.project.id, childSessionId: fork.childSessionId, revision: fork.revision });
    assert.deepEqual([dirty.outcome, dirty.removed, dirty.fork.state, dirty.fork.attention?.reason], ['attention', false, 'failed', 'worktree-dirty']);
    assert.equal(await exists(stray), true, 'the dirty worktree was not removed');
    assert.equal(await exists(fork.worktreePath), true);
    assert.equal(await readFile(stray, 'utf8'), 'work only this worktree holds\n');
    assert.equal(await git(f.repo, ['worktree', 'list']).then((listing) => listing.includes(fork.worktreePath)), true, 'git still has the worktree registered');
    // A failed fork cannot be resumed or dispatched into, and an operator resolves it by discarding.
    assert.match(await forkRefusal(f.forks.resume({ projectId: f.project.id, childSessionId: fork.childSessionId, revision: dirty.fork.revision }), 'ILLEGAL'), /failed/);
    assert.match(await forkRefusal(f.forks.dispatchChild({ projectId: f.project.id, childSessionId: fork.childSessionId, text: 'x' }), 'ILLEGAL'), /needs an operator/);

    // The explicit force is what removes it, at the revision the record now holds.
    const forced = await f.forks.discard({ projectId: f.project.id, childSessionId: fork.childSessionId, revision: dirty.fork.revision, force: true });
    assert.deepEqual([forced.outcome, forced.removed, forced.fork.state], ['discarded', true, 'discarded']);
    assert.equal(await exists(fork.worktreePath), false, 'the forced discard really removed the worktree');
    assert.equal(await git(f.repo, ['worktree', 'list']).then((listing) => listing.includes(fork.worktreePath)), false, 'git no longer has it registered');
    // A discarded fork is terminal: no resume, no dispatch, and the parent repository is intact.
    assert.match(await forkRefusal(f.forks.resume({ projectId: f.project.id, childSessionId: fork.childSessionId, revision: forced.fork.revision }), 'ILLEGAL'), /terminal/);
    assert.equal(await readFile(join(f.repo, 'README.md'), 'utf8'), '# Base\n');
    assert.deepEqual(f.forks.list(f.project.id), [], 'a discarded fork is not listed any more');
  } finally { await f.cleanup(); }
});

test('a worktree that is already gone completes the discard, and nothing outside the fork root is ever touched', async () => {
  const f = await fixture();
  try {
    await parentSubmit(f, 'parent before the cutoff');
    const entries = await parentEntries(f);
    const fork = await createFork(f, entries[entries.length - 1].id);
    await git(f.repo, ['worktree', 'remove', '--', fork.worktreePath]);
    const gone = await f.forks.discard({ projectId: f.project.id, childSessionId: fork.childSessionId, revision: fork.revision });
    assert.deepEqual([gone.outcome, gone.removed, gone.fork.state], ['discarded', false, 'discarded'], 'a worktree that is already gone is a completed discard that removed nothing');

    // A record whose worktree path is outside the designated fork root is refused as an escape, and the
    // path it names is not touched at all. The record is written the way the store writes one, so this
    // exercises the real decode path rather than a stub.
    const outsider = join(f.root, 'outside-the-fork-root');
    await mkdir(outsider, { recursive: true });
    await writeFile(join(outsider, 'keep.txt'), 'not a worktree\n');
    const rogue = createdForkRecord({
      projectId: f.project.id, parentSessionId: f.parentSessionId, cutoffEntryId: entries[entries.length - 1].id,
      childSessionId: '90001', worktreePath: outsider, baseCommit: f.baseCommit, now: new Date()
    });
    f.store.admit({
      scope: { projectId: f.project.id, sessionId: rogue.childSessionId },
      idempotencyKey: 'fork.r1', kind: 'session.fork', input: rogue,
      outbox: { kind: 'session.fork', payload: { version: 1, projectId: f.project.id, childSessionId: rogue.childSessionId, revision: 1 } }
    });
    const escape = await forkRefusal(f.forks.discard({ projectId: f.project.id, childSessionId: rogue.childSessionId, revision: 1, force: true }), 'OUTSIDE_ROOT');
    assert.ok(!escape.includes(outsider), 'the refusal names no path');
    assert.equal(await exists(join(outsider, 'keep.txt')), true, 'nothing outside the fork root was touched');
    assert.equal(f.forks.read(f.project.id, rogue.childSessionId)!.state, 'paused', 'an escape leaves the record unchanged');
  } finally { await f.cleanup(); }
});

test('every creation refusal fails closed before anything is created', async () => {
  const f = await fixture();
  try {
    await parentSubmit(f, 'parent before the cutoff');
    const entries = await parentEntries(f);
    const cutoff = entries[entries.length - 1].id;
    const root = join(f.data, FORK_ROOT_DIRECTORY, f.project.id);
    const nothingCreated = async (): Promise<void> => {
      assert.deepEqual(f.forks.list(f.project.id), [], 'no fork record was written');
      assert.deepEqual(await readdir(root).catch(() => []), [], 'no worktree directory was left behind');
    };

    // A base commit that is not a commit of this project's own repository.
    const message = await forkRefusal(f.forks.create({ projectId: f.project.id, parentSessionId: f.parentSessionId, baseCommit: 'f'.repeat(40), cutoffEntryId: cutoff }), 'INVALID');
    assert.ok(!message.includes(f.repo), 'the refusal names no path');
    await nothingCreated();
    // A cutoff the parent transcript does not hold.
    await forkRefusal(f.forks.create({ projectId: f.project.id, parentSessionId: f.parentSessionId, baseCommit: f.baseCommit, cutoffEntryId: 999_999 }), 'NOT_FOUND');
    await nothingCreated();
    // A parent session that is not a session of this project.
    await forkRefusal(f.forks.create({ projectId: f.project.id, parentSessionId: randomUUID(), baseCommit: f.baseCommit, cutoffEntryId: cutoff }), 'NOT_FOUND');
    await nothingCreated();
    // Every shape of target that could leave the designated fork root, and a target that something
    // already occupies. None of them creates anything, and none rewrites the target.
    for (const target of ['../escape', 'a/b', '/absolute', '..', '.hidden', 'x'.repeat(81)]) {
      await forkRefusal(f.forks.create({ projectId: f.project.id, parentSessionId: f.parentSessionId, baseCommit: f.baseCommit, cutoffEntryId: cutoff, target }), 'INVALID');
      await nothingCreated();
    }
    // A symlink inside the fork root is a real escape attempt: it is refused rather than followed.
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(f.root, 'outside-target'), 'outside\n');
    await exec('ln', ['-s', join(f.root, 'outside-target'), join(root, 'link')]);
    await forkRefusal(f.forks.create({ projectId: f.project.id, parentSessionId: f.parentSessionId, baseCommit: f.baseCommit, cutoffEntryId: cutoff, target: 'link' }), 'OUTSIDE_ROOT');
    assert.equal(await readFile(join(f.root, 'outside-target'), 'utf8'), 'outside\n', 'the symlink target was not touched');
    // A target that is already taken is refused rather than reused or removed.
    await mkdir(join(root, 'taken'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'taken', 'keep.txt'), 'someone else\n');
    await forkRefusal(f.forks.create({ projectId: f.project.id, parentSessionId: f.parentSessionId, baseCommit: f.baseCommit, cutoffEntryId: cutoff, target: 'taken' }), 'CONFLICT');
    assert.equal(await readFile(join(root, 'taken', 'keep.txt'), 'utf8'), 'someone else\n', 'the taken target was not touched');
    assert.deepEqual(f.forks.list(f.project.id), [], 'nothing was created by any of these refusals');
    // The fork root is documented as a bound, and a project at that bound is refused rather than
    // growing without limit.
    assert.deepEqual(f.forks.view(f.project.id).limits, { forks: FORK_MAX_FORKS, entryScan: FORK_MAX_ENTRY_SCAN, bytes: 65536 });
    assert.equal(f.forks.view(f.project.id).rules.cutoff, FORK_CONTEXT_RULE);
  } finally { await f.cleanup(); }
});

test('a project at its fork bound refuses another creation with nothing created', async () => {
  const f = await fixture();
  try {
    await parentSubmit(f, 'parent before the cutoff');
    const entries = await parentEntries(f);
    const cutoff = entries[entries.length - 1].id;
    for (let index = 0; index < FORK_MAX_FORKS; index += 1) await createFork(f, cutoff);
    assert.equal(f.forks.list(f.project.id).length, FORK_MAX_FORKS);
    const message = await forkRefusal(f.forks.create({ projectId: f.project.id, parentSessionId: f.parentSessionId, baseCommit: f.baseCommit, cutoffEntryId: cutoff }), 'BOUNDED');
    assert.match(message, new RegExp(String(FORK_MAX_FORKS)));
    assert.equal(f.forks.list(f.project.id).length, FORK_MAX_FORKS, 'the refusal created nothing');
    assert.deepEqual((await readdir(join(f.data, FORK_ROOT_DIRECTORY, f.project.id))).length, FORK_MAX_FORKS, 'and left no extra worktree');
  } finally { await f.cleanup(); }
});

test('a stored fork record that does not validate is corruption, never a record to interpret', async () => {
  const f = await fixture();
  try {
    await parentSubmit(f, 'parent before the cutoff');
    const entries = await parentEntries(f);
    const fork = await createFork(f, entries[entries.length - 1].id);
    assert.equal(f.forks.read(f.project.id, fork.childSessionId)!.childSessionId, fork.childSessionId, 'the record reads back exactly as it was written');
    // A row of the fork kind whose payload is not a fork record is refused as corruption, so no view
    // and no discard ever treats it as one.
    f.store.admit({
      scope: { projectId: f.project.id, sessionId: '90002' },
      idempotencyKey: 'fork.r1', kind: 'session.fork', input: { version: 1, surprise: true },
      outbox: { kind: 'session.fork', payload: { version: 1, projectId: f.project.id, childSessionId: '90002', revision: 1 } }
    });
    assert.throws(() => f.forks.list(f.project.id), (error: unknown) => error instanceof ForkError && error.code === 'CORRUPT');
    assert.throws(() => f.forks.read(f.project.id, '90002'), (error: unknown) => error instanceof ForkError && error.code === 'CORRUPT');
    assert.equal(f.forks.read(f.project.id, fork.childSessionId)!.state, 'paused', 'the sound record is still readable');
  } finally { await f.cleanup(); }
});

test('the child fork worktrees are a stated exclusion of a backup, never an entry it failed to recognise', async () => {
  const f = await fixture();
  try {
    await parentSubmit(f, 'parent before the cutoff');
    const entries = await parentEntries(f);
    const fork = await createFork(f, entries[entries.length - 1].id);
    assert.equal(await exists(join(fork.worktreePath, 'README.md')), true, 'a real child worktree exists inside the data root this backup reads');
    // A positive control for the exclusion below: a file written directly into the excluded fork root,
    // outside any child worktree, means that directory genuinely holds files a walk would otherwise
    // reach — so its absence from the archive is the exclusion's own effect and not an empty directory.
    await writeFile(join(f.data, FORK_ROOT_DIRECTORY, 'positive-control.txt'), 'never captured\n');
    // A data root is a Pilot root because it carries a version-1 catalog: the registry a backup reads.
    await writeFile(join(f.data, 'catalog.json'), JSON.stringify({ version: 1, projects: [] }) + '\n');
    const archive = join(f.root, 'pilot-fork-backup.pbkp');
    const manifest = await backup(f.data, archive, { passphrase: BACKUP_PASSPHRASE });
    // The fork directory is a named exclusion with a reason of its own, so it never reaches the branch
    // that reports an entry this tool failed to recognise.
    const exclusion = manifest.excluded.find((entry: { path: string; reason: string }) => entry.path === 'forks/');
    assert.ok(exclusion, 'the fork directory is a stated exclusion, not an unlisted entry');
    assert.equal(exclusion.reason.startsWith('not captured by this tool'), false, 'it is named with its own reason rather than reported as an unrecognised entry');
    assert.match(exclusion.reason, /derived/);
    assert.match(exclusion.reason, /forks\/<projectId>\/<childSessionId>/, 'the reason names the directory the worktrees live in');
    // Nothing inside the fork root is captured, and the fork records themselves are, in the control store.
    assert.equal(manifest.files.some((file: { path: string }) => file.path.startsWith('forks')), false, 'no fork worktree file is captured under forks/');
    assert.equal(manifest.files.some((file: { path: string }) => file.path === 'control.sqlite'), true, 'the fork records themselves are captured in the control store');
    // No captured path names a child worktree. A child session id is Pi Durable's own conversation id,
    // which is a short number ('12' in this fixture), so the check is a whole path component and the
    // child's own archive-relative prefix — never a substring of any captured path. A substring test
    // would match `agents/<projectId>/session.sqlite` whenever the project's random UUID happened to
    // contain those digits, which is a property of the fixture's UUID rather than of the capture.
    const worktreePrefix = join(FORK_ROOT_DIRECTORY, f.project.id, fork.childSessionId);
    assert.equal(fork.worktreePath.endsWith('/' + worktreePrefix), true, 'the child worktree really is at the archive-relative path this assertion is about');
    assert.equal(manifest.files.some((file: { path: string }) => file.path.split('/').includes(fork.childSessionId)), false, 'and no captured path names the child worktree directory');
    assert.equal(manifest.files.some((file: { path: string }) => file.path === worktreePrefix || file.path.startsWith(worktreePrefix + '/')), false, 'and no captured path is inside the child worktree');
    // The archive manifest inside the archive states the same exclusion, so a restore reads it too:
    // verifying the archive writes nothing at all.
    const verified = await verifyArchive(archive, { passphrase: BACKUP_PASSPHRASE });
    const archived = verified.excluded.find((entry: { path: string; reason: string }) => entry.path === 'forks/');
    assert.ok(archived, 'the archive own manifest names the fork directory as an excluded entry');
    assert.equal(archived.reason, exclusion.reason, 'with the reason this run reported');
    assert.equal(verified.excluded.filter((entry: { path: string }) => entry.path.replace(/\/$/, '') === 'forks').length, 1, 'and it is named exactly once, as an exclusion');
    // The backup neither moves nor removes a child worktree.
    assert.equal(await exists(fork.worktreePath), true, 'the child worktree is still there after the backup');
    assert.equal(f.forks.read(f.project.id, fork.childSessionId)!.state, 'paused', 'and its record is unchanged');
  } finally { await f.cleanup(); }
});

