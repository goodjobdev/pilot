import { appendFileSync } from 'node:fs';
import { StaticLifecycleExperiment } from '../../../prototypes/static-lifecycle.mjs';

const [path, effects, operation, gate] = process.argv.slice(2);
const input = { operation, resource: 'synthetic-root', target: 'target', revision: 1,
  targetDigest: 'c'.repeat(64), artifact: 'a'.repeat(64), active: 'b'.repeat(64), generation: 4 };
const wait = () => new Promise(resolve => process.once('message', resolve));
const helper = {
  async stage(b) {
    appendFileSync(effects, `${operation}:stage\n`);
    if (gate === 'stage') { process.send('stage-effect'); await wait(); }
    return { operation: b.operation, fingerprint: b.fingerprint, artifact: b.artifact };
  },
  async activate(b) {
    appendFileSync(effects, `${operation}:activate\n`);
    if (gate === 'activate') { process.send('activate-effect'); await wait(); }
    return { operation: b.operation, fingerprint: b.fingerprint, active: b.artifact, generation: b.generation + 1 };
  }
};
const store = new StaticLifecycleExperiment(path, helper, () => input);
process.send('ready');
await wait();
try { process.send({ result: await store.run(input) }); }
catch (error) { process.send({ error: error.message }); }
store.close();
process.disconnect();
