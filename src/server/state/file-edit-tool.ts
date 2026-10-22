import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJson, type ControlScope } from '../../shared/control-state';
import { ControlStore, ControlStoreError } from './control-store';
import { atomicWrite } from '../board-store';
import { safePath } from '../paths';

/**
 * The bounded file-edit capability the 'file_edit' scope governs.
 *
 * It edits files **only** inside a project's connected repository worktree — the registered project's
 * own folder, resolved by the caller — and nowhere else. Every path is relative, every component is
 * checked by the existing containment helper (which refuses an absolute path, a parent segment, a
 * backslash and a symlink at any component), a size cap applies to the file and to the diff, writes
 * are atomic, and every proposed or applied change is recorded durably with its diff.
 *
 * Two modes, and the mode in force is read from the acceptance policy rather than assumed:
 *
 * - **propose-only is the default.** The change and its diff are recorded and no file is written.
 * - **auto-apply writes the file.** It requires both an explicit request and a policy that permits it;
 *   a request for auto-apply while the policy in force is propose-only is refused.
 *
 * The tool is disabled by default and absent from the typed registry while it is disabled, exactly as
 * the bounded coding runner is: a capability this instance lacks is absent rather than
 * present-and-failing. Nothing here reads a general browse root, follows a symlink out of the
 * worktree, touches a generated directory or writes anywhere under the data root.
 */

export const FILE_EDIT_MODES = ['propose-only', 'auto-apply'] as const;
export type FileEditMode = (typeof FILE_EDIT_MODES)[number];

/** The per-file cap. A change larger than this is refused, never truncated. */
export const FILE_EDIT_MAX_FILE_BYTES = 256 * 1024;
/** The per-edit diff cap. A diff longer than this is truncated with a marker, never silently dropped. */
export const FILE_EDIT_MAX_DIFF_BYTES = 32 * 1024;
export const FILE_EDIT_MAX_PATH_LENGTH = 400;
/** One project cannot grow an unbounded ledger of edits. */
export const FILE_EDIT_MAX_EDITS = 500;
/** The lines of context a hunk carries, and the size above which the diff is a summary instead. */
const CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 800;

/**
 * Generated and app-managed directories inside a project. A path whose first segment is one of these
 * is refused: they are outputs, not sources, and editing them would be a change nothing tracks.
 */
export const FILE_EDIT_REFUSED_DIRECTORIES = Object.freeze([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', '.svelte-kit', '.astro', 'coverage'
]);

export type FileEditErrorCode = 'INVALID' | 'NOT_FOUND' | 'NOT_PERMITTED' | 'OUTSIDE_WORKTREE' | 'BOUNDED' | 'UNAVAILABLE' | 'CONFLICT' | 'CORRUPT' | 'STORAGE';
export class FileEditError extends Error {
  constructor(message: string, public readonly code: FileEditErrorCode) {
    super(message);
    this.name = 'FileEditError';
  }
}

/** The durable record of one change: what was proposed or applied, and the diff that proves it. */
export type FileEditRecord = {
  readonly version: 1;
  readonly id: string;
  readonly projectId: string;
  readonly agentId: string | null;
  readonly path: string;
  readonly mode: FileEditMode;
  readonly applied: boolean;
  readonly created: boolean;
  readonly bytes: number;
  readonly diff: string;
  readonly diffBytes: number;
  readonly diffTruncated: boolean;
  readonly createdAt: string;
  readonly changedBy: { readonly kind: 'owner' | 'agent'; readonly identity: string };
};

/** What one edit answers with: the durable record, and whether a file was really written. */
export type FileEditOutcome = { readonly record: FileEditRecord; readonly written: boolean };

/** The read side: the mode in force, whether the tool is enabled, and every recorded change. */
export type FileEditView = {
  readonly readOnly: true;
  readonly projectId: string;
  readonly enabled: boolean;
  readonly mode: FileEditMode;
  readonly limits: { readonly fileBytes: number; readonly diffBytes: number; readonly edits: number };
  readonly edits: readonly FileEditRecord[];
  readonly truncated: boolean;
};

/**
 * The capability the agent harness consumes. It is the whole of what the model-facing 'file_edit'
 * tool may do: resolve the mode, and make one bounded change.
 */
export interface FileEditCapability {
  readonly enabled: boolean;
  /** The mode in force, read from the acceptance policy rather than assumed. */
  mode(): Promise<FileEditMode>;
  /** Every recorded change of one project, oldest first, with the mode in force. */
  view(projectId: unknown): Promise<FileEditView>;
  edit(input: {
    readonly projectId: string;
    readonly agentId: string | null;
    readonly path: string;
    readonly content: string;
    readonly mode?: FileEditMode | null;
    readonly actor: { readonly kind: 'owner' | 'agent'; readonly identity: string };
  }): Promise<FileEditOutcome>;
}

export type FileEditToolOptions = {
  readonly enabled: boolean;
  /** The registered project's own folder — the connected repository worktree — or undefined. */
  readonly projectRoot: (projectId: string) => string | undefined;
  /** The data root, which this tool never writes under even when a path would resolve inside it. */
  readonly dataRoot?: string;
  /** The acceptance policy in force: the one owner switch that decides the mode. */
  readonly policy: { readonly mode: () => FileEditMode | Promise<FileEditMode> };
  readonly clock?: () => Date;
  readonly id?: () => string;
};

const OPERATION_KIND = 'agent.file-edit';
const OUTBOX_KIND = 'agent.file-edit-record';
const OWNER_BUCKET = 'owner';
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function storage(message: string): FileEditError {
  return new FileEditError(message, 'STORAGE');
}
function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value))
    throw new FileEditError(label + ' must be 1-160 characters, starting alphanumeric, from A-Za-z0-9._:-', 'INVALID');
  return value;
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/* --------------------------------------------------------------------------------------------- *
 * The diff. Deterministic, bounded, and never a claim about a file it did not read.
 * --------------------------------------------------------------------------------------------- */

/**
 * A unified diff of two texts, deterministic for the same input.
 *
 * It is deliberately bounded: above MAX_DIFF_LINES on either side the diff becomes a summary that
 * states the line counts it did not walk, rather than a large edit producing a large record. The
 * result is always truncated to the documented diff cap, with the truncation stated in the text.
 */
export function unifiedDiff(before: string, after: string): { readonly text: string; readonly truncated: boolean } {
  const beforeLines = splitLines(before), afterLines = splitLines(after);
  let text: string;
  if (beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES) {
    text = '--- summary (the file is longer than the ' + MAX_DIFF_LINES + ' lines this build diffs)\n'
      + '- lines before: ' + beforeLines.length + '\n'
      + '+ lines after: ' + afterLines.length + '\n'
      + '- bytes before: ' + byteLength(before) + '\n'
      + '+ bytes after: ' + byteLength(after) + '\n';
  } else {
    text = renderUnified(beforeLines, afterLines);
  }
  if (byteLength(text) > FILE_EDIT_MAX_DIFF_BYTES) {
    let clipped = text;
    while (byteLength(clipped) > FILE_EDIT_MAX_DIFF_BYTES - 64 && clipped.length > 0) clipped = clipped.slice(0, Math.floor(clipped.length * 0.9));
    return Object.freeze({ text: clipped + '\n[diff truncated at ' + FILE_EDIT_MAX_DIFF_BYTES + ' bytes]\n', truncated: true });
  }
  return Object.freeze({ text, truncated: false });
}
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
function renderUnified(before: string[], after: string[]): string {
  const ops = lineOps(before, after);
  // The line each op starts at, on each side, so a hunk header states the real positions rather than
  // the position in the op list.
  let beforeAt = 1, afterAt = 1;
  const starts: { readonly before: number; readonly after: number }[] = [];
  for (const op of ops) {
    starts.push({ before: beforeAt, after: afterAt });
    if (op.kind !== 'add') beforeAt += 1;
    if (op.kind !== 'remove') afterAt += 1;
  }
  const lines: string[] = ['--- before', '+++ after'];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === 'same') { index += 1; continue; }
    let start = index, end = index;
    while (end < ops.length) {
      if (ops[end].kind !== 'same') { end += 1; continue; }
      let run = end;
      while (run < ops.length && ops[run].kind === 'same') run += 1;
      if (run - end > CONTEXT_LINES * 2) break;
      end = run;
    }
    const from = Math.max(0, start - CONTEXT_LINES);
    const to = Math.min(ops.length, end + CONTEXT_LINES);
    const span = ops.slice(from, to);
    const beforeCount = span.filter((op) => op.kind !== 'add').length;
    const afterCount = span.filter((op) => op.kind !== 'remove').length;
    lines.push('@@ -' + starts[from].before + ',' + beforeCount + ' +' + starts[from].after + ',' + afterCount + ' @@');
    for (const op of span) lines.push((op.kind === 'same' ? ' ' : op.kind === 'add' ? '+' : '-') + op.text);
    index = to;
  }
  if (lines.length === 2) lines.push('(no line changed; the bytes differ)');
  return lines.join('\n') + '\n';
}
type LineOp = { readonly kind: 'same' | 'add' | 'remove'; readonly text: string };
/** A longest-common-subsequence line diff, which is what makes the same pair of texts produce one diff. */
function lineOps(before: string[], after: string[]): LineOp[] {
  const rows = before.length, columns = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row][column] = before[row] === after[column]
        ? table[row + 1][column + 1] + 1
        : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }
  const ops: LineOp[] = [];
  let row = 0, column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) { ops.push({ kind: 'same', text: before[row] }); row += 1; column += 1; continue; }
    if (table[row + 1][column] >= table[row][column + 1]) { ops.push({ kind: 'remove', text: before[row] }); row += 1; }
    else { ops.push({ kind: 'add', text: after[column] }); column += 1; }
  }
  while (row < rows) { ops.push({ kind: 'remove', text: before[row] }); row += 1; }
  while (column < columns) { ops.push({ kind: 'add', text: after[column] }); column += 1; }
  return ops;
}

/* --------------------------------------------------------------------------------------------- *
 * The tool.
 * --------------------------------------------------------------------------------------------- */

export class FileEditTool implements FileEditCapability {
  private readonly clock: () => Date;
  private readonly id: () => string;
  constructor(private readonly store: ControlStore, private readonly options: FileEditToolOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? (() => 'fe-' + createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 32));
  }
  get enabled(): boolean { return this.options.enabled; }

  /**
   * The mode in force, read from the acceptance policy. It is never assumed: with no policy port it
   * is propose-only, which is the safe direction.
   */
  async mode(): Promise<FileEditMode> {
    const mode = await this.options.policy.mode();
    return mode === 'auto-apply' ? 'auto-apply' : 'propose-only';
  }

  /** Every recorded change of one project, oldest first, with the mode in force. */
  async view(projectId: unknown): Promise<FileEditView> {
    const id = requireIdentifier(projectId, 'projectId');
    const mode = await this.mode();
    const edits = this.edits(id);
    const truncated = edits.length > FILE_EDIT_MAX_EDITS;
    return Object.freeze({
      readOnly: true as const,
      projectId: id,
      enabled: this.options.enabled,
      mode,
      limits: Object.freeze({ fileBytes: FILE_EDIT_MAX_FILE_BYTES, diffBytes: FILE_EDIT_MAX_DIFF_BYTES, edits: FILE_EDIT_MAX_EDITS }),
      edits: Object.freeze(edits.slice(-FILE_EDIT_MAX_EDITS)),
      truncated
    });
  }

  /**
   * One bounded change.
   *
   * In order: the tool must be enabled, the request must be well formed, the mode must be one the
   * policy in force permits, the project must resolve to its connected worktree, the path must pass
   * the existing containment helper and name no generated directory, and the change must be inside
   * the size cap. Only then is a diff computed, the change recorded, and — in auto-apply — the file
   * written atomically. A refusal writes nothing at all.
   */
  async edit(input: {
    readonly projectId: string;
    readonly agentId: string | null;
    readonly path: string;
    readonly content: string;
    readonly mode?: FileEditMode | null;
    readonly actor: { readonly kind: 'owner' | 'agent'; readonly identity: string };
  }): Promise<FileEditOutcome> {
    if (!this.options.enabled)
      throw new FileEditError('The file-edit tool is disabled on this instance, so no file is proposed or written', 'UNAVAILABLE');
    const projectId = requireIdentifier(input?.projectId, 'projectId');
    const agentId = input?.agentId === null || input?.agentId === undefined ? null : requireIdentifier(input.agentId, 'agentId');
    const actor = input?.actor;
    if (actor === null || typeof actor !== 'object' || (actor.kind !== 'owner' && actor.kind !== 'agent') || typeof actor.identity !== 'string' || actor.identity === '')
      throw new FileEditError('actor is invalid: it requires kind (owner or agent) and identity', 'INVALID');
    const rawPath = input?.path;
    if (typeof rawPath !== 'string' || rawPath === '' || rawPath.length > FILE_EDIT_MAX_PATH_LENGTH)
      throw new FileEditError('path must be a relative path of 1-' + FILE_EDIT_MAX_PATH_LENGTH + ' characters inside the connected worktree', 'INVALID');
    const content = input?.content;
    if (typeof content !== 'string') throw new FileEditError('content must be text', 'INVALID');
    const contentBytes = byteLength(content);
    if (contentBytes > FILE_EDIT_MAX_FILE_BYTES)
      throw new FileEditError('The change is ' + contentBytes + ' bytes, which is over the ' + FILE_EDIT_MAX_FILE_BYTES + '-byte cap for one file; nothing was written', 'BOUNDED');
    const mode = await this.resolveMode(input?.mode ?? null);

    const root = this.options.projectRoot(projectId);
    if (root === undefined)
      throw new FileEditError('Project ' + projectId + ' could not be resolved to a connected repository worktree, so nothing was written', 'NOT_FOUND');
    const file = await this.contain(root, rawPath);
    if (this.options.dataRoot !== undefined && await this.inside(file, this.options.dataRoot))
      throw new FileEditError('That path resolves inside the application data root, which this tool never writes to; nothing was written', 'OUTSIDE_WORKTREE');

    const before = await this.readExisting(file);
    const diff = unifiedDiff(before, content);
    const record = this.materialize({ projectId, agentId, path: rawPath, mode, content, before, diff, actor });
    const existing = this.byKey(projectId, agentId, record.id);
    if (existing !== null) return Object.freeze({ record: existing, written: false });

    // The record is written before the file is, so a crash between the two leaves evidence of a change
    // that was proposed and never applied — which is exactly what the record says — rather than a
    // changed file nothing accounts for.
    this.write(record);
    if (mode === 'auto-apply') {
      await mkdir(dirname(file), { recursive: true, mode: 0o755 });
      await atomicWrite(file, content);
    }
    return Object.freeze({ record, written: mode === 'auto-apply' });
  }

  /** The mode one request leaves in force: the request's own, or the policy's, and never a widening. */
  private async resolveMode(requested: FileEditMode | null): Promise<FileEditMode> {
    const inForce = await this.mode();
    if (requested === null) return inForce;
    if (requested !== 'propose-only' && requested !== 'auto-apply')
      throw new FileEditError('mode must be propose-only or auto-apply', 'INVALID');
    if (requested === 'auto-apply' && inForce !== 'auto-apply')
      throw new FileEditError(
        'Auto-apply is not the mode in force: the acceptance policy in force is ' + inForce + ', so this change is refused rather than applied. Set the policy to agent-may-accept, or send it as propose-only.',
        'NOT_PERMITTED'
      );
    return requested;
  }
  /**
   * The one containment path, through the helper every managed write in this build already uses: it
   * refuses an absolute path, a backslash, an empty or parent segment and a symlink at any component,
   * and it never resolves one into a path inside the root. Generated directories are refused on top.
   */
  private async contain(root: string, relative: string): Promise<string> {
    const segments = relative.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
      throw new FileEditError('That path is refused: it must be a relative path with no empty, current or parent segment. Nothing was written.', 'OUTSIDE_WORKTREE');
    let resolved: string;
    try {
      resolved = await safePath(root, relative);
    } catch (error) {
      throw new FileEditError('That path is refused: ' + (error as Error).message + '. Nothing was written.', 'OUTSIDE_WORKTREE');
    }
    if (resolved === root) throw new FileEditError('That path is the worktree root itself, which is not a file; nothing was written', 'OUTSIDE_WORKTREE');
    const first = relative.split('/')[0];
    if (FILE_EDIT_REFUSED_DIRECTORIES.includes(first))
      throw new FileEditError('That path is inside ' + first + ', a generated or app-managed directory this tool never edits; nothing was written', 'OUTSIDE_WORKTREE');
    try {
      const info = await lstat(resolved);
      if (info.isDirectory()) throw new FileEditError('That path is a directory, not a file; nothing was written', 'INVALID');
      if (info.isSymbolicLink()) throw new FileEditError('That path is a symlink, which this tool never follows; nothing was written', 'OUTSIDE_WORKTREE');
    } catch (error) {
      if (error instanceof FileEditError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new FileEditError('That path could not be inspected, so nothing was written', 'OUTSIDE_WORKTREE');
    }
    return resolved;
  }
  private async inside(candidate: string, root: string): Promise<boolean> {
    const target = root.replace(/\/+$/, '') + '/';
    return candidate === root || candidate.startsWith(target);
  }
  private async readExisting(file: string): Promise<string> {
    try {
      const info = await lstat(file);
      if (info.size > FILE_EDIT_MAX_FILE_BYTES)
        throw new FileEditError('The file is already over the ' + FILE_EDIT_MAX_FILE_BYTES + '-byte cap, so it is refused rather than rewritten; nothing was written', 'BOUNDED');
      return await readFile(file, 'utf8');
    } catch (error) {
      if (error instanceof FileEditError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw new FileEditError('The existing file could not be read, so nothing was written', 'OUTSIDE_WORKTREE');
    }
  }
  /** The record one change produces: its identity and its key are derived from the change itself. */
  private materialize(input: {
    readonly projectId: string;
    readonly agentId: string | null;
    readonly path: string;
    readonly mode: FileEditMode;
    readonly content: string;
    readonly before: string;
    readonly diff: { readonly text: string; readonly truncated: boolean };
    readonly actor: { readonly kind: 'owner' | 'agent'; readonly identity: string };
  }): FileEditRecord {
    const digest = createHash('sha256').update(canonicalJson({
      projectId: input.projectId, agentId: input.agentId, path: input.path, mode: input.mode, content: input.content
    })).digest('hex');
    const createdAt = this.now();
    return Object.freeze({
      version: 1 as const,
      id: 'fe-' + digest,
      projectId: input.projectId,
      agentId: input.agentId,
      path: input.path,
      mode: input.mode,
      applied: input.mode === 'auto-apply',
      created: input.before === '',
      bytes: byteLength(input.content),
      diff: input.diff.text,
      diffBytes: byteLength(input.diff.text),
      diffTruncated: input.diff.truncated,
      createdAt,
      changedBy: Object.freeze({ kind: input.actor.kind, identity: input.actor.identity })
    }) as FileEditRecord;
  }
  private write(record: FileEditRecord): void {
    const scope: ControlScope = { projectId: record.projectId, sessionId: record.agentId ?? OWNER_BUCKET };
    try {
      this.store.admit({
        scope,
        idempotencyKey: 'file-edit.' + record.id.slice(3),
        kind: OPERATION_KIND,
        input: record,
        outbox: { kind: OUTBOX_KIND, payload: { version: 1, editId: record.id, path: record.path, applied: record.applied } }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new FileEditError('That change was already recorded with different content; nothing was written', 'CONFLICT');
      throw storage('The durable store refused the file-edit record: ' + (error as Error).message);
    }
  }
  private byKey(projectId: string, agentId: string | null, editId: string): FileEditRecord | null {
    const rows = this.rows(
      'SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid',
      [projectId, agentId ?? OWNER_BUCKET, OPERATION_KIND]
    );
    for (const row of rows) {
      const record = this.decode(String(row.id), { projectId, sessionId: agentId ?? OWNER_BUCKET });
      if (record.id === editId) return record;
    }
    return null;
  }
  /** Every recorded change of one project, oldest first. */
  private edits(projectId: string): FileEditRecord[] {
    const rows = this.rows('SELECT id,session_id FROM operations WHERE project_id=? AND kind=? ORDER BY rowid', [projectId, OPERATION_KIND]);
    return rows.map((row) => this.decode(String(row.id), { projectId, sessionId: String(row.session_id) }));
  }
  private decode(operationId: string, scope: ControlScope): FileEditRecord {
    const operation = this.store.getOperation(operationId, scope);
    if (operation.kind !== OPERATION_KIND) throw storage('File-edit storage holds an unexpected operation kind');
    const value = operation.input as Record<string, unknown> | null;
    if (value === null || typeof value !== 'object') throw storage('A stored file-edit record is not an object');
    const required = ['version', 'id', 'projectId', 'agentId', 'path', 'mode', 'applied', 'created', 'bytes', 'diff', 'diffBytes', 'diffTruncated', 'createdAt', 'changedBy'];
    for (const field of required) if (!(field in value)) throw storage('A stored file-edit record is missing ' + field);
    if (value.version !== 1 || value.projectId !== scope.projectId) throw storage('A stored file-edit record is outside its own scope');
    if (value.mode !== 'propose-only' && value.mode !== 'auto-apply') throw storage('A stored file-edit record names no known mode');
    return Object.freeze(value) as unknown as FileEditRecord;
  }
  private rows(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try {
      return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    } catch (error) {
      throw storage('The durable control store could not be read: ' + (error as Error).message);
    }
  }
  private now(): string {
    const at = this.clock().getTime();
    if (!Number.isFinite(at)) throw storage('The file-edit clock is not a valid instant');
    return new Date(at).toISOString();
  }
}
