import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ArtifactIdentity } from '../../shared/acceptance';
import { parseAgentIdentifier } from '../../shared/agent-registry';
import { canonicalJson } from '../../shared/control-state';
import { readBoundedFile } from '../bounded-file-read';
import { AcceptanceStore } from '../state/acceptance-store';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionIntent, type AcceptedActionPort, type AcceptedActionReceipt } from '../state/accepted-action';

/**
 * `provision` — one Pilot-owned local resource per `(project, target)`, published atomically.
 *
 * The resource is a real directory under one owner-approved root, holding one bounded
 * `manifest.json`. That is deliberately the whole capability: this adapter creates no infrastructure,
 * runs no template, resolves no credential and calls no provider. The owner names the approved root
 * at deployment; the model names only a resource slug, a version and an optional description. The
 * exact resource directory is `<root>/<projectId>/<targetId>`, so a repeat for the same target
 * revision addresses the same place and nothing else.
 *
 * Guarantees this code does keep:
 *
 * - The manifest is written in a staging directory under the same parent and published with one
 *   `rename`, so a reader sees either no resource or the complete manifest, never a partial file.
 * - A repeat of the same content is idempotent: if the target already holds the exact Pilot-owned
 *   manifest, nothing is renamed and the recorded receipt is returned. Different content is a
 *   conflict and leaves the existing resource untouched.
 * - Path escapes, symlinked roots, parents, targets or manifests, an existing target that is not a
 *   Pilot-owned resource, and oversized manifests are refused before anything is published.
 * - Durable intent, the receipt and uncertainty come from `AcceptedActionExecutor`: this module does
 *   not write action state, and an interrupted attempt stays unknown instead of being replayed.
 *
 * What it does not promise: check-then-use on the filesystem is not atomic, so a same-user process
 * can still substitute a directory between two calls. `rename` is atomic only on a filesystem that
 * provides atomic directory renames (the POSIX case this build targets), and the parent directory is
 * not fsync'd, so this is not a crash-durability claim.
 */

/** The largest manifest this capability will write or read back, in bytes. */
export const PROVISION_MAX_MANIFEST_BYTES = 4096;
export const PROVISION_RESOURCE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const PROVISION_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const PROVISION_TARGET_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const PROVISION_MANIFEST_FILE = 'manifest.json';

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const manifestSchema = z.strictObject({
  schema: z.literal(1),
  projectId: identifier,
  targetId: identifier,
  resource: z.string().regex(PROVISION_RESOURCE_PATTERN),
  version: z.string().regex(PROVISION_VERSION_PATTERN),
  description: z.string().max(200).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
});
export type ProvisionManifest = Readonly<z.infer<typeof manifestSchema>>;

/** The immutable owner-configured target identity bound into the accepted artifact. */
export function provisionTargetDigest(input: { projectId: string; targetId: string; root: string; targetRevision: number }): string {
  if (!PROVISION_TARGET_PATTERN.test(input.targetId) || !Number.isSafeInteger(input.targetRevision) || input.targetRevision < 1) throw new Error('Invalid provisioning target.');
  return createHash('sha256').update(canonicalJson(['pilot-provision-target-v1', input.projectId, input.targetId, input.root, input.targetRevision])).digest('hex');
}

function manifestDigest(input: { projectId: string; targetId: string; resource: string; version: string; description: string | null }): string {
  return createHash('sha256').update(canonicalJson(['pilot-provision-resource-v1', input.projectId, input.targetId, input.resource, input.version, input.description])).digest('hex');
}

function manifestText(manifest: ProvisionManifest): string {
  const text = canonicalJson(manifest) + '\n';
  if (Buffer.byteLength(text, 'utf8') > PROVISION_MAX_MANIFEST_BYTES) throw new Error('The provisioning manifest exceeds ' + PROVISION_MAX_MANIFEST_BYTES + ' bytes.');
  return text;
}

/** One resource view: the verified manifest and the digest that identifies it. */
export type ProvisionResource = { readonly digest: string; readonly manifest: ProvisionManifest };

/**
 * The filesystem half of the capability. It is a narrow port so a test can observe an interrupted
 * publication, and so the service itself never holds a path that a model supplied.
 */
export interface ProvisionFilesystem {
  /** The target resource, or null when nothing exists there yet. Refuses anything it cannot verify. */
  inspect(input: { projectId: string }): Promise<ProvisionResource | null>;
  /** Publish the manifest atomically, or return the identical resource that is already there. */
  publish(input: { projectId: string; manifest: ProvisionManifest; signal?: AbortSignal }): Promise<ProvisionResource>;
}

/**
 * The real filesystem implementation for one owner-approved root and target id. The constructor
 * refuses a relative root, a target id that could address another path, and a root that is a
 * symbolic link; the root is revalidated on every operation because a directory can change.
 */
export class ProvisionStore implements ProvisionFilesystem {
  constructor(private readonly options: { root: string; targetId: string }) {
    if (typeof options.root !== 'string' || !isAbsolute(options.root)) throw new Error('The approved provisioning root must be an absolute path.');
    if (!PROVISION_TARGET_PATTERN.test(options.targetId)) throw new Error('The provisioning target id is invalid.');
  }

  private async root(): Promise<string> {
    const configured = resolve(this.options.root);
    const info = await lstat(configured).catch((error: NodeJS.ErrnoException) => { throw error.code === 'ENOENT' ? new Error('The approved provisioning root does not exist.') : error; });
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The approved provisioning root is not a real directory.');
    // Resolve once: later containment checks compare against the canonical root, not its spelling.
    return realpath(configured);
  }

  private destination(root: string, projectId: string): { parent: string; target: string } {
    const parent = join(root, parseAgentIdentifier(projectId)), target = join(parent, this.options.targetId);
    const rel = relative(root, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('The provisioning target leaves the approved root.');
    return { parent, target };
  }

  async inspect(input: { projectId: string }): Promise<ProvisionResource | null> {
    const root = await this.root(), { parent, target } = this.destination(root, input.projectId);
    const parentInfo = await lstat(parent).catch(() => undefined);
    if (parentInfo === undefined) return null;
    // A symlinked or non-directory project path would make the target's real location something
    // other than the approved root, so it is refused before the target is even looked at.
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('The provisioning project directory is not a real directory.');
    let info;
    try { info = await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (info.isSymbolicLink()) throw new Error('The provisioning target is a symbolic link; it was not read or written.');
    if (!info.isDirectory()) throw new Error('The provisioning target exists and is not a Pilot-owned resource directory.');
    let buffer: Buffer;
    try { buffer = await readBoundedFile(join(target, PROVISION_MANIFEST_FILE), PROVISION_MAX_MANIFEST_BYTES); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new Error('The provisioning target exists but holds no Pilot manifest; it is not a Pilot-owned resource and was not changed.');
      if (error instanceof Error && /OVERSIZE|SYMLINK|NOT_REGULAR/.test(error.message)) throw new Error('The provisioning manifest is not a bounded regular Pilot file.');
      throw error;
    }
    const parsed = manifestSchema.safeParse(this.parse(buffer));
    if (!parsed.success) throw new Error('The provisioning target holds a manifest this build does not recognize; it is not a Pilot-owned resource.');
    const manifest = Object.freeze(parsed.data);
    if (manifest.projectId !== parseAgentIdentifier(input.projectId) || manifest.targetId !== this.options.targetId || manifest.digest !== manifestDigest(manifest))
      throw new Error('The provisioning manifest does not belong to this project and target.');
    return { digest: manifest.digest, manifest };
  }

  private parse(buffer: Buffer): unknown {
    try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
  }

  private async ensureParent(root: string, parent: string): Promise<void> {
    try { await mkdir(parent, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The provisioning project directory is not a real directory.');
    const canonical = await realpath(parent), rel = relative(root, canonical);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('The provisioning project directory leaves the approved root.');
  }

  async publish(input: { projectId: string; manifest: ProvisionManifest; signal?: AbortSignal }): Promise<ProvisionResource> {
    const root = await this.root(), { parent, target } = this.destination(root, input.projectId);
    const expected = manifestText(input.manifest), expectedDigest = input.manifest.digest;
    input.signal?.throwIfAborted();
    // The common repeat is answered by reading the target, not by attempting another rename.
    const existing = await this.inspect({ projectId: input.projectId });
    if (existing !== null) {
      if (existing.digest !== expectedDigest) throw new Error('The provisioning target already holds a different resource; it was not changed.');
      return existing;
    }
    await this.ensureParent(root, parent);
    input.signal?.throwIfAborted();
    const staging = join(parent, '.staging-' + randomUUID());
    try {
      await mkdir(staging, { mode: 0o700 });
      const handle = await open(join(staging, PROVISION_MANIFEST_FILE), 'wx', 0o600);
      try { await handle.writeFile(expected, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      input.signal?.throwIfAborted();
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      // A concurrent writer that published the identical manifest first is a success, not a failure.
      const settled = await this.inspect({ projectId: input.projectId }).catch(() => null);
      if (settled !== null && settled.digest === expectedDigest) return settled;
      throw error;
    }
    const published = await this.inspect({ projectId: input.projectId });
    if (published === null || published.digest !== expectedDigest) throw new Error('The provisioning target could not be verified after publication.');
    return published;
  }
}

export type ProvisionCaller = { projectId: string; sessionId: string; agentId: string; authorize: () => Promise<void> };
export type ProvisionSpec = { resource: string; version: string; description?: string | null };
export type AcceptedProvisionOutcome =
  | { readonly status: 'succeeded'; readonly receipt: AcceptedActionReceipt; readonly operationId: string; readonly repeated: boolean }
  | { readonly status: 'refused' | 'uncertain'; readonly operationId: string | null; readonly message: string };

function recordedReceipt(value: unknown): AcceptedActionReceipt | null {
  const receipt = value as { targetId?: unknown; artifact?: { revision?: unknown; commit?: unknown }; externalId?: unknown } | null;
  if (!receipt || typeof receipt.targetId !== 'string' || !receipt.artifact || (receipt.artifact.commit !== null && typeof receipt.artifact.commit !== 'string') ||
      typeof receipt.artifact.revision !== 'string' || typeof receipt.externalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(receipt.externalId)) return null;
  return { targetId: receipt.targetId, artifact: { revision: receipt.artifact.revision, commit: receipt.artifact.commit as string | null }, externalId: receipt.externalId };
}

/**
 * One owner-configured provisioning target. The model supplies no path, root, target id, command or
 * credential: those are the service's own configuration, bound into the accepted artifact before an
 * acceptance can be recorded. A repeat of the same content returns the recorded receipt; anything
 * whose earlier intent is pending or unknown is reported as such rather than replayed.
 */
export class AcceptedProvisionService {
  constructor(private readonly options: {
    projectId: string; targetId: string; targetRevision: number; root: string;
    store: ProvisionFilesystem; acceptance: AcceptanceStore; executor: AcceptedActionExecutor;
  }) {
    parseAgentIdentifier(options.projectId);
    provisionTargetDigest({ projectId: options.projectId, targetId: options.targetId, root: options.root, targetRevision: options.targetRevision });
  }

  private spec(input: ProvisionSpec): ProvisionManifest {
    const description = input.description ?? null;
    if (typeof input.resource !== 'string' || !PROVISION_RESOURCE_PATTERN.test(input.resource)) throw new Error('The resource name must be 1-32 lowercase letters, digits or dashes, starting with a letter.');
    if (typeof input.version !== 'string' || !PROVISION_VERSION_PATTERN.test(input.version)) throw new Error('The resource version must be 1-32 letters, digits, dots, dashes or underscores, starting alphanumerically.');
    if (description !== null && (typeof description !== 'string' || description.length > 200)) throw new Error('The resource description must be at most 200 characters.');
    const digest = manifestDigest({ projectId: this.options.projectId, targetId: this.options.targetId, resource: input.resource, version: input.version, description });
    const manifest: ProvisionManifest = Object.freeze({ schema: 1 as const, projectId: this.options.projectId, targetId: this.options.targetId, resource: input.resource, version: input.version, description, digest });
    manifestText(manifest);
    return manifest;
  }

  private port(caller: ProvisionCaller, manifest: ProvisionManifest) {
    const { projectId, targetId, targetRevision, root, store, acceptance } = this.options;
    if (caller.projectId !== projectId) throw new Error('The configured provisioning project does not match.');
    const targetDigest = provisionTargetDigest({ projectId, targetId, root, targetRevision });
    const contentRevision = 'provision-' + manifest.digest;
    const artifact = targetBoundArtifact({ projectId, actionClass: 'provision', targetId, targetRevision, targetDigest, contentRevision, commit: null });
    const checkAuthority = async () => {
      await caller.authorize();
      if (provisionTargetDigest({ projectId, targetId, root, targetRevision }) !== targetDigest) throw new Error('The provisioning target changed.');
      await caller.authorize();
    };
    /** Read the target and refuse a different resource; the identical one is a repeat, not a conflict. */
    const inspect = async () => {
      await checkAuthority();
      const existing = await store.inspect({ projectId });
      await checkAuthority();
      if (existing !== null && existing.digest !== manifest.digest)
        throw new Error('The provisioning target already holds a different resource (' + existing.manifest.resource + ' ' + existing.manifest.version + '); it was not changed.');
      return existing;
    };
    const effect: AcceptedActionPort = {
      authorize: async (intent: AcceptedActionIntent) => {
        await checkAuthority();
        const view = await acceptance.readEvidence({ projectId, evidenceId: intent.evidenceId });
        await checkAuthority();
        if (!view.acceptance || intent.agentId !== caller.agentId || intent.sessionId !== caller.sessionId) throw new Error('The session acceptance is unavailable.');
        return { allowed: true, acceptance: view.acceptance, policy: acceptance.readPolicy() };
      },
      check: async (intent: AcceptedActionIntent) => {
        if (intent.actionClass !== 'provision' || intent.targetId !== targetId || intent.targetRevision !== targetRevision || intent.targetDigest !== targetDigest ||
            intent.contentRevision !== contentRevision || intent.artifact.revision !== artifact.revision || intent.artifact.commit !== null || intent.resourceKey !== undefined)
          throw new Error('The provisioning intent is not the accepted target and content.');
        await inspect();
      },
      execute: async (_intent: AcceptedActionIntent, signal: AbortSignal | undefined, revalidate: () => Promise<void>) => {
        signal?.throwIfAborted(); await inspect(); await revalidate(); signal?.throwIfAborted();
        const published = await store.publish({ projectId, manifest, signal });
        if (published.digest !== manifest.digest) throw new Error('The provisioning receipt could not be verified.');
        // The authorization check is the last admission step, not a lease: a revocation after it
        // cannot retract the rename that already happened.
        return { targetId, artifact, externalId: 'provision-' + published.digest };
      }
    };
    return { targetDigest, contentRevision, artifact, checkAuthority, inspect, effect };
  }

  async preview(input: ProvisionCaller & ProvisionSpec) {
    const manifest = this.spec(input), port = this.port(input, manifest);
    await port.checkAuthority();
    // A preview reports an existing different resource as a conflict instead of pretending it can
    // proceed: the model can see why the accepted creation would be refused without writing anything.
    const existing = await this.options.store.inspect({ projectId: this.options.projectId });
    return {
      artifact: port.artifact,
      contentRevision: port.contentRevision,
      target: { id: this.options.targetId, revision: this.options.targetRevision, digest: port.targetDigest },
      resource: manifest.resource,
      version: manifest.version,
      description: manifest.description,
      state: existing === null ? 'absent' as const : existing.digest === manifest.digest ? 'present' as const : 'conflict' as const,
      existing: existing === null ? null : { resource: existing.manifest.resource, version: existing.manifest.version }
    };
  }

  async provision(input: ProvisionCaller & ProvisionSpec & { evidenceId: string; acceptanceId: string; artifact: ArtifactIdentity; signal?: AbortSignal }): Promise<AcceptedProvisionOutcome> {
    if (input.projectId !== this.options.projectId) throw new Error('The configured provisioning project does not match.');
    input.signal?.throwIfAborted();
    const manifest = this.spec(input), port = this.port(input, manifest);
    await port.inspect();
    const recorded = this.options.executor.find({ projectId: this.options.projectId, artifact: input.artifact });
    if (recorded !== null) {
      const receipt = recorded.state === 'succeeded' ? recordedReceipt(recorded.receipt) : null;
      if (receipt !== null && receipt.targetId === this.options.targetId && receipt.artifact.revision === port.artifact.revision && receipt.artifact.commit === null)
        return { status: 'succeeded', receipt, operationId: recorded.operationId, repeated: true };
      return recorded.state === 'pending' || recorded.state === 'unknown'
        ? { status: 'uncertain', operationId: recorded.operationId, message: 'An earlier attempt for this exact resource may have happened. Inspect the target and durable intent; do not retry automatically.' }
        : { status: 'refused', operationId: recorded.operationId, message: 'This exact accepted resource already has a durable intent that is not a verified success. Inspect it before doing anything else.' };
    }
    const result = await this.options.executor.run({
      projectId: this.options.projectId, sessionId: input.sessionId, agentId: input.agentId, evidenceId: input.evidenceId, acceptanceId: input.acceptanceId,
      actionClass: 'provision', targetId: this.options.targetId, targetRevision: this.options.targetRevision, targetDigest: port.targetDigest,
      contentRevision: port.contentRevision, artifact: input.artifact
    }, port.effect, input.signal);
    return result.status === 'succeeded' ? { ...result, repeated: false } : result;
  }
}
