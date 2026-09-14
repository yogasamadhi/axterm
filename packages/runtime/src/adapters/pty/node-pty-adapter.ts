import { homedir } from 'node:os';
import process from 'node:process';
import * as pty from 'node-pty';
import type { PtyPort, ShellIntegrationKind, TerminalChannel } from '../../ports/terminal-channel';
import { defaultShellCandidates, openFirstAvailableShell } from './default-shell';

export class NodePtyAdapter implements PtyPort {
  open(input: {
    shell?: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
    term: string;
    loginShell: boolean;
    cols: number;
    rows: number;
  }): TerminalChannel {
    const args = [
      ...(input.loginShell && process.platform !== 'win32' ? ['-l'] : []),
      ...input.args,
    ];
    const { shell, value: child } = openFirstAvailableShell(
      input.shell ? [input.shell] : defaultShellCandidates(),
      (candidate) =>
        pty.spawn(candidate, args, {
          name: input.term,
          // node-pty 1.1.0 delivers Buffer instances on POSIX only when encoding is
          // explicitly null. Leaving this unset decodes arbitrary PTY bytes as
          // UTF-8 before the Runtime can put them on the binary terminal stream.
          encoding: null,
          cols: input.cols,
          rows: input.rows,
          cwd: input.cwd || homedir(),
          env: sanitizeEnvironment({ ...process.env, ...input.env, TERM: input.term }),
        }),
    );
    let closed = false;
    let exited = false;
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const dataListeners = new Set<(data: Uint8Array) => void>();
    const exitListeners = new Set<(exitCode: number | null) => void>();
    const dataSubscription = child.onData((data) => {
      // The published IPty.onData type is still `string`, while the documented
      // encoding:null runtime behavior is Buffer on POSIX. Windows ConPTY emits
      // UTF-8 strings regardless of this option, so keep that supported path.
      const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, 'utf8');
      for (const listener of dataListeners) listener(bytes);
    });
    const exitSubscription = child.onExit(({ exitCode }) => {
      closed = true;
      exited = true;
      resolveExit();
      for (const listener of exitListeners) listener(exitCode);
      dataListeners.clear();
      exitListeners.clear();
    });
    return {
      pid: child.pid,
      shellIntegrationKind: detectShellIntegrationKind(shell),
      write: (data) => {
        if (!closed) child.write(Buffer.from(data));
      },
      resize: (cols, rows) => {
        if (!closed) child.resize(cols, rows);
      },
      signal: (signal) => {
        if (!closed) child.kill(signal);
      },
      onData(listener) {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      pause: () => child.pause(),
      resume: () => child.resume(),
      async close() {
        closed = true;
        try {
          const destroy = (child as typeof child & { destroy?(): void }).destroy;
          if (destroy) destroy.call(child);
          else child.kill();
        } catch {
          // The native exit event can race with explicit close.
        }
        if (!exited && !(await waitForExit(exitPromise, 2_000)) && process.platform !== 'win32') {
          try {
            child.kill('SIGKILL');
          } catch {
            // The child may have exited between the timeout and escalation.
          }
          await waitForExit(exitPromise, 1_000);
        }
        dataSubscription.dispose();
        exitSubscription.dispose();
        dataListeners.clear();
        exitListeners.clear();
      },
    };
  }
}

function waitForExit(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    void exitPromise.then(() => finish(true));
  });
}

function sanitizeEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const blocked = /^(ELECTRON_|AXTERM_.*TOKEN|NODE_OPTIONS$)/i;
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !blocked.test(entry[0]),
    ),
  );
  if (process.platform !== 'win32' && !sanitized.LANG?.trim())
    sanitized.LANG =
      [sanitized.LC_ALL, sanitized.LC_CTYPE].find((value) => value?.trim()) ?? 'C.UTF-8';
  return sanitized;
}

function detectShellIntegrationKind(executable: string): ShellIntegrationKind {
  if (process.platform === 'win32') return 'unsupported';
  const normalized = executable.trim().toLowerCase().split(/[/\\]/u).at(-1) ?? '';
  if (normalized === 'bash') return 'bash';
  if (normalized === 'zsh') return 'zsh';
  if (normalized === 'fish') return 'fish';
  return 'unsupported';
}
