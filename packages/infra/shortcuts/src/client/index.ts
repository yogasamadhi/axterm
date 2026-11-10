import { installShortcutSettings } from './ui.tsx';
import { ShortcutReferences } from './references.ts';
// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/shortcuts/src/client/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
// Axterm owns durable preferences through the accepted Configuration model, never browser storage.
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/ui/presentation';
import type { Shortcuts, ShortcutFixedInput, ShortcutPreferencePort } from '@axterm/ui/shortcuts';
import {
  ShortcutPersistence,
  bindingIssue,
  normalizeBinding,
  overlappingBindings,
  presentBinding,
  initialShortcutConfig,
} from '@axterm/plugin-api/shortcuts';
import type { AxtermKeyboardApi } from '@axterm/plugin-api/shortcuts';
import { ShortcutRegistry } from './registry.ts';
import { detectEnvironment, installKeyboard } from './dom.ts';
import { installNativeKeyboard } from './native.ts';
export const inject = ['locale'];
type PreferenceOwner = {
  port: ShortcutPreferencePort;
  persistence: ShortcutPersistence;
  off(): void;
  generation: string | undefined;
  raw: string | null | undefined;
  hydrating: boolean;
};
export class ShortcutsService implements Shortcuts {
  readonly runtime: Shortcuts['runtime'];
  readonly platform: Shortcuts['platform'];
  readonly catalog: Shortcuts['catalog'];
  readonly config: Shortcuts['config'];
  readonly fixedCatalog: Shortcuts['fixedCatalog'];
  readonly stopSequenceMs = 1000;
  private readonly registry: ShortcutRegistry;
  private readonly references = new ShortcutReferences();
  private readonly keyboard: AxtermKeyboardApi | undefined;
  private readonly fixedListeners = new Set<(input: ShortcutFixedInput) => void>();
  private owner: PreferenceOwner | undefined;
  private readonly operations = new Set<Promise<unknown>>();
  private nativeQueue: Promise<void> = Promise.resolve();
  private readonly disposers: (() => void)[] = [];
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(ctx: Context) {
    const environment = detectEnvironment(document, navigator);
    this.runtime = environment.runtime;
    this.platform = environment.platform;
    this.keyboard = (
      window as Window & { axtermDesktopKeyboard?: AxtermKeyboardApi }
    ).axtermDesktopKeyboard;
    if (this.runtime === 'desktop' && !this.keyboard) throw Error('DESKTOP_KEYBOARD_UNAVAILABLE');
    this.registry = new ShortcutRegistry(this.runtime, this.platform, initialShortcutConfig());
    this.catalog = this.registry.catalog;
    this.config = this.registry.config;
    this.fixedCatalog = this.registry.fixedCatalog;
    if (this.keyboard)
      this.disposers.push(
        installNativeKeyboard(
          window,
          this.keyboard,
          this.registry,
          () => this.config.getSnapshot(),
          () => this.fixedInput({ type: 'reset' }),
        ),
      );
    this.disposers.push(
      installKeyboard(
        window,
        this.registry,
        (input) => this.fixedInput(input),
        !!this.keyboard && (this.platform === 'macos' || this.platform === 'windows'),
      ),
    );
    this.disposers.push(ctx.locale.subscribe(() => this.registry.refreshLabels()));
  }
  private fixedInput(input: ShortcutFixedInput): void {
    let consumed = false;
    for (const listener of [...this.fixedListeners]) {
      if (!this.fixedListeners.has(listener)) continue;
      try {
        listener(
          input.type === 'reset'
            ? input
            : {
                ...input,
                gesture: {
                  ...input.gesture,
                  defaultPrevented: input.gesture.defaultPrevented || consumed,
                },
                consume: () => {
                  consumed = true;
                  input.consume();
                },
              },
        );
      } catch {
        console.warn('SHORTCUT_FIXED_HANDLER_FAILED');
      }
    }
  }
  register(command: Parameters<Shortcuts['register']>[0]): () => void {
    this.assertOpen();
    const off = this.registry.register(command);
    this.syncDefinitions();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      off();
      this.syncDefinitions();
    };
  }
  resolveCommand(
    ...args: Parameters<Shortcuts['resolveCommand']>
  ): ReturnType<Shortcuts['resolveCommand']> {
    this.assertOpen();
    return this.registry.resolveCommand(...args);
  }
  registerFixed(command: Parameters<Shortcuts['registerFixed']>[0]): () => void {
    this.assertOpen();
    const off = this.registry.registerFixed(command);
    this.syncDefinitions();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      off();
      this.syncDefinitions();
    };
  }
  observeFixedInput(listener: (input: ShortcutFixedInput) => void): () => void {
    this.assertOpen();
    if (this.fixedListeners.size >= 512) throw Error('SHORTCUT_CAPACITY');
    this.fixedListeners.add(listener);
    return () => {
      this.fixedListeners.delete(listener);
    };
  }
  registerConflictSource(source: Parameters<Shortcuts['registerConflictSource']>[0]): () => void {
    this.assertOpen();
    return this.references.register(source);
  }
  describeBinding(
    binding: Parameters<Shortcuts['describeBinding']>[0],
  ): ReturnType<Shortcuts['describeBinding']> {
    const normalized = binding === null ? null : normalizeBinding(binding, this.platform);
    const owners =
      normalized === null
        ? []
        : this.catalog
            .getSnapshot()
            .filter((row) => row.binding !== null && overlappingBindings(row.binding, normalized))
            .map((row) => row.id);
    const references = normalized === null ? [] : this.references.describe(normalized, owners);
    return {
      referenceLabels: Object.fromEntries(references.map((row) => [row.id, row.label])),
      binding: normalized,
      keys: presentBinding(normalized, this.platform).keys,
      issue: normalized === null ? null : bindingIssue(normalized, this.runtime, this.platform),
      conflicts:
        normalized === null
          ? []
          : [
              ...owners,
              ...references.map((row) => row.id),
              ...this.fixedCatalog
                .getSnapshot()
                .filter((row) =>
                  row.bindings.some((binding) => overlappingBindings(binding, normalized)),
                )
                .map((row) => row.id),
            ],
    };
  }
  attachPreference(port: ShortcutPreferencePort): () => Promise<void> {
    this.assertOpen();
    if (this.owner) throw Error('SHORTCUT_PREFERENCE_OWNER_EXISTS');
    const owner: PreferenceOwner = {
      port,
      off: () => {},
      generation: undefined,
      raw: undefined,
      hydrating: true,
      persistence: new ShortcutPersistence(
        {
          read: () => {
            const state = port.getSnapshot();
            if (!state.available || !state.generation || state.generation !== owner.generation)
              throw Error('SHORTCUT_PREFERENCE_UNAVAILABLE');
            return state.raw;
          },
          write: (raw, edit) => {
            const state = port.getSnapshot();
            if (!state.available || !state.generation || state.generation !== owner.generation)
              throw Error('SHORTCUT_PREFERENCE_RETIRED');
            return port.write(raw, state.generation, edit);
          },
        },
        this.runtime,
        this.platform,
        true,
        (snapshot) => {
          if (this.owner === owner && !owner.hydrating && !this.closed) {
            this.registry.configure(snapshot);
            this.publishNative();
          }
        },
      ),
    };
    this.owner = owner;
    const refresh = () => {
      if (this.owner !== owner || this.closed) return;
      const state = port.getSnapshot();
      if (!state.available || !state.generation) {
        owner.hydrating = true;
        owner.generation = undefined;
        owner.raw = undefined;
        this.registry.configure(initialShortcutConfig());
        this.publishNative();
        return;
      }
      if (owner.generation === state.generation && owner.raw === state.raw) return;
      const changedGeneration = owner.generation !== state.generation;
      owner.generation = state.generation;
      owner.raw = state.raw;
      if (changedGeneration) {
        owner.hydrating = true;
        this.registry.configure(initialShortcutConfig());
        owner.persistence.setDefinitions(this.registry.definitions());
      }
      const generation = state.generation;
      this.track(
        owner.persistence.readCurrent().then((snapshot) => {
          if (!this.closed && this.owner === owner && owner.generation === generation) {
            owner.hydrating = false;
            this.registry.configure(snapshot);
            this.publishNative();
          }
        }),
      );
    };
    owner.off = port.subscribe(refresh);
    owner.persistence.setDefinitions(this.registry.definitions());
    refresh();
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      owner.off();
      if (this.owner === owner) this.owner = undefined;
      owner.persistence.dispose();
      this.registry.configure(initialShortcutConfig());
      this.publishNative();
      await owner.persistence.close();
      await this.nativeQueue;
    };
  }
  private syncDefinitions(): void {
    if (!this.closed) this.owner?.persistence.setDefinitions(this.registry.definitions());
  }
  private publishNative(): void {
    const keyboard = this.keyboard;
    if (!keyboard) return;
    const snapshot = this.config.getSnapshot(),
      definitions = this.registry.definitions(),
      generation = this.owner?.generation;
    this.nativeQueue = this.nativeQueue
      .catch(() => {})
      .then(async () => {
        if (this.closed || !generation || snapshot.status === 'loading') {
          await keyboard.clear();
          return;
        }
        await keyboard.configure(generation, definitions, snapshot);
      });
    void this.nativeQueue.catch(() => {
      if (!this.closed) console.warn('SHORTCUT_NATIVE_SYNC_FAILED');
    });
  }
  async edit(...args: Parameters<Shortcuts['edit']>): ReturnType<Shortcuts['edit']> {
    this.assertOpen();
    const [edit] = args;
    if (edit.type === 'set' && edit.binding) {
      const described = this.describeBinding(edit.binding);
      const references = Object.keys(described.referenceLabels ?? {}) as Parameters<
        Shortcuts['resolveCommand']
      >[0][];
      if (references.length)
        return { status: 'conflict', snapshot: this.config.getSnapshot(), conflicts: references };
    }
    const owner = this.owner;
    if (!owner) return { status: 'not-ready', snapshot: this.config.getSnapshot() };
    if (this.operations.size >= 32)
      return { status: 'not-ready', snapshot: this.config.getSnapshot() };
    const result = await this.track(owner.persistence.edit(...args));
    await this.nativeQueue;
    return result;
  }
  async recording(active: boolean): Promise<void> {
    this.assertOpen();
    if (this.keyboard) await this.track(this.keyboard.recording(active));
  }
  async closeWindow(): Promise<void> {
    this.assertOpen();
    if (!this.keyboard) throw Error('DESKTOP_KEYBOARD_UNAVAILABLE');
    await this.track(this.keyboard.closeWindow(this.config.getSnapshot().revision));
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      for (const off of this.disposers.splice(0).reverse()) off();
      this.fixedListeners.clear();
      this.references.close();
      const owner = this.owner;
      this.owner = undefined;
      owner?.off();
      owner?.persistence.dispose();
      await Promise.allSettled([...this.operations]);
      await owner?.persistence.close();
      await this.nativeQueue.catch(() => {});
      await this.keyboard?.clear();
    })());
  }
  private assertOpen(): void {
    if (this.closed) throw Error('SHORTCUTS_CLOSED');
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.operations.add(task);
    void task.then(
      () => this.operations.delete(task),
      () => this.operations.delete(task),
    );
    return task;
  }
}
export function apply(ctx: Context): void {
  const service = new ShortcutsService(ctx);
  installShortcutSettings(ctx, service);
  ctx.provide('shortcuts', service);
  ctx.effect(() => () => service.close());
}
