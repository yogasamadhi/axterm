import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessTerminalPaste,
  foldShellContinuationLines,
  foldSqlStatementLines,
  normalizeTerminalPaste,
  supportsWindowsBracketedPaste,
  terminalPlatformFromUserAgent,
  waitForSshPasteMode,
  waitForTerminalPrompt,
  wrapWindowsBracketedPaste,
  TERMINAL_PASTE_CONFIRM_THRESHOLD,
  TERMINAL_PASTE_MAX_BYTES,
  TERMINAL_PASTE_MAX_CHARACTERS,
  TERMINAL_PASTE_PREVIEW_CHARACTERS,
} from '../../apps/desktop/src/renderer/src/components/terminal-paste';

afterEach(() => vi.useRealTimers());

describe('terminal paste protection model', () => {
  it('reviews multiline or long content while allowing short single-line text', () => {
    expect(assessTerminalPaste('echo safe')).toEqual({ action: 'send' });
    expect(assessTerminalPaste('first\nsecond')).toMatchObject({
      action: 'confirm',
      review: { characters: 12, lines: 2, reason: 'multiline' },
    });
    expect(assessTerminalPaste('x'.repeat(TERMINAL_PASTE_CONFIRM_THRESHOLD + 1))).toMatchObject({
      action: 'confirm',
      review: { reason: 'long' },
    });
    expect(assessTerminalPaste('x'.repeat(TERMINAL_PASTE_CONFIRM_THRESHOLD))).toEqual({
      action: 'send',
    });
    expect(assessTerminalPaste('first\nsecond', false)).toEqual({ action: 'send' });
  });

  it('keeps the review bounded and rejects an oversized clipboard payload', () => {
    const reviewed = assessTerminalPaste(
      `${'x'.repeat(TERMINAL_PASTE_PREVIEW_CHARACTERS + 4)}\nsecond`,
    );
    expect(reviewed).toMatchObject({
      action: 'confirm',
      review: { truncated: true, reason: 'long-multiline' },
    });
    if (reviewed.action === 'confirm')
      expect(reviewed.review.preview).toHaveLength(TERMINAL_PASTE_PREVIEW_CHARACTERS);
    expect(assessTerminalPaste('x'.repeat(TERMINAL_PASTE_MAX_CHARACTERS + 1))).toMatchObject({
      action: 'reject',
      code: 'PASTE_TOO_LARGE',
    });
    expect(
      assessTerminalPaste('界'.repeat(Math.floor(TERMINAL_PASTE_MAX_BYTES / 3) + 1)),
    ).toMatchObject({ action: 'reject', code: 'PASTE_TOO_LARGE' });
  });

  it('normalizes CRLF only for a remote terminal on Windows', () => {
    const source = 'printf one\r\nprintf two\r\n';
    expect(normalizeTerminalPaste(source, 'ssh', 'win32')).toBe('printf one\nprintf two\n');
    expect(normalizeTerminalPaste(source, 'local', 'win32')).toBe(source);
    expect(normalizeTerminalPaste(source, 'ssh', 'darwin')).toBe(source);
    expect(normalizeTerminalPaste('first |\nsecond', 'telnet', 'darwin')).toBe('first |\nsecond');
  });

  it('folds only unambiguous shell continuation lines into one command', () => {
    expect(foldShellContinuationLines("docker info |\n    sed -n '/Registry Mirrors/,+5p'")).toBe(
      "docker info | sed -n '/Registry Mirrors/,+5p'",
    );
    expect(foldShellContinuationLines('first &&\r\n  second ||\n third')).toBe(
      'first && second || third',
    );
  });

  it('preserves scripts, backslash commands, quoted operators and escaped literal pipes', () => {
    const backslashCommand = 'docker exec \\\n  -it \\\n  opengauss \\\n  bash';
    for (const text of [
      'printf one\nprintf two',
      "printf '|\ninside quote'",
      'echo "|\ninside quote"',
      'printf \\|\nprintf two',
      'printf one # |\nprintf two',
      'if ready; then\n  printf yes\nfi',
      'cat <<EOF\nbody |\nstays literal\nEOF',
      'printf one |\n',
      'printf one |\n# comment\nprintf two',
      backslashCommand,
    ])
      expect(foldShellContinuationLines(text)).toBe(text);
    expect(normalizeTerminalPaste(backslashCommand, 'ssh', 'darwin')).toBe(backslashCommand);
    expect(
      assessTerminalPaste(normalizeTerminalPaste(backslashCommand, 'ssh', 'darwin')),
    ).toMatchObject({ action: 'confirm', review: { lines: 4, reason: 'multiline' } });
  });

  it('folds one complete SQL statement without changing ambiguous SQL', () => {
    const createTable = 'CREATE TABLE users (\n  id INTEGER,\n  username VARCHAR(50)\n);';
    expect(foldSqlStatementLines(createTable)).toBe(
      'CREATE TABLE users ( id INTEGER, username VARCHAR(50) );',
    );
    expect(normalizeTerminalPaste(createTable, 'ssh', 'darwin')).toBe(
      'CREATE TABLE users ( id INTEGER, username VARCHAR(50) );',
    );
    for (const text of [
      "SELECT 'first\nsecond';",
      'SELECT 1 -- keep this comment\n, 2;',
      'SELECT 1;\nSELECT 2;',
      'SELECT flags |\n  other_flags;\nSELECT 2;',
      'CREATE TABLE users (\n  id INTEGER\n)',
      "DO $$\nBEGIN\n  RAISE NOTICE 'hello';\nEND\n$$;",
    ])
      expect(foldSqlStatementLines(text)).toBe(text);
  });

  it('detects the desktop platform without exposing a Node API to Renderer', () => {
    expect(terminalPlatformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(
      'win32',
    );
    expect(terminalPlatformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
      'darwin',
    );
    expect(terminalPlatformFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('preserves LF inside Windows PowerShell paste brackets and does not force CMD', () => {
    expect(supportsWindowsBracketedPaste(undefined)).toBe(true);
    expect(supportsWindowsBracketedPaste('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
    expect(supportsWindowsBracketedPaste('C:\\Windows\\System32\\cmd.exe')).toBe(false);
    expect(wrapWindowsBracketedPaste('first\r\nsecond\rthird\n\u001b[201~')).toBe(
      '\u001b[200~first\nsecond\nthird\n[201~\u001b[201~',
    );
  });

  it('waits for the first settled prompt before a Windows multiline paste', async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    let line = 'PowerShell 7';
    const terminal = {
      buffer: {
        active: {
          type: 'normal',
          cursorY: 0,
          getLine: () => ({ translateToString: () => line }),
        },
      },
      onWriteParsed: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    const controller = new AbortController();
    let resolved = false;
    const ready = waitForTerminalPrompt(terminal, controller.signal, 1_000, 300).then((value) => {
      resolved = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(resolved).toBe(false);
    line = 'PS C:\\Users\\test> ';
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(299);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ready).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('ends the initial wait when a custom prompt cannot be recognized', async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const terminal = {
      buffer: {
        active: {
          type: 'normal',
          cursorY: 0,
          getLine: () => ({ translateToString: () => 'λ ' }),
        },
      },
      onWriteParsed: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    const ready = waitForTerminalPrompt(terminal, new AbortController().signal, 50, 10);
    await vi.advanceTimersByTimeAsync(50);
    expect(await ready).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it('waits through SSH integration recovery, then falls back for an unsupported shell', async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const stateListeners = new Set<() => void>();
    let state: 'pending' | 'active' | 'unavailable' = 'pending';
    const terminal = {
      modes: { bracketedPasteMode: false },
      onWriteParsed: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    const subscribe = (listener: () => void) => {
      stateListeners.add(listener);
      return { dispose: () => stateListeners.delete(listener) };
    };
    let resolved = false;
    const ready = waitForSshPasteMode(
      terminal,
      new AbortController().signal,
      () => state,
      subscribe,
      12_000,
      30,
    ).then((value) => {
      resolved = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(resolved).toBe(false);
    state = 'active';
    for (const listener of stateListeners) listener();
    await vi.advanceTimersByTimeAsync(20);
    terminal.modes.bracketedPasteMode = true;
    for (const listener of listeners) listener();
    expect(await ready).toBe(true);
    expect(listeners.size).toBe(0);
    expect(stateListeners.size).toBe(0);

    terminal.modes.bracketedPasteMode = false;
    state = 'pending';
    const unsupported = waitForSshPasteMode(
      terminal,
      new AbortController().signal,
      () => state,
      subscribe,
      1_000,
      30,
    );
    await vi.advanceTimersByTimeAsync(50);
    state = 'unavailable';
    for (const listener of stateListeners) listener();
    await vi.advanceTimersByTimeAsync(30);
    expect(await unsupported).toBe(false);
    expect(listeners.size).toBe(0);
    expect(stateListeners.size).toBe(0);

    state = 'pending';
    const timedOut = waitForSshPasteMode(
      terminal,
      new AbortController().signal,
      () => state,
      subscribe,
      100,
      30,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await timedOut).toBe(false);
    expect(listeners.size).toBe(0);
    expect(stateListeners.size).toBe(0);
  });
});
