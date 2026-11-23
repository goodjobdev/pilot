import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promisify } from 'node:util';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ControlStore, ControlStoreError } from './control-store';
import { ForkCreationFence } from './fork-creation-fence';
import { ForkLifecycleFence } from './fork-lifecycle-fence';
import { ForkActivityUncertain } from './fork-activity-uncertain';
import { ForkDispatchNotStarted } from './fork-dispatch-not-started';
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
 * fork record itself starts with a single admission at revision 1. A separate durable creation fence
 * is held before transcript creation, because the transcript can commit before its receipt arrives.
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
 * 4. **A discard is revision-checked and fail-closed.** The application refuses to remove any existing
 *    worktree because pathname-based Git removal is not pinned against concurrent replacement. An
 *    already absent worktree can be closed without deletion. A disposable-test-only seam exercises
 *    ownership checks and Git removal, but is never enabled by the application.
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
const DISPATCH_KIND = 'fork.dispatch';
const DISPATCH_OUTBOX_KIND = 'fork.dispatch';
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
  /** Determine absence without opening the target or running Git. */
  presence(input: { readonly path: string }): Promise<'absent' | 'present'>;
  inspect(input: { readonly path: string }): Promise<ForkWorktreeState>;
  /** Opaque identity of a registered worktree in this repository, or a refusal. */
  identity(input: { readonly repository: string; readonly path: string }): Promise<string>;
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
  /** Refuse unless the child has no running or queued harness work. */
  readonly assertQuiescent?: (projectId: string, childSessionId: string) => Promise<void>;
  /** Disposable-test seam only. The application never enables pathname-based removal. */
  readonly allowUnpinnedRemovalForTests?: boolean;
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
  private readonly canonicalRoots = new Map<string, { path: string; dev: bigint; ino: bigint }>();
  private readonly creationFence: ForkCreationFence;
  private readonly lifecycleFence: ForkLifecycleFence;
  private readonly toolFenceContext = new AsyncLocalStorage<{ projectId: string; sessionId: string; token: string; uncertain: boolean; closed: boolean; nested: number }>();
  constructor(private readonly store: ControlStore, private readonly options: ForkStoreOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.creationFence = new ForkCreationFence(store);
    this.lifecycleFence = new ForkLifecycleFence(store);
  }

  /** Block a potentially unrecorded child during creation, including after a crash. */
  assertCreationDispatchable(projectId: string, sessionId: string): void {
    this.creationFence.assertDispatchable(projectId, sessionId);
    const context = this.toolFenceContext.getStore();
    const token = context?.projectId === projectId && context.sessionId === sessionId && !context.uncertain && !context.closed ? context.token : undefined;
    this.lifecycleFence.assertDispatchable(projectId, sessionId, token);
  }

  /**
   * Reserve the same durable fence as resume/discard for a child tool's awaited execution. A
   * competing lifecycle operation cannot remove the worktree between a tool's gate and its return.
   * This is not process containment: a detached subprocess can outlive the tool and this fence.
   * If the process dies while held, the durable fence remains held for operator review.
   */
  async withToolFence<T>(projectId: string, sessionId: string, work: () => Promise<T>): Promise<T> {
    const fork = this.read(projectId, sessionId);
    if (!fork) { this.assertCreationDispatchable(projectId, sessionId); return work(); }
    const context = this.toolFenceContext.getStore();
    const existing = this.lifecycleFence.read(projectId, sessionId);
    if(context?.projectId===projectId&&context.sessionId===sessionId&&(context.closed||context.uncertain))throw new ForkError('This fork activity is closed or uncertain; operator review is required.','CONFLICT');
    if (context?.projectId === projectId && context.sessionId === sessionId && existing?.state === 'held' && existing.token === context.token) {
      if(context.uncertain||context.closed)throw new ForkError('This fork activity is uncertain; operator review is required.','CONFLICT');
      this.assertCreationDispatchable(projectId, sessionId);
      context.nested++;
      try{return await work();}catch(error){if(error instanceof ForkActivityUncertain)context.uncertain=true;throw error;}finally{context.nested--;}
    }
    const held = this.lifecycleFence.acquire(projectId, sessionId),owner={projectId,sessionId,token:held.token,uncertain:false,closed:false,nested:0};
    return this.toolFenceContext.run(owner, async () => {
      try {
        this.assertCreationDispatchable(projectId, sessionId);
        if (this.read(projectId, sessionId)?.state !== 'active') throw new ForkError('This fork is not active; the tool was not started.', 'ILLEGAL');
        return await work();
      } catch(error) {
        if(error instanceof ForkActivityUncertain)owner.uncertain=true;
        throw error;
      } finally {
        owner.closed=true;
        // An inherited async context is not ownership after its parent returns. Outstanding nested
        // work makes the fence uncertain; no late descendant can release or reuse it.
        if(owner.nested>0)owner.uncertain=true;
        if(!owner.uncertain)this.lifecycleFence.release(projectId, sessionId, held);
      }
    });
  }

  /** The owner-visible state omits the private fence token and makes no claim about liveness. */
  creationStatus(projectId: string): { state: 'held'; revision: number; parentSessionId: string } | null {
    const fence = this.creationFence.read(projectId);
    return fence?.state === 'held' ? { state: 'held', revision: fence.revision, parentSessionId: fence.parentSessionId } : null;
  }

  lifecycleStatus(projectId: string, childSessionId: string): { state: 'held'; revision: number; childSessionId: string } | null {
    const fence = this.lifecycleFence.read(projectId, childSessionId);
    return fence?.state === 'held' ? { state: 'held', revision: fence.revision, childSessionId } : null;
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
    if (cached !== undefined) {
      try {
        const info = await lstat(cached.path, { bigint: true });
        if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== cached.dev || info.ino !== cached.ino || await realpath(candidate) !== cached.path) throw new Error('Fork root changed');
        return cached.path;
      } catch { throw new ForkError('The designated fork root changed or is unavailable; operator review is required.', 'OUTSIDE_ROOT'); }
    }
    try {
      await mkdir(candidate, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.error('The fork root could not be created: ' + (error as Error).message);
      throw new ForkError('The designated fork root could not be created, so no worktree could be prepared; nothing was created.', 'STORAGE');
    }
    const info = await lstat(candidate, { bigint: true }).catch(() => null);
    if (info === null || info.isSymbolicLink() || !info.isDirectory())
      throw new ForkError('The designated fork root is not a real directory, so no worktree could be prepared; nothing was created.', 'STORAGE');
    const canonical = await realpath(candidate);
    const stable = await lstat(canonical, { bigint: true });
    if (stable.isSymbolicLink() || !stable.isDirectory() || stable.dev !== info.dev || stable.ino !== info.ino)
      throw new ForkError('The designated fork root changed while it was checked; operator review is required.', 'OUTSIDE_ROOT');
    this.canonicalRoots.set(projectId, { path: canonical, dev: stable.dev, ino: stable.ino });
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
    if (requested !== null) await this.assertTargetFree(projectId, root, requested);
    // The transcript can commit before its caller receives the child ID. Reserve first, and never
    // clear this fence on an uncertain failure: another session could otherwise reach an orphan.
    const held = this.creationFence.acquire(projectId, parentSessionId);
    let recorded = false, beforeFork = true;
    try {
    // Other creations may have completed since the earlier budget check.
    if (this.list(projectId).length >= FORK_MAX_FORKS)
      throw new ForkError('The project reached its fork limit before this creation was admitted; nothing was created.', 'BOUNDED');
    // The earlier filesystem check is advisory. Recheck while holding the project-wide creation
    // reservation, before a transcript can be created, against both the filesystem and records.
    if (requested !== null) await this.assertTargetFree(projectId, root, requested);
    beforeFork = false;
    const child = await this.callTranscript('fork the transcript', () => this.options.transcripts.fork({ projectId, parentSessionId, cutoffEntryId }));
    const childSessionId = parseForkIdentifier(child.childSessionId, 'childSessionId');
    const component = requested ?? childSessionId;
    await this.assertTargetFree(projectId, root, component);
    const path = await this.worktreePath(root, component);
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
      recorded = true;
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
      recorded = true;
      return Object.freeze({ fork: failed, created: false, adopted });
    }
    // A successful Git return is not enough to authorize a later deletion. Persist an opaque
    // child-to-worktree identity before making the successful fork visible or lifting the fence.
    let fingerprint: string;
    try { fingerprint = await this.options.worktrees.identity({ repository, path }); }
    catch { throw new ForkError('The new worktree identity could not be verified; the creation fence remains held for operator review.', 'UNAVAILABLE'); }
    this.recordOwnership(projectId, childSessionId, fingerprint);
    const record = this.write(createdForkRecord({
      projectId, parentSessionId, cutoffEntryId, childSessionId, worktreePath: path, baseCommit: commit, now
    }));
    recorded = true;
    return Object.freeze({ fork: record, created: true, adopted });
    } finally {
      if (beforeFork || recorded) this.creationFence.release(projectId, held);
    }
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
    const projectId = parseForkIdentifier(input.projectId, 'projectId'), childSessionId = parseForkIdentifier(input.childSessionId, 'childSessionId');
    const held = this.lifecycleFence.acquire(projectId, childSessionId);
    try {
    const current = this.require(projectId, childSessionId);
    const revision = parseForkRevision(input.revision);
    // The declared no-op: an already active fork answers 'unchanged' before the revision is compared,
    // so it accepts any revision and writes nothing new. See the note above and docs/FORKS.md — the
    // revision still guards every transition that really writes.
    if (current.state === 'active') return Object.freeze({ fork: current, outcome: 'unchanged' as const, removed: false });
    this.assertRevision(current, revision);
    const next = nextForkRecord(current, { state: 'active', attention: null, now: this.clock() });
    const record = this.write(next);
    return Object.freeze({ fork: record, outcome: 'resumed' as const, removed: false });
    } finally { this.lifecycleFence.release(projectId, childSessionId, held); }
  }

  /**
   * Close a non-active fork only after its recorded worktree is already absent. Active forks cannot
   * be discarded: input admission is not atomic with lifecycle transitions, so a quiescent view may
   * miss an in-flight submission. Existing worktrees are never removed in the application: an identity
   * check followed by a pathname-based Git command leaves a replacement race. The unpinned removal
   * implementation remains available only to disposable tests.
   */
  async discard(input: { readonly projectId: unknown; readonly childSessionId: unknown; readonly revision: unknown; readonly force?: unknown }): Promise<ForkActionResult> {
    const projectId = parseForkIdentifier(input.projectId, 'projectId'), childSessionId = parseForkIdentifier(input.childSessionId, 'childSessionId');
    const held = this.lifecycleFence.acquire(projectId, childSessionId);
    let removalUncertain = false;
    try {
    const current = this.require(projectId, childSessionId);
    if (current.state === 'discarded') return Object.freeze({ fork: current, outcome: 'unchanged' as const, removed: false });
    this.assertRevision(current, parseForkRevision(input.revision));
    if (current.state === 'active')
      throw new ForkError('Discarding an active fork is unavailable: concurrent input admission cannot yet be ruled out. Nothing was removed or changed.', 'UNAVAILABLE');
    const force = input.force === true;
    const root = await this.root(current.projectId);
    this.assertInsideRoot(root, current);
    if (!this.options.assertQuiescent) throw new ForkError('Fork quiescence cannot be verified; the worktree was not removed.', 'UNAVAILABLE');
    await this.options.assertQuiescent(projectId, childSessionId);
    const repository = await this.repository(current.projectId);
    let present: 'present' | 'absent';
    try { present = await this.options.worktrees.presence({ path: current.worktreePath }); }
    catch { throw new ForkError('The worktree presence cannot be verified; nothing was removed.', 'UNAVAILABLE'); }
    if (present === 'absent')
      return Object.freeze({ fork: this.write(nextForkRecord(current, { state: 'discarded', attention: null, now: this.clock() })), outcome: 'discarded' as const, removed: false });
    if (!this.options.allowUnpinnedRemovalForTests)
      throw new ForkError('Automatic removal of an existing fork worktree is unavailable: its pathname cannot be safely pinned against concurrent replacement. No worktree was removed.', 'UNAVAILABLE');
    const fingerprint = this.ownership(current.projectId, current.childSessionId);
    if (!fingerprint || this.records(current.projectId).some(other => other.childSessionId !== current.childSessionId && other.state !== 'discarded' && other.worktreePath === current.worktreePath))
      throw new ForkError('Worktree ownership is missing or conflicts with another fork; operator review is required and nothing was removed.', 'CONFLICT');
    const verifyIdentity = async () => {
      let observed: string;
      try { observed = await this.options.worktrees.identity({ repository, path: current.worktreePath }); }
      catch { throw new ForkError('Worktree identity cannot be verified; operator review is required and nothing was removed.', 'CONFLICT'); }
      if (observed !== fingerprint) throw new ForkError('Worktree identity changed; operator review is required and nothing was removed.', 'CONFLICT');
    };
    await verifyIdentity();
    const state = await this.options.worktrees.inspect({ path: current.worktreePath });
    if (state.state === 'absent')
      return Object.freeze({ fork: this.write(nextForkRecord(current, { state: 'discarded', attention: null, now: this.clock() })), outcome: 'discarded' as const, removed: false });
    if (state.state === 'unreadable')
      return Object.freeze({ fork: this.attention(current, 'worktree-unreadable'), outcome: 'attention' as const, removed: false });
    if (state.state === 'dirty' && !force)
      return Object.freeze({ fork: this.attention(current, 'worktree-dirty'), outcome: 'attention' as const, removed: false });
    await verifyIdentity();
    try {
      removalUncertain = true;
      await this.options.worktrees.remove({ repository, path: current.worktreePath, force: state.state === 'dirty' });
    } catch (error) {
      console.error('The child worktree removal of fork ' + current.childSessionId + ' could not be confirmed: ' + (error as Error).message);
      const failed = this.attention(current, 'worktree-remove-refused');
      removalUncertain = false;
      return Object.freeze({ fork: failed, outcome: 'attention' as const, removed: false });
    }
    const record = this.write(nextForkRecord(current, { state: 'discarded', attention: null, now: this.clock() }));
    removalUncertain = false;
    return Object.freeze({ fork: record, outcome: 'discarded' as const, removed: true });
    } finally {
      if (!removalUncertain) this.lifecycleFence.release(projectId, childSessionId, held);
    }
  }

  /**
   * Owner recovery for a **held lifecycle fence**. A process that died while the fence was held leaves
   * the child permanently blocked, and this build deliberately has no automatic recovery. This action
   * releases the fence only after the owner has read its revision and the child is proven quiescent;
   * it dispatches nothing, replays nothing, removes nothing and makes no claim that the interrupted
   * effect stopped. A fork whose worktree was left dirty still needs an explicit operator decision.
   */
  async recoverLifecycleFence(input: { readonly projectId: unknown; readonly childSessionId: unknown; readonly revision: unknown }): Promise<{ readonly released: true; readonly revision: number }> {
    const projectId = parseForkIdentifier(input.projectId, 'projectId'), childSessionId = parseForkIdentifier(input.childSessionId, 'childSessionId');
    const fence = this.lifecycleFence.read(projectId, childSessionId);
    if (!fence || fence.state !== 'held') throw new ForkError('No fork lifecycle fence is held for this child, so there is nothing to release.', 'NOT_FOUND');
    if (fence.revision !== parseForkRevision(input.revision)) throw new ForkError('The fork lifecycle fence changed; re-read it before releasing it. Nothing was released.', 'CONFLICT');
    const record = this.read(projectId, childSessionId);
    if (!record) throw new ForkError('The fork record is unavailable; nothing was released.', 'NOT_FOUND');
    if (record.state === 'discarded') throw new ForkError('A discarded fork has no lifecycle fence to release.', 'ILLEGAL');
    if (!this.options.assertQuiescent) throw new ForkError('Fork quiescence cannot be verified, so the fence is not released.', 'UNAVAILABLE');
    await this.options.assertQuiescent(projectId, childSessionId);
    this.lifecycleFence.release(projectId, childSessionId, fence);
    return Object.freeze({ released: true as const, revision: fence.revision + 1 });
  }

  /**
   * Owner recovery for a **held creation fence**. The fence is recorded per parent session and is held
   * while a fork is being created; a crash leaves it held and blocks every later creation from that
   * parent. Releasing it requires the exact revision and a quiescent parent session, and creates
   * nothing: the owner inspects whether a fork record exists before creating again.
   */
  async recoverCreationFence(input: { readonly projectId: unknown; readonly parentSessionId: unknown; readonly revision: unknown }): Promise<{ readonly released: true; readonly revision: number }> {
    const projectId = parseForkIdentifier(input.projectId, 'projectId'), parentSessionId = parseForkIdentifier(input.parentSessionId, 'parentSessionId');
    const fence = this.creationFence.read(projectId);
    if (!fence || fence.state !== 'held') throw new ForkError('No fork creation fence is held for this project, so there is nothing to release.', 'NOT_FOUND');
    if (fence.parentSessionId !== parentSessionId) throw new ForkError('The held creation fence belongs to a different parent session; nothing was released.', 'NOT_FOUND');
    if (fence.revision !== parseForkRevision(input.revision)) throw new ForkError('The fork creation fence changed; re-read it before releasing it. Nothing was released.', 'CONFLICT');
    if (!this.options.assertQuiescent) throw new ForkError('Session quiescence cannot be verified, so the fence is not released.', 'UNAVAILABLE');
    await this.options.assertQuiescent(projectId, parentSessionId);
    this.creationFence.release(projectId, fence);
    return Object.freeze({ released: true as const, revision: fence.revision + 1 });
  }

  /**
   * Dispatch one input into the child of one fork. Ordinary session submissions and lifecycle
   * dispatches also reach child conversations and must check the same durable fork state.
   *
   * The durable state is read first, so a fork that is not `active` refuses **in words** and the
   * transcript port is not called if that read observes a paused child. The action's lifecycle fence
   * then excludes competing lifecycle changes until the admitted durable submission settles. Each
   * logical invocation supplies a stable idempotency identity; a retry must reuse it, and distinct
   * work must not.
   */
  /**
   * Hold the durable lifecycle fence across this fork action's full child submission wait. This does
   * not prove provider quiescence or contain detached processes; ordinary harness submissions,
   * question delivery and lifecycle replay remain separate unfenced paths. A submission failure
   * after admission has an uncertain outcome, so the fence remains held for operator review.
   */
  async dispatchChild(input: { readonly projectId: unknown; readonly parentSessionId: unknown; readonly childSessionId: unknown; readonly text: unknown; readonly invocationId: unknown }): Promise<{ readonly requestId: string }> {
    const current = this.require(input.projectId, input.childSessionId);
    // Authority is the caller's own lineage, not merely project membership: a caller may dispatch only
    // into a fork whose recorded parent is the conversation it is acting from. Anything else is refused
    // in the same words as an unknown child, so no fork's existence is disclosed to a non-owner caller.
    const caller = parseForkIdentifier(input.parentSessionId, 'parentSessionId');
    if (caller !== current.parentSessionId) throw new ForkError('This child session is not a fork of this conversation.', 'NOT_FOUND');
    this.assertCreationDispatchable(current.projectId, current.childSessionId);
    const refusal = forkDispatchRefusal(current);
    if (refusal !== null) throw new ForkError(refusal, 'ILLEGAL');
    const text = parseForkDispatchText(input.text);
    const invocationId = parseForkInvocationId(input.invocationId);
    return this.withToolFence(current.projectId, current.childSessionId, async () => {
      const admitted = this.require(current.projectId, current.childSessionId);
      const refusal = forkDispatchRefusal(admitted);
      if (refusal !== null) throw new ForkError(refusal, 'ILLEGAL');
      const invocationDigest = createHash('sha256').update(invocationId).digest('hex');
      const contentDigest = createHash('sha256').update(text).digest('hex');
      const requestId = 'fork:' + admitted.childSessionId + ':' + invocationDigest;
      const scope = { projectId: admitted.projectId, sessionId: admitted.childSessionId };
      let operation: OperationRecord;
      try {
        const admission = this.store.admit({
          scope,
          idempotencyKey: 'fork-dispatch.' + invocationDigest,
          kind: DISPATCH_KIND,
          input: { version: 1, projectId: admitted.projectId, childSessionId: admitted.childSessionId, invocationDigest, contentDigest, requestId },
          outbox: { kind: DISPATCH_OUTBOX_KIND, payload: { version: 1, requestId } }
        });
        operation = admission.operation;
        const outbox = this.outboxFor(operation.id, scope);
        const payload = outbox.payload as Record<string, unknown> | null;
        if (operation.kind !== DISPATCH_KIND || outbox.kind !== DISPATCH_OUTBOX_KIND || outbox.state !== 'pending' || outbox.operationId !== operation.id || !payload || Object.keys(payload).sort().join(',') !== 'requestId,version' || payload.version !== 1 || payload.requestId !== requestId)
          throw new ForkError('The durable child-dispatch identity is corrupt; operator review is required.', 'CORRUPT');
        if (admission.existing) {
          if (operation.state === 'succeeded') {
            const receipt = operation.receipt as Record<string, unknown> | null;
            if (!operation.receiptPresent || !receipt || Object.keys(receipt).sort().join(',') !== 'requestId,version' || receipt.version !== 1 || receipt.requestId !== requestId)
              throw new ForkError('The completed child-dispatch receipt is corrupt; operator review is required.', 'CORRUPT');
            return Object.freeze({ requestId });
          }
          if (operation.state === 'failed')
            throw new ForkError('This invocation was already refused before submission; use a new invocation identity for a deliberate new attempt.', 'CONFLICT');
          throw new ForkActivityUncertain();
        }
      } catch (error) {
        if (error instanceof ForkError || error instanceof ForkActivityUncertain) throw error;
        if (error instanceof ControlStoreError && error.code === 'CONFLICT')
          throw new ForkError('This invocation identity was already admitted with different input; no submission was made.', 'CONFLICT');
        throw new ForkError('The durable child-dispatch identity could not be recorded; no submission was made.', 'STORAGE');
      }
      try {
        // Wait for the durable child submission while retaining this lifecycle fence and async context.
        await this.options.transcripts.dispatch({ projectId: admitted.projectId, childSessionId: admitted.childSessionId, requestId, text });
      } catch (error) {
        if (error instanceof ForkDispatchNotStarted) {
          try { this.store.updateOperation(operation.id, scope, operation.revision, 'failed', { version: 1, requestId, outcome: 'not-submitted' }); }
          catch { throw new ForkActivityUncertain(); }
          throw new ForkError(error.message, 'UNAVAILABLE');
        }
        try { this.store.updateOperation(operation.id, scope, operation.revision, 'unknown', { version: 1, requestId, outcome: 'uncertain' }); }
        catch { /* Pending admission is also non-replayable. */ }
        throw new ForkActivityUncertain();
      }
      try { this.store.updateOperation(operation.id, scope, operation.revision, 'succeeded', { version: 1, requestId }); }
      catch { throw new ForkActivityUncertain(); }
      return Object.freeze({ requestId });
    });
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
  private async assertTargetFree(projectId: string, root: string, component: string): Promise<void> {
    const path = await this.worktreePath(root, component);
    const existing = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ForkError('The fork target cannot be checked; nothing was created.', 'UNAVAILABLE'); });
    if (existing !== null || this.records(projectId).some(record => record.state !== 'discarded' && record.worktreePath === path))
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

  private recordOwnership(projectId: string, childSessionId: string, fingerprint: string): void {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new ForkError('Worktree identity is invalid; the creation fence remains held.', 'CORRUPT');
    const result = this.store.admit({ scope: { projectId, sessionId: childSessionId }, idempotencyKey: 'fork.ownership', kind: 'fork.worktree-ownership', input: { version: 1, projectId, childSessionId, fingerprint }, outbox: { kind: 'fork.worktree-ownership', payload: { version: 1, projectId, childSessionId } } });
    if (result.existing) throw new ForkError('Worktree ownership already exists; the creation fence remains held.', 'CONFLICT');
  }

  private ownership(projectId: string, childSessionId: string): string | null {
    const scope = { projectId, sessionId: childSessionId };
    const rows = this.rows('SELECT id FROM operations WHERE project_id=? AND session_id=? AND idempotency_key=? LIMIT 2', [projectId, childSessionId, 'fork.ownership']);
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ForkError('Fork ownership is ambiguous; nothing was removed.', 'CORRUPT');
    const operation = this.store.getOperation(String(rows[0].id), scope), value = operation.input as Record<string, unknown> | null;
    const outbox = this.outboxFor(operation.id, scope), payload = outbox.payload as Record<string, unknown> | null;
    if (operation.kind !== 'fork.worktree-ownership' || !value || Object.keys(value).sort().join(',') !== 'childSessionId,fingerprint,projectId,version' || value.version !== 1 || value.projectId !== projectId || value.childSessionId !== childSessionId || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) || outbox.kind !== 'fork.worktree-ownership' || outbox.state !== 'pending' || !payload || payload.version !== 1 || payload.projectId !== projectId || payload.childSessionId !== childSessionId)
      throw new ForkError('Fork ownership is corrupt; nothing was removed.', 'CORRUPT');
    return value.fingerprint;
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

/** A caller-owned idempotency identity, stable for retries and distinct for separate dispatches. */
function parseForkInvocationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    throw new ForkError('A stable invocation identity is required for child dispatch; no request was submitted.', 'INVALID');
  return value;
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
      '-c', 'core.fsmonitor=false',
      '-c', 'maintenance.auto=false',
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
    async presence({ path }) {
      try { await lstat(path); return 'present' as const; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent' as const; throw error; }
    },
    async inspect({ path }) {
      const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
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
    async identity({ repository, path }) {
      // This is an identity check, not a sandbox: a hostile same-UID process can still race Git
      // after this check. No raw path or metadata leaves this port; only the digest is retained.
      const directory = await lstat(path, { bigint: true });
      if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('Not a worktree directory');
      const file = await open(join(path, '.git'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: Buffer, meta: Awaited<ReturnType<typeof file.stat>>;
      try {
        meta = await file.stat();
        if (!meta.isFile() || meta.size < 1 || meta.size > 4096) throw new Error('Invalid worktree metadata');
        const bytes = Buffer.alloc(4097), read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== meta.size || read.bytesRead > 4096) throw new Error('Changed worktree metadata');
        content = bytes.subarray(0, read.bytesRead);
      } finally { await file.close(); }
      const registered = (await git(['worktree', 'list', '--porcelain', '-z'], repository)).split('\0').includes('worktree ' + path);
      const repoCommon = await realpath(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repository));
      const childCommon = await realpath(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path));
      if (!registered || repoCommon !== childCommon) throw new Error('Worktree is not registered to the configured repository');
      const common = await lstat(repoCommon, { bigint: true });
      if (common.isSymbolicLink() || !common.isDirectory()) throw new Error('Invalid repository metadata');
      return createHash('sha256').update(JSON.stringify({ path, common: repoCommon, dev: String(directory.dev), ino: String(directory.ino), commonDev: String(common.dev), commonIno: String(common.ino), metadata: content.toString('base64') })).digest('hex');
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
