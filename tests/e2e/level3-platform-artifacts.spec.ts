import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { verifyAppImageRuntimeArtifact } from '../../scripts/commercialization/verify-appimage-runtime-artifact.mjs';
import { closeLevel3Desktop } from '../fixtures/level3-desktop-launch';
const execFileAsync = promisify(execFile);
// Retained Linux native acceptance; discovery on macOS does not count as execution.
test('Linux deb launcher icon resolves through the GTK icon theme', async () => {
  test.skip(process.platform !== 'linux', 'Debian desktop icon check');
  const debPath = resolve(
    process.env.AXTERM_DEB_PATH ?? 'release/axterm-level3-validation_0.10.0_amd64.deb',
  );
  const hasDeb = await access(debPath).then(
    () => true,
    () => false,
  );
  test.skip(!hasDeb, 'Full Debian artifact is required');

  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-deb-icon-')));
  try {
    await execFileAsync('dpkg-deb', ['-x', debPath, directory]);
    const iconTheme = join(directory, 'usr/share/icons/hicolor');
    const iconPath = join(iconTheme, '512x512/apps/axterm-level3-validation.png');
    await access(iconPath);
    await copyFile('/usr/share/icons/hicolor/index.theme', join(iconTheme, 'index.theme'));
    const script = [
      'import os, gi',
      "gi.require_version('Gtk', '3.0')",
      'from gi.repository import Gtk',
      'theme = Gtk.IconTheme.new()',
      "theme.set_search_path([os.environ['AXTERM_ICON_THEME_ROOT']])",
      "theme.set_custom_theme('hicolor')",
      "icon = theme.lookup_icon('axterm-level3-validation', 48, 0)",
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
        AXTERM_HOME: directory,
        HOME: directory,
        NODE_OPTIONS: '',
        NODE_PATH: '',
      },
    });
    const page = await app.firstWindow();
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getVersion())).toBe(
      expectedVersion,
    );
    expect(
      await app.evaluate(({ app }) => {
        const path = process.getBuiltinModule('node:path');
        const fs = process.getBuiltinModule('node:fs');
        return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))
          .main;
      }),
    ).toBe('lib/shell/main.js');
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    expect(await app.evaluate(({ app }) => app.getAppPath())).toMatch(/resources[\\/]app$/u);
    const terminal = page.locator('[data-terminal-channel=ready]');
    await terminal.waitFor();
    const tabs = page.locator('[data-workspace-global-tabs]').getByRole('tab');
    await expect(tabs).toHaveCount(1);
    await page.locator('[data-terminal-new]').click();
    await expect(tabs).toHaveCount(2);
    await closeLevel3Desktop(app);
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
    if (app) await closeLevel3Desktop(app);
    await rm(directory, { recursive: true, force: true });
  }
});
