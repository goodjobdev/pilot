import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { FILE_EDIT_MAX_DIFF_BYTES, FILE_EDIT_MAX_FILE_BYTES, FileEditError, FileEditTool, unifiedDiff, type FileEditMode } from '../../src/server/state/file-edit-tool';

/**
 * The bounded file-edit capability: containment, the size caps, the two modes and the durable record.
 *
 * Everything here runs over a disposable root with its own control store, its own worktree and its own
 * data root. Nothing reads or writes a live project, a real planning document or a provider, and no
 * model call is made.
 */

const OWNER = Object.freeze({ kind: 'owner' as const, identity: 'owner' });

async function fixture(mode: FileEditMode = 'propose-only', enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-file-edit-'));
  const worktree = join(root, 'worktree'), outside = join(root, 'outside'), dataRoot = join(root, 'data');
  await mkdir(join(worktree, 'src'), { recursive: true, mode: 0o755 });
  await mkdir(join(worktree, 'node_modules'), { recursive: true, mode: 0o755 });
  await mkdir(outside, { recursive: true, mode: 0o755 });
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(worktree, 'src', 'index.ts'), 'export const one = 1;\nexport const two = 2;\n');
  const store = new ControlStore(dataRoot);
  const projectId = randomUUID();
  const tool = new FileEditTool(store, {
    enabled,
    projectRoot: (id) => (id === projectId ? worktree : undefined),
    dataRoot,
    policy: { mode: () => mode }
  });
  return {
    root, worktree, outside, dataRoot, store, projectId, tool,
    edit: (over: Record<string, unknown> = {}) => tool.edit({
      projectId, agentId: null, path: 'src/index.ts', content: 'export const one = 1;\nexport const two = 3;\n', actor: OWNER, ...over
    }),
    cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); }
  };
}
async function refused(work: () => Promise<unknown>, code: FileEditError['code']): Promise<string> {
  try { await work(); } catch (error) {
    assert.ok(error instanceof FileEditError, 'the refusal is the tool own: ' + String(error));
    assert.equal(error.code, code, error.message);
    return error.message;
  }
  throw new Error('expected a refusal, but the call succeeded');
}
const exists = async (path: string): Promise<boolean> => stat(path).then(() => true).catch(() => false);

test('propose-only is the default: it records the change and its diff and writes no file at all', async () => {
  const f = await fixture('propose-only');
  try {
    assert.equal(await f.tool.mode(), 'propose-only', 'the mode comes from the policy, and the default policy is propose-only');
    const outcome = await f.edit();
    assert.equal(outcome.written, false);
    assert.equal(outcome.record.mode, 'propose-only');
    assert.equal(outcome.record.applied, false);
    assert.equal(outcome.record.path, 'src/index.ts');
    assert.equal(outcome.record.agentId, null);
    assert.deepEqual(outcome.record.changedBy, OWNER);
    assert.ok(outcome.record.diff.includes('-export const two = 2;'), outcome.record.diff);
    assert.ok(outcome.record.diff.includes('+export const two = 3;'), outcome.record.diff);
    assert.ok(outcome.record.diffBytes > 0 && !outcome.record.diffTruncated);
    // Nothing was written: the file still holds exactly what it held.
    assert.equal(await readFile(join(f.worktree, 'src', 'index.ts'), 'utf8'), 'export const one = 1;\nexport const two = 2;\n');
    // The record is durable and readable through the read side, with the mode in force.
    const view = await f.tool.view(f.projectId);
    assert.deepEqual([view.enabled, view.mode, view.edits.length, view.truncated], [true, 'propose-only', 1, false]);
    assert.equal(view.edits[0].id, outcome.record.id);
    assert.equal(view.edits[0].diff, outcome.record.diff);
    // A change to a file that does not exist yet is recorded the same way and still writes nothing.
    const created = await f.edit({ path: 'src/new.ts', content: 'export const three = 3;\n' });
    assert.equal(created.record.created, true);
    assert.equal(created.written, false);
    assert.equal(await exists(join(f.worktree, 'src', 'new.ts')), false);
    // The same change again is the same record: one record, not two.
    const again = await f.edit();
    assert.equal(again.record.id, outcome.record.id);
    assert.equal((await f.tool.view(f.projectId)).edits.length, 2);
  } finally { await f.cleanup(); }
});

test('auto-apply writes the file atomically and records the same diff, and only a policy that permits it allows it', async () => {
  const f = await fixture('auto-apply');
  try {
    assert.equal(await f.tool.mode(), 'auto-apply');
    const outcome = await f.edit();
    assert.equal(outcome.written, true);
    assert.equal(outcome.record.applied, true);
    assert.equal(await readFile(join(f.worktree, 'src', 'index.ts'), 'utf8'), 'export const one = 1;\nexport const two = 3;\n');
    assert.ok(outcome.record.diff.includes('+export const two = 3;'));
    // The diff is computed against what the file really held, so a second change diffs from the first.
    const second = await f.edit({ content: 'export const one = 1;\nexport const two = 4;\n' });
    assert.ok(second.record.diff.includes('-export const two = 3;'));
    assert.ok(second.record.diff.includes('+export const two = 4;'));
    assert.equal(await readFile(join(f.worktree, 'src', 'index.ts'), 'utf8'), 'export const one = 1;\nexport const two = 4;\n');

    // A policy that is propose-only refuses an explicit auto-apply rather than applying it.
    const narrow = await fixture('propose-only');
    try {
      const message = await refused(() => narrow.edit({ mode: 'auto-apply' }), 'NOT_PERMITTED');
      assert.match(message, /Auto-apply is not the mode in force/);
      assert.match(message, /the acceptance policy in force is propose-only/);
      assert.equal(await readFile(join(narrow.worktree, 'src', 'index.ts'), 'utf8'), 'export const one = 1;\nexport const two = 2;\n', 'a refused auto-apply wrote nothing');
      assert.deepEqual((await narrow.tool.view(narrow.projectId)).edits, [], 'a refused auto-apply recorded nothing either');
      // Propose-only is always permitted, whatever the policy says.
      assert.equal((await narrow.edit({ mode: 'propose-only' })).written, false);
      // An unknown mode is refused.
      await refused(() => narrow.edit({ mode: 'write' as FileEditMode }), 'INVALID');
    } finally { await narrow.cleanup(); }
  } finally { await f.cleanup(); }
});

test('containment: traversal, an absolute path, a backslash, a symlink at any component and a generated directory are all refused with nothing written', async () => {
  const f = await fixture('auto-apply');
  try {
    // An absolute path, a parent segment, a backslash and an empty segment are refused by the helper.
    for (const path of ['/etc/passwd', '../outside/secret.txt', 'src/../../outside/secret.txt', 'src\\index.ts', 'src//index.ts', './src/index.ts']) {
      const message = await refused(() => f.edit({ path }), 'OUTSIDE_WORKTREE');
      assert.match(message, /refused/, path);
    }
    // An empty path is not a path at all.
    await refused(() => f.edit({ path: '' }), 'INVALID');
    // A symlink at a parent component is refused: the helper never follows one.
    await symlink(f.outside, join(f.worktree, 'escape'));
    await refused(() => f.edit({ path: 'escape/secret.txt' }), 'OUTSIDE_WORKTREE');
    assert.equal(await exists(join(f.outside, 'secret.txt')), false, 'nothing was written through the symlink');
    // A symlink at the final component is refused too.
    await symlink(join(f.outside, 'secret.txt'), join(f.worktree, 'src', 'link.ts'));
    await refused(() => f.edit({ path: 'src/link.ts' }), 'OUTSIDE_WORKTREE');
    assert.equal(await exists(join(f.outside, 'secret.txt')), false, 'nothing was written through the final symlink');
    // A generated or app-managed directory is refused: it is an output, not a source.
    const generated = await refused(() => f.edit({ path: 'node_modules/thing/index.js', content: 'x' }), 'OUTSIDE_WORKTREE');
    assert.match(generated, /generated or app-managed directory/);
    assert.equal(await exists(join(f.worktree, 'node_modules', 'thing')), false);
    // The worktree root itself is not a file, and a directory is not a file.
    await refused(() => f.edit({ path: 'src' }), 'INVALID');
    // Every one of those refusals wrote nothing at all.
    assert.deepEqual((await f.tool.view(f.projectId)).edits, []);
    assert.equal(await readFile(join(f.worktree, 'src', 'index.ts'), 'utf8'), 'export const one = 1;\nexport const two = 2;\n');
  } finally { await f.cleanup(); }
});

test('the size caps are refused, never truncated, and a project with no connected worktree is refused', async () => {
  const f = await fixture('auto-apply');
  try {
    const oversize = await refused(() => f.edit({ content: 'x'.repeat(FILE_EDIT_MAX_FILE_BYTES + 1) }), 'BOUNDED');
    assert.match(oversize, /over the 262144-byte cap/);
    assert.equal(await readFile(join(f.worktree, 'src', 'index.ts'), 'utf8'), 'export const one = 1;\nexport const two = 2;\n');
    // A file already over the cap is refused rather than rewritten.
    await writeFile(join(f.worktree, 'big.txt'), 'y'.repeat(FILE_EDIT_MAX_FILE_BYTES + 1));
    const already = await refused(() => f.edit({ path: 'big.txt', content: 'small' }), 'BOUNDED');
    assert.match(already, /already over the 262144-byte cap/);
    // A project this instance cannot resolve to a connected worktree is refused before anything is read.
    await refused(() => f.edit({ projectId: randomUUID() }), 'NOT_FOUND');
    // A path inside the application data root is refused even where a caller resolved it there.
    const inData = await refused(() => f.edit({ path: '..\\/data/x.txt'.replace('\\/', '/') }), 'OUTSIDE_WORKTREE');
    assert.match(inData, /refused/);
    assert.deepEqual((await f.tool.view(f.projectId)).edits, []);
  } finally { await f.cleanup(); }
});

test('the tool is disabled by default, and a disabled tool refuses everything and records nothing', async () => {
  const f = await fixture('auto-apply', false);
  try {
    assert.equal(f.tool.enabled, false);
    const message = await refused(() => f.edit(), 'UNAVAILABLE');
    assert.match(message, /disabled on this instance/);
    assert.equal(await readFile(join(f.worktree, 'src', 'index.ts'), 'utf8'), 'export const one = 1;\nexport const two = 2;\n');
    assert.deepEqual((await f.tool.view(f.projectId)).edits, []);
    // The read side still reports the switch and the mode in force, which is how the interface knows.
    const view = await f.tool.view(f.projectId);
    assert.deepEqual([view.enabled, view.mode], [false, 'auto-apply']);
  } finally { await f.cleanup(); }
});

test('a large change produces a bounded, deterministic diff rather than a large record', () => {
  // The same pair of texts always produces the same diff.
  const before = 'a\nb\nc\n', after = 'a\nB\nc\n';
  assert.equal(unifiedDiff(before, after).text, unifiedDiff(before, after).text);
  assert.equal(unifiedDiff(before, after).truncated, false);
  assert.match(unifiedDiff(before, after).text, /-b\n\+B/);
  // A hunk header states the real line positions on each side, not a position in the op list: an
  // inserted line shifts the after side, and the header says so.
  assert.match(unifiedDiff('a\nb\nc\nd\ne\n', 'a\nb\nC\nd\ne\n').text, /@@ -1,5 \+1,5 @@/);
  assert.match(unifiedDiff('a\nb\nc\n', 'a\nX\nb\nc\n').text, /@@ -1,3 \+1,4 @@/);
  // A file longer than the lines this build diffs becomes a stated summary rather than a walk.
  const long = Array.from({ length: 900 }, (_, index) => 'line ' + index).join('\n');
  const summary = unifiedDiff(long, long + '\nline 900');
  assert.match(summary.text, /--- summary/);
  assert.match(summary.text, /lines before: 900/);
  // A diff over the byte cap is truncated with the truncation stated in the text.
  const huge = unifiedDiff('', Array.from({ length: 800 }, (_, index) => 'z'.repeat(60) + index).join('\n'));
  assert.equal(huge.truncated, true);
  assert.ok(huge.text.length <= FILE_EDIT_MAX_DIFF_BYTES + 64);
  assert.match(huge.text, /\[diff truncated at 32768 bytes\]/);
});

test('the record names the agent when an agent made the change, and every edit is one durable operation', async () => {
  const f = await fixture('propose-only');
  try {
    const agentId = randomUUID();
    const outcome = await f.edit({ agentId, actor: { kind: 'agent', identity: agentId } });
    assert.equal(outcome.record.agentId, agentId);
    assert.deepEqual(outcome.record.changedBy, { kind: 'agent', identity: agentId });
    // One operation per recorded change, with the outbox as its evidence, and nothing else.
    const rows = f.store.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='agent.file-edit'").get() as { n: number };
    assert.equal(rows.n, 1);
    const outboxes = f.store.db.prepare("SELECT count(*) AS n FROM outboxes WHERE kind='agent.file-edit-record'").get() as { n: number };
    assert.equal(outboxes.n, 1);
    // A malformed request is refused by name and writes nothing.
    await refused(() => f.edit({ agentId: 'not a valid id' }), 'INVALID');
    await refused(() => f.edit({ content: 42 as unknown as string }), 'INVALID');
    await refused(() => f.edit({ path: 'x'.repeat(401) }), 'INVALID');
    assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='agent.file-edit'").get() as { n: number }).n, 1);
  } finally { await f.cleanup(); }
});
