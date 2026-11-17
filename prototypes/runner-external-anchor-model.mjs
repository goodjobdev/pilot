// Disposable, in-memory protocol model. Not imported by Pilot or a runtime adapter.
import { createHash } from 'node:crypto';

const copy = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = (state) => createHash('sha256').update('pilot-anchor-model-v1\0' + JSON.stringify(state)).digest('hex');
const record = (state) => ({ version: 1, runner: state.runner, epoch: state.epoch, sequence: state.sequence, digest: digest(state) });

export class FakeAuthority {
  constructor() { this.records = new Map(); this.audit = []; this.readFault = null; this.casFault = null; }
  read(id) {
    if (this.readFault) throw new Error(`authority-${this.readFault}`);
    return this.records.has(id) ? { status: 'allocated', record: copy(this.records.get(id)) } : { status: 'unallocated' };
  }
  allocate(id, value) {
    if (this.records.has(id) || value.runner !== id) throw new Error('allocation-refused');
    this.records.set(id, copy(value)); this.audit.push({ kind: 'allocate', id, record: copy(value) });
  }
  cas(id, before, after) {
    if (this.casFault === 'before') throw new Error('cas-unknown');
    if (!equal(this.records.get(id), before) || after.runner !== id || after.epoch !== before.epoch || after.sequence !== before.sequence + 1) throw new Error('cas-refused');
    this.records.set(id, copy(after));
    if (this.casFault === 'after') throw new Error('cas-unknown');
  }
}

export class AnchorModel {
  constructor(authority, runner) {
    this.authority = authority; this.runner = runner; this.journal = null;
    this.enabled = false; this.generation = 0; this.busy = false; this.events = [];
  }
  // Owner-only ceremony; explicit interruption points leave artifacts untouched.
  provision({ epoch = 'epoch-1', journalId = 'journal-1', interrupt } = {}) {
    this.enabled = false;
    if (this.journal || this.authority.read(this.runner).status !== 'unallocated') throw new Error('provision-refused');
    this.journal = { runner: this.runner, journalId, epoch, sequence: 0, requests: [] };
    if (interrupt === 'after-journal') throw new Error('interrupted');
    this.authority.allocate(this.runner, record(this.journal));
    if (interrupt === 'after-allocation') throw new Error('interrupted');
    if (!this.matches()) throw new Error('provision-unverified');
  }
  matches() {
    const response = this.authority.read(this.runner);
    return !!this.journal && response.status === 'allocated' && this.journal.runner === this.runner && equal(response.record, record(this.journal));
  }
  // The caller asserts a synthetic fence only. This is not a host/process fence.
  ownerEnable({ syntheticPredecessorFenced = false } = {}) {
    this.enabled = false;
    if (!syntheticPredecessorFenced || !this.matches()) throw new Error('enable-refused');
    this.enabled = true;
  }
  restart() { this.enabled = false; this.generation++; }
  inspect() {
    this.enabled = false;
    try { return { matches: this.matches(), journal: copy(this.journal) }; }
    catch { return { matches: false, journal: copy(this.journal) }; }
  }
  async transition(kind, id, request, { pause, fault } = {}) {
    if (!this.enabled || this.busy) throw new Error('closed');
    this.busy = true;
    const generation = this.generation;
    const live = () => { if (!this.enabled || generation !== this.generation) throw new Error('continuation-fenced'); };
    try {
      live();
      if (!this.matches()) throw new Error('mismatch');
      const before = record(this.journal);
      const existing = this.journal.requests.find((item) => item.id === id);
      if (existing && existing.request !== request) throw new Error('changed-request');
      if (kind !== 'dispatch' && kind !== 'close') throw new Error('invalid-transition');
      if (existing && (kind === 'dispatch' || existing.closed)) return 'duplicate';
      const next = copy(this.journal);
      let item = next.requests.find((entry) => entry.id === id);
      if (!item) { item = { id, request, dispatchPossible: false, closed: false }; next.requests.push(item); next.requests.sort((a, b) => a.id.localeCompare(b.id)); }
      if (kind === 'dispatch') item.dispatchPossible = true;
      else item.closed = true;
      next.sequence++;
      if (fault === 'journal-write') throw new Error('journal-write');
      this.journal = next;
      if (fault === 'after-journal') throw new Error('interrupted');
      if (pause) await pause('after-journal');
      live();
      this.authority.cas(this.runner, before, record(next));
      if (fault === 'after-cas') throw new Error('interrupted');
      if (pause) await pause('after-cas');
      live();
      // This models an indivisible synthetic continuation, not an external effect.
      this.events.push({ kind, id });
      return 'committed';
    } catch (error) { this.enabled = false; throw error; }
    finally { this.busy = false; }
  }
}
