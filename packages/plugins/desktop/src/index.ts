import { DesktopLifecycle } from './lifecycle.ts';
import { DesktopDiagnosticsOwner, desktopDiagnosticsDomain } from './diagnostics.ts';
import type { Domain } from '@axterm/plugin-api/storage';
import type {
  DesktopDiagnostics,
  DesktopDiagnosticLogs,
  DesktopDiagnosticExport,
  DesktopDiagnosticOutcome,
  DesktopDiagnosticsUpdate,
} from '@axterm/plugin-api/desktop';
import { DesktopUpdates } from './updater.ts';
import type {
  DesktopUpdaterUpdate,
  UpdaterStatus,
  UpdaterAction,
} from '@axterm/plugin-api/desktop';
import { ownDesktopIterator } from './owned-iterator.ts';
import { DesktopExternalUrls } from './external-urls.ts';
import { DesktopPreferences } from './preferences.ts';
import { DesktopPreferencesStore } from './preferences-store.ts';
import { productDomains } from '@axterm/data-schema';
import type {
  DesktopWindowBaseline,
  DesktopWindowUpdate,
  DesktopWindowPreferencesPatch,
  DesktopWindowReceipt,
} from '@axterm/plugin-api/desktop';
import { desktopWindowPreferencesPatchSchema } from '@axterm/plugin-api/desktop';
import { DesktopLaunchStreams } from './launches.ts';
import type { DesktopStartupDecision } from '@axterm/plugin-api/desktop';
import type { DesktopLaunch } from '@axterm/plugin-api/session-intents';
import type {} from '@axterm/plugin-api/desktop';
import { Remote, RemoteError, TypertRemoteService, StorageCommandError } from '@axterm/plugin-api';
import { ZodError } from 'zod';
import type {
  RuntimeHealth,
  RuntimeVersion,
  RuntimeMetadata,
  RuntimeBaseline,
  RuntimeUpdate,
} from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
import type {} from '@axterm/infra-cmdline';
import type { Context } from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopRuntimeController: DesktopRuntimeController;
  }
}
/** Authoritative Desktop runtime facts; lifecycle identity belongs to the shared runner. */
export class DesktopRuntimeController extends TypertRemoteService {
  static inject = ['runtimeIdentity'];
  private ready: boolean;
  private readonly lifecycle: DesktopLifecycle;
  private readonly diagnostics: DesktopDiagnosticsOwner | undefined;
  private readonly diagnosticObservers = new Set<AsyncGenerator<DesktopDiagnosticsUpdate>>();
  private readonly updates: DesktopUpdates;
  private readonly updateObservers = new Set<AsyncGenerator<DesktopUpdaterUpdate>>();
  private readonly externalUrls: DesktopExternalUrls;
  private readonly launches: DesktopLaunchStreams;
  private readonly lifetime = new AbortController();
  private readonly observations = new Set<AsyncGenerator<RuntimeUpdate>>();

  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      desktopLifecycle: this.lifecycle.resourceCount(),
      desktopRuntimeFollowers: this.observations.size,
    });
  }
  constructor(
    ctx: Context,
    private readonly preferences?: DesktopPreferences,
    diagnosticsDomain?: Domain<typeof desktopDiagnosticsDomain>,
  ) {
    super(ctx, 'desktopRuntimeController', { namespace: 'desktop' });
    this.lifecycle = new DesktopLifecycle(ctx.get('nativeDesktopLifecycle'));
    ctx.effect(() => () => this.lifecycle.close(), 'desktop: drain native power observation');
    this.updates = new DesktopUpdates(() => ctx.get('nativeDesktopUpdater'));
    this.diagnostics = diagnosticsDomain
      ? new DesktopDiagnosticsOwner(ctx, diagnosticsDomain, this.updates)
      : undefined;
    if (this.diagnostics) {
      const diagnostics = this.diagnostics;
      ctx.effect(() => () => diagnostics.close(), 'desktop: drain diagnostics');
      ctx.effect(() =>
        ctx.logger.exporter({
          levels: { default: 2 },
          export: (message) => diagnostics.capture(message),
        }),
      );
      ctx.inject(['desktopTaskInspection'], (owner) => {
        owner.desktopTaskInspection.register('desktop.diagnostics', {
          inspect: (signal) => {
            signal.throwIfAborted();
            return { active: diagnostics.active() };
          },
          dispose: () => diagnostics.close(),
        });
      });
    }
    ctx.effect(
      () => async () => {
        await Promise.all(
          [...this.diagnosticObservers].map((iterator) => iterator.return(undefined)),
        );
      },
      'desktop: drain diagnostic observations',
    );

    ctx.effect(() => () => this.updates.close(), 'desktop: drain updater operations');
    ctx.inject(['desktopTaskInspection'], (owner) => {
      owner.desktopTaskInspection.register('desktop.updater', {
        inspect: (signal) => {
          signal.throwIfAborted();
          return { active: this.updates.active() };
        },
        dispose: () => this.updates.close(),
      });
    });
    ctx.effect(
      () => async () => {
        await Promise.all([...this.updateObservers].map((iterator) => iterator.return(undefined)));
      },
      'desktop: drain updater observations',
    );
    this.externalUrls = new DesktopExternalUrls(() => ctx.get('nativeExternalUrls'));
    ctx.effect(() => () => this.externalUrls.close(), 'desktop: drain external navigation');
    this.launches = new DesktopLaunchStreams(() => ctx.get('nativeDesktopLaunches'));
    ctx.effect(() => () => this.launches.close(), 'desktop: drain native launch streams');
    ctx.effect(
      () => async () => {
        this.lifetime.abort();
        await Promise.all([...this.observations].map((iterator) => iterator.return(undefined)));
        this.observations.clear();
      },
      'desktop: drain runtime observations',
    );
    ctx.inject(['remoteEvents'], (events) => {
      events.remoteEvents.register({ event: 'desktop/runtime-state', mode: 'emit' });
    });
    const appReady = ctx.get('appReady');
    this.ready = appReady === undefined;
    if (appReady)
      ctx.effect(() =>
        appReady.onReady(() => {
          this.ready = true;
          ctx.emit('desktop/runtime-state', this.getRuntimeMetadata());
        }),
      );
  }

  private requireDiagnostics(): DesktopDiagnosticsOwner {
    if (!this.diagnostics)
      throw new RemoteError('desktop/failure', 'Diagnostics are unavailable', {
        reason: 'unavailable',
      });
    return this.diagnostics;
  }
  @Remote getDiagnostics(signal: AbortSignal): Promise<DesktopDiagnostics> {
    return this.requireDiagnostics().snapshot(signal);
  }
  @Remote getDiagnosticLogs(): Promise<DesktopDiagnosticLogs> {
    return this.requireDiagnostics().logs();
  }
  @Remote({
    resources: { fileGrant: (_key: string, _generation: string, grantId: string) => grantId },
  })
  exportDiagnostics(
    key: string,
    generation: string,
    grantId: string,
    signal: AbortSignal,
  ): Promise<DesktopDiagnosticExport> {
    return this.requireDiagnostics().export(key, generation, grantId, signal);
  }
  @Remote getDiagnosticExportOutcome(key: string, generation: string): DesktopDiagnosticOutcome {
    return this.requireDiagnostics().outcome(key, generation);
  }
  @Remote drainDiagnosticExport(
    key: string,
    generation: string,
  ): Promise<DesktopDiagnosticOutcome> {
    return this.requireDiagnostics().drain(key, generation);
  }
  @Remote({ mode: 'stream' }) watchDiagnostics(
    signal: AbortSignal,
  ): AsyncIterable<DesktopDiagnosticsUpdate> {
    if (this.diagnosticObservers.size >= 16)
      throw new RemoteError('desktop/failure', 'Diagnostic observation capacity exceeded', {
        reason: 'capacity',
      });
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const diagnostics = this.requireDiagnostics();
    const iterator = ownDesktopIterator<DesktopDiagnosticsUpdate>(
      (lifetime) =>
        (async function* () {
          let first = true;
          while (!lifetime.aborted) {
            yield {
              type: first ? 'baseline' : 'replace',
              diagnostics: await diagnostics.snapshot(lifetime),
            };
            first = false;
            if (lifetime.aborted) break;
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                lifetime.removeEventListener('abort', done);
                resolve();
              };
              const timer = setTimeout(done, 3000);
              lifetime.addEventListener('abort', done, { once: true });
            });
          }
        })(),
      [signal, this.lifetime.signal],
      () => {
        this.diagnosticObservers.delete(iterator);
      },
    );
    this.diagnosticObservers.add(iterator);
    return { [Symbol.asyncIterator]: () => iterator };
  }

  @Remote
  getUpdaterStatus(signal: AbortSignal): Promise<UpdaterStatus> {
    return this.updates.status(signal);
  }
  @Remote
  performUpdaterAction(
    generation: string,
    key: string,
    action: UpdaterAction,
    signal: AbortSignal,
  ): Promise<UpdaterStatus> {
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('desktop/failure', 'Desktop generation is retired', {
        reason: 'stale',
      });
    return this.updates.perform(key, action, signal);
  }
  @Remote({ mode: 'stream' })
  watchUpdater(signal: AbortSignal): AsyncIterable<DesktopUpdaterUpdate> {
    if (this.updateObservers.size >= 16)
      throw new RemoteError('desktop/failure', 'Updater observation capacity exceeded', {
        reason: 'capacity',
      });
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const updates = this.updates,
      generation = this.ctx.runtimeIdentity.generation;
    const iterator = ownDesktopIterator<DesktopUpdaterUpdate>(
      (lifetime) =>
        (async function* () {
          let first = true;
          while (!lifetime.aborted) {
            yield {
              type: first ? 'baseline' : 'replace',
              generation,
              status: await updates.status(lifetime),
            };
            first = false;
            if (lifetime.aborted) break;
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                lifetime.removeEventListener('abort', done);
                resolve();
              };
              const timer = setTimeout(done, 3000);
              lifetime.addEventListener('abort', done, { once: true });
            });
          }
        })(),
      [signal, this.lifetime.signal],
      () => {
        this.updateObservers.delete(iterator);
      },
    );
    this.updateObservers.add(iterator);
    return { [Symbol.asyncIterator]: () => iterator };
  }

  @Remote({ mode: 'stream' })
  watchWindowPreferences(signal: AbortSignal): AsyncIterable<DesktopWindowUpdate> {
    return this.requirePreferences().watch(signal);
  }
  @Remote
  getWindowPreferences(): DesktopWindowBaseline {
    return this.requirePreferences().snapshot();
  }
  @Remote
  async updateWindowPreferences(
    key: string,
    patch: DesktopWindowPreferencesPatch,
    version: number,
    generation: string,
  ): Promise<DesktopWindowReceipt> {
    try {
      return await this.requirePreferences().update(
        key,
        desktopWindowPreferencesPatchSchema.parse(patch),
        version,
        generation,
      );
    } catch (error) {
      if (error instanceof ZodError)
        throw new RemoteError('desktop/failure', 'Invalid Desktop preference', {
          reason: 'invalid-input',
        });
      if (error instanceof StorageCommandError)
        throw new RemoteError('desktop/failure', 'Desktop preference receipt failed', {
          reason:
            error.code === 'receipt-expired'
              ? 'receipt-expired'
              : error.code === 'conflict'
                ? 'conflict'
                : 'invalid-input',
        });
      throw error;
    }
  }
  @Remote
  retryWindowPreferences(generation: string): Promise<void> {
    return this.requirePreferences().retry(generation);
  }
  private requirePreferences(): DesktopPreferences {
    if (!this.preferences)
      throw new RemoteError('desktop/failure', 'Desktop preferences are unavailable', {
        reason: 'unavailable',
      });
    return this.preferences;
  }

  private startupDecision(
    windowId: string,
    key: string,
    generation: string,
    claim: boolean,
  ): DesktopStartupDecision {
    if (
      generation !== this.ctx.runtimeIdentity.generation ||
      !this.ctx.get('nativeDesktopLaunches')
    )
      throw new RemoteError('desktop/not-ready', 'Native startup input is unavailable', {});
    try {
      return { generation, phase: this.launches.decision(windowId, key, claim) };
    } catch {
      throw new RemoteError('desktop/not-ready', 'Native startup input is unavailable', {});
    }
  }
  @Remote getConfiguredStartup(
    windowId: string,
    key: string,
    generation: string,
  ): DesktopStartupDecision {
    return this.startupDecision(windowId, key, generation, false);
  }
  @Remote claimConfiguredStartup(
    windowId: string,
    key: string,
    generation: string,
  ): DesktopStartupDecision {
    return this.startupDecision(windowId, key, generation, true);
  }
  @Remote({ mode: 'stream' })
  watchDesktopLaunches(windowId: string, signal: AbortSignal): AsyncIterable<DesktopLaunch> {
    try {
      return this.launches.watch(windowId, signal);
    } catch {
      throw new RemoteError('desktop/not-ready', 'Native Desktop launch input is unavailable', {});
    }
  }

  @Remote
  openExternal(generation: string, key: string, url: string, signal: AbortSignal): Promise<void> {
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('desktop/failure', 'Desktop generation is retired', {
        reason: 'stale',
      });
    return this.externalUrls.open(key, url, signal);
  }

  @Remote
  health(): RuntimeHealth {
    return { status: 'ok' };
  }

  @Remote
  getVersion(): RuntimeVersion {
    return { apiVersion: 'v1', appVersion: this.ctx.runtimeIdentity.appVersion };
  }

  @Remote
  getRuntimeMetadata(): RuntimeMetadata {
    if (!this.ready)
      throw new RemoteError('desktop/not-ready', 'Runtime startup has not completed', {});
    const { runtimeId, generation, startedAt, pid, mode } = this.ctx.runtimeIdentity;
    return {
      runtimeId,
      generation,
      startedAt,
      pid,
      mode,
      state: 'ready',
      ...(this.ctx.runtimeIdentity.recoveryMode
        ? { recoveryMode: true as const, recoveryHome: this.ctx.runtimeIdentity.recoveryHome }
        : {}),
    };
  }

  @Remote({ mode: 'stream' })
  watchRuntime(signal: AbortSignal): AsyncIterable<RuntimeUpdate> {
    if (this.observations.size >= 64)
      throw new RemoteError('desktop/not-ready', 'Runtime observation capacity exceeded', {});
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const baseline: RuntimeBaseline = {
        type: 'baseline',
        health: this.health(),
        version: this.getVersion(),
        metadata: this.getRuntimeMetadata(),
      },
      observations = this.observations,
      lifecycle = this.lifecycle;
    const iterator = ownDesktopIterator<RuntimeUpdate>(
      (lifetime) =>
        (async function* () {
          lifetime.throwIfAborted();
          let first = true;
          for await (const state of lifecycle.watch(lifetime)) {
            yield {
              ...baseline,
              type: first ? 'baseline' : 'replace',
              ...(state ? { lifecycle: state } : {}),
            };
            first = false;
          }
        })(),
      [signal, this.lifetime.signal],
      () => {
        observations.delete(iterator);
      },
    );
    observations.add(iterator);
    return { [Symbol.asyncIterator]: () => iterator };
  }
}

export const inject = ['runtimeIdentity', 'storage', 'storageDomain'];
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storage.domain.open(productDomains.desktop);
  ctx.effect(() => () => domain.close());
  const diagnosticsDomain = await ctx.storage.domain.open(desktopDiagnosticsDomain);
  ctx.effect(() => () => diagnosticsDomain.close());
  const preferences = new DesktopPreferences(
    new DesktopPreferencesStore(domain),
    ctx.runtimeIdentity.generation,
    ctx.get('nativeDesktopWindows'),
  );
  ctx.effect(() => () => preferences.close());
  await preferences.initialize();
  new DesktopRuntimeController(ctx, preferences, diagnosticsDomain);
}
export default { inject, apply };

export type {
  RuntimeHealth,
  RuntimeVersion,
  RuntimeMetadata,
  RuntimeBaseline,
  RuntimeUpdate,
} from '@axterm/plugin-api';
