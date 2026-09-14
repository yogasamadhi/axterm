import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    appVersion: '0.10.0',
    mode: 'headless',
    dataDirectory,
  });
  runtimes.push(runtime);
  return runtime;
}

describe('command history Runtime contract', () => {
  it('persists bounded safe commands and exposes retry-safe search, delete, clear and privacy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-command-history-runtime-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    await client.status();
    let terminal = await client.createTerminal({ kind: 'local', cols: 80, rows: 24 });

    const disabledKey = randomUUID();
    const disabled = await client.recordCommandHistory(terminal.id, 'echo disabled', disabledKey);
    expect(disabled).toMatchObject({ recorded: false, reason: 'disabled' });
    expect(await client.recordCommandHistory(terminal.id, 'echo disabled', disabledKey)).toEqual(
      disabled,
    );
    await expect(
      client.recordCommandHistory(terminal.id, 'echo changed', disabledKey),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

    const disabledSettings = await client.settings();
    await client.updateSettings(disabledSettings, {
      privacy: { commandHistoryEnabled: true },
    });
    const sensitive = 'export RUNTIME_SECRET=runtime-secret-marker';
    expect(await client.recordCommandHistory(terminal.id, sensitive)).toMatchObject({
      recorded: false,
      reason: 'sensitive',
    });
    await expect(client.recordCommandHistory(terminal.id, ' leading-space')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });

    const recordKey = randomUUID();
    const first = await client.recordCommandHistory(terminal.id, 'git status', recordKey);
    expect(first).toMatchObject({ recorded: true, count: 1 });
    expect(await client.recordCommandHistory(terminal.id, 'git status', recordKey)).toEqual(first);
    expect(await client.recordCommandHistory(terminal.id, 'git status')).toMatchObject({
      recorded: true,
      count: 2,
    });
    await client.recordCommandHistory(terminal.id, 'printf 100%_done');
    expect((await client.commandHistory({ sort: 'frequency' })).items[0]).toMatchObject({
      command: 'git status',
      count: 2,
    });
    expect(
      (await client.commandHistory({ search: '%_' })).items.map(({ command }) => command),
    ).toEqual(['printf 100%_done']);

    client.dispose();
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    expect((await readFile(join(directory, 'axterm.sqlite'))).toString('utf8')).not.toContain(
      'runtime-secret-marker',
    );

    runtime = await launch(directory);
    client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    expect((await client.commandHistory({ sort: 'frequency' })).items[0]).toMatchObject({
      command: 'git status',
      count: 2,
    });
    terminal = await client.createTerminal({ kind: 'local', cols: 80, rows: 24 });
    const current = await client.commandHistory();
    const removable = current.items.find(({ command }) => command === 'printf 100%_done')!;
    const deleteKey = randomUUID();
    const deleted = await client.deleteCommandHistory(removable, deleteKey);
    expect(await client.deleteCommandHistory(removable, deleteKey)).toEqual(deleted);

    const beforeClear = await client.commandHistory();
    const clearKey = randomUUID();
    const cleared = await client.clearCommandHistory(beforeClear, clearKey);
    expect(cleared.deletedCount).toBe(1);
    expect(await client.clearCommandHistory(beforeClear, clearKey)).toEqual(cleared);
    expect((await client.commandHistory()).items).toEqual([]);

    await client.recordCommandHistory(terminal.id, 'echo before-disable');
    const enabledSettings = await client.settings();
    await client.updateSettings(enabledSettings, { privacy: { commandHistoryEnabled: false } });
    expect((await client.commandHistory()).items).toEqual([]);
    client.dispose();
  }, 15_000);
});
