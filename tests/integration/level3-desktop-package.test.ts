import { closeLevel3Tab } from '../support/level3-tab-actions.ts';
import { openLevel3Settings, level3ContextAction } from '../support/level3-workspace-actions.ts';
import { installConfigurationFrameFixture } from '../support/level3-configuration-frame.ts';
import { createServer } from 'node:http';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import { piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
import { installAutomationFrameFixture } from '../support/level3-automation-frame.ts';
import { remoteDesktopWire, rdpFirstFrame } from '../fixtures/remote-desktop-wire.ts';
import { installRemoteDesktopFrameFixture } from '../support/level3-remote-desktop-frame.ts';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { once } from 'node:events';
import type * as Ssh2 from 'ssh2';
import { startFtpFixture } from '../fixtures/ftp-wire.ts';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import { installSftpWire } from '../fixtures/sftp-wire.ts';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { stageLevel3Desktop } from '../../scripts/stage-level3-desktop.mjs';
import { prepareLevel3Native } from '../../scripts/prepare-level3-native.mjs';
import { packageLevel3Desktop } from '../../scripts/package-level3-desktop.mjs';
import { installTerminalFrameFixture } from '../support/level3-terminal-frame.ts';
import { installFileFrameFixture } from '../support/level3-file-frame.ts';
import { installPlainTerminalFrameFixture } from '../support/level3-plain-terminal-frame.ts';
import { startTelnetFixture } from '../fixtures/telnet-wire.ts';
import { installSshForwardingWire } from '../fixtures/ssh-forwarding-wire.ts';
import { installTunnelFrameFixture } from '../support/level3-tunnel-frame.ts';
import { createServer as createTcpServer, createConnection, type Socket } from 'node:net';
import { createHash } from 'node:crypto';

it('rejects unsafe staging targets, a shared native-store link and an unprepared package before executing builds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-l3-package-admission-'));
  try {
    const stage = join(root, 'stage');
    const output = join(root, 'output');
    await mkdir(stage);
    await mkdir(output);
    await expect(stageLevel3Desktop('relative-stage')).rejects.toThrow('absolute');
    const marker = {
      purpose: 'migration-validation',
      productCutover: false,
      electron: '44.3.0',
      platform: process.platform,
      arch: process.arch,
    };
    await writeFile(join(stage, 'LEVEL3_PACKAGE.json'), JSON.stringify(marker));
    await expect(stageLevel3Desktop(stage)).rejects.toThrow('empty');
    const alias = join(root, 'alias');
    await symlink(stage, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(stageLevel3Desktop(alias)).rejects.toThrow('non-symlink');
    await mkdir(join(stage, 'node_modules'));
    await symlink(
      await realpath('packages/infra/subprocess-local/node_modules/node-pty'),
      join(stage, 'node_modules/node-pty'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(prepareLevel3Native(stage)).rejects.toThrow('outside the isolated stage');
    await rm(join(stage, 'node_modules/node-pty'));
    await mkdir(join(stage, 'node_modules/node-pty'));
    await mkdir(join(stage, 'node_modules/@serialport'));
    const sharedSerial = join(root, 'outside-serial');
    await mkdir(sharedSerial);
    await symlink(
      sharedSerial,
      join(stage, 'node_modules/@serialport/bindings-cpp'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // Validate every native root before invoking any rebuild, not only the PTY root.
    await expect(prepareLevel3Native(stage)).rejects.toThrow('outside the isolated stage');
    await expect(packageLevel3Desktop(stage, output)).rejects.toThrow(
      'requires native preparation',
    );
    await writeFile(
      join(stage, 'LEVEL3_PACKAGE.json'),
      JSON.stringify({
        ...marker,
        nativePreparation: {
          electron: marker.electron,
          platform: marker.platform,
          arch: marker.arch,
          modules: ['node-pty'],
          files: [{ path: 'one.node', sha256: 'a'.repeat(64) }],
        },
      }),
    );
    await expect(packageLevel3Desktop(stage, output)).rejects.toThrow(
      'requires native preparation',
    );
    expect(await readdir(output)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('stages the complete new runtime dependency closure without checkout links or old product packages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-l3-closure-test-'));
  try {
    const result = await stageLevel3Desktop(directory);
    expect(result.inventory.packages.length).toBeGreaterThan(40);
    expect(
      result.inventory.packages.some((entry) => /^(?:@workspace\/|dsh-)/.test(entry.name)),
    ).toBe(false);
    expect(
      result.inventory.packages.some((entry) => entry.name === '@axterm/plugin-terminals'),
    ).toBe(true);
    const pi = result.inventory.packages.find((entry) => entry.name === '@axterm/engine-pi-core');
    expect(pi).toBeDefined();
    const piRoot = join(directory, 'node_modules/.axterm', pi!.id, 'package');
    const piManifest = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8'));
    expect(Object.keys(piManifest.dependencies)).toEqual(['ws']);
    const piProof = JSON.parse(await readFile(join(piRoot, 'dist/pi-bundle.json'), 'utf8'));
    expect(piProof.components.some((entry: { name: string }) => entry.name === 'openai')).toBe(
      true,
    );
    expect(result.inventory.packages.some((entry) => entry.name === 'openai')).toBe(false);
    for (const component of piProof.components)
      for (const notice of component.licenseFiles)
        expect(
          createHash('sha256')
            .update(await readFile(join(piRoot, 'dist', notice.path)))
            .digest('hex'),
        ).toBe(notice.sha256);
    let links = 0;
    async function inspect(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const next = join(path, entry.name);
        if (entry.isSymbolicLink()) {
          links++;
          expect((await realpath(next)).startsWith(directory + sep)).toBe(true);
        } else if (entry.isDirectory()) await inspect(next);
      }
    }
    await inspect(directory);
    expect(links).toBeGreaterThan(40);
    expect(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).main).toBe(
      'lib/shell/main.js',
    );
    expect(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).axterm).toEqual({
      migrationValidation: true,
    });
    await expect(lstat(join(directory, 'lib/shell/preload.cjs'))).resolves.toBeDefined();
    await expect(lstat(join(directory, 'lib/shell/native-panel.js'))).resolves.toBeDefined();
    for (const file of [
      'LICENSE',
      'THIRD_PARTY_NOTICES.txt',
      'THIRD_PARTY_COMPONENTS.json',
      'THIRD_PARTY_LICENSE_TEXTS.json',
      'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
    ]) {
      const source =
        file === 'LICENSE' || file === 'THIRD_PARTY_NOTICES.txt' ? file : 'compliance/' + file;
      expect(await readFile(join(directory, file))).toEqual(await readFile(resolve(source)));
    }
    expect((await readdir(join(directory, 'licenses'))).sort()).toEqual(
      (await readdir(resolve('licenses'))).sort(),
    );
    const serial = createRequire(join(directory, 'package.json')).resolve(
      '@serialport/bindings-cpp',
    );
    expect(serial.startsWith(directory + sep)).toBe(true);
    await expect(lstat(join(result.nativeDirectory, 'lib/index.js'))).resolves.toBeDefined();
    const shellRequire = createRequire(join(directory, 'lib/shell/main.js'));
    for (const name of [
      '@axterm/infra-connection',
      '@axterm/infra-desktop-native',
      '@axterm/desktop-host/protocol',
    ])
      expect(shellRequire.resolve(name).startsWith(directory + sep)).toBe(true);
    for (const entry of result.inventory.packages.filter(
      (entry) => entry.name.startsWith('@axterm/') || entry.name.startsWith('@deepseek-ai/'),
    )) {
      await expect(
        lstat(join(directory, 'node_modules/.axterm', entry.id, 'package/src')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
it.skipIf(!packageResult || process.platform !== 'darwin')(
  'starts a native panel from the source-free package and reaps it when the owned Host crashes',
  async () => {
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const binary = join(appRoot, 'Contents/MacOS', binaryName!);
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-packaged-files-'));
    let application: ElectronApplication | undefined;
    const execute = promisify(execFile);
    const ownedChildren = async (parent: number): Promise<number[]> => {
      const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,comm=']);
      return stdout.split('\n').flatMap((line) => {
        const parts = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        return parts && Number(parts[2]) === parent && parts[3] === binary
          ? [Number(parts[1])]
          : [];
      });
    };
    try {
      await installFileFrameFixture(home);
      application = await electron.launch({
        executablePath: binary,
        args: [],
        timeout: 15_000,
        cwd: home,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15_000 });
      const importStatuses: { status: number; type: string | undefined }[] = [];
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/files/import')
          importStatuses.push({
            status: response.status(),
            type: response.headers()['content-type'],
          });
      });
      await page.locator('[data-file-state="ready"]').waitFor({ timeout: 15_000 });
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      await page.locator('#exercise-files').click();
      await page.locator('[data-file-operations="done"]').waitFor({ timeout: 8000 });
      await page.locator('#exercise-imports').click();
      await expect
        .poll(() => page.locator('[data-file-operations]').getAttribute('data-file-operations'), {
          timeout: 12000,
        })
        .toMatch(/^import-(done|failed-)/u);
      expect(
        await page.locator('[data-file-operations]').getAttribute('data-file-operations'),
        JSON.stringify({ importStatuses }),
      ).toBe('import-done');
      await expect
        .poll(() => page.locator('[data-grant-count]').getAttribute('data-grant-count'), {
          timeout: 8000,
        })
        .toBe('0');
      const generation = await page
        .locator('[data-file-generation]')
        .getAttribute('data-file-generation');
      expect(generation).toMatch(/^[0-9a-f-]{36}$/u);
      expect(await readdir(join(home, 'desktop/file-imports', generation!))).toEqual([]);
      const parent = application.process().pid!;
      const before = await ownedChildren(parent);
      expect(before).toHaveLength(1);
      const hostPid = before[0]!;
      await page.locator('#choose').click();
      await expect.poll(() => ownedChildren(parent), { timeout: 8000 }).toHaveLength(2);
      const helperPid = (await ownedChildren(parent)).find((id) => id !== hostPid)!;
      expect(helperPid).toBeGreaterThan(0);
      expect(await page.locator('#choose').isDisabled()).toBe(true);
      process.kill(hostPid, 'SIGKILL');
      await page.waitForURL('axterm-app://shell/recovery', { timeout: 8000 });
      await expect
        .poll(
          async () => {
            try {
              process.kill(helperPid, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
              throw error;
            }
          },
          { timeout: 8000 },
        )
        .toBe(false);
      // Native recovery is a real modal. Its inspector can pause while the modal
      // is open; terminate this owned test process after the recovery/reaping assertions.
      application.process().kill('SIGKILL');
      await application.close().catch(() => {});
      application = undefined;
    } finally {
      if (application) {
        const child = application.process();
        const force = setTimeout(() => child.kill('SIGKILL'), 1500);
        try {
          await application.evaluate(({ app }) => app.exit(1)).catch(() => {});
          await application.close();
        } finally {
          clearTimeout(force);
        }
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  40_000,
);
it.skipIf(!packageResult || process.platform !== 'darwin')(
  'rejects a packaged validation launch without an explicit isolated home before creating product data',
  async (context) => {
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    if (record.purpose === 'desktop-application')
      context.skip(
        'This rejection applies only to validation packages; product home policy is verified separately.',
      );
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binary] = await readdir(join(appRoot, 'Contents/MacOS'));
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-package-denied-'));
    const child = spawn(join(appRoot, 'Contents/MacOS', binary!), [], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        AXTERM_HOME: '',
        PATH: '/usr/bin:/bin',
        NODE_OPTIONS: '',
        NODE_PATH: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostics = '';
    child.stderr.on('data', (bytes) => {
      diagnostics = (diagnostics + String(bytes)).slice(-4096);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      expect(code).toBe(1);
      expect(diagnostics).toContain('DESKTOP_SHELL_STARTUP_FAILED');
      await expect(lstat(join(home, '.axterm'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(home, { recursive: true, force: true });
    }
  },
  12_000,
);
it.skipIf(!packageResult || process.platform !== 'darwin')(
  'runs the source-free macOS package with restricted PATH, real PTY, authenticated UI and deterministic quit',
  async () => {
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    if (record.purpose === 'desktop-application') {
      expect(record.productCutover).toBe(true);
    } else {
      expect(record.purpose).toBe('migration-validation');
    }
    const appRoot = dirname(dirname(dirname(record.app)));
    const binaries = await readdir(join(appRoot, 'Contents/MacOS'));
    expect(binaries).toHaveLength(1);
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-package-home-'));
    let application: ElectronApplication | undefined;
    try {
      await installTerminalFrameFixture(home);
      application = await electron.launch({
        executablePath: join(appRoot, 'Contents/MacOS', binaries[0]!),
        args: [],
        timeout: 15_000,
        cwd: home,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15_000 });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning')
          errors.push(message.text().slice(0, 2048));
      });
      await page
        .locator('[data-terminal-probe="ready"]')
        .waitFor({ timeout: 15_000 })
        .catch(async (error) => {
          throw new Error(
            JSON.stringify({
              errors,
              body: (
                await page
                  .locator('body')
                  .innerText({ timeout: 1000 })
                  .catch(() => 'closed')
              ).slice(0, 8192),
            }),
            { cause: error },
          );
        });
      expect(page.url()).toBe('axterm-app://app/');
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      await page.locator('#create').click();
      await page.locator('[data-session-count="1"]').waitFor();
      await page.locator('[data-output][data-channel="ready"]').waitFor();
      await page.locator('#input').click();
      await page.getByText('AXTERM_PACKAGE_OK', { exact: false }).waitFor();
      expect(
        await page.evaluate(() => ({
          cookie: document.cookie,
          local: { ...localStorage },
          session: { ...sessionStorage },
        })),
      ).toEqual({ cookie: '', local: {}, session: {} });
      await page.locator('#close').click();
      await page.locator('[data-session-count="0"]').waitFor();
      // The remove increment precedes the actual native drain. Await the command receipt before asserting idle quit.
      await page.locator('[data-close-state="done"]').waitFor();
      expect(errors).toEqual([]);
      const exited = application.waitForEvent('close');
      await application.evaluate(({ app }) => app.quit());
      await exited;
      application = undefined;
      await expect(readFile(join(home, 'vault-v2/master.key'))).resolves.toHaveLength(32);
      expect(await readdir(join(home, 'desktop/crashes')).catch(() => [])).toEqual([]);
    } finally {
      if (application) {
        const child = application.process();
        const force = setTimeout(() => child.kill('SIGKILL'), 1500);
        try {
          await application.evaluate(({ app }) => app.exit(1)).catch(() => {});
        } finally {
          clearTimeout(force);
        }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  40_000,
);

it.skipIf(!packageResult || process.platform !== 'darwin')(
  'runs authenticated generated SFTP commands from the source-free package with a restricted PATH',
  async () => {
    const ssh = createRequire(resolve('packages/plugins/connections/package.json'))(
      'ssh2',
    ) as typeof Ssh2;
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const binary = join(appRoot, 'Contents/MacOS', binaryName!);
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-packaged-sftp-'));
    const remoteRoot = join(home, 'remote');
    await mkdir(remoteRoot);
    const password = 'CONTROLLED_PACKAGE_SFTP_PASSWORD';
    const peers = new Set<Ssh2.Connection>();
    const channels = new Set<ReturnType<typeof installSftpWire>>();
    const server = new ssh.Server(
      { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
      (peer) => {
        peers.add(peer);
        peer.on('error', () => {});
        peer.once('close', () => peers.delete(peer));
        peer.on('authentication', (request) => {
          if (request.method === 'password' && request.password === password) request.accept();
          else request.reject(['password']);
        });
        peer.on('ready', () =>
          peer.on('session', (accept) =>
            accept().on('sftp', (approve) => {
              const channel = installSftpWire(approve(), remoteRoot);
              channels.add(channel);
              void channel.closed.then(() => channels.delete(channel));
            }),
          ),
        );
      },
    );
    let application: ElectronApplication | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Unbound package SFTP fixture');
      await installFileFrameFixture(home, { sftp: { port: address.port, password } });
      application = await electron.launch({
        executablePath: binary,
        args: [],
        timeout: 15_000,
        cwd: home,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15_000 });
      await page.locator('[data-file-state="ready"]').waitFor({ timeout: 15_000 });
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      await page.locator('#exercise-remote-files').click();
      await page.locator('[data-file-operations="remote-done"]').waitFor({ timeout: 15_000 });
      expect(await readdir(remoteRoot)).toEqual([]);
      await expect.poll(() => peers.size, { timeout: 8000 }).toBe(0);
      await expect.poll(() => channels.size, { timeout: 8000 }).toBe(0);
    } finally {
      await closeProtocolFixture(application);
      for (const peer of peers) peer.end();
      await new Promise<void>((done) => server.close(() => done()));
      await Promise.all([...channels].map((channel) => channel.closed));
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);

it.skipIf(!packageResult || process.platform !== 'darwin')(
  'runs credential-backed FTP commands and a streamed server-side copy from the source-free desktop package',
  async () => {
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-packaged-ftp-'));
    const password = 'CONTROLLED_PACKAGE_FTP_PASSWORD';
    const server = await startFtpFixture({ username: 'fixture', password });
    let application: ElectronApplication | undefined;
    try {
      const vault = new EncryptedVault(join(home, 'vault-v2'));
      await vault.open();
      let ref: string;
      try {
        ref = (
          await vault.put({ kind: 'password', label: 'Packaged FTP fixture', secret: password })
        ).ref;
      } finally {
        await vault.close();
      }
      await installFileFrameFixture(home, { ftp: { port: server.port, credentialRef: ref } });
      application = await electron.launch({
        executablePath: join(appRoot, 'Contents/MacOS', binaryName!),
        args: [],
        timeout: 15000,
        cwd: home,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15000 });
      await page
        .locator('[data-file-state="ready"][data-catalog-state="ready"]')
        .waitFor({ timeout: 15000 });
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      await page.locator('#exercise-ftp-files').click();
      await page.locator('[data-file-operations="ftp-done"]').waitFor({ timeout: 15000 });
      expect([...server.files.entries()].map(([name, bytes]) => [name, bytes.toString()])).toEqual([
        ['/hello.txt', 'hello'],
      ]);
    } finally {
      await closeProtocolFixture(application);
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);

it.skipIf(!packageResult || process.platform !== 'darwin')(
  'loads native Serial bindings and runs Vault-backed Telnet binary IO from the source-free package',
  async () => {
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-packaged-telnet-'));
    const password = 'CONTROLLED_PACKAGE_TELNET_PASSWORD';
    const server = await startTelnetFixture('fixture', password);
    let application: ElectronApplication | undefined;
    try {
      const vault = new EncryptedVault(join(home, 'vault-v2'));
      await vault.open();
      let ref: string;
      try {
        ref = (
          await vault.put({ kind: 'password', label: 'Packaged Telnet fixture', secret: password })
        ).ref;
      } finally {
        await vault.close();
      }
      await installPlainTerminalFrameFixture(home, { port: server.port, credentialRef: ref });
      application = await electron.launch({
        executablePath: join(appRoot, 'Contents/MacOS', binaryName!),
        args: [],
        timeout: 15000,
        cwd: home,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15000 });
      await page
        .locator('[data-terminal-probe="ready"][data-catalog-state="ready"]')
        .waitFor({ timeout: 15000 });
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      await page.locator('#create').click();
      await expect.poll(() => server.authentications()).toBe(1);
      await expect
        .poll(() => page.locator('[data-serial-count]').getAttribute('data-serial-count'))
        .toMatch(/^\d+$/);
      await page.locator('[data-output][data-channel="ready"]').waitFor({ timeout: 8000 });
      await page.locator('#input').click();
      await expect
        .poll(() => page.locator('[data-output]').textContent())
        .toContain('AXTERM_PACKAGED_TELNET_OK');
      expect(await page.locator('body').innerText()).not.toContain(password);
      await page.locator('#close').click();
      await expect.poll(() => server.peers.size).toBe(0);
      await page.locator('[data-session-count="0"]').waitFor({ timeout: 8000 });
    } finally {
      await closeProtocolFixture(application);
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);

it.skipIf(!packageResult || process.platform !== 'darwin')(
  'runs real local, remote and dynamic SSH forwarding from the source-free package with bounded binary bytes',
  async () => {
    const ssh = createRequire(resolve('packages/plugins/connections/package.json'))(
      'ssh2',
    ) as typeof Ssh2;
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-packaged-tunnels-'));
    const password = 'CONTROLLED_PACKAGE_TUNNEL_PASSWORD';
    const peers = new Set<Ssh2.Connection>();
    const forwarding = new Set<ReturnType<typeof installSshForwardingWire>>();
    const echoPeers = new Set<Socket>();
    const echo = createTcpServer({ allowHalfOpen: true }, (socket) => {
      echoPeers.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => echoPeers.delete(socket));
      socket.pipe(socket);
    });
    const server = new ssh.Server(
      { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
      (peer) => {
        peers.add(peer);
        peer.on('error', () => {});
        peer.once('close', () => peers.delete(peer));
        const owner = installSshForwardingWire(peer);
        forwarding.add(owner);
        peer.once('close', () => {
          void owner.close().then(() => forwarding.delete(owner));
        });
        peer.on('authentication', (request) => {
          if (
            request.method === 'password' &&
            request.username === 'fixture' &&
            request.password === password
          )
            request.accept();
          else request.reject(['password']);
        });
      },
    );
    server.listen(0, '127.0.0.1');
    echo.listen(0, '127.0.0.1');
    await Promise.all([once(server, 'listening'), once(echo, 'listening')]);
    const sshAddress = server.address();
    const echoAddress = echo.address();
    if (
      !sshAddress ||
      typeof sshAddress === 'string' ||
      !echoAddress ||
      typeof echoAddress === 'string'
    )
      throw new Error('Tunnel fixtures did not bind');
    let application: ElectronApplication | undefined;
    try {
      await installTunnelFrameFixture(home, {
        port: sshAddress.port,
        targetPort: echoAddress.port,
        password,
      });
      application = await electron.launch({
        executablePath: join(appRoot, 'Contents/MacOS', binaryName!),
        args: [],
        timeout: 15000,
        cwd: home,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15000 });
      await page.locator('[data-tunnel-state="ready"]').waitFor({ timeout: 15000 });
      await page.locator('#start-tunnels').click();
      await page.locator('[data-result="ready"]').waitFor({ timeout: 15000 });
      const tunnels = JSON.parse(
        (await page.locator('[data-tunnel-ports]').getAttribute('data-tunnel-ports'))!,
      ) as { id: string; type: string; port: number }[];
      expect(tunnels.map((item) => item.type)).toEqual(['local', 'remote', 'dynamic']);
      const bytes = Buffer.alloc(4 * 1024 * 1024, 0x6b);
      for (const tunnel of tunnels) {
        const socket = createConnection({ host: '127.0.0.1', port: tunnel.port });
        socket.on('error', () => {});
        const chunks: Buffer[] = [];
        socket.on('data', (bytes) => chunks.push(bytes));
        const closed = once(socket, 'close');
        await once(socket, 'connect');
        if (tunnel.type === 'dynamic') {
          const port = Buffer.alloc(2);
          port.writeUInt16BE(echoAddress.port);
          socket.end(
            Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1]), port, bytes]),
          );
        } else socket.end(bytes);
        await closed;
        const received = Buffer.concat(chunks).subarray(tunnel.type === 'dynamic' ? 12 : 0);
        expect(received.length).toBe(bytes.length);
        expect(createHash('sha256').update(received).digest('hex')).toBe(
          createHash('sha256').update(bytes).digest('hex'),
        );
      }
      await page.locator('#stop-tunnels').click();
      await page.locator('[data-result="done"]').waitFor({ timeout: 8000 });
      await expect.poll(() => peers.size).toBe(0);
      await expect
        .poll(() => [...forwarding].reduce((count, value) => count + value.resourceCount(), 0))
        .toBe(0);
    } finally {
      await closeProtocolFixture(application);
      for (const peer of peers) peer.end();
      await Promise.all([...forwarding].map((owner) => owner.close()));
      for (const socket of echoPeers) socket.destroy();
      await Promise.all([
        new Promise<void>((done) => server.close(() => done())),
        new Promise<void>((done) => echo.close(() => done())),
      ]);
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);

async function closeProtocolFixture(application: ElectronApplication | undefined): Promise<void> {
  if (!application) return;
  const child = application.process();
  // A real recovery modal can block normal close; never abandon this test-owned process.
  const force = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 1500);
  try {
    await application.close().catch(() => {});
  } finally {
    clearTimeout(force);
  }
}

it.skipIf(!packageResult || process.platform !== 'darwin')(
  'runs Vault-backed RDP TLS, VNC and SPICE binary carriers from the source-free package and drains them',
  async () => {
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-packaged-remote-desktop-'));
    const rdp = await remoteDesktopWire('rdp');
    const vnc = await remoteDesktopWire('vnc');
    const spice = await remoteDesktopWire('spice');
    let application: ElectronApplication | undefined;
    try {
      const vault = new EncryptedVault(join(home, 'vault-v2'));
      await vault.open();
      let ref: string;
      try {
        ref = (
          await vault.put({
            kind: 'password',
            label: 'Remote desktop fixture',
            secret: 'CONTROLLED_PACKAGE_DESKTOP_PASSWORD',
          })
        ).ref;
      } finally {
        await vault.close();
      }
      await installRemoteDesktopFrameFixture(home, {
        rdp: rdp.port,
        vnc: vnc.port,
        spice: spice.port,
        credentialRef: ref,
        firstFrame: rdpFirstFrame(rdp.port).toString('base64'),
      });
      application = await electron.launch({
        executablePath: join(appRoot, 'Contents/MacOS', binaryName!),
        args: [],
        timeout: 15000,
        cwd: home,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15000 });
      await page.locator('[data-desktop-state="ready"]').waitFor({ timeout: 15000 });
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      await page.locator('#test-remote-desktop').click();
      await page.locator('[data-result="done"]').waitFor({ timeout: 20000 });
      expect(await page.locator('body').innerText()).not.toContain(
        'CONTROLLED_PACKAGE_DESKTOP_PASSWORD',
      );
      await expect.poll(() => rdp.peers.size + vnc.peers.size + spice.peers.size).toBe(0);
    } finally {
      await closeProtocolFixture(application);
      await Promise.all([rdp.close(), vnc.close(), spice.close()]);
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);

it.skipIf(!packageResult || process.platform !== 'darwin')(
  'runs reviewed grant-scoped rename, Quick Commands, exactly-once SSH batches and terminal triggers in the source-free package',
  async () => {
    const ssh = createRequire(resolve('packages/plugins/connections/package.json'))(
      'ssh2',
    ) as typeof Ssh2;
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-packaged-automation-'));
    const password = 'CONTROLLED_PACKAGE_AUTOMATION_PASSWORD';
    const peers = new Set<Ssh2.Connection>();
    const executed: string[] = [];
    const server = new ssh.Server(
      { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
      (peer) => {
        peers.add(peer);
        peer.on('error', () => {});
        peer.once('close', () => peers.delete(peer));
        peer.on('authentication', (request) => {
          if (
            request.method === 'password' &&
            request.username === 'fixture' &&
            request.password === password
          )
            request.accept();
          else request.reject(['password']);
        });
        peer.on('ready', () =>
          peer.on('session', (accept) => {
            const session = accept();
            session.on('pty', (approve) => approve?.());
            session.on('env', (approve) => approve?.());
            session.on('exec', (approve, _reject, info) => {
              executed.push(info.command);
              const channel = approve();
              channel.write('/bin/sh');
              channel.exit(0);
              channel.end();
            });
            session.on('shell', (approve) => {
              const channel = approve();
              channel.on('data', (data: Buffer) => channel.write(data));
              channel.on('eof', () => channel.end());
            });
          }),
        );
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SSH fixture did not bind');
    let application: ElectronApplication | undefined;
    try {
      const vault = new EncryptedVault(join(home, 'vault-v2'));
      await vault.open();
      let ref: string;
      try {
        ref = (await vault.put({ kind: 'password', label: 'Automation fixture', secret: password }))
          .ref;
      } finally {
        await vault.close();
      }
      await mkdir(join(home, 'rename-fixture'));
      await writeFile(join(home, 'rename-fixture/alpha.txt'), 'packaged alpha');
      await writeFile(join(home, 'rename-fixture/beta.txt'), 'packaged beta');
      await installAutomationFrameFixture(home, { port: address.port, credentialRef: ref });
      application = await electron.launch({
        executablePath: join(appRoot, 'Contents/MacOS', binaryName!),
        args: [],
        timeout: 15000,
        cwd: home,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15000 });
      await page.locator('[data-automation-state="ready"]').waitFor({ timeout: 15000 });
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      await page.locator('#test-automation').click();
      await page.locator('[data-result="done"]').waitFor({ timeout: 20000 });
      expect(
        executed.filter((command) => command === 'printf AXTERM_PACKAGED_BATCH_OK'),
      ).toHaveLength(1);
      expect(await page.locator('[data-automation-output]').textContent()).toContain(
        'AXTERM_PACKAGED_TRIGGER_RESPONSE',
      );
      expect(await page.locator('body').innerText()).not.toContain(password);
      await expect.poll(() => peers.size).toBe(0);
      expect(await readFile(join(home, 'rename-fixture/alpha-01.txt'), 'utf8')).toBe(
        'packaged alpha',
      );
      expect(await readFile(join(home, 'rename-fixture/beta-02.txt'), 'utf8')).toBe(
        'packaged beta',
      );
    } finally {
      await closeProtocolFixture(application);
      for (const peer of peers) peer.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);

it.skipIf(!packageResult || process.platform !== 'darwin')(
  'starts the real default workspace without fixture UI and preserves actual PTYs across tab close and metadata reconnect',
  async () => {
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-default-workspace-'));
    let application: ElectronApplication | undefined;
    try {
      // Deliberately no Profile manifest, patch, fixture package or injected script.
      application = await electron.launch({
        executablePath: join(appRoot, 'Contents/MacOS', binaryName!),
        args: [],
        cwd: home,
        timeout: 15000,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          HOME: home,
          ZDOTDIR: home,
          ENV: '',
          BASH_ENV: '',
          HISTFILE: '/dev/null',
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15000 });
      await page.locator('[data-axterm-product-workspace]').waitFor({ timeout: 15000 });
      const manifest = JSON.parse(
        await readFile(join(home, 'profiles/desktop/package.json'), 'utf8'),
      );
      expect(manifest.axterm.profile.bundles).toContain('@axterm/bundle-workspace');
      expect(manifest.axterm.profile.bundles.join(' ')).not.toContain('@fixture');
      // Use the actual Settings UI to select a persisted language before the terminal journey.
      await openLevel3Settings(page);
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').click();
      await page.getByRole('option', { name: 'English', exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
      await page.locator('[data-settings-category="password"]').click();
      const credentials = page.locator('[data-configuration-credentials]');
      await credentials.locator('#credential-label').fill('UI saved credential');
      await credentials.locator('#credential-secret').fill('UI_PRIVATE_SECRET_CANARY');
      await credentials.getByRole('button', { name: 'Save credential', exact: true }).click();
      const savedRow = credentials
        .locator('[data-credential-ref]')
        .filter({ hasText: 'UI saved credential' });
      await savedRow.waitFor();
      expect(await credentials.locator('#credential-secret').inputValue()).toBe('');
      expect(await page.locator('body').innerText()).not.toContain('UI_PRIVATE_SECRET_CANARY');
      const beforeReplacement = await savedRow.innerText();
      await savedRow.getByRole('button', { name: 'Replace secret', exact: true }).click();
      await credentials.locator('#credential-secret').fill('UI_REPLACED_SECRET_CANARY');
      await credentials
        .locator('form')
        .getByRole('button', { name: 'Replace secret', exact: true })
        .click();
      await expect.poll(() => savedRow.innerText()).not.toBe(beforeReplacement);
      expect(await credentials.locator('#credential-secret').inputValue()).toBe('');
      await savedRow.getByRole('button', { name: 'Delete credential', exact: true }).click();
      expect(await savedRow.count()).toBe(1);
      await savedRow.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
      await savedRow.waitFor({ state: 'detached' });
      expect(
        await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
      ).toEqual({ local: {}, session: {} });
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();

      await page
        .getByRole('button', { name: 'New terminal', exact: true })
        .first()
        .waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'New terminal', exact: true }).first().click();
      await expect
        .poll(() => page.locator('[data-workspace-global-tabs]').getByRole('tab').count())
        .toBe(1);
      const current = () =>
        page.locator('.workspace-session:not([hidden]) [data-terminal-channel="ready"] .xterm');
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      };
      const shellPid = async (marker: string): Promise<number> => {
        await current().click();
        await page.keyboard.type(`printf '${marker}%s' "$$"; echo`);
        await page.keyboard.press('Enter');
        const value = async () =>
          (await current().locator('.xterm-rows').textContent())?.match(
            new RegExp(marker + '([0-9]+)'),
          )?.[1];
        await expect.poll(value).toBeTruthy();
        const pid = Number(await value());
        expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
        return pid;
      };
      await current().waitFor();
      await current().click();
      const firstPid = await shellPid('AXTERM_FIRST_PID_');
      const firstTabId = await page
        .locator('[data-workspace-global-tabs]')
        .getByRole('tab', { selected: true })
        .getAttribute('data-tab-id');
      expect(firstTabId).toBeTruthy();
      await page.keyboard.type("printf 'AXTERM_DEFAULT_%s' WORKSPACE_OK; echo");
      await page.keyboard.press('Enter');
      // Retained shell integration has a 1s start delay and a bounded 3s bootstrap window.
      await expect
        .poll(() => current().locator('.xterm-rows').textContent(), { timeout: 6000 })
        .toContain('AXTERM_DEFAULT_WORKSPACE_OK');
      const terminalBefore = await current().elementHandle();
      await openLevel3Settings(page);
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').click();
      await page.getByRole('option', { name: '日本語', exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('ja');
      await page.getByTestId('application-language').click();
      await page.getByRole('option', { name: 'English', exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
      await page.getByTestId('application-appearance').click();
      await page.getByRole('option', { name: 'Light', exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('data-ax-theme')).toBe('light');
      await page.getByTestId('application-appearance').click();
      await page.getByRole('option', { name: 'Dark', exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('data-ax-theme')).toBe('dark');
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      expect(
        await current().evaluate((element, previous) => element === previous, terminalBefore),
      ).toBe(true);
      expect(await current().locator('.xterm-rows').textContent()).toContain(
        'AXTERM_DEFAULT_WORKSPACE_OK',
      );
      await terminalBefore?.dispose();

      const paste = async (text: string) => {
        await page
          .locator('.workspace-session:not([hidden]) .terminal-canvas')
          .evaluate((element, value) => {
            const data = new DataTransfer();
            data.setData('text/plain', value);
            element.dispatchEvent(
              new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
            );
          }, text);
      };
      await paste("printf 'AXTERM_PASTE_%s' CANCEL_SHOULD_NOT_RUN; echo" + String.fromCharCode(10));
      await page.getByRole('dialog', { name: 'Confirm paste into terminal' }).waitFor();
      await page.keyboard.press('Alt+q');
      expect(await page.locator('[data-workspace-global-tabs]').getByRole('tab').count()).toBe(1);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await current().click();
      await page.keyboard.type("printf 'AXTERM_AFTER_%s' CANCEL_OK; echo");
      await page.keyboard.press('Enter');
      await expect
        .poll(() => current().locator('.xterm-rows').textContent(), { timeout: 6000 })
        .toContain('AXTERM_AFTER_CANCEL_OK');
      expect(await current().locator('.xterm-rows').textContent()).not.toContain(
        'AXTERM_PASTE_CANCEL_SHOULD_NOT_RUN',
      );
      await paste("printf 'AXTERM_PASTE_%s' CONFIRMED_OK; echo" + String.fromCharCode(10));
      await page.getByRole('dialog', { name: 'Confirm paste into terminal' }).waitFor();
      await page.getByRole('button', { name: 'Confirm paste', exact: true }).click();
      await page.keyboard.press('Enter');
      await expect
        .poll(() => current().locator('.xterm-rows').textContent(), { timeout: 6000 })
        .toContain('AXTERM_PASTE_CONFIRMED_OK');
      await page.getByRole('button', { name: 'New terminal', exact: true }).first().click();
      await expect
        .poll(() => page.locator('[data-workspace-global-tabs]').getByRole('tab').count())
        .toBe(2);
      await current().waitFor();
      await current().click();
      await page.keyboard.type("printf 'AXTERM_SECOND_%s' SESSION_OK; echo");
      await page.keyboard.press('Enter');
      await expect
        .poll(() => current().locator('.xterm-rows').textContent(), { timeout: 6000 })
        .toContain('AXTERM_SECOND_SESSION_OK');
      const secondPid = await shellPid('AXTERM_SECOND_PID_');
      expect(secondPid).not.toBe(firstPid);
      const closeAcknowledged = (id: string) =>
        page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/terminals/closeTerminal') &&
            response.request().postDataJSON()?.payload?.args?.id === id,
        );
      const firstClosed = closeAcknowledged(firstTabId!);
      await closeLevel3Tab(
        page,
        page
          .locator('[data-workspace-global-tabs]')
          .locator(`[data-tab-id=${JSON.stringify(firstTabId)}]`),
      );
      expect(await (await firstClosed).json()).toMatchObject({ result: { ok: true } });
      try {
        await expect.poll(() => alive(firstPid)).toBe(false);
      } catch (error) {
        const processes = await promisify(execFile)('/bin/ps', [
          '-p',
          `${firstPid},${secondPid}`,
          '-o',
          'pid=,ppid=,pgid=,state=,comm=',
        ]);
        await writeFile(
          'out/level3-migration/final-2026-11-09/default-pty-close-diagnostic.json',
          JSON.stringify(
            {
              firstPid,
              secondPid,
              firstTabId,
              processes: processes.stdout,
              tabs: await page
                .locator('[data-workspace-global-tabs] [role=tab]')
                .evaluateAll((nodes) =>
                  nodes.map((node) => ({
                    id: node.getAttribute('data-tab-id'),
                    selected: node.getAttribute('aria-selected'),
                    title: node.textContent,
                  })),
                ),
            },
            null,
            2,
          ),
        );
        throw error;
      }
      await expect
        .poll(() => page.locator('[data-workspace-global-tabs]').getByRole('tab').count())
        .toBe(1);
      await expect
        .poll(() => current().locator('.xterm-rows').textContent(), { timeout: 6000 })
        .toContain('AXTERM_SECOND_SESSION_OK');
      await (await level3ContextAction(page, '[data-terminals-refresh]')).click();
      await expect
        .poll(() => page.locator('[data-workspace-global-tabs]').getByRole('tab').count())
        .toBe(1);
      expect(alive(secondPid)).toBe(true);
      await current().click();
      await page.keyboard.type("printf 'AXTERM_REFRESH_%s' SESSION_OK; echo");
      await page.keyboard.press('Enter');
      await expect
        .poll(() => current().locator('.xterm-rows').textContent(), { timeout: 6000 })
        .toContain('AXTERM_REFRESH_SESSION_OK');
      const lastTabId = await page
        .locator('[data-workspace-global-tabs]')
        .getByRole('tab', { selected: true })
        .getAttribute('data-tab-id');
      const secondClosed = closeAcknowledged(lastTabId!);
      await closeLevel3Tab(page);
      expect(await (await secondClosed).json()).toMatchObject({ result: { ok: true } });
      await expect
        .poll(() => page.locator('[data-workspace-global-tabs]').getByRole('tab').count())
        .toBe(0);
      await expect.poll(() => alive(secondPid)).toBe(false);
      expect(page.url()).toBe('axterm-app://app/');
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    } finally {
      await closeProtocolFixture(application);
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);

it.skipIf(!packageResult || process.platform !== 'darwin')(
  'runs the selected Pi and AI Bundles with native Vault and durable application facts from the source-free package',
  async () => {
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-packaged-pi-'));
    const journal = join(home, 'pi-result.json');
    let requests = 0;
    let authorization = '';
    const requestsSeen: { path: string; key: string; authorization: string }[] = [];
    const server = createServer((req, res) => {
      requests++;
      requestsSeen.push({
        path: req.url ?? '',
        key: String(req.headers['x-api-key'] ?? ''),
        authorization: String(req.headers.authorization ?? ''),
      });
      authorization = String(req.headers.authorization);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(piSseText('openai-chat', 'SOURCE_FREE_PI_RESULT') + piSseEnd('openai-chat'));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
    const proxy = createServer();
    const proxyTargets: string[] = [];
    const proxyPeers = new Set<Socket>();
    proxy.on('connect', (req, downstream, head) => {
      proxyTargets.push(req.url ?? '');
      proxyPeers.add(downstream as Socket);
      const upstream = createConnection({ host: '127.0.0.1', port: address.port }, () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(downstream);
        downstream.pipe(upstream);
      });
      proxyPeers.add(upstream);
      downstream.on('error', () => upstream.destroy());
      upstream.on('error', () => downstream.destroy());
      downstream.once('close', () => {
        proxyPeers.delete(downstream as Socket);
        upstream.destroy();
      });
      upstream.once('close', () => {
        proxyPeers.delete(upstream);
        downstream.destroy();
      });
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Proxy fixture missing');
    let application: ElectronApplication | undefined;
    try {
      const vault = new EncryptedVault(join(home, 'vault-v2'));
      let reference: string;
      try {
        await vault.open();
        reference = (
          await vault.put({
            kind: 'api-key',
            label: 'Pi fixture',
            secret: 'PRIVATE_PACKAGED_PI_KEY',
          })
        ).ref;
      } finally {
        await vault.close();
      }
      const profile = join(home, 'profiles/desktop');
      const probe = join(profile, 'node_modules/@fixture/pi-consumer');
      await mkdir(probe, { recursive: true });
      await writeFile(
        join(profile, 'package.json'),
        JSON.stringify({
          name: 'isolated-packaged-pi',
          private: true,
          axterm: {
            profile: {
              bundles: [...PROFILE_TEMPLATES.desktop!.bundles],
            },
          },
        }),
      );
      await writeFile(
        join(probe, 'package.json'),
        JSON.stringify({
          name: '@fixture/pi-consumer',
          version: '1.0.0',
          type: 'module',
          exports: './index.js',
          peerDependencies: { '@deepseek-ai/cordis': '*' },
        }),
      );
      await writeFile(
        join(probe, 'index.js'),
        `
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
export const inject=['engines','connections','aiController','runtimeIdentity'];
export async function apply(ctx,config){
 let stopped=false;let task;const lifetime=new AbortController();ctx.effect(()=>async()=>{stopped=true;lifetime.abort();await task;});
 task=(async()=>{
  await new Promise((resolve,reject)=>{
   let off=()=>{};let timer;
   const check=()=>{if(ctx.engines.list().some(engine=>engine.id==='pi'&&engine.state==='ready')){clearTimeout(timer);off();resolve();}};
   off=ctx.on('engines/changed',check);timer=setTimeout(()=>{off();reject(new Error('ENGINE_NOT_READY'));},5000);check();
   ctx.effect(()=>()=>{clearTimeout(timer);off();reject(new Error('ENGINE_CONSUMER_CLOSED'));});
  });
  if(stopped)throw new Error('ENGINE_CONSUMER_CLOSED');
  const session=await ctx.engines.openSession('pi',{sessionId:'fixture-session'});
  ctx.effect(()=>()=>session.close());
  try{
   const legacyEvents=[];const legacy=session.run({runId:'fixture-legacy-run',providerId:'application-legacy',model:'fixture-model',system:'Visible system',prompt:'Visible prompt',context:'',tools:false},{event:async event=>{legacyEvents.push(event);}},{configuration:{kind:'pi-provider-v1',providerId:'application-legacy',provider:{...config.binding,baseUrl:config.legacyBaseUrl,legacy:{apiPath:'/gateway/stream',auth:'x-api-key'},proxy:config.proxy}}});
   const legacyOutcome=await legacy.done;
   const events=[];const run=session.run({runId:'fixture-run',providerId:'fixture',model:'fixture-model',system:'Visible system',prompt:'Visible prompt',context:'',tools:false},{event:async event=>{events.push(event);}});
   const outcome=await run.done;
   const boundEvents=[];const bound=session.run({runId:'fixture-bound-run',providerId:'application-bound',model:'fixture-model',system:'Visible system',prompt:'Visible prompt',context:'',tools:false},{event:async event=>{boundEvents.push(event);}},{configuration:{kind:'pi-provider-v1',providerId:'application-bound',provider:config.binding}});
   const boundOutcome=await bound.done;
   const generation=ctx.runtimeIdentity.generation;
   const provider=ctx.aiController.createProvider(crypto.randomUUID(),generation,{name:'Packaged application',enabled:true,credentialRef:config.savedReference,baseUrl:config.binding.baseUrl});
   const model=ctx.aiController.createModel(crypto.randomUUID(),generation,{name:'Packaged model',providerId:provider.ids[0],model:'fixture-model',capabilities:['chat']});
   const runKey=crypto.randomUUID();const input={modelId:model.ids[0],useCase:'chat',prompt:'Packaged application request',context:''};
   const started=await ctx.aiController.startRun(runKey,generation,input,lifetime.signal);
   const deadline=Date.now()+8000;let applicationRun;
   for(;;){applicationRun=ctx.aiController.getRun(started.id);if(applicationRun.state==='succeeded')break;if(Date.now()>deadline||['failed','canceled','interrupted'].includes(applicationRun.state))throw new Error('APPLICATION_RUN_FAILED');await delay(20,undefined,{signal:lifetime.signal});}
   const replay=await ctx.aiController.startRun(runKey,generation,input,lifetime.signal);
   const applicationLog=ctx.aiController.getLog(started.id,{after:0,limit:100});
   if(replay.id!==started.id||applicationLog.hasMore||applicationLog.entries.length===0)throw new Error('APPLICATION_FACTS_INVALID');
   const unregister=ctx.engines.register('packaged-external',{label:'Packaged external fixture',capabilities:{cancellation:true,tools:false,resume:false},openSession:async()=>({run:async(_input,context)=>{await context.emit({type:'delta',text:'PACKAGED_EXTERNAL_RESULT'});await context.emit({type:'completed'});},close:async()=>{}})});ctx.effect(()=>unregister);
   const externalProvider=ctx.aiController.createProvider(crypto.randomUUID(),generation,{name:'External without HTTP or Vault',enabled:true,engineId:'packaged-external'});
   const externalModel=ctx.aiController.createModel(crypto.randomUUID(),generation,{name:'External model',providerId:externalProvider.ids[0],model:'external',capabilities:['chat']});
   const external=await ctx.aiController.startRun(crypto.randomUUID(),generation,{modelId:externalModel.ids[0],useCase:'chat',prompt:'External request',context:''},lifetime.signal);
   let externalRun;const externalDeadline=Date.now()+8000;
   for(;;){externalRun=ctx.aiController.getRun(external.id);if(externalRun.state==='succeeded')break;if(Date.now()>externalDeadline||['failed','canceled','interrupted'].includes(externalRun.state))throw new Error('EXTERNAL_RUN_FAILED');await delay(20,undefined,{signal:lifetime.signal});}
   const externalDetail=ctx.aiController.getProvider(externalProvider.ids[0]);
   if(externalDetail.baseUrl!==undefined||externalDetail.credentialRef!==undefined)throw new Error('EXTERNAL_TRANSPORT_PLACEHOLDER');
   await writeFile(config.journal,JSON.stringify({state:'done',outcome,events,boundOutcome,boundEvents,legacyOutcome,legacyEvents,applicationRun,applicationLog,externalRun}));
  }finally{await session.close();}
 })().catch(()=>writeFile(config.journal,JSON.stringify({state:'failed'})));
 await task;
}
`,
      );
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          {
            id: 'engine-pi',
            config: {
              providers: {
                fixture: {
                  provider: 'axterm-fixture',
                  api: 'openai-completions',
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  credentialRef: encodeOpaqueCredentialRef(reference!),
                  models: [{ id: 'fixture-model' }],
                  timeoutMs: 3000,
                },
              },
            },
          },
          {
            insert: [
              {
                id: 'pi-consumer',
                name: '@fixture/pi-consumer',
                config: {
                  journal,
                  savedReference: reference!,
                  legacyBaseUrl: `http://packaged-model.invalid:${address.port}/v1`,
                  proxy: { url: `http://127.0.0.1:${proxyAddress.port}` },
                  binding: {
                    provider: 'axterm-fixture',
                    api: 'openai-completions',
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                    credentialRef: encodeOpaqueCredentialRef(reference!),
                    models: [{ id: 'fixture-model' }],
                    timeoutMs: 3000,
                  },
                },
              },
            ],
          },
        ]),
      );
      application = await electron.launch({
        executablePath: join(appRoot, 'Contents/MacOS', binaryName!),
        args: [],
        cwd: home,
        timeout: 15000,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          HOME: home,
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      await expect
        .poll(
          async () => {
            try {
              return JSON.parse(await readFile(journal, 'utf8'));
            } catch {
              return undefined;
            }
          },
          { timeout: 12000 },
        )
        .toMatchObject({ state: 'done', outcome: { status: 'completed' } });
      const result = JSON.parse(await readFile(journal, 'utf8'));
      expect(result.events).toContainEqual({ type: 'delta', text: 'SOURCE_FREE_PI_RESULT' });
      expect(result.boundOutcome).toEqual({ status: 'completed' });
      expect(result.boundEvents).toContainEqual({ type: 'delta', text: 'SOURCE_FREE_PI_RESULT' });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_PACKAGED_PI_KEY');
      expect(result.legacyOutcome).toEqual({ status: 'completed' });
      expect(result.legacyEvents).toContainEqual({ type: 'delta', text: 'SOURCE_FREE_PI_RESULT' });
      expect(result.applicationRun).toMatchObject({
        state: 'succeeded',
        engineId: 'pi',
        result: 'SOURCE_FREE_PI_RESULT',
      });
      expect(result.externalRun).toMatchObject({
        state: 'succeeded',
        engineId: 'packaged-external',
        result: 'PACKAGED_EXTERNAL_RESULT',
      });
      expect(
        result.applicationLog.entries.some(
          (entry: { payload: { kind: string } }) => entry.payload.kind === 'output',
        ),
      ).toBe(true);
      expect(requests).toBe(4);
      expect(requestsSeen[0]).toEqual({
        path: '/v1/gateway/stream',
        key: 'PRIVATE_PACKAGED_PI_KEY',
        authorization: '',
      });
      expect(requestsSeen.slice(1).map((request) => request.path)).toEqual([
        '/v1/chat/completions',
        '/v1/chat/completions',
        '/v1/chat/completions',
      ]);
      expect(proxyTargets).toEqual([`packaged-model.invalid:${address.port}`]);
      expect(authorization).toBe('Bearer PRIVATE_PACKAGED_PI_KEY');
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      await (
        await application.firstWindow()
      )
        .locator('[data-axterm-product-workspace]')
        .waitFor({ timeout: 15000 });
    } finally {
      await closeProtocolFixture(application);
      const proxyDone = once(proxy, 'close');
      proxy.close();
      for (const peer of proxyPeers) peer.destroy();
      await proxyDone;
      const done = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await done;
      await rm(home, { recursive: true, force: true });
    }
  },
  45000,
);

it.skipIf(!packageResult || process.platform !== 'darwin')(
  'roundtrips configuration through authenticated file streams and generated commands in a source-free packaged Host',
  async () => {
    const record = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const appRoot = dirname(dirname(dirname(record.app)));
    const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
    const home = await mkdtemp(join(tmpdir(), 'axterm-l3-configuration-package-'));
    let application: ElectronApplication | undefined;
    try {
      await installConfigurationFrameFixture(home);
      application = await electron.launch({
        executablePath: join(appRoot, 'Contents/MacOS', binaryName!),
        args: [],
        cwd: home,
        timeout: 15000,
        env: {
          ...process.env,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          HOME: home,
          PATH: '/usr/bin:/bin',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      const page = await application.firstWindow({ timeout: 15000 });
      await page.locator('[data-configuration-state="ready"]').waitFor({ timeout: 15000 });
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      await page.locator('#configuration-roundtrip').click();
      await page.locator('[data-configuration-result="done"]').waitFor({ timeout: 15000 });
      expect(await page.locator('body').innerText()).not.toContain('PRIVATE_');
    } finally {
      await closeProtocolFixture(application);
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
