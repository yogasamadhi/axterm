import { describe, expect, it, vi } from 'vitest';
import {
  GlobalHotkeyController,
  selectGlobalHotkeyWindow,
  toggleGlobalHotkeyWindow,
} from '../../apps/desktop/src/shell/global-hotkey-controller.ts';

function createHarness() {
  const callbacks = new Map<string, () => void>();
  const blocked = new Set<string>();
  const shortcuts = {
    isRegistered: vi.fn((accelerator: string) => callbacks.has(accelerator)),
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (blocked.has(accelerator) || callbacks.has(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      callbacks.delete(accelerator);
    }),
  };
  const state = { destroyed: false, focused: true, minimized: false };
  const target = {
    focus: vi.fn(() => {
      state.focused = true;
    }),
    isDestroyed: () => state.destroyed,
    isFocused: () => state.focused,
    isMinimizable: () => true,
    isMinimized: () => state.minimized,
    minimize: vi.fn(() => {
      state.focused = false;
      state.minimized = true;
    }),
    restore: vi.fn(() => {
      state.minimized = false;
    }),
    show: vi.fn(),
  };
  const controller = new GlobalHotkeyController(shortcuts, () => target);
  return { blocked, callbacks, controller, shortcuts, state, target };
}

describe('GlobalHotkeyController', () => {
  it('toggles the current window and releases the accelerator on close', () => {
    const { callbacks, controller, shortcuts, state, target } = createHarness();

    expect(controller.update(' Control+2 ')).toBe(true);
    expect(controller.isRegistered('Control+2')).toBe(true);
    callbacks.get('Control+2')?.();
    expect(target.minimize).toHaveBeenCalledOnce();

    state.focused = false;
    state.minimized = true;
    callbacks.get('Control+2')?.();
    expect(target.restore).toHaveBeenCalledOnce();
    expect(target.show).toHaveBeenCalledOnce();
    expect(target.focus).toHaveBeenCalledOnce();

    controller.close();
    expect(shortcuts.unregister).toHaveBeenCalledWith('Control+2');
    expect(controller.isRegistered('Control+2')).toBe(false);
  });

  it('keeps the old accelerator when replacement registration fails and supports disabling', () => {
    const { blocked, callbacks, controller, shortcuts } = createHarness();
    expect(controller.update('Control+2')).toBe(true);
    blocked.add('Alt+Shift+F10');

    expect(controller.update('Alt+Shift+F10')).toBe(false);
    expect(controller.isRegistered('Control+2')).toBe(true);
    expect(callbacks.has('Alt+Shift+F10')).toBe(false);
    expect(shortcuts.unregister).not.toHaveBeenCalled();

    expect(controller.update('')).toBe(true);
    expect(shortcuts.unregister).toHaveBeenCalledWith('Control+2');
    expect(callbacks.size).toBe(0);
  });

  it('treats registration exceptions and destroyed windows as unavailable without side effects', () => {
    const { callbacks, controller, shortcuts, state, target } = createHarness();
    shortcuts.register.mockImplementationOnce(() => {
      throw new Error('platform registration failed');
    });
    expect(controller.update('Control+2')).toBe(false);

    expect(controller.update('Alt+F10')).toBe(true);
    state.destroyed = true;
    callbacks.get('Alt+F10')?.();
    expect(target.minimize).not.toHaveBeenCalled();
    expect(target.show).not.toHaveBeenCalled();
  });
});

it('ignores captured callbacks from a replaced accelerator and never reactivates a closed owner', () => {
  const f = createHarness();
  f.controller.update('Control+2');
  const old = f.callbacks.get('Control+2')!;
  f.controller.update('Alt+F10');
  old();
  expect(f.target.minimize).not.toHaveBeenCalled();
  const current = f.callbacks.get('Alt+F10')!;
  current();
  expect(f.target.minimize).toHaveBeenCalledOnce();
  f.controller.close();
  current();
  expect(f.target.minimize).toHaveBeenCalledOnce();
  expect(f.controller.update('Control+3')).toBe(false);
  expect(f.callbacks.size).toBe(0);
});
it('selects only a live owned focus target and preserves the original minimize/restore interaction', () => {
  const first = createHarness(),
    second = createHarness(),
    foreign = createHarness();
  first.state.focused = false;
  const windows = [first.target, second.target];
  const target = selectGlobalHotkeyWindow(windows, second.target);
  expect(target).toBe(second.target);
  toggleGlobalHotkeyWindow(target);
  expect(first.target.minimize).not.toHaveBeenCalled();
  expect(second.target.minimize).toHaveBeenCalledOnce();
  second.state.focused = false;
  second.state.minimized = true;
  toggleGlobalHotkeyWindow(selectGlobalHotkeyWindow(windows, second.target));
  expect(second.target.restore).toHaveBeenCalledOnce();
  expect(second.target.show).toHaveBeenCalledOnce();
  expect(second.target.focus).toHaveBeenCalledOnce();
  expect(selectGlobalHotkeyWindow(windows, foreign.target)).toBe(first.target);
  second.state.destroyed = true;
  expect(selectGlobalHotkeyWindow(windows, second.target)).toBe(first.target);
});
it('retains a failed unregister for actual cleanup retry without admitting another binding', () => {
  const f = createHarness();
  f.controller.update('Control+2');
  f.shortcuts.unregister.mockImplementationOnce(() => {
    throw Error('Native release failed');
  });
  expect(() => f.controller.close()).toThrow('Native release failed');
  expect(f.callbacks.size).toBe(1);
  expect(f.controller.isRegistered('Control+2')).toBe(false);
  expect(f.controller.update('Alt+F10')).toBe(false);
  f.controller.close();
  expect(f.callbacks.size).toBe(0);
  expect(f.shortcuts.unregister).toHaveBeenCalledTimes(2);
});
