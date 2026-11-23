import { ControlStore, ControlStoreError } from './control-store';
import { parseAgentIdentifier } from '../../shared/agent-registry';

const PROJECT = 'agent-budgets';
const MAX_ATTEMPTS = 32;
type BudgetKind = 'request' | 'job';
export class AgentBudgetExceeded extends Error {}

/**
 * Conservative durable reservations for one agent across all projects. A request is charged before
 * it is sent even if its result is lost; no failure or restart refunds it. Job reservations use a
 * rolling hour. Slot IDs are a control-store compare-and-swap: concurrent writers choosing the same
 * count cannot both consume that slot. This ledger does not itself make a provider or runner call.
 */
export class AgentBudgetLedger {
  constructor(private readonly store: ControlStore) {}

  /** Accounted reservations, not historical provider billing or completed requests. */
  requestsAccounted(agent: string): number {
    const agentId = parseAgentIdentifier(agent);
    const row = this.store.db.prepare('SELECT COUNT(*) AS total FROM operations WHERE project_id=? AND session_id=? AND kind=?').get(PROJECT, agentId, 'agent.budget-request') as { total: number };
    const total = Number(row.total);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Agent budget ledger is corrupt.');
    return total;
  }

  reserve(input: { agentId: string; projectId: string; kind: BudgetKind; limit: number | null; guard?: () => void }): { ordinal: number } {
    const agentId = parseAgentIdentifier(input.agentId), projectId = parseAgentIdentifier(input.projectId);
    if (input.kind !== 'request' && input.kind !== 'job') throw new Error('Unknown agent budget kind.');
    if (input.limit !== null && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw new Error('Invalid agent budget limit.');
    const now = new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('Agent budget clock unavailable.');
    const kind = 'agent.budget-' + input.kind;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const rows = this.store.db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent FROM operations WHERE project_id=? AND session_id=? AND kind=?')
        .get(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), PROJECT, agentId, kind) as { total: number; recent: number | null };
      const total = Number(rows.total), used = input.kind === 'request' ? total : Number(rows.recent ?? 0);
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(used) || total < 0 || used < 0) throw new Error('Agent budget ledger is corrupt.');
      if (input.limit !== null && used >= input.limit)
        throw new AgentBudgetExceeded(input.kind === 'request' ? 'The agent has exhausted its lifetime request budget.' : 'The agent has exhausted its rolling-hour job budget.');
      const ordinal = total + 1;
      try {
        const reservation = this.store.admit({ scope: { projectId: PROJECT, sessionId: agentId }, idempotencyKey: 'agent-budget.' + input.kind + '.r' + ordinal, kind,
          input: { version: 1, agentId, projectId, kind: input.kind, ordinal }, outbox: { kind, payload: { version: 1, ordinal } }, guard: input.guard });
        // Even identical admission is a competing call, not a reservation to share.
        if (!reservation.existing) return { ordinal };
      } catch (error) {
        if (!(error instanceof ControlStoreError && error.code === 'CONFLICT')) throw error;
      }
    }
    throw new Error('Agent budget contention could not be resolved; nothing was sent.');
  }
}
