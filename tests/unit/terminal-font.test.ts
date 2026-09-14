import { describe, expect, it } from 'vitest';
import {
  BUNDLED_TERMINAL_FONT_SPEC,
  prepareBundledTerminalFont,
} from '../../apps/desktop/src/renderer/src/components/terminal-font';

describe('bundled terminal font readiness', () => {
  it('reports ready only after the bundled 400-normal face passes FontFaceSet.check', async () => {
    const calls: string[] = [];
    expect(
      await prepareBundledTerminalFont({
        load: async (font, text) => void calls.push(`load:${font}:${text}`),
        check: (font, text) => {
          calls.push(`check:${font}:${text}`);
          return true;
        },
      }),
    ).toBe('ready');
    expect(calls).toEqual([
      `load:${BUNDLED_TERMINAL_FONT_SPEC}:Axterm =>`,
      `check:${BUNDLED_TERMINAL_FONT_SPEC}:Axterm =>`,
    ]);
  });

  it('uses the declared fallback chain when loading rejects or the face is unavailable', async () => {
    await expect(
      prepareBundledTerminalFont({
        load: async () => {
          throw new Error('font unavailable');
        },
        check: () => true,
      }),
    ).resolves.toBe('fallback');
    await expect(
      prepareBundledTerminalFont({ load: async () => [], check: () => false }),
    ).resolves.toBe('fallback');
  });

  it('bounds startup waiting when a FontFaceSet never settles', async () => {
    const started = Date.now();
    await expect(
      prepareBundledTerminalFont({ load: () => new Promise(() => {}), check: () => false }, 5),
    ).resolves.toBe('fallback');
    expect(Date.now() - started).toBeLessThan(250);
  });
});
