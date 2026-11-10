import { remoteErrorOf } from '@axterm/plugin-api';
import type {
  ConnectionClientActions,
  CreateFtpConnectionInput,
  FtpConnection,
} from '@axterm/plugin-api/connections';
import type { FilesWorkspaceUi } from '@axterm/ui/workspace';
interface Snapshot {
  readonly busy: number;
  readonly unresolved: boolean;
  readonly failed: boolean;
}
/** Admission/rollback only. Connections retains protocol facts and successful explicit-disconnect lifetime. */
export class FtpFilesAdmissions {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly rollback = new Map<string, string>();
  private readonly uncertain = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private closing: Promise<void> | undefined;
  private state: Snapshot = { busy: 0, unresolved: false, failed: false };
  constructor(
    private readonly connections: ConnectionClientActions,
    private readonly openView: FilesWorkspaceUi['open'],
    private readonly capacity: () => boolean,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    if (this.closing) throw Error('FTP_WORKSPACE_CLOSED');
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  open(
    input: CreateFtpConnectionInput,
    options?: { signal?: AbortSignal; title?: string },
  ): Promise<string> {
    if (
      this.closing ||
      this.pending.size >= 4 ||
      this.rollback.size ||
      this.uncertain.size ||
      !this.capacity()
    )
      return Promise.reject(Error('FTP_WORKSPACE_CAPACITY'));
    const facts = this.connections.getSnapshot();
    if (facts.status !== 'ready') return Promise.reject(Error('FTP_WORKSPACE_NOT_READY'));
    const generation = facts.baseline.generation,
      key = crypto.randomUUID(),
      request = structuredClone(input),
      title = options?.title;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options?.signal ? [options.signal] : []),
    ]);
    const task = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      this.assertGeneration(generation);
      let connection: FtpConnection;
      try {
        connection = await this.connections.createFtpConnection(key, request, signal);
      } catch (error) {
        const marked = remoteErrorOf(error);
        if (!(
          marked?.code === 'connections/failure' &&
          [
            'invalid-input',
            'not-found',
            'capacity',
            'closed',
            'conflict',
            'stale',
            'precondition-failed',
            'precondition-required',
          ].includes(marked.details.reason)
        )) {
          this.uncertain.set(key, generation);
          try {
            await this.resolve(key, generation);
          } catch {
            /* Retain exact ownership until admission and cleanup are proven. */
          }
        }
        throw error;
      }
      this.rollback.set(connection.id, generation);
      try {
        await this.ready(connection.id, generation, signal);
        signal.throwIfAborted();
        if (!this.capacity()) throw Error('FTP_WORKSPACE_CAPACITY');
        const tab = await this.openView(
          {
            kind: 'remote',
            target: { protocol: 'ftp', connectionId: connection.id },
            path: connection.initialDirectory,
            ...(title ? { title } : {}),
          },
          signal,
        );
        this.rollback.delete(connection.id);
        return tab;
      } catch (error) {
        await this.release(connection.id, generation);
        throw error;
      }
    });
    return this.track(task);
  }
  reconcile(): Promise<void> {
    if (this.closing) return Promise.reject(Error('FTP_WORKSPACE_CLOSED'));
    return this.track(
      (async () => {
        const results = await Promise.allSettled(
          [...this.rollback]
            .map(([id, generation]) => this.release(id, generation))
            .concat([...this.uncertain].map(([key, generation]) => this.resolve(key, generation))),
        );
        if (
          results.some((value) => value.status === 'rejected') ||
          this.rollback.size ||
          this.uncertain.size
        )
          throw Error('FTP_WORKSPACE_UNCERTAIN');
      })(),
    );
  }
  dispose() {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      await Promise.allSettled(
        [...this.rollback].map(([id, generation]) => this.release(id, generation)),
      );
      await Promise.allSettled(
        [...this.uncertain].map(([key, generation]) => this.resolve(key, generation)),
      );
      this.listeners.clear();
      if (this.rollback.size || this.uncertain.size) throw Error('FTP_WORKSPACE_UNDRAINED');
    })());
  }
  private async resolve(key: string, generation: string) {
    if (this.retired(generation)) {
      this.uncertain.delete(key);
      return;
    }
    this.assertGeneration(generation);
    const outcome = await this.connections.getFtpCommandOutcome(generation, key);
    if (outcome.status === 'rejected') {
      this.uncertain.delete(key);
      return;
    }
    if (outcome.status !== 'accepted') throw Error('FTP_WORKSPACE_UNCERTAIN');
    this.rollback.set(outcome.id, generation);
    await this.release(outcome.id, generation);
    this.uncertain.delete(key);
  }
  private async release(id: string, generation: string) {
    if (!this.retired(generation)) {
      this.assertGeneration(generation);
      await this.connections.closeFtpConnection(id);
    }
    this.rollback.delete(id);
  }
  private retired(generation: string) {
    const state = this.connections.getSnapshot();
    return state.status === 'ready' && state.baseline.generation !== generation;
  }
  private assertGeneration(generation: string) {
    const state = this.connections.getSnapshot();
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('FTP_WORKSPACE_RETIRED');
  }
  private ready(id: string, generation: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let off = () => {},
        done = false;
      const timer = setTimeout(() => finish(Error('FTP_WORKSPACE_TIMEOUT')), 30000);
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(Error('FTP_WORKSPACE_CANCELED'));
      const check = () => {
        const state = this.connections.getSnapshot();
        if (signal.aborted) return aborted();
        if (state.status !== 'ready') return;
        if (state.baseline.generation !== generation) return finish(Error('FTP_WORKSPACE_RETIRED'));
        const connection = state.baseline.ftpConnections.find((value) => value.id === id);
        if (connection?.state === 'ready') finish();
        else if (connection && ['failed', 'closed', 'closing'].includes(connection.state))
          finish(Error('FTP_WORKSPACE_CONNECTION_FAILED'));
      };
      try {
        off = this.connections.subscribe(check);
        if (done) {
          off();
          return;
        }
        signal.addEventListener('abort', aborted, { once: true });
        check();
      } catch (error) {
        finish(error instanceof Error ? error : Error('FTP_WORKSPACE_NOT_READY'));
      }
    });
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    this.publish(false);
    void task.then(
      () => {
        this.pending.delete(task);
        this.publish(false);
      },
      () => {
        this.pending.delete(task);
        this.publish(true);
      },
    );
    return task;
  }
  private publish(failed: boolean) {
    this.state = Object.freeze({
      busy: this.pending.size,
      unresolved: !!(this.rollback.size || this.uncertain.size),
      failed,
    });
    for (const fn of this.listeners)
      try {
        fn();
      } catch {
        console.warn('FTP_WORKSPACE_OBSERVER_FAILED');
      }
  }
}
