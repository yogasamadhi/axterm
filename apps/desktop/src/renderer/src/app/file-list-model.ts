import type { RemoteFileEntry, Settings } from '@workspace/contracts';
import type { GrantedDirectoryEntry } from '@workspace/contracts/desktop';

export type FileManagerSort = Settings['fileManager']['localSort'];
export type FileTableEntry = GrantedDirectoryEntry | RemoteFileEntry;
type FileManagerColumn = Settings['fileManager']['columns'][number];

export function sortFileEntries(
  entries: readonly FileTableEntry[],
  sort: FileManagerSort,
): FileTableEntry[] {
  const direction = sort.direction === 'desc' ? -1 : 1;
  return [...entries].sort((left, right) => {
    if (left.type === 'directory' && right.type !== 'directory') return -1;
    if (left.type !== 'directory' && right.type === 'directory') return 1;
    const leftValue = sortableFileValue(left, sort.property);
    const rightValue = sortableFileValue(right, sort.property);
    const compared =
      typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base' });
    return compared ? compared * direction : left.name.localeCompare(right.name);
  });
}

export function filterFileEntries(
  entries: readonly FileTableEntry[],
  showHidden: boolean,
  keyword: string,
): FileTableEntry[] {
  const normalizedKeyword = keyword.toLocaleLowerCase();
  return entries.filter(
    (entry) =>
      (showHidden || !entry.name.startsWith('.')) &&
      (!normalizedKeyword || entry.name.toLocaleLowerCase().includes(normalizedKeyword)),
  );
}

function sortableFileValue(entry: FileTableEntry, column: FileManagerColumn): string | number {
  if (column === 'size' || column === 'mode') return entry[column] ?? -1;
  if (column === 'modifiedAt' || column === 'accessedAt')
    return entry[column] ? Date.parse(entry[column]) : -1;
  if (column === 'extension') {
    const separator = entry.name.lastIndexOf('.');
    return separator > 0 && separator < entry.name.length - 1
      ? entry.name.slice(separator + 1).toLocaleLowerCase()
      : '';
  }
  return String(entry[column] ?? '').toLocaleLowerCase();
}
