import { EventEmitter } from 'node:events';
import { ShellWindowPreferences } from '../../apps/desktop/src/shell/window-preferences.ts';
import { ShellPowerLifecycle } from '../../apps/desktop/src/shell/power-lifecycle.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import { nodeIpcWire, ShellVaultCapabilities } from '@axterm/infra-desktop-native';
import {
  createDesktopAuthentication,
  DESKTOP_AUTH_HEADER,
} from '../../packages/infra/connection/src/desktop-auth.ts';
import Registry from '@axterm/infra-typert-registry';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Desktop from '../../packages/plugins/desktop/src/client/index.ts';
import type { HostControl } from '../../apps/desktop-host/src/protocol.ts';
import { installFrameFixture } from '../support/level3-frame.ts';

function nextControl(child: ChildProcess, type: HostControl['type']): Promise<HostControl> {
  return new Promise((done, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exit);
    };
    const exit = () => {
      cleanup();
      reject(new Error('Desktop Host exited before control response'));
    };
    const message = (input: unknown) => {
      if (
        typeof input !== 'object' ||
        input === null ||
        !('kind' in input) ||
        input.kind !== 'axterm-desktop-control'
      )
        return;
      const value = input as HostControl;
      if (value.type === 'failed') {
        cleanup();
        reject(new Error(value.code));
      } else if (value.type === type) {
        cleanup();
        done(value);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Desktop Host control response timeout'));
    }, 8000);
    child.on('message', message);
    child.once('exit', exit);
  });
}
for (const runtime of ['node', 'electron'] as const)
  it(`runs the actual Desktop Host in ${runtime}, retains shell Vault ownership and drains authenticated Remote on shutdown`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-desktop-host-'));
    await installFrameFixture(home, 'desktop', { taskInspectionFailure: true });
    const auth = createDesktopAuthentication();
    const generation = auth.verifier.generation;
    const executable =
      runtime === 'node'
        ? process.execPath
        : (createRequire(resolve('apps/desktop/package.json'))('electron') as string);
    const child = spawn(
      executable,
      ['--expose-internals', resolve('apps/desktop-host/lib/index.js')],
      {
        env: {
          ...process.env,
          AXTERM_HOME: home,
          ...(runtime === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    const exited = new Promise<number | null>((done) => child.once('exit', done));
    const vault = new EncryptedVault(join(home, 'vault-v2'));
    const keys = new Set<string>();
    const windows = new ShellWindowPreferences({
      windows: () => [],
      focused: () => undefined,
      hotkeys: {
        register: (key) => {
          keys.add(key);
          return true;
        },
        unregister: (key) => {
          keys.delete(key);
        },
        isRegistered: (key) => keys.has(key),
      },
      displays: () => ({ primary: { x: 0, y: 0, width: 1440, height: 900 }, areas: [] }),
      activate: () => {},
      initialized: () => {},
    });
    const power = new ShellPowerLifecycle(new EventEmitter());
    const capabilities = new ShellVaultCapabilities(
      vault,
      nodeIpcWire(child),
      generation,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      windows,
      undefined,
      power,
    );

    const client = new Context();
    const diagnostics: string[] = [];
    child.stderr?.on('data', (value) => diagnostics.push(String(value)));
    child.stdout?.on('data', (value) => diagnostics.push(String(value)));
    try {
      const ready = nextControl(child, 'ready');
      child.send({
        kind: 'axterm-desktop-control',
        version: 1,
        generation,
        type: 'initialize',
        home,
        verifier: auth.verifier,
      });
      const message = await ready;
      if (message.type !== 'ready') throw new Error('Missing Host readiness');
      const origin = message.origin;
      expect((await fetch(origin)).status).toBe(401);
      const response = await fetch(origin, { headers: { [DESKTOP_AUTH_HEADER]: auth.credential } });
      expect(response.status).toBe(200);
      const index = await response.text();
      expect(index).toContain('__AXTERM_BOOT__');
      expect(index.includes(auth.credential)).toBe(false);
      expect(index.includes(auth.verifier.digest)).toBe(false);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect((await stat(join(home, 'vault-v2/master.key'))).isFile()).toBe(true);
      await expect(stat(join(home, 'profiles/desktop/launch'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await client.plugin(Registry);
      installConnection(client, {
        interactions: 'answer',
        transport: {
          streamBaseUrl: origin + '/',
          fetch: (input, init) =>
            fetch(new URL(input, origin + '/'), {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init.headers)),
                [DESKTOP_AUTH_HEADER]: auth.credential,
              },
            }),
          createWebSocket: (url) =>
            new WebSocket(url, {
              headers: { [DESKTOP_AUTH_HEADER]: auth.credential, origin },
            }) as unknown as ConnectionWebSocket,
        },
      });
      await client.plugin(Gateway);
      await client.plugin(Desktop);
      expect(await client.remote.desktop.health()).toEqual({ ok: true, value: { status: 'ok' } });
      await vi.waitFor(() => expect(client.desktopRuntimeModel.getSnapshot().status).toBe('ready'));
      const model = client.desktopRuntimeModel.getSnapshot();
      if (model.status !== 'ready') throw new Error('Runtime model not ready');
      expect(model.baseline.metadata.generation).toBe(generation);
      expect(model.baseline.metadata.mode).toBe('desktop');
      const inspect = nextControl(child, 'inspection');
      child.send({
        kind: 'axterm-desktop-control',
        version: 1,
        generation,
        type: 'inspect-quit',
        id: randomUUID(),
      });
      expect(await inspect).toMatchObject({ active: true, known: false });
      await client.fiber.dispose();
      const stopped = nextControl(child, 'stopped');
      child.send({ kind: 'axterm-desktop-control', version: 1, generation, type: 'shutdown' });
      await stopped;
      expect(await exited).toBe(0);
      expect(diagnostics.join('').includes(auth.credential)).toBe(false);
      await expect(
        readFile(join(home, 'profiles/desktop/launch/credential')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } catch (error) {
      throw new Error(
        `${String(error)}\n${diagnostics.join('')}`
          .replaceAll(auth.credential, '[redacted]')
          .replaceAll(auth.verifier.digest, '[redacted]'),
        { cause: error },
      );
    } finally {
      power.close();
      await client.fiber.dispose();
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      await capabilities.close();
      await vault.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);
