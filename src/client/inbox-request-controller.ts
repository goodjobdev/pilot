export type InboxRequestOutcome = 'loaded' | 'failed' | 'stale';

export interface InboxRequestEffects<T> {
  start(): void;
  success(value: T): void;
  failure(): void;
}

/** Serializes inbox request state publication; only the newest non-invalidated request may publish. */
export class InboxRequestController {
  private generation = 0;

  invalidate(): void {
    this.generation += 1;
  }

  async load<T>(request: () => Promise<T>, effects: InboxRequestEffects<T>): Promise<InboxRequestOutcome> {
    const generation = ++this.generation;
    effects.start();
    let value: T;
    try {
      value = await request();
    } catch {
      if (generation !== this.generation) return 'stale';
      effects.failure();
      return 'failed';
    }
    if (generation !== this.generation) return 'stale';
    effects.success(value);
    return 'loaded';
  }
}
