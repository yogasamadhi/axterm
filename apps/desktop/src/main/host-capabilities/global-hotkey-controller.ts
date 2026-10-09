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

  constructor(
    private readonly shortcuts: GlobalShortcutPort,
    private readonly getWindow: () => GlobalHotkeyWindow | undefined,
  ) {}

  update(requestedAccelerator: string): boolean {
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
    return !!requested && requested === this.accelerator && this.shortcuts.isRegistered(requested);
  }

  close(): void {
    if (this.accelerator) this.shortcuts.unregister(this.accelerator);
    this.accelerator = '';
  }

  private register(accelerator: string): boolean {
    try {
      return this.shortcuts.register(accelerator, () => this.toggleWindow());
    } catch {
      return false;
    }
  }

  private toggleWindow(): void {
    const target = this.getWindow();
    if (!target || target.isDestroyed()) return;
    if (target.isFocused() && target.isMinimizable()) {
      target.minimize();
      return;
    }
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  }
}
