import { homedir } from 'node:os';
import { win32 } from 'node:path';
import process from 'node:process';

export function defaultShellCandidates(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string[] {
  if (platform !== 'win32') return [environment.SHELL ?? '/bin/sh'];

  const programFiles = environment.ProgramW6432 ?? environment.ProgramFiles;
  const localAppData =
    environment.LOCALAPPDATA ??
    environment.LocalAppData ??
    win32.join(homeDirectory, 'AppData', 'Local');

  return uniqueShells([
    programFiles ? win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe') : undefined,
    win32.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    'pwsh.exe',
    environment.ComSpec ?? environment.COMSPEC,
    'powershell.exe',
  ]);
}

export function openFirstAvailableShell<T>(
  candidates: string[],
  open: (shell: string) => T,
): { shell: string; value: T } {
  let lastError: unknown;
  for (const shell of candidates) {
    try {
      return { shell, value: open(shell) };
    } catch (cause) {
      lastError = cause;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error('No terminal shell is available');
}

function uniqueShells(candidates: Array<string | undefined>): string[] {
  return [...new Set(candidates.filter((candidate): candidate is string => !!candidate))];
}
