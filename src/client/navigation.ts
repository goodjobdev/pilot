/**
 * The browser history behind Pilot's layers.
 *
 * The application state is the truth and history follows it. Each history entry this module
 * writes carries the whole route (project, view, document, session), the full layer list, the
 * layers that entry itself added (`owned`) and a page-load serial. The serial is what makes
 * ownership checkable: a traversal is only taken when the entry it will land on is one this page
 * wrote for that layer. A layer that was folded into an entry by a correction has no entry of its
 * own, so closing it rewrites the current entry and never walks into a foreign page.
 *
 * `sync` gives each added layer its own entry (one per layer), so Back closes exactly one layer.
 * A route change removes the layers above the route first, then pushes the new route. A person's
 * Back or Forward reads the entry's route and layers and applies them; a traversal asks for a
 * specific serial and is only suppressed when that serial really arrived.
 *
 * The address carries the route and not the layers. A direct link and a reload open the same
 * route. A home-screen app gets one guarded entry under the app, only in a standalone display
 * mode; a fullscreen desktop tab is not guarded.
 */

export const VIEWS = ['Dependencies', 'Timeline', 'List', 'Wiki', 'Agents'] as const;
export type View = (typeof VIEWS)[number];

export interface RouteSnapshot {
  /** The selected project, or `null` before one is available. */
  project: string | null;
  /** The board or documentation view. */
  view: View;
  /** The open document path, only while the view is `Wiki`. */
  doc: string | null;
  /** The selected named session, or `''` for the project's root conversation. */
  session: string;
  /** The open layers, oldest first. */
  layers: string[];
}

export interface RouteRead {
  project: string | null;
  view: View | null;
  doc: string | null;
  session: string | null;
}

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, title: string, url?: string | null): void;
  replaceState(data: unknown, title: string, url?: string | null): void;
  go(delta: number): void;
}

/** One entry this page wrote. `owned` is the layers this entry added above its predecessor. */
interface Recorded {
  /** A per-page-load nonce and a serial together identify an entry this load wrote. */
  nonce: string;
  serial: number;
  snapshot: RouteSnapshot;
  owned: string[];
  guard: boolean;
}

interface StoredEntry {
  version: 1;
  nonce: string;
  serial: number;
  snapshot: RouteSnapshot;
  owned: string[];
  guard?: true;
}

const ENTRY_KEY = 'pilot';

export function isView(value: unknown): value is View {
  return typeof value === 'string' && (VIEWS as readonly string[]).includes(value);
}

/** A board view that a narrow screen replaces with the list. Wiki and Agents stay as asked. */
export function narrowView(view: View, narrow: boolean): View {
  return narrow && (view === 'Dependencies' || view === 'Timeline') ? 'List' : view;
}

/** Read the route from a query string. A document or a session implies its own view. */
export function parseRoute(search: string): RouteRead {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const requested = params.get('view');
  const doc = params.get('doc');
  const session = params.get('session');
  let view: View | null = isView(requested) ? requested : null;
  if (view === null && doc) view = 'Wiki';
  if (view === null && session) view = 'Agents';
  return {
    project: params.get('project') || null,
    view,
    doc: doc || null,
    session: session || null,
  };
}

/** The address for one route. Layers stay in history state, not in the address. */
export function urlForRoute(snapshot: RouteSnapshot, pathname: string): string {
  const params = new URLSearchParams();
  if (snapshot.project) params.set('project', snapshot.project);
  params.set('view', snapshot.view);
  if (snapshot.view === 'Wiki' && snapshot.doc) params.set('doc', snapshot.doc);
  if (snapshot.view === 'Agents' && snapshot.session) params.set('session', snapshot.session);
  return pathname + '?' + params.toString();
}

export function sameRoute(a: RouteSnapshot, b: RouteSnapshot): boolean {
  return (
    a.project === b.project &&
    a.view === b.view &&
    a.doc === b.doc &&
    a.session === b.session
  );
}

export function sameSnapshot(a: RouteSnapshot, b: RouteSnapshot): boolean {
  return sameRoute(a, b) && sameLayers(a.layers, b.layers);
}

export function sameLayers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/** Whether `short` is the beginning of `long` (the same layers, with fewer above them). */
export function isPrefix(short: readonly string[], long: readonly string[]): boolean {
  return short.length <= long.length && short.every((key, index) => key === long[index]);
}

export function cloneSnapshot(snapshot: RouteSnapshot): RouteSnapshot {
  return { ...snapshot, layers: [...snapshot.layers] };
}

function cleanOwned(owned: unknown, layers: readonly string[]): string[] {
  if (!Array.isArray(owned)) return [];
  const keys = owned.filter((key): key is string => typeof key === 'string');
  return keys.every((key) => layers.includes(key)) ? keys : [];
}

/** Validate an entry this module wrote. Anything else is another page's state. */
export function readEntry(raw: unknown): Recorded | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = (raw as Record<string, unknown>)[ENTRY_KEY] as StoredEntry | undefined;
  if (!entry || entry.version !== 1 || typeof entry.snapshot !== 'object' || entry.snapshot === null) return null;
  const snapshot = entry.snapshot as Partial<RouteSnapshot>;
  if (typeof snapshot.project !== 'string' && snapshot.project !== null) return null;
  if (!isView(snapshot.view)) return null;
  if (typeof snapshot.doc !== 'string' && snapshot.doc !== null) return null;
  if (typeof snapshot.session !== 'string') return null;
  if (!Array.isArray(snapshot.layers) || !snapshot.layers.every((key) => typeof key === 'string')) return null;
  const layers = [...snapshot.layers];
  const serial = typeof entry.serial === 'number' && Number.isSafeInteger(entry.serial) && entry.serial > 0 ? entry.serial : 0;
  const nonce = typeof entry.nonce === 'string' && entry.nonce.length > 0 && entry.nonce.length <= 160 ? entry.nonce : '';
  return {
    nonce,
    serial,
    snapshot: {
      project: snapshot.project ?? null,
      view: snapshot.view,
      doc: snapshot.doc ?? null,
      session: snapshot.session,
      layers,
    },
    owned: cleanOwned(entry.owned, layers),
    guard: entry.guard === true,
  };
}

function pack(entry: Recorded): Record<string, StoredEntry> {
  const stored: StoredEntry = {
    version: 1,
    nonce: entry.nonce,
    serial: entry.serial,
    snapshot: cloneSnapshot(entry.snapshot),
    owned: [...entry.owned],
  };
  if (entry.guard) stored.guard = true;
  return { [ENTRY_KEY]: stored };
}

export interface StackOptions {
  history: HistoryLike;
  /** The route the application currently shows. */
  snapshot: () => RouteSnapshot;
  /** Apply one route. It must set the application state to it before it resolves. */
  apply: (target: RouteSnapshot) => void | Promise<void>;
  /** Refuse a traversal that would discard unsaved work. Returning false cancels it. */
  canLeave?: (current: RouteSnapshot, target: RouteSnapshot) => boolean;
  /** The address for a route, without layers. */
  urlFor: (snapshot: RouteSnapshot) => string;
  /** How long one traversal may wait for its popstate. A traversal that never arrives resolves. */
  timeoutMs?: number;
}

/**
 * Keep history aligned with the application's snapshot.
 *
 * Every layer added by the application gets its own entry. A layer that a correction folded into
 * an entry has no entry of its own and is closed by rewriting that entry. A traversal is only
 * made to an entry this page recorded, and only when the serial that arrives is the one expected.
 */
export class HistoryStack {
  private readonly nonce = makeNonce();
  private current: Recorded;
  private entries: Recorded[] = [];
  private index = -1;
  private detached = false;
  private nextSerial = 1;
  private basePath = '/';
  private started = false;
  private applying = false;
  private desired: RouteSnapshot | null = null;
  private running = false;
  private expected = 0;
  private expectedSerial: number | null = null;
  private expectedMatched = false;
  private resolveExpected: (() => void) | null = null;
  private readonly history: HistoryLike;
  private readonly snapshot: () => RouteSnapshot;
  private readonly applyRoute: (target: RouteSnapshot) => void | Promise<void>;
  private readonly canLeave: (current: RouteSnapshot, target: RouteSnapshot) => boolean;
  private readonly urlFor: (snapshot: RouteSnapshot) => string;
  private readonly timeoutMs: number;

  constructor(options: StackOptions) {
    this.history = options.history;
    this.snapshot = options.snapshot;
    this.applyRoute = options.apply;
    this.canLeave = options.canLeave ?? (() => true);
    this.urlFor = options.urlFor;
    this.timeoutMs = options.timeoutMs ?? 500;
    this.current = this.record(options.snapshot(), []);
  }

  private record(snapshot: RouteSnapshot, owned: string[], guard = false): Recorded {
    return { nonce: this.nonce, serial: this.nextSerial++, snapshot: cloneSnapshot(snapshot), owned: [...owned], guard };
  }

  /** Replace the page's own entry with the resolved route. Called once, after boot. */
  start(options: { homeScreen?: boolean } = {}): void {
    const snapshot = cloneSnapshot(this.snapshot());
    this.basePath = typeof location === 'undefined' ? '/' : location.pathname;
    this.current = this.record(snapshot, []);
    this.entries = [this.current];
    this.index = 0;
    this.detached = false;
    this.history.replaceState(pack(this.current), '', this.urlFor(this.current.snapshot));
    this.started = true;
    // One extra entry under the app, so a standalone app's own Back finds the app rather than the
    // blank page outside it. A normal tab and a desktop fullscreen tab are not guarded.
    if (options.homeScreen) this.pushRecord(this.record(snapshot, [], true));
  }

  get ready(): boolean {
    return this.started;
  }

  /** Follow the application state. Coalesces changes that arrive while a traversal is in flight. */
  sync(snapshot: RouteSnapshot): void {
    if (!this.started) return;
    this.desired = cloneSnapshot(snapshot);
    void this.run();
  }

  /**
   * Write the current entry to what the application really shows. A layer that appears here and
   * had no entry gets its own entry, so a later Back closes it instead of leaving the app. A layer
   * that disappeared is folded into this entry (it had no owned entry to go back to).
   */
  replaceCurrent(snapshot: RouteSnapshot): void {
    if (!this.started || this.applying) return;
    const target = cloneSnapshot(snapshot);
    const currentLayers = this.current.snapshot.layers;
    if (isPrefix(currentLayers, target.layers)) {
      const extra = target.layers.slice(currentLayers.length);
      this.replaceRecord({ ...target, layers: currentLayers }, this.current.owned);
      for (const key of extra) {
        const layers = [...this.current.snapshot.layers, key];
        this.pushRecord(this.record({ ...target, layers }, [key]));
      }
    } else {
      this.replaceRecord(target, this.current.owned.filter((key) => target.layers.includes(key)));
    }
    void this.run();
  }

  /** The browser's own Back or Forward. */
  onPop(raw: unknown): void {
    if (!this.started) return;
    const entry = readEntry(raw);
    if (this.expected > 0) {
      const matched = entry !== null && entry.nonce === this.nonce && (this.expectedSerial === null || entry.serial === this.expectedSerial);
      if (matched) {
        this.resolveExpected?.();
        return;
      }
      // Another entry arrived while this module was traversing: unblock, then treat it as real.
      this.expectedMatched = false;
      this.resolveExpected?.();
    }
    if (entry === null) {
      this.detach();
      // A cross-document Back already left this page. A same-document foreign entry is re-anchored
      // to what the application shows, so the address and the state do not disagree afterwards.
      if (typeof location === 'undefined' || location.pathname === this.basePath) {
        this.replaceRecord(this.snapshot(), []);
      }
      return;
    }
    const own = entry.nonce === this.nonce;
    const at = own ? this.entries.findIndex((candidate) => candidate.serial === entry.serial) : -1;
    if (at >= 0) {
      this.index = at;
      this.detached = false;
      // Keep the forward entries: the browser's Forward stack still holds them, and a later
      // Forward must find them as this page's own entries.
      this.current = this.entries[at];
    } else {
      // An entry from an earlier page load stays readable: its route is applied below. It is never
      // treated as this load's own, even when its serial happens to match.
      this.detached = true;
      this.index = -1;
      this.entries = [];
      this.current = entry;
    }
    const target = entry.snapshot;
    const shown = this.snapshot();
    if (sameSnapshot(target, shown)) {
      if (this.detached || this.index < 0) this.replaceRecord(shown, entry.owned);
      else this.current = entry;
      return;
    }
    if (!this.canLeave(shown, target)) {
      this.cancel(shown, entry);
      return;
    }
    void this.applyFromHistory(entry);
  }

  /** Cancel a traversal the guard refused: write the shown route above the entry Back reached. */
  private cancel(shown: RouteSnapshot, landed: Recorded): void {
    const base = landed.snapshot.layers;
    const owned = isPrefix(base, shown.layers) ? shown.layers.slice(base.length) : [];
    this.pushRecord(this.record(shown, owned));
  }

  private detach(): void {
    this.entries = [];
    this.index = -1;
    this.detached = true;
    this.current = this.record(this.snapshot(), []);
    this.current.serial = 0;
  }

  private replaceRecord(snapshot: RouteSnapshot, owned: string[]): void {
    const rec = this.record(snapshot, owned);
    if (this.detached || this.index < 0) {
      this.entries = [rec];
      this.index = 0;
      this.detached = false;
    } else {
      this.entries[this.index] = rec;
    }
    this.current = rec;
    this.history.replaceState(pack(rec), '', this.urlFor(rec.snapshot));
  }

  private pushRecord(rec: Recorded): void {
    if (this.detached || this.index < 0) {
      this.entries = [rec];
      this.index = 0;
      this.detached = false;
    } else {
      this.entries = this.entries.slice(0, this.index + 1);
      this.entries.push(rec);
      this.index += 1;
    }
    this.current = rec;
    this.history.pushState(pack(rec), '', this.urlFor(rec.snapshot));
  }

  /** One traversal, expected to land on `serial`. Resolves false when another entry arrived. */
  private async traverse(delta: number, serial: number | null): Promise<boolean> {
    if (delta === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (matched: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.expected = Math.max(0, this.expected - 1);
        if (this.resolveExpected === expectedResolve) this.resolveExpected = null;
        resolve(matched);
      };
      const expectedResolve = () => finish(this.expectedMatched);
      const timer = setTimeout(() => {
        this.expectedMatched = false;
        finish(false);
      }, this.timeoutMs);
      this.expected += 1;
      this.expectedSerial = serial;
      this.expectedMatched = true;
      this.resolveExpected = expectedResolve;
      this.history.go(delta);
    });
  }

  private canTraverseTop(top: string): boolean {
    if (this.detached || this.index <= 0) return false;
    const rec = this.entries[this.index];
    const under = this.entries[this.index - 1];
    if (!rec || rec.nonce !== this.nonce || rec.serial !== this.current.serial) return false;
    if (rec.owned.length === 0 || rec.owned[rec.owned.length - 1] !== top) return false;
    return under.snapshot.layers.length === rec.snapshot.layers.length - 1 && isPrefix(under.snapshot.layers, rec.snapshot.layers);
  }

  /** Go back to the entry under this one, if this page wrote it for the top layer. */
  private async traverseTop(): Promise<boolean> {
    const target = this.entries[this.index - 1];
    if (!target) return false;
    if (!(await this.traverse(-1, target.serial))) {
      // A lost popstate or an entry this page did not write: keep the shown route and stop
      // claiming the layer has an entry of its own.
      this.detach();
      this.replaceRecord(this.snapshot(), []);
      return false;
    }
    this.index -= 1;
    this.current = this.entries[this.index];
    return true;
  }

  private foldTop(): void {
    const layers = this.current.snapshot.layers.slice(0, -1);
    this.replaceRecord({ ...this.current.snapshot, layers }, this.current.owned.filter((key) => layers.includes(key)));
  }

  /** Remove layers until the current layers are a prefix of `target`. */
  private async removeLayersDownTo(target: string[]): Promise<void> {
    while (this.current.snapshot.layers.length > 0 && !isPrefix(this.current.snapshot.layers, target)) {
      const top = this.current.snapshot.layers[this.current.snapshot.layers.length - 1];
      if (this.canTraverseTop(top)) {
        if (!(await this.traverseTop())) return;
      } else {
        this.foldTop();
      }
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // A change that arrives during an apply stays queued; the apply finishes and calls run again.
      while (this.desired !== null && !this.applying) {
        const next = this.desired;
        this.desired = null;
        await this.reconcile(next);
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcile(next: RouteSnapshot): Promise<void> {
    if (this.applying) {
      // Keep the intent; the next run (after the apply) processes it.
      if (this.desired === null) this.desired = next;
      return;
    }
    if (sameSnapshot(next, this.current.snapshot)) return;
    const routeChanged = !sameRoute(next, this.current.snapshot);
    if (!routeChanged && isPrefix(this.current.snapshot.layers, next.layers)) {
      const added = next.layers.slice(this.current.snapshot.layers.length);
      for (const key of added) {
        const layers = [...this.current.snapshot.layers, key];
        this.pushRecord(this.record({ ...next, layers }, [key]));
      }
      return;
    }
    if (!routeChanged && isPrefix(next.layers, this.current.snapshot.layers)) {
      await this.removeLayersDownTo(next.layers);
      if (!sameSnapshot(next, this.current.snapshot)) this.replaceCurrent(next);
      return;
    }
    // A route change, or a layer replaced in place: remove the layers above the route first so Back
    // from the new route lands under it rather than on a layer of the route just left. The route
    // entry owns no layer; each layer the new route shows then gets an entry of its own.
    const firstProject = this.current.snapshot.project === null && next.project !== null;
    await this.removeLayersDownTo([]);
    // The empty workspace before the first project has no page to go back to: the first project
    // takes its entry, so Back from that project leaves the app instead of reopening an empty app.
    if (firstProject) this.replaceRecord({ ...next, layers: [] }, []);
    else this.pushRecord(this.record({ ...next, layers: [] }, []));
    for (const key of next.layers) {
      const layers = [...this.current.snapshot.layers, key];
      this.pushRecord(this.record({ ...next, layers }, [key]));
    }
  }

  private async applyFromHistory(entry: Recorded): Promise<void> {
    const own = entry.nonce === this.nonce;
    this.applying = true;
    this.current = entry;
    try {
      await this.applyRoute(entry.snapshot);
    } finally {
      this.applying = false;
      const shown = this.snapshot();
      // An older entry's route is readable, but the entry is not this load's own. Re-anchor the
      // current position with this load's nonce, even when the shown route already matches, so a
      // later close can traverse to an entry this load really wrote.
      if (!own || !sameSnapshot(shown, this.current.snapshot)) this.replaceCurrent(shown);
      void this.run();
    }
  }
}

/** A home-screen app: only an installed standalone display mode, not a desktop fullscreen tab. */
/** A nonce for one page load. It makes a serial from another load impossible to own by accident. */
function makeNonce(): string {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === 'function') return source.randomUUID();
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

export function shouldGuardHomeScreen(options: { standalone: boolean; standaloneDisplay: boolean }): boolean {
  return options.standalone || options.standaloneDisplay;
}

export function isHomeScreen(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return shouldGuardHomeScreen({
    standalone,
    standaloneDisplay: window.matchMedia('(display-mode: standalone)').matches,
  });
}
