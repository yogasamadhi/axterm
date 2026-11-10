import type { Settings } from '@axterm/plugin-api/configuration';

export const FILE_DROP_MAX_FILES = 32;
export const FILE_DROP_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
export const FILE_DROP_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

export type FileDropBehavior = Settings['terminal']['dragDropBehavior'];

export interface DroppedFileLike {
  name: string;
  size: number;
}

export type DroppedFilesErrorCode =
  | 'DIRECTORY_UNSUPPORTED'
  | 'NO_FILES'
  | 'TOO_MANY_FILES'
  | 'UNSAFE_FILE_NAME'
  | 'INVALID_FILE_SIZE'
  | 'FILE_TOO_LARGE'
  | 'TOTAL_TOO_LARGE';

export function droppedFilesError(
  files: readonly DroppedFileLike[],
  includesDirectory = false,
): DroppedFilesErrorCode | undefined {
  if (includesDirectory) return 'DIRECTORY_UNSUPPORTED';
  if (!files.length) return 'NO_FILES';
  if (files.length > FILE_DROP_MAX_FILES) return 'TOO_MANY_FILES';
  let total = 0;
  for (const file of files) {
    if (!safeDroppedFileName(file.name)) return 'UNSAFE_FILE_NAME';
    if (!Number.isSafeInteger(file.size) || file.size < 0) return 'INVALID_FILE_SIZE';
    if (file.size > FILE_DROP_MAX_FILE_BYTES) return 'FILE_TOO_LARGE';
    total += file.size;
    if (total > FILE_DROP_MAX_TOTAL_BYTES) return 'TOTAL_TOO_LARGE';
  }
  return undefined;
}

export function dropRemotePath(cwd: string, name: string): string {
  if (!safeDroppedFileName(name)) throw new Error('Unsafe dropped file name');
  const directory = safeRemoteDirectory(cwd) ? cwd.replace(/\/+$/u, '') || '/' : '.';
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

export function safeDroppedFileName(value: string): boolean {
  if (!value || value.length > 255 || value === '.' || value === '..' || /[/\\]/u.test(value))
    return false;
  const forbidden = new Set([0, 10, 13, 34, 39]);
  return [...value].every((character) => !forbidden.has(character.codePointAt(0) ?? 0));
}

function safeRemoteDirectory(value: string): boolean {
  if (!value || value.length > 4_096) return false;
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 31 && code !== 127;
  });
}
