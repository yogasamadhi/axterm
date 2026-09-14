import { describe, expect, it } from 'vitest';
import {
  boundedTerminalReloadScreen,
  createRestoreCwdInput,
  createTerminalReloadState,
  getAlternateBufferSnapshot,
  quotePosixShellArgument,
  sanitizeTerminalReloadCwd,
  TerminalReloadStateRegistry,
  TERMINAL_RELOAD_SCREEN_MAX_BYTES,
} from '../../apps/desktop/src/renderer/src/components/terminal-reload-state';

describe('terminal reload state', () => {
  it('validates and quotes a bounded working directory for explicit shell input', () => {
    expect(sanitizeTerminalReloadCwd('/srv/project')).toBe('/srv/project');
    expect(sanitizeTerminalReloadCwd('/srv\nproject')).toBe('');
    expect(sanitizeTerminalReloadCwd(`/${'x'.repeat(4_096)}`)).toBe('');
    expect(quotePosixShellArgument("/srv/a'b")).toBe("'/srv/a'\"'\"'b'");
    expect(createRestoreCwdInput("/srv/a'b")).toBe("cd -- '/srv/a'\"'\"'b'\r");
    expect(createRestoreCwdInput('/srv\runsafe')).toBe('');
  });

  it('keeps the newest complete rows inside the UTF-8 byte limit', () => {
    const line = `${'终'.repeat(96)}\n`;
    const bounded = boundedTerminalReloadScreen(
      `${'discarded'.repeat(100)}\n${line.repeat(1_200)}`,
    );
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(
      TERMINAL_RELOAD_SCREEN_MAX_BYTES,
    );
    expect(bounded.startsWith('终')).toBe(true);
    expect(bounded).not.toContain('discarded');
  });

  it('adds a trimmed alternate buffer snapshot to the serialized normal buffer', () => {
    const lines = ['alternate one', 'alternate two', '', ''];
    const alternate = getAlternateBufferSnapshot({
      type: 'alternate',
      length: lines.length,
      getLine: (index) => ({ translateToString: () => lines[index] ?? '' }),
    });
    expect(alternate).toBe('alternate one\r\nalternate two');
    expect(
      createTerminalReloadState({ cwd: '/srv', screen: 'normal', alternateScreen: alternate }),
    ).toEqual({ cwd: '/srv', screen: 'normal\r\nalternate one\r\nalternate two' });
    expect(createTerminalReloadState({})).toBeUndefined();
  });

  it('bounds the generation-local registry and consumes each handoff once', () => {
    const registry = new TerminalReloadStateRegistry(2);
    registry.set('one', { cwd: '/one', screen: 'one' });
    registry.set('two', { cwd: '/two', screen: 'two' });
    registry.set('three', { cwd: '/three', screen: 'three' });
    expect(registry.size).toBe(2);
    expect(registry.consume('one')).toBeUndefined();
    expect(registry.consume('two')).toEqual({ cwd: '/two', screen: 'two' });
    expect(registry.consume('two')).toBeUndefined();
    registry.clear();
    expect(registry.size).toBe(0);
  });
});
