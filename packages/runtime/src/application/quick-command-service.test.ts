import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductDatabase } from '../adapters/sqlite/database';
import { QuickCommandRepository } from '../adapters/sqlite/quick-command-repository';
import { QuickCommandService } from './quick-command-service';

const databases: ProductDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function input(name: string, groupId: string | null = null) {
  const command = `printf '${name}'`;
  return {
    groupId,
    name,
    command,
    commands: [
      { id: crypto.randomUUID(), name: 'first', command, delayMs: 100 },
      {
        id: crypto.randomUUID(),
        name: 'templated',
        command: 'printf "{{clipboard}} {{date}} {{time}}"',
        delayMs: 250,
      },
    ],
    description: `${name} command`,
    tags: ['ops', 'ops'],
    shortcut: null,
    inputOnly: true,
    clickCount: 0,
  };
}

describe('QuickCommandService', () => {
  it('persists nested folders, ordered multi-step commands and guarded moves', async () => {
    const database = await ProductDatabase.open();
    databases.push(database);
    const service = new QuickCommandService(new QuickCommandRepository(database));
    let tree = service.snapshot();
    tree = service.createGroup({ parentId: null, name: 'Production' }, tree.etag);
    const production = tree.groups[0]!;
    tree = service.createGroup({ parentId: production.id, name: 'Database' }, tree.etag);
    const databaseFolder = tree.groups.find(({ name }) => name === 'Database')!;
    tree = service.createCommand(input('Health', production.id), tree.etag);
    tree = service.createCommand(input('Vacuum', databaseFolder.id), tree.etag);
    const health = tree.commands.find(({ name }) => name === 'Health')!;
    const vacuum = tree.commands.find(({ name }) => name === 'Vacuum')!;

    tree = service.move(
      {
        source: { kind: 'command', id: health.id },
        target: { kind: 'command', id: vacuum.id },
        position: 'after',
      },
      tree.etag,
    );

    expect(tree.commands.find(({ id }) => id === health.id)).toMatchObject({
      groupId: databaseFolder.id,
      position: 1,
      tags: ['ops'],
      inputOnly: true,
    });
    expect(tree.commands.find(({ id }) => id === health.id)?.commands).toHaveLength(2);
    expect(() =>
      service.move(
        {
          source: { kind: 'group', id: production.id },
          target: { kind: 'group', id: databaseFolder.id },
          position: 'inside',
        },
        tree.etag,
      ),
    ).toThrow(/cycle/i);
    expect(() => service.deleteCommand(health.id, '"quick-command-tree-v1"')).toThrow(/changed/i);

    const beforeDelete = tree.etag;
    tree = service.deleteGroup(databaseFolder.id, beforeDelete);
    expect(tree.groups).toHaveLength(1);
    expect(tree.commands.every(({ groupId }) => groupId === production.id)).toBe(true);
  });

  it('migrates a legacy flat command without losing its command text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-quick-command-'));
    directories.push(directory);
    const path = join(directory, 'legacy.sqlite');
    const initialized = await ProductDatabase.open(path);
    initialized.close();
    const legacy = new DatabaseSync(path);
    const commandId = crypto.randomUUID();
    legacy
      .prepare("DELETE FROM app_meta WHERE key IN ('migration:25', 'quick-command-tree:revision')")
      .run();
    legacy.exec('DROP INDEX quick_commands_group_position; DROP TABLE quick_command_groups;');
    legacy.exec('ALTER TABLE quick_commands DROP COLUMN position;');
    legacy.exec('ALTER TABLE quick_commands DROP COLUMN group_id;');
    legacy
      .prepare(
        `INSERT INTO quick_commands(id, name, payload, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .run(
        commandId,
        'Legacy',
        JSON.stringify({ name: 'Legacy', command: 'uname -a', description: '', tags: [] }),
        '2026-09-13T00:00:00.000Z',
        '2026-09-13T00:00:00.000Z',
      );
    legacy.close();

    const database = await ProductDatabase.open(path);
    databases.push(database);
    const tree = new QuickCommandService(new QuickCommandRepository(database)).snapshot();

    expect(tree.commands).toEqual([
      expect.objectContaining({
        id: commandId,
        groupId: null,
        position: 0,
        command: 'uname -a',
        commands: [{ id: commandId, name: '', command: 'uname -a', delayMs: 100 }],
      }),
    ]);
    expect(database.get("SELECT value FROM app_meta WHERE key='migration:25'")).toBeDefined();
  });
});
