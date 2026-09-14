import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeSshAgent } from './ssh-agent';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('SSH Agent capability probe', () => {
  it('accepts a live Unix socket and rejects regular files or missing endpoints', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-agent-'));
    directories.push(directory);
    const socketPath = join(directory, 'agent.sock');
    const regularPath = join(directory, 'agent.txt');
    await writeFile(regularPath, 'not a socket');
    const server = createServer();
    server.listen(socketPath);
    await once(server, 'listening');
    try {
      await expect(probeSshAgent(socketPath, 'darwin', {})).resolves.toMatchObject({
        platform: 'macos',
        state: 'available',
        kind: 'unixSocket',
        endpoint: socketPath,
      });
      await expect(
        probeSshAgent(undefined, 'linux', { SSH_AUTH_SOCK: socketPath }),
      ).resolves.toMatchObject({ platform: 'linux', state: 'available', endpoint: socketPath });
      await expect(probeSshAgent(regularPath, 'linux', {})).resolves.toMatchObject({
        state: 'invalid',
        endpoint: regularPath,
      });
      await expect(probeSshAgent(undefined, 'linux', {})).resolves.toMatchObject({
        state: 'unavailable',
        endpoint: null,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('supports Pageant and validates Windows named-pipe syntax', async () => {
    await expect(probeSshAgent(undefined, 'win32', {})).resolves.toMatchObject({
      platform: 'windows',
      state: 'available',
      kind: 'pageant',
      endpoint: 'pageant',
    });
    await expect(
      probeSshAgent('\\\\.\\pipe\\openssh-ssh-agent', 'win32', {}),
    ).resolves.toMatchObject({ state: 'available', kind: 'windowsPipe' });
    await expect(probeSshAgent('C:\\agent.sock', 'win32', {})).resolves.toMatchObject({
      state: 'invalid',
      kind: null,
    });
  });
});
