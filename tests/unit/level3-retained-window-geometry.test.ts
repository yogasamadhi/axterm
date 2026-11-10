import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESKTOP_WINDOW_SIZE,
  correctWindowBounds as correctNativeBounds,
} from '../../apps/desktop/src/shell/window-preferences.ts';
import { DEFAULT_DESKTOP_WINDOW_PREFERENCES } from '@axterm/plugin-api/desktop';
import type { DesktopWindowBounds } from '@axterm/plugin-api/desktop';
function correctWindowBounds(
  saved: DesktopWindowBounds,
  layout: {
    primary: { workArea: DesktopWindowBounds };
    displays: { workArea: DesktopWindowBounds }[];
  },
) {
  return correctNativeBounds(saved, {
    primary: layout.primary.workArea,
    areas: layout.displays.map((display) => display.workArea),
  });
}
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

it('defaults to 1440 by 900 with window size restoration disabled', () => {
  expect(DEFAULT_DESKTOP_WINDOW_SIZE).toEqual({ width: 1440, height: 900 });
  expect(DEFAULT_DESKTOP_WINDOW_PREFERENCES.bounds).toBeNull();
  expect(DEFAULT_DESKTOP_WINDOW_PREFERENCES.rememberWindowSize).toBe(false);
});
