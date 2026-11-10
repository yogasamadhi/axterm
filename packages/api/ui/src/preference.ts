import type { ObservableSnapshot } from '@axterm/plugin-api';

/** The business owner supplies accepted facts and a durable, optimistic command. */
export interface PresentationPreferencePort<T> extends ObservableSnapshot<{
  readonly available: boolean;
  readonly value: T | undefined;
}> {
  write(value: T): Promise<void>;
}

/** One preference writer, observed facts, and a drain barrier for provider unload. */
export class PresentationPreference<T> {
  private owner:
    { port: PresentationPreferencePort<T>; stop: () => void; accepting: boolean } | undefined;
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly adopt: (value: T | undefined) => void) {}
  attach(port: PresentationPreferencePort<T>): () => Promise<void> {
    if (this.closed) throw new Error('PRESENTATION_CLOSED');
    if (this.owner) throw new Error('PREFERENCE_OWNER_EXISTS');
    const read = () => {
      if (this.owner !== owner || !owner.accepting || this.closed) return;
      const state = port.getSnapshot();
      if (state.available) this.adopt(state.value);
    };
    const owner = { port, stop: () => {}, accepting: true };
    this.owner = owner;
    try {
      const remove = port.subscribe(read);
      let stopped = false;
      owner.stop = () => {
        if (stopped) return;
        stopped = true;
        remove();
      };
      read();
    } catch (error) {
      owner.accepting = false;
      try {
        owner.stop();
      } catch {
        /* The failed owner is retired even if its cleanup rejects. */
      }
      this.owner = undefined;
      throw error;
    }
    let done: Promise<void> | undefined;
    return () =>
      (done ??= (async () => {
        owner.accepting = false;
        let failed = false;
        try {
          owner.stop();
        } catch {
          failed = true;
        }
        await Promise.allSettled([...this.pending]);
        if (this.owner === owner) this.owner = undefined;
        if (failed) throw new Error('PREFERENCE_UNSUBSCRIBE_FAILED');
      })());
  }
  async write(value: T): Promise<void> {
    if (this.closed) return Promise.reject(new Error('PRESENTATION_CLOSED'));
    const owner = this.owner;
    if (!owner?.accepting || !owner.port.getSnapshot().available)
      return Promise.reject(new Error('PREFERENCE_UNAVAILABLE'));
    if (this.pending.size) return Promise.reject(new Error('PREFERENCE_BUSY'));
    const operation = Promise.resolve().then(() => owner.port.write(value));
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    let failed = false;
    if (this.owner) {
      this.owner.accepting = false;
      try {
        this.owner.stop();
      } catch {
        failed = true;
      }
    }
    await Promise.allSettled([...this.pending]);
    this.owner = undefined;
    if (failed) throw new Error('PREFERENCE_UNSUBSCRIBE_FAILED');
  }
}
