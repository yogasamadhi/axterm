import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import {
  createLineEchoFixture,
  protocolFixtureCatalog,
  ProtocolFixtureRegistry,
  type ProtocolFixtureName,
} from '../fixtures/protocols/registry';

const execFileAsync = promisify(execFile);

function solidPng(red: number, green: number, blue: number): Buffer {
  const png = new PNG({ width: 8, height: 8 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = red;
    png.data[offset + 1] = green;
    png.data[offset + 2] = blue;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('Electerm parity harness', () => {
  test('installs the reference guard before Electerm can query a system keychain', async () => {
    const preload = resolve('scripts/parity/electerm-reference-preload.cjs');
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '-e',
        'const c=require("node:child_process");const M=require("node:module");process.stdout.write(c.execSync.name+","+M._load.name)',
      ],
      {
        env: {
          ...process.env,
          AXTERM_ELECTERM_PARITY: '1',
          NODE_OPTIONS: `--require=${preload}`,
        },
      },
    );
    expect(stdout).toBe('execSyncWithoutKeychain,loadWithoutSystemCredentialStore');
  });

  test('always launches the vendored reference with an isolated local profile', async () => {
    const launcher = await readFile('scripts/parity/launch-electerm-reference.mjs', 'utf8');
    const capture = await readFile('scripts/parity/capture.mjs', 'utf8');
    for (const source of [launcher, capture]) {
      expect(source).toContain('AXTERM_ELECTERM_PARITY');
      expect(source).toContain('--user-data-dir=');
      expect(source).toContain('NODE_OPTIONS: `--require=${preload}`');
    }
    expect(launcher).not.toContain('ELECTERM_REFERENCE_EXECUTABLE');
  });

  test('prepares isolated viewport states after resize and captures a real no-session shell', async () => {
    const capture = await readFile('scripts/parity/capture.mjs', 'utf8');
    const manifest = JSON.parse(await readFile('tests/parity/electerm-scenarios.json', 'utf8')) as {
      scenarios: Array<{ id: string; states: string[] }>;
      visualPolicy: { pixelDifferenceRatio: number; hardDefectChecks: string[] };
    };
    const viewportLoop = capture.indexOf('for (const viewport of manifest.viewports)');
    const resize = capture.indexOf('await page.setViewportSize', viewportLoop);
    const prepare = capture.indexOf('await prepareScenario', viewportLoop);
    const stable = capture.indexOf('await waitForStableLayout', prepare);
    const transient = capture.indexOf('await openScenarioTransient', stable);
    expect(viewportLoop).toBeGreaterThan(-1);
    expect(resize).toBeGreaterThan(viewportLoop);
    expect(prepare).toBeGreaterThan(resize);
    expect(stable).toBeGreaterThan(prepare);
    expect(transient).toBeGreaterThan(stable);
    expect(capture).toContain('axterm-parity-${target}-${viewport.id}-');
    expect(capture).toContain('globalThis.store.removeTabs(() => true)');
    expect(capture).toContain("globalThis.store?.currentTab?.status === 'success'");
    expect(capture).toContain('globalThis.store?.triggerResize');
    expect(capture).toContain('stableSamples >= 10');
    expect(capture).toContain('.ant-dropdown:not(.ant-dropdown-hidden)');
    expect(capture).toContain("page.locator('.no-session-view').waitFor()");
    expect(capture).toContain("page.locator('.no-sessions').waitFor()");
    expect(capture).toContain('collectEvidenceGeometry(page)');
    expect(capture).toContain("'.xterm-rows > div:first-child'");
    expect(capture).toContain('result.length >= 160');
    expect(capture).toContain('globalThis.store.config.checkUpdateOnStart = false');
    expect(capture).toContain("if (target === 'electerm')");
    expect(capture).toContain("scenario.id === 'bookmarks.command-history'");
    expect(capture).toContain('installTerminalBackdropMask(');
    expect(capture).toContain("scenario.id === 'bookmarks.ssh-config-import'");
    expect(manifest.scenarios.find(({ id }) => id === 'shell.chrome-empty')?.states).toContain(
      'closed-all-tabs-empty',
    );
    expect(manifest.visualPolicy.pixelDifferenceRatio).toBe(0.05);
    expect(manifest.visualPolicy.hardDefectChecks).toEqual([
      'overlapping-primary-controls',
      'clipped-text-or-actions',
      'unreadable-content-or-contrast',
      'off-viewport-menu-or-dialog',
      'broken-ltr-rtl-direction',
      'broken-keyboard-focus',
      'unreachable-or-nonfunctional-primary-action',
    ]);
  });

  test('audits the pinned baseline and complete scenario/settings/action maps', async () => {
    const { stdout } = await execFileAsync('node', ['scripts/parity/audit.mjs'], {
      cwd: resolve('.'),
    });
    expect(stdout).toContain('122 matrix items');
    expect(stdout).toContain('72 settings');
    expect(stdout).toContain('23 actions');
  }, 30_000);

  test('keeps committed localization captures free of hard defects at every viewport', async () => {
    const manifest = JSON.parse(await readFile('tests/parity/electerm-scenarios.json', 'utf8')) as {
      visualPolicy: { hardDefectChecks: string[] };
    };
    for (const direction of ['ltr', 'rtl']) {
      const metadata = JSON.parse(
        await readFile(
          `tests/parity/screenshots/axterm/settings.localization-${direction}.json`,
          'utf8',
        ),
      ) as {
        records: Array<{
          viewport: { id: string };
          quality: {
            applied: boolean;
            passed: boolean;
            checks: Array<{ id: string; passed: boolean; detail: string }>;
          };
        }>;
      };
      expect(metadata.records.map(({ viewport }) => viewport.id)).toEqual([
        'compact',
        'reference',
        'wide',
      ]);
      for (const { quality } of metadata.records) {
        expect(quality.applied).toBe(true);
        expect(quality.passed).toBe(true);
        expect(quality.checks.map(({ id }) => id)).toEqual(manifest.visualPolicy.hardDefectChecks);
        expect(quality.checks.every(({ passed }) => passed)).toBe(true);
      }
    }
  });

  test('visual diff emits evidence and fails images above the policy threshold', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'axterm-visual-diff-'));
    try {
      const reference = resolve(root, 'reference/reference/shell.chrome-empty.png');
      const candidate = resolve(root, 'candidate/reference/shell.chrome-empty.png');
      await mkdir(resolve(reference, '..'), { recursive: true });
      await mkdir(resolve(candidate, '..'), { recursive: true });
      await writeFile(reference, solidPng(20, 19, 20));
      await writeFile(candidate, solidPng(20, 19, 20));
      const pass = await execFileAsync(
        'node',
        [
          'scripts/parity/visual-diff.mjs',
          '--reference',
          resolve(root, 'reference'),
          '--candidate',
          resolve(root, 'candidate'),
          '--output',
          resolve(root, 'passing-diff'),
        ],
        { cwd: resolve('.') },
      );
      expect(pass.stdout).toContain('worst difference 0.000%');
      const report = JSON.parse(await readFile(resolve(root, 'passing-diff/report.json'), 'utf8'));
      expect(report.passed).toBe(true);
      expect(report.minimumSimilarityRatio).toBe(0.95);
      expect(report.lowestSimilarityRatio).toBe(1);

      await writeFile(candidate, solidPng(239, 71, 111));
      await expect(
        execFileAsync(
          'node',
          [
            'scripts/parity/visual-diff.mjs',
            '--reference',
            resolve(root, 'reference'),
            '--candidate',
            resolve(root, 'candidate'),
            '--output',
            resolve(root, 'failing-diff'),
          ],
          { cwd: resolve('.') },
        ),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('catalogues every protocol family and deterministically owns fixture cleanup', async () => {
    const expected: ProtocolFixtureName[] = [
      'ssh',
      'sftp',
      'ftp',
      'ftps',
      'telnet',
      'serial',
      'rdp',
      'vnc',
      'spice',
      'web',
      'zmodem',
      'xmodem',
      'trzsz',
      'ai',
      'sync',
      'mcp',
    ];
    expect(protocolFixtureCatalog.map(({ name }) => name)).toEqual(expected);
    const registry = new ProtocolFixtureRegistry();
    registry.register(createLineEchoFixture('telnet'));
    const running = await registry.start('telnet');
    expect(await registry.start('telnet')).toBe(running);
    const received = await new Promise<string>((resolveData, reject) => {
      const socket = createConnection(
        { host: String(running.endpoints.host), port: Number(running.endpoints.port) },
        () => socket.write('parity-fixture'),
      );
      socket.once('data', (data) => {
        resolveData(data.toString());
        socket.destroy();
      });
      socket.once('error', reject);
    });
    expect(received).toBe('parity-fixture');
    await registry.stopAll();
    expect(registry.running).toEqual([]);
    await expect(
      new Promise<void>((resolveConnection, reject) => {
        const socket = createConnection({
          host: String(running.endpoints.host),
          port: Number(running.endpoints.port),
        });
        socket.once('connect', () => {
          socket.destroy();
          resolveConnection();
        });
        socket.once('error', reject);
      }),
    ).rejects.toBeDefined();
  });
});
