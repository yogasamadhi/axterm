import { remoteErrorOf } from '@axterm/plugin-api';
import { createTerminalSchema, type TerminalSession } from '@axterm/plugin-api/terminals';
import type { ConnectionClientActions } from '@axterm/plugin-api/connections';
import type { WorkspaceUi } from '@axterm/ui/workspace';
import type { TerminalsModel } from '../index.ts';
import type { TerminalWorkspaceAdmissions } from '../workspace-owner.ts';
type Model = Pick<
  TerminalsModel,
  'getSnapshot' | 'subscribe' | 'disconnect' | 'getCommandOutcome' | 'close'
>;
type Admissions = Pick<TerminalWorkspaceAdmissions, 'open'>;
type Connections = Pick<
  ConnectionClientActions,
  'getSnapshot' | 'subscribe' | 'retryConnection' | 'cancelReconnect'
>;
/** User session intents belong to one generation and source tab; no hidden command/input retry queue. */
export class TerminalSessionActions {
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly disconnects = new Map<string, { key: string; generation: string }>();
  private readonly cleanup = new Map<string, string>();
  private closing: Promise<void> | undefined;
  private batch: Promise<void> | undefined;
  private state: Readonly<{
    failed: boolean;
    busy: readonly string[];
    uncertain: readonly string[];
  }> = Object.freeze({
    failed: false,
    busy: [] as readonly string[],
    uncertain: [] as readonly string[],
  });
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dismiss = () => this.publish(false);
  private publish(failed = this.state.failed): void {
    this.state = Object.freeze({
      failed,
      busy: Object.freeze([...this.pending.keys()]),
      uncertain: Object.freeze([...this.disconnects.keys()].filter((id) => !this.pending.has(id))),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_SESSION_OBSERVER_FAILED');
      }
    }
  }

  constructor(
    private readonly model: Model,
    private readonly admissions: Admissions,
    private readonly workspace: WorkspaceUi,
    private readonly connections: Connections,
    private readonly prepareReload: (sourceId: string) => ((newId: string) => void) | undefined,
    private readonly present: (id: string, sourceId: string) => void,
  ) {}
  retire(generation: string): void {
    for (const [id, intent] of this.disconnects)
      if (intent.generation !== generation) this.disconnects.delete(id);
    for (const [id, owner] of this.cleanup) if (owner !== generation) this.cleanup.delete(id);
    this.publish();
  }
  disconnect(id: string): Promise<void> {
    return this.run(id, async (_session, generation, signal) => {
      const previous = this.disconnects.get(id);
      const intent =
        previous?.generation === generation ? previous : { key: crypto.randomUUID(), generation };
      this.disconnects.set(id, intent);
      try {
        const accepted = await this.model.disconnect(intent.key, id, generation);
        if (accepted.id !== id) throw Error('TERMINAL_SESSION_RECEIPT_MISMATCH');
        await this.observed(generation, signal, () => {
          const current = this.source(id, true);
          return !current || current.state === 'closed';
        });
        this.disconnects.delete(id);
      } catch (error) {
        const marked = remoteErrorOf(error);
        if (
          marked?.code === 'terminals/failure' &&
          [
            'invalid-input',
            'not-found',
            'closed',
            'cancelled',
            'conflict',
            'stale',
            'forbidden',
            'capacity',
            'receipt-expired',
          ].includes(marked.details.reason)
        )
          this.disconnects.delete(id);
        throw error;
      }
    });
  }
  newTab(id: string): Promise<string> {
    return this.run(id, (_session, _generation, signal) =>
      this.admissions.open({ kind: 'local', cols: 80, rows: 24 }, signal),
    );
  }
  reload(id: string, signal?: AbortSignal): Promise<string> {
    return this.recreate(id, true, false, signal);
  }
  duplicate(id: string, nextPane = false, signal?: AbortSignal): Promise<string> {
    return this.recreate(id, false, nextPane, signal);
  }
  reloadAll(): Promise<void> {
    if (this.closing || this.batch) return Promise.reject(Error('TERMINAL_SESSION_BUSY'));
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') return Promise.reject(Error('TERMINAL_SESSION_NOT_READY'));
    const generation = state.baseline.generation;
    const ids = this.workspace
      .getSnapshot()
      .tabs.filter(
        (tab) =>
          tab.kind === 'terminal' &&
          state.baseline.sessions.some((session) => session.id === tab.id),
      )
      .map((tab) => tab.id);
    if (ids.length > 128) return Promise.reject(Error('TERMINAL_SESSION_CAPACITY'));
    const task = Promise.resolve().then(async () => {
      for (const id of ids) {
        this.lifetime.signal.throwIfAborted();
        this.assertGeneration(generation);
        if (!this.workspace.getSnapshot().tabs.some((tab) => tab.id === id)) continue;
        await this.reload(id, this.lifetime.signal);
      }
    });
    this.batch = task;
    void task.then(
      () => {
        if (this.batch === task) this.batch = undefined;
      },
      () => {
        if (this.batch === task) this.batch = undefined;
        if (!this.lifetime.signal.aborted) this.publish(true);
      },
    );
    return task;
  }
  cancelReconnect(id: string): Promise<void> {
    return this.run(id, async (session, generation) => {
      if (!session.connectionId) throw Error('TERMINAL_CONNECTION_UNAVAILABLE');
      await this.connections.cancelReconnect(session.connectionId);
      this.assertGeneration(generation);
    });
  }
  recover(id: string, generation: string): Promise<string> {
    try {
      this.assertGeneration(generation);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.recreate(id, true, false, undefined, false);
  }
  private recreate(
    id: string,
    replace: boolean,
    nextPane: boolean,
    signal?: AbortSignal,
    retryConnection = true,
  ): Promise<string> {
    const uncertain = this.disconnects.get(id),
      state = this.model.getSnapshot();
    if (uncertain && state.status === 'ready' && uncertain.generation !== state.baseline.generation)
      this.disconnects.delete(id);
    if (this.disconnects.has(id))
      return Promise.reject(Error('TERMINAL_SESSION_OUTCOME_UNCERTAIN'));
    if (!this.workspace.arrange) return Promise.reject(Error('TERMINAL_ARRANGEMENT_UNAVAILABLE'));
    return this.run(
      id,
      async (session, generation, owned) => {
        const before = this.workspace.getSnapshot(),
          tab = before.tabs.find((tab) => tab.id === id);
        if (!tab || tab.kind !== 'terminal') throw Error('TERMINAL_VIEW_RETIRED');
        const prepare = replace && session.kind === 'ssh' ? this.prepareReload(id) : undefined;
        let connectionId = session.connectionId;
        if (session.kind === 'ssh') {
          const current = this.connections.getSnapshot();
          if (
            current.status !== 'ready' ||
            current.baseline.generation !== generation ||
            !connectionId
          )
            throw Error('TERMINAL_CONNECTION_UNAVAILABLE');
          const connection = current.baseline.connections.find((item) => item.id === connectionId);
          if (!connection) throw Error('TERMINAL_CONNECTION_UNAVAILABLE');
          if (connection.state !== 'ready') {
            if (!retryConnection) throw Error('TERMINAL_RECOVERY_CONNECTION_CHANGED');
            const accepted = await this.connections.retryConnection(
              crypto.randomUUID(),
              connection.id,
            );
            connectionId = accepted.id;
            await this.observed(
              generation,
              owned,
              () => {
                const state = this.connections.getSnapshot();
                if (state.status !== 'ready' || state.baseline.generation !== generation)
                  throw Error('TERMINAL_CONNECTION_RETIRED');
                const found = state.baseline.connections.find((item) => item.id === connectionId);
                if (!found || found.state === 'failed' || found.state === 'closed')
                  throw Error('TERMINAL_CONNECTION_UNAVAILABLE');
                return found.state === 'ready';
              },
              true,
            );
          }
        }
        this.assertGeneration(generation);
        owned.throwIfAborted();
        const request = createTerminalSchema.parse({
          kind: session.kind,
          ...(connectionId ? { connectionId } : {}),
          ...(session.bookmarkId ? { bookmarkId: session.bookmarkId } : {}),
          ...(session.profileId ? { profileId: session.profileId } : {}),
          cols: 160,
          rows: 80,
        });
        const created = await this.admissions.open(request, owned, tab.title, prepare, false);
        this.cleanup.set(created, generation);
        try {
          this.assertGeneration(generation);
          owned.throwIfAborted();
          if (!this.workspace.getSnapshot().tabs.some((tab) => tab.id === id))
            throw Error('TERMINAL_VIEW_RETIRED');
          this.present(created, id);
          if (tab.pinned) this.workspace.arrange!.pinTab(created);
          this.workspace.arrange!.moveTab(created, id, true);
          const arrangement = before.arrangement;
          const sourcePane = tab.paneIndex ?? Math.max(0, arrangement?.paneTabIds.indexOf(id) ?? 0);
          if (nextPane && (arrangement?.paneTabIds.length ?? 1) === 1)
            this.workspace.arrange!.setLayout('c2');
          const panes = this.workspace.getSnapshot().arrangement?.paneTabIds.length ?? 1;
          const target = nextPane ? (sourcePane + 1) % panes : sourcePane;
          this.workspace.arrange!.moveToPane(created, target);
          for (const [index, previous] of (arrangement?.paneTabIds ?? []).entries()) {
            if (
              previous &&
              previous !== id &&
              index !== target &&
              this.workspace.getSnapshot().tabs.some((tab) => tab.id === previous)
            )
              this.workspace.arrange!.moveToPane(previous, index);
            else if (
              replace &&
              previous &&
              previous !== id &&
              index === target &&
              this.workspace.getSnapshot().tabs.some((tab) => tab.id === previous)
            )
              this.workspace.arrange!.moveToPane(previous, index);
            else if (nextPane && previous === id && index !== target)
              this.workspace.arrange!.moveToPane(id, index);
          }
          if (
            replace &&
            before.activeTabId &&
            before.activeTabId !== id &&
            this.workspace.getSnapshot().tabs.some((tab) => tab.id === before.activeTabId)
          )
            this.workspace.selectTab(before.activeTabId);
          else this.workspace.selectTab(created);
          // The observed accepted resource now belongs to its canonical session/view owner.
          this.cleanup.delete(created);
        } catch (error) {
          await this.release(created, generation);
          throw error;
        }
        if (replace) {
          this.cleanup.set(id, generation);
          await this.release(id, generation);
        }
        return created;
      },
      signal,
    );
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      if (this.batch) await Promise.allSettled([this.batch]);
      await Promise.allSettled([...this.pending.values()]);
      await Promise.allSettled(
        [...this.cleanup].map(([id, generation]) => this.release(id, generation)),
      );
      for (const [id, intent] of this.disconnects) {
        const state = this.model.getSnapshot();
        if (state.status !== 'ready') continue;
        if (state.baseline.generation !== intent.generation) {
          this.disconnects.delete(id);
          continue;
        }
        try {
          const result = await this.model.getCommandOutcome(intent.generation, intent.key);
          if (result.status === 'accepted' && result.id === id) this.disconnects.delete(id);
        } catch {
          /* Preserve unknown ownership. */
        }
      }
      this.listeners.clear();
      if (this.cleanup.size || this.disconnects.size)
        throw Error('TERMINAL_SESSION_DRAIN_UNCERTAIN');
    })());
  }
  private async release(id: string, generation: string): Promise<void> {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('TERMINAL_SESSION_NOT_READY');
    if (state.baseline.generation === generation) await this.model.close(id, generation);
    this.cleanup.delete(id);
  }
  private source(id: string, optional = false): TerminalSession | undefined {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('TERMINAL_SESSION_NOT_READY');
    const session = state.baseline.sessions.find((session) => session.id === id);
    if (!session && !optional) throw Error('TERMINAL_SESSION_NOT_FOUND');
    return session;
  }
  private assertGeneration(generation: string): void {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('TERMINAL_SESSION_RETIRED');
  }
  private run<T>(
    id: string,
    apply: (session: TerminalSession, generation: string, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closing || this.pending.has(id) || this.pending.size >= 8)
      return Promise.reject(Error('TERMINAL_SESSION_BUSY'));
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') return Promise.reject(Error('TERMINAL_SESSION_NOT_READY'));
    const session = state.baseline.sessions.find((session) => session.id === id),
      generation = state.baseline.generation;
    if (!session) return Promise.reject(Error('TERMINAL_SESSION_NOT_FOUND'));
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(() => {
      owned.throwIfAborted();
      this.assertGeneration(generation);
      return apply(structuredClone(session), generation, owned);
    });
    this.pending.set(id, task);
    this.publish();
    const release = () => {
      if (this.pending.get(id) === task) this.pending.delete(id);
      this.publish();
    };
    void task.then(release, () => {
      if (!this.lifetime.signal.aborted) this.publish(true);
      release();
    });
    return task;
  }
  private observed(
    generation: string,
    signal: AbortSignal,
    check: () => boolean,
    connection = false,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let off = () => {},
        done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const update = () => {
        try {
          this.assertGeneration(generation);
          if (check()) finish();
        } catch (error) {
          finish(error);
        }
      };
      const abort = () => finish(Error('TERMINAL_SESSION_CANCELLED'));
      const timer = setTimeout(() => finish(Error('TERMINAL_SESSION_OBSERVATION_TIMEOUT')), 30000);
      try {
        off = (connection ? this.connections : this.model).subscribe(update);
        if (done) {
          off();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else update();
      } catch (error) {
        finish(error);
      }
    });
  }
}
