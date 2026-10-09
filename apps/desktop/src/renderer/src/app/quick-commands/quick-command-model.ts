import type {
  QuickCommand,
  QuickCommandGroup,
  QuickCommandTree,
  QuickCommandTreeNode,
} from '@workspace/contracts';

export interface QuickCommandTreeRow {
  ref: QuickCommandTreeNode;
  parentId: string | null;
  depth: number;
  name: string;
  command?: QuickCommand;
  group?: QuickCommandGroup;
  matched: boolean;
  hasChildren: boolean;
}

export function buildQuickCommandRows(
  tree: QuickCommandTree,
  expanded: ReadonlySet<string>,
  rawQuery: string,
): QuickCommandTreeRow[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  const groups = new Map(tree.groups.map((group) => [group.id, group]));
  const directMatches = new Set<string>();
  const visibleGroups = new Set<string>();
  for (const group of tree.groups) {
    if (query && group.name.toLocaleLowerCase().includes(query)) {
      directMatches.add(`group:${group.id}`);
      addAncestors(group.id, groups, visibleGroups);
    }
  }
  for (const command of tree.commands) {
    if (
      query &&
      [command.name, command.description, ...command.tags, ...command.commands.map(stepText)]
        .join('\n')
        .toLocaleLowerCase()
        .includes(query)
    ) {
      directMatches.add(`command:${command.id}`);
      addAncestors(command.groupId, groups, visibleGroups);
    }
  }
  const groupChildren = new Map<string | null, QuickCommandGroup[]>();
  const commandChildren = new Map<string | null, QuickCommand[]>();
  for (const group of tree.groups) append(groupChildren, group.parentId, group);
  for (const command of tree.commands) append(commandChildren, command.groupId, command);
  for (const list of groupChildren.values()) list.sort(comparePosition);
  for (const list of commandChildren.values()) list.sort(comparePosition);
  const rows: QuickCommandTreeRow[] = [];
  const visiting = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    const siblings = [
      ...(groupChildren.get(parentId) ?? []).map((group) => ({
        position: group.position,
        kind: 'group' as const,
        id: group.id,
        group,
      })),
      ...(commandChildren.get(parentId) ?? []).map((command) => ({
        position: command.position,
        kind: 'command' as const,
        id: command.id,
        command,
      })),
    ].sort((left, right) => left.position - right.position || left.kind.localeCompare(right.kind));
    for (const sibling of siblings) {
      const key = `${sibling.kind}:${sibling.id}`;
      if (query && !directMatches.has(key) && !visibleGroups.has(sibling.id)) continue;
      if (sibling.kind === 'command') {
        rows.push({
          ref: { kind: 'command', id: sibling.id },
          parentId,
          depth,
          name: sibling.command.name,
          command: sibling.command,
          matched: directMatches.has(key),
          hasChildren: false,
        });
        continue;
      }
      if (visiting.has(sibling.id)) continue;
      const hasChildren =
        (groupChildren.get(sibling.id)?.length ?? 0) +
          (commandChildren.get(sibling.id)?.length ?? 0) >
        0;
      rows.push({
        ref: { kind: 'group', id: sibling.id },
        parentId,
        depth,
        name: sibling.group.name,
        group: sibling.group,
        matched: directMatches.has(key),
        hasChildren,
      });
      if (query || expanded.has(sibling.id)) {
        visiting.add(sibling.id);
        visit(sibling.id, depth + 1);
        visiting.delete(sibling.id);
      }
    }
  };
  visit(null, 0);
  return rows;
}

export async function quickCommandTextForInsert(
  command: QuickCommand,
  readClipboard: () => Promise<string>,
  now = new Date(),
): Promise<string> {
  return terminalSafeQuickCommandInsertion(
    await expandQuickCommandTemplates(command.commands, readClipboard, now),
  );
}

export function terminalSafeQuickCommandInsertion(commands: readonly string[]): string {
  return commands
    .flatMap((command) => command.split(/\r\n|\r|\n/u))
    .map((command) => command.trim())
    .filter(Boolean)
    .join(' && ');
}

export async function expandQuickCommandTemplates(
  steps: ReadonlyArray<{ command: string }>,
  readClipboard: () => Promise<string>,
  now = new Date(),
): Promise<string[]> {
  const needsClipboard = steps.some(({ command }) => command.includes('{{clipboard}}'));
  const clipboard = needsClipboard ? await readClipboard() : '';
  const time = String(now.getTime());
  const date = now.toLocaleDateString();
  return steps.map(({ command }) =>
    command
      .replaceAll('{{clipboard}}', clipboard)
      .replaceAll('{{time}}', time)
      .replaceAll('{{date}}', date),
  );
}

export function quickCommandDropPosition(
  kind: QuickCommandTreeNode['kind'],
  clientY: number,
  top: number,
  height: number,
): 'before' | 'inside' | 'after' {
  const ratio = height > 0 ? (clientY - top) / height : 0.5;
  if (kind === 'group') {
    if (ratio < 0.25) return 'before';
    if (ratio > 0.75) return 'after';
    return 'inside';
  }
  return ratio < 0.5 ? 'before' : 'after';
}

function stepText(step: QuickCommand['commands'][number]): string {
  return `${step.name}\n${step.command}`;
}

function comparePosition<T extends { position: number; name: string }>(left: T, right: T): number {
  return left.position - right.position || left.name.localeCompare(right.name);
}

function append<T>(map: Map<string | null, T[]>, key: string | null, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function addAncestors(
  id: string | null,
  groups: ReadonlyMap<string, QuickCommandGroup>,
  result: Set<string>,
): void {
  const visited = new Set<string>();
  let cursor = id;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    result.add(cursor);
    cursor = groups.get(cursor)?.parentId ?? null;
  }
}
