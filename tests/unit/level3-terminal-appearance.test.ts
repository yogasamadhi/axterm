import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_APPEARANCE, type TerminalAppearance } from '@axterm/plugin-api/terminals';
import { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import { TerminalRecordingWriter } from '../../packages/plugins/terminals/src/adapters/terminal-recording.ts';
async function appearance(input?: TerminalAppearance) {
  const owner = new TerminalService(
    {
      open: async () => ({
        shellIntegrationKind: 'unsupported' as const,
        write() {},
        resize() {},
        signal() {},
        pause() {},
        resume() {},
        onData: () => () => {},
        onExit: () => () => {},
        close: async () => {},
      }),
    },
    TerminalRecordingWriter,
  );
  try {
    return (
      await owner.createLocal({ cols: 80, rows: 24, ...(input ? { appearance: input } : {}) })
    ).appearance;
  } finally {
    await owner.dispose();
  }
}
describe('owned terminal appearance', () => {
  it('uses the Contract defaults without sharing their object', async () => {
    const resolved = await appearance();
    expect(resolved).toEqual(DEFAULT_TERMINAL_APPEARANCE);
    expect(resolved).not.toBe(DEFAULT_TERMINAL_APPEARANCE);
  });
  it('keeps every selected profile value for xterm construction', async () => {
    expect(
      await appearance({
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
