import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import {
  createTerminalOutputDecoder,
  decodeTerminalOutput,
  formatTerminalOutput,
} from '../../packages/plugins/terminals/src/client/rendering/output.ts';

describe('terminal output encoding and raw display', () => {
  it('hands subsequent ASCII frames to the real parser without a second string allocation', async () => {
    const state = createTerminalOutputDecoder('utf-8');
    const frame = new TextEncoder().encode('plain\r\n\u001b[31mcolor\u001b[0m');
    expect(decodeTerminalOutput(state, frame, false)).toBe(new TextDecoder().decode(frame));
    expect(decodeTerminalOutput(state, frame, false)).toBe(frame);
    const actual = new Terminal({ cols: 80, rows: 4, allowProposedApi: true });
    const reference = new Terminal({ cols: 80, rows: 4, allowProposedApi: true });
    const decoder = new TextDecoder();
    const mixed = createTerminalOutputDecoder('utf-8');
    try {
      for (const bytes of [
        new TextEncoder().encode('first '),
        frame,
        Uint8Array.of(0xef, 0xbb, 0xbf),
        Uint8Array.of(0xe2),
        Uint8Array.of(0x82, 0xac),
        new TextEncoder().encode(' tail'),
      ]) {
        await Promise.all([
          new Promise<void>((done) =>
            actual.write(decodeTerminalOutput(mixed, bytes, false), done),
          ),
          new Promise<void>((done) =>
            reference.write(decoder.decode(bytes, { stream: true }), done),
          ),
        ]);
      }
      expect(mixed.asciiFastPath).toBe(false);
      expect(decodeTerminalOutput(mixed, frame, false)).toBeTypeOf('string');
      expect(
        Array.from({ length: 4 }, (_, index) =>
          actual.buffer.active.getLine(index)?.translateToString(true),
        ),
      ).toEqual(
        Array.from({ length: 4 }, (_, index) =>
          reference.buffer.active.getLine(index)?.translateToString(true),
        ),
      );
      expect(actual.buffer.active.cursorX).toBe(reference.buffer.active.cursorX);
    } finally {
      actual.dispose();
      reference.dispose();
    }
  });

  it('preserves stream-start versus midstream BOM and permanently falls back for raw display', () => {
    const start = createTerminalOutputDecoder('utf-8');
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
    expect(decodeTerminalOutput(start, bom, false)).toBe('');
    const mid = createTerminalOutputDecoder('utf-8');
    const ascii = Uint8Array.of(65);
    decodeTerminalOutput(mid, ascii, false);
    expect(decodeTerminalOutput(mid, ascii, false)).toBe(ascii);
    expect(decodeTerminalOutput(mid, bom, false)).toBe('\ufeff');
    const raw = createTerminalOutputDecoder('utf-8');
    decodeTerminalOutput(raw, ascii, false);
    expect(decodeTerminalOutput(raw, Uint8Array.of(0x1b, 0x5b, 0x6d), true)).toBe('\\033[m');
    expect(decodeTerminalOutput(raw, ascii, false)).toBe('A');
  });
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
