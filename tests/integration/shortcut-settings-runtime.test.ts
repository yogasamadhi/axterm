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
    appVersion: '0.19.0',
    mode: 'headless',
    dataDirectory,
  });
  runtimes.push(runtime);
  return runtime;
}

describe('shortcut settings Runtime contract', () => {
  it('persists editable action bindings across Runtime generations and preserves sparse updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-shortcuts-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const initial = await client.settings();
    expect(initial.shortcuts).toEqual({ bindings: {} });

    const updated = await client.updateSettings(initial, {
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

    client.dispose();
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    runtime = await launch(directory);
    client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    expect((await client.settings()).shortcuts).toEqual(updated.shortcuts);
    client.dispose();
  });

  it('rejects stale ETags and conflicting action bindings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-shortcuts-conflict-'));
    directories.push(directory);
    const runtime = await launch(directory);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const initial = await client.settings();
    await client.updateSettings(initial, {
      shortcuts: { bindings: { app_newTab: ['alt+shift+t'] } },
    });
    await expect(
      client.updateSettings(initial, {
        shortcuts: { bindings: { app_newTab: ['alt+shift+n'] } },
      }),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      client.updateSettings(await client.settings(), {
        shortcuts: {
          bindings: {
            app_newTab: ['alt+shift+t'],
            app_closeCurrentTab: ['alt+shift+t'],
          },
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    client.dispose();
  });
});
