import type { DesktopLifecycleState } from '@workspace/contracts/desktop';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { RealtimeHub } from './realtime-hub';

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Bridges native power events through the Host REST boundary into Runtime realtime events. */
export class DesktopLifecycleService {
  private revision: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private running = false;
  private closed = false;

  constructor(
    private readonly host: Pick<HostCapabilityClient, 'lifecycle'>,
    private readonly realtime: RealtimeHub,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.running || this.closed) return;
    this.running = true;
    void this.pollAndSchedule();
  }

  async pollNow(): Promise<DesktopLifecycleState | undefined> {
    if (this.closed || this.controller) return undefined;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const lifecycle = await this.host.lifecycle(controller.signal);
      if (this.revision !== undefined && lifecycle.revision > this.revision)
        this.realtime.publish('desktop.lifecycle', lifecycle);
      this.revision = Math.max(this.revision ?? lifecycle.revision, lifecycle.revision);
      return lifecycle;
    } catch (error) {
      if (!controller.signal.aborted) return undefined;
      throw error;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  resourceCount(): number {
    return Number(!!this.timer) + Number(!!this.controller);
  }

  close(): void {
    this.closed = true;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  private async pollAndSchedule(): Promise<void> {
    await this.pollNow().catch(() => undefined);
    if (!this.running || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pollAndSchedule();
    }, this.pollIntervalMs);
    this.timer.unref();
  }
}
