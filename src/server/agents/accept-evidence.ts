import type { AcceptanceActionClass, ArtifactIdentity } from '../../shared/acceptance';
import { HttpError } from '../board-store';
import { AcceptanceStore } from '../state/acceptance-store';
import { AgentStore } from '../state/agent-store';

/** Call synchronously inside admission against the same control-store connection. */
export function verifyAgentAcceptanceAuthority(store: AgentStore, input: { projectId: string; sessionId: string; agentId: string }): void {
  const binding = store.binding(input.projectId, input.sessionId);
  const authority = store.authorityForSession({ projectId: input.projectId, sessionId: input.sessionId });
  if (!binding || binding.agentId !== input.agentId || authority.agentId !== input.agentId || authority.scopes === null || !authority.scopes.includes('accept') || (authority.projects !== null && !authority.projects.includes(input.projectId)))
    throw new Error('Acceptance authority changed.');
}

/** Bind the exact dispatch snapshot to the admission transaction, including revision changes. */
export function verifyAgentAcceptanceDispatch(store:AgentStore,input:{projectId:string;sessionId:string;agentId:string;expectedAuthority:string}):void {
  verifyAgentAcceptanceAuthority(store,input);
  if(JSON.stringify(store.versionedAuthorityForSession(input))!==input.expectedAuthority)throw new Error('Acceptance dispatch authority changed before admission.');
}

/** A model can accept only evidence from its own session, under freshly checked authority and policy. */
export async function acceptAgentEvidence(store: AcceptanceStore, input: {
  projectId: string; sessionId: string; evidenceId: string; artifact: ArtifactIdentity;
  actionClass: AcceptanceActionClass; agentId: string; authorize: () => Promise<void>;
  /** Trusted synchronous authority check over the same control store, inside admission. */
  verifyAdmission: () => void;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const evidence = await store.readEvidence({ projectId: input.projectId, evidenceId: input.evidenceId });
  input.signal?.throwIfAborted();
  if (evidence.record.sessionId !== input.sessionId) throw new HttpError(403, 'An agent may only accept evidence from its own session.');
  await input.authorize();input.signal?.throwIfAborted();
  // Policy and trusted same-store authority are checked under the admission write transaction.
  return store.accept({ projectId: input.projectId, authorizeAdmission: () => { input.signal?.throwIfAborted(); input.verifyAdmission(); input.signal?.throwIfAborted(); }, request: { evidenceId: input.evidenceId, artifact: input.artifact, actionClass: input.actionClass, actor: { kind: 'agent', identity: input.agentId } } });
}
