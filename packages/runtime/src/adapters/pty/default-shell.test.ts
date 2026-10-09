import { describe, expect, it } from 'vitest';
import { defaultShellCandidates, openFirstAvailableShell } from './default-shell';

describe('defaultShellCandidates', () => {
  it('prefers standard PowerShell 7 locations independently of PATH', () => {
    expect(
      defaultShellCandidates(
        'win32',
        {
          ProgramFiles: 'C:\\Program Files',
          LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
          PATH: 'C:\\Windows\\System32',
        },
        'C:\\Users\\tester',
      ),
    ).toEqual([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
      'pwsh.exe',
      'powershell.exe',
    ]);
  });

  it('derives the WindowsApps alias from the home directory when LOCALAPPDATA is absent', () => {
    expect(defaultShellCandidates('win32', {}, 'C:\\Users\\tester')).toContain(
      'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
    );
  });

  it('keeps the configured POSIX shell', () => {
    expect(defaultShellCandidates('linux', { SHELL: '/bin/zsh' }, '/home/tester')).toEqual([
      '/bin/zsh',
    ]);
  });
});

describe('openFirstAvailableShell', () => {
  it('tries the next candidate when a shell cannot be spawned', () => {
    const attempted: string[] = [];
    const result = openFirstAvailableShell(['missing.exe', 'pwsh.exe'], (shell) => {
      attempted.push(shell);
      if (shell === 'missing.exe') throw new Error('not found');
      return { pid: 42 };
    });

    expect(attempted).toEqual(['missing.exe', 'pwsh.exe']);
    expect(result).toEqual({ shell: 'pwsh.exe', value: { pid: 42 } });
  });
});
