import {
  terminalVisualSettingsSchema,
  type TerminalVisualSettings,
} from '@axterm/plugin-api/terminals';
import type { TerminalVisualUi, WorkspaceTabRegistration } from '@axterm/ui/workspace';

/** Appearance is pure window state. Every preview belongs to one live tab registration. */
export class TerminalVisualOwner implements TerminalVisualUi {
  private readonly registrations = new Map<
    string,
    { registration: WorkspaceTabRegistration; previews: Map<symbol, TerminalVisualSettings> }
  >();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReturnType<TerminalVisualUi['getSnapshot']> = Object.freeze({
    revision: 0,
    previews: Object.freeze({}),
  });
  private count = 0;
  private closed = false;
  getSnapshot = (): ReturnType<TerminalVisualUi['getSnapshot']> => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  register(id: string, registration: WorkspaceTabRegistration): () => void {
    this.assertOpen();
    if (this.registrations.has(id) || this.registrations.size >= 128 || !registration.present)
      throw Error('TERMINAL_VISUAL_REGISTRATION_UNAVAILABLE');
    const owned = { registration, previews: new Map<symbol, TerminalVisualSettings>() };
    this.registrations.set(id, owned);
    return () => {
      if (this.registrations.get(id) !== owned) return;
      this.registrations.delete(id);
      this.count -= owned.previews.size;
      owned.previews.clear();
      this.changed();
    };
  }
  apply(id: string, visual: TerminalVisualSettings): void {
    this.assertOpen();
    const owned = this.registrations.get(id);
    if (!owned) throw Error('TERMINAL_VISUAL_UNAVAILABLE');
    owned.registration.present!({ terminalVisual: this.parse(visual) });
  }
  preview(id: string, visual: TerminalVisualSettings): () => void {
    this.assertOpen();
    const owned = this.registrations.get(id);
    if (!owned || this.count >= 128) throw Error('TERMINAL_VISUAL_UNAVAILABLE');
    const key = Symbol();
    owned.previews.set(key, this.parse(visual));
    this.count++;
    this.changed();
    return () => {
      if (this.registrations.get(id) !== owned || !owned.previews.delete(key)) return;
      this.count--;
      this.changed();
    };
  }
  dispose(): void {
    if (this.closed) return;
    this.registrations.clear();
    this.count = 0;
    this.changed();
    this.closed = true;
    this.listeners.clear();
  }
  private parse(value: TerminalVisualSettings): TerminalVisualSettings {
    const parsed = terminalVisualSettingsSchema.parse(value);
    Object.freeze(parsed.background);
    return Object.freeze(parsed);
  }
  private assertOpen(): void {
    if (this.closed) throw Error('TERMINAL_VISUAL_CLOSED');
  }
  private changed(): void {
    const previews: Record<string, TerminalVisualSettings> = Object.create(null) as Record<
      string,
      TerminalVisualSettings
    >;
    for (const [id, owned] of this.registrations) {
      const value = [...owned.previews.values()].at(-1);
      if (value) previews[id] = value;
    }
    this.snapshot = Object.freeze({
      revision: this.snapshot.revision + 1,
      previews: Object.freeze(previews),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_VISUAL_OBSERVER_FAILED');
      }
    }
  }
}
