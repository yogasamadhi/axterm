import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import type { RuntimeClientError } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function launch(dataDirectory: string) {
  const runtime = await startRuntime({
    generation: randomUUID(),
    appVersion: '0.10.0',
    mode: 'headless',
    dataDirectory,
  });
  runtimes.push(runtime);
  return runtime;
}

describe('Connection Profile Runtime API', () => {
  it('persists five-protocol Profiles, enforces ETags and keeps one default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-connection-profile-runtime-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });

    const first = await client.createConnectionProfile({ name: 'Personal' });
    expect(first.isDefault).toBe(true);
    const production = await client.createConnectionProfile({
      name: 'Production',
      isDefault: true,
      ssh: {
        username: 'deploy',
        passwordCredentialRef: 'credential-password',
        privateKeyCredentialRef: 'credential-key',
        passphraseCredentialRef: 'credential-passphrase',
        certificateCredentialRef: 'credential-certificate',
      },
      telnet: { username: 'legacy', passwordCredentialRef: 'credential-telnet' },
    });
    expect(
      (await client.connectionProfiles()).map(({ name, isDefault }) => ({ name, isDefault })),
    ).toEqual([
      { name: 'Production', isDefault: true },
      { name: 'Personal', isDefault: false },
    ]);

    const renamed = await client.updateConnectionProfile(production, { name: 'Production v2' });
    await expect(
      client.updateConnectionProfile(production, { name: 'stale write' }),
    ).rejects.toMatchObject<Partial<RuntimeClientError>>({
      code: 'PRECONDITION_FAILED',
      status: 412,
    });
    expect(renamed.version).toBe(production.version + 1);

    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    runtime = await launch(directory);
    client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const restored = await client.connectionProfiles();
    expect(restored[0]).toMatchObject({
      name: 'Production v2',
      isDefault: true,
      ssh: {
        username: 'deploy',
        privateKeyCredentialRef: 'credential-key',
      },
      telnet: { username: 'legacy', passwordCredentialRef: 'credential-telnet' },
    });
  });

  it('persists a Profile assignment independently from the Terminal Profile and blocks deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-assigned-profile-runtime-'));
    directories.push(directory);
    const runtime = await launch(directory);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const profile = await client.createConnectionProfile({ name: 'Assigned identity' });
    const tree = await client.bookmarkTree();
    const saved = await client.createSshBookmark(tree, {
      host: {
        name: 'Profile target',
        hostname: 'profile.example.test',
        username: 'fallback-user',
        authType: 'agent',
      },
      bookmark: {
        title: 'Profile target',
        profileId: null,
        connectionProfileId: profile.id,
      },
    });

    expect(saved.bookmark).toMatchObject({
      profileId: null,
      connectionProfileId: profile.id,
    });
    await expect(client.deleteConnectionProfile(profile)).rejects.toMatchObject<
      Partial<RuntimeClientError>
    >({ code: 'CONFLICT', status: 409 });
  });
});
