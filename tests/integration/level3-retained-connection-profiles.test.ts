import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionProfilePatch,
  BookmarkTree,
  CreateSshBookmarkInput,
} from '@axterm/plugin-api/catalog';

const runtimes: Awaited<ReturnType<typeof remoteProfile>>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function launch(home: string) {
  const runtime = await remoteProfile(home);
  runtimes.push(runtime);
  return runtime;
}
const profiles = (client: Context) => remoteValue(client.remote.catalog.listConnectionProfiles());
async function createProfile(client: Context, input: ConnectionProfileInput) {
  const receipt = await remoteValue(
    client.remote.catalog.createConnectionProfile(randomUUID(), input),
  );
  return remoteValue(client.remote.catalog.getConnectionProfile(receipt.ids[0]!));
}
async function updateProfile(
  client: Context,
  profile: ConnectionProfile,
  input: ConnectionProfilePatch,
) {
  await remoteValue(
    client.remote.catalog.updateConnectionProfile(
      randomUUID(),
      profile.id,
      input,
      '"v' + profile.version + '"',
    ),
  );
  return remoteValue(client.remote.catalog.getConnectionProfile(profile.id));
}
const deleteProfile = (client: Context, profile: ConnectionProfile) =>
  remoteValue(
    client.remote.catalog.deleteConnectionProfile(
      randomUUID(),
      profile.id,
      '"v' + profile.version + '"',
    ),
  );
async function saveSsh(client: Context, tree: BookmarkTree, input: CreateSshBookmarkInput) {
  const receipt = await remoteValue(
    client.remote.catalog.createSshBookmark(randomUUID(), input, tree.etag),
  );
  return { bookmark: await remoteValue(client.remote.catalog.getBookmark(receipt.ids[1]!)) };
}

describe('Connection Profile Runtime API', () => {
  it('persists five-protocol Profiles, enforces ETags and keeps one default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-connection-profile-runtime-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = runtime.client;

    const first = await createProfile(client, { name: 'Personal' });
    expect(first.isDefault).toBe(true);
    const production = await createProfile(client, {
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
    expect((await profiles(client)).map(({ name, isDefault }) => ({ name, isDefault }))).toEqual([
      { name: 'Production', isDefault: true },
      { name: 'Personal', isDefault: false },
    ]);

    const renamed = await updateProfile(client, production, { name: 'Production v2' });
    await expect(updateProfile(client, production, { name: 'stale write' })).rejects.toMatchObject({
      code: 'catalog/failure',
      details: { reason: 'precondition-failed' },
    });
    expect(renamed.version).toBe(production.version + 1);

    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    runtime = await launch(directory);
    client = runtime.client;
    const restored = await profiles(client);
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
    const client = runtime.client;
    const profile = await createProfile(client, { name: 'Assigned identity' });
    const tree = await remoteValue(client.remote.catalog.getBookmarkTree());
    const saved = await saveSsh(client, tree, {
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
    await expect(deleteProfile(client, profile)).rejects.toMatchObject({
      code: 'catalog/failure',
      details: { reason: 'conflict' },
    });
  });
});
