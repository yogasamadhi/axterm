import { describe, expect, it } from 'vitest';
import type { FileGrant } from '../../packages/api/plugin-api/src/files.ts';
import { localAbsoluteAddress } from '../../packages/plugins/files/src/client/ui/file-manager-model.ts';

describe('local download destination display', () => {
  it.each([
    ['/Users/operator/Downloads', '', '/Users/operator/Downloads'],
    ['/Users/operator/Downloads', 'folder', '/Users/operator/Downloads/folder'],
    ['C:\\Users\\operator\\Downloads', '', 'C:\\Users\\operator\\Downloads'],
    ['D:\\下载目录', 'folder/nested', 'D:\\下载目录\\folder\\nested'],
    ['\\\\server\\share\\Downloads', 'folder', '\\\\server\\share\\Downloads\\folder'],
    ['/home/operator/Downloads', '', '/home/operator/Downloads'],
    ['/home/operator/下载', 'folder', '/home/operator/下载/folder'],
  ])('shows %s + %s as the full local destination', (rootPath, relativePath, expected) => {
    const grant: FileGrant = {
      grantId: 'downloads-grant',
      kind: 'directory',
      name: 'Downloads',
      rootPath,
      permissions: ['read', 'write'],
      createdAt: new Date(0).toISOString(),
    };
    expect(localAbsoluteAddress(grant, relativePath)).toBe(expected);
  });
});
