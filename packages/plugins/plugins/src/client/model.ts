import { pluginCommandInputSchema } from '@axterm/plugin-api/plugins';
import type {} from '@axterm/plugin-plugins/remote';
import type { Context } from '@deepseek-ai/cordis';
import { RemoteSnapshotStream } from '@axterm/infra-gateway/client';
import type {
  PluginManagementUpdate,
  PluginManagementSnapshot,
  PluginCommandReceipt,
  PluginCommandInput,
} from '@axterm/plugin-api/plugins';
export type PluginManagementState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly snapshot: PluginManagementSnapshot }
  | { readonly status: 'error' };
export class PluginsModel {
  private state: PluginManagementState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly pending = new Map<string, { generation: string }>();
  private stream: RemoteSnapshotStream<PluginManagementUpdate, PluginManagementUpdate>;
  private closing?: Promise<void>;
  private cursor = -1;
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.stream.start();
  }
  private open(): RemoteSnapshotStream<PluginManagementUpdate, PluginManagementUpdate> {
    return new RemoteSnapshotStream(
      this.ctx.remote.$stream({
        name: 'plugins.management',
        open: (signal) => this.ctx.remote.plugins.watchPlugins(signal),
        ended: () => new Error('PLUGIN_OBSERVATION_ENDED'),
      }),
      {
        name: 'plugins.management',
        isSnapshot: (value): value is PluginManagementUpdate => value.type === 'baseline',
        replace: (value) => this.accept(value, true),
        update: (value) => this.accept(value, false),
        failed: () => this.publish({ status: 'error' }),
      },
    );
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closing) throw new Error('PLUGINS_MODEL_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retry(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('PLUGINS_MODEL_CLOSED'));
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      if (!this.closing) {
        this.stream = this.open();
        this.stream.start();
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  execute(input: PluginCommandInput, signal?: AbortSignal): Promise<PluginCommandReceipt> {
    if (signal?.aborted) return Promise.reject(new Error('PLUGIN_WAIT_CANCELLED'));
    const task = this.executeOwned(input);
    if (!signal) return task;
    // Cancels only this caller's wait. The Plugins model retains reconciliation,
    // and the Host owns the already-admitted installation.
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(new Error('PLUGIN_WAIT_CANCELLED'));
      };
      signal.addEventListener('abort', abort, { once: true });
      void task.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  }
  private executeOwned(input: PluginCommandInput): Promise<PluginCommandReceipt> {
    if (this.closing) return Promise.reject(new Error('PLUGINS_MODEL_CLOSED'));
    if (this.pending.size >= 8 || this.state.status !== 'ready')
      return Promise.reject(new Error('PLUGINS_UNAVAILABLE'));
    let request: PluginCommandInput;
    try {
      request = pluginCommandInputSchema.parse(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = crypto.randomUUID(),
      generation = this.state.snapshot.generation;
    this.pending.set(id, { generation });
    const task = (async () => {
      const response = await this.ctx.remote.plugins
        .executePluginCommand(id, generation, request, this.lifetime.signal)
        .catch(() => undefined);
      this.lifetime.signal.throwIfAborted();
      if (response?.ok) {
        if (response.value.id !== id || response.value.generation !== generation)
          throw new Error('PLUGIN_OUTCOME_MISMATCH');
        if (response.value.status !== 'running') {
          this.pending.delete(id);
          return response.value;
        }
      } else if (
        response &&
        response.error.code === 'plugins/failure' &&
        [
          'invalid-input',
          'capacity',
          'closed',
          'permission',
          'conflict',
          'stale-generation',
        ].includes(response.error.details.reason)
      ) {
        this.pending.delete(id);
        throw response.error;
      }
      const deadline = Date.now() + 31 * 60_000;
      while (Date.now() < deadline) {
        this.lifetime.signal.throwIfAborted();
        const outcome = await this.ctx.remote.plugins
          .getPluginCommandOutcome(id, this.lifetime.signal)
          .catch(() => undefined);
        if (
          outcome?.ok &&
          outcome.value.status === 'known' &&
          outcome.value.receipt &&
          outcome.value.receipt.status !== 'running'
        ) {
          if (outcome.value.receipt.id !== id || outcome.value.receipt.generation !== generation)
            throw new Error('PLUGIN_OUTCOME_MISMATCH');
          this.pending.delete(id);
          return outcome.value.receipt;
        }
        await this.wait();
      }
      throw new Error('PLUGIN_COMMAND_UNCERTAIN');
    })();
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.stream.dispose();
      await this.retrying;
      await Promise.allSettled([...this.tasks]);
      this.listeners.clear();
      this.pending.clear();
    })());
  }
  private wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.lifetime.signal;
      signal.throwIfAborted();
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(new Error('PLUGINS_MODEL_CLOSED'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 500);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  private publish(state: PluginManagementState) {
    if (this.closing) return;
    this.state = state;
    for (const listener of [...this.listeners])
      try {
        listener();
      } catch {
        console.warn('PLUGINS_OBSERVER_FAILED');
      }
  }
  private accept(value: PluginManagementUpdate, baseline: boolean): void {
    if (
      !Number.isSafeInteger(value.cursor) ||
      value.cursor < 0 ||
      (baseline
        ? value.type !== 'baseline' || value.cursor !== 0
        : value.type !== 'replace' ||
          value.cursor !== this.cursor + 1 ||
          this.state.status !== 'ready' ||
          value.snapshot.generation !== this.state.snapshot.generation)
    )
      throw new Error('PLUGIN_OBSERVATION_INVALID');
    this.cursor = value.cursor;
    this.publish({ status: 'ready', snapshot: value.snapshot });
  }
}
