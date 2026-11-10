import type {
  TerminalViewUi,
  TerminalViewAction,
  TerminalSelectionContext,
} from '@axterm/ui/workspace';
interface Sink {
  selectionAvailable(): boolean;
  captureSelection?(): string;
  run(
    action: TerminalViewAction,
    signal: AbortSignal,
    captured?: { readonly selection: string },
  ): void | Promise<void>;
}
interface Owned {
  sink: Sink;
  lifetime: AbortController;
  pending?: Promise<void>;
}
/** Live UI operations and bounded opaque menu selections; no business cache or byte replay. */
export class TerminalViewOwner implements TerminalViewUi {
  private readonly lifetime = new AbortController();
  private readonly sinks = new Map<string, Owned>();
  private readonly pending = new Set<Promise<void>>();
  private readonly contexts = new Map<symbol, { id: string; owned: Owned; selection: string }>();
  private retainedCharacters = 0;
  private closing: Promise<void> | undefined;
  register(id: string, sink: Sink): () => void {
    if (this.lifetime.signal.aborted || this.sinks.has(id) || this.sinks.size >= 128)
      throw Error('TERMINAL_VIEW_REGISTRATION_UNAVAILABLE');
    const owned: Owned = { sink, lifetime: new AbortController() };
    this.sinks.set(id, owned);
    return () => {
      owned.lifetime.abort();
      if (this.sinks.get(id) === owned) this.sinks.delete(id);
      for (const [key, context] of this.contexts)
        if (context.owned === owned) this.releaseContext(key);
    };
  }
  selectionAvailable(id: string): boolean {
    return !this.lifetime.signal.aborted && !!this.sinks.get(id)?.sink.selectionAvailable();
  }
  captureContext(id: string): TerminalSelectionContext {
    const owned = this.sinks.get(id);
    if (this.lifetime.signal.aborted || !owned || this.contexts.size >= 16)
      throw Error('TERMINAL_VIEW_UNAVAILABLE');
    const selection = owned.sink.captureSelection?.() ?? '';
    if (
      selection.length > 1024 * 1024 ||
      this.retainedCharacters + selection.length > 2 * 1024 * 1024
    )
      throw Error('TERMINAL_SELECTION_CAPACITY');
    const key = Symbol();
    this.contexts.set(key, { id, owned, selection });
    this.retainedCharacters += selection.length;
    return {
      hasSelection: !!selection,
      run: (action, signal) => {
        const context = this.contexts.get(key);
        if (!context || this.sinks.get(id) !== context.owned)
          return Promise.reject(Error('TERMINAL_VIEW_RETIRED'));
        try {
          return this.dispatch(id, action, signal, { selection: context.selection });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      dispose: () => this.releaseContext(key),
    };
  }
  run(id: string, action: TerminalViewAction, signal?: AbortSignal): Promise<void> {
    return this.dispatch(id, action, signal);
  }
  private dispatch(
    id: string,
    action: TerminalViewAction,
    signal?: AbortSignal,
    captured?: { readonly selection: string },
  ): Promise<void> {
    if (this.lifetime.signal.aborted) throw Error('TERMINAL_VIEW_CLOSED');
    const owned = this.sinks.get(id);
    if (!owned || owned.pending || this.pending.size >= 16)
      throw Error('TERMINAL_VIEW_UNAVAILABLE');
    const lifetime = AbortSignal.any([
      this.lifetime.signal,
      owned.lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(async () => {
      lifetime.throwIfAborted();
      if (this.sinks.get(id) !== owned) throw Error('TERMINAL_VIEW_RETIRED');
      await owned.sink.run(action, lifetime, captured);
    });
    owned.pending = task;
    this.pending.add(task);
    const release = () => {
      this.pending.delete(task);
      if (owned.pending === task) delete owned.pending;
    };
    void task.then(release, release);
    return task;
  }
  private releaseContext(key: symbol): void {
    const context = this.contexts.get(key);
    if (!context) return;
    this.retainedCharacters -= context.selection.length;
    this.contexts.delete(key);
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      for (const owned of this.sinks.values()) owned.lifetime.abort();
      this.sinks.clear();
      this.contexts.clear();
      this.retainedCharacters = 0;
      await Promise.allSettled([...this.pending]);
    })());
  }
}
