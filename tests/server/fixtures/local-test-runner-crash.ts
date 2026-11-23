import { ControlStore } from '../../../src/server/state/control-store';
import { LocalTestRunner } from '../../../src/server/state/local-test-runner';

// The disposable "application process" for the interruption test. Its parent kills it while the fixed
// recipe is running, so only the durable intent survives. Nothing here retries or settles the job.
const [dataRoot, projectRoot, projectId, agentId, conversationId, taskId] = process.argv.slice(2) as [string, string, string, string, string, string];
const control = new ControlStore(dataRoot);
const runner = new LocalTestRunner(control);
process.stdout.write('started\n');
await runner.run({ projectId, agentId, conversationId, taskId, projectRoot, authorize: () => {}, reserveJob: () => {} });
