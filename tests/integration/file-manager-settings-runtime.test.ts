import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function launch(dataDirectory: string) {
  const runtime = await startRuntime({
    generation: randomUUID(),
    appVersion: '0.16.0',
    mode: 'headless',
    dataDirectory,
  });
  runtimes.push(runtime);
  return runtime;
}

describe('file-manager settings Runtime contract', () => {
  it('persists remote address bookmarks across Runtime generations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-file-manager-settings-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const current = await client.settings();
    const bookmark = {
      id: randomUUID(),
      hostId: randomUUID(),
      path: '/srv/应用日志',
    };
    const updated = await client.updateSettings(current, {
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
    client.dispose();
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);

    runtime = await launch(directory);
    client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    expect((await client.settings()).fileManager).toEqual(updated.fileManager);
    client.dispose();
  });
});
