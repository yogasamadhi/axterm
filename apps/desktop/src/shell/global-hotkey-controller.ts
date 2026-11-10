import type { BrowserWindow, globalShortcut } from 'electron';

type GlobalShortcutPort = Pick<typeof globalShortcut, 'isRegistered' | 'register' | 'unregister'>;
type GlobalHotkeyWindow = Pick<
  BrowserWindow,
  | 'focus'
  | 'isDestroyed'
  | 'isFocused'
  | 'isMinimizable'
  | 'isMinimized'
  | 'minimize'
  | 'restore'
  | 'show'
>;

export interface GlobalHotkeyRegistrationPort {
  update(accelerator: string): boolean;
  isRegistered(accelerator: string): boolean;
  close(): void;
}

/** Owns the single application visibility accelerator and releases it deterministically. */
export class GlobalHotkeyController implements GlobalHotkeyRegistrationPort {
  private accelerator = '';
  private closed = false;

  constructor(
    private readonly shortcuts: GlobalShortcutPort,
    private readonly getWindow: () => GlobalHotkeyWindow | undefined,
    private readonly activate?: () => void,
  ) {}

  update(requestedAccelerator: string): boolean {
    if (this.closed) return false;
    const next = requestedAccelerator.trim();
    if (next === this.accelerator)
      return !next || this.shortcuts.isRegistered(next) || this.register(next);
    if (next && !this.register(next)) return false;
    if (this.accelerator) this.shortcuts.unregister(this.accelerator);
    this.accelerator = next;
    return true;
  }

  isRegistered(accelerator: string): boolean {
    const requested = accelerator.trim();
    return (
      !this.closed &&
      !!requested &&
      requested === this.accelerator &&
      this.shortcuts.isRegistered(requested)
    );
  }

  close(): void {
    this.closed = true;
    if (this.accelerator) this.shortcuts.unregister(this.accelerator);
    this.accelerator = '';
  }

  private register(accelerator: string): boolean {
    try {
      return this.shortcuts.register(accelerator, () => {
        if (!this.closed && this.accelerator === accelerator) this.toggleWindow();
      });
    } catch {
      return false;
    }
  }

  private toggleWindow(): void {
    if (this.activate) {
      this.activate();
      return;
    }
    toggleGlobalHotkeyWindow(this.getWindow());
  }
}

export function toggleGlobalHotkeyWindow(target: GlobalHotkeyWindow | undefined): void {
  if (!target || target.isDestroyed()) return;
  if (target.isFocused() && target.isMinimizable()) {
    target.minimize();
    return;
  }
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

export function selectGlobalHotkeyWindow<Window extends GlobalHotkeyWindow>(
  windows: Iterable<Window>,
  focused: Window | null | undefined,
): Window | undefined {
  const owned = [...windows].filter((window) => !window.isDestroyed());
  return focused && owned.includes(focused) ? focused : owned[0];
}
