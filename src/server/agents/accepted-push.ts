import type { ArtifactIdentity } from '../../shared/acceptance';
import { pushResourceKey } from '../state/push-resource-key';
import { AcceptanceStore } from '../state/acceptance-store';
import { ActionTargetStore, actionTargetFingerprint } from '../state/action-target-store';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionIntent, type AcceptedActionPort } from '../state/accepted-action';

/**
 * Trusted, separately configured integration. It must resolve remoteId to a pinned repository,
 * validate the source object, and perform exactly one normal fast-forward-only push of commit to
 * branch: no force, tags, submodules, hooks on the client, arbitrary refspecs or model-supplied URL.
 * It must resolve and verify the immutable repository digest both at inspection and effect time.
 * `push` returns only after a read-back of that branch; any error or ambiguous receipt is uncertain.
 * This interface is NOT a production GitHub transport, sandbox, credential store or HTTP endpoint.
 */
export type ExactPushTransport = {
  inspect(input: { projectId: string; remoteId: string; repositoryDigest: string; branch: string; commit: string }): Promise<{ repositoryDigest: string; remoteHead: string | null }>;
  push(input: { projectId: string; remoteId: string; repositoryDigest: string; branch: string; commit: string; signal?: AbortSignal }): Promise<{ repositoryDigest: string; observedCommit: string }>;
};
type Caller = { projectId: string; sessionId: string; agentId: string; authorize: () => Promise<void> };

// RegExp.test coerces non-strings, and `$` also matches before a final newline.
// Git object identities at this boundary must be exact primitive strings.
function isCommitId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value);
}

/**
 * Installed only when the instance sets `DASHBOARD_AGENT_PUSH=on`. The transport supplied by this
 * build is one owner-configured local remote: no hosted credential integration, no network transport.
 */
export class AcceptedPushService {
  constructor(private readonly options: {
    projectId: string; targetId: string; targetRevision: number; targets: ActionTargetStore;
    acceptance: AcceptanceStore; executor: AcceptedActionExecutor; transport: ExactPushTransport;
    targetCurrent(projectId: string, sessionId: string, targetId: string, revision: number): Promise<boolean>;
  }) {}

  private port(caller: Caller, commit: string) {
    const { projectId, targetId, targetRevision, targets, acceptance, transport, targetCurrent } = this.options;
    if (caller.projectId !== projectId || !isCommitId(commit)) throw new Error('Invalid push project or commit.');
    const target = targets.resolve(projectId, targetId, targetRevision, 'push');
    if (target.definition.kind !== 'push') throw new Error('The configured push target is unavailable.');
    const { remoteId, repositoryDigest, branch } = target.definition, targetDigest = actionTargetFingerprint(target), contentRevision = 'commit-' + commit;
    // Alias, project, target revision and commit are intentionally excluded: all configured aliases
    // of the same repository identity and branch share a barrier. The identity is still a trusted
    // integration assertion, not independently established by hashing it.
    const resourceKey = pushResourceKey(repositoryDigest, branch);
    const artifact = targetBoundArtifact({ projectId, actionClass: 'push', targetId, targetRevision, targetDigest, contentRevision, commit });
    const checkAuthority = async () => {
      await caller.authorize();
      if (actionTargetFingerprint(targets.resolve(projectId, targetId, targetRevision, 'push')) !== targetDigest || !await targetCurrent(projectId, caller.sessionId, targetId, targetRevision))
        throw new Error('The push target or session changed.');
      await caller.authorize();
      if (actionTargetFingerprint(targets.resolve(projectId, targetId, targetRevision, 'push')) !== targetDigest || !await targetCurrent(projectId, caller.sessionId, targetId, targetRevision)) throw new Error('The push target or session changed.');
    };
    const inspect = async () => {
      await checkAuthority();
      const observed = await transport.inspect({ projectId, remoteId, repositoryDigest, branch, commit });
      if (!observed || observed.repositoryDigest !== repositoryDigest || (observed.remoteHead !== null && !isCommitId(observed.remoteHead))) throw new Error('The remote state is unavailable.');
      await checkAuthority();
      return observed;
    };
    const effect: AcceptedActionPort = {
      authorize: async (intent: AcceptedActionIntent) => {
        await checkAuthority();
        const view = await acceptance.readEvidence({ projectId, evidenceId: intent.evidenceId });
        await checkAuthority();
        if (!view.acceptance || intent.agentId !== caller.agentId || intent.sessionId !== caller.sessionId) throw new Error('The session acceptance is unavailable.');
        return { allowed: true, acceptance: view.acceptance, policy: acceptance.readPolicy() };
      },
      check: async intent => {
        if (intent.actionClass !== 'push' || intent.resourceKey !== resourceKey || intent.targetId !== targetId || intent.targetRevision !== targetRevision || intent.targetDigest !== targetDigest || intent.contentRevision !== contentRevision || intent.artifact.revision !== artifact.revision || intent.artifact.commit !== commit) throw new Error('The push intent is not the accepted target and commit.');
        await inspect();
      },
      execute: async (_intent, signal, revalidate) => {
        signal?.throwIfAborted(); await inspect(); await revalidate(); signal?.throwIfAborted();
        const result = await transport.push({ projectId, remoteId, repositoryDigest, branch, commit, signal });
        if (!result || result.repositoryDigest !== repositoryDigest || result.observedCommit !== commit) throw new Error('The pushed branch could not be verified.');
        // A transport receipt alone is not the service's post-effect observation. This still uses
        // the same trusted transport, so it is neither independent verification nor a reservation:
        // the branch may change immediately afterwards. Any failure remains an uncertain effect.
        signal?.throwIfAborted();
        const observed = await inspect();
        signal?.throwIfAborted();
        if (observed.remoteHead !== commit) throw new Error('The pushed branch did not match the accepted commit on read-back.');
        return { targetId, artifact, externalId: commit };
      }
    };
    return { target, remoteId, repositoryDigest, branch, artifact, contentRevision, targetDigest, resourceKey, inspect, effect };
  }

  async preview(input: Caller & { commit: string }) {
    const port = this.port(input, input.commit), remote = await port.inspect();
    return { artifact: port.artifact, contentRevision: port.contentRevision, target: { id: port.target.targetId, revision: port.target.revision, digest: port.targetDigest, kind: 'push' as const, remoteId: port.remoteId, repositoryDigest: port.repositoryDigest, branch: port.branch }, remoteHead: remote.remoteHead };
  }

  async push(input: Caller & { evidenceId: string; acceptanceId: string; artifact: ArtifactIdentity; signal?: AbortSignal }) {
    if (input.artifact.commit === null) throw new Error('The accepted push must name a commit.');
    input.signal?.throwIfAborted();
    const port = this.port(input, input.artifact.commit);
    return this.options.executor.run({ projectId: input.projectId, sessionId: input.sessionId, agentId: input.agentId, evidenceId: input.evidenceId, acceptanceId: input.acceptanceId, actionClass: 'push', targetId: port.target.targetId, targetRevision: port.target.revision, targetDigest: port.targetDigest, contentRevision: port.contentRevision, artifact: input.artifact, resourceKey: port.resourceKey }, port.effect, input.signal);
  }
}
