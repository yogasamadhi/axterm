import {
  openSettingsSync,
  openWidgets,
  openFilesWorkspace,
  openTerminalThemes,
  openQuickCommandsWorkspace,
} from './settings-workspace-navigation';
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import {
  cp,
  chmod,
  copyFile,
  link,
  mkdtemp,
  rm,
  access,
  realpath,
  stat,
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { EOL, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import { build as buildFixture } from 'esbuild';
import type * as Ssh2Module from 'ssh2';
import type { Connection as SshServerConnection } from 'ssh2';
import {
  DEFAULT_TERMINAL_BACKGROUND,
  connectionProfileInputSchema,
  createBookmarkSchema,
  createHostSchema,
  terminalProfileInputSchema,
  triggerRuleInputSchema,
  tunnelProfileInputSchema,
} from '../../packages/contracts/src';
import { CredentialVault } from '../../apps/desktop/src/main/host-capabilities/credential-vault';
import { canonicalManifestRecord } from '../../apps/desktop/src/main/host-capabilities/signed-release-updater';
import { BookmarkRepository } from '../../packages/runtime/src/adapters/sqlite/bookmark-repository';
import { ConnectionProfileRepository } from '../../packages/runtime/src/adapters/sqlite/connection-profile-repository';
import { ProductDatabase } from '../../packages/runtime/src/adapters/sqlite/database';
import {
  ProductRepository,
  etagFor,
} from '../../packages/runtime/src/adapters/sqlite/product-repository';
import { QuickCommandRepository } from '../../packages/runtime/src/adapters/sqlite/quick-command-repository';
import { SyncProfileRepository } from '../../packages/runtime/src/adapters/sqlite/sync-profile-repository';
import { TerminalThemeRepository } from '../../packages/runtime/src/adapters/sqlite/terminal-theme-repository';
import { TriggerRepository } from '../../packages/runtime/src/adapters/sqlite/trigger-repository';
import { AXTERM_TERMINAL_THEMES } from '../../packages/shared/src/terminal-theme-presets';
import { inventoryPackagedResources } from '../../scripts/commercialization/packaged-license-inventory.mjs';
import { missingPackagedComponents } from '../../scripts/commercialization/generate-component-index.mjs';
import { mismatchedPackagedLicenseTexts } from '../../scripts/commercialization/generate-license-texts.mjs';
import { verifyNoVncPackagedBundle } from '../../scripts/commercialization/generate-novnc-source-notices.mjs';
import { verifySpicePackagedBundle } from '../../scripts/commercialization/generate-spice-source-notices.mjs';
import { verifyAppImageRuntimeArtifact } from '../../scripts/commercialization/verify-appimage-runtime-artifact.mjs';
import { verifyFourLocaleEditorConditionalJourney } from './editor-conditional-journey';
import { verifyFourLocaleS3ConditionalJourney } from './s3-conditional-journey';
import { verifyFourLocaleS4ConditionalJourney } from './s4-conditional-journey';
import { verifyFourLocaleS5ShellJourney } from './s5-shell-journey';
import {
  MIGRATION_FAILURE_SECRET,
  REMOVED_BUILT_IN_THEME_ID,
  seedFailingLocalProfile,
  vaultFileHashes,
} from '../fixtures/migration/failing-local-profile';

const defaultArtifact =
  process.platform === 'darwin'
    ? `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Axterm.app`
    : process.platform === 'win32'
      ? 'release/win-unpacked'
      : 'release/linux-unpacked';
const source = process.env.AXTERM_PACKAGED_APP ?? defaultArtifact;
const previousPackagedSource = process.env.AXTERM_PREVIOUS_PACKAGED_APP?.trim() ?? '';
const previousAxotermSource = process.env.AXTERM_PREVIOUS_AXOTERM_APP?.trim() ?? '';
const realNoHardlinkDirectory = process.env.AXTERM_REAL_NOHARDLINK_DIRECTORY?.trim() ?? '';
const realNoReplaceDirectory = process.env.AXTERM_REAL_NO_REPLACE_DIRECTORY?.trim() ?? '';
const sshFixturePort = Number(process.env.AXTERM_SSH_FIXTURE_PORT ?? 0);
const packagedEvidenceDirectory = 'test-results/packaged-evidence';
const execFileAsync = promisify(execFile);
const licenseDocuments = (await readdir(resolve('licenses')))
  .filter((name) => name.endsWith('.txt'))
  .sort();
const runtimeRequire = createRequire(resolve('packages/runtime/package.json'));
const desktopRequire = createRequire(resolve('apps/desktop/package.json'));
const axeScriptPath = desktopRequire.resolve('axe-core/axe.min.js');
const { Server: SshServer, utils: sshUtils } = runtimeRequire('ssh2') as typeof Ssh2Module;
const packagedElectronLanguages = ['en', 'ja', 'zh-CN', 'zh-TW'] as const;
const packagedLanguageEyebrows = {
  en: 'SETTINGS',
  ja: '設定',
  'zh-CN': '设置',
  'zh-TW': '設定',
} satisfies Record<(typeof packagedElectronLanguages)[number], string>;

async function packagedTransferDestination(directory: string, protocol: string): Promise<string> {
  if (realNoHardlinkDirectory) {
    const destination = await realpath(
      await mkdtemp(join(realNoHardlinkDirectory, `axterm-${protocol}-`)),
    );
    const source = join(destination, '.hardlink-probe');
    const target = join(destination, 'hardlink-probe');
    try {
      await writeFile(source, 'probe');
      let rejected = false;
      try {
        await link(source, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EINVAL'].includes(code ?? ''))
          throw error;
        rejected = true;
      } finally {
        await unlink(target).catch(() => undefined);
        await unlink(source).catch(() => undefined);
      }
      if (!rejected) throw new Error('The selected transfer volume supports hard links');
      return destination;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
  const destination = join(directory, 'downloads');
  await mkdir(destination);
  return destination;
}

// FAT/ExFAT may create AppleDouble sidecars (._name) alongside a stage.
function isTransferStage(entry: string): boolean {
  return entry.endsWith('.part') && !entry.startsWith('._');
}

async function expectPackagedAxeClean(page: Page, scene: string) {
  const violations = await page.evaluate(async () => {
    const axe = (
      globalThis as typeof globalThis & {
        axe?: {
          run: (
            context: Document,
            options: { runOnly: { type: 'tag'; values: string[] } },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              help: string;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe;
    if (!axe) throw new Error('axe-core was not injected into the packaged renderer');
    const results = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => {
        const target = node.target[0];
        const element = target ? document.querySelector<HTMLElement>(target) : null;
        if (!element) return { target: node.target, failureSummary: node.failureSummary };
        const style = getComputedStyle(element);
        const matchedColorRules: string[] = [];
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules)) {
              if (!(rule instanceof CSSStyleRule) || !rule.style.color) continue;
              try {
                if (element.matches(rule.selectorText)) matchedColorRules.push(rule.cssText);
              } catch {
                // Ignore selectors unsupported by Element.matches.
              }
            }
          } catch {
            // Ignore stylesheets that do not allow rule inspection.
          }
        }
        const backgroundLayers: Array<{ selector: string; color: string }> = [];
        for (
          let ancestor: HTMLElement | null = element;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const backgroundColor = getComputedStyle(ancestor).backgroundColor;
          if (backgroundColor !== 'rgba(0, 0, 0, 0)') {
            backgroundLayers.push({
              selector:
                ancestor.tagName.toLowerCase() +
                (ancestor.className
                  ? `.${String(ancestor.className).trim().replaceAll(/\s+/g, '.')}`
                  : ''),
              color: backgroundColor,
            });
          }
          if (backgroundLayers.length === 3) break;
        }
        return {
          target: node.target,
          failureSummary: node.failureSummary,
          foreground: style.color,
          background: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          opacity: style.opacity,
          disabled: element.matches(':disabled'),
          textMutedToken: style.getPropertyValue('--text-muted').trim(),
          matchedColorRules,
          backgroundLayers,
        };
      }),
    }));
  });
  expect(
    violations,
    `${scene} packaged axe-core violations:\n${JSON.stringify(violations, null, 2)}`,
  ).toEqual([]);
}

async function startPackagedHostKeyFixture(hostKey: string | Buffer) {
  const connections = new Set<SshServerConnection>();
  const server = new SshServer({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    connection.on('error', (error) => {
      if (error.message !== 'KEY_EXCHANGE_FAILED') throw error;
    });
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', (context) => {
      if (context.method === 'none') context.accept();
      else context.reject(['none']);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Packaged Host Key fixture did not bind');
  return {
    port: address.port,
    async stop() {
      const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      for (const connection of connections) connection.end();
      await closed;
    },
  };
}

function normalizeElectronLocale(locale: string) {
  return locale.trim().toLowerCase().replaceAll('_', '-');
}

function electronLocaleMatches(wanted: string, actual: string) {
  const wantedLocale = normalizeElectronLocale(wanted);
  const actualLocale = normalizeElectronLocale(actual);
  return (
    wantedLocale === actualLocale ||
    actualLocale.startsWith(`${wantedLocale}-`) ||
    wantedLocale.startsWith(`${actualLocale}-`)
  );
}

async function packagedElectronLocaleNames() {
  const directory =
    process.platform === 'darwin'
      ? join(source, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources')
      : join(source, 'locales');
  const extension = process.platform === 'darwin' ? '.lproj' : '.pak';
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => (process.platform === 'darwin' ? entry.isDirectory() : entry.isFile()))
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(extension))
    .map((name) => name.slice(0, -extension.length))
    .sort();
}

function installedElectronLegalFiles() {
  const electronRoot = dirname(desktopRequire.resolve('electron/package.json'));
  const distribution = join(electronRoot, 'dist');
  const electronLicense = [join(distribution, 'LICENSE'), join(electronRoot, 'LICENSE')].find(
    (candidate) => existsSync(candidate),
  );
  const chromiumLicense = join(distribution, 'LICENSES.chromium.html');
  return new Map<string, string>([
    ...(electronLicense ? ([['LICENSE.electron.txt', electronLicense]] as const) : []),
    ...(existsSync(chromiumLicense)
      ? ([['LICENSES.chromium.html', chromiumLicense]] as const)
      : []),
  ]);
}

function sha256(content: Buffer) {
  return createHash('sha256').update(content).digest('hex');
}

async function fileSha256(path: string) {
  return sha256(await readFile(path));
}

async function directoryFileHashes(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => [entry.name, await fileSha256(join(directory, entry.name))] as const),
    ),
  );
}

async function enterTerminalCommand(input: Locator, command: string) {
  // A full local-PTY command can otherwise reach the terminal input faster than
  // its renderer/PTY bridge drains key events, corrupting fixture paths. Clear
  // the editable shell line first so a delayed startup character cannot prefix
  // a fixture path.
  await input.press('Control+A');
  await input.press('Control+U');
  await input.pressSequentially(command, { delay: 4 });
  await input.press('Enter');
}
const { Client: FtpClient } = runtimeRequire('basic-ftp') as {
  Client: new (timeout?: number) => {
    access(input: { host: string; port: number; user: string; password: string }): Promise<unknown>;
    list(path?: string): Promise<Array<{ name: string }>>;
    uploadFrom(source: Readable, remotePath: string): Promise<unknown>;
    rename(sourcePath: string, destinationPath: string): Promise<unknown>;
    send(command: string): Promise<{ code: number; message: string }>;
    close(): void;
  };
};

test('packaged app includes Axterm and transition third-party license notices', async () => {
  await access(source);
  const contentDirectory = process.platform === 'darwin' ? join(source, 'Contents') : source;
  const resourcesDirectory =
    process.platform === 'darwin'
      ? join(contentDirectory, 'Resources')
      : join(contentDirectory, 'resources');
  expect(await verifyNoVncPackagedBundle(resourcesDirectory)).toMatchObject({ sources: 52 });
  expect(await verifySpicePackagedBundle(resourcesDirectory)).toMatchObject({ sources: 30 });
  expect(await readFile(join(contentDirectory, 'LICENSE.axterm'))).toEqual(
    await readFile(resolve('LICENSE')),
  );
  const notices = await readFile(join(contentDirectory, 'THIRD_PARTY_NOTICES.txt'));
  expect(notices).toEqual(await readFile(resolve('THIRD_PARTY_NOTICES.txt')));
  const componentFile = await readFile(join(contentDirectory, 'THIRD_PARTY_COMPONENTS.json'));
  expect(componentFile).toEqual(await readFile(resolve('compliance/THIRD_PARTY_COMPONENTS.json')));
  const sbomFile = await readFile(
    join(contentDirectory, 'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json'),
  );
  expect(sbomFile).toEqual(
    await readFile(resolve('compliance/AXTERM_PRODUCTION_DEPENDENCIES.spdx.json')),
  );
  expect(JSON.parse(sbomFile.toString('utf8'))).toMatchObject({
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
  });
  const licenseTextsFile = await readFile(join(contentDirectory, 'THIRD_PARTY_LICENSE_TEXTS.json'));
  expect(licenseTextsFile).toEqual(
    await readFile(resolve('compliance/THIRD_PARTY_LICENSE_TEXTS.json')),
  );
  const componentIndex = JSON.parse(componentFile.toString('utf8')) as {
    components: Array<{ name: string; version: string; license: string }>;
  };
  const licenseTexts = JSON.parse(licenseTextsFile.toString('utf8')) as {
    components: Array<{
      name: string;
      version: string;
      license: string;
      files: Array<{ name: string; sha256: string; content: string }>;
      attribution: {
        manifestPublisherRecords: Array<{
          field: 'author' | 'contributors';
          value: string | Record<string, unknown>;
        }>;
        manifestCopyright: string | null;
        rootLicenseCopyrightLines: Array<{ file: string; line: string }>;
      };
    }>;
    missingRootLicenseFiles: Array<{ name: string; version: string }>;
    missingCopyrightDeclarations: Array<{ name: string; version: string }>;
  };
  expect(licenseTexts.components).toHaveLength(componentIndex.components.length);
  expect(licenseTexts.components.flatMap(({ files }) => files)).toHaveLength(132);
  expect(licenseTexts.missingRootLicenseFiles).toEqual([
    { name: '@devolutions/iron-remote-desktop-rdp', version: '0.7.0' },
    { name: '@hono/zod-openapi', version: '1.6.3' },
    { name: '@hono/zod-validator', version: '0.9.1' },
    { name: '@openclaw/fs-safe-darwin-arm64', version: '0.13.1' },
    { name: '@xterm/addon-serialize', version: '0.14.0' },
    { name: '@xterm/headless', version: '6.0.0' },
    { name: 'drizzle-orm', version: '0.45.2' },
    { name: 'isarray', version: '1.0.0' },
  ]);
  expect(licenseTexts.missingCopyrightDeclarations).toEqual([
    { name: '@devolutions/iron-remote-desktop-rdp', version: '0.7.0' },
    { name: '@hono/zod-openapi', version: '1.6.3' },
    { name: '@hono/zod-validator', version: '0.9.1' },
    { name: '@novnc/novnc', version: '1.7.0' },
    { name: '@openclaw/fs-safe-darwin-arm64', version: '0.13.1' },
    { name: '@xterm/addon-serialize', version: '0.14.0' },
    { name: '@xterm/headless', version: '6.0.0' },
    { name: 'drizzle-orm', version: '0.45.2' },
    { name: 'isarray', version: '1.0.0' },
    { name: 'tweetnacl', version: '0.14.5' },
  ]);
  expect(
    licenseTexts.components.find(({ name }) => name === 'lie')?.attribution
      .rootLicenseCopyrightLines,
  ).toEqual([
    { file: 'license.md', line: '#Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband' },
  ]);
  expect(
    licenseTexts.components.find(({ name }) => name === 'process-nextick-args')?.attribution
      .rootLicenseCopyrightLines,
  ).toEqual([{ file: 'license.md', line: '# Copyright (c) 2015 Calvin Metcalf' }]);
  expect(licenseTexts.components.find(({ name }) => name === 'ssh2')?.attribution).toEqual({
    manifestPublisherRecords: [{ field: 'author', value: 'Brian White <mscdex@mscdex.net>' }],
    manifestCopyright: null,
    rootLicenseCopyrightLines: [
      { file: 'LICENSE', line: 'Copyright Brian White. All rights reserved.' },
    ],
  });
  expect(
    licenseTexts.components.find(({ name }) => name === '@codemirror/commands')?.attribution,
  ).toMatchObject({
    manifestPublisherRecords: [
      {
        field: 'author',
        value: {
          name: 'Marijn Haverbeke',
          email: 'marijn@haverbeke.berlin',
          url: 'http://marijnhaverbeke.nl',
        },
      },
    ],
  });
  const text = notices.toString('utf8');
  expect(text).toContain('ZHAO Xudong');
  expect(text).toContain('Copyright (c) 2023 Lonny Wong');
  expect(text).toContain('licenses/trzsz-js-LICENSE.txt');
  expect(text).toContain('licenses/isarray-README.txt');
  expect(text).not.toContain('@legacy-prototype/ftp-srv');
  expect(text).toContain('@devolutions/iron-remote-desktop-rdp 0.7.0');
  expect(text).toContain('Chromium DOM code to Windows scan-code data');
  expect(text).toContain('licenses/chromium-dom-code-data-LICENSE.txt');
  expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
  expect(
    (await readdir(join(contentDirectory, 'licenses')))
      .filter((name) => name.endsWith('.txt'))
      .sort(),
  ).toEqual(licenseDocuments);
  expect(licenseDocuments).toContain('isarray-README.txt');
  expect(licenseDocuments).toContain('trzsz-js-LICENSE.txt');
  expect(licenseDocuments).toContain('chromium-dom-code-data-LICENSE.txt');
  for (const name of licenseDocuments) {
    expect(await readFile(join(contentDirectory, 'licenses', name))).toEqual(
      await readFile(resolve('licenses', name)),
    );
  }
  expect(
    await readFile(join(contentDirectory, 'licenses', 'spice-client-1.2.0-source.tar')),
  ).toEqual(await readFile(resolve('licenses/spice-client-1.2.0-source.tar')));
  expect(await readFile(join(contentDirectory, 'licenses', 'noVNC-1.7.0-source.tgz'))).toEqual(
    await readFile(resolve('licenses/noVNC-1.7.0-source.tgz')),
  );
  const resources =
    process.platform === 'darwin' ? join(source, 'Contents/Resources') : join(source, 'resources');
  const inventory = inventoryPackagedResources(resources);
  expect(inventory.rendererProvenanceFiles).toEqual([
    {
      path: '/out/renderer/axterm-novnc-bundle-provenance.json',
      sha256: sha256(
        await readFile(resolve('apps/desktop/out/renderer/axterm-novnc-bundle-provenance.json')),
      ),
    },
    {
      path: '/out/renderer/axterm-spice-client-bundle-provenance.json',
      sha256: sha256(
        await readFile(
          resolve('apps/desktop/out/renderer/axterm-spice-client-bundle-provenance.json'),
        ),
      ),
    },
  ]);
  expect(missingPackagedComponents(componentIndex, inventory.packages)).toEqual([]);
  expect(mismatchedPackagedLicenseTexts(licenseTexts, inventory.packages)).toEqual([]);
  expect(inventory.externalLegalFiles).toContainEqual(
    expect.objectContaining({ path: 'THIRD_PARTY_COMPONENTS.json' }),
  );
  expect(inventory.externalLegalFiles).toContainEqual(
    expect.objectContaining({ path: 'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json' }),
  );
  expect(inventory.externalLegalFiles).toContainEqual(
    expect.objectContaining({
      path: 'licenses/spice-client-1.2.0-source.tar',
      sha256: 'a30adf3706f5a03ede1fdcd0785cea4330f86af2c9bbbc75165384ccfcfd9a26',
    }),
  );
  expect(inventory.externalLegalFiles).toContainEqual(
    expect.objectContaining({
      path: 'licenses/noVNC-1.7.0-source.tgz',
      sha256: '32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903',
    }),
  );
  const productAssets = JSON.parse(
    await readFile(resolve('compliance/AXTERM_PRODUCT_ASSETS.json'), 'utf8'),
  ) as { assets: Array<{ path: string; sha256: string }> };
  if (process.platform === 'darwin') {
    const sourceMacIcon = productAssets.assets.find(
      ({ path }) => path === 'apps/desktop/build/icon.icns',
    );
    expect(sourceMacIcon).toBeDefined();
    expect(sha256(await readFile(join(contentDirectory, 'Resources', 'icon.icns')))).toBe(
      sourceMacIcon!.sha256,
    );
  }
  expect(inventory.externalLegalFiles).toContainEqual(
    expect.objectContaining({ path: 'THIRD_PARTY_LICENSE_TEXTS.json' }),
  );
  const electronLegalFiles = installedElectronLegalFiles();
  expect(inventory.electronRuntimeLegalFiles.map(({ path }) => path.split('/').at(-1))).toEqual([
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
  ]);
  for (const entry of inventory.electronRuntimeLegalFiles) {
    const packagedName = entry.path.split('/').at(-1);
    if (!packagedName) throw new Error(`Unexpected Electron runtime legal file: ${entry.path}`);
    const sourcePath = electronLegalFiles.get(packagedName);
    if (sourcePath) {
      expect(entry.sha256).toBe(sha256(await readFile(sourcePath)));
      continue;
    }
    expect(packagedName).toBe('LICENSES.chromium.html');
    const packagedDocument = await readFile(join(contentDirectory, packagedName));
    expect(packagedDocument.byteLength).toBeGreaterThan(1_000_000);
    expect(packagedDocument.toString('utf8', 0, 200)).toContain('html');
  }
  expect(
    inventory.rendererAssets.filter((asset: string) =>
      /\/iron-remote-desktop-rdp-[^/]+\.js$/u.test(asset),
    ),
  ).toHaveLength(1);
  expect(inventory.rendererAssets).not.toContainEqual(
    expect.stringMatching(/\/rdp_client_bg-[^/]+\.wasm$/u),
  );
  for (const packageName of ['ssh2', 'buildcheck']) {
    const entry = inventory.packages.find(({ name }: { name: string }) => name === packageName);
    expect(entry).toMatchObject({ license: 'MIT', licenseSource: 'licenses' });
    expect(entry.licenseFiles).toEqual([
      expect.objectContaining({
        sha256: 'd06b5d27bbbbe22c36b1fd88406b1208876e2d37d795f5b8eaed951a459a3111',
      }),
    ]);
    expect(inventory.missingLicenseMetadata).not.toContain(entry.manifestPath);
  }
});

test('packaged native modules use rebuilt Electron ABI binaries without foreign prebuilds', async () => {
  await access(source);
  const resources =
    process.platform === 'darwin' ? join(source, 'Contents/Resources') : join(source, 'resources');
  const inventory = inventoryPackagedResources(resources);
  expect(inventory.archivedPrebuildFiles).toEqual([]);
  expect(
    inventory.unpackedFiles.filter(({ path }: { path: string }) => path.includes('/prebuilds/')),
  ).toEqual([]);
  for (const moduleName of ['node-pty', '@serialport/bindings-cpp']) {
    expect(
      inventory.unpackedFiles.some(
        ({ path }: { path: string }) =>
          path.startsWith(`node_modules/${moduleName}/build/Release/`) && path.endsWith('.node'),
      ),
    ).toBe(true);
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    expect(
      inventory.unpackedFiles.some(
        ({ path }: { path: string }) =>
          path === 'node_modules/@openclaw/fs-safe-darwin-arm64/fs-safe-native.node',
      ),
    ).toBe(true);
  }
});

test('packaged macOS arm64 native helper publishes without replacing an existing file', async () => {
  test.skip(
    process.platform !== 'darwin' || process.arch !== 'arm64',
    'macOS arm64 native package',
  );
  const executable = resolve(source, 'Contents/MacOS/Axterm');
  const appManifest = resolve(source, 'Contents/Resources/app.asar/package.json');
  const script = `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const requireApp = createRequire(${JSON.stringify(appManifest)});
    const { publishFileExclusive } = requireApp('@openclaw/fs-safe/durability');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axterm-packaged-native-publish-'));
    async function run() {
      try {
        const source = path.join(root, '.received.part');
        const target = path.join(root, 'received.bin');
        fs.writeFileSync(source, Buffer.from([0, 1, 2, 255]));
        const receipt = await publishFileExclusive({
          sourcePath: source,
          targetPath: target,
          strategy: 'rename-noreplace',
        });
        const collisionSource = path.join(root, '.collision.part');
        fs.writeFileSync(collisionSource, 'collision');
        let collisionCode = null;
        try {
          await publishFileExclusive({
            sourcePath: collisionSource,
            targetPath: target,
            strategy: 'rename-noreplace',
          });
        } catch (error) {
          collisionCode = error.code;
        }
        process.stdout.write(JSON.stringify({
          method: receipt.method,
          directorySync: receipt.directorySync.status,
          finalHex: fs.readFileSync(target).toString('hex'),
          sourceExists: fs.existsSync(source),
          collisionCode,
          collisionSource: fs.readFileSync(collisionSource, 'utf8'),
        }));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    run().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await execFileAsync(executable, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  expect(JSON.parse(stdout)).toEqual({
    method: 'rename-noreplace',
    directorySync: 'synced',
    finalHex: '000102ff',
    sourceExists: false,
    collisionCode: 'EEXIST',
    collisionSource: 'collision',
  });
});

test('packaged app keeps only the four selected Electron runtime locale families', async () => {
  await access(source);
  const localeNames = await packagedElectronLocaleNames();
  expect(localeNames).not.toEqual([]);
  for (const language of packagedElectronLanguages) {
    expect(localeNames.some((locale) => electronLocaleMatches(language, locale))).toBe(true);
  }
  expect(
    localeNames.every((locale) =>
      packagedElectronLanguages.some((language) => electronLocaleMatches(language, locale)),
    ),
  ).toBe(true);
});

test('packaged FTP Widget runs the independent server outside the source checkout', async () => {
  const runLongTransfer = process.env.AXTERM_PACKAGED_FTP_LONG_TRANSFER === '1';
  const runStalledTransfer = process.env.AXTERM_PACKAGED_FTP_STALLED_TRANSFER === '1';
  const runActiveStalledTransfer = process.env.AXTERM_PACKAGED_FTP_ACTIVE_STALLED_TRANSFER === '1';
  const runStopRestart = process.env.AXTERM_PACKAGED_FTP_STOP_RESTART === '1';
  const optionalTransfers = [runLongTransfer, runStalledTransfer, runActiveStalledTransfer].filter(
    Boolean,
  ).length;
  if (optionalTransfers > 0) test.setTimeout(90_000 + optionalTransfers * 90_000);
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-ftp-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const shared = join(directory, 'shared');
  const curlSource = join(directory, 'curl-source.bin');
  const curlDownloaded = join(directory, 'curl-downloaded.bin');
  const curlActiveDownloaded = join(directory, 'curl-active-downloaded.bin');
  const curlAsciiSource = join(directory, 'curl-ascii-source.txt');
  const curlAsciiDownloaded = join(directory, 'curl-ascii-downloaded.txt');
  const curlPayload = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.alloc(8_192, 0xa5)]);
  const curlAsciiPayload = Buffer.from('PACKAGED_ASCII_LINE1\nPACKAGED_ASCII_LINE2\n');
  const hostAsciiPayload = Buffer.concat([
    Buffer.from('PACKAGED_ASCII_LINE1'),
    Buffer.from(EOL),
    Buffer.from('PACKAGED_ASCII_LINE2'),
    Buffer.from(EOL),
  ]);
  await mkdir(shared);
  await writeFile(join(shared, 'source.txt'), 'PACKAGED_FTP_SOURCE');
  await writeFile(curlSource, curlPayload);
  await writeFile(curlAsciiSource, curlAsciiPayload);
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
    },
  });
  const ftp = new FtpClient(5_000);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, shared);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openWidgets(page);
    const workspace = page.locator('.widget-workspace');
    await workspace.getByRole('button', { name: /Local FTP Server|本地 FTP 服务器/ }).click();
    const form = workspace.locator('.local-ftp-widget-form');
    expect(
      await form
        .locator('select[name="host"] option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
    ).toEqual(['127.0.0.1', '::1']);
    await form.getByRole('button', { name: '选择目录' }).click();
    await form.locator('input[name="port"]').fill('0');
    await form.locator('input[name="password"]').fill('packaged-ftp-session-only');
    await form.locator('input[name="passivePortStart"]').fill('50416');
    await form.locator('input[name="passivePortEnd"]').fill('50423');
    await form.getByRole('button', { name: /Start widget|启动 Widget/ }).click();
    const instance = workspace.locator('.widget-instance-list article').filter({
      hasText: /Local FTP Server|本地 FTP 服务器/,
    });
    await expect(instance).toBeVisible();
    const text = (await instance.locator('.widget-instance-title small').textContent()) ?? '';
    const address = new URL(text.match(/ftp:\/\/[^\s·]+/)![0]);
    await ftp.access({
      host: address.hostname,
      port: Number(address.port),
      user: 'ftpuser',
      password: 'packaged-ftp-session-only',
    });
    expect((await ftp.list()).map(({ name }) => name)).toContain('source.txt');
    const largeDirectory = join(shared, 'large');
    await mkdir(largeDirectory);
    for (let index = 0; index <= 1_000; index += 1) {
      await writeFile(join(largeDirectory, `entry-${String(index).padStart(4, '0')}.txt`), 'x');
    }
    for (const verb of ['LIST', 'NLST', 'MLSD']) {
      await ftp.send('PASV');
      await expect(ftp.send(`${verb} large`)).rejects.toMatchObject({ code: 550 });
      expect((await ftp.send('NOOP')).code).toBe(200);
    }
    await rename(largeDirectory, join(shared, 'moved'));
    await unlink(join(shared, 'moved', 'entry-1000.txt'));
    expect(await ftp.list('moved')).toHaveLength(1_000);
    await ftp.uploadFrom(Readable.from(Buffer.from('PACKAGED_FTP_UPLOAD')), 'uploaded.txt');
    expect(await readFile(join(shared, 'uploaded.txt'), 'utf8')).toBe('PACKAGED_FTP_UPLOAD');
    await ftp.uploadFrom(
      Readable.from(Buffer.from('PACKAGED_FTP_REPLACEMENT')),
      'replacement-stage.txt',
    );
    await ftp.rename('replacement-stage.txt', 'source.txt');
    expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
    await expect(readFile(join(shared, 'replacement-stage.txt'), 'utf8')).rejects.toThrow();
    if (process.platform !== 'win32') {
      await mkdir(join(shared, 'protected-dir'));
      await symlink('source.txt', join(shared, 'file-link'));
      await symlink('protected-dir', join(shared, 'dir-link'));
      await expect(ftp.send('DELE file-link')).rejects.toThrow();
      await expect(ftp.send('RMD dir-link')).rejects.toThrow();
      await expect(ftp.send('RNFR file-link')).rejects.toThrow();
      await expect(ftp.send('RNTO renamed-link.txt')).rejects.toThrow();
      expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
      expect(await readdir(join(shared, 'protected-dir'))).toEqual([]);
      expect(await readdir(join(shared, 'dir-link'))).toEqual([]);
      await expect(readFile(join(shared, 'renamed-link.txt'))).rejects.toThrow();
    }
    ftp.close();

    if (runLongTransfer) {
      const slowFtp = new FtpClient(45_000);
      try {
        await slowFtp.access({
          host: address.hostname,
          port: Number(address.port),
          user: 'ftpuser',
          password: 'packaged-ftp-session-only',
        });
        const slowSource = Readable.from(
          (async function* () {
            yield Buffer.from('first-');
            await new Promise((resolveWait) => setTimeout(resolveWait, 16_000));
            yield Buffer.from('middle-');
            await new Promise((resolveWait) => setTimeout(resolveWait, 16_000));
            yield Buffer.from('last');
          })(),
        );
        await slowFtp.uploadFrom(slowSource, 'long-transfer.bin');
        expect(await readFile(join(shared, 'long-transfer.bin'), 'utf8')).toBe('first-middle-last');
        expect((await slowFtp.send('NOOP')).code).toBe(200);
      } finally {
        slowFtp.close();
      }
    }

    if (runStalledTransfer) {
      const stalledFtp = new FtpClient(45_000);
      const stalledSource = new PassThrough();
      try {
        await stalledFtp.access({
          host: address.hostname,
          port: Number(address.port),
          user: 'ftpuser',
          password: 'packaged-ftp-session-only',
        });
        const startedAt = Date.now();
        const upload = stalledFtp.uploadFrom(stalledSource, 'source.txt');
        stalledSource.write('STALLED_PARTIAL_BYTES');
        await expect
          .poll(async () => (await readdir(shared)).some((name) => name.endsWith('.part')))
          .toBe(true);
        await expect(upload).rejects.toThrow();
        expect(Date.now() - startedAt).toBeGreaterThan(29_000);
        expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
        expect((await readdir(shared)).filter((name) => name.endsWith('.part'))).toEqual([]);
        const recoveryFtp = new FtpClient(5_000);
        try {
          await recoveryFtp.access({
            host: address.hostname,
            port: Number(address.port),
            user: 'ftpuser',
            password: 'packaged-ftp-session-only',
          });
          expect((await recoveryFtp.send('NOOP')).code).toBe(200);
        } finally {
          recoveryFtp.close();
        }
      } finally {
        stalledSource.destroy();
        stalledFtp.close();
      }
    }

    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const curlShared = [
      '--silent',
      '--show-error',
      '--fail',
      '--disable-epsv',
      '--max-time',
      '10',
      '--user',
      'ftpuser:packaged-ftp-session-only',
    ];
    const remoteRoot = `ftp://${address.hostname}:${address.port}/`;
    if (runActiveStalledTransfer) {
      const stalledCurl = spawn(
        curl,
        [
          '--silent',
          '--show-error',
          '--fail',
          '--max-time',
          '40',
          '--user',
          'ftpuser:packaged-ftp-session-only',
          '--ftp-port',
          '-',
          '--upload-file',
          '-',
          `${remoteRoot}source.txt`,
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      stalledCurl.stdin.on('error', () => undefined);
      stalledCurl.stderr.resume();
      const closed = once(stalledCurl, 'close');
      const startedAt = Date.now();
      try {
        stalledCurl.stdin.write('STALLED_ACTIVE_BYTES');
        await expect
          .poll(async () => {
            const stagingName = (await readdir(shared)).find((name) => name.endsWith('.part'));
            return stagingName ? (await stat(join(shared, stagingName))).size > 0 : false;
          })
          .toBe(true);
        await expect
          .poll(async () => (await readdir(shared)).every((name) => !name.endsWith('.part')), {
            timeout: 25_000,
            intervals: [250],
          })
          .toBe(true);
        expect(Date.now() - startedAt).toBeGreaterThan(14_000);
        expect(Date.now() - startedAt).toBeLessThan(30_000);
        stalledCurl.kill();
        await closed;
        expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
        expect((await readdir(shared)).filter((name) => name.endsWith('.part'))).toEqual([]);
        const recoveryFtp = new FtpClient(5_000);
        try {
          await recoveryFtp.access({
            host: address.hostname,
            port: Number(address.port),
            user: 'ftpuser',
            password: 'packaged-ftp-session-only',
          });
          expect((await recoveryFtp.send('NOOP')).code).toBe(200);
        } finally {
          recoveryFtp.close();
        }
      } finally {
        stalledCurl.stdin.destroy();
        stalledCurl.kill();
      }
    }
    if (runLongTransfer) {
      const slowDownloadSource = join(shared, 'long-download.bin');
      const slowDownloadTarget = join(directory, 'long-downloaded.bin');
      await writeFile(slowDownloadSource, Buffer.alloc(36 * 1024 * 1024, 0xa5));
      const startedAt = Date.now();
      const { stderr } = await execFileAsync(
        curl,
        [
          '--silent',
          '--show-error',
          '--fail',
          '--verbose',
          '--disable-epsv',
          '--limit-rate',
          '1M',
          '--max-time',
          '75',
          '--user',
          'ftpuser:packaged-ftp-session-only',
          '--quote',
          '-NOOP',
          '--output',
          slowDownloadTarget,
          `${remoteRoot}long-download.bin`,
        ],
        { maxBuffer: 1024 * 1024, timeout: 80_000 },
      );
      expect(Date.now() - startedAt).toBeGreaterThan(30_000);
      expect(await fileSha256(slowDownloadTarget)).toBe(await fileSha256(slowDownloadSource));
      const replies = stderr.split(/\r?\n/u).map((line) => line.trim());
      const noopIndex = replies.findIndex((line) => line === '> NOOP');
      expect(noopIndex).toBeGreaterThan(0);
      expect(replies.slice(noopIndex + 1).some((line) => /^< 200 /u.test(line))).toBe(true);
    }
    const listedByCurl = await execFileAsync(curl, [...curlShared, '--list-only', remoteRoot], {
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    expect(listedByCurl.stdout).toContain('source.txt');
    await execFileAsync(
      curl,
      [...curlShared, '--upload-file', curlSource, `${remoteRoot}curl-upload.bin`],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(join(shared, 'curl-upload.bin'))).toEqual(curlPayload);
    await execFileAsync(
      curl,
      [...curlShared, '--output', curlDownloaded, `${remoteRoot}curl-upload.bin`],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(curlDownloaded)).toEqual(curlPayload);
    await execFileAsync(
      curl,
      [
        ...curlShared,
        '--crlf',
        '--use-ascii',
        '--upload-file',
        curlAsciiSource,
        `${remoteRoot}curl-ascii.txt`,
      ],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(join(shared, 'curl-ascii.txt'))).toEqual(hostAsciiPayload);
    await execFileAsync(
      curl,
      [
        ...curlShared,
        '--use-ascii',
        '--output',
        curlAsciiDownloaded,
        `${remoteRoot}curl-ascii.txt`,
      ],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(curlAsciiDownloaded)).toEqual(hostAsciiPayload);
    await execFileAsync(
      curl,
      [
        '--silent',
        '--show-error',
        '--fail',
        '--max-time',
        '10',
        '--user',
        'ftpuser:packaged-ftp-session-only',
        '--ftp-port',
        '-',
        '--upload-file',
        curlSource,
        `${remoteRoot}curl-active-upload.bin`,
      ],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(join(shared, 'curl-active-upload.bin'))).toEqual(curlPayload);
    await execFileAsync(
      curl,
      [
        '--silent',
        '--show-error',
        '--fail',
        '--max-time',
        '10',
        '--user',
        'ftpuser:packaged-ftp-session-only',
        '--ftp-port',
        '-',
        '--output',
        curlActiveDownloaded,
        `${remoteRoot}curl-active-upload.bin`,
      ],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(curlActiveDownloaded)).toEqual(curlPayload);

    if (runStopRestart) {
      const interrupted = new FtpClient(5_000);
      const uploadSource = new PassThrough();
      try {
        await interrupted.access({
          host: address.hostname,
          port: Number(address.port),
          user: 'ftpuser',
          password: 'packaged-ftp-session-only',
        });
        const uploadResult = interrupted.uploadFrom(uploadSource, 'source.txt').then(
          () => 'completed',
          () => 'failed',
        );
        uploadSource.write('PACKAGED_STOP_PARTIAL_BYTES');
        await expect
          .poll(async () => {
            const stage = (await readdir(shared)).find((name) => name.endsWith('.part'));
            return stage ? (await stat(join(shared, stage))).size > 0 : false;
          })
          .toBe(true);
        await instance.getByTitle('停止').click();
        await instance.getByTitle('再次点击确认停止').click();
        await expect(workspace.getByText(/No running instances|没有运行中的实例/)).toBeVisible();
        uploadSource.destroy();
        interrupted.close();
        expect(await uploadResult).toBe('failed');
        expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
        expect((await readdir(shared)).filter((name) => name.endsWith('.part'))).toEqual([]);
      } finally {
        uploadSource.destroy();
        interrupted.close();
      }

      await form.locator('input[name="port"]').fill(address.port);
      await form.locator('input[name="password"]').fill('packaged-ftp-session-only');
      await form.locator('input[name="passivePortStart"]').fill('50416');
      await form.locator('input[name="passivePortEnd"]').fill('50423');
      await form.getByRole('button', { name: /Start widget|启动 Widget/ }).click();
      await expect(instance).toBeVisible();
      const restartedAddress = new URL(
        ((await instance.locator('.widget-instance-title small').textContent()) ?? '').match(
          /ftp:\/\/[^\s·]+/,
        )![0],
      );
      expect(restartedAddress.port).toBe(address.port);
      const recovered = new FtpClient(5_000);
      try {
        await recovered.access({
          host: restartedAddress.hostname,
          port: Number(restartedAddress.port),
          user: 'ftpuser',
          password: 'packaged-ftp-session-only',
        });
        expect((await recovered.send('NOOP')).code).toBe(200);
        expect((await recovered.list()).map(({ name }) => name)).toContain('source.txt');
      } finally {
        recovered.close();
      }
    }

    await instance.getByTitle('停止').click();
    await instance.getByTitle('再次点击确认停止').click();
    await expect(workspace.getByText(/No running instances|没有运行中的实例/)).toBeVisible();
  } finally {
    ftp.close();
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged app roundtrips TRZSZ binary data through a real local PTY', async () => {
  test.skip(process.platform === 'win32', 'POSIX PTY fixture requires stty');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-trzsz-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const fixture = join(directory, 'trzsz-peer.mjs');
  const sourceFile = join(directory, 'source.bin');
  const uploadTarget = join(directory, 'uploaded.bin');
  const destination = await packagedTransferDestination(directory, 'trzsz');
  const bytes = Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.alloc(16_384, 0xa5)]);
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  await writeFile(sourceFile, bytes);
  await buildFixture({
    entryPoints: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/trzsz-peer.mjs'),
    ],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, 'axterm');
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, destination);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
    await enterTerminalCommand(terminalInput, `"${process.execPath}" "${fixture}" "${sourceFile}"`);
    await expect
      .poll(() => terminalLayer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PEER_READY_SEND');
    await terminalInput.pressSequentially('!');
    await expect
      .poll(() => readFile(join(destination, 'source.bin')).catch(() => undefined), {
        timeout: 20_000,
      })
      .toEqual(bytes);
    expect(await readFile(join(destination, 'source.bin'))).toEqual(bytes);

    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, sourceFile);
    await enterTerminalCommand(
      terminalInput,
      `"${process.execPath}" "${fixture}" "${uploadTarget}" receive`,
    );
    await expect
      .poll(() => terminalLayer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PEER_READY_RECEIVE');
    await terminalInput.pressSequentially('!');
    await expect
      .poll(() => readFile(uploadTarget).catch(() => undefined), { timeout: 20_000 })
      .toEqual(bytes);
  } finally {
    await app.close().catch(() => {});
    await rm(destination, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS app rejects TRZSZ bytes beyond the announced file size', async () => {
  test.skip(process.platform !== 'darwin', 'macOS packaged transfer safety journey');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-trzsz-size-')));
  const artifact = join(directory, 'Axterm.app');
  const fixture = join(directory, 'trzsz-peer.mjs');
  const sourceFile = join(directory, 'source.bin');
  const destination = await realpath(await mkdtemp(join(directory, 'downloads-')));
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  await writeFile(sourceFile, Buffer.from([0, 1, 2, 3]));
  await buildFixture({
    entryPoints: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/trzsz-peer.mjs'),
    ],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const app = await electron.launch({
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, destination);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const terminalInput = page
      .locator('.terminal-session-layer:not([hidden])')
      .locator('.xterm-helper-textarea');
    await enterTerminalCommand(
      terminalInput,
      `"${process.execPath}" "${fixture}" "${sourceFile}" misreport-size`,
    );
    await expect
      .poll(() => page.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PEER_READY_SEND');
    await terminalInput.pressSequentially('!');
    await expect(page.locator('.terminal-transfer-indicator.failed')).toBeVisible();
    expect(await readdir(destination)).toEqual([]);
    await expect(readFile(join(destination, 'source.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS app rejects an oversized TRZSZ binary chunk header', async () => {
  test.skip(process.platform !== 'darwin', 'macOS packaged transfer safety journey');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-trzsz-chunk-')));
  const artifact = join(directory, 'Axterm.app');
  const fixture = join(directory, 'trzsz-peer.mjs');
  const sourceFile = join(directory, 'source.bin');
  const destination = await realpath(await mkdtemp(join(directory, 'downloads-')));
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  await writeFile(sourceFile, Buffer.from([0, 1, 2, 3]));
  await buildFixture({
    entryPoints: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/trzsz-peer.mjs'),
    ],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const app = await electron.launch({
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, destination);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const terminalInput = page
      .locator('.terminal-session-layer:not([hidden])')
      .locator('.xterm-helper-textarea');
    await enterTerminalCommand(
      terminalInput,
      `"${process.execPath}" "${fixture}" "${sourceFile}" oversized-chunk-header`,
    );
    await expect
      .poll(() => page.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PEER_READY_SEND');
    await terminalInput.pressSequentially('!');
    await expect(page.locator('.terminal-transfer-indicator.failed')).toBeVisible();
    expect(await readdir(destination)).toEqual([]);
    await expect(readFile(join(destination, 'source.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS app removes an active TRZSZ receive stage on graceful quit', async () => {
  test.skip(process.platform !== 'darwin', 'macOS utilityProcess shutdown journey');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-trzsz-quit-')));
  const artifact = join(directory, 'Axterm.app');
  const fixture = join(directory, 'trzsz-peer.mjs');
  const sourceFile = join(directory, 'source.bin');
  const destination = await realpath(await mkdtemp(join(directory, 'downloads-')));
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  await writeFile(sourceFile, Buffer.alloc(4 * 1024 * 1024, 0xa5));
  await buildFixture({
    entryPoints: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/trzsz-peer.mjs'),
    ],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const app = await electron.launch({
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, destination);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
    await enterTerminalCommand(
      terminalInput,
      `"${process.execPath}" "${fixture}" "${sourceFile}" stall-after-first-chunk`,
    );
    await expect
      .poll(() => terminalLayer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PEER_READY_SEND');
    await terminalInput.pressSequentially('!');
    await expect
      .poll(
        async () => {
          const staged = (await readdir(destination)).find(isTransferStage);
          return staged ? (await stat(join(destination, staged))).size : 0;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    await app.close();
    expect(await readdir(destination)).toEqual([]);
    await expect(readFile(join(destination, 'source.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS active TRZSZ receive survives a hard-kill/restart without publishing incomplete bytes', async () => {
  test.skip(
    process.platform !== 'darwin' || process.env.AXTERM_PACKAGED_TRANSFER_CRASH_PROBE !== '1',
    'opt-in hard-kill diagnostic for a copied macOS package',
  );
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-trzsz-crash-')));
  const artifact = join(directory, 'Axterm.app');
  const fixture = join(directory, 'trzsz-peer.mjs');
  const sourceFile = join(directory, 'source.bin');
  const destination = await packagedTransferDestination(directory, 'trzsz-recovery');
  const userData = join(directory, 'user-data');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  await writeFile(sourceFile, Buffer.alloc(4 * 1024 * 1024, 0xa5));
  await buildFixture({
    entryPoints: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/trzsz-peer.mjs'),
    ],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const launch = () =>
    electron.launch({
      executablePath: join(artifact, 'Contents/MacOS/Axterm'),
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
    });
  const app = await launch();
  let restarted: typeof app | undefined;
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, destination);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
    await enterTerminalCommand(
      terminalInput,
      `"${process.execPath}" "${fixture}" "${sourceFile}" stall-after-first-chunk`,
    );
    await expect
      .poll(() => terminalLayer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PEER_READY_SEND');
    await terminalInput.pressSequentially('!');
    try {
      await expect
        .poll(
          async () => {
            const staged = (await readdir(destination)).find(isTransferStage);
            return staged ? (await stat(join(destination, staged))).size : 0;
          },
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
    } catch (error) {
      throw new Error(
        `Stage did not begin: ${JSON.stringify({ destination, entries: await readdir(destination), screen: await page.locator('body').innerText() })}`,
        { cause: error },
      );
    }

    const exited = once(app.process(), 'exit');
    expect(app.process().kill('SIGKILL')).toBe(true);
    await exited;
    await expect(readFile(join(destination, 'source.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    restarted = await launch();
    const recoveredPage = await restarted.firstWindow();
    await expect(recoveredPage.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(readFile(join(destination, 'source.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const leftoverStages = (await readdir(destination)).filter(isTransferStage);
    expect(leftoverStages).toHaveLength(1);
    await restarted.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, destination);
    await recoveredPage
      .locator('.terminal-session-layer:not([hidden]) .terminal-host')
      .click({ button: 'right' });
    await recoveredPage
      .getByRole('menuitem', {
        name: /Review interrupted downloads|检查中断的下载|中断したダウンロードを確認|檢查中斷的下載/u,
      })
      .click();
    const review = recoveredPage.getByRole('dialog', {
      name: /Interrupted download files|中断的下载文件|中断したダウンロードファイル|中斷的下載檔案/u,
    });
    await expect(review).toBeVisible();
    await expect(review).toContainText('source.bin');
    expect(await review.textContent()).not.toContain(destination);
    expect((await readdir(destination)).filter(isTransferStage)).toHaveLength(1);
    await review
      .getByRole('button', {
        name: /Remove partial|删除暂存文件|一時ファイルを削除|刪除暫存檔案/u,
      })
      .click();
    await review
      .getByRole('button', {
        name: /Confirm removal|确认删除|削除を確定|確認刪除/u,
      })
      .click();
    await expect(review).toContainText(
      /No recorded partial files|没有已记录的暂存文件|記録済みの一時ファイルはありません|沒有已記錄的暫存檔案/u,
    );
    expect((await readdir(destination)).filter(isTransferStage)).toEqual([]);
    await expect(readFile(join(destination, 'source.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await restarted?.close().catch(() => {});
    await app.close().catch(() => {});
    await rm(destination, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

for (const protocol of ['xmodem', 'zmodem'] as const) {
  test(`packaged macOS ${protocol.toUpperCase()} hard-kill recovery requires re-Grant and confirmation`, async () => {
    test.skip(
      process.platform !== 'darwin' || process.env.AXTERM_PACKAGED_TRANSFER_CRASH_PROBE !== '1',
      'opt-in hard-kill recovery probe for the current macOS package',
    );
    test.setTimeout(90_000);
    await access(source);
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), `axterm-packaged-${protocol}-crash-`)),
    );
    const artifact = join(directory, 'Axterm.app');
    const fixture = join(directory, `${protocol}-peer.mjs`);
    const sourceFile = join(directory, 'source.bin');
    const destination = await packagedTransferDestination(directory, `${protocol}-recovery`);
    const userData = join(directory, 'user-data');
    const finalName = protocol === 'xmodem' ? 'xmodem-download.bin' : 'source.bin';
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    await writeFile(sourceFile, Buffer.alloc(4 * 1024 * 1024, 0xa5));
    await buildFixture({
      entryPoints: [
        resolve(`packages/runtime/src/adapters/terminal-transfer/fixtures/${protocol}-peer.mjs`),
      ],
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
    });
    const launch = () =>
      electron.launch({
        executablePath: join(artifact, 'Contents/MacOS/Axterm'),
        args: [`--user-data-dir=${userData}`],
        cwd: directory,
        env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
      });
    const app = await launch();
    let restarted: typeof app | undefined;
    try {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      }, destination);
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      const layer = page.locator('.terminal-session-layer:not([hidden])');
      const input = layer.locator('.xterm-helper-textarea');
      await enterTerminalCommand(
        input,
        `"${process.execPath}" "${fixture}" "${sourceFile}" send stall-after-first-chunk`,
      );
      await expect
        .poll(() => layer.locator('.xterm-rows').textContent())
        .toContain(`AXTERM_${protocol.toUpperCase()}_READY_SEND`);
      await input.pressSequentially('!');
      if (protocol === 'xmodem') {
        await layer.locator('.terminal-host').click({ button: 'right' });
        await page
          .getByRole('menuitem', {
            name: /XMODEM 接收文件|Receive file with XMODEM|XMODEM でファイルを受信|使用 XMODEM 接收檔案/u,
          })
          .click();
      }
      await expect
        .poll(
          async () => {
            const staged = (await readdir(destination)).find(isTransferStage);
            return staged ? (await stat(join(destination, staged))).size : 0;
          },
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
      const exited = once(app.process(), 'exit');
      expect(app.process().kill('SIGKILL')).toBe(true);
      await exited;
      await expect(readFile(join(destination, finalName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      restarted = await launch();
      const recoveredPage = await restarted.firstWindow();
      await expect(recoveredPage.getByTestId('runtime-state')).toHaveAttribute(
        'data-state',
        'ready',
      );
      expect((await readdir(destination)).filter(isTransferStage)).toHaveLength(1);
      await restarted.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      }, destination);
      await recoveredPage
        .locator('.terminal-session-layer:not([hidden]) .terminal-host')
        .click({ button: 'right' });
      await recoveredPage
        .getByRole('menuitem', {
          name: /Review interrupted downloads|检查中断的下载|中断したダウンロードを確認|檢查中斷的下載/u,
        })
        .click();
      const review = recoveredPage.getByRole('dialog');
      await expect(review).toContainText(finalName);
      await expect(review).toContainText(protocol.toUpperCase());
      expect(await review.textContent()).not.toContain(destination);
      await review
        .getByRole('button', {
          name: /Remove partial|删除暂存文件|一時ファイルを削除|刪除暫存檔案/u,
        })
        .click();
      await review
        .getByRole('button', {
          name: /Confirm removal|确认删除|削除を確定|確認刪除/u,
        })
        .click();
      await expect
        .poll(async () => (await readdir(destination)).filter(isTransferStage))
        .toEqual([]);
      await expect(readFile(join(destination, finalName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await restarted?.close().catch(() => {});
      await app.close().catch(() => {});
      await rm(destination, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('packaged macOS recovery rejects a stale Grant after Runtime utility generation changes', async () => {
  test.skip(
    process.platform !== 'darwin' || process.env.AXTERM_PACKAGED_TRANSFER_CRASH_PROBE !== '1',
    'opt-in utilityProcess generation recovery probe',
  );
  test.setTimeout(90_000);
  await access(source);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'axterm-packaged-stage-generation-')),
  );
  const artifact = join(directory, 'Axterm.app');
  const fixture = join(directory, 'trzsz-peer.mjs');
  const sourceFile = join(directory, 'source.bin');
  const destination = await packagedTransferDestination(directory, 'trzsz-generation');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  await writeFile(sourceFile, Buffer.alloc(4 * 1024 * 1024, 0xa5));
  await buildFixture({
    entryPoints: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/trzsz-peer.mjs'),
    ],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const app = await electron.launch({
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, destination);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const input = page.locator('.terminal-session-layer:not([hidden]) .xterm-helper-textarea');
    await enterTerminalCommand(
      input,
      `"${process.execPath}" "${fixture}" "${sourceFile}" stall-after-first-chunk`,
    );
    await expect
      .poll(() => page.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PEER_READY_SEND');
    await input.pressSequentially('!');
    await expect
      .poll(
        async () => {
          const staged = (await readdir(destination)).find(isTransferStage);
          return staged ? (await stat(join(destination, staged))).size : 0;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    const generation = await page.getByTestId('runtime-generation').innerText();
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const runtimePid = Number(
      await page.locator('.runtime-identity dl div').nth(2).locator('dd').innerText(),
    );
    expect(runtimePid).toBeGreaterThan(0);
    process.kill(runtimePid, 'SIGKILL');
    await expect(page.getByTestId('runtime-generation')).not.toHaveText(generation);
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    expect((await readdir(destination)).filter(isTransferStage)).toHaveLength(1);
    await page.locator('.pane-tabbar button.tab-add').click();
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await page
      .locator('.terminal-session-layer:not([hidden]) .terminal-host')
      .click({ button: 'right' });
    await page
      .getByRole('menuitem', {
        name: /Review interrupted downloads|检查中断的下载|中断したダウンロードを確認|檢查中斷的下載/u,
      })
      .click();
    const review = page.getByRole('dialog');
    await expect(review).toContainText('source.bin');
    await review
      .getByRole('button', {
        name: /Remove partial|删除暂存文件|一時ファイルを削除|刪除暫存檔案/u,
      })
      .click();
    await review
      .getByRole('button', {
        name: /Confirm removal|确认删除|削除を確定|確認刪除/u,
      })
      .click();
    await expect.poll(async () => (await readdir(destination)).filter(isTransferStage)).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await rm(destination, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged app roundtrips ZMODEM binary data through a real local PTY', async () => {
  test.skip(process.platform === 'win32', 'POSIX PTY fixture requires stty');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-zmodem-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const fixture = join(directory, 'zmodem-peer.mjs');
  const sourceFile = join(directory, 'source.bin');
  const uploadTarget = join(directory, 'uploaded.bin');
  const destination = await packagedTransferDestination(directory, 'zmodem');
  const bytes = Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.alloc(16_384, 0xa5)]);
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  await writeFile(sourceFile, bytes);
  await buildFixture({
    entryPoints: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/zmodem-peer.mjs'),
    ],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, 'axterm');
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, destination);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
    await enterTerminalCommand(terminalInput, `"${process.execPath}" "${fixture}" "${sourceFile}"`);
    await expect
      .poll(() => terminalLayer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_ZMODEM_READY_SEND');
    await terminalInput.pressSequentially('!');
    await expect
      .poll(() => readFile(join(destination, 'source.bin')).catch(() => undefined), {
        timeout: 20_000,
      })
      .toEqual(bytes);

    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, sourceFile);
    await enterTerminalCommand(
      terminalInput,
      `"${process.execPath}" "${fixture}" "${uploadTarget}" receive`,
    );
    await expect
      .poll(() => terminalLayer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_ZMODEM_READY_RECEIVE');
    await terminalInput.pressSequentially('!');
    try {
      await expect
        .poll(() => readFile(uploadTarget).catch(() => undefined), { timeout: 20_000 })
        .toEqual(bytes);
    } catch (error) {
      const state = await terminalLayer
        .locator('.terminal-surface')
        .getAttribute('data-terminal-transfer');
      const indicator = await terminalLayer
        .locator('.terminal-transfer-indicator')
        .textContent()
        .catch(() => '');
      const rows = (await terminalLayer.locator('.xterm-rows').textContent())?.slice(-400);
      throw new Error(`ZMODEM upload failed: state=${state} indicator=${indicator} rows=${rows}`, {
        cause: error,
      });
    }
  } finally {
    await app.close().catch(() => {});
    await rm(destination, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged app roundtrips XMODEM binary data through explicit terminal actions', async () => {
  test.skip(process.platform === 'win32', 'POSIX PTY fixture requires stty');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-xmodem-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const fixture = join(directory, 'xmodem-peer.mjs');
  const sourceFile = join(directory, 'source.bin');
  const uploadTarget = join(directory, 'uploaded.bin');
  const destination = await packagedTransferDestination(directory, 'xmodem');
  const bytes = Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.alloc(16_380, 0xa5)]);
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  await writeFile(sourceFile, bytes);
  await buildFixture({
    entryPoints: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/xmodem-peer.mjs'),
    ],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, 'axterm');
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, destination);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    const terminalHost = terminalLayer.locator('.terminal-host');
    await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');
    const terminalInput = terminalLayer.locator('.xterm-helper-textarea');

    await enterTerminalCommand(terminalInput, `"${process.execPath}" "${fixture}" "${sourceFile}"`);
    await expect
      .poll(() => terminalLayer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_XMODEM_READY_SEND');
    await terminalInput.pressSequentially('!');
    await terminalHost.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /XMODEM 接收文件|Receive file with XMODEM/ }).click();
    await expect
      .poll(() => readFile(join(destination, 'xmodem-download.bin')).catch(() => undefined), {
        timeout: 20_000,
      })
      .toEqual(bytes);
    await expect(terminalLayer.locator('.terminal-surface')).toHaveAttribute(
      'data-terminal-transfer',
      'completed',
    );

    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, sourceFile);
    await enterTerminalCommand(
      terminalInput,
      `"${process.execPath}" "${fixture}" "${uploadTarget}" receive`,
    );
    await expect
      .poll(() => terminalLayer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_XMODEM_READY_RECEIVE');
    await terminalHost.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /XMODEM 发送文件|Send file with XMODEM/ }).click();
    await expect(terminalLayer.locator('.terminal-surface')).toHaveAttribute(
      'data-terminal-transfer',
      'waiting-peer',
    );
    await terminalInput.pressSequentially('!');
    await expect
      .poll(() => readFile(uploadTarget).catch(() => undefined), { timeout: 20_000 })
      .toEqual(bytes);
    await expect(terminalLayer.locator('.terminal-surface')).toHaveAttribute(
      'data-terminal-transfer',
      'completed',
    );
  } finally {
    await app.close().catch(() => {});
    await rm(destination, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

for (const protocol of ['trzsz', 'zmodem', 'xmodem'] as const) {
  test(`packaged app rejects unsafe real-volume publication through ${protocol} without a partial file`, async () => {
    test.skip(
      process.platform !== 'darwin' || !realNoReplaceDirectory,
      'requires a real macOS volume that rejects hard links and native no-replace rename',
    );
    test.setTimeout(90_000);
    await access(source);
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), `axterm-packaged-${protocol}-unsupported-publication-`)),
    );
    const destination = await realpath(
      await mkdtemp(join(realNoReplaceDirectory, `axterm-packaged-${protocol}-`)),
    );
    const artifact = join(directory, 'Axterm.app');
    const fixture = join(directory, `${protocol}-peer.mjs`);
    const sourceFile = join(directory, 'source.bin');
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    await writeFile(sourceFile, Buffer.alloc(1024, 0xa5));
    await buildFixture({
      entryPoints: [
        resolve(`packages/runtime/src/adapters/terminal-transfer/fixtures/${protocol}-peer.mjs`),
      ],
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
    });
    const app = await electron.launch({
      executablePath: join(artifact, 'Contents/MacOS/Axterm'),
      args: [`--user-data-dir=${join(directory, 'user-data')}`],
      cwd: directory,
      env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
    });
    try {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      }, destination);
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
      const terminalHost = terminalLayer.locator('.terminal-host');
      await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');
      const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
      await enterTerminalCommand(
        terminalInput,
        `"${process.execPath}" "${fixture}" "${sourceFile}"`,
      );
      const readyMarker =
        protocol === 'trzsz'
          ? 'AXTERM_PEER_READY_SEND'
          : `AXTERM_${protocol.toUpperCase()}_READY_SEND`;
      await expect
        .poll(() => terminalLayer.locator('.xterm-rows').textContent())
        .toContain(readyMarker);
      await terminalInput.pressSequentially('!');
      if (protocol === 'xmodem') {
        await terminalHost.click({ button: 'right' });
        await page
          .getByRole('menuitem', { name: /XMODEM 接收文件|Receive file with XMODEM/ })
          .click();
      }
      await expect(terminalLayer.locator('.terminal-surface')).toHaveAttribute(
        'data-terminal-transfer',
        'failed',
      );
      await expect(terminalLayer.locator('.terminal-transfer-indicator')).toContainText(
        /目标文件系统无法安全保存接收文件|This destination filesystem cannot safely publish/u,
      );
      expect((await readdir(destination)).filter((name) => !name.startsWith('._'))).toEqual([]);
    } finally {
      await app.close().catch(() => {});
      await rm(destination, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('packaged app exposes its exact license and notices in About', async () => {
  test.setTimeout(90_000);
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-legal-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="legal"]').click();
    const panel = page.locator('.legal-notices-panel');
    await expect(panel).toBeVisible();
    await panel.getByText('阅读 Apache-2.0 许可证').click();
    await panel.getByText('阅读第三方声明').click();
    expect(await panel.locator('details').nth(0).locator('pre').textContent()).toBe(
      await readFile(resolve('LICENSE'), 'utf8'),
    );
    expect(await panel.locator('details').nth(1).locator('pre').textContent()).toBe(
      await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8'),
    );
    const topDetails = panel.locator(':scope > details');
    const detailsWithSummary = (name: string) => {
      const exactName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      return topDetails.filter({
        has: page.locator(':scope > summary', { hasText: exactName }),
      });
    };
    expect(
      (await topDetails.locator(':scope > summary').allTextContents())
        .filter((name) => name.endsWith('.txt'))
        .sort(),
    ).toEqual(licenseDocuments);
    expect(licenseDocuments).toContain('isarray-README.txt');
    expect(licenseDocuments).toContain('trzsz-js-LICENSE.txt');
    expect(licenseDocuments).toContain('chromium-dom-code-data-LICENSE.txt');
    const ironRdpDetails = detailsWithSummary('IronRDP-LICENSE-APACHE.txt');
    await ironRdpDetails.locator(':scope > summary').click();
    await expect(ironRdpDetails.locator('pre')).toBeVisible();
    for (const name of licenseDocuments) {
      const details = detailsWithSummary(name);
      if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) {
        await details.locator(':scope > summary').click();
      }
      await expect(details.locator('pre')).toBeVisible();
      expect(await details.locator('pre').textContent()).toBe(
        await readFile(resolve('licenses', name), 'utf8'),
      );
    }
    const runtimeLicenseDetails = detailsWithSummary('查看 Electron 与 Chromium 声明');
    await runtimeLicenseDetails.locator(':scope > summary').click();
    const electronRuntimeDetails = runtimeLicenseDetails.locator('details').filter({
      has: page.locator('summary', { hasText: 'Electron 许可证' }),
    });
    await electronRuntimeDetails.locator('summary').click();
    await expect(
      page.frameLocator('iframe[title="Electron 许可证"]').locator('body'),
    ).toContainText('Electron contributors');
    const chromiumRuntimeDetails = runtimeLicenseDetails.locator('details').filter({
      has: page.locator('summary', { hasText: 'Chromium 声明' }),
    });
    const chromiumResponse = page.waitForResponse(
      (response) => response.url() === 'axterm-license://chromium/',
    );
    await chromiumRuntimeDetails.locator('summary').click();
    const response = await chromiumResponse;
    expect(response.status()).toBe(200);
    expect(Number(response.headers()['content-length'])).toBeGreaterThan(1_000_000);
    await chromiumRuntimeDetails.locator('summary').click();
    const componentDetails = detailsWithSummary('THIRD_PARTY_COMPONENTS.json');
    await componentDetails.locator('summary').click();
    await expect(componentDetails.locator('summary')).toHaveText('THIRD_PARTY_COMPONENTS.json');
    expect(await componentDetails.locator('pre').textContent()).toBe(
      await readFile(resolve('compliance/THIRD_PARTY_COMPONENTS.json'), 'utf8'),
    );
    const sbomDetails = detailsWithSummary('AXTERM_PRODUCTION_DEPENDENCIES.spdx.json');
    await sbomDetails.locator('summary').click();
    await expect(sbomDetails.locator('summary')).toHaveText(
      'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
    );
    expect(await sbomDetails.locator('pre').textContent()).toBe(
      await readFile(resolve('compliance/AXTERM_PRODUCTION_DEPENDENCIES.spdx.json'), 'utf8'),
    );
    const licenseTextsDetails = detailsWithSummary('THIRD_PARTY_LICENSE_TEXTS.json');
    await licenseTextsDetails.locator('summary').first().click();
    await expect(licenseTextsDetails.locator('summary').first()).toHaveText(
      'THIRD_PARTY_LICENSE_TEXTS.json',
    );
    const archive = JSON.parse(
      await readFile(resolve('compliance/THIRD_PARTY_LICENSE_TEXTS.json'), 'utf8'),
    ) as {
      limitations: string[];
      missingCopyrightDeclarations: Array<{ name: string; version: string }>;
      components: Array<{
        name: string;
        version: string;
        files: Array<{ name: string; content: string }>;
        attribution: {
          manifestPublisherRecords: Array<{
            field: 'author' | 'contributors';
            value: string | Record<string, unknown>;
          }>;
          manifestCopyright: string | null;
          rootLicenseCopyrightLines: Array<{ file: string; line: string }>;
        };
      }>;
    };
    const attributionDetails = licenseTextsDetails.locator('details').filter({
      has: page.locator('summary', { hasText: '查看软件包署名元数据' }),
    });
    await attributionDetails.locator('summary').click();
    expect(await attributionDetails.locator('pre').textContent()).toBe(
      JSON.stringify(
        {
          source:
            'Package manifest author/contributor and copyright fields plus copyright lines extracted from installed root LICENSE/COPYING/NOTICE files.',
          reviewQueue: archive.missingCopyrightDeclarations,
          components: archive.components.map(({ name, version, attribution }) => ({
            name,
            version,
            ...attribution,
          })),
          limitations: archive.limitations,
        },
        null,
        2,
      ),
    );
    for (const name of ['@fontsource/maple-mono', 'spice-client', 'ssh2']) {
      const component = archive.components.find((entry) => entry.name === name);
      expect(component?.files.length).toBeGreaterThan(0);
      const file = component?.files[0];
      if (!component || !file) throw new Error(`Missing packaged license text for ${name}`);
      const details = licenseTextsDetails.locator('details').filter({
        has: page.locator('summary', {
          hasText: `${component.name}@${component.version}/${file.name}`,
        }),
      });
      await details.locator('summary').click();
      expect(await details.locator('pre').textContent()).toBe(file.content);
    }
    await page.locator('[data-settings-category="common"]').click();
    await expect(panel).toBeHidden();
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Axterm configuration surfaces pass rendered accessibility scans without retired import UI', async () => {
  test.setTimeout(90_000);
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-accessibility-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const userData = join(directory, 'user-data');
  const invalidConfigurationFixture = join(directory, 'invalid-configuration.json');
  const configurationPath = join(directory, 'axterm-configuration.json');
  await writeFile(invalidConfigurationFixture, '{"formatVersion":');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
    },
  });
  try {
    await app.context().addInitScript({ path: axeScriptPath });
    await app.evaluate(
      ({ dialog }, selections) => {
        let openIndex = 0;
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [
              selections.openPaths[Math.min(openIndex++, selections.openPaths.length - 1)]!,
            ],
          })) as typeof dialog.showOpenDialog;
        dialog.showSaveDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePath: selections.savePath,
          })) as typeof dialog.showSaveDialog;
      },
      {
        openPaths: [configurationPath, configurationPath, invalidConfigurationFixture],
        savePath: configurationPath,
      },
    );
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.bringToFront();
    await expectPackagedAxeClean(page, 'packaged startup shell');
    const activateByKeyboard = async (control: Locator) => {
      await page.bringToFront();
      await control.focus();
      await expect(control).toBeFocused();
      await control.press('Enter');
    };

    await activateByKeyboard(page.locator('[data-activity-item="setting"]'));
    await activateByKeyboard(page.locator('[data-settings-category="common"]'));
    await expect(page.getByLabel('Legacy Prototype 数据迁移')).toHaveCount(0);
    const configuration = page.getByLabel('Axterm 配置快照');
    await activateByKeyboard(configuration.getByRole('button', { name: '导出 Axterm 配置' }));
    await expect(configuration.getByText('Axterm 配置已导出', { exact: true })).toBeVisible();
    await activateByKeyboard(configuration.getByRole('button', { name: '检查 Axterm 文件' }));
    await expect(configuration.getByText('Axterm 文件检查完成', { exact: true })).toBeVisible();
    await expectPackagedAxeClean(page, 'packaged Axterm configuration inspection');
    await activateByKeyboard(configuration.getByRole('button', { name: '导入 Axterm 配置' }));
    const configurationPreview = configuration.locator('.axterm-config-preview');
    await expect(configurationPreview).toBeVisible();
    await expect(configurationPreview.locator('.axterm-config-preview-note')).toContainText(
      '保留当前设置和 application-local Vault',
    );
    await expectPackagedAxeClean(page, 'packaged independent Axterm configuration preview');
    await activateByKeyboard(
      configurationPreview.getByRole('button', { name: '丢弃 Axterm 配置预览' }),
    );
    await expect(configurationPreview).toBeHidden();
    await activateByKeyboard(configuration.getByRole('button', { name: '导入 Axterm 配置' }));
    await expect(configuration.getByRole('alert')).toBeVisible();
    await expectPackagedAxeClean(page, 'packaged malformed Axterm configuration');

    await activateByKeyboard(page.getByRole('button', { name: '终端配置', exact: true }));
    const connectionConfiguration = page.getByRole('region', { name: '连接配置' });
    const protocolTabs = connectionConfiguration.getByRole('tablist', { name: '配置适用协议' });
    const sshTab = protocolTabs.getByRole('tab', { name: 'SSH' });
    const spiceTab = protocolTabs.getByRole('tab', { name: 'SPICE' });
    await expectPackagedAxeClean(page, 'packaged SSH connection configuration');
    await sshTab.focus();
    await sshTab.press('End');
    await expect(spiceTab).toBeFocused();
    await expect(spiceTab).toHaveAttribute('aria-selected', 'true');
    await expect(connectionConfiguration.getByRole('tabpanel', { name: 'SPICE' })).toBeVisible();
    await spiceTab.press('Tab');
    await expect(
      connectionConfiguration.getByRole('tabpanel', { name: 'SPICE' }).getByRole('textbox', {
        name: '用户名',
      }),
    ).toBeFocused();
    await expectPackagedAxeClean(page, 'packaged SPICE connection configuration');

    await activateByKeyboard(page.getByRole('button', { name: '关闭设置并返回工作区' }));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expectPackagedAxeClean(page, 'packaged Shell after configuration review');
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS Shell and Settings remain bounded at three viewports', async () => {
  test.skip(process.platform !== 'darwin', 'macOS packaged visual evidence is platform-specific.');
  test.setTimeout(90_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-visual-')));
  const artifact = join(directory, 'Axterm.app');
  const userData = join(directory, 'user-data');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    app = await electron.launch({
      executablePath: join(artifact, 'Contents/MacOS/Axterm'),
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
    });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await expect(page.getByRole('heading', { name: '主机与连接' })).toBeVisible();

    for (const { width, height } of [
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize({ width, height });
      await expect
        .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
        .toEqual([width, height]);
      await page.evaluate(() => document.fonts.ready);
      const outOfBounds = await page.evaluate(() => {
        const selectors = ['.activity-bar', '.workspace-sidebar'];
        return selectors.flatMap((selector) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) return [`${selector}: missing`];
          const bounds = element.getBoundingClientRect();
          return bounds.left < -1 ||
            bounds.top < -1 ||
            bounds.right > innerWidth + 1 ||
            bounds.bottom > innerHeight + 1
            ? [`${selector}: ${JSON.stringify(bounds.toJSON())}`]
            : [];
        });
      });
      expect(outOfBounds).toEqual([]);
      await page.screenshot({
        path: join(packagedEvidenceDirectory, `macos-shell-${width}x${height}.png`),
        animations: 'disabled',
        caret: 'hide',
      });

      if (width === 1280) {
        const addHost = page.getByRole('button', { name: '添加主机' });
        await addHost.click();
        const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
        await expect(dialog.getByLabel('名称')).toBeFocused();
        const bounds = await dialog.evaluate((element) => element.getBoundingClientRect().toJSON());
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(width);
        expect(bounds.bottom).toBeLessThanOrEqual(height);
        await page.screenshot({
          path: join(packagedEvidenceDirectory, 'macos-host-dialog-1280x800.png'),
          animations: 'disabled',
          caret: 'hide',
        });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(addHost).toBeFocused();
      }

      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="terminal"]').click();
      await expect(page.getByRole('region', { name: '终端配置' })).toBeVisible();
      const settingsBounds = await page
        .getByRole('region', { name: '终端配置' })
        .evaluate((element) => element.getBoundingClientRect().toJSON());
      expect(settingsBounds.left).toBeGreaterThanOrEqual(0);
      expect(settingsBounds.right).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: join(packagedEvidenceDirectory, `macos-settings-${width}x${height}.png`),
        animations: 'disabled',
        caret: 'hide',
      });
      await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    }
  } finally {
    await app?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS U3 keeps compact Shell, Settings and dialogs accessible at 200% zoom', async () => {
  test.skip(process.platform !== 'darwin', 'macOS packaged UX evidence is platform-specific.');
  test.setTimeout(120_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-u3-')));
  const artifact = join(directory, 'Axterm.app');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    app = await electron.launch({
      executablePath: join(artifact, 'Contents/MacOS/Axterm'),
      args: [`--user-data-dir=${join(directory, 'user-data')}`],
      cwd: directory,
      env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
    });
    await app.context().addInitScript({ path: axeScriptPath });
    const page = await app.firstWindow();
    const activateByKeyboard = async (control: Locator) => {
      await page.bringToFront();
      await control.focus();
      await expect(control).toBeFocused();
      await control.press('Enter');
    };
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([640, 400]);

    const layout = page.getByTitle('布局与工作区');
    await activateByKeyboard(layout);
    await activateByKeyboard(page.locator('[data-layout-choice="c2x2"]'));
    const firstPane = page.locator('.empty-pane-landing').first();
    await expect(page.locator('.empty-pane-landing')).toHaveCount(3);
    for (const control of [
      firstPane.getByRole('button', { name: '新建终端' }),
      firstPane.getByRole('button', { name: '不保存直接连接' }),
      firstPane.getByRole('button', { name: '添加已保存连接' }),
      firstPane.getByRole('button', { name: '使用 AI 草拟连接' }),
      firstPane.getByLabel('为窗格 2 选择已有会话'),
    ]) {
      await control.focus();
      await expect(control).toBeInViewport();
    }
    expect(await firstPane.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
    await expectPackagedAxeClean(page, 'U3 packaged compact empty panes');
    await page.screenshot({
      path: join(packagedEvidenceDirectory, 'macos-u3-empty-panes-200-percent.png'),
      animations: 'disabled',
      caret: 'hide',
    });

    await activateByKeyboard(page.locator('[data-activity-item="bookmarks"]'));
    await expectPackagedAxeClean(page, 'U3 packaged compact host sidebar');
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    const addHost = page.getByRole('button', { name: '添加主机' });
    await activateByKeyboard(addHost);
    const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(dialog.getByLabel('名称')).toBeFocused();
    for (const control of [
      dialog.getByLabel('名称'),
      dialog.getByLabel('主机地址'),
      dialog.getByLabel('用户名'),
      dialog.getByRole('tab').last(),
    ]) {
      await control.focus();
      await expect(control).toBeInViewport();
    }
    await expectPackagedAxeClean(page, 'U3 packaged compact SSH dialog');
    await page.keyboard.press('Escape');
    await expect(addHost).toBeFocused();

    await activateByKeyboard(page.locator('.status-transfer'));
    const transferCenter = page.locator('.transfer-center');
    await expect(transferCenter).toBeVisible();
    await expectPackagedAxeClean(page, 'U3 packaged compact transfer center');
    const transferBounds = await transferCenter.evaluate((element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom, width: innerWidth, height: innerHeight };
    });
    expect(transferBounds.left).toBeGreaterThanOrEqual(0);
    expect(transferBounds.right).toBeLessThanOrEqual(transferBounds.width);
    expect(transferBounds.top).toBeGreaterThanOrEqual(0);
    expect(transferBounds.bottom).toBeLessThanOrEqual(transferBounds.height);
    await page.keyboard.press('Escape');

    await activateByKeyboard(page.locator('[data-activity-item="setting"]'));
    const categories = page.getByRole('complementary', { name: '设置项目' });
    for (const category of ['common', 'terminal', 'legal'] as const) {
      const button = categories.locator(`[data-settings-category="${category}"]`);
      await button.focus();
      await expect(button).toBeInViewport();
      await button.press('Enter');
      await expect(button).toHaveAttribute('aria-current', 'page');
      await expectPackagedAxeClean(page, `U3 packaged compact Settings ${category}`);
    }
    await page.screenshot({
      path: join(packagedEvidenceDirectory, 'macos-u3-settings-200-percent.png'),
      animations: 'disabled',
      caret: 'hide',
    });

    const maximumMotion = await page.locator('.app-shell').evaluate((root) =>
      Math.max(
        0,
        ...Array.from(root.querySelectorAll<HTMLElement>('*'))
          .filter((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0;
          })
          .flatMap((element) => {
            const style = getComputedStyle(element);
            return [style.animationDuration, style.transitionDuration];
          })
          .flatMap((value) =>
            value.split(',').map((duration) => {
              const normalized = duration.trim();
              return normalized.endsWith('ms')
                ? Number.parseFloat(normalized)
                : normalized.endsWith('s')
                  ? Number.parseFloat(normalized) * 1_000
                  : 0;
            }),
          ),
      ),
    );
    expect(maximumMotion).toBeLessThanOrEqual(0.01);
  } finally {
    await app?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Axterm configuration rejects the retired custom-theme file without creating data', async () => {
  test.setTimeout(90_000);
  await access(source);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'axterm-packaged-theme-migration-')),
  );
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const userData = join(directory, 'user-data');
  const fixturePath = resolve(
    'tests/fixtures/migration/legacy-prototype-v1.101.16-custom-terminal-theme-ui-export-v1.json',
  );
  const raw = await readFile(fixturePath, 'utf8');
  expect(sha256(Buffer.from(raw))).toBe(
    'c366a2a2462cf6c795d867aac7c1942a4895b6a9ab6246c9adfcd5cb47908067',
  );
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    const executablePath =
      process.platform === 'darwin'
        ? join(artifact, 'Contents/MacOS/Axterm')
        : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    await app.context().addInitScript({ path: axeScriptPath });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, fixturePath);

    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();

    await expect(page.getByLabel('Legacy Prototype 数据迁移')).toHaveCount(0);
    const configuration = page.getByLabel('Axterm 配置快照');
    await configuration.getByRole('button', { name: '导入 Axterm 配置' }).click();
    await expect(configuration.getByRole('alert')).toBeVisible();
    await expect(configuration.locator('.axterm-config-preview')).toHaveCount(0);
    await expectPackagedAxeClean(page, 'packaged rejected retired custom-theme file');
    await app.close();
    app = undefined;
    const database = new DatabaseSync(join(userData, 'data-v2', 'axterm.sqlite'), {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM terminal_themes WHERE name='Axterm Aurora Test'")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%import_entries%'",
          )
          .all(),
      ).toEqual([{ name: 'axterm_configuration_import_entries' }]);
    } finally {
      database.close();
    }
  } finally {
    await app?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged official IronRDP backend initializes after copying outside the checkout', async () => {
  await access(source);
  const resources =
    process.platform === 'darwin' ? join(source, 'Contents/Resources') : join(source, 'resources');
  const bundles = inventoryPackagedResources(resources).rendererAssets.filter((asset: string) =>
    /\/iron-remote-desktop-rdp-[^/]+\.js$/u.test(asset),
  );
  expect(bundles).toHaveLength(1);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-ironrdp-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const result = await page.evaluate(async (asset) => {
      const url = new URL(asset.replace(/^\/out\/renderer\//u, ''), document.baseURI);
      const module = (await import(/* @vite-ignore */ url.href)) as {
        init(logLevel: string): Promise<void>;
        Backend: {
          DesktopSize: new (
            width: number,
            height: number,
          ) => {
            width: number;
            height: number;
            free(): void;
          };
        };
      };
      await module.init('warn');
      const size = new module.Backend.DesktopSize(800, 600);
      try {
        return { width: size.width, height: size.height };
      } finally {
        size.free();
      }
    }, bundles[0]!);
    expect(result).toEqual({ width: 800, height: 600 });
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged app rejects retired inputs and recovers through Axterm configuration and sync', async () => {
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-migration-')));
  const backupPath = join(directory, 'legacy-remote-backup.json');
  const configurationPath = join(directory, 'axterm-configuration.json');
  const importConfigurationPath = join(directory, 'axterm-configuration-import.json');
  const userData = join(directory, 'user-data');
  const remoteDocument =
    '{"formatVersion":1,"encrypted":true,"ciphertext":"PACKAGED_BACKUP_MARKER"}\n';
  const syncSecret = 'PACKAGED_BACKUP_WEBDAV_SECRET';
  const syncEncryptionSecret = 'PACKAGED_AXTERM_SYNC_ENCRYPTION_SECRET';
  const sourceAddressBookmarkId = randomUUID();
  const sourceWorkspaceId = randomUUID();
  const sourceWorkspaceTabId = randomUUID();
  let sourceHostId: string;
  let sourceBookmarkId: string;
  let sourceConnectionProfileId: string;
  let sourceTerminalProfileId: string;
  let sourceTunnelProfileId: string;
  let sourceQuickCommandGroupId: string;
  let sourceQuickCommandId: string;
  let sourceThemeId: string;
  let sourceTriggerId: string;
  interface RemoteDocument {
    contents: string | null;
    etag: string | null;
    reads: number;
    writes: number;
  }
  const legacyRemote: RemoteDocument = {
    contents: remoteDocument,
    etag: '"legacy-r1"',
    reads: 0,
    writes: 0,
  };
  const axtermRemote: RemoteDocument = { contents: null, etag: null, reads: 0, writes: 0 };
  const documents = new Map<string, RemoteDocument>([
    ['/storage/legacy-prototype/desktop.json', legacyRemote],
    ['/storage/axterm/desktop.json', axtermRemote],
  ]);
  let revision = 1;
  let rejectNextAxtermPut = false;
  const server = createServer(async (request, response) => {
    if (
      request.headers.authorization !==
      `Basic ${Buffer.from(`operator:${syncSecret}`).toString('base64')}`
    ) {
      response.writeHead(401).end();
      return;
    }
    if (
      (request.url === '/storage/legacy-prototype/' || request.url === '/storage/axterm/') &&
      request.method === 'MKCOL'
    ) {
      response.writeHead(201).end();
      return;
    }
    const document = request.url ? documents.get(request.url) : undefined;
    if (!document) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'GET') {
      document.reads += 1;
      if (!document.contents) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
        ETag: document.etag!,
      });
      response.end(document.contents);
      return;
    }
    if (request.method !== 'PUT') {
      response.writeHead(405).end();
      return;
    }
    if (
      (document.etag && request.headers['if-match'] !== document.etag) ||
      (!document.etag && request.headers['if-none-match'] !== '*')
    ) {
      response.writeHead(412).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === '/storage/axterm/desktop.json' && rejectNextAxtermPut) {
      rejectNextAxtermPut = false;
      response.writeHead(412).end();
      return;
    }
    document.contents = Buffer.concat(chunks).toString('utf8');
    document.etag = `"packaged-r${++revision}"`;
    document.writes += 1;
    response.writeHead(204, { ETag: document.etag }).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Sync backup fixture failed');
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    await app.evaluate(
      ({ dialog }, selections) => {
        const paths = [...selections.savePaths];
        let openIndex = 0;
        dialog.showSaveDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePath: paths.shift()!,
          })) as typeof dialog.showSaveDialog;
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [
              selections.openPaths[Math.min(openIndex++, selections.openPaths.length - 1)]!,
            ],
          })) as typeof dialog.showOpenDialog;
      },
      {
        savePaths: [configurationPath, backupPath],
        openPaths: [configurationPath, importConfigurationPath],
      },
    );
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const axtermFtpLink =
      'axterm://ftp-user:ftp-session-only@ftp.example.test:2121?type=ftp&title=FTP%20Deep';
    await app.evaluate(
      ({ app }, url) => {
        app.emit('second-instance', {} as never, [url], process.cwd(), {} as never);
      },
      axtermFtpLink.replace('axterm://', 'legacy-prototype://'),
    );
    const deepLinkFtpForm = page.getByRole('dialog', { name: '添加 FTP/FTPS 书签' });
    await expect(deepLinkFtpForm).toBeHidden();
    await app.evaluate(({ app }, url) => {
      app.emit('second-instance', {} as never, [url], process.cwd(), {} as never);
    }, axtermFtpLink);
    await expect(deepLinkFtpForm).toBeVisible();
    await expect(deepLinkFtpForm.locator('input[name="hostname"]')).toHaveValue('ftp.example.test');
    await expect(deepLinkFtpForm.locator('input[name="port"]')).toHaveValue('2121');
    await expect(deepLinkFtpForm.locator('input[name="username"]')).toHaveValue('ftp-user');
    await expect(deepLinkFtpForm.locator('input[name="password"]')).toHaveValue('ftp-session-only');
    await deepLinkFtpForm.getByRole('button', { name: '取消' }).click();
    await expect(page.getByTestId('legacy-batch-workflow-deprecation')).toHaveCount(0);
    await page.locator('[data-activity-item="setting"]').click();
    await expect(page.locator('[data-settings-category="common"]')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('data-migration-deprecation')).toHaveCount(0);
    await expect(page.getByLabel('Legacy Prototype 数据迁移')).toHaveCount(0);
    const migration = page.getByLabel('Axterm 配置快照');
    await migration.getByRole('button', { name: '导出 Axterm 配置' }).click();
    await expect(migration.getByText('Axterm 配置已导出')).toBeVisible();
    const configuration = await readFile(configurationPath, 'utf8');
    expect(JSON.parse(configuration)).toMatchObject({
      format: 'axterm-configuration',
      formatVersion: 1,
      vaultSecretValues: 'omitted',
    });
    const importDocument = JSON.parse(configuration) as {
      exportedAt: string;
      data: { hosts: unknown[] };
    };
    const now = new Date().toISOString();
    const recoveryWorkspaceLayout = () => ({
      section: 'hosts' as const,
      contentSurface: 'terminal' as const,
      sidebarOpen: true,
      split: false,
      tabs: [
        {
          id: sourceWorkspaceTabId,
          title: 'Packaged recovery session',
          kind: 'ssh' as const,
          hostId: sourceHostId,
          bookmarkId: sourceBookmarkId,
          profileId: sourceTerminalProfileId,
          visual: {
            themeId: sourceThemeId,
            background: structuredClone(DEFAULT_TERMINAL_BACKGROUND),
          },
          pinned: true,
          paneIndex: 0,
        },
      ],
      activeTerminalId: sourceWorkspaceTabId,
      secondaryTerminalId: null,
      layoutMode: 'c1' as const,
      paneTerminalIds: [sourceWorkspaceTabId],
      focusedPane: 0,
    });
    const recoveryWorkspaceSettings = () => {
      const layout = recoveryWorkspaceLayout();
      return {
        restoreLayout: true,
        aiInspectorOpen: true,
        layout,
        namedWorkspaces: [
          {
            id: sourceWorkspaceId,
            name: 'Packaged recovery workspace',
            layout,
            createdAt: now,
            updatedAt: now,
          },
        ],
        activeWorkspaceId: sourceWorkspaceId,
        startupSessions: [sourceBookmarkId],
        showTabNumber: false,
        switchTabOnHover: true,
      };
    };
    const recoveryAddressBookmarks = () => [
      {
        id: sourceAddressBookmarkId,
        hostId: sourceHostId,
        path: '/srv/packaged-sync-recovery',
      },
    ];
    importDocument.exportedAt = now;
    importDocument.data.hosts.push({
      id: randomUUID(),
      ...createHostSchema.parse({
        name: 'Packaged configuration host',
        hostname: 'packaged-import.example.test',
        username: 'operator',
      }),
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await writeFile(importConfigurationPath, JSON.stringify(importDocument), 'utf8');
    await expect(migration.locator('.axterm-config-hash')).toContainText(
      createHash('sha256').update(configuration).digest('hex'),
    );
    await migration.getByRole('button', { name: '检查 Axterm 文件' }).click();
    await expect(migration.getByText('Axterm 文件检查完成')).toBeVisible();
    await expect(migration.locator('.axterm-config-inspection')).toContainText('0 个问题');
    await migration.locator('.axterm-config-settings-option input').check();
    // Settings navigation persists the current workspace after a 400 ms
    // debounce. Let that safety-relevant write settle before creating the
    // optimistic import preview so the preview is not stale by construction.
    await page.waitForTimeout(500);
    await migration.getByRole('button', { name: '导入 Axterm 配置' }).click();
    await expect(migration.getByText('审阅 Axterm 配置变更', { exact: true })).toBeVisible();
    await expect(migration.locator('.axterm-config-preview-note')).toContainText(
      '下次启动 Axterm 时',
    );
    await expect(
      migration.locator('.axterm-config-preview .data-migration-metric.create strong'),
    ).toHaveText('1');
    await migration.getByRole('button', { name: '导入 1 项' }).click();
    await expect(migration.getByText('Axterm 配置已导入', { exact: true })).toBeVisible();
    await expect(
      migration.getByText('已保存便携的外观、布局、终端、文件和快捷键设置'),
    ).toBeVisible();
    const importedDatabase = await ProductDatabase.open(
      join(directory, 'user-data', 'data-v2', 'axterm.sqlite'),
    );
    try {
      const products = new ProductRepository(importedDatabase);
      const host = products.listHosts().find(({ name }) => name === 'Packaged configuration host');
      if (!host) throw new Error('Packaged configuration Host import failed');
      sourceHostId = host.id;

      const connectionProfile = new ConnectionProfileRepository(importedDatabase).create(
        connectionProfileInputSchema.parse({
          name: 'Packaged recovery connection profile',
          isDefault: false,
          ssh: { username: 'packaged-profile-user' },
        }),
      );
      sourceConnectionProfileId = connectionProfile.id;
      const terminalProfile = products.createJson(
        'terminal_profiles',
        terminalProfileInputSchema.parse({
          name: 'Packaged recovery terminal profile',
          fontSize: 16,
          scrollback: 5_432,
          env: { AXTERM_PACKAGED_SYNC: 'restored' },
        }),
        'terminal-profile',
      );
      sourceTerminalProfileId = terminalProfile.id;
      const theme = new TerminalThemeRepository(products).create({
        ...structuredClone(AXTERM_TERMINAL_THEMES[0]),
        name: 'Packaged recovery theme',
        terminal: {
          ...structuredClone(AXTERM_TERMINAL_THEMES[0].terminal),
          foreground: '#dff9ec',
          background: '#10251f',
          cursor: '#5ee0b4',
        },
        ui: {
          ...structuredClone(AXTERM_TERMINAL_THEMES[0].ui),
          primary: '#2fc7a1',
        },
      });
      sourceThemeId = theme.id;

      const bookmarks = new BookmarkRepository(importedDatabase);
      const bookmarkTree = bookmarks.createBookmark(
        createBookmarkSchema.parse({
          protocol: 'ssh',
          hostId: host.id,
          title: 'Packaged recovery bookmark',
          profileId: terminalProfile.id,
          connectionProfileId: connectionProfile.id,
        }),
        bookmarks.snapshot().etag,
      );
      const bookmark = bookmarkTree.bookmarks.find(
        ({ title }) => title === 'Packaged recovery bookmark',
      );
      if (!bookmark) throw new Error('Packaged recovery Bookmark seed failed');
      sourceBookmarkId = bookmark.id;

      const commands = new QuickCommandRepository(importedDatabase);
      let commandTree = commands.createGroup(
        { parentId: null, name: 'Packaged recovery commands' },
        commands.snapshot().etag,
      );
      const commandGroup = commandTree.groups.find(
        ({ name }) => name === 'Packaged recovery commands',
      );
      if (!commandGroup) throw new Error('Packaged recovery Quick Command group seed failed');
      sourceQuickCommandGroupId = commandGroup.id;
      commandTree = commands.createCommand(
        {
          groupId: commandGroup.id,
          name: 'Packaged recovery diagnostic',
          command: "printf 'PACKAGED_SYNC_RECOVERY'",
          commands: [
            {
              id: randomUUID(),
              name: 'Print packaged marker',
              command: "printf 'PACKAGED_SYNC_RECOVERY'",
              delayMs: 120,
            },
            {
              id: randomUUID(),
              name: 'Check packaged status',
              command: 'printf PACKAGED_STATUS_OK',
              delayMs: 260,
            },
          ],
          description: 'Packaged encrypted sync recovery',
          tags: ['packaged', 'recovery'],
          shortcut: null,
          inputOnly: true,
          clickCount: 0,
        },
        commandTree.etag,
      );
      const command = commandTree.commands.find(
        ({ name }) => name === 'Packaged recovery diagnostic',
      );
      if (!command) throw new Error('Packaged recovery Quick Command seed failed');
      sourceQuickCommandId = command.id;

      const tunnel = products.createJson(
        'tunnel_profiles',
        tunnelProfileInputSchema.parse({
          name: 'Packaged recovery tunnel',
          hostId: host.id,
          type: 'local',
          bindHost: '127.0.0.1',
          bindPort: 41_024,
          targetHost: '127.0.0.1',
          targetPort: 22,
          allowNonLoopback: false,
        }),
        'tunnel-profile',
      );
      sourceTunnelProfileId = tunnel.id;
      const triggers = new TriggerRepository(importedDatabase);
      const triggerCollection = triggers.create(
        triggerRuleInputSchema.parse({
          name: 'Packaged recovery trigger',
          enabled: true,
          match: {
            type: 'regex',
            value: 'PACKAGED_RECOVERY_PROMPT$',
            caseSensitive: true,
          },
          action: { type: 'send', value: "printf 'PACKAGED_TRIGGER_RECOVERED'" },
          sendEnter: true,
          mode: 'cooldown',
          cooldownMs: 2_600,
        }),
        triggers.snapshot().etag,
      );
      const trigger = triggerCollection.triggers.find(
        ({ name }) => name === 'Packaged recovery trigger',
      );
      if (!trigger) throw new Error('Packaged recovery Trigger seed failed');
      sourceTriggerId = trigger.id;

      const settings = products.getSettings();
      products.updateSettings(
        {
          appearance: { theme: 'light' },
          terminal: {
            defaultProfileId: terminalProfile.id,
            visual: { ...settings.terminal.visual, themeId: theme.id },
          },
          workspace: recoveryWorkspaceSettings(),
          fileManager: { remoteAddressBookmarks: recoveryAddressBookmarks() },
        },
        etagFor(settings.version),
      );
    } finally {
      importedDatabase.close();
    }
    await page.locator('[data-settings-category="sync"]').click();
    await expect(page.getByTestId('legacy-sync-deprecation')).toHaveCount(0);
    const panel = page.getByRole('region', { name: '设置同步' });
    await panel.getByRole('tab', { name: 'WebDAV' }).click();
    await panel.getByLabel('服务地址').fill(`http://127.0.0.1:${address.port}/storage/`);
    await panel.getByLabel('远程文件名').fill('desktop.json');
    await panel.getByLabel('用户名').fill('operator');
    await panel.getByLabel('WebDAV 密码').fill(syncSecret);
    await panel.getByLabel('同步加密密码').fill(syncEncryptionSecret);
    await panel.getByLabel('上传前使用本地密码加密同步文件').check();
    await panel.getByRole('button', { name: '保存配置' }).click();
    await expect(panel.getByText('同步配置已保存；凭据只保存在应用本地 Vault。')).toBeVisible();
    expect(legacyRemote.reads).toBe(0);
    expect(legacyRemote.writes).toBe(0);
    const vaultBeforeFailedUpload = await vaultFileHashes(join(userData, 'vault-v2'));

    // Let the Renderer's 400 ms layout persistence debounce finish before the
    // test writes the exact source value that the sync upload must capture.
    await page.waitForTimeout(500);
    const uploadDatabase = await ProductDatabase.open(
      join(directory, 'user-data', 'data-v2', 'axterm.sqlite'),
    );
    try {
      const products = new ProductRepository(uploadDatabase);
      const settings = products.getSettings();
      products.updateSettings(
        {
          appearance: { theme: 'light' },
          workspace: recoveryWorkspaceSettings(),
          fileManager: { remoteAddressBookmarks: recoveryAddressBookmarks() },
        },
        etagFor(settings.version),
      );
    } finally {
      uploadDatabase.close();
    }

    rejectNextAxtermPut = true;
    await panel.getByRole('button', { name: '上传', exact: true }).click();
    await expect(panel.locator('.data-sync-message')).toBeVisible();
    await expect(panel.locator('.data-sync-message')).not.toContainText('所选分类已上传');
    expect(legacyRemote.contents).toBe(remoteDocument);
    expect(legacyRemote.etag).toBe('"legacy-r1"');
    expect(legacyRemote.writes).toBe(0);
    expect(axtermRemote.contents).toBeNull();
    expect(axtermRemote.writes).toBe(0);
    expect(await vaultFileHashes(join(userData, 'vault-v2'))).toEqual(vaultBeforeFailedUpload);
    await panel.getByRole('button', { name: '上传', exact: true }).click();
    await expect(panel.locator('.data-sync-message')).toContainText('所选分类已上传。');
    await expect.poll(() => axtermRemote.contents).not.toBeNull();
    const uploadedAxtermDocument = axtermRemote.contents;
    if (!uploadedAxtermDocument) throw new Error('Packaged Axterm sync upload was not created');
    expect(JSON.parse(uploadedAxtermDocument)).toMatchObject({
      formatVersion: 1,
      encrypted: true,
      algorithm: 'aes-256-gcm+scrypt',
      salt: expect.any(String),
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    });
    expect(uploadedAxtermDocument).not.toContain('Packaged configuration host');
    expect(uploadedAxtermDocument).not.toContain('packaged-import.example.test');
    expect(uploadedAxtermDocument).not.toContain('Packaged recovery diagnostic');
    expect(uploadedAxtermDocument).not.toContain('Packaged recovery theme');
    expect(uploadedAxtermDocument).not.toContain('Packaged recovery workspace');
    expect(uploadedAxtermDocument).not.toContain('Packaged recovery trigger');
    expect(uploadedAxtermDocument).not.toContain(syncEncryptionSecret);
    expect(axtermRemote.writes).toBe(1);
    expect(legacyRemote.contents).toBe(remoteDocument);
    expect(legacyRemote.writes).toBe(0);
    await panel.getByRole('button', { name: '备份远端文件' }).click();
    await expect(panel.getByText(/远端同步文件已保存到本地/)).toBeVisible();
    expect(await readFile(backupPath, 'utf8')).toBe(uploadedAxtermDocument);
    await expect(panel.locator('.data-sync-message')).toContainText(
      createHash('sha256').update(uploadedAxtermDocument).digest('hex'),
    );

    const mutationDatabase = await ProductDatabase.open(
      join(directory, 'user-data', 'data-v2', 'axterm.sqlite'),
    );
    try {
      const products = new ProductRepository(mutationDatabase);
      const host = products.listHosts().find(({ name }) => name === 'Packaged configuration host');
      if (!host) throw new Error('Packaged Axterm sync recovery host is missing');
      const settings = products.getSettings();
      products.updateSettings(
        {
          appearance: { theme: 'dark' },
          terminal: {
            defaultProfileId: null,
            visual: {
              ...settings.terminal.visual,
              themeId: '00000000-0000-4000-8000-000000000001',
            },
          },
          workspace: {
            restoreLayout: false,
            aiInspectorOpen: false,
            layout: {
              section: 'settings',
              contentSurface: 'section',
              sidebarOpen: false,
              split: false,
              tabs: [],
              activeTerminalId: null,
              secondaryTerminalId: null,
              layoutMode: 'c1',
              paneTerminalIds: [],
              focusedPane: 0,
            },
            namedWorkspaces: [],
            activeWorkspaceId: null,
            startupSessions: [],
            showTabNumber: true,
            switchTabOnHover: false,
          },
          fileManager: { remoteAddressBookmarks: [] },
        },
        etagFor(settings.version),
      );

      const bookmarks = new BookmarkRepository(mutationDatabase);
      const bookmark = bookmarks
        .snapshot()
        .bookmarks.find(({ title }) => title === 'Packaged recovery bookmark');
      if (!bookmark) throw new Error('Packaged recovery Bookmark seed is missing');
      bookmarks.deleteBookmark(bookmark.id, bookmarks.snapshot().etag);

      const tunnel = products
        .listJson<{ id: string; name: string; version: number }>('tunnel_profiles')
        .find(({ name }) => name === 'Packaged recovery tunnel');
      if (!tunnel) throw new Error('Packaged recovery Tunnel Profile seed is missing');
      products.deleteJson('tunnel_profiles', tunnel.id, etagFor(tunnel.version), 'tunnel-profile');

      const triggers = new TriggerRepository(mutationDatabase);
      const trigger = triggers
        .snapshot()
        .triggers.find(({ name }) => name === 'Packaged recovery trigger');
      if (!trigger) throw new Error('Packaged recovery Trigger seed is missing');
      triggers.delete(trigger.id, triggers.snapshot().etag);

      const commands = new QuickCommandRepository(mutationDatabase);
      let commandTree = commands.snapshot();
      const command = commandTree.commands.find(
        ({ name }) => name === 'Packaged recovery diagnostic',
      );
      const commandGroup = commandTree.groups.find(
        ({ name }) => name === 'Packaged recovery commands',
      );
      if (!command || !commandGroup)
        throw new Error('Packaged recovery Quick Command seed is missing');
      commandTree = commands.deleteCommand(command.id, commandTree.etag);
      commands.deleteGroup(commandGroup.id, commandTree.etag);

      const themes = new TerminalThemeRepository(products);
      const theme = themes.list().find(({ name }) => name === 'Packaged recovery theme');
      if (!theme) throw new Error('Packaged recovery Theme seed is missing');
      themes.delete(theme.id, etagFor(theme.version));

      const connectionProfiles = new ConnectionProfileRepository(mutationDatabase);
      const connectionProfile = connectionProfiles
        .list()
        .find(({ name }) => name === 'Packaged recovery connection profile');
      const terminalProfile = products
        .listJson<{ id: string; name: string; version: number }>('terminal_profiles')
        .find(({ name }) => name === 'Packaged recovery terminal profile');
      if (!connectionProfile || !terminalProfile)
        throw new Error('Packaged recovery Profile seed is missing');
      connectionProfiles.delete(connectionProfile.id, etagFor(connectionProfile.version));
      products.deleteJson(
        'terminal_profiles',
        terminalProfile.id,
        etagFor(terminalProfile.version),
        'terminal-profile',
      );
      products.deleteHost(host.id, etagFor(host.version));

      expect(products.listHosts()).toEqual([]);
      expect(new BookmarkRepository(mutationDatabase).snapshot().bookmarks).toEqual([]);
      expect(new QuickCommandRepository(mutationDatabase).snapshot()).toMatchObject({
        groups: [],
        commands: [],
      });
      expect(new TerminalThemeRepository(products).list()).toEqual([]);
      expect(new ConnectionProfileRepository(mutationDatabase).list()).toEqual([]);
      expect(products.listJson('terminal_profiles')).toEqual([]);
      expect(products.listJson('tunnel_profiles')).toEqual([]);
      expect(new TriggerRepository(mutationDatabase).snapshot().triggers).toEqual([]);
      expect(products.getSettings().appearance.theme).toBe('dark');
      expect(products.getSettings()).toMatchObject({
        workspace: {
          restoreLayout: false,
          namedWorkspaces: [],
          activeWorkspaceId: null,
          startupSessions: [],
        },
        fileManager: { remoteAddressBookmarks: [] },
      });
    } finally {
      mutationDatabase.close();
    }

    await panel.getByRole('button', { name: '下载', exact: true }).click();
    const downloadPreview = panel.getByRole('region', { name: '下载预览' });
    await expect(downloadPreview).toBeVisible();
    await expect(downloadPreview.getByRole('button', { name: '确认应用' })).toBeEnabled();
    await downloadPreview.getByRole('button', { name: '确认应用' }).click();
    await expect(panel.getByText('远程数据已按预览提交。')).toBeVisible();

    const recoveredDatabase = await ProductDatabase.open(
      join(directory, 'user-data', 'data-v2', 'axterm.sqlite'),
    );
    try {
      const products = new ProductRepository(recoveredDatabase);
      const settings = products.getSettings();
      const recoveredHost = products
        .listHosts()
        .find(({ name }) => name === 'Packaged configuration host');
      const recoveredBookmark = new BookmarkRepository(recoveredDatabase)
        .snapshot()
        .bookmarks.find(({ title }) => title === 'Packaged recovery bookmark');
      const recoveredConnectionProfile = new ConnectionProfileRepository(recoveredDatabase)
        .list()
        .find(({ name }) => name === 'Packaged recovery connection profile');
      const recoveredTerminalProfile = products
        .listJson<{
          id: string;
          name: string;
          fontSize: number;
          scrollback: number;
          env: Record<string, string>;
        }>('terminal_profiles')
        .find(({ name }) => name === 'Packaged recovery terminal profile');
      const recoveredTunnelProfile = products
        .listJson<{
          id: string;
          name: string;
          hostId: string;
          bindPort: number;
          targetPort: number | null;
        }>('tunnel_profiles')
        .find(({ name }) => name === 'Packaged recovery tunnel');
      expect(recoveredHost).toMatchObject({
        hostname: 'packaged-import.example.test',
        username: 'operator',
      });
      expect(recoveredHost?.id).not.toBe(sourceHostId);
      expect(recoveredBookmark).toMatchObject({
        hostId: recoveredHost?.id,
        profileId: recoveredTerminalProfile?.id,
        connectionProfileId: recoveredConnectionProfile?.id,
      });
      expect(recoveredBookmark?.id).not.toBe(sourceBookmarkId);
      expect(recoveredConnectionProfile).toMatchObject({
        ssh: {
          username: 'packaged-profile-user',
          passwordCredentialRef: null,
          privateKeyCredentialRef: null,
        },
      });
      expect(recoveredConnectionProfile?.id).not.toBe(sourceConnectionProfileId);
      expect(recoveredTerminalProfile).toMatchObject({
        fontSize: 16,
        scrollback: 5_432,
        env: { AXTERM_PACKAGED_SYNC: 'restored' },
      });
      expect(recoveredTerminalProfile?.id).not.toBe(sourceTerminalProfileId);
      expect(recoveredTunnelProfile).toMatchObject({
        hostId: recoveredHost?.id,
        bindPort: 41_024,
        targetPort: 22,
      });
      expect(recoveredTunnelProfile?.id).not.toBe(sourceTunnelProfileId);

      const recoveredCommands = new QuickCommandRepository(recoveredDatabase).snapshot();
      const recoveredCommandGroup = recoveredCommands.groups.find(
        ({ name }) => name === 'Packaged recovery commands',
      );
      const recoveredCommand = recoveredCommands.commands.find(
        ({ name }) => name === 'Packaged recovery diagnostic',
      );
      expect(recoveredCommandGroup).toMatchObject({ parentId: null });
      expect(recoveredCommandGroup?.id).not.toBe(sourceQuickCommandGroupId);
      expect(recoveredCommand).toMatchObject({
        groupId: recoveredCommandGroup?.id,
        command: "printf 'PACKAGED_SYNC_RECOVERY'",
        commands: [
          expect.objectContaining({
            name: 'Print packaged marker',
            command: "printf 'PACKAGED_SYNC_RECOVERY'",
            delayMs: 120,
          }),
          expect.objectContaining({
            name: 'Check packaged status',
            command: 'printf PACKAGED_STATUS_OK',
            delayMs: 260,
          }),
        ],
        description: 'Packaged encrypted sync recovery',
        tags: ['packaged', 'recovery'],
        inputOnly: true,
      });
      expect(recoveredCommand?.id).not.toBe(sourceQuickCommandId);

      const recoveredTheme = new TerminalThemeRepository(products)
        .list()
        .find(({ name }) => name === 'Packaged recovery theme');
      expect(recoveredTheme).toMatchObject({
        builtIn: false,
        terminal: {
          foreground: '#dff9ec',
          background: '#10251f',
          cursor: '#5ee0b4',
        },
        ui: expect.objectContaining({ primary: '#2fc7a1' }),
      });
      expect(recoveredTheme?.id).not.toBe(sourceThemeId);
      expect(settings.appearance.theme).toBe('light');
      expect(settings.terminal).toMatchObject({
        defaultProfileId: recoveredTerminalProfile?.id,
        visual: { themeId: recoveredTheme?.id },
      });
      expect(settings.fileManager.remoteAddressBookmarks).toEqual([
        {
          id: sourceAddressBookmarkId,
          hostId: recoveredHost?.id,
          path: '/srv/packaged-sync-recovery',
        },
      ]);
      expect(settings.workspace).toMatchObject({
        restoreLayout: true,
        aiInspectorOpen: true,
        activeWorkspaceId: sourceWorkspaceId,
        startupSessions: [recoveredBookmark?.id],
        showTabNumber: false,
        switchTabOnHover: true,
      });
      expect(settings.workspace.layout?.tabs).toEqual([
        expect.objectContaining({
          id: sourceWorkspaceTabId,
          title: 'Packaged recovery session',
          hostId: recoveredHost?.id,
          bookmarkId: recoveredBookmark?.id,
          profileId: recoveredTerminalProfile?.id,
          visual: expect.objectContaining({ themeId: recoveredTheme?.id }),
          pinned: true,
        }),
      ]);
      expect(settings.workspace.namedWorkspaces).toEqual([
        expect.objectContaining({
          id: sourceWorkspaceId,
          name: 'Packaged recovery workspace',
          layout: expect.objectContaining({
            tabs: [
              expect.objectContaining({
                id: sourceWorkspaceTabId,
                hostId: recoveredHost?.id,
                bookmarkId: recoveredBookmark?.id,
                profileId: recoveredTerminalProfile?.id,
                visual: expect.objectContaining({ themeId: recoveredTheme?.id }),
              }),
            ],
          }),
        }),
      ]);

      const recoveredTrigger = new TriggerRepository(recoveredDatabase)
        .snapshot()
        .triggers.find(({ name }) => name === 'Packaged recovery trigger');
      expect(recoveredTrigger).toMatchObject({
        enabled: true,
        match: {
          type: 'regex',
          value: 'PACKAGED_RECOVERY_PROMPT$',
          caseSensitive: true,
        },
        action: { type: 'send', value: "printf 'PACKAGED_TRIGGER_RECOVERED'" },
        sendEnter: true,
        mode: 'cooldown',
        cooldownMs: 2_600,
      });
      expect(recoveredTrigger?.id).not.toBe(sourceTriggerId);
    } finally {
      recoveredDatabase.close();
    }
    expect(axtermRemote.contents).toBe(uploadedAxtermDocument);
    expect(axtermRemote.writes).toBe(1);
    expect(legacyRemote.contents).toBe(remoteDocument);
    expect(legacyRemote.reads).toBe(0);
    expect(legacyRemote.writes).toBe(0);
  } finally {
    await app?.close().catch(() => {});
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Gist and Custom sync preserve old remote files and recover Axterm settings', async () => {
  await access(source);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'axterm-packaged-sync-providers-')),
  );
  const cases = [
    {
      provider: 'github' as const,
      tab: 'GitHub Gist',
      route: '/github/gists/github-migration',
      endpointPath: '/github/gists',
      remoteLabel: 'Gist ID',
      remoteId: 'github-migration',
      secretLabel: 'Access Token',
      secret: 'PACKAGED_GITHUB_MIGRATION_SECRET',
      legacyContents:
        '{"formatVersion":1,"encrypted":true,"ciphertext":"PACKAGED_GITHUB_LEGACY"}\n',
    },
    {
      provider: 'gitee' as const,
      tab: 'Gitee Gist',
      route: '/gitee/gists/gitee-migration',
      endpointPath: '/gitee/gists',
      remoteLabel: 'Gist ID',
      remoteId: 'gitee-migration',
      secretLabel: 'Access Token',
      secret: 'PACKAGED_GITEE_MIGRATION_SECRET',
      legacyContents: '{"formatVersion":1,"encrypted":true,"ciphertext":"PACKAGED_GITEE_LEGACY"}\n',
    },
    {
      provider: 'custom' as const,
      tab: '自定义服务器',
      route: '/custom-sync',
      endpointPath: '/custom-sync',
      remoteLabel: '用户 ID',
      remoteId: 'custom-migration',
      secretLabel: 'JWT Secret',
      secret: 'PACKAGED_CUSTOM_MIGRATION_SECRET',
      legacyContents:
        '{"formatVersion":1,"encrypted":true,"ciphertext":"PACKAGED_CUSTOM_LEGACY"}\n',
    },
  ];
  interface NamedFileContainer {
    files: Record<string, { content: string }>;
    etag: string;
    reads: number;
    writes: number;
  }
  const containers = new Map<string, NamedFileContainer>(
    cases.map((entry) => [
      entry.route,
      {
        files: { 'axterm-sync.json': { content: entry.legacyContents } },
        etag: `"${entry.provider}-r1"`,
        reads: 0,
        writes: 0,
      },
    ]),
  );
  const server = createServer(async (request, response) => {
    const entry = cases.find(({ route }) => route === request.url);
    const container = request.url ? containers.get(request.url) : undefined;
    if (!entry || !container) {
      response.writeHead(404).end();
      return;
    }
    const authorization = request.headers.authorization ?? '';
    if (entry.provider === 'github' && authorization !== `Bearer ${entry.secret}`) {
      response.writeHead(401).end();
      return;
    }
    if (entry.provider === 'gitee' && authorization !== `token ${entry.secret}`) {
      response.writeHead(401).end();
      return;
    }
    if (entry.provider === 'custom') {
      const token = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
      const [header, payload, signature] = token.split('.');
      const expectedSignature =
        header && payload
          ? createHmac('sha256', entry.secret).update(`${header}.${payload}`).digest('base64url')
          : '';
      const claims = payload
        ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { id?: string })
        : {};
      if (signature !== expectedSignature || claims.id !== entry.remoteId) {
        response.writeHead(401).end();
        return;
      }
    }
    if (request.method === 'GET') {
      container.reads += 1;
      response.writeHead(200, {
        'Content-Type': 'application/json',
        ETag: container.etag,
      });
      response.end(
        JSON.stringify({
          files: container.files,
          updated_at: '2026-09-22T00:00:00.000Z',
        }),
      );
      return;
    }
    if (
      (entry.provider !== 'custom' && request.method !== 'PATCH') ||
      (entry.provider === 'custom' && request.method !== 'PUT')
    ) {
      response.writeHead(405).end();
      return;
    }
    if (entry.provider === 'custom' && request.headers['if-match'] !== container.etag) {
      response.writeHead(412).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      files: Record<string, { content: string }>;
    };
    container.files =
      entry.provider === 'custom' ? body.files : { ...container.files, ...body.files };
    container.writes += 1;
    container.etag = `"${entry.provider}-r${container.writes + 1}"`;
    response.writeHead(200, {
      'Content-Type': 'application/json',
      ETag: container.etag,
    });
    response.end(
      JSON.stringify({
        files: container.files,
        updated_at: '2026-09-22T00:00:00.000Z',
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider migration fixture failed');

  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${join(directory, 'user-data')}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="sync"]').click();
    const panel = page.getByRole('region', { name: '设置同步' });

    for (const entry of cases) {
      await panel.getByRole('tab', { name: entry.tab }).click();
      await panel
        .getByLabel('服务地址')
        .fill(`http://127.0.0.1:${address.port}${entry.endpointPath}`);
      await panel.getByLabel(entry.remoteLabel).fill(entry.remoteId);
      await panel.getByLabel(entry.secretLabel).fill(entry.secret);
      await panel.getByRole('button', { name: '保存配置' }).click();
      await expect(panel.getByText('同步配置已保存；凭据只保存在应用本地 Vault。')).toBeVisible();

      const uploadDatabase = await ProductDatabase.open(
        join(directory, 'user-data', 'data-v2', 'axterm.sqlite'),
      );
      try {
        const products = new ProductRepository(uploadDatabase);
        const settings = products.getSettings();
        products.updateSettings({ appearance: { theme: 'light' } }, etagFor(settings.version));
      } finally {
        uploadDatabase.close();
      }

      await panel.getByRole('button', { name: '上传', exact: true }).click();
      await expect(panel.getByText('所选分类已上传。')).toBeVisible();
      const container = containers.get(entry.route)!;
      expect(container.files['axterm-sync.json']?.content).toBe(entry.legacyContents);
      const uploadedAxtermContents = container.files['axterm-sync-v1.json']?.content;
      expect(uploadedAxtermContents).toContain('"format":"axterm-sync"');
      expect(container.writes).toBe(1);

      const divergentDatabase = await ProductDatabase.open(
        join(directory, 'user-data', 'data-v2', 'axterm.sqlite'),
      );
      try {
        const products = new ProductRepository(divergentDatabase);
        const settings = products.getSettings();
        products.updateSettings({ appearance: { theme: 'dark' } }, etagFor(settings.version));
      } finally {
        divergentDatabase.close();
      }

      await panel.getByRole('button', { name: '下载', exact: true }).click();
      await expect(panel.getByText('远程数据已下载为预览，请核对后提交。')).toBeVisible();
      const preview = panel.getByRole('region', { name: '下载预览' });
      await expect(preview).toBeVisible();
      await expect(preview.getByText('将应用', { exact: true })).toBeVisible();
      await preview.getByRole('button', { name: '确认应用' }).click();
      await expect(panel.getByText('远程数据已按预览提交。')).toBeVisible();
      await expect(preview).toBeHidden();

      const recoveredDatabase = await ProductDatabase.open(
        join(directory, 'user-data', 'data-v2', 'axterm.sqlite'),
      );
      try {
        expect(new ProductRepository(recoveredDatabase).getSettings().appearance.theme).toBe(
          'light',
        );
      } finally {
        recoveredDatabase.close();
      }
      expect(container.files['axterm-sync.json']?.content).toBe(entry.legacyContents);
      expect(container.files['axterm-sync-v1.json']?.content).toBe(uploadedAxtermContents);
      expect(container.writes).toBe(1);
    }
  } finally {
    await app?.close().catch(() => {});
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Linux deb launcher icon resolves through the GTK icon theme', async () => {
  test.skip(process.platform !== 'linux', 'Debian desktop icon check');
  const debPath = resolve(process.env.AXTERM_DEB_PATH ?? 'release/axterm_0.10.0_amd64.deb');
  const hasDeb = await access(debPath).then(
    () => true,
    () => false,
  );
  test.skip(!hasDeb, 'Full Debian artifact is required');

  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-deb-icon-')));
  try {
    await execFileAsync('dpkg-deb', ['-x', debPath, directory]);
    const iconTheme = join(directory, 'usr/share/icons/hicolor');
    const iconPath = join(iconTheme, '512x512/apps/axterm.png');
    await access(iconPath);
    await copyFile('/usr/share/icons/hicolor/index.theme', join(iconTheme, 'index.theme'));
    const script = [
      'import os, gi',
      "gi.require_version('Gtk', '3.0')",
      'from gi.repository import Gtk',
      'theme = Gtk.IconTheme.new()',
      "theme.set_search_path([os.environ['AXTERM_ICON_THEME_ROOT']])",
      "theme.set_custom_theme('hicolor')",
      "icon = theme.lookup_icon('axterm', 48, 0)",
      "print(icon.get_filename() if icon else '')",
    ].join('\n');
    const { stdout } = await execFileAsync('/usr/bin/python3', ['-c', script], {
      env: { ...process.env, AXTERM_ICON_THEME_ROOT: join(directory, 'usr/share/icons') },
    });
    expect(stdout.trim()).toBe(iconPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Linux AppImage runtime launches outside the source checkout', async () => {
  const appImagePath = process.env.AXTERM_APPIMAGE_PATH?.trim();
  test.skip(process.platform !== 'linux' || !appImagePath, 'Requires a Linux AppImage gate');
  test.setTimeout(120_000);

  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-appimage-runtime-')));
  const copiedAppImage = join(directory, 'Axterm.AppImage');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await copyFile(resolve(appImagePath!), copiedAppImage);
    await chmod(copiedAppImage, 0o755);
    const expectedVersion = (
      JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    const artifactHash = createHash('sha256');
    for await (const chunk of createReadStream(copiedAppImage)) artifactHash.update(chunk);
    const observedArtifact = {
      name: basename(appImagePath!),
      bytes: (await stat(copiedAppImage)).size,
      sha256: artifactHash.digest('hex'),
    };
    const releaseManifest = JSON.parse(
      await readFile(
        join(dirname(resolve(appImagePath!)), 'AXTERM_RELEASE_ARTIFACTS.linux-x64.json'),
        'utf8',
      ),
    ) as unknown;
    verifyAppImageRuntimeArtifact(releaseManifest, expectedVersion, observedArtifact);
    app = await electron.launch({
      executablePath: copiedAppImage,
      args: ['--no-sandbox', `--user-data-dir=${join(directory, 'user-data')}`],
      cwd: directory,
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: '1',
        ELECTRON_RENDERER_URL: '',
        PATH: '/usr/bin:/bin',
      },
    });
    const page = await app.firstWindow();
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getVersion())).toBe(
      expectedVersion,
    );
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(1);
    await page
      .locator('.terminal-pane.active .tab-add')
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(2);
    await app.close();
    app = undefined;
    const finalArtifactHash = createHash('sha256');
    for await (const chunk of createReadStream(copiedAppImage)) finalArtifactHash.update(chunk);
    expect((await stat(copiedAppImage)).size).toBe(observedArtifact.bytes);
    expect(finalArtifactHash.digest('hex')).toBe(observedArtifact.sha256);
    const receiptPath = process.env.AXTERM_APPIMAGE_RUNTIME_RECEIPT?.trim();
    if (receiptPath) {
      await writeFile(
        resolve(receiptPath),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            verifiedAt: new Date().toISOString(),
            host: { platform: process.platform, architecture: process.arch },
            artifact: observedArtifact,
            appVersion: expectedVersion,
            extractionMode: 'APPIMAGE_EXTRACT_AND_RUN=1',
            runtimeReady: true,
            localTerminalTabs: 2,
            cleanShutdown: true,
          },
          null,
          2,
        )}\n`,
      );
    }
  } finally {
    await app?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Linux close control responds with terminal tabs open', async () => {
  test.skip(process.platform !== 'linux', 'The Linux custom title bar is under test.');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-linux-close-')));
  const artifact = join(directory, 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const app = await electron.launch({
    executablePath: join(artifact, 'axterm'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ x: 100, y: 100, width: 800, height: 700 }),
    );
    for (let index = 0; index < 2; index++) {
      await page
        .locator('.terminal-pane.active .tab-add')
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(index + 2);
    }
    const close = page.locator('[data-window-action="close"]');
    const geometry = await page.evaluate(() => {
      const controls = document.querySelector('.terminal-workspace > .tabbar');
      const scroll = document.querySelector('.terminal-pane.active .pane-tabbar-scroll');
      const close = document.querySelector('[data-window-action="close"]');
      if (!controls || !scroll || !close) throw new Error('Missing Linux title-bar control');
      const rect = close.getBoundingClientRect();
      return {
        controlsLeft: controls.getBoundingClientRect().left,
        scrollRight: scroll.getBoundingClientRect().right,
        closeHit: close.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        ),
      };
    });
    expect(geometry.scrollRight).toBeLessThanOrEqual(geometry.controlsLeft + 1);
    expect(geometry.closeHit).toBe(true);
    await close.hover();
    await expect.poll(() => close.evaluate((button) => button.matches(':hover'))).toBe(true);
    await close.click();
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '取消' }).click();
    expect(page.isClosed()).toBe(false);
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged app runs the signed updater without exposing its installer path', async () => {
  test.setTimeout(90_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-updater-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const userData = join(directory, 'user-data');
  const updateArtifact = Buffer.alloc(512 * 1024, 0x5a);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const fixtureState: { manifest?: Record<string, unknown> } = {};
  const fixture = createServer((request, response) => {
    if (request.url === '/manifest.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(fixtureState.manifest));
      return;
    }
    if (request.url === '/axterm-0.11.0.zip') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
      });
      response.write(updateArtifact.subarray(0, 64 * 1024));
      response.end(updateArtifact.subarray(64 * 1024));
      return;
    }
    response.writeHead(404).end();
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Updater fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const unsigned = {
    version: '0.11.0',
    publishedAt: '2026-09-14T00:00:00.000Z',
    notes: 'Packaged signed update fixture',
    artifact: {
      url: `${origin}/axterm-0.11.0.zip`,
      fileName: 'axterm-0.11.0.zip',
      size: updateArtifact.byteLength,
      sha256: createHash('sha256').update(updateArtifact).digest('hex'),
      signature: Buffer.alloc(64).toString('base64'),
    },
  };
  fixtureState.manifest = {
    ...unsigned,
    artifact: {
      ...unsigned.artifact,
      signature: sign(null, Buffer.from(canonicalManifestRecord(unsigned)), privateKey).toString(
        'base64',
      ),
    },
  };
  let launchedApp: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
        AXTERM_UPDATE_MANIFEST_URL: `${origin}/manifest.json`,
        AXTERM_UPDATE_PUBLIC_KEY_BASE64: publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
      },
    });
    launchedApp = app;
    await app.evaluate(({ shell }) => {
      (globalThis as unknown as { openedInstallers: string[] }).openedInstallers = [];
      shell.openPath = (async (path: string) => {
        (globalThis as unknown as { openedInstallers: string[] }).openedInstallers.push(path);
        return '';
      }) as typeof shell.openPath;
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const updater = page.locator('.updater-panel');
    await updater.getByRole('button', { name: /Check for updates|检查更新/ }).click();
    await expect(updater).toContainText(/Update available|发现新版本/);
    await updater.getByRole('button', { name: /Download|下载/ }).click();
    await expect(updater).toContainText(/Ready to install|可以安装/);
    expect(await page.locator('body').innerText()).not.toContain(join(userData, 'updates'));
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'updater-ready.png') });
    await updater.getByRole('button', { name: /Open installer|打开安装包/ }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { openedInstallers: string[] }).openedInstallers,
        ),
      )
      .toEqual([join(userData, 'updates', 'axterm-0.11.0.zip')]);
  } finally {
    await launchedApp?.close().catch(() => {});
    fixture.closeAllConnections();
    await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged app starts independently of checkout and system Node', async () => {
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-')));
  try {
    const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
    // Preserve framework symlinks; fs.cp otherwise rewrites them to source paths.
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    const executablePath =
      process.platform === 'darwin'
        ? join(artifact, 'Contents/MacOS/Axterm')
        : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
    let app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${join(directory, 'user-data')}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await app.evaluate(({ app: electronApp }) => {
        electronApp.emit(
          'open-url',
          { preventDefault() {} } as never,
          'legacy-prototype://operator@legacy.example.test:22?type=ssh&title=Retired',
        );
      });
      await page.waitForTimeout(250);
      await expect(page.getByRole('dialog', { name: /添加.*书签/ })).toHaveCount(0);
      expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      const layout = await app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        path: app.getAppPath(),
      }));
      expect(layout.packaged).toBe(true);
      expect(layout.path).toContain('app.asar');
      expect(layout.path.startsWith(resolve(directory))).toBe(true);
      if (
        process.platform === 'linux' &&
        process.env.DISPLAY &&
        process.env.XDG_SESSION_TYPE !== 'wayland'
      ) {
        expect(await readFile(join(artifact, 'resources/axterm-icon.png'))).toEqual(
          await readFile(resolve('apps/desktop/build/icon.png')),
        );
        const windowId = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readUInt32LE(0),
        );
        await expect
          .poll(async () => {
            const { stdout } = await execFileAsync('xprop', [
              '-id',
              `0x${windowId.toString(16)}`,
              '_NET_WM_ICON',
            ]);
            return stdout;
          })
          .toContain('Icon (128 x 128)');
      }
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const bounds = BrowserWindow.getAllWindows()[0]!.getBounds();
            return { width: bounds.width, height: bounds.height };
          }),
        )
        .toEqual({ width: 1440, height: 900 });
      const activeTab = page.locator('.pane-tabbar .terminal-tab.active');
      await expect(activeTab).toHaveCount(1);
      const initialTerminalId = await activeTab.getAttribute('data-terminal-id');
      await page.getByTitle('新建本地终端').click();
      await expect
        .poll(() => activeTab.getAttribute('data-terminal-id'))
        .not.toBe(initialTerminalId);
      const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
      const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
      await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
        'data-connection-state',
        'connected',
      );
      await terminalInput.pressSequentially("printf '\\nAXTERM_PACKAGED_PTY_OK\\n'");
      await terminalInput.press('Enter');
      await expect
        .poll(() => terminalLayer.locator('.xterm-rows').textContent())
        .toContain('AXTERM_PACKAGED_PTY_OK');
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'terminal.png') });
      await terminalInput.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      const search = terminalLayer.getByPlaceholder('查找终端输出');
      await expect
        .poll(async () => {
          await search.fill('');
          await search.fill('AXTERM_PACKAGED_PTY_OK');
          return terminalLayer.locator('.terminal-search-result').textContent();
        })
        .toBe('已找到');
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await page.getByRole('button', { name: '添加主机' }).click();
      await page.getByLabel('显示名称').fill('packaged-sqlite');
      await page.getByLabel('主机地址').fill('127.0.0.1');
      await page.getByLabel('用户名').fill('fixture');
      await page.getByLabel('认证方式').selectOption('agent');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(
        page.locator('.host-card').getByText('packaged-sqlite', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '添加串口' }).click();
      await expect(page.getByTestId('serial-enumeration-ready')).toContainText(/已枚举 \d+ 个串口/);
      await page.getByRole('button', { name: '取消' }).click();
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'hosts.png') });

      await openQuickCommandsWorkspace(page);
      const commands = page.getByTestId('quick-command-workspace');
      await commands
        .locator('.quick-command-toolbar')
        .getByRole('button', { name: '新建快捷命令', exact: true })
        .click();
      const editor = commands.locator('.quick-command-form');
      await editor.getByLabel('名称', { exact: true }).fill('Packaged health');
      await editor.getByLabel('步骤 1 命令').fill('uptime');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await expect(
        commands.locator('.quick-command-tree-row').filter({ hasText: 'Packaged health' }),
      ).toBeVisible();
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'commands.png') });

      await page.locator('[data-activity-item="setting"]').click();
      await expect(page.locator('[data-settings-category="common"]')).toBeVisible();
      await expect(page.locator('[data-settings-category="terminal"]')).toBeVisible();
      await expect(
        page.locator('.settings-workspace-tabs').getByRole('button', { name: /组件/ }),
      ).toBeVisible();
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'settings.png') });

      await app.close();
      app = await electron.launch({
        executablePath,
        args: [`--user-data-dir=${join(directory, 'user-data')}`],
        cwd: directory,
        env: {
          ...process.env,
          ELECTRON_RENDERER_URL: '',
          PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
        },
      });
      const restored = await app.firstWindow();
      await expect(restored.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await restored.locator('[data-activity-item="bookmarks"]').click();
      await restored.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await expect(
        restored.locator('.host-card').getByText('packaged-sqlite', { exact: true }),
      ).toBeVisible();
      await openQuickCommandsWorkspace(restored);
      await expect(
        restored.locator('.quick-command-tree-row').filter({ hasText: 'Packaged health' }),
      ).toBeVisible();
      await restored.screenshot({ path: join(packagedEvidenceDirectory, 'restart.png') });
    } finally {
      await app.close().catch(() => {});
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Windows app starts its unconfigured local terminal with PowerShell 7', async () => {
  test.skip(process.platform !== 'win32', 'PowerShell 7 is the Windows platform default.');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-pwsh-')));
  const artifact = join(directory, 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath = join(artifact, 'Axterm.exe');
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      PATH: process.env.SystemRoot ?? '',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
    await terminalInput.pressSequentially(
      "Write-Output ('AXTERM_PWSH_MAJOR=' + $PSVersionTable.PSVersion.Major)",
    );
    await terminalInput.press('Enter');
    await expect
      .poll(() => terminalLayer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PWSH_MAJOR=7');
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Windows Ctrl+C copies selection and interrupts without one or on double press', async () => {
  test.skip(process.platform !== 'win32', 'The Windows terminal keyboard behavior is under test.');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-ctrl-c-')));
  const artifact = join(directory, 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const app = await electron.launch({
    executablePath: join(artifact, 'Axterm.exe'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const input = layer.locator('.xterm-helper-textarea');
    await input.pressSequentially("Write-Output 'AXTERM_PACKAGED_CTRL_C_COPY'");
    await input.press('Enter');
    await expect
      .poll(() => layer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PACKAGED_CTRL_C_COPY');
    await layer.locator('.terminal-host').click({ button: 'right', position: { x: 100, y: 100 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '全选' })
      .click();
    await page.keyboard.press('Control+c');
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('AXTERM_PACKAGED_CTRL_C_COPY');

    const started = join(directory, 'sleep-started.txt');
    const afterInterrupt = join(directory, 'after-interrupt.txt');
    await input.pressSequentially(
      `Set-Content -LiteralPath '${started}' -Value 'started'; Start-Sleep -Seconds 20`,
    );
    await input.press('Enter');
    await expect.poll(() => readFile(started, 'utf8').catch(() => '')).toContain('started');
    await app.evaluate(({ clipboard }) => clipboard.writeText('NO_SELECTION_SENTINEL'));
    await input.press('Control+c');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      'NO_SELECTION_SENTINEL',
    );
    // PowerShell/PSReadLine can discard the first keystroke while redrawing after ^C.
    await page.waitForTimeout(300);
    await input.pressSequentially(`Set-Content -LiteralPath '${afterInterrupt}' -Value 'resumed'`);
    await input.press('Enter');
    await expect.poll(() => readFile(afterInterrupt, 'utf8').catch(() => '')).toContain('resumed');

    const doubleStarted = join(directory, 'double-started.txt');
    const afterDouble = join(directory, 'after-double.txt');
    await input.pressSequentially(
      `Set-Content -LiteralPath '${doubleStarted}' -Value 'started'; Start-Sleep -Seconds 20`,
    );
    await input.press('Enter');
    await expect.poll(() => readFile(doubleStarted, 'utf8').catch(() => '')).toContain('started');
    await layer.locator('.terminal-host').click({ button: 'right', position: { x: 100, y: 100 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '全选' })
      .click();
    await app.evaluate(({ clipboard }) => clipboard.writeText('DOUBLE_PRESS_SENTINEL'));
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('Start-Sleep -Seconds 20');
    await page.waitForTimeout(300);
    await input.pressSequentially(`Set-Content -LiteralPath '${afterDouble}' -Value 'resumed'`);
    await input.press('Enter');
    await expect.poll(() => readFile(afterDouble, 'utf8').catch(() => '')).toContain('resumed');
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Windows terminal pastes with Ctrl+V and Ctrl+Shift+V', async () => {
  test.skip(process.platform !== 'win32', 'The Windows terminal keyboard behavior is under test.');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-ctrl-v-')));
  const artifact = join(directory, 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const app = await electron.launch({
    executablePath: join(artifact, 'Axterm.exe'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const input = layer.locator('.xterm-helper-textarea');
    for (const [chord, filename] of [
      ['Control+v', 'ctrl-v.txt'],
      ['Control+Shift+v', 'ctrl-shift-v.txt'],
    ] as const) {
      const output = join(directory, filename);
      await app.evaluate(
        ({ clipboard }, command) => clipboard.writeText(command),
        `Set-Content -LiteralPath '${output}' -Value '${filename}'`,
      );
      await input.press(chord);
      await expect.poll(() => layer.locator('.xterm-rows').textContent()).toContain(filename);
      await input.press('Enter');
      await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toContain(filename);
    }
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Windows new tab keeps the first multiline paste buffered until Enter', async () => {
  test.skip(process.platform !== 'win32', 'The Windows PowerShell startup behavior is under test.');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-first-paste-')));
  const artifact = join(directory, 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const app = await electron.launch({
    executablePath: join(artifact, 'Axterm.exe'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const first = join(directory, 'first.txt');
    const second = join(directory, 'second.txt');
    await app.evaluate(
      ({ clipboard }, value) => clipboard.writeText(value),
      `Set-Content -LiteralPath '${first}' -Value 'first'\r\nSet-Content -LiteralPath '${second}' -Value 'second'`,
    );
    const previousId = await page
      .locator('.terminal-session-layer:not([hidden])')
      .getAttribute('data-terminal-session');
    await page.locator('.terminal-pane.active .tab-add').click();
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(2);
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer).not.toHaveAttribute('data-terminal-session', previousId!);
    const input = layer.locator('.xterm-helper-textarea');
    await input.press('Control+v');
    const dialog = page.getByRole('dialog', { name: '确认粘贴到终端' });
    await dialog.getByRole('button', { name: '确认粘贴' }).click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('剪贴板内容已发送到终端。');
    await page.waitForTimeout(3_000);
    expect(await readFile(first, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(await readFile(second, 'utf8').catch(() => undefined)).toBeUndefined();
    await input.press('Enter');
    await expect.poll(() => readFile(first, 'utf8').catch(() => '')).toContain('first');
    await expect.poll(() => readFile(second, 'utf8').catch(() => '')).toContain('second');
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Windows paste confirmation and file browser layout use available space', async () => {
  test.skip(process.platform !== 'win32', 'The Windows packaged interface is under test.');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-file-layout-')));
  const browseDirectory = join(directory, 'browse');
  await mkdir(browseDirectory);
  await Promise.all(
    Array.from({ length: 80 }, (_, index) =>
      writeFile(join(browseDirectory, `file-${String(index).padStart(3, '0')}.txt`), ''),
    ),
  );
  const artifact = join(directory, 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const app = await electron.launch({
    executablePath: join(artifact, 'Axterm.exe'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      });
    }, browseDirectory);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText("Write-Output 'PACKAGED_PASTE_ONE'\nWrite-Output 'PACKAGED_PASTE_TWO'"),
    );
    await layer.locator('.xterm-helper-textarea').press('Control+v');
    const pasteDialog = page.getByRole('dialog', { name: '确认粘贴到终端' });
    await expect(pasteDialog.getByRole('button', { name: '确认粘贴' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pasteDialog).toHaveCount(0);
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('剪贴板内容已发送到终端。');

    await page
      .getByRole('tablist', { name: '会话工具' })
      .getByRole('tab', { name: '文件管理' })
      .click();
    const pane = page.locator('.terminal-file-session-layer:not([hidden]) .file-pane-local');
    await pane.getByRole('button', { name: '更换目录' }).click();
    await expect(pane.getByLabel('本地绝对路径')).toHaveValue(browseDirectory);
    await expect.poll(() => pane.locator('.file-data-row').count()).toBeGreaterThan(20);
    const bottomGap = await pane.evaluate((element) => {
      const scroll = element.querySelector('.file-table-scroll')!.getBoundingClientRect();
      return element.getBoundingClientRect().bottom - scroll.bottom;
    });
    expect(bottomGap).toBeLessThan(50);
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Windows close button confirms multiple tabs and allows cancellation', async () => {
  test.skip(process.platform !== 'win32', 'The custom Windows close button is under test.');
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-close-')));
  const artifact = join(directory, 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const app = await electron.launch({
    executablePath: join(artifact, 'Axterm.exe'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(1);
    await page.locator('.terminal-pane.active .tab-add').click();
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized()),
      )
      .toBe(true);

    const closeButton = page.locator('[data-window-action="close"]');
    await expect(page.locator('.activity-brand')).toHaveCSS('-webkit-app-region', 'drag');
    await expect(page.locator('.terminal-workspace > .tabbar')).toHaveCSS(
      '-webkit-app-region',
      'no-drag',
    );
    const dragStrip = page.locator('.terminal-pane.active > .pane-tabbar .pane-tabbar-scroll');
    await expect(dragStrip).toHaveCSS('-webkit-app-region', 'drag');
    const dragSpace = dragStrip.locator('.pane-tabbar-drag-space');
    await expect(dragSpace).toHaveCSS('-webkit-app-region', 'drag');
    expect(
      await dragSpace.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeGreaterThan(100);
    const stripRight = await dragStrip.evaluate((element) => element.getBoundingClientRect().right);
    const controlsLeft = await page
      .locator('.terminal-workspace > .tabbar')
      .evaluate((element) => element.getBoundingClientRect().left);
    expect(stripRight).toBeLessThanOrEqual(controlsLeft + 1);
    await expect(closeButton).toHaveCSS('-webkit-app-region', 'no-drag');
    const closeTarget = await closeButton.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      return {
        x,
        y,
        hitsCloseButton: button.contains(document.elementFromPoint(x, y)),
        regionsAtPoint: document
          .elementsFromPoint(x, y)
          .map((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')),
      };
    });
    expect(closeTarget.hitsCloseButton).toBe(true);
    expect(closeTarget.regionsAtPoint).not.toContain('drag');
    await page.mouse.click(closeTarget.x, closeTarget.y);
    const confirmation = page.getByRole('alertdialog', { name: '关闭 2 个标签？' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '取消' }).click();
    expect(page.isClosed()).toBe(false);

    await page.mouse.click(closeTarget.x, closeTarget.y);
    await confirmation.getByRole('button', { name: '关闭窗口' }).click();
    await expect.poll(() => page.isClosed()).toBe(true);
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged P-04/P-07 localizes SSH Host Key review and blocks unconfirmed replacement', async () => {
  test.setTimeout(120_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-host-key-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const userData = join(directory, 'user-data');
  const databasePath = join(userData, 'data-v2', 'axterm.sqlite');
  const hostKey = sshUtils.generateKeyPairSync('ecdsa', { bits: 256 }).private;
  const parsedHostKey = sshUtils.parseKey(hostKey);
  if (parsedHostKey instanceof Error || Array.isArray(parsedHostKey))
    throw new Error('Packaged Host Key fixture generated an invalid host key');
  const publicKey = parsedHostKey.getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256')
    .update(publicKey)
    .digest('base64')
    .replace(/=+$/u, '')}`;
  const unknownFixture = await startPackagedHostKeyFixture(hostKey);
  const changedFixture = await startPackagedHostKeyFixture(hostKey);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

  const localeCases = [
    {
      id: 'en',
      bookmark: 'Packaged Host Key EN',
      title: 'First connection to this host',
      summary: 'No identity is saved for this SSH host.',
      target: 'Target',
      algorithm: 'Algorithm',
      fingerprint: 'SHA256 fingerprint',
      remember: 'Save and remember this host key',
      reject: 'Reject',
      changedTitle: 'Remote host key changed',
      changedSummary: 'The remote identity does not match the saved host key.',
      highRisk: 'High risk',
      confirmChanged: 'I verified the new fingerprint and want to replace the saved host key',
      replaceAndConnect: 'Replace key and connect',
      confirmRequired:
        'Verify the new fingerprint and select the confirmation checkbox before replacing the saved host key.',
    },
    {
      id: 'ja',
      bookmark: 'Packaged Host Key JA',
      title: 'このホストへの初回接続',
      summary: 'この SSH ホストの識別情報は保存されていません。',
      target: '接続先',
      algorithm: 'アルゴリズム',
      fingerprint: 'SHA256 フィンガープリント',
      remember: 'このホスト鍵を保存して記憶',
      reject: '拒否',
      changedTitle: 'リモートホスト鍵が変更されました',
      changedSummary: 'リモートの識別情報が保存済みホスト鍵と一致しません。',
      highRisk: '高リスク',
      confirmChanged: '新しいフィンガープリントを確認し、保存済みホスト鍵を置き換えます',
      replaceAndConnect: '鍵を置き換えて接続',
      confirmRequired:
        '新しいフィンガープリントを確認し、確認チェックボックスを選択してから保存済みホスト鍵を置き換えてください。',
    },
    {
      id: 'zh-CN',
      bookmark: 'Packaged Host Key ZH-CN',
      title: '首次连接此主机',
      summary: '尚未保存此 SSH 主机的身份。',
      target: '目标',
      algorithm: '算法',
      fingerprint: 'SHA256 指纹',
      remember: '保存并记住此主机密钥',
      reject: '拒绝',
      changedTitle: '远程主机密钥已改变',
      changedSummary: '远程主机身份与已保存的主机密钥不一致。',
      highRisk: '高风险',
      confirmChanged: '我已核对新指纹，替换已保存的主机密钥',
      replaceAndConnect: '替换密钥并连接',
      confirmRequired: '请先核对新指纹并勾选确认框，再替换已保存的主机密钥。',
    },
    {
      id: 'zh-TW',
      bookmark: 'Packaged Host Key ZH-TW',
      title: '首次連線至此主機',
      summary: '尚未儲存此 SSH 主機的身分。',
      target: '目標',
      algorithm: '演算法',
      fingerprint: 'SHA256 指紋',
      remember: '儲存並記住此主機金鑰',
      reject: '拒絕',
      changedTitle: '遠端主機金鑰已變更',
      changedSummary: '遠端主機身分與已儲存的主機金鑰不一致。',
      highRisk: '高風險',
      confirmChanged: '我已驗證新指紋，並要取代已儲存的主機金鑰',
      replaceAndConnect: '取代金鑰並連線',
      confirmRequired: '請先核對新指紋並勾選確認方塊，再取代已儲存的主機金鑰。',
    },
  ] as const;

  try {
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    await mkdir(join(userData, 'data-v2'), { recursive: true });
    const database = await ProductDatabase.open(databasePath);
    try {
      const products = new ProductRepository(database);
      const bookmarks = new BookmarkRepository(database);
      for (const locale of localeCases) {
        const host = products.createHost({
          name: locale.bookmark,
          hostname: '127.0.0.1',
          port: unknownFixture.port,
          username: 'operator',
          authType: 'agent',
          sshAgent: { enabled: false, path: null },
        });
        bookmarks.createBookmark(
          createBookmarkSchema.parse({
            protocol: 'ssh',
            hostId: host.id,
            title: locale.bookmark,
            description: 'Packaged localized Host Key verification fixture',
          }),
          bookmarks.snapshot().etag,
        );
      }
      const changedHost = products.createHost({
        name: 'Packaged Changed Host Key',
        hostname: '127.0.0.1',
        port: changedFixture.port,
        username: 'operator',
        authType: 'agent',
        sshAgent: { enabled: false, path: null },
      });
      products.saveKnownHostKey({
        host: changedHost.hostname,
        port: changedHost.port,
        algorithm: parsedHostKey.type,
        fingerprint: 'SHA256:packaged-previous-host-key',
        publicKey: Buffer.from('packaged-previous-host-key').toString('base64'),
      });
      bookmarks.createBookmark(
        createBookmarkSchema.parse({
          protocol: 'ssh',
          hostId: changedHost.id,
          title: 'Packaged Changed Host Key',
          description: 'Packaged changed Host Key verification fixture',
        }),
        bookmarks.snapshot().etag,
      );
    } finally {
      database.close();
    }

    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');

    for (const locale of localeCases) {
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator(`[data-bookmark-title="${locale.bookmark}"] .bookmark-row-main`).click();

      const dialog = page.getByRole('dialog', { name: locale.title });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('form[data-interaction-kind="unknownHostKey"]')).toBeVisible();
      await expect(dialog.getByText(locale.summary, { exact: true })).toBeVisible();
      await expect(dialog.getByText(locale.target, { exact: true })).toBeVisible();
      await expect(dialog.getByText(locale.algorithm, { exact: true })).toBeVisible();
      await expect(dialog.getByText(locale.fingerprint, { exact: true })).toBeVisible();
      await expect(dialog.getByText(`operator@127.0.0.1:${unknownFixture.port}`)).toBeVisible();
      await expect(dialog.getByText(parsedHostKey.type, { exact: true })).toBeVisible();
      await expect(dialog.getByText(fingerprint, { exact: true })).toBeVisible();
      await expect(dialog.getByLabel(locale.remember)).toBeChecked();
      const reject = dialog.getByRole('button', { name: locale.reject, exact: true });
      await expect(reject).toBeFocused();
      await expect(dialog.getByText('SSH host key verification', { exact: true })).toHaveCount(0);
      if (locale.id === 'zh-CN')
        await page.screenshot({
          path: join(packagedEvidenceDirectory, 'packaged-host-key-zh-CN.png'),
        });
      await reject.click();
      await expect(dialog).toBeHidden();
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([720, 450]);

    for (const locale of localeCases) {
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page
        .locator('[data-bookmark-title="Packaged Changed Host Key"] .bookmark-row-main')
        .click();

      const changedDialog = page.getByRole('dialog', { name: locale.changedTitle });
      await expect(changedDialog).toBeVisible();
      await expect(
        changedDialog.locator('form[data-interaction-kind="changedHostKey"]'),
      ).toBeVisible();
      await expect(changedDialog.getByRole('alert', { name: locale.changedSummary })).toBeVisible();
      await expect(changedDialog.getByText(locale.changedSummary, { exact: true })).toBeVisible();
      await expect(changedDialog.getByText(locale.highRisk, { exact: true })).toBeVisible();
      await expect(
        changedDialog.getByText('SHA256:packaged-previous-host-key', { exact: true }),
      ).toBeVisible();
      await expect(changedDialog.getByText(fingerprint, { exact: true })).toBeVisible();
      const confirm = changedDialog.getByLabel(locale.confirmChanged);
      await expect(confirm).not.toBeChecked();
      await changedDialog.getByRole('button', { name: locale.replaceAndConnect }).click();
      await expect(changedDialog).toBeVisible();
      await expect(changedDialog.getByText(locale.confirmRequired, { exact: true })).toBeVisible();
      await expect(confirm).toHaveAttribute('aria-invalid', 'true');
      const geometry = await changedDialog.evaluate((element) => ({
        dialogWidth: element.clientWidth,
        dialogScrollWidth: element.scrollWidth,
        dialogHeight: element.clientHeight,
        dialogScrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: globalThis.innerWidth,
      }));
      expect(
        geometry.dialogScrollWidth,
        `${locale.id} changed Host Key horizontal overflow`,
      ).toBeLessThanOrEqual(geometry.dialogWidth + 1);
      expect(
        geometry.documentWidth,
        `${locale.id} document horizontal overflow`,
      ).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(
        geometry.dialogScrollHeight <= geometry.dialogHeight + 1 ||
          ['auto', 'scroll'].includes(geometry.overflowY),
        `${locale.id} changed Host Key dialog clips unscrollable vertical content`,
      ).toBe(true);
      expect(
        await changedDialog
          .locator('.host-key-interaction-summary')
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe('rgb(240, 100, 115)');
      if (locale.id === 'en')
        await page.screenshot({
          path: join(packagedEvidenceDirectory, 'packaged-changed-host-key.png'),
        });
      await changedDialog.getByRole('button', { name: locale.reject, exact: true }).click();
      await expect(changedDialog).toBeHidden();
    }

    await app.close();
    app = undefined;
    const inspected = await ProductDatabase.open(databasePath);
    try {
      expect(
        new ProductRepository(inspected).getKnownHostKey('127.0.0.1', changedFixture.port),
      ).toMatchObject({ fingerprint: 'SHA256:packaged-previous-host-key' });
    } finally {
      inspected.close();
    }
  } finally {
    await app?.close().catch(() => {});
    await unknownFixture.stop().catch(() => {});
    await changedFixture.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Phase 12 shell preserves tab, pane, workspace and window behavior', async () => {
  test.setTimeout(120_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-phase12-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const userData = join(directory, 'user-data');
  const launch = () =>
    electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const bounds = BrowserWindow.getAllWindows()[0]!.getBounds();
          return { width: bounds.width, height: bounds.height };
        }),
      )
      .toEqual({ width: 1440, height: 900 });

    const rail = page.locator('.activity-bar');
    await expect(rail.locator('[data-activity-item]')).toHaveCount(3);
    await expect(rail.locator('.activity-brand')).toBeEmpty();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.workspace-sidebar')).toBeVisible();

    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await expect(page.getByRole('heading', { name: '主机与连接' })).toBeVisible();
    const addHost = page.getByRole('button', { name: '添加主机' });
    await addHost.click();
    const hostDialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(hostDialog).toBeVisible();
    await expect(
      hostDialog.locator('.host-bookmark-shell-tabs, .host-bookmark-shell-sidebar'),
    ).toHaveCount(0);
    await expect(page.getByText('New Bookmarks', { exact: true })).toHaveCount(0);
    await expect(page.getByText('PrivateKey/Certificate', { exact: true })).toHaveCount(0);
    const packagedHostStyle = await hostDialog
      .locator('input[name="save"]')
      .evaluate((element) => ({
        accentColor: getComputedStyle(element).accentColor,
        width: element.closest('[role="dialog"]')?.getBoundingClientRect().width ?? 0,
      }));
    expect(packagedHostStyle.accentColor).toBe('rgb(47, 199, 161)');
    expect(packagedHostStyle.width).toBeGreaterThan(0);
    expect(packagedHostStyle.width).toBeLessThanOrEqual(922);
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'phase12-host-dialog.png') });
    await page.keyboard.press('Escape');
    await expect(hostDialog).toBeHidden();
    await expect(addHost).toBeFocused();

    const addRdp = page.getByRole('button', { name: '添加 RDP' });
    await addRdp.click();
    const rdpDialog = page.getByRole('dialog', { name: '添加 RDP 书签' });
    const rdpForm = rdpDialog.locator('form[data-protocol="rdp"]');
    await expect(rdpDialog).toBeVisible();
    await expect(rdpForm).toBeVisible();
    await expect(rdpDialog.getByLabel('名称')).toBeFocused();
    const packagedRdpStyle = await rdpDialog.evaluate((element) => {
      const form = element.querySelector<HTMLElement>('.protocol-bookmark-form');
      const scaleViewport = element.querySelector<HTMLInputElement>('input[name="scaleViewport"]');
      const { bottom, left, right, top, width } = element.getBoundingClientRect();
      return {
        accentColor: scaleViewport ? getComputedStyle(scaleViewport).accentColor : '',
        bottom,
        columns: form ? getComputedStyle(form).gridTemplateColumns : '',
        left,
        right,
        top,
        viewportHeight: globalThis.innerHeight,
        viewportWidth: globalThis.innerWidth,
        width,
      };
    });
    expect(packagedRdpStyle.accentColor).toBe('rgb(47, 199, 161)');
    expect(packagedRdpStyle.width).toBeGreaterThanOrEqual(760);
    expect(packagedRdpStyle.width).toBeLessThanOrEqual(822);
    expect(packagedRdpStyle.columns.trim().split(/\s+/u)).toHaveLength(2);
    expect(packagedRdpStyle.left).toBeGreaterThanOrEqual(0);
    expect(packagedRdpStyle.top).toBeGreaterThanOrEqual(0);
    expect(packagedRdpStyle.right).toBeLessThanOrEqual(packagedRdpStyle.viewportWidth);
    expect(packagedRdpStyle.bottom).toBeLessThanOrEqual(packagedRdpStyle.viewportHeight);
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'phase12-rdp-dialog.png') });
    const saveRdp = rdpDialog.getByRole('button', { name: '保存并连接' });
    await saveRdp.scrollIntoViewIfNeeded();
    await expect(saveRdp).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(rdpDialog).toBeHidden();
    await expect(addRdp).toBeFocused();

    await page.locator('[data-activity-item="setting"]').click();
    await page.getByRole('button', { name: '终端配置', exact: true }).click();
    const connectionConfiguration = page.getByRole('region', { name: '连接配置' });
    await expect(connectionConfiguration.getByRole('heading', { name: '连接配置' })).toBeVisible();
    await expect(connectionConfiguration.getByLabel('连接配置名称')).toBeVisible();
    await expect(connectionConfiguration.getByText('Profiles', { exact: true })).toHaveCount(0);
    await expect(connectionConfiguration.getByText(/连接 Profile|Profile 名称/u)).toHaveCount(0);
    await expect(connectionConfiguration.getByText(/ID:\s*PROFILE\d+/u)).toHaveCount(0);
    await page.screenshot({
      path: join(packagedEvidenceDirectory, 'phase12-connection-configuration.png'),
    });
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.locator('.workspace-tab.terminal-tab.active:visible').click();
    await expect(page.locator('.terminal-pane.active .tab-add')).toBeVisible();

    await page.getByTitle('收起侧栏').click();
    await expect(page.locator('.workspace-sidebar')).toBeHidden();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.workspace-sidebar')).toBeVisible();

    await page.locator('.tab-add-menu:visible').first().click();
    const sessionMenu = page.locator('.session-menu');
    await expect(sessionMenu).toBeVisible();
    await sessionMenu.locator('#quick-connect').fill('invalid protocol://');
    await sessionMenu.locator('#quick-connect').press('Enter');
    await expect(sessionMenu.locator('.menu-error')).toBeVisible();
    await page.keyboard.press('Escape');

    for (let index = 0; index < 3; index++)
      await page.locator('.terminal-pane.active .tab-add').click();
    const paneTabs = page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab');
    await expect(paneTabs).toHaveCount(4);
    await expect(paneTabs.locator('.tab-number')).toHaveText(['1', '2', '3', '4']);
    expect(
      await paneTabs
        .locator('.tab-number')
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return { backgroundColor: style.backgroundColor, color: style.color };
        }),
    ).toEqual({ backgroundColor: 'rgb(47, 199, 161)', color: 'rgb(6, 32, 27)' });
    const initialIds = await paneTabs.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-terminal-id')),
    );
    await paneTabs.first().focus();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect
      .poll(() =>
        paneTabs.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-terminal-id')),
        ),
      )
      .toEqual([initialIds[1], initialIds[0], initialIds[2], initialIds[3]]);

    const renameCandidate = paneTabs.nth(1);
    const renameCandidateId = await renameCandidate.getAttribute('data-terminal-id');
    expect(renameCandidateId).toBeTruthy();
    const namedTab = page.locator(
      `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${renameCandidateId!}"]`,
    );
    await namedTab.click({ button: 'right' });
    const contextMenu = page.locator('.tab-context-menu');
    await expect(contextMenu.getByRole('button', { name: '复制标签' })).toBeVisible();
    await expect(contextMenu.getByRole('button', { name: '关闭其他标签' })).toBeVisible();
    await contextMenu.getByRole('button', { name: '固定标签' }).click();
    await namedTab.click({ button: 'right' });
    await contextMenu.getByRole('button', { name: '重命名' }).click();
    await namedTab.locator('.tab-rename').fill('打包四窗格');
    await namedTab.locator('.tab-rename').press('Enter');
    await expect(namedTab).toHaveClass(/pinned/);

    const tabIds = await paneTabs.evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute('data-terminal-id'))
        .filter((id): id is string => !!id),
    );
    const activeTerminalId = await page
      .locator('.pane-tabbar[data-pane-index="0"] .terminal-tab.active')
      .getAttribute('data-terminal-id');
    expect(activeTerminalId).toBeTruthy();

    await page.getByTitle('布局与工作区').click();
    await page.locator('[data-layout-choice="c2x2"]').click();
    await expect(page.locator('.terminal-pane')).toHaveCount(4);
    const emptyPanes = page.locator('.empty-pane-landing');
    await expect(emptyPanes).toHaveCount(3);
    const emptyPane = emptyPanes.first();
    await expect(emptyPane).toHaveRole('region');
    await expect(emptyPane.getByRole('heading', { name: '本地终端' })).toBeVisible();
    await expect(emptyPane.getByRole('button', { name: '新建终端' })).toBeVisible();
    await expect(emptyPane.getByRole('button', { name: '不保存直接连接' })).toBeVisible();
    await expect(emptyPane.getByRole('button', { name: '添加已保存连接' })).toBeVisible();
    await expect(emptyPane.getByRole('button', { name: '使用 AI 草拟连接' })).toBeVisible();
    await expect(emptyPane.locator('.empty-pane-sort')).toHaveCount(0);
    expect(
      await emptyPane
        .locator('.empty-pane-glyph')
        .evaluate((element) => getComputedStyle(element).color),
    ).toBe('rgb(47, 199, 161)');
    expect(
      await emptyPane.getByRole('button', { name: '新建终端' }).evaluate((element) => {
        const style = getComputedStyle(element);
        return { backgroundColor: style.backgroundColor, color: style.color };
      }),
    ).toEqual({ backgroundColor: 'rgb(47, 199, 161)', color: 'rgb(6, 32, 27)' });
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'phase12-empty-pane.png') });
    const assignable = tabIds.filter((id) => id !== activeTerminalId);
    for (let paneIndex = 1; paneIndex < 4; paneIndex++)
      await page
        .getByLabel(`为窗格 ${paneIndex + 1} 选择已有会话`)
        .selectOption(assignable[paneIndex - 1]!);
    await expect(page.locator('.terminal-host:visible')).toHaveCount(4);

    const firstPane = page.locator('.terminal-pane').first();
    const before = await firstPane.boundingBox();
    const divider = page.locator('.pane-resizer.vertical').first();
    const handle = await divider.boundingBox();
    expect(before).toBeTruthy();
    expect(handle).toBeTruthy();
    await page.mouse.move(handle!.x + 2, handle!.y + 20);
    await page.mouse.down();
    await page.mouse.move(handle!.x + 80, handle!.y + 20, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(async () => Math.abs((await firstPane.boundingBox())!.width - before!.width))
      .toBeGreaterThan(10);

    const secondPane = page.locator('.terminal-pane').nth(1);
    await secondPane.getByRole('button', { name: '最大化窗格 2' }).click();
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
    await page.getByRole('button', { name: '还原窗格 2' }).click();
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(4);

    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区' }).click();
    await page.getByPlaceholder('工作区名称').fill('打包 Phase 12');
    await page.locator('.workspace-menu form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.workspace-list-menu').getByText('打包 Phase 12')).toBeVisible();
    await page.keyboard.press('Escape');

    const fullscreen = page.locator('[data-window-action="toggle-fullscreen"]');
    await fullscreen.click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          return window.isFullScreen() || window.isSimpleFullScreen();
        }),
      )
      .toBe(true);
    await fullscreen.click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          return window.isFullScreen() || window.isSimpleFullScreen();
        }),
      )
      .toBe(false);
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'phase12-shell.png') });
    await page.waitForTimeout(700);

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-pane')).toHaveCount(1);
    await expect(page.locator('.pane-tabbar .terminal-tab')).toHaveCount(1);
    await expect(page.locator('.pane-tabbar .terminal-tab.disconnected')).toHaveCount(0);
    await expect(
      page.locator('.pane-tabbar .terminal-tab').filter({ hasText: '打包四窗格' }),
    ).toHaveCount(0);
    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区' }).click();
    await expect(page.locator('.workspace-list-menu').getByText('打包 Phase 12')).toBeVisible();
    await page
      .locator('.workspace-list-menu > div > button')
      .filter({ hasText: '打包 Phase 12' })
      .click();
    await expect(page.locator('.terminal-pane')).toHaveCount(4);
    await expect(page.locator('.pane-tabbar .terminal-tab')).toHaveCount(4);
    await expect(
      page.locator('.terminal-host[data-connection-state="connected"]:visible'),
    ).toHaveCount(4);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'phase12-restart.png') });
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS S1 localizes Settings recovery and real Runtime restart at 200% zoom', async () => {
  test.skip(process.platform !== 'darwin', 'S1 currently requires the macOS packaged candidate');
  test.setTimeout(180_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-s1-')));
  const artifact = join(directory, 'Axterm.app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath = join(artifact, 'Contents/MacOS/Axterm');
  const userData = join(directory, 'user-data');
  const launch = () =>
    electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', {
        configurable: true,
        get: () => [window.name || 'en'],
      });
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 720, height: 450 });

    let rejectSettingsRead = false;
    let rejectRuntimeStatus = false;
    const failureBody = JSON.stringify({
      type: 'about:blank',
      title: 'Synthetic failure',
      status: 500,
      detail: 'packaged-s1-canary-do-not-display',
    });
    await page.route('**/api/v1/settings', async (route) => {
      if (rejectSettingsRead && route.request().method() === 'GET') {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: failureBody,
        });
        return;
      }
      await route.continue();
    });
    await page.route('**/api/v1/runtime', async (route) => {
      if (rejectRuntimeStatus && route.request().method() === 'GET') {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: failureBody,
        });
        return;
      }
      await route.continue();
    });

    const cases = [
      {
        id: 'en',
        ready: 'Runtime Ready',
        degraded: 'Runtime Degraded',
        loadFailed: 'Unable to load settings. Saved preferences were not changed.',
        retry: 'Retry loading settings',
        recovered: 'Core Runtime recovered',
      },
      {
        id: 'ja',
        ready: 'Runtime の準備ができました',
        degraded: 'Runtime への接続が中断されました',
        loadFailed: '設定を読み込めませんでした。保存済みの設定は変更されていません。',
        retry: '設定の読み込みを再試行',
        recovered: 'Core Runtime が復旧しました',
      },
      {
        id: 'zh-CN',
        ready: 'Runtime 已就绪',
        degraded: 'Runtime 连接中断',
        loadFailed: '无法读取设置。已保存的偏好未更改。',
        retry: '重试读取设置',
        recovered: 'Core Runtime 已恢复',
      },
      {
        id: 'zh-TW',
        ready: 'Runtime 已就緒',
        degraded: 'Runtime 連線中斷',
        loadFailed: '無法載入設定。已儲存的偏好設定並未變更。',
        retry: '重試載入設定',
        recovered: 'Core Runtime 已恢復',
      },
    ] as const;

    for (const locale of cases) {
      rejectSettingsRead = false;
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await page.evaluate((id) => {
        window.name = id;
      }, locale.id);

      rejectSettingsRead = true;
      await page.reload();
      await expect(page.getByTestId('runtime-state')).toHaveText(locale.ready);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      const loadError = page.locator('.settings-load-error');
      await expect(loadError).toContainText(locale.loadFailed);
      const retry = loadError.getByRole('button', { name: locale.retry });
      await retry.focus();
      await expect(retry).toBeFocused();
      await expect(retry).toBeInViewport();
      const bounds = await retry.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: innerWidth,
          height: innerHeight,
        };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.width);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
      await expect(page.getByText('packaged-s1-canary-do-not-display')).toHaveCount(0);
      rejectSettingsRead = false;
      await retry.press('Enter');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await expect(loadError).toHaveCount(0);
      await expect(page.getByTestId('application-language')).toBeEnabled();

      rejectRuntimeStatus = true;
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'degraded');
      await expect(page.getByTestId('runtime-state')).toHaveText(locale.degraded);
      await expect(page.locator('.runtime-wait h2')).toHaveText(locale.degraded);
      await expect(page.getByText('packaged-s1-canary-do-not-display')).toHaveCount(0);
      rejectRuntimeStatus = false;
      await page.locator('.runtime-wait button').click();
      await expect(page.getByTestId('runtime-state')).toHaveText(locale.ready);
    }

    // A supervisor intentionally stops after three restarts. Launch a fresh
    // packaged host for each real crash so every locale exercises one recovery.
    await app.close();
    for (const locale of cases) {
      app = await launch();
      page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      const generation = await page.getByTestId('runtime-generation').innerText();
      const runtimePid = Number(
        await page.locator('.runtime-identity dl div').nth(2).locator('dd').innerText(),
      );
      const mainPid = await app.evaluate(() => process.pid);
      expect(runtimePid).toBeGreaterThan(0);
      expect(runtimePid).not.toBe(mainPid);
      process.kill(runtimePid, 'SIGKILL');
      await expect(page.getByTestId('runtime-generation')).not.toHaveText(generation);
      await expect(page.getByTestId('runtime-state')).toHaveText(locale.ready);
      const recoveryBanner = page.getByTestId('session-recovery');
      await expect(recoveryBanner).toHaveAttribute('data-recovery-kind', 'runtime-restarted');
      await expect(recoveryBanner.locator('strong')).toHaveText(locale.recovered);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await app.close();
    }
  } finally {
    await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS S2 localizes SSH, FTP and connection editor validation and retry at 200% zoom', async () => {
  test.skip(process.platform !== 'darwin', 'The Mac engineering cell runs against a copied .app');
  test.setTimeout(300_000);
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-editor-s2-')));
  const artifact = join(directory, 'Axterm.app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const userData = join(directory, 'user-data');
  const app = await electron.launch({
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: [`--user-data-dir=${userData}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    const page = await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 720, height: 450 });
    await verifyFourLocaleEditorConditionalJourney(page);
  } finally {
    await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS S3 localizes terminal search, file-list recovery and transfer states at 200% zoom', async () => {
  test.skip(process.platform !== 'darwin', 'The Mac engineering cell runs against a copied .app');
  test.setTimeout(300_000);
  await access(source);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'axterm-packaged-conditional-s3-')),
  );
  const artifact = join(directory, 'Axterm.app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const userData = join(directory, 'user-data');
  const app = await electron.launch({
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: [`--user-data-dir=${userData}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    const page = await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 720, height: 450 });
    await verifyFourLocaleS3ConditionalJourney(page);
  } finally {
    await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS S4 localizes theme, Widget and AI recovery and empty states at 200% zoom', async () => {
  test.skip(process.platform !== 'darwin', 'The Mac engineering cell runs against a copied .app');
  test.setTimeout(300_000);
  await access(source);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'axterm-packaged-conditional-s4-')),
  );
  const artifact = join(directory, 'Axterm.app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const userData = join(directory, 'user-data');
  const app = await electron.launch({
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: [`--user-data-dir=${userData}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    const page = await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 720, height: 450 });
    await verifyFourLocaleS4ConditionalJourney(page);
  } finally {
    await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS S5 keeps Shell and navigation mutation errors safe and retryable in four languages', async () => {
  test.skip(process.platform !== 'darwin', 'The Mac engineering cell runs against a copied .app');
  test.setTimeout(300_000);
  await access(source);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'axterm-packaged-conditional-s5-')),
  );
  const artifact = join(directory, 'Axterm.app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const userData = join(directory, 'user-data');
  const app = await electron.launch({
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: [`--user-data-dir=${userData}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    const page = await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 720, height: 450 });
    await verifyFourLocaleS5ShellJourney(page);
  } finally {
    await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged H-11 localization switches immediately and survives a cold restart', async () => {
  test.setTimeout(90_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-h11-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const userData = join(directory, 'user-data');
  const launch = () =>
    electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const verifyAdvancedDiagnostics = async (title: string, databaseLabel: string) => {
      const diagnostics = page.locator('.settings-advanced-diagnostics');
      const summary = diagnostics.locator('summary');
      await expect(summary).toHaveText(title);
      await expect(diagnostics).not.toHaveAttribute('open', '');
      await expect(diagnostics.locator('.diagnostic-grid')).toHaveCount(0);
      await summary.click();
      await expect(diagnostics).toHaveAttribute('open', '');
      await expect(diagnostics.locator('.diagnostic-grid')).toBeVisible();
      await expect(diagnostics.locator('.diagnostic-grid')).toContainText(databaseLabel);
      await summary.click();
      await expect(diagnostics.locator('.diagnostic-grid')).toHaveCount(0);
    };
    const language = page.getByTestId('application-language');
    await expect(language.locator('option')).toHaveCount(4);
    await language.selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await verifyAdvancedDiagnostics('Advanced diagnostics', 'Database');
    await expect(
      page.getByText(
        'Navigation labels are available in all four supported languages. Other text falls back to English when a translation is unavailable.',
      ),
    ).toBeVisible();
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'localization-en.png') });

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    await expect(page.getByTestId('application-language')).toHaveValue('en');
    const catalog = JSON.parse(
      await readFile(
        resolve('apps/desktop/src/renderer/src/i18n/axterm-navigation.generated.json'),
        'utf8',
      ),
    ) as { locales: Array<{ id: string; messages: { common: string } & Record<string, string> }> };
    const activityNavigationKeys = ['newBookmark', 'bookmarks', 'setting'] as const;
    const settingsNavigationKeys = [
      ['common', 'common'],
      ['terminal', 'terminal'],
      ['shortcuts', 'settingShortcuts'],
      ['sync', 'settingSync'],
      ['ai', 'aiConfig'],
      ['password', 'password'],
      ['legal', 'about'],
    ] as const;
    const languageSaveFailure = {
      en: 'Unable to save the language. Your previous language is still active; try again.',
      ja: '言語を保存できませんでした。以前の言語設定は維持されています。もう一度お試しください。',
      'zh-CN': '无法保存语言。原来的语言仍然生效，请重试。',
      'zh-TW': '無法儲存語言。原本的語言設定仍然有效，請重試。',
    } satisfies Record<(typeof packagedElectronLanguages)[number], string>;
    const settingsSaveFailure = {
      en: {
        behavior: 'Unable to save the setting.',
        terminal: 'Unable to save terminal-recovery settings.',
        tab: 'Unable to save tab settings.',
        proxy: 'Proxy operation failed.',
        windowLoad: 'Unable to load window preferences. Try again.',
        windowSave: 'Unable to save window preferences. Try again.',
      },
      ja: {
        behavior: '設定を保存できませんでした。',
        terminal: 'ターミナル復旧設定を保存できません。',
        tab: 'タブ設定を保存できません。',
        proxy: 'プロキシ操作に失敗しました。',
        windowLoad: 'ウィンドウ設定の読み込みに失敗しました。もう一度お試しください。',
        windowSave: 'ウィンドウ設定の保存に失敗しました。もう一度お試しください。',
      },
      'zh-CN': {
        behavior: '无法保存设置。',
        terminal: '无法保存终端恢复设置',
        tab: '无法保存标签设置',
        proxy: '代理操作失败。',
        windowLoad: '无法读取窗口偏好。请重试。',
        windowSave: '无法保存窗口偏好。请重试。',
      },
      'zh-TW': {
        behavior: '無法儲存設定。',
        terminal: '無法儲存終端機復原設定。',
        tab: '無法儲存分頁設定。',
        proxy: 'Proxy 操作失敗。',
        windowLoad: '無法載入視窗偏好設定。請重試。',
        windowSave: '無法儲存視窗偏好設定。請重試。',
      },
    } satisfies Record<
      (typeof packagedElectronLanguages)[number],
      {
        behavior: string;
        terminal: string;
        tab: string;
        proxy: string;
        windowLoad: string;
        windowSave: string;
      }
    >;
    let rejectSettingsSave = false;
    let rejectWindowLoad = false;
    let rejectWindowSave = false;
    await page.route('**/api/v1/settings', async (route) => {
      if (rejectSettingsSave && route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Synthetic failure',
            status: 500,
            detail: 'do-not-show-this-in-ui',
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.route('**/api/v1/desktop/window/preferences', async (route) => {
      if (
        (rejectWindowLoad && route.request().method() === 'GET') ||
        (rejectWindowSave && route.request().method() === 'PATCH')
      ) {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Synthetic failure',
            status: 500,
            detail: 'do-not-show-this-in-ui',
          }),
        });
        return;
      }
      await route.continue();
    });
    for (const locale of catalog.locales) {
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      for (const key of activityNavigationKeys) {
        const label = locale.messages[key];
        if (!label) throw new Error(`Missing ${locale.id} activity label ${key}`);
        await expect(page.locator(`[data-activity-item="${key}"]`)).toHaveAttribute(
          'aria-label',
          label,
        );
      }
      for (const [category, key] of settingsNavigationKeys) {
        const label = locale.messages[key];
        if (!label) throw new Error(`Missing ${locale.id} settings label ${key}`);
        const button = page.locator(`[data-settings-category="${category}"]`);
        await expect(button).toHaveText(label);
        await button.click();
        await expect(button).toHaveAttribute('aria-current', 'page');
        await expect(page.locator(`.settings-item-${category} .panel-page`)).toBeVisible();
      }
      await page.locator('[data-settings-category="common"]').click();
      const languageEyebrow =
        packagedLanguageEyebrows[locale.id as keyof typeof packagedLanguageEyebrows];
      if (!languageEyebrow) throw new Error(`Missing language eyebrow assertion for ${locale.id}`);
      await expect(page.locator('.language-settings-panel header small')).toHaveText(
        languageEyebrow,
      );
      await expect(page.locator('[data-settings-category="common"]')).toHaveText(
        locale.messages.common,
      );
      if (locale.id === 'zh-CN') await verifyAdvancedDiagnostics('高级诊断', '数据库');
      if (locale.id === 'ja') {
        await verifyAdvancedDiagnostics('詳細診断', 'データベース');
        await expect(
          page.getByText(
            'ナビゲーションのラベルは、対応する4言語すべてで利用できます。翻訳がないその他のテキストは英語で表示されます。',
          ),
        ).toBeVisible();
        await page.locator('[data-settings-category="shortcuts"]').click();
        await expect(
          page.getByRole('heading', { name: 'ショートカット', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('物理キーの組み合わせを入力します。')).toBeVisible();
        await expect(
          page.getByRole('table', { name: 'ショートカット アクション レジストリ' }),
        ).toBeVisible();
        await page.locator('[data-settings-category="common"]').click();
        await page.locator('[data-settings-category="terminal"]').click();
        await expect(
          page.getByPlaceholder('空欄のままにするとプラットフォームの既定シェルを使用します'),
        ).toBeVisible();
        const japaneseRecovery = page.locator('.terminal-recovery-settings-panel');
        await expect(
          japaneseRecovery.getByRole('heading', { name: 'ターミナルの操作と復旧', exact: true }),
        ).toBeVisible();
        await expect(japaneseRecovery).toContainText(
          '自動再接続は、確立済みの SSH セッションが予期せず切断された後にのみ行われます。',
        );
        await page.locator('[data-settings-category="common"]').click();
        await expect(page.getByTestId('data-migration-deprecation')).toHaveCount(0);
        await expect(
          page.getByRole('region', { name: 'Axterm 設定スナップショット' }),
        ).toBeVisible();
        await expect(
          page.getByText(
            '接続、すべてのブックマークプロトコル、プロファイル、コマンド、カスタムテーマ、トリガー、設定を Axterm 独自形式でエクスポートします。',
          ),
        ).toBeVisible();
        await expect(
          page.getByRole('heading', { name: '起動、ファイル、アクセシビリティ' }),
        ).toBeVisible();
        await expect(
          page.getByPlaceholder('空欄のままにするとシステムの既定値を使用します'),
        ).toBeVisible();
        await page.getByRole('button', { name: 'ターミナルプロファイル' }).click();
        await expect(page.getByRole('region', { name: '接続プロファイル' })).toBeVisible();
        await expect(page.getByPlaceholder('検索')).toBeVisible();
        await expect(page.getByRole('region', { name: '接続プロファイル' })).toContainText(
          'プロトコル間でユーザー名と認証情報を再利用します。ブックマークではターミナルプロファイルと接続プロファイルを個別に選択できます。',
        );
        await page.locator('[data-activity-item="bookmarks"]').click();
        await expect(page.getByRole('heading', { name: 'ホストと接続' })).toBeVisible();
        const japaneseBookmarkTree = page.getByRole('region', { name: 'ブックマークツリー' });
        await expect(japaneseBookmarkTree).toBeVisible();
        await expect(
          japaneseBookmarkTree.getByRole('textbox', { name: 'ブックマークを検索' }),
        ).toBeVisible();
        await expect(page.getByPlaceholder('名前、アドレス、またはユーザーで検索')).toBeVisible();
        await expect(
          page.getByText('最初の SSH ホストを追加するか、SSH 設定をインポートしてください。'),
        ).toBeVisible();
        await page.getByRole('button', { name: 'ホストを追加' }).click();
        const japaneseHostDialog = page.getByRole('dialog', { name: 'SSH ホストを追加' });
        await expect(japaneseHostDialog).toBeVisible();
        await japaneseHostDialog.getByRole('tab', { name: '認証' }).click();
        await expect(
          japaneseHostDialog.getByText(
            'SSH の接続先と認証を設定します。保存した認証情報は Axterm のアプリケーションローカル Vault に保存されます。',
          ),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(japaneseHostDialog).toBeHidden();
        await page.getByRole('button', { name: 'FTP を追加' }).click();
        const japaneseFtpDialog = page.getByRole('dialog', {
          name: 'FTP/FTPS ブックマークを追加',
        });
        await expect(japaneseFtpDialog).toBeVisible();
        await expect(
          japaneseFtpDialog.getByText(
            'パスワードは Axterm のアプリケーションローカル認証情報ストアにのみ保存されます。ブックマークデータベースには参照だけが保存されます。',
          ),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(japaneseFtpDialog).toBeHidden();
        await openSettingsSync(page);
        await expect(page.getByTestId('legacy-sync-deprecation')).toHaveCount(0);
        await expect(page.getByRole('tablist', { name: '同期サービス' })).toBeVisible();
        await page.getByRole('tab', { name: 'Gitee Gist' }).click();
        await expect(
          page.getByText(
            'Gitee API のレート制限と ETag サポートは GitHub より弱いため、アップロード前にコンテンツバージョンを再比較します。',
          ),
        ).toBeVisible();
        await page.locator('.settings-workspace-close.right').click();
        await page.locator('.batch-input-trigger').click();
        const japaneseBatchInput = page.getByRole('region', { name: '一括入力パネル' });
        await expect(japaneseBatchInput).toContainText(
          '選択したターミナルへ一度に送信します。フォーカスは現在のターミナルに残ります。',
        );
        await expect(
          japaneseBatchInput.getByRole('textbox', { name: '一括コマンド' }),
        ).toHaveAttribute(
          'placeholder',
          'コマンドを入力してください。Enter で送信し、Shift+Enter で改行します',
        );
        await japaneseBatchInput.getByRole('button', { name: '一括入力を閉じる' }).click();
        await page.locator('[data-activity-item="setting"]').click();
        await page.locator('[data-settings-category="common"]').click();
      }
      if (locale.id === 'zh-TW') {
        await verifyAdvancedDiagnostics('進階診斷', '資料庫');
        await expect(
          page.getByText('導覽標籤支援全部 4 種語言；其他文案在沒有翻譯時會回退為英文。'),
        ).toBeVisible();
        await page.locator('[data-settings-category="shortcuts"]').click();
        await expect(page.getByRole('heading', { name: '快速鍵', exact: true })).toBeVisible();
        await expect(page.getByText('擷取實體按鍵組合。')).toBeVisible();
        await expect(page.getByRole('table', { name: '快速鍵動作登錄表' })).toBeVisible();
        await page.locator('[data-settings-category="common"]').click();
        await page.locator('[data-settings-category="terminal"]').click();
        await expect(page.getByPlaceholder('留空以使用平台預設 Shell')).toBeVisible();
        const traditionalChineseRecovery = page.locator('.terminal-recovery-settings-panel');
        await expect(
          traditionalChineseRecovery.getByRole('heading', {
            name: '終端機互動與復原',
            exact: true,
          }),
        ).toBeVisible();
        await expect(traditionalChineseRecovery).toContainText(
          '自動重新連線只會在已建立的 SSH 工作階段意外中斷後套用。',
        );
        await page.locator('[data-settings-category="common"]').click();
        await expect(page.getByTestId('data-migration-deprecation')).toHaveCount(0);
        await expect(page.getByRole('region', { name: 'Axterm 設定快照' })).toBeVisible();
        await expect(
          page.getByText(
            '以 Axterm 自有格式匯出連線、所有書籤協定、設定檔、命令、自訂主題、觸發器與設定。',
          ),
        ).toBeVisible();
        await expect(page.getByRole('heading', { name: '啟動、檔案與無障礙功能' })).toBeVisible();
        await expect(page.getByPlaceholder('留空以使用系統預設值')).toBeVisible();
        await page.getByRole('button', { name: '終端機設定檔' }).click();
        await expect(page.getByRole('region', { name: '連線設定檔' })).toBeVisible();
        await expect(page.getByPlaceholder('搜尋')).toBeVisible();
        await expect(page.getByRole('region', { name: '連線設定檔' })).toContainText(
          '在各協定間重複使用使用者名稱與憑證。書籤可以分別選取終端機和連線設定檔。',
        );
        await page.locator('[data-activity-item="bookmarks"]').click();
        await expect(page.getByRole('heading', { name: '主機與連線' })).toBeVisible();
        const traditionalChineseBookmarkTree = page.getByRole('region', { name: '書籤樹' });
        await expect(traditionalChineseBookmarkTree).toBeVisible();
        await expect(
          traditionalChineseBookmarkTree.getByRole('textbox', { name: '搜尋書籤' }),
        ).toBeVisible();
        await expect(page.getByPlaceholder('依名稱、位址或使用者搜尋')).toBeVisible();
        await expect(page.getByText('新增第一個 SSH 主機或匯入 SSH 設定。')).toBeVisible();
        await page.getByRole('button', { name: '新增主機' }).click();
        const traditionalChineseHostDialog = page.getByRole('dialog', { name: '新增 SSH 主機' });
        await expect(traditionalChineseHostDialog).toBeVisible();
        await traditionalChineseHostDialog.getByRole('tab', { name: '驗證' }).click();
        await expect(
          traditionalChineseHostDialog.getByText(
            '設定 SSH 目的地與驗證。已儲存的憑證會寫入 Axterm 的應用程式本機 Vault。',
          ),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(traditionalChineseHostDialog).toBeHidden();
        await page.getByRole('button', { name: '新增 FTP' }).click();
        const traditionalChineseFtpDialog = page.getByRole('dialog', {
          name: '新增 FTP/FTPS 書籤',
        });
        await expect(traditionalChineseFtpDialog).toBeVisible();
        await expect(
          traditionalChineseFtpDialog.getByText(
            '密碼只會保留在 Axterm 應用程式本機憑證存放區。書籤資料庫只會儲存參照。',
          ),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(traditionalChineseFtpDialog).toBeHidden();
        await openSettingsSync(page);
        await expect(page.getByTestId('legacy-sync-deprecation')).toHaveCount(0);
        await expect(page.getByRole('tablist', { name: '同步服務' })).toBeVisible();
        await page.getByRole('tab', { name: 'Gitee Gist' }).click();
        await expect(
          page.getByText(
            'Gitee API 的速率限制與 ETag 支援比 GitHub 弱。上傳前會再次比較內容版本。',
          ),
        ).toBeVisible();
        await page.locator('.settings-workspace-close.right').click();
        await page.locator('.batch-input-trigger').click();
        const traditionalChineseBatchInput = page.getByRole('region', { name: '批次輸入面板' });
        await expect(traditionalChineseBatchInput).toContainText(
          '一次傳送至選取的終端機；焦點會停留在目前終端機。',
        );
        await expect(
          traditionalChineseBatchInput.getByRole('textbox', { name: '批次命令' }),
        ).toHaveAttribute('placeholder', '輸入命令；Enter 傳送，Shift+Enter 新增一行');
        await traditionalChineseBatchInput.getByRole('button', { name: '關閉批次輸入' }).click();
        await page.locator('[data-activity-item="setting"]').click();
        await page.locator('[data-settings-category="common"]').click();
      }
      const alternate = locale.id === 'en' ? 'ja' : 'en';
      rejectSettingsSave = true;
      await page.getByTestId('application-language').selectOption(alternate);
      await expect(page.locator('.language-settings-panel [role="status"]')).toHaveText(
        languageSaveFailure[locale.id as (typeof packagedElectronLanguages)[number]],
      );
      await expect(page.getByTestId('application-language')).toHaveValue(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await expect(page.getByText('do-not-show-this-in-ui')).toHaveCount(0);
      rejectSettingsSave = false;

      const failure = settingsSaveFailure[locale.id as (typeof packagedElectronLanguages)[number]];
      const behavior = page.locator('.behavior-settings');
      const behaviorToggle = behavior.locator('label.check input[type="checkbox"]').first();
      const behaviorBefore = await behaviorToggle.isChecked();
      rejectSettingsSave = true;
      await behaviorToggle.click();
      await expect(behavior.getByRole('alert')).toHaveText(failure.behavior);
      await expect(behaviorToggle).toHaveJSProperty('checked', behaviorBefore);
      await expect(page.getByText('do-not-show-this-in-ui')).toHaveCount(0);
      rejectSettingsSave = false;
      await behaviorToggle.click();
      await expect(behaviorToggle).toHaveJSProperty('checked', !behaviorBefore);
      await expect(behavior.getByRole('alert')).toHaveCount(0);

      await page.locator('[data-settings-category="terminal"]').click();
      const recovery = page.locator('.terminal-recovery-settings-panel');
      const recoveryToggle = recovery.locator('label.check input[type="checkbox"]').first();
      const recoveryBefore = await recoveryToggle.isChecked();
      rejectSettingsSave = true;
      await recoveryToggle.click();
      await expect(recovery.getByRole('alert')).toHaveText(failure.terminal);
      await expect(recoveryToggle).toHaveJSProperty('checked', recoveryBefore);
      await expect(page.getByText('do-not-show-this-in-ui')).toHaveCount(0);
      rejectSettingsSave = false;
      await recoveryToggle.click();
      await expect(recoveryToggle).toHaveJSProperty('checked', !recoveryBefore);
      await expect(recovery.getByRole('alert')).toHaveCount(0);
      await page.locator('[data-settings-category="common"]').click();

      const tab = page.locator('.tab-preferences-panel');
      const tabToggle = tab.locator('label.check input[type="checkbox"]').first();
      const tabBefore = await tabToggle.isChecked();
      rejectSettingsSave = true;
      await tabToggle.click();
      await expect(tab.getByRole('alert')).toHaveText(failure.tab);
      await expect(tabToggle).toHaveJSProperty('checked', tabBefore);
      rejectSettingsSave = false;
      await tabToggle.click();
      await expect(tabToggle).toHaveJSProperty('checked', !tabBefore);
      await expect(tab.getByRole('alert')).toHaveCount(0);

      const proxy = page.locator('[aria-labelledby="proxy-settings-title"]');
      rejectSettingsSave = true;
      await proxy.locator('form button[value="save"]').click();
      await expect(proxy.getByRole('alert')).toHaveText(failure.proxy);
      await expect(page.getByText('do-not-show-this-in-ui')).toHaveCount(0);
      rejectSettingsSave = false;
      await proxy.locator('form button[value="save"]').click();
      await expect(proxy.getByRole('alert')).toHaveCount(0);

      const windowPanel = page.locator('[aria-labelledby="window-preferences-title"]');
      rejectWindowSave = true;
      await windowPanel.locator('form button[type="submit"]').click();
      await expect(windowPanel.getByRole('alert')).toHaveText(failure.windowSave);
      await expect(page.getByText('do-not-show-this-in-ui')).toHaveCount(0);
      rejectWindowSave = false;
      await windowPanel.locator('form button[type="submit"]').click();
      await expect(windowPanel.getByRole('alert')).toHaveCount(0);

      rejectWindowLoad = true;
      await page.locator('[data-settings-category="terminal"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await expect(windowPanel.getByRole('alert')).toHaveText(failure.windowLoad);
      await expect(page.getByText('do-not-show-this-in-ui')).toHaveCount(0);
      rejectWindowLoad = false;
      await windowPanel.getByRole('button').click();
      await expect(windowPanel.locator('form')).toBeVisible();
    }
    await page.getByTestId('application-language').selectOption('ja');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByTestId('application-language')).toHaveValue('ja');
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'localization-ja.png') });
    await page.locator('.settings-workspace-close.right').click();
    await page.locator('.workspace-tab.terminal-tab.active:visible').click();
    const japaneseTerminal = page.locator('.terminal-session-layer:not([hidden])');
    await japaneseTerminal
      .locator('.xterm-helper-textarea')
      .press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    await expect(japaneseTerminal.getByPlaceholder('ターミナル出力を検索')).toBeVisible();
    await japaneseTerminal.getByRole('button', { name: '検索を閉じる' }).click();
    await japaneseTerminal.locator('.xterm-screen').click({ button: 'right' });
    const japaneseTerminalMenu = page.getByRole('menu', { name: 'ターミナルメニュー' });
    await expect(japaneseTerminalMenu).toBeVisible();
    await expect(japaneseTerminalMenu.getByRole('menuitem', { name: 'AI で説明' })).toBeVisible();
    await expect(
      japaneseTerminalMenu.getByRole('menuitem', { name: 'XMODEM でファイルを送信' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(japaneseTerminalMenu).toBeHidden();
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    await page.getByTestId('application-language').selectOption('zh-TW');
    await page.locator('.settings-workspace-close.right').click();
    await page.locator('.workspace-tab.terminal-tab.active:visible').click();
    const traditionalChineseTerminal = page.locator('.terminal-session-layer:not([hidden])');
    await traditionalChineseTerminal
      .locator('.xterm-helper-textarea')
      .press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    await expect(traditionalChineseTerminal.getByPlaceholder('搜尋終端機輸出')).toBeVisible();
    await traditionalChineseTerminal.getByRole('button', { name: '關閉搜尋' }).click();
    await traditionalChineseTerminal.locator('.xterm-screen').click({ button: 'right' });
    const traditionalChineseTerminalMenu = page.getByRole('menu', { name: '終端機選單' });
    await expect(traditionalChineseTerminalMenu).toBeVisible();
    await expect(
      traditionalChineseTerminalMenu.getByRole('menuitem', { name: '使用 AI 說明' }),
    ).toBeVisible();
    await expect(
      traditionalChineseTerminalMenu.getByRole('menuitem', { name: '使用 XMODEM 傳送檔案' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(traditionalChineseTerminalMenu).toBeHidden();
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS keeps all four languages and Settings categories bounded at 200% zoom', async () => {
  test.skip(process.platform !== 'darwin', 'macOS first: native Windows/Linux review is separate');
  test.setTimeout(90_000);
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-settings-zoom-')));
  const artifact = join(directory, 'Axterm.app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const app = await electron.launch({
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: [`--user-data-dir=${join(directory, 'user-data')}`],
    cwd: directory,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([720, 450]);
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const language = page.getByTestId('application-language');
    for (const locale of packagedElectronLanguages) {
      await language.selectOption(locale);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      for (const category of [
        'common',
        'terminal',
        'shortcuts',
        'sync',
        'ai',
        'password',
        'legal',
      ] as const) {
        const button = page.locator(`[data-settings-category="${category}"]`);
        await button.click();
        await expect(button).toHaveAttribute('aria-current', 'page');
        const content = page.locator(`.settings-item-${category} .panel-page`);
        await expect(content).toBeVisible();
        if (category === 'legal') {
          const summary = content.locator('summary', {
            hasText: 'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
          });
          await summary.click();
          await expect(summary.locator('..')).toHaveAttribute('open', '');
        }
        const widths = await content.evaluate((element) => ({
          content: element.clientWidth,
          scroll: element.scrollWidth,
          document: document.documentElement.scrollWidth,
          viewport: globalThis.innerWidth,
        }));
        expect(widths.scroll, `${locale}/${category} content overflow`).toBeLessThanOrEqual(
          widths.content + 1,
        );
        expect(widths.document, `${locale}/${category} document overflow`).toBeLessThanOrEqual(
          widths.viewport + 1,
        );
      }
      await page.locator('[data-settings-category="common"]').click();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged upgrade migrates a retired language to English and preserves its database backup', async () => {
  test.setTimeout(90_000);
  await access(source);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'axterm-packaged-retired-language-')),
  );
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const userData = join(directory, 'user-data');
  const dataDirectory = join(userData, 'data-v2');
  const databasePath = join(dataDirectory, 'axterm.sqlite');
  try {
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    await mkdir(dataDirectory, { recursive: true });
    const seededDatabase = await ProductDatabase.open(databasePath);
    seededDatabase.run(
      "UPDATE app_settings SET payload = json_set(payload, '$.language', 'de') WHERE section = 'appearance'",
    );
    seededDatabase.run("DELETE FROM app_meta WHERE key = 'migration:38'");
    seededDatabase.close();

    const executablePath =
      process.platform === 'darwin'
        ? join(artifact, 'Contents/MacOS/Axterm')
        : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
    const app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      const language = page.getByTestId('application-language');
      await expect(language.locator('option')).toHaveCount(4);
      await expect(language).toHaveValue('en');
    } finally {
      await app.close().catch(() => {});
    }

    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const setting = migratedDatabase
        .prepare("SELECT payload FROM app_settings WHERE section = 'appearance'")
        .get() as { payload: string };
      expect(JSON.parse(setting.payload)).toMatchObject({ language: 'en' });
      expect(
        migratedDatabase.prepare("SELECT value FROM app_meta WHERE key = 'migration:38'").get(),
      ).toBeDefined();
    } finally {
      migratedDatabase.close();
    }

    const backups = (await readdir(dataDirectory)).filter((entry) =>
      entry.startsWith('axterm.sqlite.pre-migration-38.bak'),
    );
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(dataDirectory, backups[0]!), { readOnly: true });
    try {
      const setting = backup
        .prepare("SELECT payload FROM app_settings WHERE section = 'appearance'")
        .get() as { payload: string };
      expect(JSON.parse(setting.payload)).toMatchObject({ language: 'de' });
    } finally {
      backup.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS configuration import rolls back a late failure without losing data or Vault secrets', async () => {
  test.skip(process.platform !== 'darwin', 'The D3 engineering cell uses the macOS app');
  test.setTimeout(120_000);
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-d3-import-')));
  const artifact = join(directory, 'Axterm.app');
  const userData = join(directory, 'user-data');
  const databasePath = join(userData, 'data-v2', 'axterm.sqlite');
  const vaultDirectory = join(userData, 'vault-v2');
  const importPath = join(directory, 'axterm-configuration-import.json');
  const existingSecret = 'D3_EXISTING_VAULT_SECRET';
  try {
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    const sourceDatabase = await ProductDatabase.open(join(directory, 'incoming.sqlite'));
    let incomingHost: ReturnType<ProductRepository['createHost']>;
    let incomingBookmark: ReturnType<BookmarkRepository['createBookmark']>['bookmarks'][number];
    try {
      incomingHost = new ProductRepository(sourceDatabase).createHost(
        createHostSchema.parse({
          name: 'D3 incoming Host',
          hostname: 'incoming.example.test',
          username: 'operator',
        }),
      );
      const bookmarks = new BookmarkRepository(sourceDatabase);
      const created = bookmarks.createBookmark(
        createBookmarkSchema.parse({
          protocol: 'ssh',
          hostId: incomingHost.id,
          title: 'D3 incoming bookmark',
        }),
        bookmarks.snapshot().etag,
      );
      incomingBookmark = created.bookmarks.find(({ title }) => title === 'D3 incoming bookmark')!;
    } finally {
      sourceDatabase.close();
    }
    const vault = new CredentialVault(vaultDirectory);
    await vault.open();
    const existingCredential = await vault.put({
      kind: 'sshPassword',
      label: 'D3 existing Host',
      secret: existingSecret,
    });
    vault.close();
    await mkdir(join(userData, 'data-v2'), { recursive: true });
    const seeded = await ProductDatabase.open(databasePath);
    try {
      new ProductRepository(seeded).createHost({
        name: 'D3 existing Host',
        hostname: 'preserved.example.test',
        username: 'preserved',
        authType: 'password',
        credentialRef: existingCredential.ref,
      });
      seeded.run(`CREATE TRIGGER d3_fail_import
        BEFORE INSERT ON bookmarks
        BEGIN SELECT RAISE(ABORT, 'synthetic D3 late import failure'); END`);
    } finally {
      seeded.close();
    }
    const vaultBefore = await vaultFileHashes(vaultDirectory);
    const executablePath = join(artifact, 'Contents/MacOS/Axterm');
    const exportApp = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
    });
    try {
      await exportApp.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
      }, importPath);
      const page = await exportApp.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      const panel = page.getByLabel('Axterm 配置快照');
      await panel.getByRole('button', { name: '导出 Axterm 配置' }).click();
      await expect(panel.getByText('Axterm 配置已导出', { exact: true })).toBeVisible();
    } finally {
      await exportApp.close().catch(() => {});
    }
    const importDocument = JSON.parse(await readFile(importPath, 'utf8')) as {
      data: { hosts: unknown[]; bookmarks: unknown[] };
    };
    importDocument.data.hosts = [incomingHost];
    importDocument.data.bookmarks = [incomingBookmark];
    await writeFile(importPath, JSON.stringify(importDocument), 'utf8');
    const runImport = async (expectSuccess: boolean) => {
      const app = await electron.launch({
        executablePath,
        args: [`--user-data-dir=${userData}`],
        cwd: directory,
        env: { ...process.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
      });
      try {
        await app.evaluate(({ dialog }, path) => {
          dialog.showOpenDialog = (() =>
            Promise.resolve({
              canceled: false,
              filePaths: [path],
            })) as typeof dialog.showOpenDialog;
        }, importPath);
        const page = await app.firstWindow();
        await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
        await page.locator('[data-activity-item="setting"]').click();
        await page.locator('[data-settings-category="common"]').click();
        const panel = page.getByLabel('Axterm 配置快照');
        await panel.getByRole('button', { name: '导入 Axterm 配置' }).click();
        await expect(panel.locator('.axterm-config-preview')).toBeVisible();
        await expect(panel.locator('.data-migration-metric.create strong')).not.toHaveText('0');
        await panel.locator('.data-migration-commit button.primary').click();
        if (expectSuccess) {
          await expect(panel.getByText('Axterm 配置已导入', { exact: true })).toBeVisible();
          await expect(panel.locator('.data-migration-error')).toHaveCount(0);
        } else {
          await expect(panel.locator('.data-migration-error')).toBeVisible();
          await expect(panel.getByText('Axterm 配置已导入', { exact: true })).toHaveCount(0);
          expect(await page.locator('body').innerText()).not.toContain(existingSecret);
        }
      } finally {
        await app.close().catch(() => {});
      }
    };

    await runImport(false);
    const failed = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(failed.prepare('SELECT name, credential_ref FROM hosts').all()).toEqual([
        { name: 'D3 existing Host', credential_ref: existingCredential.ref },
      ]);
      expect(failed.prepare('SELECT COUNT(*) AS count FROM bookmark_groups').get()).toEqual({
        count: 0,
      });
      expect(failed.prepare('SELECT COUNT(*) AS count FROM bookmarks').get()).toEqual({ count: 0 });
      expect(failed.prepare('SELECT COUNT(*) AS count FROM connection_profiles').get()).toEqual({
        count: 0,
      });
    } finally {
      failed.close();
    }
    expect(await vaultFileHashes(vaultDirectory)).toEqual(vaultBefore);
    const preservedVault = new CredentialVault(vaultDirectory);
    await preservedVault.open();
    expect(await preservedVault.get(existingCredential.ref)).toBe(existingSecret);
    preservedVault.close();
    expect((await readFile(databasePath)).includes(Buffer.from(existingSecret))).toBe(false);

    const repair = new DatabaseSync(databasePath);
    repair.exec('DROP TRIGGER d3_fail_import');
    repair.close();
    await runImport(true);
    const recovered = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(recovered.prepare('SELECT COUNT(*) AS count FROM hosts').get()).toEqual({ count: 2 });
      expect(recovered.prepare('SELECT COUNT(*) AS count FROM bookmarks').get()).toEqual({
        count: 1,
      });
      expect(recovered.prepare('SELECT name FROM hosts ORDER BY name').all()).toEqual([
        { name: 'D3 existing Host' },
        { name: 'D3 incoming Host' },
      ]);
    } finally {
      recovered.close();
    }
    const recoveredVault = new CredentialVault(vaultDirectory);
    await recoveredVault.open();
    expect(await recoveredVault.get(existingCredential.ref)).toBe(existingSecret);
    recoveredVault.close();
    const configuration = await readFile(importPath, 'utf8');
    expect(JSON.parse(configuration)).toMatchObject({
      format: 'axterm-configuration',
      formatVersion: 1,
      vaultSecretValues: 'omitted',
    });
    expect(configuration).toContain('D3 incoming bookmark');
    expect(configuration).not.toContain(existingSecret);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged app rejects the frozen retired portable file and preserves existing local rows', async () => {
  test.setTimeout(90_000);
  await access(source);
  const fixturePath = resolve(
    'tests/fixtures/migration/historical-axterm-portable-v2-657b3cc.json',
  );
  const raw = await readFile(fixturePath, 'utf8');
  expect(sha256(Buffer.from(raw))).toBe(
    '250a533d009e2b62ccc3723425584f9fad90efe9849b60ea41e2dcb583f3c0dc',
  );
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-frozen-portable-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const userData = join(directory, 'user-data');
  try {
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    await mkdir(join(userData, 'data-v2'), { recursive: true });
    const seeded = await ProductDatabase.open(join(userData, 'data-v2', 'axterm.sqlite'));
    let preservedHostId: string;
    try {
      preservedHostId = new ProductRepository(seeded).createHost({
        name: 'Preserved local host',
        hostname: 'preserved.example.test',
        port: 2222,
        username: 'operator',
        authType: 'agent',
        sshAgent: { enabled: false, path: null },
      }).id;
    } finally {
      seeded.close();
    }
    const executablePath =
      process.platform === 'darwin'
        ? join(artifact, 'Contents/MacOS/Axterm')
        : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
    const app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    try {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      }, fixturePath);
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await expect(page.getByLabel('Legacy Prototype 数据迁移')).toHaveCount(0);
      const panel = page.getByLabel('Axterm 配置快照');
      await panel.getByRole('button', { name: '导入 Axterm 配置' }).click();
      await expect(panel.getByRole('alert')).toBeVisible();
      await expect(panel.locator('.axterm-config-preview')).toHaveCount(0);
    } finally {
      await app.close().catch(() => {});
    }

    const database = new DatabaseSync(join(userData, 'data-v2', 'axterm.sqlite'), {
      readOnly: true,
    });
    try {
      expect(
        database.prepare("SELECT id, hostname FROM hosts WHERE name='Preserved local host'").get(),
      ).toEqual({ id: preservedHostId, hostname: 'preserved.example.test' });
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%import_entries%'",
          )
          .all(),
      ).toEqual([{ name: 'axterm_configuration_import_entries' }]);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM bookmark_groups WHERE name='Historical package group'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
    expect(
      (await readdir(join(userData, 'vault-v2'))).filter((name) => name.endsWith('.bin')),
    ).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged app leaves the previous local data profile byte-for-byte inert', async () => {
  test.setTimeout(90_000);
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-retired-sync-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  const userData = join(directory, 'user-data');
  const databasePath = join(userData, 'data', 'axterm.sqlite');
  const oldVaultDirectory = join(userData, 'vault');
  let requests = 0;
  const remote = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolveListen) => remote.listen(0, '127.0.0.1', resolveListen));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('Missing mock remote port');
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    await mkdir(join(userData, 'data'), { recursive: true });
    const oldVault = new CredentialVault(oldVaultDirectory);
    await oldVault.open();
    const oldCredential = await oldVault.put({
      kind: 'syncAccessToken',
      label: 'Previous profile secret',
      secret: 'previous-profile-secret',
    });
    oldVault.close();
    const oldVaultBefore = await vaultFileHashes(oldVaultDirectory);
    const seeded = await ProductDatabase.open(databasePath);
    let profileId: string;
    let before: Record<string, unknown>;
    try {
      profileId = new SyncProfileRepository(seeded).create({
        provider: 'webdav',
        name: 'Preserved retired WebDAV',
        endpointUrl: `http://127.0.0.1:${address.port}/storage/`,
        remoteId: 'retired.json',
        username: 'operator',
        accessCredentialRef: oldCredential.ref,
        encryptionCredentialRef: null,
        selectedCategories: ['settings'],
        autoSyncEnabled: true,
        autoSyncIntervalMinutes: 1,
        autoSyncDirection: 'upload',
      }).id;
      before = seeded.get<Record<string, unknown>>(
        'SELECT * FROM sync_profiles WHERE id=?',
        profileId,
      )!;
    } finally {
      seeded.close();
    }
    const oldDatabaseBefore = await fileSha256(databasePath);
    const executablePath =
      process.platform === 'darwin'
        ? join(artifact, 'Contents/MacOS/Axterm')
        : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="sync"]').click();
    const panel = page.getByRole('region', { name: '设置同步' });
    await expect(panel).toBeVisible();
    await expect(panel).not.toContainText('Preserved retired WebDAV');
    await expect(page.getByTestId('legacy-sync-deprecation')).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(requests).toBe(0);
    expect(await fileSha256(databasePath)).toBe(oldDatabaseBefore);
    expect(await vaultFileHashes(oldVaultDirectory)).toEqual(oldVaultBefore);
    expect(
      (await readdir(join(userData, 'vault-v2'))).filter((name) => name.endsWith('.bin')),
    ).toEqual([]);
    await app.close();
    app = undefined;
    const persisted = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(persisted.prepare('SELECT * FROM sync_profiles WHERE id=?').get(profileId)).toEqual(
        before,
      );
    } finally {
      persisted.close();
    }
    expect(requests).toBe(0);
  } finally {
    await app?.close().catch(() => {});
    await new Promise<void>((resolveClose) => remote.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('current Mac package rejects a portable file produced by the preserved Axoterm package', async () => {
  test.skip(
    process.platform !== 'darwin' || !previousAxotermSource,
    'Set AXTERM_PREVIOUS_AXOTERM_APP on macOS',
  );
  test.setTimeout(180_000);
  await access(previousAxotermSource);
  await access(source);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-retired-portable-')));
  const oldArtifact = join(directory, 'Axoterm.app');
  const currentArtifact = join(directory, 'Axterm.app');
  const oldUserData = join(directory, 'old-user-data');
  const coldBackup = join(directory, 'old-cold-backup');
  const currentUserData = join(directory, 'current-user-data');
  const portableFile = join(directory, 'axoterm-portable.json');
  const oldHostName = 'retired-portable-synthetic-host';
  const oldSecret = 'RETIRED_AXOTERM_SYNTHETIC_SECRET';
  const currentSecret = 'CURRENT_AXTERM_SYNTHETIC_SECRET';
  const launchEnvironment = {
    ...process.env,
    ELECTRON_RENDERER_URL: '',
    PATH: '/usr/bin:/bin',
  };

  try {
    await Promise.all([
      cp(previousAxotermSource, oldArtifact, { recursive: true, verbatimSymlinks: true }),
      cp(source, currentArtifact, { recursive: true, verbatimSymlinks: true }),
    ]);
    const oldApp = await electron.launch({
      executablePath: join(oldArtifact, 'Contents/MacOS/Axoterm'),
      args: [`--user-data-dir=${oldUserData}`],
      cwd: directory,
      env: launchEnvironment,
    });
    try {
      const page = await oldApp.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await page.getByRole('button', { name: '添加主机' }).click();
      await page.locator('input[name="name"]').fill(oldHostName);
      await page.locator('input[name="hostname"]').fill('old.example.test');
      await page.locator('input[name="username"]').fill('synthetic-user');
      await page.locator('input[name="password"]').fill(oldSecret);
      await page.getByRole('button', { name: '保存', exact: true }).last().click();
      await expect(page.getByText(oldHostName, { exact: true })).toBeVisible();
      await oldApp.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
      }, portableFile);
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByRole('button', { name: '导出数据' }).click();
      await expect(page.getByText('数据已导出', { exact: true })).toBeVisible();
    } finally {
      await oldApp.close().catch(() => {});
    }

    const portableBytes = await readFile(portableFile);
    expect(JSON.parse(portableBytes.toString('utf8'))).toMatchObject({
      _axoterm: { formatVersion: expect.any(Number) },
      bookmarks: expect.arrayContaining([expect.objectContaining({ title: oldHostName })]),
    });
    expect(portableBytes.includes(Buffer.from(oldSecret))).toBe(false);
    const oldDatabasePath = join(oldUserData, 'data', 'axoterm.sqlite');
    const oldDatabaseHash = await fileSha256(oldDatabasePath);
    const oldVaultHashes = await vaultFileHashes(join(oldUserData, 'vault'));
    await cp(oldUserData, coldBackup, { recursive: true, verbatimSymlinks: true });
    expect(await fileSha256(join(coldBackup, 'data', 'axoterm.sqlite'))).toBe(oldDatabaseHash);
    expect(await vaultFileHashes(join(coldBackup, 'vault'))).toEqual(oldVaultHashes);

    const currentVaultDirectory = join(currentUserData, 'vault-v2');
    const currentVault = new CredentialVault(currentVaultDirectory);
    await currentVault.open();
    const existingCredential = await currentVault.put({
      kind: 'sshPassword',
      label: 'Existing current Host',
      secret: currentSecret,
    });
    currentVault.close();
    await mkdir(join(currentUserData, 'data-v2'), { recursive: true });
    const seeded = await ProductDatabase.open(join(currentUserData, 'data-v2', 'axterm.sqlite'));
    try {
      new ProductRepository(seeded).createHost({
        name: 'Existing current Host',
        hostname: 'current.example.test',
        username: 'operator',
        authType: 'password',
        credentialRef: existingCredential.ref,
      });
    } finally {
      seeded.close();
    }
    const currentVaultHashes = await vaultFileHashes(currentVaultDirectory);

    const currentApp = await electron.launch({
      executablePath: join(currentArtifact, 'Contents/MacOS/Axterm'),
      args: [`--user-data-dir=${currentUserData}`],
      cwd: directory,
      env: launchEnvironment,
    });
    try {
      await currentApp.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      }, portableFile);
      const page = await currentApp.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await expect(page.getByLabel('Legacy Prototype 数据迁移')).toHaveCount(0);
      const configuration = page.getByLabel('Axterm 配置快照');
      await configuration.getByRole('button', { name: '导入 Axterm 配置' }).click();
      await expect(configuration.getByRole('alert')).toBeVisible();
      await expect(configuration.locator('.axterm-config-preview')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toContain(oldSecret);
      expect(await page.locator('body').innerText()).not.toContain(currentSecret);
    } finally {
      await currentApp.close().catch(() => {});
    }

    const currentDatabase = await ProductDatabase.open(
      join(currentUserData, 'data-v2', 'axterm.sqlite'),
    );
    try {
      expect(new ProductRepository(currentDatabase).listHosts()).toMatchObject([
        {
          name: 'Existing current Host',
          hostname: 'current.example.test',
          credentialRef: existingCredential.ref,
        },
      ]);
      expect(new BookmarkRepository(currentDatabase).snapshot().bookmarks).toEqual([]);
    } finally {
      currentDatabase.close();
    }
    expect(await vaultFileHashes(currentVaultDirectory)).toEqual(currentVaultHashes);
    const reopenedVault = new CredentialVault(currentVaultDirectory);
    await reopenedVault.open();
    expect(await reopenedVault.get(existingCredential.ref)).toBe(currentSecret);
    reopenedVault.close();
    expect(await fileSha256(oldDatabasePath)).toBe(oldDatabaseHash);
    expect(await vaultFileHashes(join(oldUserData, 'vault'))).toEqual(oldVaultHashes);
    expect(await readFile(portableFile)).toEqual(portableBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('current packaged app upgrades data produced by a historical packaged release', async () => {
  test.skip(
    !previousPackagedSource,
    'Set AXTERM_PREVIOUS_PACKAGED_APP to a preserved historical package',
  );
  test.setTimeout(240_000);
  await access(source);
  await access(previousPackagedSource);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-historical-upgrade-')));
  const previousContainer = join(directory, 'previous');
  const currentContainer = join(directory, 'current');
  const artifactName = process.platform === 'darwin' ? 'Axterm.app' : 'app';
  const previousArtifact = join(previousContainer, artifactName);
  const currentArtifact = join(currentContainer, artifactName);
  const executableFor = (artifact: string) =>
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const asarFor = (artifact: string) =>
    process.platform === 'darwin'
      ? join(artifact, 'Contents/Resources/app.asar')
      : join(artifact, 'resources/app.asar');
  const launchEnvironment = {
    ...process.env,
    ELECTRON_RENDERER_URL: '',
    PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
  };
  const userData = join(directory, 'user-data');
  const portableImportUserData = join(directory, 'portable-import-user-data');
  const upgradedConfigurationUserData = join(directory, 'upgraded-configuration-user-data');
  const historicalExportPath = join(directory, 'historical-portable-export.json');
  const upgradedConfigurationPath = join(directory, 'upgraded-axterm-configuration.json');
  const databasePath = join(userData, 'data-v2', 'axterm.sqlite');
  const vaultDirectory = join(userData, 'vault-v2');
  const fixturePassword = 'historical-package-fixture-password';
  const syncAccessSecret = 'historical-package-sync-access-secret';
  const syncEncryptionSecret = 'historical-package-sync-encryption-secret';
  const syncUsername = 'historical-sync-user';
  const syncRemoteId = 'historical-desktop.json';
  const plaintextSyncRemoteId = 'historical-desktop-plaintext.json';
  const historicalThemeId = '00000000-0000-4000-8000-000000000003';
  const migratedThemeId = '00000000-0000-4000-8000-000000000001';
  const historicalCustomThemeName = 'Historical user theme';
  const emptyHistoricalRemote = () => ({
    contents: null as string | null,
    etag: null as string | null,
    reads: 0,
    writes: 0,
    lastAuthorization: null as string | null,
  });
  const historicalRemote = emptyHistoricalRemote();
  const historicalPlaintextRemote = emptyHistoricalRemote();
  const expectedSyncAuthorization = `Basic ${Buffer.from(
    `${syncUsername}:${syncAccessSecret}`,
  ).toString('base64')}`;
  const historicalSyncServer = createServer(async (request, response) => {
    const authorization = request.headers.authorization ?? null;
    if (authorization !== expectedSyncAuthorization) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === '/storage/legacy-prototype/' && request.method === 'MKCOL') {
      response.writeHead(201).end();
      return;
    }
    const activeRemote =
      request.url === `/storage/legacy-prototype/${syncRemoteId}`
        ? historicalRemote
        : request.url === `/storage/legacy-prototype/${plaintextSyncRemoteId}`
          ? historicalPlaintextRemote
          : undefined;
    if (!activeRemote) {
      response.writeHead(404).end();
      return;
    }
    activeRemote.lastAuthorization = authorization;
    if (request.method === 'GET') {
      activeRemote.reads += 1;
      if (activeRemote.contents === null) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
        ETag: activeRemote.etag!,
      });
      response.end(activeRemote.contents);
      return;
    }
    if (request.method !== 'PUT') {
      response.writeHead(405).end();
      return;
    }
    if (
      (activeRemote.etag && request.headers['if-match'] !== activeRemote.etag) ||
      (!activeRemote.etag && request.headers['if-none-match'] !== '*')
    ) {
      response.writeHead(412).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    activeRemote.contents = Buffer.concat(chunks).toString('utf8');
    activeRemote.writes += 1;
    activeRemote.etag = `"historical-r${activeRemote.writes}"`;
    response.writeHead(204, { ETag: activeRemote.etag }).end();
  });
  historicalSyncServer.listen(0, '127.0.0.1');
  await once(historicalSyncServer, 'listening');
  const historicalSyncAddress = historicalSyncServer.address();
  if (!historicalSyncAddress || typeof historicalSyncAddress === 'string')
    throw new Error('Historical package WebDAV fixture did not bind');
  const historicalSyncEndpoint = `http://127.0.0.1:${historicalSyncAddress.port}/storage/`;
  const terminalThemeId = (database: DatabaseSync) => {
    const settings = database
      .prepare("SELECT payload FROM app_settings WHERE section = 'terminal'")
      .get() as { payload: string } | undefined;
    const payload = JSON.parse(settings?.payload ?? '{}') as {
      visual?: { themeId?: unknown };
    };
    return payload.visual?.themeId;
  };
  const historicalLinkedRows = (database: DatabaseSync) => {
    const group = database
      .prepare("SELECT id, name FROM bookmark_groups WHERE name='Historical package group'")
      .get() as { id: string; name: string } | undefined;
    const profile = database
      .prepare(
        "SELECT id, name, payload FROM connection_profiles WHERE name='Historical package identity'",
      )
      .get() as { id: string; name: string; payload: string } | undefined;
    if (!group || !profile) throw new Error('Historical group/Profile was not preserved');
    return {
      group: { id: group.id, name: group.name },
      profile: { id: profile.id, name: profile.name, payload: profile.payload },
      bookmarks: database
        .prepare(
          `SELECT title, group_id, connection_profile_id FROM bookmarks
           WHERE title IN ('historical-package-host','historical-profile-host') ORDER BY title`,
        )
        .all(),
    };
  };

  try {
    await Promise.all([
      mkdir(previousContainer, { recursive: true }),
      mkdir(currentContainer, { recursive: true }),
    ]);
    await Promise.all([
      cp(previousPackagedSource, previousArtifact, {
        recursive: true,
        verbatimSymlinks: true,
      }),
      cp(source, currentArtifact, { recursive: true, verbatimSymlinks: true }),
    ]);

    const previousApp = await electron.launch({
      executablePath: executableFor(previousArtifact),
      args: [`--user-data-dir=${userData}`],
      cwd: previousContainer,
      env: launchEnvironment,
    });
    let previousVersion = '';
    try {
      const page = await previousApp.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      previousVersion = await previousApp.evaluate(({ app }) => app.getVersion());
      expect(previousVersion).toBe('0.10.0');
      expect(await previousApp.evaluate(({ app }) => app.isPackaged)).toBe(true);

      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await page.getByRole('button', { name: '新建顶级分组' }).click();
      const groupDialog = page.getByRole('dialog', { name: '新建分组' });
      await groupDialog.getByLabel('分组名称').fill('Historical package group');
      await groupDialog.getByRole('button', { name: '创建' }).click();
      await expect(page.getByRole('treeitem', { name: 'Historical package group' })).toBeVisible();
      await page.getByRole('button', { name: '添加主机' }).click();
      const directHostDialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
      await directHostDialog.getByLabel('显示名称').fill('historical-package-host');
      await directHostDialog.getByLabel('主机地址').fill('127.0.0.1');
      await directHostDialog.getByLabel('用户名').fill('historical-user');
      await directHostDialog.getByLabel('密码', { exact: true }).fill(fixturePassword);
      await directHostDialog.getByRole('tab', { name: '设置' }).click();
      await directHostDialog
        .getByLabel('分组', { exact: true })
        .selectOption({ label: 'Historical package group' });
      await directHostDialog.getByRole('button', { name: '保存', exact: true }).click();
      await expect(
        page.locator('.host-card').getByText('historical-package-host', { exact: true }),
      ).toBeVisible();

      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="terminal"]').click();
      await page.getByRole('tab', { name: /Profiles|配置文件/u }).click();
      const profileForm = page.getByTestId('connection-profile-form');
      await profileForm.getByLabel('Profile 名称').fill('Historical package identity');
      await profileForm.locator('input[name="ssh.username"]').fill('historical-profile-user');
      await profileForm.getByRole('button', { name: '保存 Profile' }).click();
      await expect(page.getByText('连接 Profile 已保存。')).toBeVisible();

      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await page.getByRole('button', { name: '添加主机' }).click();
      const profileHostDialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
      await profileHostDialog.getByLabel('显示名称').fill('historical-profile-host');
      await profileHostDialog.getByLabel('主机地址').fill('profile.example.test');
      await profileHostDialog.getByLabel('用户名', { exact: true }).fill('fallback-user');
      await profileHostDialog
        .getByRole('group', { name: 'SSH 认证类型' })
        .getByRole('button', { name: 'Profiles', exact: true })
        .click();
      await profileHostDialog
        .getByLabel('连接 Profile')
        .selectOption({ label: 'Historical package identity（默认）' });
      await profileHostDialog.getByRole('tab', { name: '设置' }).click();
      await profileHostDialog
        .getByLabel('分组', { exact: true })
        .selectOption({ label: 'Historical package group' });
      await profileHostDialog.getByRole('button', { name: '保存', exact: true }).click();
      await expect(
        page.locator('.host-card').getByText('historical-profile-host', { exact: true }),
      ).toBeVisible();

      await page
        .locator('.app-sidebar nav')
        .getByRole('button', { name: /^快捷命令/ })
        .click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '打开工作区' }).click();
      const commands = page.getByTestId('quick-command-workspace');
      await commands
        .locator('.quick-command-toolbar')
        .getByRole('button', { name: '新建快捷命令', exact: true })
        .click();
      const editor = commands.locator('.quick-command-form');
      await editor.getByLabel('名称', { exact: true }).fill('Historical package command');
      await editor.getByLabel('步骤 1 命令').fill('uptime');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await expect(
        commands
          .locator('.quick-command-tree-row')
          .filter({ hasText: 'Historical package command' }),
      ).toBeVisible();

      await page.locator('[data-activity-item="terminalThemes"]').click();
      const themeWorkspace = page.locator('.terminal-theme-workspace');
      const themeList = page.getByRole('complementary', { name: '终端主题列表' });
      await themeWorkspace.getByLabel('主题应用范围').selectOption('global');
      await themeList.getByLabel('搜索终端主题').fill('3024 Day');
      await themeList.getByRole('button', { name: /3024 Day.*内建/ }).click();
      await themeWorkspace.getByRole('button', { name: /^(Apply|应用)$/ }).click();
      await expect(themeWorkspace.getByText('主题与背景已设为全局默认。')).toBeVisible();
      await themeList.getByLabel('搜索终端主题').fill('');
      await themeList.locator('.terminal-theme-list-item.new').click();
      await themeWorkspace.getByLabel('主题名称').fill(historicalCustomThemeName);
      await themeWorkspace.getByRole('button', { name: '保存', exact: true }).click();
      await expect(themeWorkspace.getByText('主题已保存。')).toBeVisible();
      await expect(
        themeList.getByRole('button', { name: historicalCustomThemeName }),
      ).toBeVisible();

      await page.locator('[data-activity-item="setting"]').click();
      await page
        .getByRole('complementary', { name: '设置项目' })
        .locator('[data-settings-category="sync"]')
        .click();
      const syncPanel = page.getByRole('region', { name: '设置同步' });
      await syncPanel.getByRole('tab', { name: 'WebDAV' }).click();
      await syncPanel.getByLabel('配置名称').fill('Historical package WebDAV');
      await syncPanel.getByLabel('服务地址').fill(historicalSyncEndpoint);
      await syncPanel.getByLabel('远程文件名').fill(syncRemoteId);
      await syncPanel.getByLabel('用户名').fill(syncUsername);
      await syncPanel.getByLabel('WebDAV 密码').fill(syncAccessSecret);
      await syncPanel.getByLabel('同步加密密码').fill(syncEncryptionSecret);
      await syncPanel.getByLabel('上传前使用本地密码加密同步文件').check();
      await syncPanel.getByRole('button', { name: '保存配置' }).click();
      await expect(
        syncPanel.getByText('同步配置已保存；凭据只保存在应用本地 Vault。'),
      ).toBeVisible();
      await syncPanel.getByRole('button', { name: '上传', exact: true }).click();
      await expect(syncPanel.getByText('所选分类已上传。')).toBeVisible();
      await expect.poll(() => historicalRemote.contents).not.toBeNull();

      await syncPanel.getByLabel('远程文件名').fill(plaintextSyncRemoteId);
      await syncPanel.getByLabel('上传前使用本地密码加密同步文件').uncheck();
      await syncPanel.getByRole('button', { name: '保存配置' }).click();
      await expect(
        syncPanel.getByText('同步配置已保存；凭据只保存在应用本地 Vault。'),
      ).toBeVisible();
      await syncPanel.getByRole('button', { name: '上传', exact: true }).click();
      await expect.poll(() => historicalPlaintextRemote.contents).not.toBeNull();

      await syncPanel.getByLabel('远程文件名').fill(syncRemoteId);
      await syncPanel.getByLabel('同步加密密码').fill(syncEncryptionSecret);
      await syncPanel.getByLabel('上传前使用本地密码加密同步文件').check();
      await syncPanel.getByRole('button', { name: '保存配置' }).click();
      await expect(
        syncPanel.getByText('同步配置已保存；凭据只保存在应用本地 Vault。'),
      ).toBeVisible();
      await previousApp.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
      }, historicalExportPath);
      await page.locator('[data-settings-category="common"]').click();
      const historicalDataPanel = page.getByLabel('Legacy Prototype 数据迁移');
      await historicalDataPanel.getByRole('button', { name: '导出数据' }).click();
      await expect(historicalDataPanel.getByText('数据已导出', { exact: true })).toBeVisible();
    } finally {
      await previousApp.close().catch(() => {});
    }

    const historicalExport = await readFile(historicalExportPath, 'utf8');
    expect(JSON.parse(historicalExport)).toMatchObject({
      bookmarks: expect.arrayContaining([
        expect.objectContaining({ title: 'historical-package-host' }),
        expect.objectContaining({ title: 'historical-profile-host' }),
      ]),
      _axterm: expect.objectContaining({ formatVersion: 2, credentials: 'omitted' }),
    });
    for (const secret of [fixturePassword, syncAccessSecret, syncEncryptionSecret])
      expect(historicalExport).not.toContain(secret);

    const historicalRemoteDocument = historicalRemote.contents;
    const historicalPlaintextDocument = historicalPlaintextRemote.contents;
    if (!historicalRemoteDocument || !historicalPlaintextDocument)
      throw new Error('Historical package did not publish both WebDAV documents');
    expect(historicalRemote.writes).toBe(1);
    expect(historicalPlaintextRemote.writes).toBe(1);
    const encryptedReadsBefore = historicalRemote.reads;
    const plaintextReadsBefore = historicalPlaintextRemote.reads;
    const encryptedRemoteHash = sha256(Buffer.from(historicalRemoteDocument));
    const plaintextRemoteHash = sha256(Buffer.from(historicalPlaintextDocument));

    const beforeUpgrade = new DatabaseSync(databasePath, { readOnly: true });
    let hostId = '';
    let credentialRef = '';
    let syncAccessCredentialRef = '';
    let syncEncryptionCredentialRef = '';
    let historicalLinksBefore: ReturnType<typeof historicalLinkedRows>;
    let historicalCustomThemeBefore: {
      id: string;
      name: string;
      payload: string;
      created_at: string;
      updated_at: string;
      version: number;
    };
    let historicalSyncBefore: {
      name: string;
      endpoint_url: string;
      remote_id: string;
      username: string;
      access_credential_ref: string;
      encryption_credential_ref: string;
    };
    try {
      expect(
        beforeUpgrade.prepare("SELECT value FROM app_meta WHERE key='migration:33'").get(),
      ).toBeTruthy();
      expect(
        beforeUpgrade.prepare("SELECT value FROM app_meta WHERE key='migration:34'").get(),
      ).toBeUndefined();
      const host = beforeUpgrade
        .prepare("SELECT id, credential_ref FROM hosts WHERE name='historical-package-host'")
        .get() as { id: string; credential_ref: string } | undefined;
      if (!host) throw new Error('Historical Host was not created');
      hostId = host.id;
      credentialRef = host.credential_ref;
      historicalLinksBefore = historicalLinkedRows(beforeUpgrade);
      expect(terminalThemeId(beforeUpgrade)).toBe(historicalThemeId);
      const customTheme = beforeUpgrade
        .prepare(
          'SELECT id, name, payload, created_at, updated_at, version FROM terminal_themes WHERE name=?',
        )
        .get(historicalCustomThemeName) as typeof historicalCustomThemeBefore | undefined;
      if (!customTheme) throw new Error('Historical custom theme was not created');
      historicalCustomThemeBefore = customTheme;
      const syncProfile = beforeUpgrade
        .prepare(
          'SELECT name, endpoint_url, remote_id, username, access_credential_ref, encryption_credential_ref FROM sync_profiles WHERE provider=?',
        )
        .get('webdav') as typeof historicalSyncBefore | undefined;
      if (!syncProfile) throw new Error('Historical sync profile was not created');
      historicalSyncBefore = syncProfile;
      syncAccessCredentialRef = syncProfile.access_credential_ref;
      syncEncryptionCredentialRef = syncProfile.encryption_credential_ref;
    } finally {
      beforeUpgrade.close();
    }
    const databaseBeforeSha256 = await fileSha256(databasePath);
    const vaultBefore = await directoryFileHashes(vaultDirectory);
    const coldBackup = join(directory, 'historical-cold-backup');
    await cp(userData, coldBackup, { recursive: true, verbatimSymlinks: true });
    expect(await fileSha256(join(coldBackup, 'data', 'axterm.sqlite'))).toBe(databaseBeforeSha256);
    expect(await directoryFileHashes(join(coldBackup, 'vault'))).toEqual(vaultBefore);

    const rejectedImportApp = await electron.launch({
      executablePath: executableFor(currentArtifact),
      args: ['--user-data-dir=' + portableImportUserData],
      cwd: currentContainer,
      env: launchEnvironment,
    });
    try {
      await rejectedImportApp.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      }, historicalExportPath);
      const page = await rejectedImportApp.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await expect(page.getByLabel('Legacy Prototype 数据迁移')).toHaveCount(0);
      const configuration = page.getByLabel('Axterm 配置快照');
      await configuration.getByRole('button', { name: '导入 Axterm 配置' }).click();
      await expect(configuration.getByRole('alert')).toBeVisible();
      await expect(configuration.locator('.axterm-config-preview')).toHaveCount(0);
    } finally {
      await rejectedImportApp.close().catch(() => {});
    }
    const rejectedDatabase = new DatabaseSync(
      join(portableImportUserData, 'data-v2', 'axterm.sqlite'),
      { readOnly: true },
    );
    try {
      expect(rejectedDatabase.prepare('SELECT COUNT(*) AS count FROM hosts').get()).toEqual({
        count: 0,
      });
      expect(rejectedDatabase.prepare('SELECT COUNT(*) AS count FROM bookmarks').get()).toEqual({
        count: 0,
      });
    } finally {
      rejectedDatabase.close();
    }

    const currentApp = await electron.launch({
      executablePath: executableFor(currentArtifact),
      args: ['--user-data-dir=' + userData],
      cwd: currentContainer,
      env: launchEnvironment,
    });
    let currentVersion = '';
    try {
      await currentApp.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
      }, upgradedConfigurationPath);
      const page = await currentApp.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      currentVersion = await currentApp.evaluate(({ app }) => app.getVersion());
      expect(currentVersion).toBe('0.10.0');
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await expect(
        page.locator('.host-card').getByText('historical-package-host', { exact: true }),
      ).toBeVisible();
      await openTerminalThemes(page);
      const themeList = page.getByRole('complementary', { name: '终端主题列表' });
      await themeList.getByLabel('搜索终端主题').fill(historicalCustomThemeName);
      await expect(
        themeList.getByRole('button', { name: historicalCustomThemeName }),
      ).toBeVisible();
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      const configuration = page.getByLabel('Axterm 配置快照');
      await configuration.getByRole('button', { name: '导出 Axterm 配置' }).click();
      await expect(configuration.getByText('Axterm 配置已导出', { exact: true })).toBeVisible();
      await page.locator('[data-settings-category="sync"]').click();
      const syncPanel = page.getByRole('region', { name: '设置同步' });
      await syncPanel.getByRole('tab', { name: 'WebDAV' }).click();
      await expect(syncPanel.getByRole('tab', { name: /旧版迁移格式/ })).toHaveCount(0);
      await expect(syncPanel.getByText('Historical package WebDAV')).toHaveCount(0);
      await expect(syncPanel.getByRole('button', { name: '下载', exact: true })).toHaveCount(0);
    } finally {
      await currentApp.close().catch(() => {});
    }

    const upgradedConfigurationText = await readFile(upgradedConfigurationPath, 'utf8');
    const upgradedConfiguration = JSON.parse(upgradedConfigurationText) as {
      format: string;
      data: { terminalThemes: Array<{ name: string; terminal: unknown; ui: unknown }> };
    };
    expect(upgradedConfiguration.format).toBe('axterm-configuration');
    const exportedTheme = upgradedConfiguration.data.terminalThemes.find(
      ({ name }) => name === historicalCustomThemeName,
    );
    const historicalThemePayload = JSON.parse(historicalCustomThemeBefore.payload) as {
      terminal: unknown;
      ui: unknown;
    };
    expect(exportedTheme?.terminal).toEqual(historicalThemePayload.terminal);
    expect(exportedTheme?.ui).toEqual(historicalThemePayload.ui);
    for (const secret of [fixturePassword, syncAccessSecret, syncEncryptionSecret])
      expect(upgradedConfigurationText).not.toContain(secret);

    const configurationImportApp = await electron.launch({
      executablePath: executableFor(currentArtifact),
      args: ['--user-data-dir=' + upgradedConfigurationUserData],
      cwd: currentContainer,
      env: launchEnvironment,
    });
    try {
      await configurationImportApp.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      }, upgradedConfigurationPath);
      const page = await configurationImportApp.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      const configuration = page.getByLabel('Axterm 配置快照');
      await configuration.getByRole('button', { name: '导入 Axterm 配置' }).click();
      const preview = configuration.locator('.axterm-config-preview');
      await expect(preview).toBeVisible();
      const createCount = Number(
        await preview.locator('.data-migration-metric.create strong').textContent(),
      );
      expect(createCount).toBeGreaterThan(0);
      await preview.getByRole('button', { name: '导入 ' + createCount + ' 项' }).click();
      await expect(configuration.getByText('Axterm 配置已导入', { exact: true })).toBeVisible();
    } finally {
      await configurationImportApp.close().catch(() => {});
    }
    const importedDatabase = new DatabaseSync(
      join(upgradedConfigurationUserData, 'data-v2', 'axterm.sqlite'),
      { readOnly: true },
    );
    try {
      expect(
        importedDatabase
          .prepare("SELECT name, credential_ref FROM hosts WHERE name='historical-package-host'")
          .get(),
      ).toEqual({ name: 'historical-package-host', credential_ref: null });
      const importedTheme = importedDatabase
        .prepare('SELECT payload FROM terminal_themes WHERE name=?')
        .get(historicalCustomThemeName) as { payload: string } | undefined;
      expect(importedTheme).toBeTruthy();
      const payload = JSON.parse(importedTheme!.payload) as { terminal: unknown; ui: unknown };
      expect(payload.terminal).toEqual(historicalThemePayload.terminal);
      expect(payload.ui).toEqual(historicalThemePayload.ui);
    } finally {
      importedDatabase.close();
    }

    const upgradedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        upgradedDatabase.prepare("SELECT value FROM app_meta WHERE key='migration:38'").get(),
      ).toBeTruthy();
      expect(
        upgradedDatabase.prepare('SELECT credential_ref FROM hosts WHERE id=?').get(hostId),
      ).toEqual({ credential_ref: credentialRef });
      expect(historicalLinkedRows(upgradedDatabase)).toEqual(historicalLinksBefore);
      expect(terminalThemeId(upgradedDatabase)).toBe(migratedThemeId);
      expect(
        upgradedDatabase
          .prepare(
            'SELECT id, name, payload, created_at, updated_at, version FROM terminal_themes WHERE name=?',
          )
          .get(historicalCustomThemeName),
      ).toEqual(historicalCustomThemeBefore);
      expect(
        upgradedDatabase
          .prepare(
            'SELECT format, name, endpoint_url, remote_id, username, access_credential_ref, encryption_credential_ref FROM sync_profiles WHERE provider=?',
          )
          .get('webdav'),
      ).toEqual({ format: 'legacy-legacy-prototype-v1', ...historicalSyncBefore });
    } finally {
      upgradedDatabase.close();
    }
    expect(await directoryFileHashes(vaultDirectory)).toEqual(vaultBefore);
    const vault = new CredentialVault(vaultDirectory);
    await vault.open();
    expect(await vault.get(credentialRef)).toBe(fixturePassword);
    expect(await vault.get(syncAccessCredentialRef)).toBe(syncAccessSecret);
    expect(await vault.get(syncEncryptionCredentialRef)).toBe(syncEncryptionSecret);
    vault.close();
    expect(await fileSha256(join(coldBackup, 'data', 'axterm.sqlite'))).toBe(databaseBeforeSha256);
    expect(await directoryFileHashes(join(coldBackup, 'vault'))).toEqual(vaultBefore);
    expect(historicalRemote.contents).toBe(historicalRemoteDocument);
    expect(historicalRemote.writes).toBe(1);
    expect(historicalRemote.reads).toBe(encryptedReadsBefore);
    expect(historicalPlaintextRemote.contents).toBe(historicalPlaintextDocument);
    expect(historicalPlaintextRemote.writes).toBe(1);
    expect(historicalPlaintextRemote.reads).toBe(plaintextReadsBefore);

    await writeFile(
      join(packagedEvidenceDirectory, 'historical-package-upgrade.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          previousVersion,
          currentVersion,
          previousAsarSha256: await fileSha256(asarFor(previousArtifact)),
          currentAsarSha256: await fileSha256(asarFor(currentArtifact)),
          oldPortableSha256: sha256(Buffer.from(historicalExport)),
          oldPortableRejectedWithoutWrites: true,
          beforeDatabaseSha256: databaseBeforeSha256,
          coldBackupPreserved: true,
          localVaultPreserved: true,
          oldSyncProfileInert: true,
          oldRemoteEncryptedSha256: encryptedRemoteHash,
          oldRemotePlaintextSha256: plaintextRemoteHash,
          oldRemoteReadsUnchanged: true,
          axtermConfigurationSha256: sha256(Buffer.from(upgradedConfigurationText)),
          customThemePreservedInConfiguration: true,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      historicalSyncServer.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged same-generation schema upgrade preserves data, Axterm sync and the local vault', async () => {
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-upgrade-')));
  try {
    const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    const executablePath =
      process.platform === 'darwin'
        ? join(artifact, 'Contents/MacOS/Axterm')
        : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
    const userData = join(directory, 'user-data');
    const dataDirectory = join(userData, 'data-v2');
    const vaultDirectory = join(userData, 'vault-v2');
    const databasePath = join(dataDirectory, 'axterm.sqlite');
    await mkdir(dataDirectory, { recursive: true });

    const vault = new CredentialVault(vaultDirectory);
    await vault.open();
    const secret = 'upgrade-fixture-password-value';
    const credential = await vault.put({
      kind: 'sshPassword',
      label: 'Upgrade fixture',
      secret,
    });
    const syncAccessSecret = 'upgrade-fixture-sync-access-value';
    const syncAccessCredential = await vault.put({
      kind: 'syncAccessToken',
      label: 'Upgrade sync access',
      secret: syncAccessSecret,
    });
    const syncEncryptionSecret = 'upgrade-fixture-sync-encryption-value';
    const syncEncryptionCredential = await vault.put({
      kind: 'syncEncryptionPassword',
      label: 'Upgrade sync encryption',
      secret: syncEncryptionSecret,
    });
    vault.close();

    const database = await ProductDatabase.open(databasePath);
    database.recordAppVersion('0.9.0', '2026-09-12T00:00:00.000Z');
    const products = new ProductRepository(database);
    products.createHost({
      name: 'upgrade-preserved-host',
      hostname: '127.0.0.1',
      username: 'fixture',
      authType: 'password',
      credentialRef: credential.ref,
    });
    const priorSettings = products.getSettings();
    products.updateSettings(
      {
        terminal: {
          visual: {
            ...priorSettings.terminal.visual,
            themeId: '00000000-0000-4000-8000-000000000312',
          },
        },
      },
      etagFor(priorSettings.version),
    );
    const commands = new QuickCommandRepository(database);
    const commandTree = commands.snapshot();
    commands.createCommand(
      {
        groupId: null,
        name: 'Upgrade preserved command',
        command: 'uptime',
        commands: [{ id: randomUUID(), name: '', command: 'uptime', delayMs: 100 }],
        description: 'Created by the prior-version fixture',
        tags: ['upgrade'],
        shortcut: null,
        inputOnly: true,
        clickCount: 0,
      },
      commandTree.etag,
    );
    const legacySync = new SyncProfileRepository(database).create({
      provider: 'webdav',
      name: 'Upgrade Axterm WebDAV',
      endpointUrl: 'https://dav.example.test/legacy/',
      remoteId: 'desktop.json',
      username: 'operator',
      accessCredentialRef: syncAccessCredential.ref,
      encryptionCredentialRef: syncEncryptionCredential.ref,
      selectedCategories: ['settings', 'bookmarks'],
      autoSyncEnabled: false,
      autoSyncIntervalMinutes: 15,
      autoSyncDirection: 'upload',
    });
    database.run('ALTER TABLE ai_messages DROP COLUMN attachments_json');
    database.run("DELETE FROM app_meta WHERE key='migration:32'");
    database.run("DELETE FROM app_meta WHERE key='migration:34'");
    database.close();

    // Model the pre-format migration schema explicitly. This fixture is not a
    // historic binary or release artifact; it verifies that a preserved local
    // profile can safely cross the production migrations in this packaged app.
    const priorSchema = new DatabaseSync(databasePath);
    priorSchema.prepare("DELETE FROM app_meta WHERE key='migration:37'").run();
    priorSchema.exec('DROP INDEX sync_profiles_provider_format_unique;');
    priorSchema.prepare("DELETE FROM app_meta WHERE key='migration:36'").run();
    priorSchema.exec('ALTER TABLE sync_profiles DROP COLUMN format;');
    priorSchema.close();

    const app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(
        page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
      ).toHaveAttribute('data-theme-background', '#1e1e1e');
      await openTerminalThemes(page);
      await expect(page.getByTestId('legacy-theme-file-deprecation')).toHaveCount(0);
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await expect(
        page.locator('.host-card').getByText('upgrade-preserved-host', { exact: true }),
      ).toBeVisible();
      await openQuickCommandsWorkspace(page);
      await expect(
        page
          .getByTestId('quick-command-workspace')
          .locator('.quick-command-tree-row')
          .filter({ hasText: 'Upgrade preserved command' }),
      ).toBeVisible();
      await openSettingsSync(page);
      await expect(page.getByRole('region', { name: '设置同步' })).not.toContainText(
        'Upgrade Axterm WebDAV',
      );
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'upgrade.png') });
    } finally {
      await app.close();
    }

    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const meta = Object.fromEntries(
        (
          inspected
            .prepare(
              "SELECT key, value FROM app_meta WHERE key IN ('app:current-version','app:previous-version','migration:32','migration:34','migration:36','migration:37')",
            )
            .all() as Array<{ key: string; value: string }>
        ).map(({ key, value }) => [key, value]),
      );
      expect(meta['app:current-version']).toBe('0.10.0');
      expect(meta['app:previous-version']).toBe('0.9.0');
      expect(meta['migration:32']).toMatch(/^[0-9a-f]{64}$/u);
      expect(meta['migration:34']).toMatch(/^[0-9a-f]{64}$/u);
      expect(meta['migration:36']).toMatch(/^[0-9a-f]{64}$/u);
      expect(meta['migration:37']).toMatch(/^[0-9a-f]{64}$/u);
      const terminalSettings = inspected
        .prepare("SELECT payload FROM app_settings WHERE section = 'terminal'")
        .get() as { payload: string };
      expect(JSON.parse(terminalSettings.payload).visual.themeId).toBe(
        '00000000-0000-4000-8000-000000000001',
      );
      expect(
        (inspected.prepare('PRAGMA table_info(ai_messages)').all() as Array<{ name: string }>).map(
          ({ name }) => name,
        ),
      ).toContain('attachments_json');
      expect(
        inspected
          .prepare(
            `SELECT format, endpoint_url, remote_id, username, access_credential_ref,
                    encryption_credential_ref, selected_categories, auto_sync_enabled,
                    auto_sync_interval_minutes, auto_sync_direction
             FROM sync_profiles WHERE id=?`,
          )
          .get(legacySync.id),
      ).toEqual({
        format: 'axterm-sync-v1',
        endpoint_url: 'https://dav.example.test/legacy/',
        remote_id: 'desktop.json',
        username: 'operator',
        access_credential_ref: syncAccessCredential.ref,
        encryption_credential_ref: syncEncryptionCredential.ref,
        selected_categories: JSON.stringify(['settings', 'bookmarks']),
        auto_sync_enabled: 0,
        auto_sync_interval_minutes: 15,
        auto_sync_direction: 'upload',
      });
    } finally {
      inspected.close();
    }
    await access(`${databasePath}.pre-migration-34.bak`);
    const persistedDatabase = (await readFile(databasePath)).toString('utf8');
    for (const value of [secret, syncAccessSecret, syncEncryptionSecret])
      expect(persistedDatabase).not.toContain(value);
    const restoredVault = new CredentialVault(vaultDirectory);
    await restoredVault.open();
    expect(await restoredVault.get(credential.ref)).toBe(secret);
    expect(await restoredVault.get(syncAccessCredential.ref)).toBe(syncAccessSecret);
    expect(await restoredVault.get(syncEncryptionCredential.ref)).toBe(syncEncryptionSecret);
    restoredVault.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged macOS D1 leaves SQLite and the local Vault intact after a failed risky migration', async () => {
  test.skip(process.platform !== 'darwin', 'The Mac engineering D1 cell uses the macOS app');
  test.setTimeout(60_000);
  await access(source);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'axterm-packaged-migration-failure-')),
  );
  let application: ReturnType<typeof spawn> | undefined;
  try {
    const artifact = join(directory, 'Axterm.app');
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    const userData = join(directory, 'user-data');
    const fixture = await seedFailingLocalProfile(userData);
    const backupPath = `${fixture.databasePath}.pre-migration-34.bak`;
    application = spawn(join(artifact, 'Contents/MacOS/Axterm'), [`--user-data-dir=${userData}`], {
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: '/usr/bin:/bin',
      },
      stdio: 'ignore',
    });
    const closed = once(application, 'close');
    await expect
      .poll(
        async () =>
          access(backupPath).then(
            () => true,
            () => false,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    // A second backup can be made only after the first Runtime attempt has
    // failed and the Host supervisor has restarted the utility process.
    await expect
      .poll(
        async () =>
          (await readdir(join(userData, 'data-v2'))).filter((entry) =>
            entry.startsWith('axterm.sqlite.pre-migration-34.bak'),
          ).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(2);
    application.kill('SIGKILL');
    await closed;
    application = undefined;

    expect(await readFile(backupPath)).toEqual(fixture.databaseBefore);
    expect(await readFile(fixture.databasePath)).toEqual(fixture.databaseBefore);
    expect(await vaultFileHashes(fixture.vaultDirectory)).toEqual(fixture.vaultBefore);
    const inspected = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        inspected.prepare("SELECT value FROM app_meta WHERE key='migration:34'").get(),
      ).toBeUndefined();
      const terminal = inspected
        .prepare("SELECT payload FROM app_settings WHERE section='terminal'")
        .get() as {
        payload: string;
      };
      expect(JSON.parse(terminal.payload).visual.themeId).toBe(REMOVED_BUILT_IN_THEME_ID);
    } finally {
      inspected.close();
    }
    const vault = new CredentialVault(fixture.vaultDirectory);
    await vault.open();
    expect(await vault.get(fixture.credentialRef)).toBe(MIGRATION_FAILURE_SECRET);
    vault.close();

    const repair = new DatabaseSync(fixture.databasePath);
    repair.exec('DROP TRIGGER migration_34_failure');
    repair.close();
    const relaunched = await electron.launch({
      executablePath: join(artifact, 'Contents/MacOS/Axterm'),
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: '/usr/bin:/bin',
      },
    });
    try {
      const page = await relaunched.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    } finally {
      await relaunched.close();
    }
    const recovered = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        recovered.prepare("SELECT value FROM app_meta WHERE key='migration:34'").get(),
      ).toBeDefined();
      const terminal = recovered
        .prepare("SELECT payload FROM app_settings WHERE section='terminal'")
        .get() as {
        payload: string;
      };
      expect(JSON.parse(terminal.payload).visual.themeId).not.toBe(REMOVED_BUILT_IN_THEME_ID);
      expect(
        recovered
          .prepare('SELECT name FROM hosts WHERE credential_ref=?')
          .get(fixture.credentialRef),
      ).toEqual({ name: 'preserved-migration-host' });
    } finally {
      recovered.close();
    }
    expect(await readFile(backupPath)).toEqual(fixture.databaseBefore);
    expect(await vaultFileHashes(fixture.vaultDirectory)).toEqual(fixture.vaultBefore);
  } finally {
    application?.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test.describe('packaged SSH fixture', () => {
  test.skip(!sshFixturePort, 'Set AXTERM_SSH_FIXTURE_PORT through the fixture script');
  test('packaged SSH terminal authenticates and renders output', async () => {
    test.setTimeout(90_000);
    await access(source);
    await mkdir(packagedEvidenceDirectory, { recursive: true });
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-ssh-')));
    try {
      const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
      await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
      const executablePath =
        process.platform === 'darwin'
          ? join(artifact, 'Contents/MacOS/Axterm')
          : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
      const userData = join(directory, 'user-data');
      const launch = () =>
        electron.launch({
          executablePath,
          args: [`--user-data-dir=${userData}`],
          cwd: directory,
          env: {
            ...process.env,
            ELECTRON_RENDERER_URL: '',
            PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
          },
        });
      let app = await launch();
      try {
        let page = await app.firstWindow();
        await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
        await page.locator('[data-activity-item="bookmarks"]').click();
        await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
        await page.getByRole('button', { name: '添加主机' }).click();
        await page.getByLabel('显示名称').fill('packaged-ssh');
        await page.getByLabel('主机地址').fill('127.0.0.1');
        await page.getByLabel('用户名').fill('fixture');
        await page.getByLabel('端口').fill(String(sshFixturePort));
        await page.getByLabel('认证方式').selectOption('password');
        await page.getByLabel('密码', { exact: true }).fill('axterm-fixture-password');
        await page.getByRole('button', { name: '保存并连接' }).click();
        await expect(page.getByRole('heading', { name: '首次连接此主机' })).toBeVisible();
        await page.getByLabel('保存并记住此主机密钥').check();
        await page.getByRole('button', { name: '信任并连接', exact: true }).click();
        const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
        const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
        await expect(page.locator('.pane-tabbar .terminal-tab.active .tab-title')).toHaveText(
          'packaged-ssh',
        );
        await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
          'data-connection-state',
          'connected',
        );
        await expect
          .poll(() => terminalLayer.locator('.xterm-rows').textContent())
          .toContain('Welcome to OpenSSH Server');
        await terminalInput.pressSequentially("printf '\\nAXTERM_PACKAGED_SSH_OK\\n'");
        await terminalInput.press('Enter');
        await terminalInput.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
        const search = terminalLayer.getByPlaceholder('查找终端输出');
        await expect
          .poll(async () => {
            await search.fill('');
            await search.fill('AXTERM_PACKAGED_SSH_OK');
            return terminalLayer.locator('.terminal-search-result').textContent();
          })
          .toBe('已找到');

        await search.press('Escape');
        await terminalInput.pressSequentially(
          "cd /tmp && printf 'AXTERM_PACKAGED_SFTP_OK' > packaged-sftp.txt && printf '\\nAXTERM_PACKAGED_SFTP_READY\\n'",
        );
        await terminalInput.press('Enter');
        await expect
          .poll(() => terminalLayer.locator('.xterm-rows').textContent())
          .toContain('AXTERM_PACKAGED_SFTP_READY');

        await openFilesWorkspace(page);
        const remotePane = page.getByRole('region', { name: '远端文件' });
        await remotePane.getByRole('button', { name: '当前终端目录' }).click();
        await expect(remotePane.getByRole('textbox', { name: '远端路径' })).toHaveValue('/tmp');
        await expect(
          remotePane.getByRole('button', { name: 'packaged-sftp.txt', exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: join(packagedEvidenceDirectory, 'sftp.png') });

        const sidebar = page.locator('.workspace-sidebar');
        await page.locator('[data-activity-item="bookmarks"]').click();
        await sidebar.getByRole('tab', { name: '历史' }).click();
        const historyRow = sidebar.locator('.connection-history-row').filter({
          hasText: 'packaged-ssh',
        });
        await expect(historyRow).toHaveCount(1);
        await historyRow.hover();
        await historyRow.getByRole('button', { name: '将 packaged-ssh 保存为书签' }).click();
        await sidebar.getByRole('tab', { name: '书签' }).click();
        await expect(sidebar.locator('[data-bookmark-title="packaged-ssh"]')).toHaveCount(2);

        await app.close();
        app = await launch();
        page = await app.firstWindow();
        await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
        const restoredSidebar = page.locator('.workspace-sidebar');
        const restoredBookmarkTab = restoredSidebar.getByRole('tab', { name: '书签' });
        if (!(await restoredBookmarkTab.isVisible()))
          await page.locator('[data-activity-item="bookmarks"]').click();
        await restoredSidebar.getByRole('tab', { name: '书签' }).click();
        await expect(restoredSidebar.locator('[data-bookmark-title="packaged-ssh"]')).toHaveCount(
          2,
        );
        await restoredSidebar.getByRole('tab', { name: '历史' }).click();
        const restoredHistory = restoredSidebar.locator('.connection-history-row').filter({
          hasText: 'packaged-ssh',
        });
        await expect(restoredHistory).toHaveCount(1);
        await restoredHistory.locator('.connection-history-main').click();
        await expect(page.locator('.pane-tabbar .terminal-tab.active .tab-title')).toHaveText(
          'packaged-ssh',
        );
        await expect(
          page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
        ).toHaveAttribute('data-connection-state', 'connected');

        const reconnectedHistoryTab = restoredSidebar.getByRole('tab', { name: '历史' });
        if (!(await reconnectedHistoryTab.isVisible()))
          await page.locator('[data-activity-item="bookmarks"]').click();
        await reconnectedHistoryTab.click();
        const reconnectedHistory = restoredSidebar.locator('.connection-history-row').filter({
          hasText: 'packaged-ssh',
        });
        await page.screenshot({ path: join(packagedEvidenceDirectory, 'history.png') });
        await reconnectedHistory.hover();
        await reconnectedHistory
          .getByRole('button', { name: '删除 packaged-ssh 的连接历史' })
          .click();
        await expect(reconnectedHistory).toHaveCount(0);

        await app.close();
        app = await launch();
        page = await app.firstWindow();
        await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
        const finalSidebar = page.locator('.workspace-sidebar');
        const finalHistoryTab = finalSidebar.getByRole('tab', { name: '历史' });
        if (!(await finalHistoryTab.isVisible()))
          await page.locator('[data-activity-item="bookmarks"]').click();
        await finalHistoryTab.click();
        await expect(
          page.locator('.workspace-sidebar .connection-history-row').filter({
            hasText: 'packaged-ssh',
          }),
        ).toHaveCount(0);
      } finally {
        await app.close().catch(() => {});
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
