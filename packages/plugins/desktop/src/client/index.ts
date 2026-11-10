import { installDesktopPowerUi } from './power-ui.tsx';
import { DesktopResumePolicy } from './resume-policy.ts';
import type { ConnectionHandle } from '@axterm/infra-connection/client';
import { installRuntimeStatusUi } from './runtime-status.tsx';
import { DesktopDiagnosticsModel } from './diagnostics-model.ts';
import { DiagnosticExportCommands } from './diagnostics-commands.ts';
import { installDiagnosticsUi } from './diagnostics-ui.tsx';
import { DesktopUpdaterModel } from './updater-model.ts';
import { DesktopUpdateCommands } from './updater-commands.ts';
import { installDesktopUpdaterUi } from './updater-ui.tsx';
import { installDesktopShortcuts } from './shortcuts.ts';
import { installWindowControls } from './window-controls.tsx';
import { DesktopPreferencesModel } from './preferences-model.ts';
import { DesktopPreferenceCommands } from './preferences-commands.ts';
import { installDesktopPreferencesUi } from './preferences-ui.tsx';
import type {} from '@axterm/ui/shortcuts';
import { DesktopLinksClient } from './external-urls.ts';
import { installDesktopLaunchUi } from './launch-ui.tsx';
import { installRecoveryUi } from './recovery.tsx';
import type { Context } from '@deepseek-ai/cordis';
import type { RuntimeBaseline, RuntimeReplacement, RuntimeUpdate } from '@axterm/plugin-api';
import { RemoteSnapshotStream } from '@axterm/infra-gateway/client';
import remote from '@axterm/plugin-desktop/remote';

export type DesktopRuntimeState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: RuntimeBaseline }
  | { readonly status: 'error'; readonly message: string };

/** Observable Client projection, replaced by each connection generation's complete baseline. */
export class DesktopRuntimeModel {
  private snapshot: DesktopRuntimeState = { status: 'connecting' };
  private readonly listeners = new Set<{ readonly listener: () => void }>();
  private stream: RemoteSnapshotStream<RuntimeBaseline, RuntimeReplacement>;
  private retrying: Promise<void> | undefined;
  private disposed = false;
  private readonly resume = new DesktopResumePolicy();
  private resumeNotice = 0;
  getResumeNotice = (): number => this.resumeNotice;
  dismissResume = (): void => {
    if (this.disposed || !this.resumeNotice) return;
    this.resumeNotice = 0;
    this.publish(this.snapshot);
  };

  constructor(private readonly ctx: Context) {
    this.stream = this.open();
  }
  private open(): RemoteSnapshotStream<RuntimeBaseline, RuntimeReplacement> {
    const stream = new RemoteSnapshotStream<RuntimeBaseline, RuntimeReplacement>(
      this.ctx.remote.$stream<RuntimeUpdate>({
        name: 'desktop.runtime',
        open: (signal) => this.ctx.remote.desktop.watchRuntime(signal),
        ended: () => new Error('Runtime observation ended'),
      }),
      {
        name: 'desktop.runtime',
        isSnapshot: (value): value is RuntimeBaseline => value.type === 'baseline',
        replace: (baseline) => this.acceptRuntime(baseline),
        update: (replacement) => this.acceptRuntime({ ...replacement, type: 'baseline' }),
        failed: () =>
          this.publish({ status: 'error', message: 'Runtime information is unavailable' }),
      },
    );
    stream.start();
    return stream;
  }

  private acceptRuntime(baseline: RuntimeBaseline): void {
    const resumed = this.resume.accept(baseline);
    if (resumed) this.resumeNotice++;
    this.publish({ status: 'ready', baseline });
    if (resumed)
      (this.ctx.get('connection') as unknown as ConnectionHandle | undefined)?.reconnect();
  }

  getSnapshot = (): DesktopRuntimeState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) throw new Error('Runtime model is disposed');
    const entry = { listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  };
  retry(): Promise<void> {
    if (this.disposed) return Promise.reject(Error('Runtime model is disposed'));
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      if (this.disposed) return;
      this.publish({ status: 'connecting' });
      this.stream = this.open();
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stream.dispose();
    await this.retrying;
    this.listeners.clear();
  }
  private publish(snapshot: DesktopRuntimeState): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    for (const { listener } of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('[desktop] Runtime observer failed');
      }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopRuntimeModel: DesktopRuntimeModel;
  }
}
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.desktop'], (scope) => {
    const model = new DesktopRuntimeModel(scope);
    installDesktopPowerUi(scope, model);
    scope.effect(() => () => model.dispose());
    scope.provide('desktopRuntimeModel', model);
    const links = new DesktopLinksClient(
      model.getSnapshot,
      async (generation, key, url, signal) => {
        const result = await scope.remote.desktop.openExternal(generation, key, url, signal);
        if (!result.ok) throw result.error;
      },
      (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    );
    scope.effect(() => () => links.close());
    scope.provide('desktopUi', links);
    const updater = new DesktopUpdaterModel(scope);
    scope.effect(() => () => updater.close());
    const updateCommands = new DesktopUpdateCommands(
      () => {
        const state = updater.getSnapshot();
        return state.status === 'ready' ? state.baseline.generation : undefined;
      },
      async (generation, key, action, signal) => {
        const result = await scope.remote.desktop.performUpdaterAction(
          generation,
          key,
          action,
          signal,
        );
        if (!result.ok) throw result.error;
        return result.value;
      },
    );
    scope.effect(() => () => updateCommands.close());
    installDesktopUpdaterUi(scope, updater, updateCommands);
    const diagnostics = new DesktopDiagnosticsModel(scope);
    scope.effect(() => () => diagnostics.close());
    scope.inject(['fileGrantActions'], (ui) => {
      const commands = new DiagnosticExportCommands(
        () => {
          const state = diagnostics.getSnapshot();
          return state.status === 'ready' ? state.baseline.diagnostics.generation : undefined;
        },
        ui.fileGrantActions,
        {
          export: async (key, generation, grantId, signal) => {
            const result = await ui.remote.desktop.exportDiagnostics(
              key,
              generation,
              grantId,
              signal,
            );
            if (!result.ok) throw result.error;
            return result.value;
          },
          outcome: async (key, generation) => {
            const result = await ui.remote.desktop.getDiagnosticExportOutcome(key, generation);
            if (!result.ok) throw result.error;
            return result.value;
          },
          drain: async (key, generation) => {
            const result = await ui.remote.desktop.drainDiagnosticExport(key, generation);
            if (!result.ok) throw result.error;
            return result.value;
          },
        },
      );
      ui.effect(() => () => commands.close());
      installDiagnosticsUi(ui, diagnostics, commands);
    });
    const preferences = new DesktopPreferencesModel(scope),
      commands = new DesktopPreferenceCommands(preferences);
    scope.effect(() => () => preferences.close());
    scope.effect(() => () => commands.close());
    scope.inject(['locale', 'shortcuts'], (ui) => {
      installRuntimeStatusUi(ui, model);
      installRecoveryUi(ui, model);
      installDesktopLaunchUi(ui);
      installDesktopPreferencesUi(ui, preferences, commands);
      installDesktopShortcuts(ui, model, preferences, commands);
      installWindowControls(ui);
    });
  });
}
