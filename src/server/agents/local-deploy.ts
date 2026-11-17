import { lstat,mkdir,readlink,realpath,rename,rm,symlink } from 'node:fs/promises';
import { basename,dirname,join,resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ArtifactIdentity } from '../../shared/acceptance';
import { AcceptanceStore } from '../state/acceptance-store';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionIntent, type AcceptedActionPort } from '../state/accepted-action';
import { LocalReleaseStore, localDestinationFingerprint, localDestinationResourceKey, LOCAL_DESTINATION_TARGET_IDS, type LocalDestinationRecord } from '../state/local-release-store';
import {
  approvedRealDirectory, containedDirectory, copyManifest, directoryDigest, discardStaging, directoryManifest,
  generationName, isSafeSegment, LOCAL_RELEASE_CURRENT, LOCAL_RELEASE_GENERATIONS, LOCAL_RELEASE_LIMITS, LOCAL_RELEASE_LINK_PREFIX, LocalReleaseError,
  releaseDigest, stagingDirectory, type ReleaseManifest
} from './local-release';

type Caller = { projectId: string; sessionId: string; agentId: string; authorize: () => Promise<void> };

/**
 * The model-facing shape of the local deploy capability. A caller supplies no path, directory,
 * command or credential: the owner configured the artifact path and the target, and the model only
 * asks for the exact content it previewed to be promoted once.
 */
export type LocalDeployPort = {
  preview(input: Caller): Promise<unknown>;
  deploy(input: Caller & { evidenceId: string; acceptanceId: string; artifact: ArtifactIdentity; signal?: AbortSignal }): Promise<unknown>;
};

/** Test-only ordering seams. The application never sets them from a request or the environment. */
export type LocalReleaseSeam = { readonly beforeSwap?: () => Promise<void>; readonly afterSwap?: () => void };

/**
 * Promote one exact artifact directory of the project into one owner-configured local directory.
 *
 * The mechanism is deliberately small and verifiable:
 *
 * 1. The artifact is read from the project's connected worktree, refused if it holds anything but
 *    regular files, and reduced to a sorted SHA-256 manifest. That digest is the content identity the
 *    acceptance binds; a model never supplies a path or a digest of its own choosing.
 * 2. The files are copied into an owned staging directory *inside* the configured target, and the
 *    staged bytes are read back and compared before anything is promoted.
 * 3. The staging directory is renamed to an immutable generation (`generations/gen-<digest-prefix>`),
 *    and the stable `current` link is replaced atomically by renaming a temporary link over it.
 * 4. The served content is read back through the link and must produce the same digest.
 *
 * A generation is never removed, so the previous one is retained for manual rollback and is recorded
 * in the durable outcome beside the generation that replaced it. Uncertainty is returned rather than
 * retried: the accepted-action intent holds its barrier for the exact target revision and content.
 */
export class LocalDeployService implements LocalDeployPort {
  constructor(private readonly options: {
    store: LocalReleaseStore;
    acceptance: AcceptanceStore;
    executor: AcceptedActionExecutor;
    projectRoot: (projectId: string) => string | undefined;
    approvedRoots: readonly string[];
    /** Refuses a session that cannot dispatch (a frozen or uncertain fork), before any effect. */
    sessionGate?: (projectId: string, sessionId: string) => void;
    seam?: LocalReleaseSeam;
  }) {}

  private targetId(): string { return LOCAL_DESTINATION_TARGET_IDS.deploy; }

  private destination(projectId: string): LocalDestinationRecord {
    const record = this.options.store.readDestination(projectId, 'deploy');
    if (!record || !record.enabled)
      throw new LocalReleaseError('No enabled local deployment target is configured for this project', 'UNAVAILABLE');
    return record;
  }

  private async artifact(projectId: string, record: LocalDestinationRecord): Promise<{ directory: string; manifest: ReleaseManifest }> {
    const root = this.options.projectRoot(projectId);
    if (root === undefined) throw new LocalReleaseError('The project could not be resolved to a connected repository worktree', 'NOT_FOUND');
    if (record.definition.kind !== 'deploy-local') throw new LocalReleaseError('The configured destination is not a deployment target', 'UNAVAILABLE');
    const directory = await containedDirectory(root, record.definition.artifactPath);
    return { directory, manifest: await directoryManifest(directory, LOCAL_RELEASE_LIMITS) };
  }

  private async target(record: LocalDestinationRecord): Promise<string> {
    if (record.definition.kind !== 'deploy-local') throw new LocalReleaseError('The configured destination is not a deployment target', 'UNAVAILABLE');
    return approvedRealDirectory(record.definition.targetDirectory, this.options.approvedRoots);
  }

  /** The generation the stable link currently names, or null. A link this tool did not create is refused. */
  private async currentGeneration(target: string): Promise<string | null> {
    const link = join(target, LOCAL_RELEASE_CURRENT);
    let info;
    try { info = await lstat(link); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!info.isSymbolicLink())
      throw new LocalReleaseError('The stable current path exists and is not a link this build created; it is never replaced', 'REFUSED');
    const pointed = await readlink(link), generations = join(target, LOCAL_RELEASE_GENERATIONS), resolved = resolve(target, pointed);
    if (dirname(resolved) !== generations || !isSafeSegment(basename(resolved)))
      throw new LocalReleaseError('The stable current link points outside the generation directory; it is never followed', 'REFUSED');
    return basename(resolved);
  }

  private async verifyTarget(record: LocalDestinationRecord): Promise<string> {
    const target = await this.target(record);
    const generations = join(target, LOCAL_RELEASE_GENERATIONS);
    try {
      const info = await lstat(generations);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new LocalReleaseError('The generation directory is not a real directory', 'REFUSED');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.currentGeneration(target);
    return target;
  }

  private async verify(projectId: string, record: LocalDestinationRecord, contentDigest: string): Promise<{ directory: string; manifest: ReleaseManifest; target: string }> {
    const artifact = await this.artifact(projectId, record);
    if (artifact.manifest.digest !== contentDigest)
      throw new LocalReleaseError('The built artifact changed since it was previewed; nothing was deployed', 'CONFLICT');
    return { ...artifact, target: await this.verifyTarget(record) };
  }

  async preview(caller: Caller): Promise<unknown> {
    if (typeof caller?.projectId !== 'string' || typeof caller?.sessionId !== 'string' || typeof caller?.agentId !== 'string') throw new LocalReleaseError('Invalid deploy caller', 'INVALID');
    await caller.authorize();
    // The service's own gate, not only the harness one: a preview must refuse in a fork exactly as the
    // effect does, so the refusal does not depend on which tools a prompt text happens to list.
    this.options.sessionGate?.(caller.projectId, caller.sessionId);
    const record = this.destination(caller.projectId), artifact = await this.artifact(caller.projectId, record);
    await this.verifyTarget(record);
    const targetDigest = localDestinationFingerprint(record), contentDigest = artifact.manifest.digest;
    const bound = targetBoundArtifact({ projectId: caller.projectId, actionClass: 'deploy', targetId: this.targetId(), targetRevision: record.revision, targetDigest, contentRevision: 'artifact-' + contentDigest, commit: null });
    await caller.authorize();
    return {
      target: { id: this.targetId(), revision: record.revision, digest: targetDigest, kind: 'local-directory' as const, artifactPath: record.definition.kind === 'deploy-local' ? record.definition.artifactPath : null, current: 'the owner-configured directory is read at execution; no path is returned to the model' },
      artifact: bound, contentDigest, files: artifact.manifest.entries.length, bytes: artifact.manifest.bytes,
      served: { current: LOCAL_RELEASE_CURRENT, generations: LOCAL_RELEASE_GENERATIONS, targetIsRealDirectory: true }
    };
  }

  async deploy(input: Caller & { evidenceId: string; acceptanceId: string; artifact: ArtifactIdentity; signal?: AbortSignal }): Promise<unknown> {
    input.signal?.throwIfAborted();
    if (typeof input?.projectId !== 'string' || typeof input?.sessionId !== 'string' || typeof input?.agentId !== 'string') throw new LocalReleaseError('Invalid deploy caller', 'INVALID');
    await input.authorize();
    input.signal?.throwIfAborted();
    const record = this.destination(input.projectId), snapshot = await this.artifact(input.projectId, record);
    const targetDigest = localDestinationFingerprint(record), contentDigest = snapshot.manifest.digest, targetId = this.targetId();
    const contentRevision = 'artifact-' + contentDigest;
    const bound = targetBoundArtifact({ projectId: input.projectId, actionClass: 'deploy', targetId, targetRevision: record.revision, targetDigest, contentRevision, commit: null });
    if (input.artifact?.revision !== bound.revision || input.artifact.commit !== null)
      throw new LocalReleaseError('The accepted artifact does not bind this exact deployment target and content', 'REFUSED');
    const resourceKey = localDestinationResourceKey(input.projectId, 'deploy', record.definition, contentDigest);
    const caller = input, expected = { record, targetDigest, contentDigest };
    let executed: { generation: string; previous: string | null } | null = null;

    const checkAuthority = async () => {
      await caller.authorize();
      const current = this.options.store.readDestination(caller.projectId, 'deploy');
      if (!current || !current.enabled || current.revision !== expected.record.revision || localDestinationFingerprint(current) !== expected.targetDigest)
        throw new LocalReleaseError('The configured deployment target changed or its revision is no longer in force', 'CONFLICT');
      this.options.sessionGate?.(caller.projectId, caller.sessionId);
      await caller.authorize();
    };

    const inspect = async () => {
      await checkAuthority();
      await this.verify(caller.projectId, expected.record, expected.contentDigest);
      await checkAuthority();
    };

    const effect: AcceptedActionPort = {
      authorize: async (intent: AcceptedActionIntent) => {
        await checkAuthority();
        const view = await this.options.acceptance.readEvidence({ projectId: caller.projectId, evidenceId: intent.evidenceId });
        await checkAuthority();
        if (!view.acceptance || intent.agentId !== caller.agentId || intent.sessionId !== caller.sessionId)
          throw new LocalReleaseError('The session acceptance required for this deployment is unavailable', 'REFUSED');
        return { allowed: true, acceptance: view.acceptance, policy: this.options.acceptance.readPolicy() };
      },
      check: async (intent) => {
        if (intent.actionClass !== 'deploy' || intent.resourceKey !== resourceKey || intent.targetId !== targetId || intent.targetRevision !== expected.record.revision || intent.targetDigest !== expected.targetDigest || intent.contentRevision !== contentRevision || intent.artifact.revision !== bound.revision || intent.artifact.commit !== null)
          throw new LocalReleaseError('The deployment intent is not the accepted target and content', 'REFUSED');
        await inspect();
      },
      execute: async (_intent, signal, revalidate) => {
        signal?.throwIfAborted();
        const verified = await this.verify(caller.projectId, expected.record, expected.contentDigest);
        await revalidate();
        signal?.throwIfAborted();
        const generations = join(verified.target, LOCAL_RELEASE_GENERATIONS);
        await mkdir(generations, { recursive: true, mode: 0o755 });
        const staging = stagingDirectory(verified.target);
        let promoted = false;
        try {
          await copyManifest(verified.directory, verified.manifest, staging);
          const staged = await directoryDigest(staging);
          if (staged !== expected.contentDigest)
            throw new LocalReleaseError('The staged copy does not match the previewed artifact; nothing was deployed', 'CONFLICT');
          await this.options.seam?.beforeSwap?.();
          signal?.throwIfAborted();
          const previous = await this.currentGeneration(verified.target);
          const generation = generationName(expected.contentDigest), destination = join(generations, generation);
          let existing = false;
          try {
            const info = await lstat(destination);
            if (!info.isDirectory() || info.isSymbolicLink())
              throw new LocalReleaseError('A generation already holds this name and is not a real directory', 'REFUSED');
            if (await directoryDigest(destination) !== expected.contentDigest)
              throw new LocalReleaseError('A generation already holds this name with different content', 'CONFLICT');
            existing = true;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (existing) await discardStaging(staging); else await rename(staging, destination);
          promoted = true;
          const temporary = join(verified.target, LOCAL_RELEASE_LINK_PREFIX + randomBytes(8).toString('hex'));
          await symlink(join(LOCAL_RELEASE_GENERATIONS, generation), temporary, 'dir');
          try { await rename(temporary, join(verified.target, LOCAL_RELEASE_CURRENT)); }
          catch (error) { await discardStaging(temporary).catch(() => {}); throw error; }
          this.options.seam?.afterSwap?.();
          const served = await realpath(join(verified.target, LOCAL_RELEASE_CURRENT)).catch(() => undefined);
          if (served === undefined || dirname(served) !== generations || basename(served) !== generation)
            throw new LocalReleaseError('The served content is not the generation this deployment promoted', 'CONFLICT');
          if (await directoryDigest(served) !== expected.contentDigest)
            throw new LocalReleaseError('The served content digest did not match after the swap', 'CONFLICT');
          const externalId = 'deploy-' + generation;
          this.options.store.recordOutcome({
            projectId: caller.projectId, actionClass: 'deploy', artifactRevision: bound.revision, targetRevision: expected.record.revision,
            targetDigest: expected.targetDigest, contentDigest: expected.contentDigest, externalId, previousGeneration: previous
          });
          executed = { generation, previous };
          return { targetId, artifact: bound, externalId };
        } finally {
          if (!promoted) await discardStaging(staging).catch(() => {});
        }
      }
    };

    const outcome = await this.options.executor.run({
      projectId: input.projectId, sessionId: input.sessionId, agentId: input.agentId, evidenceId: input.evidenceId,
      acceptanceId: input.acceptanceId, actionClass: 'deploy', targetId, targetRevision: record.revision, targetDigest,
      contentRevision, artifact: input.artifact, resourceKey
    }, effect, input.signal);
    const landed = executed as { generation: string; previous: string | null } | null;
    return {
      ...outcome,
      target: { id: targetId, revision: record.revision, digest: targetDigest, kind: 'local-directory' as const },
      contentDigest,
      generation: landed === null ? null : landed.generation,
      previousGeneration: landed === null ? null : landed.previous,
      rollback: landed === null ? null : 'Point the stable current link at the retained previous generation to roll back manually; this build never rolls back automatically.'
    };
  }
}
