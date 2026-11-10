import {
  persistedTerminalTabSchema,
  type PersistedTerminalTab,
} from '@axterm/plugin-api/configuration';
import type {
  WorkspaceSessionDescriptions,
  WorkspaceSessionDescriptionSource,
  WorkspaceTab,
} from '@axterm/ui/workspace';
/** A selected UI contribution table, not a business registry or execution engine. */
export class SessionDescriptions implements WorkspaceSessionDescriptions {
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly lifetime = new AbortController();
  private waiters = 0;
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
  private readonly sources = new Map<
    'terminal' | 'remote-desktop' | 'web-session',
    WorkspaceSessionDescriptionSource
  >();
  register(
    kind: 'terminal' | 'remote-desktop' | 'web-session',
    source: WorkspaceSessionDescriptionSource,
  ): () => void {
    if (
      this.closed ||
      !['terminal', 'remote-desktop', 'web-session'].includes(kind) ||
      this.sources.has(kind)
    )
      throw Error('WORKSPACE_SOURCE_CONFLICT');
    const off = source.subscribe(() => this.notify());
    this.sources.set(kind, source);
    this.unsubscribers.set(kind, off);
    this.notify();
    return () => {
      if (this.sources.get(kind) === source) {
        this.sources.delete(kind);
        this.unsubscribers.delete(kind);
        off();
        this.notify();
      }
    };
  }
  isReady(kind: PersistedTerminalTab['kind'], generation: string): boolean {
    const family =
      kind === 'web'
        ? 'web-session'
        : ['rdp', 'vnc', 'spice'].includes(kind)
          ? 'remote-desktop'
          : 'terminal';
    return !this.closed && this.sources.get(family)?.isReady(generation) === true;
  }
  waitFor(
    kind: PersistedTerminalTab['kind'],
    generation: string,
    caller: AbortSignal,
  ): Promise<void> {
    const family =
      kind === 'web'
        ? 'web-session'
        : ['rdp', 'vnc', 'spice'].includes(kind)
          ? 'remote-desktop'
          : 'terminal';
    const ready = () => this.sources.get(family)?.isReady(generation) === true;
    caller.throwIfAborted();
    if (this.closed) throw Error('WORKSPACE_SOURCE_CLOSED');
    if (ready()) return Promise.resolve();
    if (this.waiters >= 32) throw Error('WORKSPACE_SOURCE_CAPACITY');
    this.waiters++;
    const signal = AbortSignal.any([caller, this.lifetime.signal]);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const clean = () => {
        clearTimeout(timer);
        this.listeners.delete(update);
        signal.removeEventListener('abort', abort);
        this.waiters--;
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clean();
        if (error) reject(error);
        else resolve();
      };
      const update = () => {
        if (ready()) finish();
      };
      const abort = () => finish(Error('WORKSPACE_SOURCE_UNAVAILABLE'));
      const timer = setTimeout(abort, 10000);
      this.listeners.add(update);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else update();
    });
  }
  describe(tab: WorkspaceTab): PersistedTerminalTab {
    if (this.closed) throw Error('WORKSPACE_SOURCE_CLOSED');
    const source = this.sources.get(tab.kind as 'terminal' | 'remote-desktop' | 'web-session');
    if (!source) throw Error('WORKSPACE_SOURCE_UNAVAILABLE');
    const value = source.describe(tab.id);
    if (!value) throw Error('WORKSPACE_SESSION_UNAVAILABLE');
    return persistedTerminalTabSchema.parse({
      ...value,
      id: tab.id,
      title: tab.title,
      pinned: tab.pinned ?? false,
      paneIndex: tab.paneIndex ?? 0,
      ...(tab.tabNumber ? { tabNumber: tab.tabNumber } : {}),
      ...(tab.terminalVisual ? { visual: tab.terminalVisual } : {}),
    });
  }
  restore(input: PersistedTerminalTab, generation: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.closed) throw Error('WORKSPACE_SOURCE_CLOSED');
    const captured = persistedTerminalTabSchema.parse(input),
      kind =
        captured.kind === 'web'
          ? 'web-session'
          : ['rdp', 'vnc', 'spice'].includes(captured.kind)
            ? 'remote-desktop'
            : 'terminal',
      source = this.sources.get(kind);
    if (!source) throw Error('WORKSPACE_SOURCE_UNAVAILABLE');
    return source.restore(captured, generation, signal);
  }
  close(): void {
    this.closed = true;
    this.lifetime.abort();
    for (const off of this.unsubscribers.values()) off();
    this.unsubscribers.clear();
    this.listeners.clear();
    this.sources.clear();
  }
}
