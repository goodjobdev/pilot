import type { HarnessHost } from '../agents/harness-host';
import type { Project } from '../../shared/model';
import { WorkerError } from '../../shared/workers';
import type { WorkerPortResult, WorkerRunPort, WorkerPortRunInput } from './worker-store';

/**
 * The production worker port: one bounded conversation in the application's Pi Durable harness.
 *
 * Model inference stays in the application process, where the owner's provider credentials already
 * live. The contained runner is not involved, has no network and gains no provider path. A project
 * that is no longer registered refuses before any submission.
 */
export function harnessWorkerPort(agents: HarnessHost, projectOf: (projectId: string) => Project | undefined): WorkerRunPort {
  return {
    async run(input: WorkerPortRunInput): Promise<WorkerPortResult> {
      const project = projectOf(input.projectId);
      if (project === undefined) throw new WorkerError('The project is not registered on this instance', 'NOT_FOUND');
      const outcome = await agents.runWorker(project, {
        runId: input.runId,
        workerId: input.workerId,
        model: input.model,
        scopes: input.scopes,
        prompt: input.prompt,
        requestId: input.requestId,
        guard: input.guard,
        onConversation: input.onConversation,
        beforeSubmit: input.beforeSubmit,
        signal: input.signal
      });
      return outcome;
    },
    async cancel(input: { projectId: string; runId: string }): Promise<void> {
      await agents.cancelWorkerRun(input.projectId, input.runId);
    }
  };
}
