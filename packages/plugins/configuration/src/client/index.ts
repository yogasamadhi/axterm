import { installShortcutPreferences } from './shortcuts.ts';
import type { TerminalRecoveryPreferences } from '@axterm/plugin-api/configuration';
import {
  workspacePresentationSlotSchema,
  workspacePresentationSchema,
  type WorkspacePresentation,
  type WorkspacePresentationBinding,
  type WorkspacePresentationReceipt,
} from '@axterm/plugin-api/configuration';
import { SyncModel } from './sync.ts';
import { ConfigurationPortableModel } from './portable.ts';
import { SavedCredentialsModel } from './credentials.ts';
import { installPresentationPreferences } from './presentation.ts';
import type { Context } from '@deepseek-ai/cordis';
import { updateSettingsSchema } from '@axterm/plugin-api/configuration';
import type {
  SettingsBaseline,
  SettingsUpdate,
  UpdateSettingsInput,
  SettingsReceipt,
} from '@axterm/plugin-api/configuration';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import remote from '@axterm/plugin-configuration/remote';
import { SettingsProjection } from './projection.ts';
export type SettingsState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: SettingsBaseline }
  | { readonly status: 'error'; readonly message: string };
export class SettingsModel {
  private state: SettingsState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<SettingsUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private closing = false;
  private readonly commands = new Set<Promise<unknown>>();
  private retrying: Promise<void> | undefined;
  private observedTail: Promise<void> = Promise.resolve();
  private observedCount = 0;
  private publications = 0;
  private readonly observedLifetime = new AbortController();
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): SettingsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async bindWorkspacePresentation(slot: string): Promise<WorkspacePresentationBinding> {
    this.assertOpen();
    if (this.commands.size >= 32) throw Error('SETTINGS_COMMAND_CAPACITY');
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.bindWorkspacePresentation(
          workspacePresentationSlotSchema.parse(slot),
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async saveWorkspacePresentation(
    key: string,
    slot: string,
    input: WorkspacePresentation,
    version: number,
    generation: string,
    importRevision: number,
  ): Promise<WorkspacePresentationReceipt> {
    this.assertOpen();
    if (this.commands.size >= 32) throw Error('SETTINGS_COMMAND_CAPACITY');
    const state = this.state;
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('WORKSPACE_PRESENTATION_NOT_READY');
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.saveWorkspacePresentation(
          key,
          workspacePresentationSlotSchema.parse(slot),
          workspacePresentationSchema.parse(input),
          version,
          generation,
          importRevision,
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async setTerminalRecoveryPreferences(
    key: string,
    preferences: TerminalRecoveryPreferences,
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt> {
    this.assertOpen();
    if (this.commands.size >= 32) throw Error('SETTINGS_COMMAND_CAPACITY');
    const state = this.state;
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('MONITOR_PREFERENCES_GENERATION_CHANGED');
    const input = structuredClone(preferences);
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.setTerminalRecoveryPreferences(
          key,
          input,
          ifMatch,
          generation,
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async setLegacyShortcutBindings(
    key: string,
    bindings: SettingsBaseline['settings']['shortcuts']['bindings'],
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt> {
    this.assertOpen();
    if (this.commands.size >= 32) throw Error('SETTINGS_COMMAND_CAPACITY');
    const state = this.state;
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('SHORTCUT_GENERATION_CHANGED');
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.setLegacyShortcutBindings(
          key,
          structuredClone(bindings),
          ifMatch,
          generation,
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async setShortcutDocument(
    key: string,
    document: NonNullable<SettingsBaseline['settings']['shortcuts']['document']>,
    ifMatch: string,
    generation: string,
    resetTerminalGestures: boolean = false,
  ): Promise<SettingsReceipt> {
    this.assertOpen();
    if (this.commands.size >= 32) throw Error('SETTINGS_COMMAND_CAPACITY');
    const state = this.state;
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('SHORTCUT_GENERATION_CHANGED');
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.setShortcutDocument(
          key,
          document,
          ifMatch,
          generation,
          resetTerminalGestures,
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async setMonitorPreferences(
    key: string,
    preferences: SettingsBaseline['settings']['monitor'],
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt> {
    this.assertOpen();
    if (this.commands.size >= 32) throw Error('SETTINGS_COMMAND_CAPACITY');
    const state = this.state;
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('MONITOR_PREFERENCES_GENERATION_CHANGED');
    const input = structuredClone(preferences);
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.setMonitorPreferences(
          key,
          input,
          ifMatch,
          generation,
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async setTerminalShortcutBarButtons(
    key: string,
    buttons: SettingsBaseline['settings']['terminal']['shortcutBarButtons'],
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt> {
    this.assertOpen();
    if (this.commands.size >= 32) throw Error('SETTINGS_COMMAND_CAPACITY');
    const state = this.state;
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('TERMINAL_KEY_PREFERENCES_GENERATION_CHANGED');
    const input = structuredClone(buttons);
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.setTerminalShortcutBarButtons(
          key,
          input,
          ifMatch,
          generation,
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async setTerminalVisual(
    key: string,
    visual: SettingsBaseline['settings']['terminal']['visual'],
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt> {
    this.assertOpen();
    if (this.commands.size >= 32) throw Error('SETTINGS_COMMAND_CAPACITY');
    const state = this.state;
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('TERMINAL_VISUAL_GENERATION_CHANGED');
    const request = structuredClone(visual);
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.setTerminalVisual(
          key,
          request,
          ifMatch,
          generation,
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async updateSettings(
    key: string,
    input: UpdateSettingsInput,
    ifMatch: string | undefined,
  ): Promise<SettingsReceipt> {
    this.assertOpen();
    if (this.commands.size >= 32) throw new Error('SETTINGS_COMMAND_CAPACITY');
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.updateSettings(key, input, ifMatch);
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  writeObservedSettings(input: UpdateSettingsInput): Promise<void> {
    this.assertOpen();
    if (this.observedCount >= 16 || this.commands.size >= 32)
      throw new Error('SETTINGS_COMMAND_CAPACITY');
    const initial = this.state;
    if (initial.status !== 'ready') throw new Error('SETTINGS_UNAVAILABLE');
    const generation = initial.baseline.generation;
    const patch = updateSettingsSchema.parse(structuredClone(input));
    this.observedCount++;
    const task = this.observedTail.then(async () => {
      this.assertOpen();
      const current = this.state;
      if (current.status !== 'ready') throw new Error('SETTINGS_UNAVAILABLE');
      if (current.baseline.generation !== generation)
        throw new Error('SETTINGS_GENERATION_CHANGED');
      try {
        const receipt = await this.updateSettings(
          crypto.randomUUID(),
          patch,
          '"v' + current.baseline.settings.version + '"',
        );
        await this.observeSettings(generation, receipt.version);
      } catch (error) {
        if (
          !this.closing &&
          !this.disposed &&
          (this.state.status !== 'ready' || this.state.baseline.generation === generation)
        ) {
          const after = this.publications;
          try {
            await this.retry();
            await this.observeSettings(generation, 0, after);
          } catch {
            /* A readonly refresh cannot replace the original command failure. */
          }
        }
        throw error;
      }
    });
    this.observedTail = task.catch(() => {});
    void task
      .finally(() => {
        this.observedCount--;
      })
      .catch(() => {});
    return this.track(task);
  }
  private observeSettings(generation: string, minimumVersion: number, after = -1): Promise<void> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const signal = this.observedLifetime.signal;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.listeners.delete(check);
        signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(new Error('SETTINGS_MODEL_CLOSED'));
      const check = () => {
        if (signal.aborted) return aborted();
        if (this.state.status === 'ready') {
          if (this.state.baseline.generation !== generation)
            return finish(new Error('SETTINGS_GENERATION_CHANGED'));
          if (this.publications > after && this.state.baseline.settings.version >= minimumVersion)
            finish();
        } else if (after < 0 && this.state.status === 'error')
          finish(new Error('SETTINGS_UNAVAILABLE'));
      };
      const timer = setTimeout(() => finish(new Error('SETTINGS_ACCEPTANCE_UNAVAILABLE')), 10000);
      this.listeners.add(check);
      signal.addEventListener('abort', aborted, { once: true });
      check();
    });
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.commands.add(operation);
    void operation.finally(() => this.commands.delete(operation)).catch(() => {});
    return operation;
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.disposed) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.closing = true;
    this.observedLifetime.abort();
    await Promise.allSettled([...this.commands]);
    this.disposed = true;
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  private assertOpen(): void {
    if (this.disposed || this.closing) throw new Error('SETTINGS_MODEL_CLOSED');
  }
  private open(): RemoteStream<SettingsUpdate> {
    return this.ctx.remote.$stream({
      name: 'configuration.settings',
      open: (signal) => this.ctx.remote.configuration.watchSettings(signal),
      ended: () => new RemoteStreamCarrierError('Settings generation ended'),
    });
  }
  private async consume(stream: RemoteStream<SettingsUpdate>): Promise<void> {
    const projection = new SettingsProjection();
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
        this.publish({ status: 'error', message: 'Settings information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: SettingsState): void {
    if (this.disposed) return;
    this.state = state;
    this.publications++;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('SETTINGS_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    settingsModel: SettingsModel;
  }
}
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.configuration'], (scope) => {
    const model = new SettingsModel(scope);
    scope.provide('settingsModel', model);
    scope.provide('configurationActions', {
      setWorkspacePreferences: (key, input, ifMatch, generation) => {
        const state = model.getSnapshot();
        if (state.status !== 'ready' || state.baseline.generation !== generation)
          return Promise.reject(Error('WORKSPACE_SETTINGS_RETIRED'));
        return model.updateSettings(key, { workspace: input }, ifMatch);
      },
      bindWorkspacePresentation: (slot) => model.bindWorkspacePresentation(slot),
      saveWorkspacePresentation: (key, slot, input, version, generation, importRevision) =>
        model.saveWorkspacePresentation(key, slot, input, version, generation, importRevision),
      setNetworkProxy: (key, proxy, ifMatch) =>
        model.updateSettings(key, { network: { proxy } }, ifMatch),
      setFileManagerPreferences: (key, input, ifMatch) =>
        model.updateSettings(key, { fileManager: input }, ifMatch),
      getSnapshot: model.getSnapshot,
      subscribe: model.subscribe,
      retry: () => model.retry(),
      setDefaultTerminalProfile: (key, id, ifMatch) =>
        model.updateSettings(key, { terminal: { defaultProfileId: id } }, ifMatch),
      setTerminalRecoveryPreferences: (key, input, ifMatch, generation) =>
        model.setTerminalRecoveryPreferences(key, input, ifMatch, generation),
      setLegacyShortcutBindings: (key, bindings, ifMatch, generation) =>
        model.setLegacyShortcutBindings(key, bindings, ifMatch, generation),
      setMonitorPreferences: (key, input, ifMatch, generation) =>
        model.setMonitorPreferences(key, input, ifMatch, generation),
      setTerminalShortcutBarButtons: (key, buttons, ifMatch, generation) =>
        model.setTerminalShortcutBarButtons(key, buttons, ifMatch, generation),
      setTerminalVisual: (key, visual, ifMatch, generation) =>
        model.setTerminalVisual(key, visual, ifMatch, generation),
      setCommandHistoryEnabled: (key, enabled, ifMatch) =>
        model.updateSettings(key, { privacy: { commandHistoryEnabled: enabled } }, ifMatch),
      setConnectionHistoryEnabled: (key, enabled, ifMatch) =>
        model.updateSettings(key, { privacy: { connectionHistoryEnabled: enabled } }, ifMatch),
    });
    const credentials = new SavedCredentialsModel(scope);
    scope.provide('savedCredentialsModel', credentials);
    scope.provide('savedCredentialActions', {
      submitCreate: (input) => credentials.create(input),
      submitFromGrant: (input, signal) => credentials.createFromGrant(input, signal),
      submitRemove: (ref) => credentials.remove(ref),
      outcome: (id) => credentials.outcome(id),
      create: (input) => credentials.create(input).result,
      remove: (ref) => credentials.remove(ref).result,
    });
    const portable = new ConfigurationPortableModel(scope);
    scope.provide('configurationPortableModel', portable);
    const sync = new SyncModel(scope);
    scope.provide('syncModel', sync);
    scope.effect(() => () => sync.dispose());
    scope.effect(() => () => portable.dispose());
    scope.effect(() => () => credentials.dispose());
    scope.effect(() => () => model.dispose());
    installPresentationPreferences(scope, model);
    installShortcutPreferences(scope, model);
    scope.inject(['workspaceUi', 'slots', 'locale', 'theme'], async (ui) => {
      const { installSettingsUi } = await import('./ui.tsx');
      if (ui.fiber.uid !== null) installSettingsUi(ui, model, credentials, portable, sync);
    });
  });
}
