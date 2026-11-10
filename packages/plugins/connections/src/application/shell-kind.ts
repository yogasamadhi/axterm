import type { ShellIntegrationKind } from '@axterm/plugin-api/host';
export function detectShellIntegrationKind(
  executable: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ShellIntegrationKind {
  if (platform === 'win32' || !executable) return 'unsupported';
  const normalized = executable.trim().toLowerCase().split(/[/\\]/u).at(-1) ?? '';
  if (normalized === 'bash') return 'bash';
  if (normalized === 'zsh') return 'zsh';
  if (normalized === 'fish') return 'fish';
  return 'unsupported';
}
