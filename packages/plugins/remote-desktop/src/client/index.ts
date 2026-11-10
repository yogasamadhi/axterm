import type * as NoVnc from '@novnc/novnc';
import { installRemoteDesktopUi } from './ui/index.tsx';
import type { ConnectionHandle } from '@axterm/infra-connection/client';
import { claimRemoteDesktopCredentials } from './credentials.ts';
export { claimRemoteDesktopCredentials } from './credentials.ts';
export { RemoteDesktopStream } from './stream.ts';
import { RemoteDesktopProjection } from './projection.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {
  CreateRemoteDesktopSession,
  RemoteDesktopCredentials,
  RemoteDesktopBaseline,
  RemoteDesktopDelta,
  RemoteDesktopSession,
  RemoteDesktopCommandOutcome,
} from '@axterm/plugin-api/remote-desktop';
import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@axterm/infra-gateway/client';
import remote from '@axterm/plugin-remote-desktop/remote';
export type RemoteDesktopState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: RemoteDesktopBaseline }
  | { readonly status: 'error'; readonly message: string };
/** A metadata projection and commands. Byte channels are separately owned by their renderer. */
export class RemoteDesktopModel {
  private readonly projection = new RemoteDesktopProjection();
  private snapshot: RemoteDesktopState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteSnapshotStream<RemoteDesktopBaseline, RemoteDesktopDelta>;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly commands = new Set<Promise<unknown>>();
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
  }
  getSnapshot = (): RemoteDesktopState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) throw new Error('REMOTE_DESKTOP_MODEL_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async create(
    input: CreateRemoteDesktopSession,
    key = crypto.randomUUID(),
    signal?: AbortSignal,
  ): Promise<RemoteDesktopSession> {
    this.assertOpen();
    const state = this.snapshot;
    if (state.status !== 'ready') throw Error('REMOTE_DESKTOP_NOT_READY');
    const result = await this.track(
      this.ctx.remote.remoteDesktop.createSession(
        key,
        structuredClone(input),
        state.baseline.generation,
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
      ),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  /** Transient protocol response only; the result never enters this model's snapshot. */
  claimCredentials(id: string, signal?: AbortSignal): Promise<RemoteDesktopCredentials> {
    this.assertOpen();
    return this.track(
      claimRemoteDesktopCredentials(
        this.ctx.get('connection') as unknown as ConnectionHandle,
        id,
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
      ),
    );
  }
  async loadVnc(): Promise<typeof NoVnc> {
    this.assertOpen();
    const result = await this.track(this.ctx.remote.remoteDesktop.getProtocolAssets());
    if (!result.ok) throw result.error;
    const path = result.value.novnc;
    if (!/^remote-desktop\/modules\/novnc-[a-f0-9]{64}\.js$/.test(path))
      throw Error('REMOTE_DESKTOP_MODULE_INVALID');
    this.assertOpen();
    return import(/* @vite-ignore */ new URL(path, document.baseURI).href) as Promise<typeof NoVnc>;
  }
  async getCommandOutcome(generation: string, key: string): Promise<RemoteDesktopCommandOutcome> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.remoteDesktop.getCommandOutcome(generation, key),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async resize(id: string, width: number, height: number): Promise<void> {
    this.assertOpen();
    const result = await this.track(this.ctx.remote.remoteDesktop.resizeSession(id, width, height));
    if (!result.ok) throw result.error;
  }
  async close(id: string, generation?: string): Promise<void> {
    this.assertOpen();
    const state = this.snapshot;
    if (generation === undefined && state.status !== 'ready')
      throw Error('REMOTE_DESKTOP_NOT_READY');
    const result = await this.track(
      this.ctx.remote.remoteDesktop.closeSession(
        id,
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
    if (this.disposed) throw new Error('REMOTE_DESKTOP_MODEL_CLOSED');
  }
  private open(): RemoteSnapshotStream<RemoteDesktopBaseline, RemoteDesktopDelta> {
    const stream = new RemoteSnapshotStream<RemoteDesktopBaseline, RemoteDesktopDelta>(
      this.ctx.remote.$stream({
        name: 'remoteDesktop.metadata',
        open: (signal) => this.ctx.remote.remoteDesktop.watchSessions(signal),
        ended: () => new RemoteStreamCarrierError('Remote desktop metadata generation ended'),
      }),
      {
        name: 'remoteDesktop.metadata',
        isSnapshot: (value): value is RemoteDesktopBaseline => value.type === 'baseline',
        replace: (value) =>
          this.publish({ status: 'ready', baseline: this.projection.replace(value) }),
        update: (value) => {
          if (this.snapshot.status !== 'ready') throw new Error('REMOTE_DESKTOP_BASELINE_REQUIRED');
          this.publish({ status: 'ready', baseline: this.projection.apply(value) });
        },
        failed: () =>
          this.publish({ status: 'error', message: 'Remote desktop information is unavailable' }),
      },
    );
    stream.start();
    return stream;
  }
  private publish(value: RemoteDesktopState): void {
    if (this.disposed) return;
    this.snapshot = value;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('REMOTE_DESKTOP_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteDesktopModel: RemoteDesktopModel;
  }
}
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.remoteDesktop'], (scope) => {
    const model = new RemoteDesktopModel(scope);
    scope.provide('remoteDesktopModel', model);
    scope.effect(() => () => model.dispose());
    scope.inject(['workspaceUi', 'slots', 'locale'], (ui) => installRemoteDesktopUi(ui, model));
  });
}
