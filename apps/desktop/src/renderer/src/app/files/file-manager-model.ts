import type { Settings } from '@workspace/contracts';
import type { FileGrant } from '@workspace/contracts/desktop';
import {
  TERMINAL_DROP_MAX_FILES,
  type TerminalDroppedFilesErrorCode,
} from '../../components/terminal-file-drop-model';
import type { I18nValue } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';
import { type FileManagerSort } from '../file-list-model';
type Translator = I18nValue['x'];
export type FileManagerColumn = Settings['fileManager']['columns'][number];

export type FilePaneScope = 'local' | 'remote';

export interface FileOperationClipboard {
  scope: FilePaneScope;
  authority: string;
  operation: 'copy' | 'move';
  paths: string[];
}

export interface FileDragPayload {
  scope: FilePaneScope;
  authority: string;
  paths: string[];
}

export const FILE_DRAG_MIME = 'application/x-axterm-file-selection';

export const FILE_MANAGER_COLUMNS: Array<{ id: FileManagerColumn; labelKey: AxtermMessageKey }> = [
  { id: 'name', labelKey: 'fileManager.columnName' },
  { id: 'size', labelKey: 'fileManager.columnSize' },
  { id: 'modifiedAt', labelKey: 'fileManager.columnModified' },
  { id: 'accessedAt', labelKey: 'fileManager.columnAccessed' },
  { id: 'owner', labelKey: 'fileManager.columnOwner' },
  { id: 'group', labelKey: 'fileManager.columnGroup' },
  { id: 'mode', labelKey: 'fileManager.columnMode' },
  { id: 'path', labelKey: 'fileManager.columnPath' },
  { id: 'extension', labelKey: 'fileManager.columnExtension' },
];

export const DEFAULT_FILE_MANAGER_COLUMNS: FileManagerColumn[] = ['name', 'size', 'modifiedAt'];

export const DEFAULT_FILE_MANAGER_SORT: FileManagerSort = {
  property: 'modifiedAt',
  direction: 'desc',
};

export function boundedPathHistory(path: string, current: string[]): string[] {
  return [path, ...current.filter((item) => item !== path)].slice(0, 32);
}

export function fileManagerDropError(code: TerminalDroppedFilesErrorCode, x: Translator): string {
  switch (code) {
    case 'DIRECTORY_UNSUPPORTED':
      return x('fileManager.dropDirectoryUnsupported');
    case 'NO_FILES':
      return x('terminal.dropNoFiles');
    case 'TOO_MANY_FILES':
      return x('terminal.dropTooManyFiles', { limit: TERMINAL_DROP_MAX_FILES });
    case 'UNSAFE_FILE_NAME':
      return x('terminal.dropUnsafeFileName');
    case 'INVALID_FILE_SIZE':
      return x('terminal.dropInvalidFileSize');
    case 'FILE_TOO_LARGE':
      return x('terminal.dropFileTooLarge');
    case 'TOTAL_TOO_LARGE':
      return x('terminal.dropTotalTooLarge');
  }
}

export function normalizeLocalAddress(value: string, x: Translator): string {
  const segments = value.trim().replaceAll('\\', '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\0')))
    throw new Error(x('fileManager.localPathInvalid'));
  return segments.join('/');
}

export function localAbsoluteAddress(grant: FileGrant | undefined, relativePath: string): string {
  const rootPath = grant?.rootPath;
  if (!rootPath) return relativePath ? `/${relativePath}` : '/';
  if (!relativePath) return rootPath;
  const separator = rootPath.includes('\\') ? '\\' : '/';
  const root =
    rootPath.endsWith('/') || rootPath.endsWith('\\') ? rootPath : `${rootPath}${separator}`;
  return `${root}${relativePath.replaceAll('/', separator)}`;
}

export function localRelativeAddress(
  value: string,
  grant: FileGrant | undefined,
  x: Translator,
): string | undefined {
  const address = value.trim().replaceAll('\\', '/');
  const rootPath = grant?.rootPath?.replaceAll('\\', '/');
  const absolute = address.startsWith('/') || /^[a-z]:\//iu.test(address);
  if (!absolute || !rootPath || address.includes('\0'))
    throw new Error(x('fileManager.localPathInvalid'));
  const root = rootPath.length > 1 ? rootPath.replace(/\/+$/u, '') : rootPath;
  const caseInsensitive = /^[a-z]:\//iu.test(root);
  const comparableAddress = caseInsensitive ? address.toLocaleLowerCase() : address;
  const comparableRoot = caseInsensitive ? root.toLocaleLowerCase() : root;
  if (comparableAddress === comparableRoot) return '';
  const prefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  if (!comparableAddress.startsWith(prefix)) return undefined;
  return normalizeLocalAddress(address.slice(prefix.length), x);
}

export function localParentPath(value: string): string {
  const separator = value.lastIndexOf('/');
  return separator < 0 ? '' : value.slice(0, separator);
}

export function appendLocalPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

export function appendRemotePath(directory: string, name: string): string {
  return `${directory.replace(/\/$/, '')}/${name}`;
}

export function normalizeRemoteAddress(value: string, x: Translator): string {
  const trimmed = value.trim().replaceAll('\\', '/');
  if (!trimmed.startsWith('/') || trimmed.includes('\0'))
    throw new Error(x('fileManager.remotePathInvalid'));
  const segments = trimmed.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') normalized.pop();
    else normalized.push(segment);
  }
  return `/${normalized.join('/')}`;
}
