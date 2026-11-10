import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { DEFAULT_DESKTOP_WINDOW_PREFERENCES } from '@axterm/plugin-api/desktop';
import {
  correctWindowBounds,
  ShellWindowPreferences,
} from '../../apps/desktop/src/shell/window-preferences.ts';
const signal = () => new AbortController().signal;
function fixture() {
  let bounds = { x: 0, y: 0, width: 1440, height: 900 };
  const target = {
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    getNormalBounds: () => bounds,
    setBounds: vi.fn((value) => {
      bounds = value;
    }),
    setOpacity: vi.fn(),
    webContents: { setZoomFactor: vi.fn() },
  } as unknown as BrowserWindow;
  const registered = new Map<string, () => void>();
  const hotkeys = {
    register: vi.fn((key: string, run: () => void) => {
      if (key === 'Unavailable') return false;
      registered.set(key, run);
      return true;
    }),
    unregister: vi.fn((key: string) => {
      registered.delete(key);
    }),
    isRegistered: (key: string) => registered.has(key),
  };
  const activate = vi.fn(),
    initialized = vi.fn();
  const owner = new ShellWindowPreferences({
    windows: () => [target],
    focused: () => target,
    hotkeys,
    activate,
    initialized,
    displays: () => ({ primary: { x: 0, y: 0, width: 1920, height: 1080 }, areas: [] }),
  });
  owner.attach(target);
  return { owner, target, registered, hotkeys, activate, initialized };
}
it('corrects disconnected bounds using the same frozen minimum/display policy', () => {
  expect(
    correctWindowBounds(
      { x: 8000, y: 7000, width: 400, height: 300 },
      { primary: { x: 0, y: 0, width: 1920, height: 1080 }, areas: [] },
    ),
  ).toEqual({ x: 560, y: 250, width: 800, height: 580 });
  expect(
    correctWindowBounds(
      { x: -90, y: -90, width: 3000, height: 2000 },
      { primary: { x: 0, y: 0, width: 1280, height: 720 }, areas: [] },
    ),
  ).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
});
it('applies accepted presentation versions, preserves newer state and releases only its owned OS hotkey', async () => {
  const f = fixture();
  await f.owner.configure(
    { version: 0, preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES } },
    signal(),
  );
  expect(f.registered.has('Control+2')).toBe(true);
  const next = {
    version: 1,
    preferences: {
      ...DEFAULT_DESKTOP_WINDOW_PREFERENCES,
      titleBarStyle: 'system' as const,
      zoomFactor: 1.5,
      opacity: 0.8,
    },
  };
  expect(await f.owner.configure(next, signal())).toMatchObject({
    appliedVersion: 1,
    requiresRestart: true,
  });
  expect(f.target.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.5);
  await f.owner.configure(
    { version: 0, preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES } },
    signal(),
  );
  expect(f.target.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.5);
  await expect(
    f.owner.configure({ ...next, preferences: { ...next.preferences, opacity: 0.6 } }, signal()),
  ).rejects.toThrow('VERSION_CONFLICT');
  await f.owner.dispose();
  expect(f.registered.size).toBe(0);
  await expect(f.owner.state(signal())).rejects.toThrow('CLOSED');
});
it('suspends the actual global key during recording, restores the current key, and reports registration failure', async () => {
  const f = fixture();
  await f.owner.configure(
    { version: 0, preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES } },
    signal(),
  );
  f.owner.setRecording(true);
  expect(f.registered.size).toBe(0);
  await f.owner.configure(
    {
      version: 1,
      preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, globalHotkey: 'Alt+Shift+Z' },
    },
    signal(),
  );
  expect(f.registered.size).toBe(0);
  f.owner.setRecording(false);
  expect([...f.registered.keys()]).toEqual(['Alt+Shift+Z']);
  f.registered.get('Alt+Shift+Z')!();
  expect(f.activate).toHaveBeenCalledWith(true);
  expect(
    await f.owner.configure(
      {
        version: 2,
        preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, globalHotkey: 'Unavailable' },
      },
      signal(),
    ),
  ).toMatchObject({ globalHotkeyRegistered: false });
  expect([...f.registered.keys()]).toEqual(['Alt+Shift+Z']);
  await f.owner.dispose();
  expect(f.registered.size).toBe(0);
});
it('persists observed bounds without moving other native windows, and applies explicitly requested bounds', async () => {
  const f = fixture(),
    bounds = { x: 100, y: 100, width: 1000, height: 700 };
  await f.owner.configure(
    { version: 0, preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES } },
    signal(),
  );
  await f.owner.configure(
    {
      version: 1,
      preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, rememberWindowSize: true, bounds },
    },
    signal(),
  );
  expect(f.target.setBounds).not.toHaveBeenCalled();
  await f.owner.configure(
    {
      version: 2,
      preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, rememberWindowSize: true, bounds },
    },
    signal(),
    true,
  );
  expect(f.target.setBounds).toHaveBeenCalledWith(bounds);
  await f.owner.dispose();
});

it('releases the prior registration before a new Host generation and revokes its captured callback', async () => {
  const f = fixture();
  await f.owner.configure(
    {
      version: 3,
      preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, globalHotkey: 'Alt+Shift+A' },
    },
    signal(),
  );
  const prior = f.registered.get('Alt+Shift+A')!;
  await f.owner.dispose();
  expect(f.registered.size).toBe(0);
  f.owner.beginGeneration();
  const state = await f.owner.configure(
    {
      version: 0,
      preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, globalHotkey: 'Alt+Shift+B' },
    },
    signal(),
  );
  expect(state).toMatchObject({ appliedVersion: 0, globalHotkeyRegistered: true });
  expect([...f.registered.keys()]).toEqual(['Alt+Shift+B']);
  prior();
  expect(f.activate).not.toHaveBeenCalled();
  f.registered.get('Alt+Shift+B')!();
  expect(f.activate).toHaveBeenCalledExactlyOnceWith(true);
  await f.owner.dispose();
  expect(f.registered.size).toBe(0);
});
