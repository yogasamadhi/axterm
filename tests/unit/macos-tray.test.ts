import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { createMacosTrayIcon } from '../../apps/desktop/src/shell/macos-tray-icon.ts';

const state = {
  image: {
    addRepresentation: vi.fn(),
    setTemplateImage: vi.fn(),
  },
  tray: {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
  },
  buildMenu: vi.fn((items: unknown[]) => ({ items })),
};

const native = {
  createTray: vi.fn(() => {
    createMacosTrayIcon({ createEmpty: () => state.image } as never);
    return state.tray;
  }),
  buildMenu: (items: unknown[]) => state.buildMenu(items) as never,
};

import { MacosTrayController } from '../../apps/desktop/src/shell/macos-tray.ts';

beforeEach(() => {
  vi.clearAllMocks();
  state.tray.setContextMenu.mockReset();
  state.tray.isDestroyed.mockReturnValue(false);
});

describe('macOS menu bar item', () => {
  it('owns one native item with a standard/Retina monochrome template and window/quit menu', () => {
    const showWindow = vi.fn();
    const controller = new MacosTrayController('Axterm', showWindow, native, 'darwin');
    controller.start();
    controller.start();
    expect(native.createTray).toHaveBeenCalledOnce();
    expect(state.tray.setToolTip).toHaveBeenCalledWith('Axterm');
    expect(state.image.setTemplateImage).toHaveBeenCalledWith(true);
    const representations = state.image.addRepresentation.mock.calls.map(
      ([value]) => value as { scaleFactor: number; buffer: Buffer },
    );
    expect(representations.map(({ scaleFactor }) => scaleFactor)).toEqual([1, 2]);
    for (const { scaleFactor, buffer } of representations) {
      const png = PNG.sync.read(buffer);
      expect([png.width, png.height]).toEqual([16 * scaleFactor, 16 * scaleFactor]);
      const alpha: number[] = [];
      for (let index = 0; index < png.data.length; index += 4) {
        expect([...png.data.subarray(index, index + 3)]).toEqual([0, 0, 0]);
        alpha.push(png.data[index + 3]!);
      }
      expect(alpha.some((value) => value === 0)).toBe(true);
      expect(alpha.some((value) => value > 0)).toBe(true);
    }
    const menu = state.buildMenu.mock.calls[0]![0] as Array<{
      id?: string;
      role?: string;
      click?: () => void;
    }>;
    expect(menu.at(-1)?.role).toBe('quit');
    const show = menu.find(({ id }) => id === 'axterm-show-window')!;
    show.click!();
    expect(showWindow).toHaveBeenCalledOnce();
    controller.close();
    controller.close();
    controller.start();
    show.click!();
    expect(showWindow).toHaveBeenCalledOnce();
    expect(state.tray.setContextMenu).toHaveBeenLastCalledWith(null);
    expect(state.tray.destroy).toHaveBeenCalledOnce();
    expect(native.createTray).toHaveBeenCalledOnce();
  });

  it.each(['win32', 'linux'] as const)('does not allocate a macOS tray on %s', (platform) => {
    const controller = new MacosTrayController('Axterm', vi.fn(), native, platform);
    controller.start();
    controller.close();
    expect(native.createTray).not.toHaveBeenCalled();
    expect(state.image.addRepresentation).not.toHaveBeenCalled();
  });

  it('destroys a partially configured tray when native menu creation fails', () => {
    state.tray.setContextMenu.mockImplementationOnce(() => {
      throw new Error('native menu unavailable');
    });
    const controller = new MacosTrayController('Axterm', vi.fn(), native, 'darwin');
    expect(() => controller.start()).toThrow('native menu unavailable');
    expect(state.tray.destroy).toHaveBeenCalledOnce();
    controller.close();
    expect(state.tray.destroy).toHaveBeenCalledOnce();
  });

  it('still destroys the native item if clearing its menu fails during shutdown', () => {
    const controller = new MacosTrayController('Axterm', vi.fn(), native, 'darwin');
    controller.start();
    state.tray.setContextMenu.mockImplementationOnce(() => {
      throw new Error('native menu unavailable');
    });
    expect(() => controller.close()).toThrow('native menu unavailable');
    expect(state.tray.destroy).toHaveBeenCalledOnce();
    expect(() => controller.close()).not.toThrow();
    expect(state.tray.destroy).toHaveBeenCalledOnce();
  });
});

it('routes new-window and explicit quit to their Shell owners and revokes captured callbacks on close', () => {
  const actions = { newWindow: vi.fn(), quit: vi.fn() };
  const controller = new MacosTrayController('Axterm', vi.fn(), native, 'darwin', actions);
  controller.start();
  const menu = state.buildMenu.mock.calls[0]![0] as Array<{ id?: string; click?: () => void }>;
  const newWindow = menu.find((item) => item.id === 'axterm-new-window')!;
  const quit = menu.find((item) => item.id === 'axterm-quit')!;
  newWindow.click!();
  quit.click!();
  expect(actions.newWindow).toHaveBeenCalledOnce();
  expect(actions.quit).toHaveBeenCalledOnce();
  controller.close();
  newWindow.click!();
  quit.click!();
  expect(actions.newWindow).toHaveBeenCalledOnce();
  expect(actions.quit).toHaveBeenCalledOnce();
});
