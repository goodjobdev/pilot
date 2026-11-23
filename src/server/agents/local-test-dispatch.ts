import { HttpError } from '../board-store';
import { AgentBudgetExceeded } from '../state/agent-budget';
import type { AgentStore } from '../state/agent-store';
import { ControlStoreError, type ControlStore } from '../state/control-store';
import { LocalTestRunner, LocalTestError } from '../state/local-test-runner';
import { authorizeToolUse } from '../../shared/agent-registry';
import { AgentJobRefused, reserveNamedAgentTestJob } from './job-budget';

/**
 * The installed `run_tests` dispatch: the enforcement a model call really reaches.
 *
 * The harness verifies one in-memory effect ticket and hands this port the identity it resolved plus
 * the exact authority snapshot that ticket carries. From there, in order:
 *
 * 1. The bound named agent, its `run_tests` scope, the project grant and the versioned authority are
 *    re-read synchronously. A change since the ticket refuses before anything is reserved or written.
 * 2. One rolling-hour job is reserved through the durable ledger, whose guard re-checks binding,
 *    revision, scope and project inside the admission transaction.
 * 3. The local runner re-reads the same authority in the durable intent's transaction and once more
 *    immediately before it spawns the fixed `node --test` recipe.
 *
 * A fork is refused: the fixed recipe's working directory is the registered project root, not the
 * fork worktree, so running it there would test the wrong tree. Nothing here is a sandbox.
 */
export type LocalTestDispatchRequest = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly taskId: string;
  /** The authority snapshot the privilege hook verified for this call. */
  readonly expectedAuthority: string;
  readonly signal?: AbortSignal;
};

export function localTestPort(input: {
  readonly control: () => ControlStore | undefined;
  readonly agents: () => AgentStore | undefined;
  readonly runner: () => LocalTestRunner | undefined;
  readonly projectRoot: (projectId: string) => string | undefined;
  readonly isFork: (projectId: string, sessionId: string) => boolean;
}): { run(request: LocalTestDispatchRequest): Promise<unknown> } {
  return {
    run: async (request) => {
      const control = input.control(), agents = input.agents(), runner = input.runner();
      if (!control || !agents || !runner)
        throw new HttpError(503, 'Test execution is unavailable: the durable control store or the agent registry is not open. No test job was started.');
      const projectRoot = input.projectRoot(request.projectId);
      if (projectRoot === undefined) throw new HttpError(404, 'The project is not registered on this instance. No test job was started.');
      if (input.isFork(request.projectId, request.sessionId))
        throw new HttpError(409, 'Test execution is unavailable in a fork: the fixed recipe runs at the registered project root. No test job was started.');
      const authorize = () => {
        const binding = agents.binding(request.projectId, request.sessionId);
        const authority = agents.versionedAuthorityForSession({ projectId: request.projectId, sessionId: request.sessionId });
        if (!binding || binding.agentId !== request.agentId || authority.agentId !== request.agentId || authority.scopes === null ||
            !authorizeToolUse({ scopes: authority.scopes, tool: 'run_tests' }).permitted ||
            (authority.projects !== null && !authority.projects.includes(request.projectId)) ||
            JSON.stringify(authority) !== request.expectedAuthority)
          throw new HttpError(403, 'Test-execution authority changed or is unavailable. No test job was started.');
      };
      try {
        return await runner.run({
          projectId: request.projectId,
          agentId: request.agentId,
          conversationId: request.conversationId,
          taskId: request.taskId,
          projectRoot,
          authorize,
          reserveJob: () => reserveNamedAgentTestJob({ control, agents, projectId: request.projectId, sessionId: request.sessionId, agentId: request.agentId }),
          signal: request.signal
        });
      } catch (error) {
        if (error instanceof LocalTestError) throw new HttpError(error.code === 'UNAVAILABLE' ? 503 : error.code === 'REFUSED' ? 403 : 409, error.message);
        if (error instanceof AgentBudgetExceeded || error instanceof AgentJobRefused) throw new HttpError(409, error.message);
        if (error instanceof ControlStoreError) throw new HttpError(503, 'The durable test record could not be read or written (' + error.message + '). Inspect the job before retrying.');
        throw error;
      }
    }
  };
}
