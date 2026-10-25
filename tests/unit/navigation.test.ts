import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HistoryStack,
  cloneSnapshot,
  isPrefix,
  narrowView,
  parseRoute,
  readEntry,
  sameRoute,
  shouldGuardHomeScreen,
  urlForRoute,
  type HistoryLike,
  type RouteSnapshot,
} from '../../src/client/navigation';

const base: RouteSnapshot = { project: 'p1', view: 'List', doc: null, session: '', layers: [] };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A history with the same push/replace/go semantics the stack relies on. */
class FakeHistory implements HistoryLike {
  entries: { state: unknown; url: string }[] = [{ state: null, url: '/start' }];
  index = 0;
  listener: (() => void) | null = null;
  /** When true, a traversal changes the index but never delivers its popstate. */
  silentGo = false;

  get state(): unknown {
    return this.entries[this.index].state;
  }
  pushState(data: unknown, _title: string, url?: string | null): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ state: data, url: url ?? '' });
    this.index += 1;
  }
  replaceState(data: unknown, _title: string, url?: string | null): void {
    this.entries[this.index] = { state: data, url: url ?? '' };
  }
  go(delta: number): void {
    this.index += delta;
    if (!this.silentGo) queueMicrotask(() => this.listener?.());
  }
  /** The person's own Back, without the module asking for it. */
  back(): void {
    this.index = Math.max(0, this.index - 1);
    this.listener?.();
  }
}

function subjectFor(options: {
  canLeave?: (a: RouteSnapshot, b: RouteSnapshot) => boolean;
  onApply?: () => void;
} = {}) {
  const fake = new FakeHistory();
  let shown = cloneSnapshot(base);
  const stack = new HistoryStack({
    history: fake,
    snapshot: () => shown,
    apply: (target) => {
      shown = cloneSnapshot(target);
      options.onApply?.();
    },
    canLeave: options.canLeave,
    urlFor: (snapshot) => '/?view=' + snapshot.view,
    timeoutMs: 20,
  });
  fake.listener = () => stack.onPop(fake.state);
  return {
    fake,
    stack,
    get shown() {
      return shown;
    },
    set shown(next: RouteSnapshot) {
      shown = cloneSnapshot(next);
    },
  };
}

test('a document or a session in the address implies its own view', () => {
  assert.deepEqual(parseRoute('?project=p1&doc=docs/a.md'), {
    project: 'p1',
    view: 'Wiki',
    doc: 'docs/a.md',
    session: null,
  });
  assert.deepEqual(parseRoute('?project=p1&session=s1'), {
    project: 'p1',
    view: 'Agents',
    doc: null,
    session: 's1',
  });
  assert.equal(parseRoute('?view=not-a-view').view, null);
  assert.deepEqual(parseRoute(''), { project: null, view: null, doc: null, session: null });
});

test('the address carries the route and the layers stay in history state', () => {
  const wiki = urlForRoute({ ...base, view: 'Wiki', doc: 'docs/a.md' }, '/');
  assert.match(wiki, /view=Wiki/);
  assert.match(wiki, /doc=docs%2Fa.md/);
  assert.doesNotMatch(wiki, /session=/);
  const agents = urlForRoute({ ...base, view: 'Agents', session: 's1' }, '/');
  assert.match(agents, /session=s1/);
  assert.doesNotMatch(agents, /doc=/);
  const list = urlForRoute({ ...base, doc: 'ignored' }, '/');
  assert.doesNotMatch(list, /doc=/);
});

test('a narrow screen replaces only the board views with the list', () => {
  assert.equal(narrowView('Dependencies', true), 'List');
  assert.equal(narrowView('Timeline', true), 'List');
  assert.equal(narrowView('Wiki', true), 'Wiki');
  assert.equal(narrowView('Agents', true), 'Agents');
  assert.equal(narrowView('Dependencies', false), 'Dependencies');
});

test('layer prefixes are the only layer change that adds or removes one entry', () => {
  assert.equal(isPrefix([], ['menu']), true);
  assert.equal(isPrefix(['menu'], ['menu', 'dialog']), true);
  assert.equal(isPrefix(['dialog'], ['menu', 'dialog']), false);
  assert.equal(isPrefix(['menu', 'dialog'], ['menu']), false);
});

test('an entry is read back only when it has this module’s shape', () => {
  assert.equal(readEntry(null), null);
  assert.equal(readEntry({ other: true }), null);
  assert.equal(readEntry({ pilot: { version: 1, snapshot: { ...base, view: 'Nope' } } }), null);
  assert.equal(readEntry({ pilot: { version: 1, snapshot: { ...base, layers: [1] } } }), null);
  const entry = readEntry({ pilot: { version: 1, snapshot: { ...base, layers: ['menu:actions'] } } });
  assert.deepEqual(entry?.snapshot, { ...base, layers: ['menu:actions'] });
  assert.equal(entry?.serial, 0);
  assert.equal(entry?.nonce, '');
  assert.deepEqual(entry?.owned, []);
  assert.equal(entry?.guard, false);
  const owned = readEntry({ pilot: { version: 1, nonce: 'load-a', serial: 7, snapshot: { ...base, layers: ['menu:actions'] }, owned: ['menu:actions'] } });
  assert.equal(owned?.serial, 7);
  assert.equal(owned?.nonce, 'load-a');
  assert.deepEqual(owned?.owned, ['menu:actions']);
});

test('only an installed standalone display mode guards the root', () => {
  assert.equal(shouldGuardHomeScreen({ standalone: true, standaloneDisplay: false }), true);
  assert.equal(shouldGuardHomeScreen({ standalone: false, standaloneDisplay: true }), true);
  // A desktop fullscreen tab reports fullscreen, not standalone, and is not guarded.
  assert.equal(shouldGuardHomeScreen({ standalone: false, standaloneDisplay: false }), false);
});

test('an opened layer pushes one entry and an in-app close takes it back off', async () => {
  const subject = subjectFor();
  subject.stack.start();
  const startIndex = subject.fake.index;

  subject.shown = { ...base, layers: ['menu:actions'] };
  subject.stack.sync(subject.shown);
  await settle();
  assert.equal(subject.fake.index, startIndex + 1);
  assert.equal(readEntry(subject.fake.state)?.snapshot.layers[0], 'menu:actions');

  subject.shown = cloneSnapshot(base);
  subject.stack.sync(subject.shown);
  await settle();
  assert.equal(subject.fake.index, startIndex);
  assert.deepEqual(readEntry(subject.fake.state)?.snapshot, base);
});

test('the person’s Back applies the entry under the newest layer, and Forward restores it', async () => {
  let applied = 0;
  const subject = subjectFor({ onApply: () => (applied += 1) });
  subject.stack.start();
  subject.shown = { ...base, layers: ['menu:actions'] };
  subject.stack.sync(subject.shown);
  await settle();

  subject.fake.back();
  await settle();
  assert.deepEqual(subject.shown, base);
  assert.equal(applied, 1);

  // Forward is the browser's own: the entry is read and applied again.
  subject.fake.index += 1;
  subject.fake.listener?.();
  await settle();
  assert.deepEqual(subject.shown.layers, ['menu:actions']);
  assert.equal(applied, 2);
});

test('a route change removes the layers above it before it writes the new route', async () => {
  const subject = subjectFor();
  subject.stack.start();
  subject.shown = { ...base, layers: ['menu:actions'] };
  subject.stack.sync(subject.shown);
  await settle();
  const withLayer = subject.fake.index;

  subject.shown = { ...base, view: 'Wiki', layers: [] };
  subject.stack.sync(subject.shown);
  await settle();
  assert.equal(subject.fake.index, withLayer);
  const written = readEntry(subject.fake.state)!.snapshot;
  assert.deepEqual(written, { ...base, view: 'Wiki', layers: [] });
  assert.equal(sameRoute(written, base), false);
});

test('a refused traversal stays on the shown route and writes it at the entry reached', async () => {
  let refusals = 0;
  const subject = subjectFor({
    canLeave: () => {
      refusals += 1;
      return false;
    },
  });
  subject.stack.start();
  subject.shown = { ...base, layers: ['dialog:settings'] };
  subject.stack.sync(subject.shown);
  await settle();
  const withDialog = cloneSnapshot(subject.shown);

  subject.fake.back();
  await settle();
  assert.equal(refusals, 1);
  assert.deepEqual(subject.shown, withDialog);
  assert.deepEqual(readEntry(subject.fake.state)?.snapshot, withDialog);
});

test('replaceCurrent corrects the current entry without adding one', () => {
  const subject = subjectFor();
  subject.stack.start();
  const startIndex = subject.fake.index;
  const corrected = { ...base, session: '' };
  subject.shown = corrected;
  subject.stack.replaceCurrent(corrected);
  assert.equal(subject.fake.index, startIndex);
  assert.deepEqual(readEntry(subject.fake.state)?.snapshot, corrected);
});

test('a layer shown by a correction gets its own entry, so closing it stays in the app', async () => {
  const subject = subjectFor();
  subject.stack.start();
  const startIndex = subject.fake.index;

  // The shell fell back and opened the named-session list in the same step as the correction.
  subject.shown = { ...base, layers: ['panel:sessions'] };
  subject.stack.replaceCurrent(subject.shown);
  assert.equal(subject.fake.index, startIndex + 1);
  assert.deepEqual(readEntry(subject.fake.state)?.owned, ['panel:sessions']);

  // Closing the list in the app takes its own entry back off. It does not leave the app.
  subject.shown = cloneSnapshot(base);
  subject.stack.sync(subject.shown);
  await settle();
  assert.equal(subject.fake.index, startIndex);
  assert.deepEqual(readEntry(subject.fake.state)?.snapshot, base);
});

test('an entry with the same serial from another page load is readable but not owned', async () => {
  const older = subjectFor();
  older.stack.start();
  const olderState = older.fake.state;

  const subject = subjectFor();
  subject.shown = { ...base, view: 'Wiki' };
  subject.stack.start();
  subject.stack.onPop(olderState);
  await settle();
  // The older route stays readable and is applied.
  assert.deepEqual(subject.shown, base);

  // The route is readable, but the entry is re-anchored with this load's nonce. It is never
  // mistaken for the older load's own entry.
  const current = readEntry(subject.fake.state);
  assert.deepEqual(current?.snapshot, base);
  assert.notEqual(current?.nonce, readEntry(olderState)?.nonce);
  assert.ok(current?.nonce);
  assert.notEqual(current?.nonce, readEntry(olderState)?.nonce);

  // A layer opened now and closed in the app traverses to that re-anchored entry, not the older one.
  subject.shown = { ...base, layers: ['dialog:settings'] };
  subject.stack.sync(subject.shown);
  await settle();
  const at = subject.fake.index;
  subject.shown = cloneSnapshot(base);
  subject.stack.sync(subject.shown);
  await settle();
  assert.equal(subject.fake.index, at - 1);
  assert.deepEqual(readEntry(subject.fake.state)?.snapshot, base);
});

test('a foreign entry under a layer is re-anchored, not walked past', async () => {
  const subject = subjectFor();
  subject.stack.start();
  // A page script writes an entry this module did not create.
  subject.fake.pushState({ foreign: true }, '', '/?foreign=1');
  const foreignIndex = subject.fake.index;

  subject.shown = { ...base, layers: ['dialog:settings'] };
  subject.stack.sync(subject.shown);
  await settle();
  subject.shown = cloneSnapshot(base);
  subject.stack.sync(subject.shown);
  await settle();

  // The close stopped at the foreign entry; the app still shows its route, and that entry now
  // carries this page's entry instead of the foreign state.
  assert.deepEqual(subject.shown, base);
  assert.equal(subject.fake.index, foreignIndex);
  assert.deepEqual(readEntry(subject.fake.state)?.snapshot, base);

  // The next Back reaches the app's own base entry, not a dead end outside the app.
  subject.fake.back();
  await settle();
  assert.deepEqual(readEntry(subject.fake.state)?.snapshot, base);
});

test('a traversal that never arrives resolves instead of looping', async () => {
  const subject = subjectFor();
  subject.fake.silentGo = true;
  subject.stack.start();
  subject.shown = { ...base, layers: ['menu:actions'] };
  subject.stack.sync(subject.shown);
  await settle();
  const indexed = subject.fake.index;

  subject.shown = cloneSnapshot(base);
  subject.stack.sync(subject.shown);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  // One traversal was asked for; the timeout lets it finish and nothing repeats it. The entry it
  // reached is the layer's own predecessor, which is the route now shown.
  assert.equal(subject.fake.index, indexed - 1);
  assert.deepEqual(readEntry(subject.fake.state)?.snapshot, base);
});
