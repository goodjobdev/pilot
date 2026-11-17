import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ControlStore, ControlStoreError } from './control-store';
import { boundedJson } from '../../shared/control-state';
import { parseAgentIdentifier } from '../../shared/agent-registry';

/**
 * The hard, owner-configured money bound for the `spend` class.
 *
 * Two limits, both checked before any request leaves the process:
 *
 * - a **per-charge** limit for the class: one charge may not exceed it;
 * - a **per-project** limit: the sum of every charge admitted for the project may not exceed it.
 *
 * The sum is a durable reservation ledger in the control store, not a counter in memory. A
 * reservation is admitted inside one SQLite write transaction with the sum re-read in the same
 * transaction, so two concurrent charges cannot both pass the cap. One reservation is kept per
 * accepted artifact revision: a repeat reservation is the same reservation, never a second one.
 *
 * A reservation is not a refund: a charge that the provider refused, that failed, or whose outcome
 * is unknown still counts against the cap. That is the conservative direction, and it is why a
 * charge needs an owner-visible reconciliation rather than another automatic attempt. This ledger
 * bounds what *Pilot* sends; it is not a provider-side spending limit and does not read the
 * provider's billing state.
 */

const RESERVATION_KIND = 'spend.budget', RESERVATION_OUTBOX = 'spend.budget-audit';
const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const reservation = z.strictObject({
  version: z.literal(1),
  projectId: identifier,
  artifactRevision: z.string().min(1).max(200),
  amountMinor: z.number().int().positive().max(1_000_000_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/)
});
type Reservation = z.infer<typeof reservation>;

export class SpendBudgetError extends Error {}

export class SpendBudget {
  constructor(private readonly store: ControlStore, readonly limits: { readonly projectCapMinor: number; readonly chargeCapMinor: number }) {
    for (const [name, value] of Object.entries(limits))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('The spend ' + name + ' must be a positive whole number of minor units.');
    if (limits.chargeCapMinor > limits.projectCapMinor) throw new Error('The per-charge spend cap cannot exceed the per-project cap.');
  }

  /**
   * Every admitted charge for one project, including failed and uncertain ones. `exclude` omits one
   * artifact revision so a repeat of the same charge is measured against the cap once, not twice.
   */
  total(projectId: string, exclude?: string): number {
    const project = parseAgentIdentifier(projectId);
    const rows = this.store.db.prepare('SELECT input_json FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid').all(project, 'accepted-actions', RESERVATION_KIND) as { input_json: string }[];
    let total = 0;
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.input_json); } catch { throw new SpendBudgetError('The spend reservation ledger is corrupt; nothing was sent.'); }
      const value = reservation.safeParse(parsed);
      if (!value.success || value.data.projectId !== project || total + value.data.amountMinor > 1_000_000_000_000)
        throw new SpendBudgetError('The spend reservation ledger is corrupt; nothing was sent.');
      if (exclude !== undefined && value.data.artifactRevision === exclude) continue;
      total += value.data.amountMinor;
    }
    return total;
  }

  remaining(projectId: string): number {
    return this.limits.projectCapMinor - this.total(projectId);
  }

  /**
   * Reserve one charge atomically. The amount is refused before anything else when it exceeds the
   * per-charge cap; the project cap is checked against the durable sum and again inside the
   * admission transaction. `repeated` means this exact accepted artifact already holds a
   * reservation, which is the durable idempotency barrier for a repeat attempt.
   */
  reserve(input: { projectId: string; artifactRevision: string; amountMinor: number; currency: string }): { operationId: string; repeated: boolean; remainingMinor: number } {
    const projectId = parseAgentIdentifier(input.projectId);
    const parsed = reservation.safeParse({ version: 1, projectId, artifactRevision: input.artifactRevision, amountMinor: input.amountMinor, currency: input.currency });
    if (!parsed.success) throw new SpendBudgetError('The charge is not a bounded amount and currency; nothing was sent.');
    const record: Reservation = parsed.data;
    if (record.amountMinor > this.limits.chargeCapMinor)
      throw new SpendBudgetError('The charge exceeds the owner-configured per-charge spend cap of ' + this.limits.chargeCapMinor + ' ' + record.currency + ' minor units; nothing was sent.');
    const key = 'spend-budget.' + createHash('sha256').update(record.artifactRevision).digest('hex');
    const scope = { projectId, sessionId: 'accepted-actions' };
    const overCap = () => new SpendBudgetError('The charge would exceed the owner-configured per-project spend cap of ' + this.limits.projectCapMinor + ' minor units; nothing was sent.');
    if (this.total(projectId, record.artifactRevision) + record.amountMinor > this.limits.projectCapMinor) throw overCap();
    try {
      const admitted = this.store.admit({
        scope, idempotencyKey: key, kind: RESERVATION_KIND, input: record,
        outbox: { kind: RESERVATION_OUTBOX, payload: { version: 1, artifactRevision: record.artifactRevision } },
        // Admission runs inside the same write transaction as the unique-key check, so the sum
        // cannot be observed by a second charge between the check and this insert.
        guard: () => {
          if (this.total(projectId, record.artifactRevision) + record.amountMinor > this.limits.projectCapMinor) throw overCap();
        }
      });
      if (boundedJson(admitted.operation.input) !== boundedJson(record)) throw new SpendBudgetError('The spend reservation does not match this exact charge; nothing was sent.');
      return { operationId: admitted.operation.id, repeated: admitted.existing, remainingMinor: this.limits.projectCapMinor - this.total(projectId) };
    } catch (error) {
      if (error instanceof SpendBudgetError) throw error;
      if (error instanceof ControlStoreError && /spend cap/.test(error.message)) throw overCap();
      if (error instanceof ControlStoreError) throw new SpendBudgetError('The spend budget could not reserve this charge; nothing was sent.');
      throw error;
    }
  }
}
