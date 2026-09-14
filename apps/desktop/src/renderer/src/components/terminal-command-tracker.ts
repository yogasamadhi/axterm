import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import {
  assessShellCommandLine,
  deserializeOsc633Value,
  isSensitiveCommandLine,
} from '@workspace/shared';
import { sanitizeTerminalReloadCwd } from './terminal-reload-state';

export type TerminalCommandTrackingState = 'pending' | 'active' | 'unavailable';

export interface TerminalCommandTrackerLifecycle {
  onPrompt?(): void;
  onCommandStart?(): void;
}

/**
 * Receives command lines only from OSC 633 shell integration. It intentionally
 * has no keyboard or xterm-buffer fallback, because those paths cannot
 * distinguish a shell command from a password/OTP prompt.
 */
export class TerminalCommandTrackerAddon implements ITerminalAddon {
  private disposable: { dispose(): void } | undefined;
  private replaying = false;
  private disposed = false;
  private state: TerminalCommandTrackingState = 'pending';

  constructor(
    private readonly onCommand: (command: string) => void,
    private readonly onState: (state: TerminalCommandTrackingState) => void,
    private readonly onCwd: (cwd: string) => void = () => {},
    private readonly lifecycle: TerminalCommandTrackerLifecycle = {},
  ) {}

  activate(terminal: Terminal): void {
    this.disposable?.dispose();
    this.disposed = false;
    this.disposable = terminal.parser.registerOscHandler(633, (data) => this.handle(data));
  }

  beginReplay(): void {
    if (!this.disposed) this.replaying = true;
  }

  endReplay(): void {
    this.replaying = false;
  }

  setState(state: TerminalCommandTrackingState): void {
    if (this.disposed) return;
    this.state = state;
    this.onState(state);
  }

  dispose(): void {
    this.disposed = true;
    this.replaying = false;
    this.state = 'pending';
    this.disposable?.dispose();
    this.disposable = undefined;
  }

  /** Exposed for the deterministic parser model tests. */
  handle(data: string): boolean {
    if (this.disposed || !data) return false;
    const kind = data.charAt(0);
    if (!['A', 'B', 'C', 'D', 'E', 'P'].includes(kind)) return false;
    if (kind === 'A') {
      if (!this.replaying && this.state === 'active') this.lifecycle.onPrompt?.();
      return true;
    }
    if (kind === 'C') {
      if (!this.replaying && this.state === 'active') this.lifecycle.onCommandStart?.();
      return true;
    }
    if (kind === 'P') {
      if (this.replaying || !data.startsWith('P;Cwd=')) return true;
      const cwd = sanitizeTerminalReloadCwd(deserializeOsc633Value(data.slice(6)));
      if (cwd) this.onCwd(cwd);
      return true;
    }
    if (kind !== 'E' || this.replaying) return true;
    if (this.state !== 'active') return true;
    this.lifecycle.onCommandStart?.();
    if (data.charAt(1) !== ';') return false;
    const decoded = deserializeOsc633Value(data.slice(2));
    if (decoded === undefined) return true;
    const assessment = assessShellCommandLine(decoded);
    if (!assessment.accepted || isSensitiveCommandLine(assessment.command)) return true;
    this.onCommand(assessment.command);
    return true;
  }
}
