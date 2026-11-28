// Synthetic, uninstalled experiment. Never connect this to a runtime or production journal.
import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync } from 'node:fs';

const fields = ['jobId', 'policyRevision', 'snapshotDigest'];
function envelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== [...fields].sort().join(',')) {
    throw Error('Invalid synthetic request');
  }
  const snapshot = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' ||
        !descriptor.value.length || descriptor.value.length > 128) throw Error('Invalid synthetic request');
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

export class SyntheticAuthority {
  #db;
  static provision(file) {
    const fd = openSync(file, 'wx', 0o600); closeSync(fd);
    const db = new DatabaseSync(file);
    try { db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, request TEXT NOT NULL,
      decision TEXT NOT NULL, stage TEXT NOT NULL); PRAGMA user_version=1`); }
    finally { db.close(); }
    return new SyntheticAuthority(file);
  }
  constructor(file) {
    const fd = openSync(file, 'r+'); closeSync(fd);
    this.#db = new DatabaseSync(file);
    try {
      this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      if (this.#db.prepare('PRAGMA user_version').get().user_version !== 1) throw Error('Invalid journal');
      this.#db.prepare('SELECT id, request, decision, stage FROM jobs LIMIT 1').all();
    } catch (e) { this.#db.close(); throw e; }
  }
  dispose() { this.#db.close(); }
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (e) { try { this.#db.exec('ROLLBACK'); } catch {} throw e; }
  }
  #decide(request, json, wanted) {
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM jobs WHERE id=?').get(request.jobId);
      if (row) {
        if (row.request !== json) throw Error('Request mismatch');
        if (!['closed-before-dispatch', 'dispatch-possible'].includes(row.decision)) throw Error('Invalid decision');
        return { decision: row.decision, winner: false };
      }
      if (wanted === 'dispatch-possible' && this.#db.prepare("SELECT 1 FROM jobs WHERE decision='dispatch-possible' LIMIT 1").get()) {
        throw Error('Unresolved dispatch barrier');
      }
      this.#db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(request.jobId, json, wanted, wanted === 'dispatch-possible' ? 'admitted' : 'closed');
      return { decision: wanted, winner: wanted === 'dispatch-possible' };
    });
  }
  closeRequest(input) {
    const request = envelope(input);
    const json = JSON.stringify(fields.map(k => request[k]));
    return this.#decide(request, json, 'closed-before-dispatch').decision;
  }
  // The winner alone owns this invocation's continuation. Duplicates and reopen never receive it.
  async dispatch(input, events, gate = async () => {}) {
    const request = envelope(input);
    const json = JSON.stringify(fields.map(k => request[k]));
    const result = this.#decide(request, json, 'dispatch-possible');
    if (!result.winner) return result.decision;
    await gate('admitted');
    this.#advance(request.jobId, json, 'admitted', 'create-intent');
    await gate('create-intent');
    events.push('create'); // synthetic runtime, not an injectable real runtime port
    await gate('created');
    this.#advance(request.jobId, json, 'create-intent', 'start-intent');
    await gate('start-intent');
    events.push('start');
    await gate('started');
    return result.decision;
  }
  // Both synthetic runtime calls pass through this same durable authority, immediately before
  // their intent. An interruption anywhere leaves the permanent barrier in place.
  #advance(id, json, expected, next) {
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if (!row || row.request !== json || row.decision !== 'dispatch-possible' || row.stage !== expected) throw Error('Invalid continuation');
      if (this.#db.prepare('UPDATE jobs SET stage=? WHERE id=? AND stage=?').run(next, id, expected).changes !== 1) throw Error('Lost continuation');
    });
  }
}
