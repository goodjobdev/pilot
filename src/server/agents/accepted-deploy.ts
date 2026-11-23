import type { ArtifactIdentity } from '../../shared/acceptance';
import { AcceptanceStore } from '../state/acceptance-store';
import { ActionTargetStore, actionTargetFingerprint } from '../state/action-target-store';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionIntent, type AcceptedActionPort } from '../state/accepted-action';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Caller = { projectId: string; sessionId: string; agentId: string; authorize: () => Promise<void> };
/** A trusted, fixed target integration; no general URL, command or credential comes from a model. */
export type WorkerDeployTransport = {
  inspect(input: { resourceDigest: string; versionId: string; signal?: AbortSignal }): Promise<{ resourceDigest: string; versionId: string }>;
  deploy(input: { resourceDigest: string; versionId: string; signal?: AbortSignal }): Promise<{ resourceDigest: string; versionId: string; deploymentId: string }>;
};

/** Experimental injected service. No application route, credential provisioning or tool installs it. */
export class AcceptedDeployService {
  constructor(private readonly options: {
    projectId: string; targetId: string; targetRevision: number; targets: ActionTargetStore;
    acceptance: AcceptanceStore; executor: AcceptedActionExecutor; transport: WorkerDeployTransport;
    targetCurrent(projectId: string, sessionId: string, targetId: string, revision: number): Promise<boolean>;
  }) {}

  private port(caller: Caller, versionId: string) {
    const { projectId, targetId, targetRevision, targets, acceptance, transport, targetCurrent } = this.options;
    if (caller.projectId !== projectId || !UUID.test(versionId)) throw new Error('Invalid deployment project or version.');
    const target = targets.resolve(projectId, targetId, targetRevision, 'deploy');
    if (target.definition.kind !== 'deploy' || target.definition.environmentId !== 'production') throw new Error('The configured deployment target is unavailable.');
    const { integrationId, serviceId, environmentId, resourceDigest } = target.definition;
    const targetDigest = actionTargetFingerprint(target), contentRevision = 'worker-version-' + versionId, resourceKey = 'resource-' + resourceDigest;
    const artifact = targetBoundArtifact({ projectId, actionClass: 'deploy', targetId, targetRevision, targetDigest, contentRevision, commit: null });
    const checkAuthority = async () => {
      await caller.authorize();
      if (actionTargetFingerprint(targets.resolve(projectId, targetId, targetRevision, 'deploy')) !== targetDigest || !await targetCurrent(projectId, caller.sessionId, targetId, targetRevision)) throw new Error('The deployment target or session changed.');
      await caller.authorize();
      if (actionTargetFingerprint(targets.resolve(projectId, targetId, targetRevision, 'deploy')) !== targetDigest || !await targetCurrent(projectId, caller.sessionId, targetId, targetRevision)) throw new Error('The deployment target or session changed.');
    };
    const inspect = async (signal?: AbortSignal) => {
      signal?.throwIfAborted(); await checkAuthority();
      const observed = await transport.inspect({ resourceDigest, versionId, signal });
      if (!observed || observed.resourceDigest !== resourceDigest || observed.versionId !== versionId) throw new Error('The deployment version or target could not be verified.');
      await checkAuthority(); signal?.throwIfAborted();
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
        if (intent.actionClass !== 'deploy' || intent.resourceKey !== resourceKey || intent.targetId !== targetId || intent.targetRevision !== targetRevision || intent.targetDigest !== targetDigest || intent.contentRevision !== contentRevision || intent.artifact.revision !== artifact.revision || intent.artifact.commit !== null) throw new Error('The deployment intent is not the accepted target and version.');
        await inspect();
      },
      execute: async (_intent, signal, revalidate) => {
        await inspect(signal); await revalidate(); signal?.throwIfAborted();
        const result = await transport.deploy({ resourceDigest, versionId, signal });
        if (!result || result.resourceDigest !== resourceDigest || result.versionId !== versionId || !UUID.test(result.deploymentId)) throw new Error('The deployment receipt could not be verified.');
        return { targetId, artifact, externalId: result.deploymentId };
      }
    };
    return { target, integrationId, serviceId, environmentId, resourceDigest, resourceKey, targetDigest, contentRevision, artifact, inspect, effect };
  }

  async preview(input: Caller & { versionId: string }) {
    const port = this.port(input, input.versionId); await port.inspect();
    return { artifact: port.artifact, contentRevision: port.contentRevision, versionId: input.versionId, target: { id: port.target.targetId, revision: port.target.revision, digest: port.targetDigest, integrationId: port.integrationId, serviceId: port.serviceId, environmentId: port.environmentId, resourceDigest: port.resourceDigest } };
  }

  async deploy(input: Caller & { versionId: string; evidenceId: string; acceptanceId: string; artifact: ArtifactIdentity; signal?: AbortSignal }) {
    input.signal?.throwIfAborted(); const port = this.port(input, input.versionId);
    return this.options.executor.run({ projectId: input.projectId, sessionId: input.sessionId, agentId: input.agentId, evidenceId: input.evidenceId, acceptanceId: input.acceptanceId, actionClass: 'deploy', targetId: port.target.targetId, targetRevision: port.target.revision, targetDigest: port.targetDigest, contentRevision: port.contentRevision, artifact: input.artifact, resourceKey: port.resourceKey }, port.effect, input.signal);
  }
}
