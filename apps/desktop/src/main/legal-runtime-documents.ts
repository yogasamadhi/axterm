import { dirname, join, win32 } from 'node:path';

export const RUNTIME_LEGAL_SCHEME = 'axterm-license';

export interface RuntimeLegalDocument {
  id: 'electron' | 'chromium';
  contentType: string;
  path: string;
}

export interface RuntimeLegalDocumentPaths {
  packaged: boolean;
  resourcesDirectory: string;
  electronDistributionDirectory: string;
}

const documents = {
  electron: {
    packagedName: 'LICENSE.electron.txt',
    developmentName: 'LICENSE',
    contentType: 'text/plain; charset=utf-8',
  },
  chromium: {
    packagedName: 'LICENSES.chromium.html',
    developmentName: 'LICENSES.chromium.html',
    contentType: 'text/html; charset=utf-8',
  },
} as const;

/**
 * Electron places its runtime legal files inside Contents/Resources on macOS,
 * but beside the executable (one level above resources/) on Linux and Windows.
 */
export function resolvePackagedRuntimeLegalDirectory(
  resourcesDirectory: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'darwin') return resourcesDirectory;
  return platform === 'win32' ? win32.dirname(resourcesDirectory) : dirname(resourcesDirectory);
}

/**
 * This deliberately resolves only two fixed runtime legal documents. It is
 * not a local-file protocol and it does not accept a caller-provided path.
 */
export function resolveRuntimeLegalDocument(
  requestUrl: string,
  paths: RuntimeLegalDocumentPaths,
): RuntimeLegalDocument | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== `${RUNTIME_LEGAL_SCHEME}:` ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    return undefined;
  const id = url.hostname;
  if (id !== 'electron' && id !== 'chromium') return undefined;
  const document = documents[id];
  return {
    id,
    contentType: document.contentType,
    path: join(
      paths.packaged ? paths.resourcesDirectory : paths.electronDistributionDirectory,
      paths.packaged ? document.packagedName : document.developmentName,
    ),
  };
}
