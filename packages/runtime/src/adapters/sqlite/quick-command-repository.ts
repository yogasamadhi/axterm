import { randomUUID } from 'node:crypto';
import {
  quickCommandSchema,
  type MoveQuickCommandTreeNodeInput,
  type QuickCommand,
  type QuickCommandGroup,
  type QuickCommandGroupInput,
  type QuickCommandGroupPatch,
  type QuickCommandInput,
  type QuickCommandPatch,
  type QuickCommandTree,
  type QuickCommandTreeNode,
} from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import type { ProductDatabase } from './database';

interface GroupRow {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
  version: number;
}

interface CommandRow {
  id: string;
  group_id: string | null;
  name: string;
  payload: string;
  position: number;
  created_at: string;
  updated_at: string;
  version: number;
}

interface TreeNodeRow {
  kind: QuickCommandTreeNode['kind'];
  id: string;
  parent_id: string | null;
  position: number;
}

export const quickCommandTreeEtag = (revision: number): string =>
  `"quick-command-tree-v${revision}"`;

function revisionFromEtag(value: string | undefined): number {
  if (!value)
    throw new ApplicationError(
      'PRECONDITION_REQUIRED',
      'Quick Command tree If-Match is required',
      428,
    );
  const match = /^"quick-command-tree-v(\d+)"$/.exec(value);
  if (!match)
    throw new ApplicationError('PRECONDITION_FAILED', 'Invalid Quick Command tree version', 412);
  return Number(match[1]);
}

function groupFromRow(row: GroupRow): QuickCommandGroup {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function commandFromRow(row: CommandRow): QuickCommand {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const legacyCommand = typeof payload.command === 'string' ? payload.command : '';
  const commands = Array.isArray(payload.commands)
    ? payload.commands
    : [{ id: row.id, name: '', command: legacyCommand, delayMs: 100 }];
  const firstCommand = commands[0] as Record<string, unknown> | undefined;
  return quickCommandSchema.parse({
    id: row.id,
    groupId: row.group_id,
    position: row.position,
    name: row.name,
    command:
      legacyCommand || (typeof firstCommand?.command === 'string' ? firstCommand.command : ''),
    commands,
    description: typeof payload.description === 'string' ? payload.description : '',
    tags: Array.isArray(payload.tags)
      ? payload.tags
      : Array.isArray(payload.labels)
        ? payload.labels
        : [],
    shortcut: typeof payload.shortcut === 'string' && payload.shortcut ? payload.shortcut : null,
    inputOnly: payload.inputOnly === true,
    clickCount:
      typeof payload.clickCount === 'number' && Number.isSafeInteger(payload.clickCount)
        ? Math.max(0, payload.clickCount)
        : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function commandPayload(input: QuickCommandInput | (QuickCommand & QuickCommandPatch)) {
  return {
    name: input.name,
    command: input.commands[0]?.command ?? input.command,
    commands: input.commands,
    description: input.description,
    tags: input.tags,
    shortcut: input.shortcut,
    inputOnly: input.inputOnly,
    clickCount: input.clickCount,
  };
}

export class QuickCommandRepository {
  constructor(private readonly database: ProductDatabase) {}

  snapshot(): QuickCommandTree {
    const revision = this.readRevision();
    return {
      revision,
      etag: quickCommandTreeEtag(revision),
      groups: this.database
        .all<GroupRow>(
          `SELECT * FROM quick_command_groups
           ORDER BY COALESCE(parent_id, ''), position, lower(name), id`,
        )
        .map(groupFromRow),
      commands: this.database
        .all<CommandRow>(
          `SELECT * FROM quick_commands
           ORDER BY COALESCE(group_id, ''), position, lower(name), id`,
        )
        .map(commandFromRow),
    };
  }

  createGroup(input: QuickCommandGroupInput, ifMatch: string | undefined): QuickCommandTree {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      if (input.parentId) this.requireGroup(input.parentId);
      const id = randomUUID();
      const now = new Date().toISOString();
      const position = this.listChildren(input.parentId).length;
      this.database.run(
        `INSERT INTO quick_command_groups(
          id, parent_id, name, position, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        id,
        input.parentId,
        input.name,
        position,
        now,
        now,
      );
      const revision = this.advanceRevision();
      this.database.appendEvent('quick-command-group.created', id, {
        id,
        parentId: input.parentId,
        name: input.name,
        position,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  updateGroup(
    id: string,
    input: QuickCommandGroupPatch,
    ifMatch: string | undefined,
  ): QuickCommandTree {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      const current = this.requireGroup(id);
      const name = input.name ?? current.name;
      const now = new Date().toISOString();
      this.database.run(
        `UPDATE quick_command_groups
         SET name=?, updated_at=?, version=version+1 WHERE id=?`,
        name,
        now,
        id,
      );
      const revision = this.advanceRevision();
      this.database.appendEvent('quick-command-group.updated', id, {
        id,
        name,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  deleteGroup(id: string, ifMatch: string | undefined): QuickCommandTree {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      const group = this.requireGroup(id);
      const parentChildren = this.listChildren(group.parent_id);
      const index = parentChildren.findIndex((node) => node.kind === 'group' && node.id === id);
      if (index < 0)
        throw new ApplicationError('INVALID_STATE', 'Quick Command folder has no parent entry');
      const promoted = this.listChildren(id);
      const next = parentChildren.filter((node) => !(node.kind === 'group' && node.id === id));
      next.splice(index, 0, ...promoted);
      const now = new Date().toISOString();
      this.reindex(group.parent_id, next, now);
      this.database.run('DELETE FROM quick_command_groups WHERE id=?', id);
      const revision = this.advanceRevision();
      this.database.appendEvent('quick-command-group.deleted', id, {
        id,
        promoted: promoted.map(({ kind, id: promotedId }) => ({ kind, id: promotedId })),
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  createCommand(input: QuickCommandInput, ifMatch: string | undefined): QuickCommandTree {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      if (input.groupId) this.requireGroup(input.groupId);
      const id = randomUUID();
      const now = new Date().toISOString();
      const position = this.listChildren(input.groupId).length;
      this.database.run(
        `INSERT INTO quick_commands(
          id, group_id, name, payload, position, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        id,
        input.groupId,
        input.name,
        JSON.stringify(commandPayload(input)),
        position,
        now,
        now,
      );
      const revision = this.advanceRevision();
      this.database.appendEvent('quick-command.created', id, {
        id,
        groupId: input.groupId,
        name: input.name,
        stepCount: input.commands.length,
        position,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  updateCommand(
    id: string,
    input: QuickCommandPatch,
    ifMatch: string | undefined,
  ): QuickCommandTree {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      const current = commandFromRow(this.requireCommand(id));
      const next: QuickCommand = {
        ...current,
        name: input.name ?? current.name,
        command: input.commands?.[0]?.command ?? input.command ?? current.command,
        commands: input.commands ?? current.commands,
        description: input.description ?? current.description,
        tags: input.tags ?? current.tags,
        shortcut: input.shortcut === undefined ? current.shortcut : input.shortcut,
        inputOnly: input.inputOnly ?? current.inputOnly,
        clickCount: input.clickCount ?? current.clickCount,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.database.run(
        `UPDATE quick_commands
         SET name=?, payload=?, updated_at=?, version=version+1 WHERE id=?`,
        next.name,
        JSON.stringify(commandPayload(next)),
        next.updatedAt,
        id,
      );
      const revision = this.advanceRevision();
      this.database.appendEvent('quick-command.updated', id, {
        id,
        name: next.name,
        stepCount: next.commands.length,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  deleteCommand(id: string, ifMatch: string | undefined): QuickCommandTree {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      const current = this.requireCommand(id);
      this.database.run('DELETE FROM quick_commands WHERE id=?', id);
      this.reindex(current.group_id, this.listChildren(current.group_id), new Date().toISOString());
      const revision = this.advanceRevision();
      this.database.appendEvent('quick-command.deleted', id, {
        id,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  move(input: MoveQuickCommandTreeNodeInput, ifMatch: string | undefined): QuickCommandTree {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      if (input.source.kind === input.target.kind && input.source.id === input.target.id)
        throw new ApplicationError('CONFLICT', 'A Quick Command node cannot be moved onto itself');
      const source = this.requireNode(input.source);
      const target = this.requireNode(input.target);
      if (input.position === 'inside' && target.kind !== 'group')
        throw new ApplicationError(
          'CONFLICT',
          'Only a Quick Command folder accepts an inside drop',
        );
      const destination = input.position === 'inside' ? target.id : target.parent_id;
      if (source.kind === 'group') this.assertAcyclic(source.id, destination);
      const sourceSiblings = this.listChildren(source.parent_id).filter(
        (node) => !(node.kind === source.kind && node.id === source.id),
      );
      const destinationSiblings =
        destination === source.parent_id
          ? sourceSiblings
          : this.listChildren(destination).filter(
              (node) => !(node.kind === source.kind && node.id === source.id),
            );
      let insertion = destinationSiblings.length;
      if (input.position !== 'inside') {
        const targetIndex = destinationSiblings.findIndex(
          (node) => node.kind === target.kind && node.id === target.id,
        );
        if (targetIndex < 0)
          throw new ApplicationError('INVALID_STATE', 'Quick Command drop target is unavailable');
        insertion = targetIndex + (input.position === 'after' ? 1 : 0);
      }
      destinationSiblings.splice(insertion, 0, { ...source, parent_id: destination });
      const now = new Date().toISOString();
      if (destination !== source.parent_id) this.reindex(source.parent_id, sourceSiblings, now);
      this.reindex(destination, destinationSiblings, now);
      const revision = this.advanceRevision();
      this.database.appendEvent('quick-command-tree.moved', input.source.id, {
        ...input,
        fromParentId: source.parent_id,
        toParentId: destination,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  replacePortable(
    groups: readonly QuickCommandGroup[],
    commands: readonly QuickCommand[],
    ifMatch: string | undefined,
  ): QuickCommandTree {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      this.database.run('DELETE FROM quick_commands');
      this.database.run('DELETE FROM quick_command_groups');
      for (const group of topologicalGroups(groups))
        this.database.run(
          `INSERT INTO quick_command_groups(
            id, parent_id, name, position, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          group.id,
          group.parentId,
          group.name,
          group.position,
          group.createdAt,
          group.updatedAt,
          group.version,
        );
      for (const command of commands)
        this.database.run(
          `INSERT INTO quick_commands(
            id, group_id, name, payload, position, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          command.id,
          command.groupId,
          command.name,
          JSON.stringify(commandPayload(command)),
          command.position,
          command.createdAt,
          command.updatedAt,
          command.version,
        );
      const revision = this.advanceRevision();
      this.database.appendEvent('quick-command-tree.replaced', 'quick-command-tree', {
        groupCount: groups.length,
        commandCount: commands.length,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  private readRevision(): number {
    const row = this.database.get<{ value: string }>(
      "SELECT value FROM app_meta WHERE key='quick-command-tree:revision'",
    );
    const revision = Number(row?.value);
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new ApplicationError('INVALID_STATE', 'Quick Command tree revision is unavailable');
    return revision;
  }

  private requireRevision(ifMatch: string | undefined): void {
    if (revisionFromEtag(ifMatch) !== this.readRevision())
      throw new ApplicationError('PRECONDITION_FAILED', 'Quick Command tree changed', 412);
  }

  private advanceRevision(): number {
    const result = this.database.run(
      `UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
       WHERE key='quick-command-tree:revision'`,
    );
    if (!result.changes)
      throw new ApplicationError('INVALID_STATE', 'Quick Command tree revision is unavailable');
    return this.readRevision();
  }

  private requireGroup(id: string): GroupRow {
    const row = this.database.get<GroupRow>('SELECT * FROM quick_command_groups WHERE id=?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Quick Command folder not found', 404);
    return row;
  }

  private requireCommand(id: string): CommandRow {
    const row = this.database.get<CommandRow>('SELECT * FROM quick_commands WHERE id=?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Quick Command not found', 404);
    return row;
  }

  private requireNode(ref: QuickCommandTreeNode): TreeNodeRow {
    if (ref.kind === 'group') {
      const row = this.requireGroup(ref.id);
      return { kind: 'group', id: row.id, parent_id: row.parent_id, position: row.position };
    }
    const row = this.requireCommand(ref.id);
    return { kind: 'command', id: row.id, parent_id: row.group_id, position: row.position };
  }

  private listChildren(parentId: string | null): TreeNodeRow[] {
    return this.database.all<TreeNodeRow>(
      `SELECT 'group' AS kind, id, parent_id, position
       FROM quick_command_groups WHERE parent_id IS ?
       UNION ALL
       SELECT 'command' AS kind, id, group_id AS parent_id, position
       FROM quick_commands WHERE group_id IS ?
       ORDER BY position, kind DESC, id`,
      parentId,
      parentId,
    );
  }

  private reindex(parentId: string | null, nodes: TreeNodeRow[], now: string): void {
    nodes.forEach((node, position) => {
      if (node.kind === 'group')
        this.database.run(
          `UPDATE quick_command_groups
           SET parent_id=?, position=?, updated_at=?, version=version+1 WHERE id=?`,
          parentId,
          position,
          now,
          node.id,
        );
      else
        this.database.run(
          `UPDATE quick_commands
           SET group_id=?, position=?, updated_at=?, version=version+1 WHERE id=?`,
          parentId,
          position,
          now,
          node.id,
        );
    });
  }

  private assertAcyclic(groupId: string, parentId: string | null): void {
    const visited = new Set<string>();
    let cursor = parentId;
    while (cursor) {
      if (cursor === groupId)
        throw new ApplicationError('CONFLICT', 'Quick Command folder cycle detected');
      if (visited.has(cursor))
        throw new ApplicationError('INVALID_STATE', 'Stored Quick Command folder cycle detected');
      visited.add(cursor);
      cursor = this.requireGroup(cursor).parent_id;
    }
  }
}

function topologicalGroups(groups: readonly QuickCommandGroup[]): QuickCommandGroup[] {
  const pending = new Map(groups.map((group) => [group.id, group]));
  const ordered: QuickCommandGroup[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(
      ({ parentId }) => parentId === null || !pending.has(parentId),
    );
    if (!ready.length)
      throw new ApplicationError('VALIDATION_ERROR', 'Quick Command folder cycle detected', 400);
    ready.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    for (const group of ready) {
      pending.delete(group.id);
      ordered.push(group);
    }
  }
  return ordered;
}
