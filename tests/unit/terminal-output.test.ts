import { describe, expect, it } from 'vitest';
import {
  createTerminalOutputDecoder,
  decodeTerminalOutput,
  formatTerminalOutput,
} from '../../apps/desktop/src/renderer/src/components/terminal-output';

describe('terminal output encoding and raw display', () => {
  it('streams split GBK characters without replacement glyphs', () => {
    const state = createTerminalOutputDecoder('gbk');
    expect(state.fellBack).toBe(false);
    expect(decodeTerminalOutput(state, Uint8Array.of(0xd6), false)).toBe('');
    expect(decodeTerminalOutput(state, Uint8Array.of(0xd0, 0xce, 0xc4), false)).toBe('中文');
  });

  it('shows ESC as the pinned raw marker while preserving DCS writes', () => {
    expect(formatTerminalOutput('\u001b[31mred\u001b[0m', true)).toBe('\\033[31mred\\033[0m');
    expect(formatTerminalOutput('\u001bPimage-payload\u001b\\', true)).toBe(
      '\u001bPimage-payload\u001b\\',
    );
    expect(formatTerminalOutput('\u001b[31mred', false)).toBe('\u001b[31mred');
  });
});
