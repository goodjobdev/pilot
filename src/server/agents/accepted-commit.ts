import type { Project } from '../../shared/model';
import type { ArtifactIdentity } from '../../shared/acceptance';
import { WorkspaceStore } from '../workspace';
import { AcceptanceStore } from '../state/acceptance-store';
import { AcceptedActionExecutor, type AcceptedActionIntent } from '../state/accepted-action';
import { acceptedGitCommitPort } from '../state/accepted-git-commit';
import { ActionTargetStore, actionTargetFingerprint } from '../state/action-target-store';

/**
 * Opt-in composition for one owner-configured target, installed only when the instance sets
 * `DASHBOARD_AGENT_COMMIT=on`. The host supplies live session/scope checks; the target resolver must
 * refuse stale configuration and unsupported fork workspaces. There is deliberately no
 * model-selected path, branch or command.
 */
export class AcceptedCommitService {
  constructor(private readonly options: {
    project: Project; targetId: string; targetRevision: number; workspace: WorkspaceStore;
    acceptance: AcceptanceStore; executor: AcceptedActionExecutor; targets: ActionTargetStore;
    targetCurrent(projectId: string, sessionId: string, targetId: string, revision: number): Promise<boolean>;
  }) {}

  private port(sessionId: string, agentId: string, authorize: () => Promise<void>) {
    const { project, targetId, targetRevision, workspace, acceptance, targetCurrent, targets } = this.options;
    const targetDigest = actionTargetFingerprint(targets.resolve(project.id, targetId, targetRevision, 'commit'));
    const checkAuthority = async () => {
      await authorize();
      const configured = targets.resolve(project.id, targetId, targetRevision, 'commit');
      if (actionTargetFingerprint(configured) !== targetDigest || configured.definition.kind !== 'commit' || configured.definition.repositoryId !== project.id || configured.definition.branch !== 'refs/heads/work/pilot-' + project.id.slice(0, 8))
        throw new Error('The commit target does not match the configured repository and branch.');
      if (!await targetCurrent(project.id, sessionId, targetId, targetRevision)) throw new Error('The commit target or session is unavailable.');
      await authorize();
      if (actionTargetFingerprint(targets.resolve(project.id, targetId, targetRevision, 'commit')) !== targetDigest) throw new Error('The commit target changed.');
    };
    return { targetDigest, checkAuthority, git: acceptedGitCommitPort({ project, targetId, targetRevision, targetDigest, workspace,
      authorize: async (intent: AcceptedActionIntent) => {
        await checkAuthority();
        const view = await acceptance.readEvidence({ projectId: project.id, evidenceId: intent.evidenceId });
        await checkAuthority();
        if (!view.acceptance || intent.agentId !== agentId || intent.sessionId !== sessionId) throw new Error('The session acceptance is unavailable.');
        return { allowed: true, acceptance: view.acceptance, policy: acceptance.readPolicy() };
      }
    }) };
  }

  async preview(input: { projectId: string; sessionId: string; agentId: string; authorize: () => Promise<void> }) {
    if (input.projectId !== this.options.project.id) throw new Error('The configured commit project does not match.');
    const port = this.port(input.sessionId, input.agentId, input.authorize);
    await port.checkAuthority(); const preview = await port.git.preview(); await port.checkAuthority();
    return preview;
  }

  async commit(input: { projectId: string; sessionId: string; agentId: string; evidenceId: string; acceptanceId: string; artifact: ArtifactIdentity; authorize: () => Promise<void>; signal?: AbortSignal }) {
    const { project, targetId, targetRevision, executor } = this.options;
    if (input.projectId !== project.id) throw new Error('The configured commit project does not match.');
    const port = this.port(input.sessionId, input.agentId, input.authorize);
    input.signal?.throwIfAborted(); await port.checkAuthority();
    const preview = await port.git.preview();
    await port.checkAuthority(); input.signal?.throwIfAborted();
    return executor.run({ projectId: project.id, sessionId: input.sessionId, agentId: input.agentId, evidenceId: input.evidenceId, acceptanceId: input.acceptanceId, artifact: input.artifact, contentRevision: preview.contentRevision, actionClass: 'commit', targetId, targetRevision, targetDigest: port.targetDigest }, port.git, input.signal);
  }
}
