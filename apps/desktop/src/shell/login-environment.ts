// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Login-shell discovery and delimiter framing adapted from apps/desktop/src/login-shell-environment.ts
// at 8bd073392eef6f54e921a093b95076248eb08cbb. Collection is bounded and owned child groups are drained.
import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
const DELIMITER = '_AXTERM_LOGIN_ENV_';
const DUMP = `printf '\\0%s\\0' '${DELIMITER}'; command env -0 || exit; printf '\\0%s\\0' '${DELIMITER}'; exit`;
const EXCLUDED = new Set([
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'DISABLE_AUTO_UPDATE',
  'ZSH_TMUX_AUTOSTARTED',
  'ZSH_TMUX_AUTOSTART',
]);
export function parseLoginEnvironment(bytes: Uint8Array): Record<string, string> | undefined {
  const entries = Buffer.from(bytes).toString('utf8').split('\0');
  const start = entries.indexOf(DELIMITER),
    end = entries.lastIndexOf(DELIMITER);
  if (start < 0 || end === start) return undefined;
  const values: Record<string, string> = {};
  for (const value of entries.slice(start + 1, end)) {
    const at = value.indexOf('=');
    if (at > 0) {
      const name = value.slice(0, at);
      if (
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        !EXCLUDED.has(name) &&
        !/^(AXTERM_|ELECTRON_)/i.test(name)
      )
        values[name] = value.slice(at + 1);
    }
  }
  return values;
}
async function probe(
  shell: string,
  base: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<Record<string, string> | undefined> {
  if (signal.aborted) return undefined;
  return new Promise((resolve) => {
    const child = spawn(shell, ['-ilc', DUMP], {
      cwd: homedir(),
      env: {
        ...base,
        DISABLE_AUTO_UPDATE: 'true',
        ZSH_TMUX_AUTOSTARTED: 'true',
        ZSH_TMUX_AUTOSTART: 'false',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let bytes = 0;
    const chunks: Buffer[] = [];
    let finished = false;
    let closed = false;
    let result: Record<string, string> | undefined;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (releaseTimer) clearTimeout(releaseTimer);
      child.off('close', onClose);
      resolve(result);
    };
    const finish = (value?: Record<string, string>) => {
      if (finished) return;
      finished = true;
      result = value;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      child.stdout.off('data', data);
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Owned group already exited. */
        }
      }
      child.stdout.destroy();
      if (closed) release();
      else
        releaseTimer = setTimeout(() => {
          result = undefined;
          release();
        }, 1000);
    };
    const aborted = () => finish();
    const data = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) {
        finish();
        return;
      }
      chunks.push(chunk);
      const parsed = parseLoginEnvironment(Buffer.concat(chunks));
      if (parsed) finish(parsed);
    };
    const onClose = () => {
      closed = true;
      if (finished) release();
      else finish(parseLoginEnvironment(Buffer.concat(chunks)));
    };
    const timer = setTimeout(() => finish(), 10_000);
    child.stdout.on('data', data);
    child.once('error', () => finish());
    child.once('close', onClose);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
/** Called once by the shell after its instance lock; failures retain the inherited environment. */
export async function readLoginEnvironment(
  base: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return { ...base };
  let account: string | null = null;
  try {
    account = userInfo().shell;
  } catch {
    /* Fixed candidates remain available. */
  }
  const candidates = [
    ...new Set([...(account ? [account] : []), '/bin/zsh', '/bin/bash', '/bin/sh']),
  ];
  for (const shell of candidates) {
    const values = await probe(shell, base, signal);
    if (values) return { ...base, ...values };
    if (signal.aborted) break;
  }
  return { ...base };
}
