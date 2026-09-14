import type { BrowserWindow } from 'electron';
import {
  desktopWindowActionResultSchema,
  desktopWindowPreferencesResultSchema,
  desktopWindowStateSchema,
  type DesktopWindowAction,
  type DesktopWindowActionResult,
  type DesktopWindowPreferences,
  type DesktopWindowPreferencesPatch,
  type DesktopWindowPreferencesResult,
  type DesktopWindowState,
} from '@workspace/contracts/desktop';
import {
  correctWindowBounds,
  type DesktopDisplayLayout,
  type WindowPreferencesPort,
} from './window-preferences';
import type { GlobalHotkeyRegistrationPort } from './global-hotkey-controller';

type ControlledWindow = Pick<
  BrowserWindow,
  | 'close'
  | 'isClosable'
  | 'isDestroyed'
  | 'isFocused'
  | 'isFullScreen'
  | 'isMaximizable'
  | 'isMaximized'
  | 'isMinimizable'
  | 'isMinimized'
  | 'isVisible'
  | 'maximize'
  | 'minimize'
  | 'setFullScreen'
  | 'unmaximize'
> &
  Partial<
    Pick<BrowserWindow, 'isSimpleFullScreen' | 'setBounds' | 'setOpacity' | 'setSimpleFullScreen'>
  > & {
    webContents?: Pick<BrowserWindow['webContents'], 'setZoomFactor'>;
  };

interface DesktopWindowControllerOptions {
  platform?: NodeJS.Platform;
  preferences?: WindowPreferencesPort;
  getDisplayLayout?: () => DesktopDisplayLayout;
  getAppliedTitleBarStyle?: () => DesktopWindowPreferences['titleBarStyle'] | undefined;
  getAppliedAllowMultiInstance?: () => boolean | undefined;
  globalHotkey?: GlobalHotkeyRegistrationPort;
}

export class DesktopWindowUnavailableError extends Error {
  constructor() {
    super('Desktop window is unavailable');
  }
}

export class DesktopGlobalHotkeyUnavailableError extends Error {
  constructor() {
    super('The requested global hotkey could not be registered');
  }
}

/** Controls only the current Axterm window supplied by Electron Main. */
export class DesktopWindowController {
  constructor(
    private readonly getWindow: () => ControlledWindow | undefined,
    private readonly options: DesktopWindowControllerOptions = {},
  ) {}

  status(): DesktopWindowState {
    return desktopWindowStateSchema.parse(readState(this.requireWindow()));
  }

  perform(action: DesktopWindowAction): DesktopWindowActionResult {
    const target = this.requireWindow();
    if (action === 'minimize') {
      if (!target.isMinimizable()) throw new DesktopWindowUnavailableError();
      target.minimize();
    } else if (action === 'toggle-maximize') {
      if (!target.isMaximizable()) throw new DesktopWindowUnavailableError();
      if (target.isMaximized()) target.unmaximize();
      else target.maximize();
    } else if (action === 'toggle-fullscreen') {
      const nativeFullScreen = target.isFullScreen();
      const simpleFullScreen = target.isSimpleFullScreen?.() ?? false;
      if (simpleFullScreen) target.setSimpleFullScreen?.(false);
      else if (nativeFullScreen) target.setFullScreen(false);
      else if (
        (this.options.platform ?? process.platform) === 'darwin' &&
        !target.isFocused() &&
        target.setSimpleFullScreen
      )
        target.setSimpleFullScreen(true);
      else target.setFullScreen(true);
    } else {
      if (!target.isClosable()) throw new DesktopWindowUnavailableError();
      // Let the HTTP handler flush its accepted response before closing Renderer.
      setImmediate(() => {
        if (!target.isDestroyed()) target.close();
      });
    }
    return desktopWindowActionResultSchema.parse({ accepted: true, state: readState(target) });
  }

  preferences(): DesktopWindowPreferencesResult {
    const preferences = this.requirePreferences().get();
    return desktopWindowPreferencesResultSchema.parse({
      preferences,
      requiresRestart: this.requiresRestart(preferences),
      globalHotkeyRegistered:
        !!preferences.globalHotkey &&
        !!this.options.globalHotkey?.isRegistered(preferences.globalHotkey),
    });
  }

  async updatePreferences(
    input: DesktopWindowPreferencesPatch,
  ): Promise<DesktopWindowPreferencesResult> {
    const target = this.getAvailableWindow();
    const patch =
      input.bounds && this.options.getDisplayLayout
        ? {
            ...input,
            bounds: correctWindowBounds(input.bounds, this.options.getDisplayLayout()),
          }
        : input;
    const store = this.requirePreferences();
    const previous = store.get();
    const hotkeyChanged =
      patch.globalHotkey !== undefined && patch.globalHotkey !== previous.globalHotkey;
    if (hotkeyChanged && !this.options.globalHotkey?.update(patch.globalHotkey!))
      throw new DesktopGlobalHotkeyUnavailableError();
    let preferences: DesktopWindowPreferences;
    try {
      preferences = await store.update(patch);
    } catch (error) {
      if (hotkeyChanged) this.options.globalHotkey?.update(previous.globalHotkey);
      throw error;
    }
    if (target) {
      if (input.opacity !== undefined) target.setOpacity?.(preferences.opacity);
      if (input.zoomFactor !== undefined) target.webContents?.setZoomFactor(preferences.zoomFactor);
      if (input.bounds !== undefined && preferences.bounds) target.setBounds?.(preferences.bounds);
    }
    return desktopWindowPreferencesResultSchema.parse({
      preferences,
      requiresRestart: this.requiresRestart(preferences),
      globalHotkeyRegistered:
        !!preferences.globalHotkey &&
        !!this.options.globalHotkey?.isRegistered(preferences.globalHotkey),
    });
  }

  private requireWindow(): ControlledWindow {
    const target = this.getAvailableWindow();
    if (!target) throw new DesktopWindowUnavailableError();
    return target;
  }

  private getAvailableWindow(): ControlledWindow | undefined {
    const target = this.getWindow();
    return !target || target.isDestroyed() ? undefined : target;
  }

  private requirePreferences(): WindowPreferencesPort {
    if (!this.options.preferences) throw new DesktopWindowUnavailableError();
    return this.options.preferences;
  }

  private requiresRestart(preferences: DesktopWindowPreferences): boolean {
    if (!this.getAvailableWindow()) return false;
    const titleBar = this.options.getAppliedTitleBarStyle?.();
    const multiInstance = this.options.getAppliedAllowMultiInstance?.();
    return (
      (titleBar !== undefined && titleBar !== preferences.titleBarStyle) ||
      (multiInstance !== undefined && multiInstance !== preferences.allowMultiInstance)
    );
  }
}

function readState(target: ControlledWindow): DesktopWindowState {
  return {
    minimized: target.isMinimized(),
    maximized: target.isMaximized(),
    fullScreen: target.isFullScreen() || (target.isSimpleFullScreen?.() ?? false),
    focused: target.isFocused(),
    visible: target.isVisible(),
    canMinimize: target.isMinimizable(),
    canMaximize: target.isMaximizable(),
    canClose: target.isClosable(),
  };
}
