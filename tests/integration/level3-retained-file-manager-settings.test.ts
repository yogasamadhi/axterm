import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { Settings, UpdateSettingsInput } from '@axterm/plugin-api/configuration';

const runtimes: Awaited<ReturnType<typeof remoteProfile>>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function launch(home: string) {
  const runtime = await remoteProfile(home);
  runtimes.push(runtime);
  return runtime;
}
const getSettings = (client: Context) => remoteValue(client.remote.configuration.getSettings());
async function saveSettings(client: Context, current: Settings, patch: UpdateSettingsInput) {
  await remoteValue(
    client.remote.configuration.updateSettings(randomUUID(), patch, '"v' + current.version + '"'),
  );
  return getSettings(client);
}

describe('file-manager settings Runtime contract', () => {
  it('persists remote address bookmarks across Runtime generations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-file-manager-settings-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = runtime.client;
    const current = await getSettings(client);
    const bookmark = {
      id: randomUUID(),
      hostId: randomUUID(),
      path: '/srv/应用日志',
    };
    const updated = await saveSettings(client, current, {
      fileManager: {
        showHiddenFiles: false,
        externalEditor: '/usr/bin/vi',
        refreshOnFocus: true,
        followTerminalCwd: true,
        sshSplitView: true,
        remoteAddressBookmarks: [bookmark],
        columns: ['name', 'owner', 'mode'],
        remoteSort: { property: 'name', direction: 'asc' },
      },
    });
    expect(updated.fileManager).toEqual({
      showHiddenFiles: false,
      externalEditor: '/usr/bin/vi',
      refreshOnFocus: true,
      followTerminalCwd: true,
      sshSplitView: true,
      remoteAddressBookmarks: [bookmark],
      columns: ['name', 'owner', 'mode'],
      localSort: { property: 'modifiedAt', direction: 'desc' },
      remoteSort: { property: 'name', direction: 'asc' },
    });
    await client.fiber.dispose();
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);

    runtime = await launch(directory);
    client = runtime.client;
    expect((await getSettings(client)).fileManager).toEqual(updated.fileManager);
    await client.fiber.dispose();
  });
});
