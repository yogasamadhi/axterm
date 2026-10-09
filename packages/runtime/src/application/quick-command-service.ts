import {
  quickCommandTreeSchema,
  type QuickCommand,
  type QuickCommandGroup,
  type MoveQuickCommandTreeNodeInput,
  type QuickCommandGroupInput,
  type QuickCommandGroupPatch,
  type QuickCommandInput,
  type QuickCommandPatch,
  type QuickCommandTree,
} from '@workspace/contracts';
import type { QuickCommandRepository } from '../adapters/sqlite/quick-command-repository';
import { ApplicationError } from './errors';

const maximumNodes = 5_000;
const maximumCommandBytes = 128 * 1024;

export class QuickCommandService {
  constructor(private readonly repository: QuickCommandRepository) {}

  snapshot(): QuickCommandTree {
    return this.repository.snapshot();
  }

  createGroup(input: QuickCommandGroupInput, ifMatch: string | undefined): QuickCommandTree {
    this.assertCapacity();
    return this.repository.createGroup(
      { parentId: input.parentId, name: requiredName(input.name, 'Quick Command folder') },
      ifMatch,
    );
  }

  updateGroup(
    id: string,
    input: QuickCommandGroupPatch,
    ifMatch: string | undefined,
  ): QuickCommandTree {
    if (!Object.keys(input).length)
      throw new ApplicationError('INVALID_STATE', 'Quick Command folder update is empty');
    return this.repository.updateGroup(
      id,
      input.name === undefined ? {} : { name: requiredName(input.name, 'Quick Command folder') },
      ifMatch,
    );
  }

  deleteGroup(id: string, ifMatch: string | undefined): QuickCommandTree {
    return this.repository.deleteGroup(id, ifMatch);
  }

  createCommand(input: QuickCommandInput, ifMatch: string | undefined): QuickCommandTree {
    this.assertCapacity();
    const normalized = normalizeCommand(input);
    this.assertShortcutAvailable(normalized.shortcut);
    return this.repository.createCommand(normalized, ifMatch);
  }

  updateCommand(
    id: string,
    input: QuickCommandPatch,
    ifMatch: string | undefined,
  ): QuickCommandTree {
    if (!Object.keys(input).length)
      throw new ApplicationError('INVALID_STATE', 'Quick Command update is empty');
    const current = this.snapshot().commands.find((command) => command.id === id);
    if (!current) throw new ApplicationError('NOT_FOUND', 'Quick Command not found', 404);
    const normalized = normalizeCommand({
      groupId: current.groupId,
      name: input.name ?? current.name,
      command: input.command ?? current.command,
      commands: input.commands ?? current.commands,
      description: input.description ?? current.description,
      tags: input.tags ?? current.tags,
      shortcut: input.shortcut === undefined ? current.shortcut : input.shortcut,
      inputOnly: input.inputOnly ?? current.inputOnly,
      clickCount: input.clickCount ?? current.clickCount,
    });
    this.assertShortcutAvailable(normalized.shortcut, id);
    return this.repository.updateCommand(id, normalized, ifMatch);
  }

  deleteCommand(id: string, ifMatch: string | undefined): QuickCommandTree {
    return this.repository.deleteCommand(id, ifMatch);
  }

  move(input: MoveQuickCommandTreeNodeInput, ifMatch: string | undefined): QuickCommandTree {
    return this.repository.move(input, ifMatch);
  }

  replacePortable(value: unknown, ifMatch: string | undefined): QuickCommandTree {
    const source =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const parsed = quickCommandTreeSchema.parse({
      revision: 1,
      etag: '"quick-command-tree-v1"',
      groups: source.groups,
      commands: source.commands,
    });
    if (parsed.groups.length + parsed.commands.length > maximumNodes)
      throw new ApplicationError(
        'CONFLICT',
        `Quick Command tree is limited to ${maximumNodes} nodes`,
        409,
      );
    const groupIds = new Set(parsed.groups.map(({ id }) => id));
    for (const group of parsed.groups)
      if (group.parentId && !groupIds.has(group.parentId))
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Quick Command folder parent is missing',
          400,
        );
    for (const command of parsed.commands) {
      if (command.groupId && !groupIds.has(command.groupId))
        throw new ApplicationError('VALIDATION_ERROR', 'Quick Command folder is missing', 400);
      normalizeCommand(command);
    }
    const shortcuts = parsed.commands.flatMap(({ shortcut }) =>
      shortcut ? [shortcut.toLocaleLowerCase()] : [],
    );
    if (new Set(shortcuts).size !== shortcuts.length)
      throw new ApplicationError('CONFLICT', 'Quick Command shortcuts must be unique', 409);
    assertSiblingPositions(parsed.groups, parsed.commands);
    return this.repository.replacePortable(parsed.groups, parsed.commands, ifMatch);
  }

  private assertCapacity(): void {
    const snapshot = this.snapshot();
    if (snapshot.groups.length + snapshot.commands.length >= maximumNodes)
      throw new ApplicationError(
        'CONFLICT',
        `Quick Command tree is limited to ${maximumNodes} nodes`,
        409,
      );
  }

  private assertShortcutAvailable(shortcut: string | null, exceptId?: string): void {
    if (!shortcut) return;
    const normalized = shortcut.toLocaleLowerCase();
    if (
      this.snapshot().commands.some(
        (command) =>
          command.id !== exceptId && command.shortcut?.toLocaleLowerCase() === normalized,
      )
    )
      throw new ApplicationError('CONFLICT', 'Quick Command shortcut is already assigned', 409);
  }
}

function assertSiblingPositions(
  groups: readonly QuickCommandGroup[],
  commands: readonly QuickCommand[],
): void {
  const positions = new Set<string>();
  for (const item of [
    ...groups.map(({ parentId, position }) => ({ parentId, position })),
    ...commands.map(({ groupId, position }) => ({ parentId: groupId, position })),
  ]) {
    const key = `${item.parentId ?? 'root'}:${item.position}`;
    if (positions.has(key))
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Quick Command sibling positions must be unique',
        400,
      );
    positions.add(key);
  }
}

function normalizeCommand(input: QuickCommandInput): QuickCommandInput {
  const commands = input.commands.map((step) => ({
    ...step,
    name: step.name.trim(),
  }));
  const bytes = commands.reduce((total, step) => total + Buffer.byteLength(step.command), 0);
  if (bytes > maximumCommandBytes)
    throw new ApplicationError(
      'PAYLOAD_TOO_LARGE',
      `Quick Command content is limited to ${maximumCommandBytes} bytes`,
      413,
    );
  return {
    groupId: input.groupId,
    name: requiredName(input.name, 'Quick Command'),
    command: commands[0]?.command ?? input.command,
    commands,
    description: input.description,
    tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
    shortcut: input.shortcut?.trim() || null,
    inputOnly: input.inputOnly,
    clickCount: input.clickCount,
  };
}

function requiredName(value: string, label: string): string {
  const name = value.trim();
  if (!name) throw new ApplicationError('INVALID_STATE', `${label} name is required`);
  return name;
}
