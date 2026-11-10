import { describe, expect, it } from 'vitest';
import {
  resolvePackagedRuntimeLegalDirectory,
  resolveRuntimeLegalDocument,
} from '../../apps/desktop/src/shell/legal.ts';

const packagedPaths = {
  packaged: true,
  directory: '/Applications/Axterm.app/Contents',
};

describe('runtime legal document protocol', () => {
  it('uses the platform-specific Electron runtime legal directory', () => {
    expect(
      resolvePackagedRuntimeLegalDirectory('/Applications/Axterm.app/Contents/Resources', 'darwin'),
    ).toBe('/Applications/Axterm.app/Contents');
    expect(resolvePackagedRuntimeLegalDirectory('/opt/Axterm/resources', 'linux')).toBe(
      '/opt/Axterm',
    );
    expect(resolvePackagedRuntimeLegalDirectory('C:\\Axterm\\resources', 'win32')).toMatch(
      /Axterm$/u,
    );
  });

  it('resolves only the fixed packaged Electron and Chromium documents', () => {
    expect(
      resolveRuntimeLegalDocument(`axterm-app://app/desktop/licenses/electron`, packagedPaths),
    ).toEqual({
      id: 'electron',
      contentType: 'text/plain; charset=utf-8',
      path: '/Applications/Axterm.app/Contents/LICENSE.electron.txt',
    });
    expect(
      resolveRuntimeLegalDocument(`axterm-app://app/desktop/licenses/chromium`, packagedPaths),
    ).toEqual({
      id: 'chromium',
      contentType: 'text/html; charset=utf-8',
      path: '/Applications/Axterm.app/Contents/LICENSES.chromium.html',
    });
  });

  it('uses the Electron distribution names in development', () => {
    expect(
      resolveRuntimeLegalDocument(`axterm-app://app/desktop/licenses/electron`, {
        ...packagedPaths,
        packaged: false,
        directory: '/ignored/electron/dist',
      }),
    ).toMatchObject({ path: '/ignored/electron/dist/LICENSE' });
  });

  it('rejects paths, credentials, ports, query strings and unknown documents', () => {
    for (const input of [
      `axterm-app://app/desktop/licenses/electron/other`,
      `axterm-app://app/desktop/licenses/electron?preview=1`,
      `axterm-app://app:80/desktop/licenses/electron`,
      `axterm-app://user@app/desktop/licenses/electron`,
      `axterm-app://app/desktop/licenses/file`,
      'file:///etc/passwd',
      'not a URL',
    ])
      expect(resolveRuntimeLegalDocument(input, packagedPaths)).toBeUndefined();
  });
});
