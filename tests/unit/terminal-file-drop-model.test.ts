import { describe, expect, it } from 'vitest';
import {
  terminalDroppedFilesError,
  terminalDropRemotePath,
} from '../../apps/desktop/src/renderer/src/components/terminal-file-drop-model';

describe('terminal file drop model', () => {
  it('accepts bounded files and resolves the current remote directory', () => {
    expect(
      terminalDroppedFilesError([
        { name: 'read me.txt', size: 12 },
        { name: '中文.log', size: 0 },
      ]),
    ).toBeUndefined();
    expect(terminalDropRemotePath('/srv/app/', 'read me.txt')).toBe('/srv/app/read me.txt');
    expect(terminalDropRemotePath('', 'read me.txt')).toBe('./read me.txt');
  });

  it('rejects unsafe names, directories, excessive counts and excessive sizes', () => {
    expect(terminalDroppedFilesError([{ name: 'bad"name', size: 1 }])).toBe('UNSAFE_FILE_NAME');
    expect(terminalDroppedFilesError([{ name: 'folder', size: 0 }], true)).toBe(
      'DIRECTORY_UNSUPPORTED',
    );
    expect(
      terminalDroppedFilesError(
        Array.from({ length: 33 }, (_, index) => ({ name: `${index}.txt`, size: 1 })),
      ),
    ).toBe('TOO_MANY_FILES');
    expect(terminalDroppedFilesError([{ name: 'huge.bin', size: 4 * 1024 ** 3 + 1 }])).toBe(
      'FILE_TOO_LARGE',
    );
  });
});
