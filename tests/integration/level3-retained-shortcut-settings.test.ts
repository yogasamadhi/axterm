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

describe('shortcut settings Runtime contract', () => {
  it('persists editable action bindings across Runtime generations and preserves sparse updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-shortcuts-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = runtime.client;
    const initial = await getSettings(client);
    expect(initial.shortcuts).toEqual({ bindings: {} });

    const updated = await saveSettings(client, initial, {
      shortcuts: {
        bindings: {
          app_newTab: ['alt+shift+t'],
          terminal_search: [],
        },
      },
    });
    expect(updated.shortcuts.bindings).toEqual({
      app_newTab: ['alt+shift+t'],
      terminal_search: [],
    });
    expect(updated.terminal).toEqual(initial.terminal);

    await client.fiber.dispose();
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    runtime = await launch(directory);
    client = runtime.client;
    expect((await getSettings(client)).shortcuts).toEqual(updated.shortcuts);
    await client.fiber.dispose();
  });

  it('rejects stale ETags and conflicting action bindings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-shortcuts-conflict-'));
    directories.push(directory);
    const runtime = await launch(directory);
    const client = runtime.client;
    const initial = await getSettings(client);
    await saveSettings(client, initial, {
      shortcuts: { bindings: { app_newTab: ['alt+shift+t'] } },
    });
    await expect(
      saveSettings(client, initial, {
        shortcuts: { bindings: { app_newTab: ['alt+shift+n'] } },
      }),
    ).rejects.toMatchObject({
      code: 'configuration/failure',
      details: { reason: 'precondition-failed' },
    });
    await expect(
      saveSettings(client, await getSettings(client), {
        shortcuts: {
          bindings: {
            app_newTab: ['alt+shift+t'],
            app_closeCurrentTab: ['alt+shift+t'],
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'configuration/failure',
      details: { reason: 'invalid-input' },
    });
    await client.fiber.dispose();
  });
});
