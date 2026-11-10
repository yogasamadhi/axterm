import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { SubprocessService, SubprocessTerminalHandle } from '@axterm/plugin-api/host';
import type { PtyPort, TerminalChannel, ShellIntegrationKind } from '../ports/terminal-channel.ts';
import { SHELL_INTEGRATION_SENTINEL_VARIABLE } from '../ports/terminal-channel.ts';
import { defaultShellCandidates } from './default-shell.ts';

/** Maps the owned subprocess capability to the application's binary terminal port. */
export class NodePtyAdapter implements PtyPort {
  constructor(private readonly subprocess: SubprocessService) {}
  async open(input: Parameters<PtyPort['open']>[0]): Promise<TerminalChannel> {
    const cwd = resolve(input.cwd || homedir());
    const args = [
      ...(input.loginShell && process.platform !== 'win32' ? ['-l'] : []),
      ...input.args,
    ];
    let terminal: SubprocessTerminalHandle | undefined;
    let selected: string | undefined;
    let lastError: unknown;
    for (const shell of input.shell ? [input.shell] : defaultShellCandidates()) {
      input.signal?.throwIfAborted();
      try {
        terminal = await this.subprocess.spawnTerminal({
          argv: [shell, ...args],
          cwd,
          env: sanitizeEnvironment(input.env),
          terminalType: input.term,
          cols: input.cols,
          rows: input.rows,
          binary: process.platform !== 'win32',
          graceMs: 1000,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        selected = shell;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!terminal || !selected) throw lastError ?? new Error('TERMINAL_SHELL_UNAVAILABLE');
    const handle = terminal;
    let closed = false;
    let exitCode: number | null | undefined;
    const exits = new Set<(exitCode: number | null) => void>();
    const operations = new Set<Promise<void>>();
    let queuedBytes = 0;
    let closing: Promise<void> | undefined;
    const publishExit = (code: number | null) => {
      if (exitCode !== undefined) return;
      closed = true;
      exitCode = code;
      for (const listener of [...exits]) listener(code);
      exits.clear();
    };
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        closed = true;
        const results = await Promise.allSettled([
          Promise.resolve().then(() => handle.terminate()),
          ...operations,
        ]);
        if (results[0]?.status === 'rejected') throw new Error('TERMINAL_DRAIN_FAILED');
        handle.output.destroy();
        exits.clear();
      })());
    const submit = (operation: () => Promise<void>, bytes = 0): void => {
      if (closed) return;
      if (operations.size >= 256 || queuedBytes + bytes > 1024 * 1024)
        throw new Error('TERMINAL_IO_CAPACITY');
      queuedBytes += bytes;
      const work = Promise.resolve().then(operation);
      operations.add(work);
      const release = () => {
        operations.delete(work);
        queuedBytes -= bytes;
      };
      void work.then(release, () => {
        release();
        publishExit(null);
        void close().catch(() => {});
      });
    };
    void handle.done.then(
      (outcome) => publishExit(outcome.exitCode),
      () => publishExit(null),
    );
    return {
      pid: handle.pid,
      cwd,
      shellIntegrationKind: detectShellIntegrationKind(selected),
      write: (bytes) => {
        const copy = Buffer.from(bytes);
        submit(() => handle.write(copy), copy.length);
      },
      resize: (cols, rows) => submit(() => handle.resize(cols, rows)),
      signal: (signal) =>
        submit(async () => {
          await handle.signalForeground(signal);
        }),
      onData: (listener) => {
        handle.output.on('data', listener);
        return () => {
          handle.output.off('data', listener);
        };
      },
      onExit: (listener) => {
        if (exitCode !== undefined) queueMicrotask(() => listener(exitCode!));
        else exits.add(listener);
        return () => {
          exits.delete(listener);
        };
      },
      pause: () => {
        handle.output.pause();
      },
      resume: () => {
        handle.output.resume();
      },
      close,
    };
  }
}

/**
 * The shell integration sentinel only means "this shell was already injected".
 * An inherited value would make every spawned shell skip the injection, so the
 * Runtime never forwards it and lets each shell set its own copy.
 */
export function sanitizeEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const blocked = /^(ELECTRON_|AXTERM_.*TOKEN|NODE_OPTIONS$)/i;
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        !blocked.test(entry[0]) &&
        entry[0].toUpperCase() !== SHELL_INTEGRATION_SENTINEL_VARIABLE,
    ),
  );
  if (process.platform !== 'win32' && !sanitized.LANG?.trim())
    sanitized.LANG =
      [sanitized.LC_ALL, sanitized.LC_CTYPE].find((value) => value?.trim()) ?? 'C.UTF-8';
  return sanitized;
}

export function detectShellIntegrationKind(executable: string): ShellIntegrationKind {
  if (process.platform === 'win32') return 'unsupported';
  const normalized = executable.trim().toLowerCase().split(/[/\\]/u).at(-1) ?? '';
  if (normalized === 'bash') return 'bash';
  if (normalized === 'zsh') return 'zsh';
  if (normalized === 'fish') return 'fish';
  return 'unsupported';
}
