import { lstat,mkdir,rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactIdentity } from '../../shared/acceptance';
import { AcceptanceStore } from '../state/acceptance-store';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionIntent, type AcceptedActionPort } from '../state/accepted-action';
import { LocalReleaseStore, localDestinationFingerprint, localDestinationResourceKey, LOCAL_DESTINATION_TARGET_IDS, type LocalDestinationRecord } from '../state/local-release-store';
import {
  approvedRealDirectory, copyManifest, directoryDigest, discardStaging, fileListManifest, generationName,
  LOCAL_RELEASE_LIMITS, LocalReleaseError, stagingDirectory, type ReleaseManifest
} from './local-release';
import type { LocalReleaseSeam } from './local-deploy';

type Caller = { projectId: string; sessionId: string; agentId: string; authorize: () => Promise<void> };

/** The model-facing shape of the local publish capability: reviewed files, and no destination. */
export type LocalPublishPort = {
  preview(input: Caller & { files: readonly unknown[] }): Promise<unknown>;
  publish(input: Caller & { files: readonly unknown[]; evidenceId: string; acceptanceId: string; artifact: ArtifactIdentity; signal?: AbortSignal }): Promise<unknown>;
};

/**
 * Copy one exact, bounded set of reviewed static files into one owner-configured publication root.
 *
 * The publication is an immutable directory named after the manifest digest:
 * `<publicationRoot>/publish-<digest-prefix>`. The files are first copied into an owned staging
 * directory inside the root and read back; only then is the staging directory renamed to its
 * published name with one atomic rename. The published directory is read back again and its digest
 * must match. A path that escapes the project worktree, a symlink at any component, a non-regular
 * file, an oversize file and an oversize total are refused before anything is copied.
 *
 * This is a local filesystem publication, not a provider or CDN channel, and it keeps no rollback
 * pointer: publishing cannot remove or replace an earlier publication. The stable `current` link,
 * when one exists, is only ever created by this same tool and points inside `published/`.
 */
export class LocalPublishService implements LocalPublishPort {
  constructor(private readonly options: {
    store: LocalReleaseStore;
    acceptance: AcceptanceStore;
    executor: AcceptedActionExecutor;
    projectRoot: (projectId: string) => string | undefined;
    approvedRoots: readonly string[];
    sessionGate?: (projectId: string, sessionId: string) => void;
    seam?: LocalReleaseSeam;
  }) {}

  private targetId(): string { return LOCAL_DESTINATION_TARGET_IDS.publish; }

  private destination(projectId: string): LocalDestinationRecord {
    const record = this.options.store.readDestination(projectId, 'publish');
    if (!record || !record.enabled)
      throw new LocalReleaseError('No enabled local publication root is configured for this project', 'UNAVAILABLE');
    return record;
  }

  private async files(projectId: string, record: LocalDestinationRecord, files: readonly unknown[]): Promise<{ root: string; manifest: ReleaseManifest }> {
    const root = this.options.projectRoot(projectId);
    if (root === undefined) throw new LocalReleaseError('The project could not be resolved to a connected repository worktree', 'NOT_FOUND');
    if (record.definition.kind !== 'publish-local') throw new LocalReleaseError('The configured destination is not a publication root', 'UNAVAILABLE');
    return { root, manifest: await fileListManifest(root, files, LOCAL_RELEASE_LIMITS) };
  }

  private async root(record: LocalDestinationRecord): Promise<string> {
    if (record.definition.kind !== 'publish-local') throw new LocalReleaseError('The configured destination is not a publication root', 'UNAVAILABLE');
    return approvedRealDirectory(record.definition.publicationRoot, this.options.approvedRoots);
  }

  /** The publication root is a real directory under an approved root, re-resolved at each check. */
  private async verifyRoot(record: LocalDestinationRecord): Promise<string> {
    return this.root(record);
  }

  private async verify(projectId: string, record: LocalDestinationRecord, contentDigest: string, files: readonly unknown[]): Promise<{ root: string; manifest: ReleaseManifest; publicationRoot: string }> {
    const resolved = await this.files(projectId, record, files);
    if (resolved.manifest.digest !== contentDigest)
      throw new LocalReleaseError('The named files changed since they were previewed; nothing was published', 'CONFLICT');
    return { ...resolved, publicationRoot: await this.verifyRoot(record) };
  }

  async preview(caller: Caller & { files: readonly unknown[] }): Promise<unknown> {
    if (typeof caller?.projectId !== 'string' || typeof caller?.sessionId !== 'string' || typeof caller?.agentId !== 'string') throw new LocalReleaseError('Invalid publish caller', 'INVALID');
    await caller.authorize();
    // The service's own gate, not only the harness one: a preview must refuse in a fork exactly as the
    // effect does, so the refusal does not depend on which tools a prompt text happens to list.
    this.options.sessionGate?.(caller.projectId, caller.sessionId);
    const record = this.destination(caller.projectId), resolved = await this.files(caller.projectId, record, caller.files);
    await this.verifyRoot(record);
    const targetDigest = localDestinationFingerprint(record), contentDigest = resolved.manifest.digest;
    const bound = targetBoundArtifact({ projectId: caller.projectId, actionClass: 'publish', targetId: this.targetId(), targetRevision: record.revision, targetDigest, contentRevision: 'artifact-' + contentDigest, commit: null });
    await caller.authorize();
    return {
      target: { id: this.targetId(), revision: record.revision, digest: targetDigest, kind: 'local-directory' as const, current: 'the owner-configured root is read at execution; no path is returned to the model' },
      artifact: bound, contentDigest, files: resolved.manifest.entries.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes })), bytes: resolved.manifest.bytes
    };
  }

  async publish(input: Caller & { files: readonly unknown[]; evidenceId: string; acceptanceId: string; artifact: ArtifactIdentity; signal?: AbortSignal }): Promise<unknown> {
    input.signal?.throwIfAborted();
    if (typeof input?.projectId !== 'string' || typeof input?.sessionId !== 'string' || typeof input?.agentId !== 'string') throw new LocalReleaseError('Invalid publish caller', 'INVALID');
    await input.authorize();
    input.signal?.throwIfAborted();
    const record = this.destination(input.projectId), snapshot = await this.files(input.projectId, record, input.files);
    const targetDigest = localDestinationFingerprint(record), contentDigest = snapshot.manifest.digest, targetId = this.targetId();
    const contentRevision = 'artifact-' + contentDigest;
    const bound = targetBoundArtifact({ projectId: input.projectId, actionClass: 'publish', targetId, targetRevision: record.revision, targetDigest, contentRevision, commit: null });
    if (input.artifact?.revision !== bound.revision || input.artifact.commit !== null)
      throw new LocalReleaseError('The accepted artifact does not bind this exact publication root and content', 'REFUSED');
    const resourceKey = localDestinationResourceKey(input.projectId, 'publish', record.definition, contentDigest);
    const caller = input, expected = { record, targetDigest, contentDigest };
    let executed: { publication: string } | null = null;

    const checkAuthority = async () => {
      await caller.authorize();
      const current = this.options.store.readDestination(caller.projectId, 'publish');
      if (!current || !current.enabled || current.revision !== expected.record.revision || localDestinationFingerprint(current) !== expected.targetDigest)
        throw new LocalReleaseError('The configured publication root changed or its revision is no longer in force', 'CONFLICT');
      this.options.sessionGate?.(caller.projectId, caller.sessionId);
      await caller.authorize();
    };

    const inspect = async () => {
      await checkAuthority();
      await this.verify(caller.projectId, expected.record, expected.contentDigest, caller.files);
      await checkAuthority();
    };

    const effect: AcceptedActionPort = {
      authorize: async (intent: AcceptedActionIntent) => {
        await checkAuthority();
        const view = await this.options.acceptance.readEvidence({ projectId: caller.projectId, evidenceId: intent.evidenceId });
        await checkAuthority();
        if (!view.acceptance || intent.agentId !== caller.agentId || intent.sessionId !== caller.sessionId)
          throw new LocalReleaseError('The session acceptance required for this publication is unavailable', 'REFUSED');
        return { allowed: true, acceptance: view.acceptance, policy: this.options.acceptance.readPolicy() };
      },
      check: async (intent) => {
        if (intent.actionClass !== 'publish' || intent.resourceKey !== resourceKey || intent.targetId !== targetId || intent.targetRevision !== expected.record.revision || intent.targetDigest !== expected.targetDigest || intent.contentRevision !== contentRevision || intent.artifact.revision !== bound.revision || intent.artifact.commit !== null)
          throw new LocalReleaseError('The publication intent is not the accepted root and content', 'REFUSED');
        await inspect();
      },
      execute: async (_intent, signal, revalidate) => {
        signal?.throwIfAborted();
        const verified = await this.verify(caller.projectId, expected.record, expected.contentDigest, caller.files);
        await revalidate();
        signal?.throwIfAborted();
        // The publication root exists and is real; staging is an owned sibling inside it, so the
        // final rename stays on one filesystem and cannot be redirected outside the root.
        const staging = stagingDirectory(verified.publicationRoot);
        let promoted = false;
        try {
          await copyManifest(verified.root, verified.manifest, staging);
          if (await directoryDigest(staging) !== expected.contentDigest)
            throw new LocalReleaseError('The staged copy does not match the previewed files; nothing was published', 'CONFLICT');
          await this.options.seam?.beforeSwap?.();
          signal?.throwIfAborted();
          const publication = generationName(expected.contentDigest, 'publish-'), destination = join(verified.publicationRoot, publication);
          let existing = false;
          try {
            const info = await lstat(destination);
            if (!info.isDirectory() || info.isSymbolicLink())
              throw new LocalReleaseError('A publication already holds this name and is not a real directory', 'REFUSED');
            if (await directoryDigest(destination) !== expected.contentDigest)
              throw new LocalReleaseError('A publication already holds this name with different content', 'CONFLICT');
            existing = true;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (existing) await discardStaging(staging); else await rename(staging, destination);
          promoted = true;
          this.options.seam?.afterSwap?.();
          const readback = await directoryDigest(destination);
          if (readback !== expected.contentDigest)
            throw new LocalReleaseError('The published content digest did not match after the rename', 'CONFLICT');
          const externalId = publication;
          this.options.store.recordOutcome({
            projectId: caller.projectId, actionClass: 'publish', artifactRevision: bound.revision, targetRevision: expected.record.revision,
            targetDigest: expected.targetDigest, contentDigest: expected.contentDigest, externalId, previousGeneration: null
          });
          executed = { publication };
          return { targetId, artifact: bound, externalId };
        } finally {
          if (!promoted) await discardStaging(staging).catch(() => {});
        }
      }
    };

    const outcome = await this.options.executor.run({
      projectId: input.projectId, sessionId: input.sessionId, agentId: input.agentId, evidenceId: input.evidenceId,
      acceptanceId: input.acceptanceId, actionClass: 'publish', targetId, targetRevision: record.revision, targetDigest,
      contentRevision, artifact: input.artifact, resourceKey
    }, effect, input.signal);
    const landed = executed as { publication: string } | null;
    return {
      ...outcome,
      target: { id: targetId, revision: record.revision, digest: targetDigest, kind: 'local-directory' as const },
      contentDigest,
      publication: landed === null ? null : landed.publication,
      rollback: 'Publishing is additive: a previous published directory is never replaced or removed, so a rollback is an operator decision about what the server reads.'
    };
  }
}
