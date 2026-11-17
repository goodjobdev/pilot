import { AgentBudgetLedger } from '../state/agent-budget';
import type { AgentStore } from '../state/agent-store';
import type { ControlStore } from '../state/control-store';

/** A refusal that is about authority, not storage: the session, binding, scope or grant changed. */
export class AgentJobRefused extends Error {}

/**
 * Reserve one rolling-hour job for an explicitly bound named agent. The installed local test runner
 * calls it, so the rolling-hour limit is enforced by the path a model really reaches; it neither
 * supplies a runtime nor authorizes a workspace by itself. The agent and ledger must share the
 * admission connection so their guard runs in the same write transaction. The caller must still
 * recheck session, workspace and scope immediately before each runner effect.
 */
export function reserveNamedAgentTestJob(input: {
  control: ControlStore; agents: AgentStore; projectId: string; sessionId: string; agentId: string;
}): void {
  const { control, agents, projectId, sessionId, agentId } = input;
  if (!agents.usesControlStore(control)) throw new Error('Job budget authority must share the admission connection.');
  const binding = agents.binding(projectId, sessionId);
  const authority = agents.authorityForSession({ projectId, sessionId });
  if (!binding || binding.agentId !== agentId || authority.agentId !== agentId || !authority.scopes?.includes('run_tests') || (authority.projects !== null && !authority.projects.includes(projectId)))
    throw new AgentJobRefused('The session is not bound to an agent authorized to run tests in this project.');
  const agent = agents.read(agentId), signature = JSON.stringify(authority);
  if (!agent.enabled || agent.archived) throw new AgentJobRefused('The agent is not active.');
  const check = () => {
    const currentBinding = agents.binding(projectId, sessionId), current = agents.read(agentId);
    if (!currentBinding || currentBinding.agentId !== agentId || currentBinding.revision !== binding.revision || current.revision !== agent.revision || !current.enabled || current.archived || JSON.stringify(agents.authorityForSession({ projectId, sessionId })) !== signature)
      throw new AgentJobRefused('Agent authority or job budget changed before reservation.');
  };
  new AgentBudgetLedger(control).reserve({ agentId, projectId, kind: 'job', limit: agent.budgets.maxJobsPerHour, guard: check });
  // Admission is not a lease; revocation after it remains a refusal and the reservation is not refunded.
  check();
}
