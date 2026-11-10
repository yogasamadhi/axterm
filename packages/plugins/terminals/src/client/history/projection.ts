import type { CommandHistoryPage, CommandHistorySort } from '@axterm/plugin-api/terminals';
/** Display projection only; the accepted, complete bounded history stays in TerminalFactsModel. */
export function historyPageFor(
  page: CommandHistoryPage,
  sort: CommandHistorySort,
  search: string,
): CommandHistoryPage {
  const needle = search.slice(0, 256).toLocaleLowerCase();
  const items = page.items
    .filter((item) => !needle || item.command.toLocaleLowerCase().includes(needle))
    .sort(
      (a, b) =>
        (sort === 'frequency' ? b.count - a.count : 0) ||
        b.lastUsedAt.localeCompare(a.lastUsedAt) ||
        a.id.localeCompare(b.id),
    );
  return { ...page, sort, search, items, total: items.length, nextCursor: null };
}
