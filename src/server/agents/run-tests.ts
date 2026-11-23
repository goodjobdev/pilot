import { createHash } from 'node:crypto';
import type { RunnerBroker } from '../state/runner-broker';
import type { RunnerJobRecord } from '../../shared/runner';

/**
 * Orchestrate one fixed test recipe. The caller supplies an authorization check that re-reads the
 * current session, project and grant; it must also reject workspaces it cannot safely associate
 * with that session. This is not a sandbox and does not provide a runtime by itself.
 *
 * Once a job is submitted, every refusal returns its durable ID. In particular, a run failure is
 * not treated as evidence that nothing ran: the owner must inspect/reconcile it before retrying.
 */
/** A stable opaque ID lets an interrupted invocation be correlated with its job after restart. */
export function agentTestJobId(projectId: string, conversationId: string, taskId: string): string {
  if (![projectId, conversationId, taskId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200))
    throw new Error('A test job requires a bounded project, conversation and task identity');
  return 'agent-test-' + createHash('sha256').update(JSON.stringify([projectId, conversationId, taskId])).digest('hex');
}

export async function runAgentTests(input: {
  broker: Pick<RunnerBroker, 'submit' | 'claim' | 'run'>;
  projectId: string;
  conversationId: string;
  taskId: string;
  owner: string;
  workspace: string;
  authorize: () => Promise<void>;
  /** Reserve a job budget before submission; a failed or cancelled reservation is never refunded. */
  reserveJob: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<
  | { status: 'settled'; job: RunnerJobRecord }
  | { status: 'needs-inspection'; jobId: string; stage: 'submission' | 'submitted' | 'claimed' | 'run'; message: string }
> {
  const check = async () => { input.signal?.throwIfAborted(); await input.authorize(); input.signal?.throwIfAborted(); };
  const jobId = agentTestJobId(input.projectId, input.conversationId, input.taskId);
  await check();
  await input.reserveJob(); await check();
  const verify = (job: RunnerJobRecord, state: 'pending' | 'claimed' | 'settled') => {
    if (!job || job.id !== jobId || job.projectId !== input.projectId || job.recipe !== 'test-run' ||
        job.workspace !== input.workspace || job.state !== state ||
        (state !== 'pending' && job.claim?.owner !== input.owner) ||
        (state === 'settled' && !job.result))
      throw new Error('Runner returned a record that does not match this invocation');
  };
  let stage: 'submission' | 'submitted' | 'claimed' | 'run' = 'submission';
  try {
    const submitted = await input.broker.submit({ projectId: input.projectId, recipe: 'test-run', workspace: input.workspace, jobId });
    stage = 'submitted';
    verify(submitted, 'pending');
    await check();
    const claimed = await input.broker.claim({ projectId: input.projectId, owner: input.owner, expectedJobId: jobId });
    stage = 'claimed';
    verify(claimed, 'claimed');
    await check();
    stage = 'run';
    const settled = await input.broker.run({ projectId: input.projectId, owner: input.owner, jobId, signal: input.signal, beforeExecute: check });
    verify(settled, 'settled');
    // A port may ignore or race cancellation; inspect the broker's durable record rather than
    // presenting this invocation as a normal completion after the caller abandoned it.
    if (input.signal?.aborted) return { status: 'needs-inspection', jobId, stage: 'run', message: 'Cancellation raced execution. Inspect the durable job; do not retry automatically.' };
    return { status: 'settled', job: settled };
  } catch {
    return { status: 'needs-inspection', jobId, stage, message: 'Inspect the durable job before retrying; it may not exist, or execution may be uncertain.' };
  }
}
