import { desktopWindowFullscreen } from './fullscreen.ts';
import { GlobalHotkeyController } from './global-hotkey-controller.ts';
import type { BrowserWindow } from 'electron';
import {
  DEFAULT_DESKTOP_WINDOW_PREFERENCES,
  desktopWindowPreferenceRecordSchema,
  desktopWindowBoundsSchema,
} from '@axterm/infra-desktop-native';
import type {
  DesktopWindowPreferences,
  DesktopWindowPreferenceRecord,
  DesktopWindowBounds,
  NativeDesktopWindowState,
} from '@axterm/infra-desktop-native';

export const DEFAULT_DESKTOP_WINDOW_SIZE = Object.freeze({ width: 1440, height: 900 });

interface NativePreferencePorts {
  windows(): readonly BrowserWindow[];
  focused(): BrowserWindow | undefined;
  hotkeys: {
    register(key: string, run: () => void): boolean;
    unregister(key: string): void;
    isRegistered(key: string): boolean;
  };
  displays(): { primary: DesktopWindowBounds; areas: readonly DesktopWindowBounds[] };
  activate(toggle: boolean): void;
  initialized(): void;
}
/** Same display correction as the frozen Shell owner; never persists a Shell JSON file. */
export function correctWindowBounds(
  saved: DesktopWindowBounds,
  layout: { primary: DesktopWindowBounds; areas: readonly DesktopWindowBounds[] },
): DesktopWindowBounds {
  const checked = desktopWindowBoundsSchema.parse(saved),
    areas = layout.areas.length ? layout.areas : [layout.primary];
  const center = {
    x: checked.x + Math.floor(checked.width / 2),
    y: checked.y + Math.floor(checked.height / 2),
  };
  const centered = areas.find(
    (area) =>
      center.x >= area.x &&
      center.x < area.x + area.width &&
      center.y >= area.y &&
      center.y < area.y + area.height,
  );
  const intersecting = areas
    .map((area) => ({
      area,
      size:
        Math.max(
          0,
          Math.min(checked.x + checked.width, area.x + area.width) - Math.max(checked.x, area.x),
        ) *
        Math.max(
          0,
          Math.min(checked.y + checked.height, area.y + area.height) - Math.max(checked.y, area.y),
        ),
    }))
    .sort((a, b) => b.size - a.size)[0];
  const target =
    centered ?? (intersecting && intersecting.size > 0 ? intersecting.area : layout.primary);
  const width = Math.min(Math.max(checked.width, Math.min(800, target.width)), target.width),
    height = Math.min(Math.max(checked.height, Math.min(580, target.height)), target.height);
  const disconnected = !centered && (!intersecting || intersecting.size === 0),
    clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  return desktopWindowBoundsSchema.parse({
    width,
    height,
    x: disconnected
      ? target.x + Math.floor((target.width - width) / 2)
      : clamp(checked.x, target.x, target.x + target.width - width),
    y: disconnected
      ? target.y + Math.floor((target.height - height) / 2)
      : clamp(checked.y, target.y, target.y + target.height - height),
  });
}
export class ShellWindowPreferences {
  private record: DesktopWindowPreferenceRecord = {
    version: 0,
    preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES },
  };
  private appliedVersion = -1;
  private readonly styles = new WeakMap<BrowserWindow, DesktopWindowPreferences['titleBarStyle']>();
  private hotkey: GlobalHotkeyController;
  private closed = false;
  private recording = false;
  constructor(private readonly ports: NativePreferencePorts) {
    this.hotkey = this.createHotkey();
  }
  private createHotkey(): GlobalHotkeyController {
    return new GlobalHotkeyController(
      this.ports.hotkeys,
      () => undefined,
      () => {
        if (!this.closed && !this.recording) this.ports.activate(true);
      },
    );
  }
  beginGeneration(): void {
    if (this.closed) {
      this.hotkey.close();
      this.hotkey = this.createHotkey();
    }
    this.closed = false;
    this.appliedVersion = -1;
    this.recording = false;
  }
  setRecording(active: boolean): void {
    this.recording = active;
    if (this.closed) return;
    if (active) this.hotkey.update('');
    else this.registerHotkey();
  }
  private registerHotkey(): void {
    if (!this.recording) this.hotkey.update(this.record.preferences.globalHotkey);
  }
  get preferences(): Readonly<DesktopWindowPreferences> {
    return this.record.preferences;
  }
  creation(): DesktopWindowPreferences {
    const preferences = structuredClone(this.record.preferences);
    preferences.bounds =
      preferences.rememberWindowSize && preferences.bounds
        ? correctWindowBounds(preferences.bounds, this.ports.displays())
        : null;
    return preferences;
  }
  attach(window: BrowserWindow): void {
    this.styles.set(window, this.record.preferences.titleBarStyle);
    window.webContents.setZoomFactor(this.record.preferences.zoomFactor);
  }
  async configure(
    input: DesktopWindowPreferenceRecord,
    signal: AbortSignal,
    applyBounds = false,
  ): Promise<NativeDesktopWindowState> {
    signal.throwIfAborted();
    if (this.closed) throw Error('WINDOW_PREFERENCES_CLOSED');
    const next = desktopWindowPreferenceRecordSchema.parse(input);
    if (next.version < this.appliedVersion) return this.state(signal);
    if (
      next.version === this.appliedVersion &&
      JSON.stringify(next) !== JSON.stringify(this.record)
    )
      throw Error('WINDOW_PREFERENCES_VERSION_CONFLICT');
    const changed = next.version !== this.appliedVersion;
    this.record = next;
    this.registerHotkey();
    if (changed)
      for (const window of this.ports.windows()) {
        if (window.isDestroyed()) continue;
        window.setOpacity(next.preferences.opacity);
        window.webContents.setZoomFactor(next.preferences.zoomFactor);
        if (
          applyBounds &&
          next.preferences.bounds &&
          JSON.stringify(next.preferences.bounds) !== JSON.stringify(window.getNormalBounds())
        )
          window.setBounds(correctWindowBounds(next.preferences.bounds, this.ports.displays()));
      }
    this.appliedVersion = next.version;
    this.ports.initialized();
    return this.state(signal);
  }
  async state(signal: AbortSignal): Promise<NativeDesktopWindowState> {
    signal.throwIfAborted();
    if (this.closed) throw Error('WINDOW_PREFERENCES_CLOSED');
    const windows = this.ports.windows().filter((window) => !window.isDestroyed()),
      focused = this.ports.focused(),
      target = focused && windows.includes(focused) ? focused : windows[0];
    return {
      appliedVersion: this.appliedVersion,
      globalHotkeyRegistered: this.hotkey.isRegistered(this.record.preferences.globalHotkey),
      requiresRestart: windows.some(
        (window) => this.styles.get(window) !== this.record.preferences.titleBarStyle,
      ),
      bounds:
        target && !target.isDestroyed() && !desktopWindowFullscreen(target) && !target.isMaximized()
          ? desktopWindowBoundsSchema.parse(target.getNormalBounds())
          : null,
    };
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.hotkey.close();
  }
}
