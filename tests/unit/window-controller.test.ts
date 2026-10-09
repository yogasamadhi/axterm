import { describe, expect, it, vi } from 'vitest';
import {
  DesktopGlobalHotkeyUnavailableError,
  DesktopWindowController,
  DesktopWindowUnavailableError,
} from '../../apps/desktop/src/main/host-capabilities/window-controller';
import { DEFAULT_DESKTOP_WINDOW_PREFERENCES } from '../../apps/desktop/src/main/host-capabilities/window-preferences';
import type {
  DesktopWindowPreferences,
  DesktopWindowPreferencesPatch,
} from '../../packages/contracts/src/host-capabilities/desktop';

function createWindow() {
  const state = {
    minimized: false,
    maximized: false,
    fullScreen: false,
    simpleFullScreen: false,
    focused: true,
    visible: true,
    destroyed: false,
    closable: true,
    maximizable: true,
    minimizable: true,
  };
  const target = {
    close: vi.fn(() => {
      state.destroyed = true;
      state.visible = false;
    }),
    isClosable: () => state.closable,
    isDestroyed: () => state.destroyed,
    isFocused: () => state.focused,
    isFullScreen: () => state.fullScreen,
    isSimpleFullScreen: () => state.simpleFullScreen,
    isMaximizable: () => state.maximizable,
    isMaximized: () => state.maximized,
    isMinimizable: () => state.minimizable,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    maximize: vi.fn(() => {
      state.maximized = true;
      state.minimized = false;
    }),
    minimize: vi.fn(() => {
      state.minimized = true;
    }),
    setFullScreen: vi.fn((value: boolean) => {
      state.fullScreen = value;
    }),
    setSimpleFullScreen: vi.fn((value: boolean) => {
      state.simpleFullScreen = value;
    }),
    setBounds: vi.fn(),
    setOpacity: vi.fn(),
    webContents: { setZoomFactor: vi.fn() },
    unmaximize: vi.fn(() => {
      state.maximized = false;
    }),
  };
  return { state, target };
}

describe('Desktop window controller', () => {
  it('reports safe state and performs minimize/maximize toggles on the supplied window', () => {
    const { target } = createWindow();
    const controller = new DesktopWindowController(() => target);

    expect(controller.status()).toEqual({
      minimized: false,
      maximized: false,
      fullScreen: false,
      focused: true,
      visible: true,
      canMinimize: true,
      canMaximize: true,
      canClose: true,
    });
    expect(controller.perform('minimize').state.minimized).toBe(true);
    expect(target.minimize).toHaveBeenCalledOnce();
    expect(controller.perform('toggle-maximize').state.maximized).toBe(true);
    expect(target.maximize).toHaveBeenCalledOnce();
    expect(controller.perform('toggle-maximize').state.maximized).toBe(false);
    expect(target.unmaximize).toHaveBeenCalledOnce();
    expect(controller.perform('toggle-fullscreen').state.fullScreen).toBe(true);
    expect(controller.perform('toggle-fullscreen').state.fullScreen).toBe(false);
    expect(target.setFullScreen).toHaveBeenCalledTimes(2);
  });

  it('uses a state-visible simple fullscreen fallback when macOS denies native fullscreen to an unfocused window', () => {
    const { state, target } = createWindow();
    state.focused = false;
    const controller = new DesktopWindowController(() => target, { platform: 'darwin' });

    expect(controller.perform('toggle-fullscreen').state.fullScreen).toBe(true);
    expect(target.setSimpleFullScreen).toHaveBeenCalledWith(true);
    expect(target.setFullScreen).not.toHaveBeenCalled();
    expect(controller.perform('toggle-fullscreen').state.fullScreen).toBe(false);
    expect(target.setSimpleFullScreen).toHaveBeenLastCalledWith(false);
  });

  it('accepts close before scheduling it and refuses absent or destroyed windows', async () => {
    const { state, target } = createWindow();
    const approveClose = vi.fn();
    const controller = new DesktopWindowController(() => target, { approveClose });

    expect(controller.perform('close')).toMatchObject({ accepted: true });
    expect(target.close).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(approveClose).toHaveBeenCalledOnce();
    expect(approveClose).toHaveBeenCalledWith(target);
    expect(target.close).toHaveBeenCalledOnce();
    expect(state.destroyed).toBe(true);
    expect(() => controller.status()).toThrow(DesktopWindowUnavailableError);
    expect(() => new DesktopWindowController(() => undefined).status()).toThrow(
      DesktopWindowUnavailableError,
    );
  });

  it('does not invoke a platform action when Electron reports it unavailable', () => {
    const { state, target } = createWindow();
    state.minimizable = false;
    state.maximizable = false;
    state.closable = false;
    const controller = new DesktopWindowController(() => target);

    expect(() => controller.perform('minimize')).toThrow(DesktopWindowUnavailableError);
    expect(() => controller.perform('toggle-maximize')).toThrow(DesktopWindowUnavailableError);
    expect(() => controller.perform('close')).toThrow(DesktopWindowUnavailableError);
    expect(target.minimize).not.toHaveBeenCalled();
    expect(target.maximize).not.toHaveBeenCalled();
    expect(target.close).not.toHaveBeenCalled();
  });

  it('applies live preferences, corrects bounds, and reports title-bar restart state', async () => {
    const { target } = createWindow();
    let appliedTitleBarStyle: 'custom' | 'system' = 'custom';
    let preferences: DesktopWindowPreferences = { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES };
    const store = {
      get: () => ({ ...preferences }),
      update: vi.fn(async (patch: DesktopWindowPreferencesPatch) => {
        preferences = {
          titleBarStyle: patch.titleBarStyle ?? preferences.titleBarStyle,
          opacity: patch.opacity ?? preferences.opacity,
          zoomFactor: patch.zoomFactor ?? preferences.zoomFactor,
          bounds: patch.bounds === undefined ? preferences.bounds : patch.bounds,
          globalHotkey: patch.globalHotkey ?? preferences.globalHotkey,
          allowMultiInstance: patch.allowMultiInstance ?? preferences.allowMultiInstance,
          confirmBeforeExit: patch.confirmBeforeExit ?? preferences.confirmBeforeExit,
        };
        return { ...preferences };
      }),
    };
    const controller = new DesktopWindowController(() => target, {
      preferences: store,
      getAppliedTitleBarStyle: () => appliedTitleBarStyle,
      getDisplayLayout: () => ({
        displays: [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
        primary: { workArea: { x: 0, y: 0, width: 1440, height: 900 } },
      }),
    });

    expect(controller.preferences().requiresRestart).toBe(false);
    const result = await controller.updatePreferences({
      titleBarStyle: 'system',
      opacity: 0.75,
      zoomFactor: 1.5,
      bounds: { x: 9000, y: 9000, width: 1000, height: 700 },
    });
    expect(result).toEqual({
      preferences: {
        titleBarStyle: 'system',
        opacity: 0.75,
        zoomFactor: 1.5,
        bounds: { x: 220, y: 100, width: 1000, height: 700 },
        globalHotkey: 'Control+2',
        allowMultiInstance: false,
        confirmBeforeExit: false,
      },
      requiresRestart: true,
      globalHotkeyRegistered: false,
    });
    expect(target.setOpacity).toHaveBeenCalledWith(0.75);
    expect(target.webContents.setZoomFactor).toHaveBeenCalledWith(1.5);
    expect(target.setBounds).toHaveBeenCalledWith({
      x: 220,
      y: 100,
      width: 1000,
      height: 700,
    });

    appliedTitleBarStyle = 'system';
    expect(controller.preferences().requiresRestart).toBe(false);
  });

  it('updates global hotkeys before persistence and rolls back registration failures', async () => {
    const { target } = createWindow();
    let preferences: DesktopWindowPreferences = { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES };
    let registered = 'Control+2';
    const globalHotkey = {
      update: vi.fn((value: string) => {
        if (value === 'Control+9') return false;
        registered = value;
        return true;
      }),
      isRegistered: (value: string) => value === registered,
      close: vi.fn(),
    };
    const controller = new DesktopWindowController(() => target, {
      globalHotkey,
      preferences: {
        get: () => ({ ...preferences }),
        update: async (patch) => {
          preferences = {
            titleBarStyle: patch.titleBarStyle ?? preferences.titleBarStyle,
            opacity: patch.opacity ?? preferences.opacity,
            zoomFactor: patch.zoomFactor ?? preferences.zoomFactor,
            bounds: patch.bounds === undefined ? preferences.bounds : patch.bounds,
            globalHotkey: patch.globalHotkey ?? preferences.globalHotkey,
            allowMultiInstance: patch.allowMultiInstance ?? preferences.allowMultiInstance,
            confirmBeforeExit: patch.confirmBeforeExit ?? preferences.confirmBeforeExit,
          };
          return { ...preferences };
        },
      },
    });

    await expect(
      controller.updatePreferences({ globalHotkey: 'Control+8' }),
    ).resolves.toMatchObject({
      preferences: { globalHotkey: 'Control+8' },
      globalHotkeyRegistered: true,
    });
    await expect(controller.updatePreferences({ globalHotkey: 'Control+9' })).rejects.toThrow(
      DesktopGlobalHotkeyUnavailableError,
    );
    expect(preferences.globalHotkey).toBe('Control+8');
    expect(registered).toBe('Control+8');
  });

  it('reports a restart while the persisted multi-instance policy differs from launch', async () => {
    const { target } = createWindow();
    let preferences: DesktopWindowPreferences = { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES };
    const controller = new DesktopWindowController(() => target, {
      getAppliedAllowMultiInstance: () => false,
      preferences: {
        get: () => ({ ...preferences }),
        update: async (patch) => {
          preferences = { ...preferences, ...patch } as DesktopWindowPreferences;
          return { ...preferences };
        },
      },
    });

    expect((await controller.updatePreferences({ allowMultiInstance: true })).requiresRestart).toBe(
      true,
    );
    expect((await controller.updatePreferences({ confirmBeforeExit: true })).requiresRestart).toBe(
      true,
    );
    expect(
      (await controller.updatePreferences({ allowMultiInstance: false })).requiresRestart,
    ).toBe(false);
  });
});
