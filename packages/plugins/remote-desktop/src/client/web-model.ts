import type { Context } from '@deepseek-ai/cordis';
import type {
  CreateWebSession,
  WebSession,
  WebSessionBaseline,
  WebSessionDelta,
  RemoteDesktopCommandOutcome,
  NativeWebViewPresentation,
  NativeWebViewAction,
  NativeWebViewAuthResponse,
} from '@axterm/plugin-api/remote-desktop';
import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@axterm/infra-gateway/client';
import { WebSessionProjection } from './web-projection.ts';
export type WebSessionState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: WebSessionBaseline }
  | { readonly status: 'error'; readonly message: string };
/** A metadata projection and commands. Byte channels are separately owned by their renderer. */
export class WebSessionModel {
  private readonly projection = new WebSessionProjection();
  private snapshot: WebSessionState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteSnapshotStream<WebSessionBaseline, WebSessionDelta>;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly commands = new Set<Promise<unknown>>();
  private retrying: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    private readonly windowId: string,
  ) {
    this.stream = this.open();
  }
  getSnapshot = (): WebSessionState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) throw new Error('WEB_SESSION_MODEL_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async create(
    input: Pick<CreateWebSession, 'bookmarkId'>,
    key = crypto.randomUUID(),
    signal?: AbortSignal,
  ): Promise<WebSession> {
    this.assertOpen();
    const state = this.snapshot;
    if (state.status !== 'ready') throw Error('WEB_SESSION_NOT_READY');
    const result = await this.track(
      this.ctx.remote.remoteDesktop.createWebSession(
        key,
        { ...structuredClone(input), windowId: this.windowId },
        state.baseline.generation,
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
      ),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async getCommandOutcome(generation: string, key: string): Promise<RemoteDesktopCommandOutcome> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.remoteDesktop.getWebCommandOutcome(generation, key),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async present(id: string, input: NativeWebViewPresentation, signal?: AbortSignal): Promise<void> {
    const generation = this.generation();
    const result = await this.track(
      this.ctx.remote.remoteDesktop.presentWebSession(
        id,
        this.windowId,
        input,
        generation,
        this.signal(signal),
      ),
    );
    if (!result.ok) throw result.error;
  }
  async perform(id: string, input: NativeWebViewAction, signal?: AbortSignal): Promise<void> {
    const result = await this.track(
      this.ctx.remote.remoteDesktop.performWebSessionAction(
        id,
        this.windowId,
        input,
        this.generation(),
        this.signal(signal),
      ),
    );
    if (!result.ok) throw result.error;
  }
  async authenticate(
    id: string,
    input: NativeWebViewAuthResponse,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.track(
      this.ctx.remote.remoteDesktop.answerWebSessionAuthentication(
        id,
        this.windowId,
        input,
        this.generation(),
        this.signal(signal),
      ),
    );
    if (!result.ok) throw result.error;
  }
  private generation(): string {
    this.assertOpen();
    const state = this.snapshot;
    if (state.status !== 'ready') throw Error('WEB_SESSION_NOT_READY');
    return state.baseline.generation;
  }
  private signal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
  }
  async close(id: string, generation?: string): Promise<void> {
    this.assertOpen();
    const state = this.snapshot;
    if (generation === undefined && state.status !== 'ready') throw Error('WEB_SESSION_NOT_READY');
    const result = await this.track(
      this.ctx.remote.remoteDesktop.closeWebSession(
        id,
        this.windowId,
        generation ?? (state.status === 'ready' ? state.baseline.generation : ''),
      ),
    );
    if (!result.ok) throw result.error;
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      if (!this.disposed) {
        this.publish({ status: 'connecting' });
        this.stream = this.open();
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    await this.stream.dispose();
    await this.retrying;
    await Promise.allSettled([...this.commands]);
    this.listeners.clear();
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.commands.add(task);
    const settled = () => this.commands.delete(task);
    void task.then(settled, settled);
    return task;
  }
  private assertOpen(): void {
    if (this.disposed) throw new Error('WEB_SESSION_MODEL_CLOSED');
  }
  private open(): RemoteSnapshotStream<WebSessionBaseline, WebSessionDelta> {
    const stream = new RemoteSnapshotStream<WebSessionBaseline, WebSessionDelta>(
      this.ctx.remote.$stream({
        name: 'remoteDesktop.webMetadata',
        open: (signal) => this.ctx.remote.remoteDesktop.watchWebSessions(this.windowId, signal),
        ended: () => new RemoteStreamCarrierError('Remote desktop metadata generation ended'),
      }),
      {
        name: 'remoteDesktop.webMetadata',
        isSnapshot: (value): value is WebSessionBaseline => value.type === 'baseline',
        replace: (value) =>
          this.publish({ status: 'ready', baseline: this.projection.replace(value) }),
        update: (value) => {
          if (this.snapshot.status !== 'ready') throw new Error('WEB_SESSION_BASELINE_REQUIRED');
          this.publish({ status: 'ready', baseline: this.projection.apply(value) });
        },
        failed: () =>
          this.publish({ status: 'error', message: 'Web session information is unavailable' }),
      },
    );
    stream.start();
    return stream;
  }
  private publish(value: WebSessionState): void {
    if (this.disposed) return;
    this.snapshot = value;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('WEB_SESSION_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
