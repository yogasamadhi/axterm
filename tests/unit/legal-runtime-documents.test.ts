import { describe, expect, it } from 'vitest';
import {
  RUNTIME_LEGAL_SCHEME,
  resolvePackagedRuntimeLegalDirectory,
  resolveRuntimeLegalDocument,
} from '../../apps/desktop/src/main/legal-runtime-documents';

const packagedPaths = {
  packaged: true,
  resourcesDirectory: '/Applications/Axterm.app/Contents/Resources',
  electronDistributionDirectory: '/ignored/electron/dist',
};

describe('runtime legal document protocol', () => {
  it('uses the platform-specific Electron runtime legal directory', () => {
    expect(
      resolvePackagedRuntimeLegalDirectory('/Applications/Axterm.app/Contents/Resources', 'darwin'),
    ).toBe('/Applications/Axterm.app/Contents/Resources');
    expect(resolvePackagedRuntimeLegalDirectory('/opt/Axterm/resources', 'linux')).toBe(
      '/opt/Axterm',
    );
    expect(resolvePackagedRuntimeLegalDirectory('C:\\Axterm\\resources', 'win32')).toMatch(
      /Axterm$/u,
    );
  });

  it('resolves only the fixed packaged Electron and Chromium documents', () => {
    expect(
      resolveRuntimeLegalDocument(`${RUNTIME_LEGAL_SCHEME}://electron/`, packagedPaths),
    ).toEqual({
      id: 'electron',
      contentType: 'text/plain; charset=utf-8',
      path: '/Applications/Axterm.app/Contents/Resources/LICENSE.electron.txt',
    });
    expect(
      resolveRuntimeLegalDocument(`${RUNTIME_LEGAL_SCHEME}://chromium/`, packagedPaths),
    ).toEqual({
      id: 'chromium',
      contentType: 'text/html; charset=utf-8',
      path: '/Applications/Axterm.app/Contents/Resources/LICENSES.chromium.html',
    });
  });

  it('uses the Electron distribution names in development', () => {
    expect(
      resolveRuntimeLegalDocument(`${RUNTIME_LEGAL_SCHEME}://electron/`, {
        ...packagedPaths,
        packaged: false,
      }),
    ).toMatchObject({ path: '/ignored/electron/dist/LICENSE' });
  });

  it('rejects paths, credentials, ports, query strings and unknown documents', () => {
    for (const input of [
      `${RUNTIME_LEGAL_SCHEME}://electron/other`,
      `${RUNTIME_LEGAL_SCHEME}://electron/?preview=1`,
      `${RUNTIME_LEGAL_SCHEME}://electron:80/`,
      `${RUNTIME_LEGAL_SCHEME}://user@electron/`,
      `${RUNTIME_LEGAL_SCHEME}://file/`,
      'file:///etc/passwd',
      'not a URL',
    ])
      expect(resolveRuntimeLegalDocument(input, packagedPaths)).toBeUndefined();
  });
});
