import { describe, expect, it } from 'vitest';
import { resolveTerminalAppearance } from '../../apps/desktop/src/renderer/src/components/terminal-appearance';
import { DEFAULT_TERMINAL_APPEARANCE } from '../../packages/contracts/src';

describe('terminal appearance', () => {
  it('uses the Contract defaults without sharing their object', () => {
    const resolved = resolveTerminalAppearance(undefined);
    expect(resolved).toEqual(DEFAULT_TERMINAL_APPEARANCE);
    expect(resolved).not.toBe(DEFAULT_TERMINAL_APPEARANCE);
  });

  it('keeps every selected profile value for xterm construction', () => {
    expect(
      resolveTerminalAppearance({
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 19,
        lineHeight: 1.4,
        cursorStyle: 'bar',
        cursorBlink: true,
      }),
    ).toEqual({
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 19,
      lineHeight: 1.4,
      cursorStyle: 'bar',
      cursorBlink: true,
    });
  });
});
