import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from './packages/shared/src/index';
import { DESKTOP_COMMAND_LINE_HELP } from './apps/desktop/src/main/command-line';

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = join(repositoryRoot, 'apps', 'desktop');
const desktopManifest = join(desktopDirectory, 'package.json');
const desktopIcon = join(desktopDirectory, 'build', 'icon.png');
const forwardedSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
type ForwardedSignal = (typeof forwardedSignals)[number];

const exitCodes: Record<ForwardedSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runDesktop(): Promise<number> {
  if (!existsSync(desktopManifest)) {
    throw new Error(`Desktop workspace not found: ${desktopManifest}`);
  }
  if (!existsSync(desktopIcon)) {
    throw new Error(`Desktop icon not found: ${desktopIcon}`);
  }

  const forwardedArguments = process.argv.slice(2);
  if (forwardedArguments[0] === '--') forwardedArguments.shift();
  if (forwardedArguments.includes('--help') || forwardedArguments.includes('-h')) {
    console.log(DESKTOP_COMMAND_LINE_HELP);
    return 0;
  }
  if (forwardedArguments.includes('--version') || forwardedArguments.includes('-V')) {
    console.log(APP_VERSION);
    return 0;
  }
  const bunArguments = ['run', 'dev'];
  if (forwardedArguments.length > 0) bunArguments.push('--', ...forwardedArguments);

  console.log('[Axterm] Starting the desktop development environment...');

  const desktop = spawn(process.execPath, bunArguments, {
    cwd: desktopDirectory,
    detached: process.platform !== 'win32',
    env: { ...process.env, AXTERM_DESKTOP_ICON: desktopIcon },
    stdio: 'inherit',
  });

  let requestedSignal: ForwardedSignal | undefined;
  let forceShutdownTimer: NodeJS.Timeout | undefined;

  const signalDesktopTree = (signal: NodeJS.Signals): void => {
    if (!desktop.pid || desktop.exitCode !== null || desktop.signalCode !== null) return;

    if (process.platform === 'win32') {
      desktop.kill(signal);
      return;
    }

    try {
      process.kill(-desktop.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') desktop.kill(signal);
    }
  };

  const requestShutdown = (signal: ForwardedSignal): void => {
    if (requestedSignal) return;
    requestedSignal = signal;
    signalDesktopTree(signal);

    forceShutdownTimer = setTimeout(() => signalDesktopTree('SIGKILL'), 5_000);
    forceShutdownTimer.unref();
  };

  const signalHandlers = new Map<ForwardedSignal, () => void>();
  for (const signal of forwardedSignals) {
    const handler = (): void => requestShutdown(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const onError = (error: Error): void => {
          desktop.off('exit', onExit);
          reject(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          desktop.off('error', onError);
          resolve({ code, signal });
        };

        desktop.once('error', onError);
        desktop.once('exit', onExit);
      },
    );

    if (result.code !== null) return result.code;
    if (requestedSignal) return exitCodes[requestedSignal];
    return result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1;
  } finally {
    if (forceShutdownTimer) clearTimeout(forceShutdownTimer);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

try {
  process.exitCode = await runDesktop();
} catch (error) {
  console.error(`[Axterm] Failed to start the desktop: ${formatError(error)}`);
  process.exitCode = 1;
}
