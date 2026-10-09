import { lstat } from 'node:fs/promises';
import type { SshAgentStatus } from '@workspace/contracts';

export async function probeSshAgent(
  requestedPath?: string,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SshAgentStatus> {
  const normalizedPlatform =
    platform === 'win32'
      ? ('windows' as const)
      : platform === 'darwin'
        ? ('macos' as const)
        : platform === 'linux'
          ? ('linux' as const)
          : ('other' as const);
  const explicit = requestedPath?.trim();
  if (platform === 'win32') {
    const endpoint = explicit || 'pageant';
    if (endpoint === 'pageant')
      return {
        platform: normalizedPlatform,
        state: 'available',
        kind: 'pageant',
        endpoint,
        message: 'Pageant integration is available.',
      };
    if (/^\\\\\.\\pipe\\[^\0\r\n]+$/u.test(endpoint))
      return {
        platform: normalizedPlatform,
        state: 'available',
        kind: 'windowsPipe',
        endpoint,
        message: 'The Windows agent pipe path is valid.',
      };
    return {
      platform: normalizedPlatform,
      state: 'invalid',
      kind: null,
      endpoint,
      message: 'Use Pageant or a \\.\\pipe\\… Windows agent endpoint.',
    };
  }
  const endpoint = explicit || environment.SSH_AUTH_SOCK?.trim();
  if (!endpoint)
    return {
      platform: normalizedPlatform,
      state: 'unavailable',
      kind: null,
      endpoint: null,
      message: 'SSH_AUTH_SOCK is not set; enter an agent socket path or start an SSH Agent.',
    };
  try {
    const metadata = await lstat(endpoint);
    if (!metadata.isSocket())
      return {
        platform: normalizedPlatform,
        state: 'invalid',
        kind: null,
        endpoint,
        message: 'The configured SSH Agent endpoint is not a Unix socket.',
      };
    return {
      platform: normalizedPlatform,
      state: 'available',
      kind: 'unixSocket',
      endpoint,
      message: explicit
        ? 'The configured SSH Agent socket is available.'
        : 'SSH_AUTH_SOCK is available.',
    };
  } catch {
    return {
      platform: normalizedPlatform,
      state: 'unavailable',
      kind: null,
      endpoint,
      message: 'The configured SSH Agent socket is unavailable.',
    };
  }
}
