import type { Context } from '@deepseek-ai/cordis';
import type * as Contract from '@axterm/plugin-api/terminals';
import type { TerminalFactsBaseline, TerminalFactsUpdate } from '@axterm/plugin-api/terminals';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { TerminalFactsProjection } from './facts-projection.ts';
export type TerminalFactsState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: TerminalFactsBaseline }
  | { readonly status: 'error'; readonly message: string };
export class TerminalFactsModel {
  private state: TerminalFactsState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<TerminalFactsUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private closing = false;
  private readonly calls = new Set<Promise<unknown>>();
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): TerminalFactsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async createTerminalProfile(
    key: string,
    input: Contract.TerminalProfileInput,
  ): Promise<Contract.TerminalFactsReceipt> {
    this.assertOpen();
    const result = await this.call(() =>
      this.ctx.remote.terminals.createTerminalProfile(key, input),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async updateTerminalProfile(
    key: string,
    id: string,
    input: Contract.TerminalProfilePatch,
    ifMatch: string | undefined,
  ): Promise<Contract.TerminalFactsReceipt> {
    this.assertOpen();
    const result = await this.call(() =>
      this.ctx.remote.terminals.updateTerminalProfile(key, id, input, ifMatch),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteTerminalProfile(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.TerminalFactsReceipt> {
    this.assertOpen();
    const result = await this.call(() =>
      this.ctx.remote.terminals.deleteTerminalProfile(key, id, ifMatch),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createTerminalTheme(
    key: string,
    input: Contract.TerminalThemeInput,
    generation = this.generation(),
  ): Promise<Contract.TerminalFactsReceipt> {
    this.assertOpen();
    if (this.generation() !== generation) throw Error('TERMINAL_THEME_GENERATION_CHANGED');
    const request = structuredClone(input);
    const result = await this.call(() =>
      this.ctx.remote.terminals.createTerminalTheme(key, request, generation),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async cloneTerminalTheme(
    key: string,
    id: string,
    name?: string,
    generation = this.generation(),
  ): Promise<Contract.TerminalFactsReceipt> {
    this.assertOpen();
    if (this.generation() !== generation) throw Error('TERMINAL_THEME_GENERATION_CHANGED');
    const result = await this.call(() =>
      this.ctx.remote.terminals.cloneTerminalTheme(key, id, name, generation),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async updateTerminalTheme(
    key: string,
    id: string,
    input: Contract.TerminalThemePatch,
    ifMatch: string | undefined,
    generation = this.generation(),
  ): Promise<Contract.TerminalFactsReceipt> {
    this.assertOpen();
    if (this.generation() !== generation) throw Error('TERMINAL_THEME_GENERATION_CHANGED');
    const request = structuredClone(input);
    const result = await this.call(() =>
      this.ctx.remote.terminals.updateTerminalTheme(key, id, request, ifMatch, generation),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteTerminalTheme(
    key: string,
    id: string,
    ifMatch: string | undefined,
    generation = this.generation(),
  ): Promise<Contract.TerminalFactsReceipt> {
    this.assertOpen();
    if (this.generation() !== generation) throw Error('TERMINAL_THEME_GENERATION_CHANGED');
    const result = await this.call(() =>
      this.ctx.remote.terminals.deleteTerminalTheme(key, id, ifMatch, generation),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async listCommandHistory(
    input: Contract.CommandHistoryQuery = {},
  ): Promise<Contract.CommandHistoryPage> {
    this.assertOpen();
    const result = await this.call(() => this.ctx.remote.terminals.listCommandHistory(input));
    if (!result.ok) throw result.error;
    return result.value;
  }
  async recordCommandHistory(
    key: string,
    input: Contract.RecordCommandHistoryInput,
    generation = this.generation(),
  ): Promise<Contract.RecordCommandHistoryResult> {
    this.assertOpen();
    const result = await this.call(() =>
      this.ctx.remote.terminals.recordCommandHistory(key, input, generation),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteCommandHistory(
    key: string,
    id: string,
    ifMatch: string | undefined,
    generation = this.generation(),
  ): Promise<Contract.DeleteCommandHistoryResult> {
    this.assertOpen();
    const result = await this.call(() =>
      this.ctx.remote.terminals.deleteCommandHistory(key, id, ifMatch, generation),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async clearCommandHistory(
    key: string,
    ifMatch: string | undefined,
    generation = this.generation(),
  ): Promise<Contract.ClearCommandHistoryResult> {
    this.assertOpen();
    const result = await this.call(() =>
      this.ctx.remote.terminals.clearCommandHistory(key, ifMatch, generation),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.disposed && !this.closing) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.calls]);
    this.disposed = true;
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  private generation(): string {
    if (this.state.status !== 'ready') throw Error('TERMINAL_FACTS_MODEL_NOT_READY');
    return this.state.baseline.generation;
  }
  private call<T>(invoke: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.calls.size >= 32) throw Error('TERMINAL_FACTS_COMMAND_CAPACITY');
    const task = Promise.resolve().then(invoke);
    this.calls.add(task);
    void task.then(
      () => this.calls.delete(task),
      () => this.calls.delete(task),
    );
    return task;
  }
  private assertOpen(): void {
    if (this.disposed || this.closing) throw new Error('TERMINAL_FACTS_MODEL_CLOSED');
  }
  private open(): RemoteStream<TerminalFactsUpdate> {
    return this.ctx.remote.$stream({
      name: 'terminals.facts',
      open: (signal) => this.ctx.remote.terminals.watchTerminalFacts(signal),
      ended: () => new RemoteStreamCarrierError('Terminal facts generation ended'),
    });
  }
  private async consume(stream: RemoteStream<TerminalFactsUpdate>): Promise<void> {
    const projection = new TerminalFactsProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          this.publish({ status: 'ready', baseline });
          item.accept();
        }
      }
    } catch {
      if (!this.disposed)
        this.publish({ status: 'error', message: 'Terminal facts information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: TerminalFactsState): void {
    if (this.disposed) return;
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_FACTS_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalFactsModel: TerminalFactsModel;
  }
}
