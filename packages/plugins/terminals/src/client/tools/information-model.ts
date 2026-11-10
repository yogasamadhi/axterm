import type { Context } from '@deepseek-ai/cordis';
import type { TerminalInformationBaseline } from '@axterm/plugin-api/terminals';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
export type InformationState =
  | { readonly status: 'idle' | 'connecting' | 'error' }
  | { readonly status: 'ready'; readonly baseline: TerminalInformationBaseline };
/** One selected ephemeral observation; each frame replaces the complete sample baseline. */
export class TerminalInformationModel {
  private state: InformationState = { status: 'idle' };
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Promise<void>>();
  private current:
    | {
        id: string;
        generation: string;
        stream: RemoteStream<TerminalInformationBaseline> | undefined;
      }
    | undefined;
  private closed = false;
  constructor(private readonly ctx: Context) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  observe(id: string, generation: string): () => void {
    if (this.closed) throw Error('TERMINAL_INFORMATION_CLOSED');
    const previous = this.current;
    const owned = {
      id,
      generation,
      stream: undefined as RemoteStream<TerminalInformationBaseline> | undefined,
    };
    this.current = owned;
    this.publish({ status: 'connecting' });
    const task = (async () => {
      await previous?.stream?.dispose();
      if (this.closed || this.current !== owned) return;
      const stream = this.ctx.remote.$stream({
        name: 'terminals.information',
        open: (signal) =>
          this.ctx.remote.terminals.watchTerminalInformation(generation, id, signal),
        ended: () => new RemoteStreamCarrierError('Terminal information generation ended'),
      });
      owned.stream = stream;
      try {
        let revision = 0,
          carrier = 0;
        for await (const item of stream) {
          if (this.current !== owned || this.closed) break;
          if (carrier !== item.generation) {
            carrier = item.generation;
            revision = 0;
          }
          const frame = item.value;
          if (
            frame.generation !== generation ||
            frame.snapshot.terminalId !== id ||
            frame.type !== 'baseline' ||
            frame.revision !== revision + 1
          )
            throw Error('TERMINAL_INFORMATION_BASELINE_INVALID');
          revision = frame.revision;
          this.publish({ status: 'ready', baseline: Object.freeze(structuredClone(frame)) });
          item.accept();
        }
      } finally {
        await stream.dispose();
      }
    })().catch(() => {
      if (this.current === owned && !this.closed) this.publish({ status: 'error' });
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return () => {
      if (this.current === owned) {
        this.current = undefined;
        this.publish({ status: 'idle' });
      }
      void owned.stream?.dispose().catch(() => {});
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    const previous = this.current;
    this.current = undefined;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => previous?.stream?.dispose()),
      ...this.pending,
    ]);
    this.listeners.clear();
    if (results.some((result) => result.status === 'rejected'))
      throw Error('TERMINAL_INFORMATION_DRAIN_FAILED');
  }
  private publish(state: InformationState): void {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_INFORMATION_OBSERVER_FAILED');
      }
    }
  }
}
