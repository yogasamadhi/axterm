import { remoteErrorOf } from '@axterm/plugin-api';
import type { StartTunnelInput } from '@axterm/plugin-api/connections';
import type { ConnectionsModel } from '../../index.ts';
export interface OperationState {
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly failed: boolean;
}
/** One bounded explicit UI intent. Facts stay in their model; network retry is readonly. */
export class TunnelOperations {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private state: OperationState = { busy: false, uncertain: false, failed: false };
  private pending: Promise<unknown> | undefined;
  private retained:
    | { generation: string; retry: () => Promise<unknown>; mode: 'fact' | 'network' | 'cleanup' }
    | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Pick<
      ConnectionsModel,
      'getSnapshot' | 'startTunnel' | 'getTunnelCommandOutcome'
    >,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  fact<T>(invoke: (key: string) => Promise<T>): Promise<T> {
    this.assertIdle();
    const generation = this.generation(),
      key = crypto.randomUUID();
    this.retained = { generation, retry: () => invoke(key), mode: 'fact' };
    return this.run(() => invoke(key));
  }
  start(input: StartTunnelInput, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.assertIdle();
    const generation = this.generation(),
      key = crypto.randomUUID(),
      request = structuredClone(input);
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const reconcile = async () => {
      this.assertGeneration(generation);
      const result = await this.model.getTunnelCommandOutcome(generation, key);
      if (result.status === 'accepted' || result.status === 'rejected') return;
      throw Error('TUNNEL_ADMISSION_UNCERTAIN');
    };
    this.retained = { generation, retry: reconcile, mode: 'network' };
    return this.run(async () => {
      if (owned.aborted) {
        this.retained = undefined;
        owned.throwIfAborted();
      }
      try {
        await this.model.startTunnel(key, request, owned);
      } catch (error) {
        try {
          await reconcile();
          this.retained = undefined;
        } catch {
          /* Keep the exact intent; never start again. */
        }
        throw error;
      }
    });
  }
  action<T>(invoke: () => Promise<T>): Promise<T> {
    const task = this.fact(() => invoke());
    if (this.retained) this.retained.mode = 'cleanup';
    return task;
  }
  retry(): Promise<unknown> {
    if (this.closing || this.pending || !this.retained)
      return Promise.reject(Error('TUNNEL_NOT_UNCERTAIN'));
    const intent = this.retained;
    if (this.retired(intent.generation)) {
      this.retained = undefined;
      this.publish(false, false);
      return Promise.resolve();
    }
    return this.run(intent.retry);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.pending?.catch(() => {});
      if (this.retained) {
        if (this.retired(this.retained.generation)) this.retained = undefined;
        else if (this.retained.mode !== 'fact') {
          try {
            await this.retained.retry();
            this.retained = undefined;
          } catch {
            /* Fail closed. */
          }
        }
      }
      this.listeners.clear();
      if (this.retained) throw Error('TUNNEL_UI_UNDRAINED');
    })());
  }
  private assertIdle() {
    if (this.closing || this.pending || this.retained) throw Error('TUNNEL_UI_BUSY');
  }
  private generation() {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('TUNNEL_UI_NOT_READY');
    return state.baseline.generation;
  }
  private retired(generation: string) {
    const state = this.model.getSnapshot();
    return state.status === 'ready' && state.baseline.generation !== generation;
  }
  private assertGeneration(generation: string) {
    if (this.generation() !== generation) throw Error('TUNNEL_UI_RETIRED');
  }
  private run<T>(invoke: () => Promise<T>): Promise<T> {
    const intent = this.retained!;
    let failed = false;
    this.publish(true, false);
    const task = Promise.resolve()
      .then(() => {
        this.assertGeneration(intent.generation);
        return invoke();
      })
      .then(
        (value) => {
          this.retained = undefined;
          return value;
        },
        (error) => {
          failed = true;
          const marked = remoteErrorOf(error);
          if (
            (marked?.code === 'connections/failure' &&
              [
                'invalid-input',
                'not-found',
                'conflict',
                'capacity',
                'closed',
                'precondition-required',
                'precondition-failed',
                'stale',
              ].includes(marked.details.reason)) ||
            this.retired(intent.generation)
          )
            this.retained = undefined;
          throw Error('TUNNEL_OPERATION_FAILED');
        },
      )
      .finally(() => {
        this.pending = undefined;
        this.publish(false, failed);
      });
    this.pending = task;
    return task;
  }
  private publish(busy: boolean, failed: boolean) {
    this.state = Object.freeze({ busy, uncertain: !!this.retained, failed });
    if (!this.closing)
      for (const fn of this.listeners) {
        try {
          fn();
        } catch {
          console.warn('TUNNEL_UI_OBSERVER_FAILED');
        }
      }
  }
}
