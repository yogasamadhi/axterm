import { Terminal } from '@xterm/headless';
import { expect, it } from 'vitest';
import {
  readNormalBuffer,
  NORMAL_BUFFER_MAX_CHARACTERS,
  NORMAL_BUFFER_MAX_LINES,
} from '../../packages/plugins/terminals/src/client/interactions/normal-buffer.ts';
const write = (terminal: Terminal, text: string) =>
  new Promise<void>((done) => terminal.write(text, done));
it('reads the real normal buffer while a TUI owns the alternate buffer and omits empty trailing rows', async () => {
  const terminal = new Terminal({ cols: 80, rows: 4, allowProposedApi: true });
  try {
    expect(readNormalBuffer(terminal.buffer.normal)).toBeUndefined();
    await write(terminal, 'SHELL_BUFFER_PROBE\r\n');
    await write(terminal, '\x1b[?1049hTUI_ALTERNATE_PROBE');
    expect(terminal.buffer.active.type).toBe('alternate');
    const snapshot = readNormalBuffer(terminal.buffer.normal);
    expect(snapshot).toContain('SHELL_BUFFER_PROBE');
    expect(snapshot).not.toContain('TUI_ALTERNATE_PROBE');
    expect(snapshot?.endsWith('\n')).toBe(false);
  } finally {
    terminal.dispose();
  }
});
it('bounds a real large scrollback snapshot while retaining the newest normal output', async () => {
  const terminal = new Terminal({ cols: 512, rows: 4, scrollback: 3000, allowProposedApi: true });
  try {
    await write(
      terminal,
      Array.from({ length: 2200 }, (_, index) => `row-${index}:` + 'x'.repeat(250) + '\r\n').join(
        '',
      ),
    );
    const snapshot = readNormalBuffer(terminal.buffer.normal)!;
    expect(snapshot).toContain('row-2199:');
    expect(snapshot).not.toContain('row-0:');
    expect(snapshot.split('\n').length).toBeLessThanOrEqual(NORMAL_BUFFER_MAX_LINES);
    expect(snapshot.length).toBeLessThanOrEqual(
      NORMAL_BUFFER_MAX_CHARACTERS + NORMAL_BUFFER_MAX_LINES - 1,
    );
  } finally {
    terminal.dispose();
  }
});
