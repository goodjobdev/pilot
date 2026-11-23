// Uninstalled experiment: its store and helper are synthetic, not deployment authority.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

export function bindingOf(input) {
  const { operation, resource, target, revision, targetDigest, artifact, active, generation } = input;
  if (!id(operation) || !id(resource) || !id(target) || !Number.isSafeInteger(revision) || revision < 1 ||
      !hex(targetDigest) || !hex(artifact) || !hex(active) || !Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(generation + 1)) throw new Error('invalid binding');
  return { operation, resource, target, revision, targetDigest, artifact, active, generation };
}
const fingerprint = (binding) => digest(JSON.stringify(['static-lifecycle-experiment-v1', binding.operation,
  binding.resource, binding.target, binding.revision, binding.targetDigest, binding.artifact, binding.active, binding.generation]));

export class StaticLifecycleExperiment {
  constructor(path, helper, currentTarget) {
    this.helper = helper;
    this.currentTarget = currentTarget;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS intents (
        operation TEXT PRIMARY KEY, resource TEXT NOT NULL UNIQUE, binding TEXT NOT NULL,
        fingerprint TEXT NOT NULL, state TEXT NOT NULL
      );`);
  }
  close() { this.db.close(); }
  inspect(operation) { return this.db.prepare('SELECT * FROM intents WHERE operation = ?').get(operation); }
  state(operation, state) { this.db.prepare('UPDATE intents SET state = ? WHERE operation = ?').run(state, operation); }
  async run(input) {
    const binding = bindingOf(input);
    const mark = fingerprint(binding);
    // A unique resource row is a permanent barrier, including after successful completion.
    // No recovery or release policy is invented by this experiment.
    this.db.prepare('INSERT INTO intents VALUES (?, ?, ?, ?, ?)')
      .run(binding.operation, binding.resource, JSON.stringify(binding), mark, 'intent');
    const matchesTarget = () => {
      const target = this.currentTarget();
      return target.target === binding.target && target.revision === binding.revision && target.targetDigest === binding.targetDigest && target.resource === binding.resource;
    };
    if (!matchesTarget()) { this.state(binding.operation, 'refused'); return 'refused'; }
    // Persist uncertainty before calling the helper, including if the process dies mid-call.
    this.state(binding.operation, 'stage-unknown');
    try {
      const staged = await this.helper.stage({ ...binding, fingerprint: mark });
      if (staged?.fingerprint !== mark || staged?.artifact !== binding.artifact || staged?.operation !== binding.operation) return 'stage-unknown';
      if (!matchesTarget()) { this.state(binding.operation, 'staged-target-changed'); return 'staged-target-changed'; }
      this.state(binding.operation, 'activate-unknown');
      const activated = await this.helper.activate({ ...binding, fingerprint: mark });
      if (activated?.fingerprint !== mark || activated?.operation !== binding.operation ||
          activated?.active !== binding.artifact || activated?.generation !== binding.generation + 1) return 'activate-unknown';
      this.state(binding.operation, 'activated');
      return 'activated';
    } catch {
      return this.inspect(binding.operation).state;
    }
  }
}
