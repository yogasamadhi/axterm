import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  correctWindowBounds,
  DEFAULT_DESKTOP_WINDOW_SIZE,
  DEFAULT_DESKTOP_WINDOW_PREFERENCES,
  WindowBoundsPersistence,
  WindowPreferencesStore,
  readWindowLaunchPreferences,
} from '../../apps/desktop/src/main/host-capabilities/window-preferences';
import type { DesktopWindowBounds } from '../../packages/contracts/src/host-capabilities/desktop';

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('WindowPreferencesStore', () => {
  it('uses a 1440 by 900 first-launch window before local bounds exist', () => {
    expect(DEFAULT_DESKTOP_WINDOW_SIZE).toEqual({ width: 1440, height: 900 });
    expect(DEFAULT_DESKTOP_WINDOW_PREFERENCES.bounds).toBeNull();
  });

  it('atomically persists strict application-local preferences and serializes updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-window-preferences-'));
    directories.push(directory);
    const store = new WindowPreferencesStore(directory);
    await store.open();

    expect(store.get()).toEqual(DEFAULT_DESKTOP_WINDOW_PREFERENCES);
    await Promise.all([
      store.update({ opacity: 0.8 }),
      store.update({ zoomFactor: 1.5 }),
      store.update({ titleBarStyle: 'system' }),
    ]);

    const expected = {
      titleBarStyle: 'system' as const,
      opacity: 0.8,
      zoomFactor: 1.5,
      bounds: null,
      globalHotkey: 'Control+2',
      allowMultiInstance: false,
      confirmBeforeExit: false,
    };
    expect(store.get()).toEqual(expected);
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toEqual({
      version: 1,
      preferences: expected,
    });
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const reopened = new WindowPreferencesStore(directory);
    await reopened.open();
    expect(reopened.get()).toEqual(expected);
    await expect(store.update({ opacity: 1.01 })).rejects.toThrow();
    await expect(store.update({ unknown: true } as never)).rejects.toThrow();
    expect(store.get()).toEqual(expected);
  });

  it('reads the multi-instance policy before Electron startup and safely defaults malformed data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-window-launch-'));
    directories.push(directory);
    expect(readWindowLaunchPreferences(directory)).toEqual(DEFAULT_DESKTOP_WINDOW_PREFERENCES);

    await writeFile(
      join(directory, 'window-preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: {
          ...DEFAULT_DESKTOP_WINDOW_PREFERENCES,
          allowMultiInstance: true,
          confirmBeforeExit: true,
        },
      }),
    );
    expect(readWindowLaunchPreferences(directory)).toMatchObject({
      allowMultiInstance: true,
      confirmBeforeExit: true,
    });

    await writeFile(join(directory, 'window-preferences.json'), '{bad json');
    expect(readWindowLaunchPreferences(directory)).toEqual(DEFAULT_DESKTOP_WINDOW_PREFERENCES);
  });

  it('quarantines a malformed or schema-invalid file and falls back to safe defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-window-preferences-'));
    directories.push(directory);
    const path = join(directory, 'window-preferences.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, opacity: 4, injected: true },
      }),
    );

    const store = new WindowPreferencesStore(directory);
    await store.open();
    expect(store.get()).toEqual(DEFAULT_DESKTOP_WINDOW_PREFERENCES);
    expect(await readdir(directory)).toEqual([
      expect.stringMatching(/^window-preferences\.json\.corrupt-/),
    ]);

    await store.update({ zoomFactor: 2 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 1,
      preferences: { zoomFactor: 2 },
    });
  });
});

describe('desktop window geometry', () => {
  const primary = { workArea: { x: 0, y: 24, width: 1440, height: 876 } };
  const secondary = { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };
  const layout = { displays: [primary, secondary], primary };

  it('retains a connected negative-coordinate display and clamps the whole window into it', () => {
    expect(correctWindowBounds({ x: -2000, y: -100, width: 1200, height: 900 }, layout)).toEqual({
      x: -1920,
      y: 0,
      width: 1200,
      height: 900,
    });
  });

  it('centers disconnected bounds on the primary display and caps oversized dimensions', () => {
    expect(
      correctWindowBounds({ x: 40_000, y: 40_000, width: 5000, height: 5000 }, layout),
    ).toEqual({ x: 0, y: 24, width: 1440, height: 876 });
    expect(correctWindowBounds({ x: 12_000, y: 12_000, width: 900, height: 600 }, layout)).toEqual({
      x: 270,
      y: 162,
      width: 900,
      height: 600,
    });
  });

  it('preserves right, left and upper secondary-display coordinates', () => {
    const right = { workArea: { x: 1440, y: 120, width: 1280, height: 900 } };
    const upper = { workArea: { x: 0, y: -900, width: 1440, height: 900 } };
    const extended = { displays: [primary, secondary, right, upper], primary };
    expect(correctWindowBounds({ x: 1500, y: 180, width: 1000, height: 700 }, extended)).toEqual({
      x: 1500,
      y: 180,
      width: 1000,
      height: 700,
    });
    expect(correctWindowBounds({ x: -1600, y: 100, width: 1000, height: 700 }, extended)).toEqual({
      x: -1600,
      y: 100,
      width: 1000,
      height: 700,
    });
    expect(correctWindowBounds({ x: 200, y: -820, width: 1000, height: 700 }, extended)).toEqual({
      x: 200,
      y: -820,
      width: 1000,
      height: 700,
    });
  });

  it('chooses the greatest intersection and keeps an oversized window inside that work area', () => {
    expect(correctWindowBounds({ x: -200, y: 10, width: 1900, height: 1000 }, layout)).toEqual({
      x: 0,
      y: 24,
      width: 1440,
      height: 876,
    });
  });
});

describe('WindowBoundsPersistence', () => {
  it('throttles move and resize bursts, ignores maximized geometry, and flushes cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'));
    const listeners = new Map<string, Set<() => void>>();
    let bounds: DesktopWindowBounds = { x: 10, y: 20, width: 1000, height: 700 };
    let maximized = false;
    const target = {
      getNormalBounds: () => ({ ...bounds }),
      isDestroyed: () => false,
      isFullScreen: () => false,
      isMaximized: () => maximized,
      on: (event: 'move' | 'resize', listener: () => void) => {
        const entries = listeners.get(event) ?? new Set();
        entries.add(listener);
        listeners.set(event, entries);
      },
      off: (event: 'move' | 'resize', listener: () => void) =>
        listeners.get(event)?.delete(listener),
    };
    const persisted: DesktopWindowBounds[] = [];
    const binding = new WindowBoundsPersistence(target, async (value) => {
      persisted.push({ ...value });
    });
    const emit = (event: 'move' | 'resize') => {
      for (const listener of listeners.get(event) ?? []) listener();
    };

    emit('move');
    await vi.advanceTimersByTimeAsync(1);
    expect(persisted).toEqual([{ x: 10, y: 20, width: 1000, height: 700 }]);

    bounds = { x: 25, y: 30, width: 1000, height: 700 };
    emit('move');
    bounds = { x: 25, y: 30, width: 1100, height: 720 };
    emit('resize');
    await vi.advanceTimersByTimeAsync(248);
    expect(persisted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(persisted).toEqual([
      { x: 10, y: 20, width: 1000, height: 700 },
      { x: 25, y: 30, width: 1100, height: 720 },
    ]);

    maximized = true;
    bounds = { x: 0, y: 0, width: 1440, height: 876 };
    emit('resize');
    await vi.advanceTimersByTimeAsync(300);
    expect(persisted).toHaveLength(2);

    maximized = false;
    bounds = { x: 40, y: 50, width: 1180, height: 780 };
    await binding.dispose();
    expect(persisted.at(-1)).toEqual(bounds);
    expect(listeners.get('move')?.size).toBe(0);
    expect(listeners.get('resize')?.size).toBe(0);
  });
});
