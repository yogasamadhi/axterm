import { describe, expect, it } from 'vitest';
import type { QuickCommandTree } from '../../packages/contracts/src/index';
import {
  buildQuickCommandRows,
  quickCommandDropPosition,
  quickCommandTextForInsert,
} from '../../apps/desktop/src/renderer/src/app/quick-commands/quick-command-model';

const timestamp = '2026-09-13T00:00:00.000Z';
const rootId = '00000000-0000-4000-8000-000000000001';
const childId = '00000000-0000-4000-8000-000000000002';
const commandId = '00000000-0000-4000-8000-000000000003';
const tree: QuickCommandTree = {
  revision: 1,
  etag: '"quick-command-tree-v1"',
  groups: [
    {
      id: rootId,
      parentId: null,
      name: 'Production',
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
    {
      id: childId,
      parentId: rootId,
      name: 'Database',
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
  ],
  commands: [
    {
      id: commandId,
      groupId: childId,
      position: 0,
      name: 'Inspect replication',
      command: 'echo {{clipboard}}',
      commands: [
        {
          id: '00000000-0000-4000-8000-000000000004',
          name: 'status',
          command: 'echo {{clipboard}}',
          delayMs: 100,
        },
        {
          id: '00000000-0000-4000-8000-000000000005',
          name: 'when',
          command: 'echo {{date}} {{time}}',
          delayMs: 250,
        },
      ],
      description: 'Checks database replicas',
      tags: ['postgres'],
      shortcut: null,
      inputOnly: true,
      clickCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
  ],
};

describe('Quick Command renderer model', () => {
  it('reveals ancestor folders when a nested command matches search', () => {
    const rows = buildQuickCommandRows(tree, new Set(), 'postgres');

    expect(rows.map(({ name, depth }) => [name, depth])).toEqual([
      ['Production', 0],
      ['Database', 1],
      ['Inspect replication', 2],
    ]);
    expect(rows.at(-1)?.matched).toBe(true);
  });

  it('expands all supported templates once and preserves multi-line order', async () => {
    const text = await quickCommandTextForInsert(
      tree.commands[0]!,
      async () => 'copied value',
      new Date('2026-09-13T12:34:56.000Z'),
    );

    expect(text).toContain('echo copied value && ');
    expect(text).toContain(String(new Date('2026-09-13T12:34:56.000Z').getTime()));
    expect(text).not.toContain('{{');
  });

  it('uses the middle of a folder as an inside drop target', () => {
    expect(quickCommandDropPosition('group', 50, 0, 100)).toBe('inside');
    expect(quickCommandDropPosition('group', 10, 0, 100)).toBe('before');
    expect(quickCommandDropPosition('command', 80, 0, 100)).toBe('after');
  });
});
