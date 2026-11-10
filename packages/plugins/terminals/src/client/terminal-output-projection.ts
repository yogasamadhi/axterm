import type { TerminalOutputMetrics } from './terminal-output-consumer.ts';

/** One numeric snapshot, no output bytes; accounting and transport never wait for this observer. */
export class TerminalOutputProjection {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: TerminalOutputMetrics | undefined;
  private closed = false;
  constructor(private readonly publish: (metrics: TerminalOutputMetrics) => void) {}
  update = (metrics: TerminalOutputMetrics): void => {
    if (this.closed) return;
    this.latest = metrics;
    if (metrics.disposed) {
      this.dispose();
      return;
    }
    this.timer ??= setTimeout(this.flush, 16);
  };
  private flush = (): void => {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const metrics = this.latest;
    this.latest = undefined;
    if (metrics) this.publish(metrics);
  };
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
  }
}
