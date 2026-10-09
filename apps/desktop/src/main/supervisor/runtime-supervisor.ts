import { randomUUID } from 'node:crypto';
import {
  childEnvelopeSchema,
  type DesktopBootstrap,
  type ParentEnvelope,
  type StartupEnvelope,
} from '@workspace/contracts/desktop';

export interface RuntimeChild {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  removeAllListeners(): unknown;
  postMessage(envelope: ParentEnvelope): void;
  kill(): boolean;
}
export type SupervisorState =
  'created' | 'starting' | 'ready' | 'degraded' | 'restarting' | 'stopping' | 'stopped';
export interface SupervisorOptions {
  fork(): RuntimeChild;
  startup:
    | Omit<StartupEnvelope, 'type' | 'generation'>
    | ((generation: string) => Omit<StartupEnvelope, 'type' | 'generation'>);
  onReady?(bootstrap: DesktopBootstrap): void;
  onUnavailable?(): void;
  restartDelay?(attempt: number): number;
  startupTimeoutMs?: number;
}

/** Desktop lifecycle only; the child interface cannot carry business messages. */
export class RuntimeSupervisor {
  state: SupervisorState = 'created';
  generation = '';
  restartCount = 0;
  pid: number | undefined;
  lastExit: { code: number; at: string } | undefined;
  private child: RuntimeChild | undefined;
  private metadata: DesktopBootstrap | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped: Promise<void> | undefined;
  private finishStop: (() => void) | undefined;

  constructor(private readonly options: SupervisorOptions) {}

  start(): void {
    if (this.state !== 'created') return;
    this.launch();
  }

  resolve(): DesktopBootstrap {
    if (this.state !== 'ready' || !this.metadata) throw new Error('Runtime unavailable');
    return { ...this.metadata };
  }

  private launch(): void {
    this.state = 'starting';
    this.generation = randomUUID();
    this.metadata = undefined;
    this.pid = undefined;
    const generation = this.generation;
    let child: RuntimeChild;
    try {
      child = this.options.fork();
    } catch {
      this.scheduleRestart();
      return;
    }
    this.child = child;
    child.on('message', (message) => {
      if (this.child !== child || this.state === 'stopping') return;
      const parsed = childEnvelopeSchema.safeParse(message);
      if (!parsed.success) return;
      if (parsed.data.type === 'crash') {
        child.kill();
        return;
      }
      if (parsed.data.bootstrap.generation !== generation) return;
      clearTimeout(this.startupTimer);
      this.metadata = parsed.data.bootstrap;
      this.pid = parsed.data.pid;
      this.state = 'ready';
      this.options.onReady?.(this.resolve());
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      clearTimeout(this.startupTimer);
      child.removeAllListeners();
      this.child = undefined;
      this.metadata = undefined;
      this.pid = undefined;
      this.lastExit = { code, at: new Date().toISOString() };
      if (this.state === 'stopping') {
        this.completeStop();
        return;
      }
      this.scheduleRestart();
    });
    this.startupTimer = setTimeout(() => child.kill(), this.options.startupTimeoutMs ?? 10_000);
    try {
      const startup =
        typeof this.options.startup === 'function'
          ? this.options.startup(generation)
          : this.options.startup;
      child.postMessage({ type: 'startup', generation, ...startup });
    } catch {
      child.kill();
    }
  }

  private scheduleRestart(): void {
    this.state = 'degraded';
    if (this.restartCount >= 3) {
      this.options.onUnavailable?.();
      return;
    }
    this.restartCount += 1;
    this.state = 'restarting';
    const delay =
      this.options.restartDelay?.(this.restartCount) ??
      300 * 2 ** (this.restartCount - 1) + Math.floor(Math.random() * 200);
    this.restartTimer = setTimeout(() => this.launch(), delay);
  }

  private completeStop(): void {
    clearTimeout(this.stopTimer);
    this.state = 'stopped';
    this.finishStop?.();
    this.finishStop = undefined;
  }

  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.state = 'stopping';
    this.metadata = undefined;
    clearTimeout(this.startupTimer);
    clearTimeout(this.restartTimer);
    this.stopped = new Promise<void>((resolve) => {
      this.finishStop = resolve;
    });
    const child = this.child;
    if (!child) this.completeStop();
    else {
      this.stopTimer = setTimeout(() => child.kill(), 2_000);
      try {
        child.postMessage({ type: 'shutdown' });
      } catch {
        child.kill();
      }
    }
    return this.stopped;
  }
}
