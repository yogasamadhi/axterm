export const TERMINAL_RELOAD_CWD_MAX_LENGTH = 4_096;
export const TERMINAL_RELOAD_SCREEN_MAX_BYTES = 256 * 1_024;
export const TERMINAL_RELOAD_STATE_CAPACITY = 32;

export interface TerminalReloadState {
  cwd: string;
  screen: string;
}

interface TerminalBufferLineLike {
  translateToString(trimRight?: boolean): string;
}

interface TerminalBufferLike {
  type: string;
  length: number;
  getLine(index: number): TerminalBufferLineLike | undefined;
}

export function sanitizeTerminalReloadCwd(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > TERMINAL_RELOAD_CWD_MAX_LENGTH ||
    /[\0\r\n]/u.test(value)
  )
    return '';
  return value;
}

export function quotePosixShellArgument(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

export function createRestoreCwdInput(cwd: unknown): string {
  const safe = sanitizeTerminalReloadCwd(cwd);
  return safe ? `cd -- ${quotePosixShellArgument(safe)}\r` : '';
}

export function boundedTerminalReloadScreen(
  screen: unknown,
  maximumBytes = TERMINAL_RELOAD_SCREEN_MAX_BYTES,
): string {
  if (typeof screen !== 'string' || !screen || maximumBytes <= 0) return '';
  const encoded = new TextEncoder().encode(screen);
  if (encoded.byteLength <= maximumBytes) return screen;

  // Keep the newest complete visual rows. Starting at a row boundary avoids
  // replaying a truncated UTF-8 sequence or the middle of an ANSI row update.
  let bounded = new TextDecoder().decode(encoded.slice(encoded.byteLength - maximumBytes));
  const rowBoundary = bounded.indexOf('\n');
  if (rowBoundary >= 0) bounded = bounded.slice(rowBoundary + 1);
  return bounded;
}

export function getAlternateBufferSnapshot(buffer: TerminalBufferLike | undefined): string {
  if (!buffer || buffer.type !== 'alternate') return '';
  const lines: string[] = [];
  const boundedLength = Math.min(Math.max(0, buffer.length), 10_000);
  for (let index = 0; index < boundedLength; index += 1)
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.join('\r\n');
}

export function createTerminalReloadState(input: {
  cwd?: unknown;
  screen?: unknown;
  alternateScreen?: unknown;
}): TerminalReloadState | undefined {
  const cwd = sanitizeTerminalReloadCwd(input.cwd);
  const normal = typeof input.screen === 'string' ? input.screen : '';
  const alternate = typeof input.alternateScreen === 'string' ? input.alternateScreen : '';
  const screen = boundedTerminalReloadScreen(
    `${normal}${normal && alternate ? '\r\n' : ''}${alternate}`,
  );
  return cwd || screen ? { cwd, screen } : undefined;
}

/**
 * Generation-local handoff for a freshly created replacement terminal. State
 * is consumed once and never enters React, Zustand, browser storage or SQLite.
 */
export class TerminalReloadStateRegistry {
  readonly #capacity: number;
  readonly #states = new Map<string, TerminalReloadState>();

  constructor(capacity = TERMINAL_RELOAD_STATE_CAPACITY) {
    this.#capacity = Math.max(1, capacity);
  }

  set(terminalId: string, state: TerminalReloadState | undefined): void {
    this.#states.delete(terminalId);
    if (!state) return;
    this.#states.set(terminalId, { ...state });
    while (this.#states.size > this.#capacity) {
      const oldest = this.#states.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#states.delete(oldest);
    }
  }

  consume(terminalId: string): TerminalReloadState | undefined {
    const state = this.#states.get(terminalId);
    this.#states.delete(terminalId);
    return state ? { ...state } : undefined;
  }

  delete(terminalId: string): void {
    this.#states.delete(terminalId);
  }

  clear(): void {
    this.#states.clear();
  }

  get size(): number {
    return this.#states.size;
  }
}
