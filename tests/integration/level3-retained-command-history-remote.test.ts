import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';

const runtimes: Awaited<ReturnType<typeof remoteProfile>>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function launch(dataDirectory: string) {
  const runtime = await remoteProfile(dataDirectory, { terminals: true });
  await runtime.client.plugin(Terminals);
  await vi.waitFor(() =>
    expect(runtime.client.terminalFactsModel.getSnapshot().status).toBe('ready'),
  );
  runtimes.push(runtime);
  return runtime;
}

function record(
  model: Terminals.TerminalFactsModel,
  terminalId: string,
  command: string,
  key = randomUUID(),
) {
  return model.recordCommandHistory(key, { terminalId, command, source: 'shellIntegration' });
}

describe('command history Runtime contract', () => {
  it('persists bounded safe commands and exposes retry-safe search, delete, clear and privacy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-command-history-runtime-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = runtime.client.terminalFactsModel;
    let terminal = await runtime.client.terminalsModel.create({
      kind: 'local',
      cols: 80,
      rows: 24,
    });

    const disabledKey = randomUUID();
    const disabled = await record(client, terminal.id, 'echo disabled', disabledKey);
    expect(disabled).toMatchObject({ recorded: false, reason: 'disabled' });
    expect(await record(client, terminal.id, 'echo disabled', disabledKey)).toEqual(disabled);
    await expect(record(client, terminal.id, 'echo changed', disabledKey)).rejects.toMatchObject({
      code: 'terminals/failure',
      details: { reason: 'conflict' },
    });

    const disabledSettings = await remoteValue(runtime.client.remote.configuration.getSettings());
    await runtime.client.settingsModel.updateSettings(
      randomUUID(),
      {
        privacy: { commandHistoryEnabled: true },
      },
      '"v' + disabledSettings.version + '"',
    );
    const sensitive = 'export RUNTIME_SECRET=runtime-secret-marker';
    expect(await record(client, terminal.id, sensitive)).toMatchObject({
      recorded: false,
      reason: 'sensitive',
    });
    await expect(record(client, terminal.id, ' leading-space')).rejects.toMatchObject({
      code: 'terminals/failure',
      details: { reason: 'invalid-input' },
    });

    const recordKey = randomUUID();
    const first = await record(client, terminal.id, 'git status', recordKey);
    expect(first).toMatchObject({ recorded: true, count: 1 });
    expect(await record(client, terminal.id, 'git status', recordKey)).toEqual(first);
    expect(await record(client, terminal.id, 'git status')).toMatchObject({
      recorded: true,
      count: 2,
    });
    await record(client, terminal.id, 'printf 100%_done');
    expect((await client.listCommandHistory({ sort: 'frequency' })).items[0]).toMatchObject({
      command: 'git status',
      count: 2,
    });
    expect(
      (await client.listCommandHistory({ search: '%_' })).items.map(({ command }) => command),
    ).toEqual(['printf 100%_done']);

    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    expect(
      (await readFile(join(directory, 'data-v2', 'axterm.sqlite'))).toString('utf8'),
    ).not.toContain('runtime-secret-marker');

    runtime = await launch(directory);
    client = runtime.client.terminalFactsModel;
    expect((await client.listCommandHistory({ sort: 'frequency' })).items[0]).toMatchObject({
      command: 'git status',
      count: 2,
    });
    terminal = await runtime.client.terminalsModel.create({ kind: 'local', cols: 80, rows: 24 });
    const current = await client.listCommandHistory();
    const removable = current.items.find(({ command }) => command === 'printf 100%_done')!;
    const deleteKey = randomUUID();
    const deleted = await client.deleteCommandHistory(
      deleteKey,
      removable.id,
      '"v' + removable.version + '"',
    );
    expect(
      await client.deleteCommandHistory(deleteKey, removable.id, '"v' + removable.version + '"'),
    ).toEqual(deleted);

    const beforeClear = await client.listCommandHistory();
    const clearKey = randomUUID();
    const cleared = await client.clearCommandHistory(clearKey, beforeClear.etag);
    expect(cleared.deletedCount).toBe(1);
    expect(await client.clearCommandHistory(clearKey, beforeClear.etag)).toEqual(cleared);
    expect((await client.listCommandHistory()).items).toEqual([]);

    await record(client, terminal.id, 'echo before-disable');
    const enabledSettings = await remoteValue(runtime.client.remote.configuration.getSettings());
    await runtime.client.settingsModel.updateSettings(
      randomUUID(),
      { privacy: { commandHistoryEnabled: false } },
      '"v' + enabledSettings.version + '"',
    );
    expect((await client.listCommandHistory()).items).toEqual([]);
  }, 15_000);
});
