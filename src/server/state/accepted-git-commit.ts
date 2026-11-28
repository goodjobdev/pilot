import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../../shared/model';
import { isWorkspacePath } from '../../shared/workspace';
import { WorkspaceStore } from '../workspace';
import { targetBoundArtifact, type AcceptedActionAuthorization, type AcceptedActionIntent, type AcceptedActionPort } from './accepted-action';

/**
 * A local Git plumbing adapter for one owner-configured Pilot branch, installed only behind the
 * default-off commit switch. It never stages files, invokes a shell, pushes or selects a target from
 * model input.
 * The accepted revision hashes the target identity, target configuration revision and exact staged
 * tree; the accepted commit must be the exact existing HEAD. Git writes an immutable commit object, then updates only the named
 * branch with a compare-and-swap. A lost result remains uncertain in the durable action executor.
 */
export function acceptedGitCommitPort(options: {
  project: Project;
  targetId: string;
  targetRevision: number;
  targetDigest: string;
  workspace: WorkspaceStore;
  authorize(intent: AcceptedActionIntent): Promise<AcceptedActionAuthorization>;
}): AcceptedActionPort & { preview(): Promise<{ artifact: { revision: string; commit: string }; contentRevision: string; target: { id: string; revision: number; digest: string; branch: string }; changedPaths: string[]; totalPaths: number; truncated: boolean }> } {
  const branch = 'refs/heads/work/pilot-' + options.project.id.slice(0, 8);
  const git = (args: string[]) => options.workspace.localGit(options.project, ['--no-replace-objects', ...args]);
  const checkBranch = async () => {
    if ((await git(['symbolic-ref', '--no-recurse', 'HEAD'])).trim() !== branch) throw new Error('The configured branch changed.');
    const refs = (await git(['for-each-ref', '--format=%(refname)%00%(symref)', branch])).split('\n');
    if (!refs.includes(branch + '\0')) throw new Error('The configured branch is missing or symbolic.');
  };
  const snapshot = async (): Promise<{ tree: string; parent: string; names: string[] }> => {
    const meta = await lstat(join(options.project.path, '.git'));
    if (meta.isSymbolicLink() || (!meta.isFile() && !meta.isDirectory())) throw new Error('The configured repository is unavailable.');
    const top = (await git(['rev-parse', '--show-toplevel'])).trim();
    if (await realpath(top) !== await realpath(options.project.path)) throw new Error('The configured repository root changed.');
    await checkBranch();
    const parent = (await git(['rev-parse', '--verify', 'HEAD'])).trim(), tree = (await git(['write-tree'])).trim();
    if (!/^[a-f0-9]{40}$/.test(parent) || !/^[a-f0-9]{40}$/.test(tree)) throw new Error('The Git object format is unsupported.');
    const names = (await git(['diff-tree', '--no-commit-id', '--no-renames', '-r', '--name-only', '-z', parent, tree])).split('\0').filter(Boolean);
    if (names.length === 0 || names.length > 5000 || names.some(path => !isWorkspacePath(path))) throw new Error('The staged change is empty, too large, or includes a refused path.');
    const entries = (await git(['ls-tree', '-r', '-z', '--full-tree', tree, '--', ...names])).split('\0').filter(Boolean);
    if (entries.some(entry => !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry))) throw new Error('The staged change includes a symlink or unsupported object.');
    await checkBranch();
    if ((await git(['rev-parse', '--verify', 'HEAD'])).trim() !== parent || (await git(['write-tree'])).trim() !== tree)
      throw new Error('The Git snapshot changed while it was inspected.');
    return { tree, parent, names };
  };
  const validate = async (intent: AcceptedActionIntent): Promise<{ tree: string; parent: string }> => {
    if (intent.actionClass !== 'commit' || intent.projectId !== options.project.id || intent.targetId !== options.targetId || intent.targetRevision !== options.targetRevision || intent.targetDigest !== options.targetDigest)
      throw new Error('The configured commit target changed or does not match.');
    const current = await snapshot();
    const contentRevision = 'tree-' + current.tree;
    const artifact = targetBoundArtifact({ projectId: options.project.id, actionClass: 'commit', targetId: options.targetId, targetRevision: options.targetRevision, targetDigest: options.targetDigest, contentRevision, commit: current.parent });
    if (intent.contentRevision !== contentRevision || intent.artifact.revision !== artifact.revision || intent.artifact.commit !== artifact.commit) throw new Error('The staged tree, parent or bound target changed after acceptance.');
    return current;
  };
  return {
    authorize: options.authorize,
    preview: async () => {
      const { tree, parent, names } = await snapshot(), contentRevision = 'tree-' + tree;
      const artifact = targetBoundArtifact({ projectId: options.project.id, actionClass: 'commit', targetId: options.targetId, targetRevision: options.targetRevision, targetDigest: options.targetDigest, contentRevision, commit: parent });
      return { artifact: { revision: artifact.revision, commit: parent }, contentRevision, target: { id: options.targetId, revision: options.targetRevision, digest: options.targetDigest, branch }, changedPaths: names.slice(0, 50), totalPaths: names.length, truncated: names.length > 50 };
    },
    check: async intent => { await validate(intent); },
    execute: async (intent, signal, revalidate) => options.workspace.exclusive(options.project, async () => {
      signal?.throwIfAborted();
      const { tree, parent } = await validate(intent);
      await revalidate(); signal?.throwIfAborted();
      const commit = (await git(['-c', 'user.name=Pilot', '-c', 'user.email=pilot@localhost', '-c', 'author.name=Pilot', '-c', 'author.email=pilot@localhost', '-c', 'committer.name=Pilot', '-c', 'committer.email=pilot@localhost', 'commit-tree', tree, '-p', parent, '-m', 'Pilot: accepted changes'])).trim();
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Git did not report a valid commit.');
      await revalidate(); signal?.throwIfAborted();
      // Detect substitutions visible after object creation. This is not atomic with update-ref.
      await validate(intent); signal?.throwIfAborted();
      // Authority and ref identity checks cannot be atomic with Git's ref update.
      await revalidate(); signal?.throwIfAborted();
      // Do not follow a concurrently substituted symbolic ref to a different target branch.
      await git(['update-ref', '--no-deref', branch, commit, parent]);
      return { targetId: intent.targetId, artifact: intent.artifact, externalId: commit };
    })
  };
}
