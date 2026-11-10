import { describe, expect, it } from 'vitest';
import {
  droppedFilesError,
  dropRemotePath,
} from '../../packages/plugins/files/src/client/ui/file-drop-model.ts';

describe('terminal file drop model', () => {
  it('accepts bounded files and resolves the current remote directory', () => {
    expect(
      droppedFilesError([
        { name: 'read me.txt', size: 12 },
        { name: '中文.log', size: 0 },
      ]),
    ).toBeUndefined();
    expect(dropRemotePath('/srv/app/', 'read me.txt')).toBe('/srv/app/read me.txt');
    expect(dropRemotePath('', 'read me.txt')).toBe('./read me.txt');
  });

  it('rejects unsafe names, directories, excessive counts and excessive sizes', () => {
    expect(droppedFilesError([{ name: 'bad"name', size: 1 }])).toBe('UNSAFE_FILE_NAME');
    expect(droppedFilesError([{ name: 'folder', size: 0 }], true)).toBe('DIRECTORY_UNSUPPORTED');
    expect(
      droppedFilesError(
        Array.from({ length: 33 }, (_, index) => ({ name: `${index}.txt`, size: 1 })),
      ),
    ).toBe('TOO_MANY_FILES');
    expect(droppedFilesError([{ name: 'huge.bin', size: 4 * 1024 ** 3 + 1 }])).toBe(
      'FILE_TOO_LARGE',
    );
  });
});
