import type { Context } from '@deepseek-ai/cordis';
import type { AiRun, AiLogEntry } from '@axterm/plugin-api/ai';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { AiRunProjection } from './run-projection.ts';

export type AiRunState = {
  readonly status: 'ready' | 'error';
  readonly visible: ReturnType<AiRunProjection['snapshot']>;
};

/** A selected Run owns one resumable visible log, independent of metadata and commands. */
export class AiRunModel {
  private readonly projection: AiRunProjection;
  private readonly listeners = new Set<() => void>();
  private state: AiRunState;
  private stream: RemoteStream<AiLogEntry>;
  private done: Promise<void>;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private retrying: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    run: AiRun,
    readonly generation: string,
    private readonly released: () => void,
  ) {
    this.projection = new AiRunProjection(run);
    this.state = { status: 'ready', visible: this.projection.snapshot() };
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): AiRunState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    if (this.listeners.size >= 256) throw new Error('AI_RUN_OBSERVER_CAPACITY');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.closing) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  dispose(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    return (this.closePromise = (async () => {
      await this.stream.dispose();
      await this.done;
      await this.retrying;
      this.listeners.clear();
      this.released();
    })());
  }
  private assertOpen(): void {
    if (this.closing) throw new Error('AI_RUN_MODEL_CLOSED');
  }
  private open(): RemoteStream<AiLogEntry> {
    return this.ctx.remote.$stream({
      name: 'ai.run-log',
      open: (signal) =>
        this.ctx.remote.ai.watchRunLog(
          this.state.visible.run.id,
          this.projection.snapshot().cursor,
          signal,
        ),
      ended: () => new RemoteStreamCarrierError('AI log carrier ended'),
    });
  }
  private async consume(stream: RemoteStream<AiLogEntry>): Promise<void> {
    try {
      for await (const item of stream) {
        if (this.closing) return;
        this.projection.accept(item.value);
        this.publish('ready');
        item.accept();
      }
    } catch {
      if (!this.closing) this.publish('error');
    }
  }
  private publish(status: AiRunState['status']): void {
    this.state = { status, visible: this.projection.snapshot() };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('AI_RUN_OBSERVER_FAILED');
      }
    }
  }
}
