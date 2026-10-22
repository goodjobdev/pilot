import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ControlStore, ControlStoreError } from './control-store';
import type { ControlScope, OperationRecord, OutboxRecord } from '../../shared/control-state';
import { safePath, within } from '../paths';
import { SessionError, type SessionRecord } from '../../shared/sessions';
import {
  FORK_ATTENTION_DETAILS, FORK_MAX_ENTRY_SCAN, FORK_MAX_FORKS, ForkError, createdForkRecord, forkChildName, forkDispatchRefusal,
  forkView, nextForkRecord, parseForkBaseCommit, parseForkCutoffEntryId, parseForkIdentifier, parseForkRevision,
  parseForkTarget, validateForkRecord,
  type ForkActionResult, ForkAttentionReason, type ForkRecord, type ForkView
} from '../../shared/forks';

/**
 * The durable half of a fork: one control-store operation per fork revision, the transcript fork that
 * creates the child, and the one fixed git operation that creates the child's worktree.
 *
 * It introduces **no** new persistence. Exactly like the named-session registry, the queue and the
 * session lifecycle, it keeps one operation per revision — keyed `fork.r<revision>` inside the child
 * session's own scope — and the control store's `UNIQUE(project_id, session_id, idempotency_key)`
 * index is what makes two writers aiming at the same revision a conflict rather than two records. The
 * creation is a single admission, so a fork either exists at revision 1 or does not exist at all.
 *
 * Four rules hold, and each is enforced here rather than asserted:
 *
 * 1. **A fork starts from a commit and never from a working tree.** The child's worktree is created by
 *    one fixed `git worktree add` from the recorded base commit (`createForkWorktreePort`), with no
 *    hooks, no submodule recursion, no network and no local-protocol transport. The parent's
 *    uncommitted and staged changes are **never** copied, and no `git stash` is run anywhere: nothing
 *    in this file or its port reads or writes a stash, and nothing reads the parent worktree at all.
 * 2. **A child is created paused, and a paused child dispatches nothing.** `dispatchChild` reads the
 *    durable state first and refuses in words when the fork is not `active`; the refusal happens
 *    before any call to the transcript port, so a paused child causes no model request at all.
 * 3. **Nothing is inherited.** The child's session is adopted with no links and no declared model, and
 *    approvals, acceptances and grants are not copied — they are separate durable records this store
 *    never reads or writes.
 * 4. **A discard is target-bound, revision-checked and never forced implicitly.** It acts on the worktree
 *    path the record itself carries, re-checks that the path is still inside the designated fork root,
 *    refuses a stale revision without touching anything, and refuses to remove a worktree with
 *    uncommitted or untracked changes unless the caller forces it. A worktree that cannot be removed
 *    safely becomes a **named operator-attention state** (`failed`), never a forced deletion.
 *
 * The designated fork root is **per project**: `root(projectId)` resolves and caches
 * `<forkRootParent>/<projectId>`, so the one store an instance constructs for every project never
 * hands one project another's root, and the layout `<data>/forks/<projectId>/<childSessionId>` holds
 * whatever order the projects are used in.
 *
 * Every refusal is path-free: a git or filesystem error may name a path, so those are logged, never
 * stored in a record and never returned to a caller.
 */

const OPERATION_KIND = 'session.fork';
const OUTBOX_KIND = 'session.fork';
/** The directory, inside the data root, that every fork worktree of a project must live under. */
export const FORK_ROOT_DIRECTORY = 'forks';

/** What the durable transcript must answer for one fork. Every method is read-only except `fork` and `dispatch`. */
export type ForkTranscriptPort = {
  /** Whether this project's transcript holds a conversation for this session id. */
  parentSession(input: { readonly projectId: string; readonly parentSessionId: string }): Promise<boolean>;
  /** Whether the parent transcript holds this entry id. Read-only, and bounded. */
  hasEntry(input: { readonly projectId: string; readonly parentSessionId: string; readonly cutoffEntryId: number }): Promise<boolean>;
  /**
   * Creates the child conversation from the parent's context up to and including the cutoff entry.
   * It must make no model request, and it must not carry anything the parent recorded after the cutoff.
   */
  fork(input: { readonly projectId: string; readonly parentSessionId: string; readonly cutoffEntryId: number }): Promise<{ readonly childSessionId: string }>;
  /**
   * Sends one input to a child conversation under a stable request identity. It is called **only** for
   * a fork this store has already found `active`.
   */
  dispatch(input: { readonly projectId: string; readonly childSessionId: string; readonly requestId: string; readonly text: string }): Promise<void>;
};

/** The state of one child worktree as the filesystem and git really report it. */
export type ForkWorktreeState = { readonly state: 'clean' | 'dirty' | 'absent' | 'unreadable'; readonly head: string | null };

/**
 * The fixed git operations a fork may perform. There are four, and nothing here takes a command, an
 * argument or an environment from a caller:
 *
 * - `resolveCommit` proves the recorded base commit is a real commit of the project's own repository;
 * - `create` is one `git worktree add` from that commit;
 * - `inspect` reads the child worktree's own status, so a discard knows what it would destroy;
 * - `remove` is one `git worktree remove`, with `force` only when the caller explicitly forced it.
 */
export type ForkWorktreePort = {
  resolveCommit(input: { readonly repository: string; readonly commit: string }): Promise<string>;
  create(input: { readonly repository: string; readonly path: string; readonly baseCommit: string }): Promise<void>;
  inspect(input: { readonly path: string }): Promise<ForkWorktreeState>;
  remove(input: { readonly repository: string; readonly path: string; readonly force: boolean }): Promise<void>;
};

/** The session registry as this store needs it: read the parent, adopt the child, and nothing else. */
export type ForkSessionRegistry = {
  read(projectId: unknown, sessionId: unknown): SessionRecord;
  adopt(input: unknown): Promise<{ readonly record: SessionRecord; readonly existing: boolean }>;
};

export type ForkStoreOptions = {
  /** The registered project's own folder, which is the repository a child worktree is added to. */
  readonly projectFolder: (projectId: string) => string | undefined;
  /** The designated fork root's parent: the directory every fork worktree of a project must live under. */
  readonly forkRootParent: string;
  readonly transcripts: ForkTranscriptPort;
  readonly worktrees: ForkWorktreePort;
  readonly sessions: ForkSessionRegistry;
  readonly clock?: () => Date;
};

/** What one creation reports: the record, and the state it was created in (paused, or the named failure). */
export type ForkCreationResult = {
  readonly fork: ForkRecord;
  readonly created: boolean;
  readonly adopted: boolean;
};

function iso(at: Date): string {
  const time = at.getTime();
  if (!Number.isFinite(time)) throw new ForkError('The fork clock is not a valid instant', 'INVALID');
  return new Date(time).toISOString();
}
function attentionOf(reason: ForkAttentionReason): { readonly reason: ForkAttentionReason; readonly detail: string } {
  return Object.freeze({ reason, detail: FORK_ATTENTION_DETAILS[reason] });
}
/** A refusal keeps its type when it is already this store's own, and is wrapped precisely when it is not. */
function asForkError(error: unknown, label: string): ForkError {
  if (error instanceof ForkError) return error;
  const message = error instanceof SessionError ? error.message : (error as Error).message;
  console.error('The fork operation ' + label + ' failed: ' + message);
  return new ForkError('The fork operation ' + label + ' could not be completed; nothing was forced and the durable record is unchanged.', 'UNAVAILABLE');
}

export class ForkStore {
  private readonly clock: () => Date;
  /**
   * The canonical fork root of **each project**, keyed by project id. It is a map and not one value:
   * this store is constructed once for the whole application (one `ForkStore` in `main.ts`), so a
   * single cached root would hand the first project that asked for its root to every later project,
   * and a child of project B would be created under project A's `forks/<projectId>` directory. Each
   * project resolves and caches its own root, under its own directory, so the documented layout
   * `<data>/forks/<projectId>/<childSessionId>` holds for every project whichever one is used first.
   */
  private readonly canonicalRoots = new Map<string, string>();
  constructor(private readonly store: ControlStore, private readonly options: ForkStoreOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * The designated fork root for one project: a real directory under the configured parent, never a
   * symlink, created on first use with private permissions, and resolved and cached **per project
   * id**, so one project's root is never another's. Every path this store touches is inside it, and a
   * path that is not is refused rather than rewritten.
   */
  private async root(projectId: string): Promise<string> {
    const candidate = join(this.options.forkRootParent, projectId);
    const cached = this.canonicalRoots.get(projectId);
    if (cached !== undefined) return cached;
    try {
      await mkdir(candidate, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.error('The fork root could not be created: ' + (error as Error).message);
      throw new ForkError('The designated fork root could not be created, so no worktree could be prepared; nothing was created.', 'STORAGE');
    }
    const info = await lstat(candidate).catch(() => null);
    if (info === null || info.isSymbolicLink() || !info.isDirectory())
      throw new ForkError('The designated fork root is not a real directory, so no worktree could be prepared; nothing was created.', 'STORAGE');
    const canonical = await realpath(candidate);
    this.canonicalRoots.set(projectId, canonical);
    return canonical;
  }

  /** The repository a child worktree is added to, or the precise refusal that there is not one. */
  private async repository(projectId: string): Promise<string> {
    const folder = this.options.projectFolder(projectId);
    if (folder === undefined || folder === '')
      throw new ForkError('Project ' + projectId + ' records no folder, so there is no repository to branch a worktree from', 'NOT_FOUND');
    const info = await lstat(folder).catch(() => null);
    if (info === null || info.isSymbolicLink() || !info.isDirectory())
      throw new ForkError('Project ' + projectId + ' records no readable folder, so there is no repository to branch a worktree from', 'NOT_FOUND');
    return folder;
  }

  /** The fork of one project and child session, or null when this project holds no such fork. */
  read(projectId: unknown, childSessionId: unknown): ForkRecord | null {
    const project = parseForkIdentifier(projectId, 'projectId');
    const child = parseForkIdentifier(childSessionId, 'childSessionId');
    return this.latest(project, child);
  }

  /** Every fork of one project that is not discarded, oldest first with ties broken by id: a deterministic order. */
  list(projectId: unknown): readonly ForkRecord[] {
    return Object.freeze(this.records(parseForkIdentifier(projectId, 'projectId')).filter((fork) => fork.state !== 'discarded'));
  }

  /** The owner-visible read of one project's forks, at the documented bounds. */
  view(projectId: unknown): ForkView {
    const project = parseForkIdentifier(projectId, 'projectId');
    const all = this.records(project);
    const live = all.filter((fork) => fork.state !== 'discarded');
    const truncated = live.length > FORK_MAX_FORKS;
    return forkView({ projectId: project, forks: live.slice(0, FORK_MAX_FORKS), truncated });
  }

  /**
   * Create one fork: a child transcript branched at the cutoff, a paused child session, and a worktree
   * created from the recorded base commit.
   *
   * The order is the guarantee. Every refusal that costs nothing happens **first** — the parent session,
   * the cutoff entry, the base commit, the target and the project's own fork budget are all checked
   * before anything durable or on disk is created — and once the transcript fork has happened the
   * outcome is a record rather than an error: a fork whose worktree or session could not be created is
   * recorded as `failed` with a named, path-free reason, so an operator sees exactly what exists.
   */
  async create(input: {
    readonly projectId: unknown; readonly parentSessionId: unknown; readonly baseCommit: unknown;
    readonly cutoffEntryId: unknown; readonly target?: unknown;
  }): Promise<ForkCreationResult> {
    const projectId = parseForkIdentifier(input.projectId, 'projectId');
    const parentSessionId = parseForkIdentifier(input.parentSessionId, 'parentSessionId');
    const baseCommit = parseForkBaseCommit(input.baseCommit);
    const cutoffEntryId = parseForkCutoffEntryId(input.cutoffEntryId);
    const requested = input.target === undefined || input.target === null ? null : parseForkTarget(input.target);
    let parent: SessionRecord;
    try {
      parent = this.options.sessions.read(projectId, parentSessionId);
    } catch (error) {
      if (error instanceof SessionError && (error.code === 'NOT_FOUND' || error.code === 'INVALID'))
        throw new ForkError('A fork branches from a named session of this project, and ' + error.message, 'NOT_FOUND');
      throw error;
    }
    if (this.list(projectId).length >= FORK_MAX_FORKS)
      throw new ForkError(
        'Project ' + projectId + ' already holds the documented maximum of ' + FORK_MAX_FORKS +
          ' forks; discard one before creating another; nothing was created',
        'BOUNDED'
      );
    if (!(await this.callTranscript('verify the parent session', () => this.options.transcripts.parentSession({ projectId, parentSessionId }))))
      throw new ForkError(
        'The transcript of project ' + projectId + ' holds no conversation for session ' + parentSessionId +
          ', so there is nothing to fork; nothing was created',
        'NOT_FOUND'
      );
    const cutoff = await this.callTranscript('read the cutoff entry', () => this.options.transcripts.hasEntry({ projectId, parentSessionId, cutoffEntryId }));
    if (!cutoff)
      throw new ForkError(
        'The parent transcript of session ' + parentSessionId + ' holds no entry ' + cutoffEntryId +
          ' in the window of ' + FORK_MAX_ENTRY_SCAN +
          ' entries this instance reads, so a child branched there could not be shown to see a real context; a fork branches only at an entry the parent transcript really holds; nothing was created',
        'NOT_FOUND'
      );
    const repository = await this.repository(projectId);
    const commit = await this.baseCommit(repository, baseCommit);
    const root = await this.root(projectId);
    // A caller-supplied target is checked before anything is created. The derived default — the child
    // session's own id — is checked once it is known, and a collision there is reported as a named
    // operator-attention state rather than forced away.
    if (requested !== null) await this.assertTargetFree(root, requested);
    const child = await this.callTranscript('fork the transcript', () => this.options.transcripts.fork({ projectId, parentSessionId, cutoffEntryId }));
    const childSessionId = parseForkIdentifier(child.childSessionId, 'childSessionId');
    const path = await this.worktreePath(root, requested ?? childSessionId);
    const now = this.clock();
    let adopted = false;
    try {
      await this.options.sessions.adopt({ projectId, sessionId: childSessionId, name: forkChildName(parent.name, childSessionId), model: null, links: [] });
      adopted = true;
    } catch (error) {
      console.error('The named session of fork ' + childSessionId + ' could not be created: ' + (error as Error).message);
      const failed = this.write(createdForkRecord({
        projectId, parentSessionId, cutoffEntryId, childSessionId, worktreePath: path, baseCommit: commit,
        state: 'failed', attention: attentionOf('child-session-refused'), now
      }));
      return Object.freeze({ fork: failed, created: false, adopted: false });
    }
    try {
      await this.options.worktrees.create({ repository, path, baseCommit: commit });
    } catch (error) {
      console.error('The child worktree of fork ' + childSessionId + ' could not be created: ' + (error as Error).message);
      const failed = this.write(createdForkRecord({
        projectId, parentSessionId, cutoffEntryId, childSessionId, worktreePath: path, baseCommit: commit,
        state: 'failed', attention: attentionOf('worktree-create-failed'), now
      }));
      return Object.freeze({ fork: failed, created: false, adopted });
    }
    const record = this.write(createdForkRecord({
      projectId, parentSessionId, cutoffEntryId, childSessionId, worktreePath: path, baseCommit: commit, now
    }));
    return Object.freeze({ fork: record, created: true, adopted });
  }

  /**
   * Resume one paused fork: lift the pause so the child may be dispatched into. It dispatches nothing,
   * makes no model request and grants nothing — the child still holds no approval, no accepted artifact
   * and no inherited link.
   *
   * **A repeated resume is a declared no-op that does not re-check the revision.** An already `active`
   * fork answers `unchanged` from its stored record *before* the revision is compared, so a repeat
   * accepts any revision and writes nothing. That is deliberate, and it is not in tension with the
   * `REVISION_MATCHES` the `fork.resume` descriptor declares: the revision is the token of the
   * transitions that really write — the resume that lifts a pause, and the discard — so the declared
   * match is about those writes and not about a call that changes nothing at all. Only an `active`
   * fork can reach the no-op; every other state either is refused or performs a revision-checked write.
   * (docs/FORKS.md says the same thing to an operator.)
   *
   * It answers with a promise like every other fork operation, so a refusal is a rejection the caller's
   * own `await` sees rather than a synchronous throw that a caller without a try/catch around the call
   * itself would miss.
   */
  async resume(input: { readonly projectId: unknown; readonly childSessionId: unknown; readonly revision: unknown }): Promise<ForkActionResult> {
    const current = this.require(input.projectId, input.childSessionId);
    const revision = parseForkRevision(input.revision);
    // The declared no-op: an already active fork answers 'unchanged' before the revision is compared,
    // so it accepts any revision and writes nothing new. See the note above and docs/FORKS.md — the
    // revision still guards every transition that really writes.
    if (current.state === 'active') return Object.freeze({ fork: current, outcome: 'unchanged' as const, removed: false });
    this.assertRevision(current, revision);
    const next = nextForkRecord(current, { state: 'active', attention: null, now: this.clock() });
    const record = this.write(next);
    return Object.freeze({ fork: record, outcome: 'resumed' as const, removed: false });
  }

  /**
   * Discard one fork, removing its worktree. It is target-bound (it acts on the path the record itself
   * carries, re-checked against the designated fork root), revision-checked (a stale revision is a
   * conflict that mutates nothing) and never implicitly forced:
   *
   * - a worktree that is already gone is a completed discard, and nothing is removed;
   * - a clean worktree is removed by one `git worktree remove`;
   * - a worktree with uncommitted or untracked changes is **not** removed unless the caller forces it,
   *   and the fork becomes the named operator-attention state `worktree-dirty`;
   * - a worktree git will not remove, or cannot report, becomes `worktree-remove-refused` or
   *   `worktree-unreadable`, and is left exactly where it is.
   */
  async discard(input: { readonly projectId: unknown; readonly childSessionId: unknown; readonly revision: unknown; readonly force?: unknown }): Promise<ForkActionResult> {
    const current = this.require(input.projectId, input.childSessionId);
    if (current.state === 'discarded') return Object.freeze({ fork: current, outcome: 'unchanged' as const, removed: false });
    this.assertRevision(current, parseForkRevision(input.revision));
    const force = input.force === true;
    const root = await this.root(current.projectId);
    this.assertInsideRoot(root, current);
    const repository = await this.repository(current.projectId);
    const state = await this.options.worktrees.inspect({ path: current.worktreePath });
    if (state.state === 'absent')
      return Object.freeze({ fork: this.write(nextForkRecord(current, { state: 'discarded', attention: null, now: this.clock() })), outcome: 'discarded' as const, removed: false });
    if (state.state === 'unreadable')
      return Object.freeze({ fork: this.attention(current, 'worktree-unreadable'), outcome: 'attention' as const, removed: false });
    if (state.state === 'dirty' && !force)
      return Object.freeze({ fork: this.attention(current, 'worktree-dirty'), outcome: 'attention' as const, removed: false });
    try {
      await this.options.worktrees.remove({ repository, path: current.worktreePath, force: state.state === 'dirty' });
    } catch (error) {
      console.error('The child worktree of fork ' + current.childSessionId + ' was not removed: ' + (error as Error).message);
      return Object.freeze({ fork: this.attention(current, 'worktree-remove-refused'), outcome: 'attention' as const, removed: false });
    }
    return Object.freeze({
      fork: this.write(nextForkRecord(current, { state: 'discarded', attention: null, now: this.clock() })),
      outcome: 'discarded' as const,
      removed: true
    });
  }

  /**
   * Dispatch one input into the child of one fork — the only path that reaches a child conversation,
   * and the path the paused rule is enforced on.
   *
   * The durable state is read first, so a fork that is not `active` refuses **in words** and the
   * transcript port is never called at all: a paused child causes no model request, no submission and
   * no admission. An `active` child is dispatched under a stable request identity derived from the
   * fork's own child session id, so a repeat is the same submission rather than a second one.
   */
  async dispatchChild(input: { readonly projectId: unknown; readonly childSessionId: unknown; readonly text: unknown }): Promise<{ readonly requestId: string }> {
    const current = this.require(input.projectId, input.childSessionId);
    const refusal = forkDispatchRefusal(current);
    if (refusal !== null) throw new ForkError(refusal, 'ILLEGAL');
    const text = parseForkDispatchText(input.text);
    const requestId = 'fork:' + current.childSessionId;
    await this.options.transcripts.dispatch({ projectId: current.projectId, childSessionId: current.childSessionId, requestId, text });
    return Object.freeze({ requestId });
  }

  /** The fork of one project and child session, or the refusal that names what is missing. */
  private require(projectId: unknown, childSessionId: unknown): ForkRecord {
    const project = parseForkIdentifier(projectId, 'projectId');
    const child = parseForkIdentifier(childSessionId, 'childSessionId');
    const record = this.latest(project, child);
    if (record === null) throw new ForkError('Project ' + project + ' holds no fork of child session ' + child, 'NOT_FOUND');
    return record;
  }
  /** The revision the caller read must be the stored one: a stale one is a conflict that mutates nothing. */
  private assertRevision(current: ForkRecord, revision: number): void {
    if (current.revision !== revision)
      throw new ForkError(
        'Fork ' + current.childSessionId + ' is at revision ' + current.revision + ', not ' + revision +
          '; read it again before writing; nothing was changed and no worktree was touched',
        'CONFLICT'
      );
  }
  /**
   * The worktree path a record carries must still be inside the designated fork root, and must not be
   * the root itself. A record that says otherwise is refused as an escape attempt: nothing is looked
   * up, nothing is removed, and the reason names no path.
   */
  private assertInsideRoot(root: string, record: ForkRecord): void {
    if (record.worktreePath === root || !within(root, record.worktreePath) || dirname(record.worktreePath) !== root)
      throw new ForkError(
        'Fork ' + record.childSessionId + ' records a worktree path outside the designated fork root, so this build refuses to touch it: a fork is only ever removed inside its own root; nothing was removed',
        'OUTSIDE_ROOT'
      );
  }
  /** One component inside the fork root, and nothing that could escape it. */
  private async worktreePath(root: string, component: string): Promise<string> {
    let candidate: string;
    try {
      candidate = await safePath(root, component);
    } catch (error) {
      throw new ForkError('The fork target is not one path component inside the designated fork root, so no worktree was prepared (' + (error as Error).message + ')', 'OUTSIDE_ROOT');
    }
    if (candidate === root || !within(root, candidate) || dirname(candidate) !== root)
      throw new ForkError('The fork target resolves outside the designated fork root, so no worktree was prepared; nothing was created', 'OUTSIDE_ROOT');
    return candidate;
  }
  /** A fork target that something already occupies is refused rather than reused or removed. */
  private async assertTargetFree(root: string, component: string): Promise<void> {
    const path = await this.worktreePath(root, component);
    const existing = await lstat(path).catch(() => null);
    if (existing !== null)
      throw new ForkError(
        'The fork target is already taken by something in the designated fork root, and this build never reuses or removes what it did not create; give another target; nothing was created',
        'CONFLICT'
      );
  }
  /** The recorded base commit must be a real commit of the project's own repository. */
  private async baseCommit(repository: string, commit: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await this.options.worktrees.resolveCommit({ repository, commit });
    } catch (error) {
      if (error instanceof ForkError) throw error;
      console.error('The base commit could not be resolved: ' + (error as Error).message);
      throw new ForkError('The base commit is not a commit of this project\'s own repository, so nothing was created', 'INVALID');
    }
    if (!/^[0-9a-f]{40}$/.test(resolved))
      throw new ForkError('The base commit did not resolve to one commit id of this project\'s own repository, so nothing was created', 'INVALID');
    return resolved;
  }
  /** A transcript port failure is reported precisely and never asserted as a different outcome. */
  private async callTranscript<T>(label: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ForkError) throw error;
      console.error('The transcript could not ' + label + ': ' + (error as Error).message);
      throw new ForkError(
        'The agent transcript could not ' + label + ', so the fork was refused; no fork record was written and no worktree was created',
        'UNAVAILABLE'
      );
    }
  }
  private attention(current: ForkRecord, reason: ForkAttentionReason): ForkRecord {
    return this.write(nextForkRecord(current, { state: 'failed', attention: attentionOf(reason), now: this.clock() }));
  }

  /** The one write path: a strictly validated next revision, one admission, and the store's own verdict. */
  private write(record: ForkRecord): ForkRecord {
    const exact = validateForkRecord(record);
    let admitted: { operation: OperationRecord; outbox: OutboxRecord; existing: boolean };
    try {
      admitted = this.store.admit({
        scope: { projectId: exact.projectId, sessionId: exact.childSessionId },
        // One key per revision inside the child session's own scope: the store's unique index is what
        // makes two writers at the same revision a conflict rather than two records.
        idempotencyKey: 'fork.r' + exact.revision,
        kind: OPERATION_KIND,
        input: exact,
        outbox: { kind: OUTBOX_KIND, payload: { version: 1, projectId: exact.projectId, childSessionId: exact.childSessionId, revision: exact.revision } }
      });
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT')
        throw new ForkError(
          'Fork ' + exact.childSessionId + ' revision ' + exact.revision + ' was already written with different content (' + error.message + '); the record is unchanged',
          'CONFLICT'
        );
      throw new ForkError('The durable store refused the fork write: ' + (error as Error).message, 'STORAGE');
    }
    if (admitted.existing && exact.revision === 1)
      throw new ForkError('Fork ' + exact.childSessionId + ' already exists in project ' + exact.projectId + '; the record is unchanged', 'CONFLICT');
    return exact;
  }
  /** The latest stored revision of one fork, or null when this project holds no such fork. */
  private latest(projectId: string, childSessionId: string): ForkRecord | null {
    const rows = this.rows('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid', [projectId, childSessionId, OPERATION_KIND]);
    let latest: ForkRecord | null = null;
    for (const row of rows) {
      const record = this.decode(String(row.id), { projectId, sessionId: childSessionId });
      if (latest === null || record.revision > latest.revision) latest = record;
      else if (record.revision === latest.revision) throw new ForkError('Corrupt fork storage: two records of child session ' + childSessionId + ' share revision ' + record.revision, 'CORRUPT');
    }
    return latest;
  }
  /** Every fork of one project: the highest revision of each child session, in a deterministic order. */
  private records(projectId: string): ForkRecord[] {
    const rows = this.rows('SELECT id, session_id FROM operations WHERE project_id=? AND kind=? ORDER BY rowid', [projectId, OPERATION_KIND]);
    const byChild = new Map<string, ForkRecord>();
    for (const row of rows) {
      const childSessionId = String(row.session_id);
      const record = this.decode(String(row.id), { projectId, sessionId: childSessionId });
      const previous = byChild.get(childSessionId);
      if (previous === undefined || record.revision > previous.revision) byChild.set(childSessionId, record);
      else if (record.revision === previous.revision) throw new ForkError('Corrupt fork storage: two records of child session ' + childSessionId + ' share revision ' + record.revision, 'CORRUPT');
    }
    return [...byChild.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.childSessionId.localeCompare(right.childSessionId));
  }
  private decode(operationId: string, scope: ControlScope): ForkRecord {
    let operation: OperationRecord;
    try {
      operation = this.store.getOperation(operationId, scope);
    } catch (error) {
      throw new ForkError('The durable store could not read fork operation ' + operationId + ': ' + (error as Error).message, 'STORAGE');
    }
    if (operation.kind !== OPERATION_KIND) throw new ForkError('Fork storage holds an unexpected operation kind', 'CORRUPT');
    let record: ForkRecord;
    try {
      record = validateForkRecord(operation.input, 'CORRUPT');
    } catch (error) {
      throw new ForkError('A stored fork record is corrupt: ' + (error as Error).message, 'CORRUPT');
    }
    if (record.projectId !== scope.projectId || record.childSessionId !== scope.sessionId)
      throw new ForkError('A stored fork record is outside its own scope', 'CORRUPT');
    const outbox = this.outboxFor(operation.id, scope);
    if (outbox.kind !== OUTBOX_KIND) throw new ForkError('Fork storage holds an unexpected outbox kind', 'CORRUPT');
    if (outbox.state !== 'pending') throw new ForkError('A fork outbox must stay pending for the life of the record', 'CORRUPT');
    const payload = outbox.payload as { version?: unknown; projectId?: unknown; childSessionId?: unknown; revision?: unknown } | null;
    if (!payload || typeof payload !== 'object' || payload.version !== 1 || payload.projectId !== record.projectId || payload.childSessionId !== record.childSessionId || payload.revision !== record.revision)
      throw new ForkError('The stored fork outbox payload does not describe its record', 'CORRUPT');
    return record;
  }
  private outboxFor(operationId: string, scope: ControlScope): OutboxRecord {
    const rows = this.rows('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2', [operationId]);
    if (rows.length !== 1) throw new ForkError('Fork storage holds no unambiguous outbox row for one of its operations', 'CORRUPT');
    try {
      return this.store.getOutbox(String(rows[0].id), scope);
    } catch (error) {
      throw new ForkError('The durable store could not read a fork outbox: ' + (error as Error).message, 'STORAGE');
    }
  }
  /** Read-only SELECTs over the reviewed control schema; every record is read back through the store's own getters. */
  private rows(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    try {
      return this.store.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    } catch (error) {
      throw new ForkError('The durable control store could not be read: ' + (error as Error).message, 'STORAGE');
    }
  }
}

/** One input dispatched into a child: 1-2000 printable characters, and nothing else. */
function parseForkDispatchText(value: unknown, label = 'text'): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new ForkError('The ' + label + ' of a dispatch is invalid: it must be 1-2000 characters of printable text', 'INVALID');
  if (value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value))
    throw new ForkError('The ' + label + ' of a dispatch is invalid: it must be 1-2000 characters of printable text', 'INVALID');
  return value;
}

const exec = promisify(execFile);
export type ForkGitCommand = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;

/**
 * The only git this build runs for a fork. Every invocation is a fixed argv with a stripped
 * environment: hooks are disabled (`core.hooksPath=/dev/null`), submodule recursion is turned off by
 * configuration (`submodule.recurse=false`, `fetch.recurseSubmodules=no` — the only way to say it,
 * because `git worktree add` has no such flag and never initializes a submodule of its own), no network
 * command is ever issued (there is no fetch, clone, pull or ls-remote here), and both the file and the
 * external protocol handlers are refused. No stash is ever created or read: there is no `stash`
 * argument anywhere in this file, and the parent's working tree is never read at all.
 */
export function createForkWorktreePort(options: { readonly command?: ForkGitCommand; readonly timeoutMs?: number } = {}): ForkWorktreePort {
  const command = options.command ?? (async (file, args, settings) => exec(file, args, settings));
  const timeout = options.timeoutMs ?? 60_000;
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: '/nonexistent',
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0'
  };
  /** One fixed git invocation: hooks off, protocols refused, submodule recursion off, no network, no stash. */
  const git = async (args: string[], cwd: string): Promise<string> => {
    const fixed = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ext.allow=never',
      '-c', 'submodule.recurse=false',
      '-c', 'fetch.recurseSubmodules=no',
      '-c', 'submodule.fetchJobs=1',
      '-c', 'advice.detachedHead=false',
      ...args
    ];
    return (await command('git', fixed, { env: environment, cwd, timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
  };
  return {
    async resolveCommit({ repository, commit }) {
      try {
        const resolved = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', commit + '^{commit}'], repository);
        if (!/^[0-9a-f]{40}$/.test(resolved))
          throw new ForkError('The base commit did not resolve to one commit id of this project\'s own repository', 'INVALID');
        return resolved;
      } catch (error) {
        if (error instanceof ForkError) throw error;
        throw new ForkError('The base commit is not a commit of this project\'s own repository', 'INVALID');
      }
    },
    async create({ repository, path, baseCommit }) {
      try {
        // One fixed argv. There is deliberately no --force, so an occupied target fails instead of
        // being overwritten, and no branch is created: the child is a detached checkout of exactly the
        // recorded commit. Submodule recursion is off by configuration (submodule.recurse and
        // fetch.recurseSubmodules above): 'git worktree add' takes no submodule flag and never
        // initializes a submodule of its own.
        await git(['worktree', 'add', '--detach', '--', path, baseCommit], repository);
      } catch (error) {
        console.error('git worktree add refused: ' + (error as Error).message);
        throw new ForkError('The child worktree could not be created from the recorded base commit', 'WORKTREE');
      }
    },
    async inspect({ path }) {
      const info = await lstat(path).catch(() => null);
      if (info === null) return Object.freeze({ state: 'absent' as const, head: null });
      // A fork target that is not a directory is reported as unreadable rather than interpreted: this
      // build removes a worktree and nothing else, and it never removes something it cannot read.
      if (info.isSymbolicLink() || !info.isDirectory()) return Object.freeze({ state: 'unreadable' as const, head: null });
      try {
        const status = await git(['status', '--porcelain=v1', '--untracked-files=all'], path);
        const head = await git(['rev-parse', 'HEAD'], path).catch(() => '');
        return Object.freeze({
          state: status === '' ? ('clean' as const) : ('dirty' as const),
          head: /^[0-9a-f]{40}$/.test(head) ? head : null
        });
      } catch {
        return Object.freeze({ state: 'unreadable' as const, head: null });
      }
    },
    async remove({ repository, path, force }) {
      try {
        await git(['worktree', 'remove', ...(force ? ['--force'] : []), '--', path], repository);
      } catch {
        throw new ForkError('git refused to remove the child worktree, and nothing was forced', 'WORKTREE');
      }
    }
  };
}
