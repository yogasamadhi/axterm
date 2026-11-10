import { Context } from '@deepseek-ai/cordis';
import type {} from '../../packages/infra/web-startup/src/index.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import {
  installConnection,
  type ConnectionWebSocket,
  type ConnectionHandle,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import * as Settings from '../../packages/plugins/configuration/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';

it('runs generated terminal facts, actual isolated profile PTY options, history privacy and baseline replacement', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-facts-profile-'));
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  let channel: Terminals.TerminalStream | undefined;
  const sockets = new Set<WebSocket>();
  let socketOpens = 0;
  const windows = process.platform === 'win32';
  const shell = windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  const shellArgs = windows ? ['/d', '/q'] : ['-f'];
  try {
    const profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'isolated-terminal-facts-profile',
        private: true,
        axterm: {
          profile: {
            bundles: [
              '@axterm/bundle-base',
              '@axterm/bundle-web',
              '@axterm/bundle-configuration',
              '@axterm/bundle-terminals',
            ],
          },
        },
      }),
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        {
          id: 'terminals',
          config: {
            shell,
            shellArgs,
            cwd: home,
            env: { HOME: home, HISTFILE: windows ? 'NUL' : '/dev/null', ENV: '' },
            maxSessions: 2,
          },
        },
      ]),
    );
    application = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: {},
      patchFiles: [],
      args: [],
      requiredServices: ['terminalFacts', 'terminalController', 'configuration', 'webStartup'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const host = application.ctx;
    const origin = new URL(host.webStartup.url).origin;
    const token = (await readFile(host.webStartup.tokenFile!, 'utf8')).trim();
    const authenticated = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(authenticated.status).toBe(200);
    const cookie = authenticated.headers.get('set-cookie')!.split(';')[0]!;
    client = new Context();
    await client.plugin(Registry);
    installConnection(client, {
      interactions: 'answer',
      recovery: { backoffBaseMs: 10 },
      transport: {
        streamBaseUrl: origin + '/',
        fetch: (input, init) =>
          fetch(new URL(input, origin + '/'), {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          }),
        createWebSocket: (url) => {
          socketOpens++;
          const socket = new WebSocket(url, { headers: { cookie, origin } });
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(Gateway);
    await client.plugin(Settings);
    const owner = client.plugin(Terminals);
    await owner;
    const model = client.terminalFactsModel;
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    const receipt = await model.createTerminalProfile(randomUUID(), {
      name: 'Selected profile',
      shellArgs,
      fontSize: 18,
      fontFamily: 'monospace',
      env: { AXTERM_PROFILE_FIXTURE: 'PROFILE_ENV_OK' },
    });
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(state.status === 'ready' && state.baseline.profiles[0]?.id).toBe(receipt.ids[0]);
    });
    const settings = client.settingsModel.getSnapshot();
    if (settings.status !== 'ready') throw Error('Settings not ready');
    const defaultReceipt = await client.settingsModel.updateSettings(
      randomUUID(),
      { terminal: { defaultProfileId: receipt.ids[0]! } },
      '"v' + settings.baseline.settings.version + '"',
    );
    const terminal = await client.terminalsModel.create({
      kind: 'local',
      cols: 80,
      rows: 24,
    });
    expect(terminal).toMatchObject({
      profileId: receipt.ids[0],
      appearance: { fontSize: 18, fontFamily: 'monospace' },
    });
    const connection = client.get('connection') as unknown as ConnectionHandle;
    let output = '';
    const controls: unknown[] = [];
    const decoder = new TextDecoder();
    channel = new Terminals.TerminalStream(connection, {
      terminalId: terminal.id,
      writer: {
        write(bytes, done) {
          output = (
            output + (typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true }))
          ).slice(-16384);
          done();
        },
      },
      control: (value) => controls.push(value),
    });
    await vi.waitFor(() =>
      expect(controls).toContainEqual(expect.objectContaining({ type: 'ready' })),
    );
    expect(
      channel.sendInput(
        windows
          ? 'echo PROFILE_VALUE=%AXTERM_PROFILE_FIXTURE%\r'
          : 'printf "\\nPROFILE_VALUE=%s\\n" "$AXTERM_PROFILE_FIXTURE"\n',
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(output).toContain('PROFILE_VALUE=PROFILE_ENV_OK'));
    const input = {
      terminalId: terminal.id,
      source: 'shellIntegration' as const,
      command: 'printf OWNED_PROFILE_HISTORY',
    };
    expect(await model.recordCommandHistory(randomUUID(), input)).toMatchObject({
      recorded: false,
      reason: 'disabled',
    });
    await client.settingsModel.updateSettings(
      randomUUID(),
      { privacy: { commandHistoryEnabled: true } },
      '"v' + defaultReceipt.version + '"',
    );
    const key = randomUUID();
    const recorded = await model.recordCommandHistory(key, input);
    expect(recorded).toMatchObject({ recorded: true, count: 1 });
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(state.status === 'ready' && state.baseline.history.items[0]?.command).toBe(
        input.command,
      );
    });
    const ready = model.getSnapshot();
    if (ready.status !== 'ready') throw new Error('Missing terminal fact baseline');
    await expect(
      model.clearCommandHistory(randomUUID(), ready.baseline.history.etag, randomUUID()),
    ).rejects.toMatchObject({ code: 'terminals/failure', details: { reason: 'stale' } });
    await model.clearCommandHistory(randomUUID(), ready.baseline.history.etag);
    expect(await model.recordCommandHistory(key, input)).toEqual(recorded);
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(state.status === 'ready' && state.baseline.history.total).toBe(0);
    });
    const before = model.getSnapshot();
    const previousOpens = socketOpens;
    for (const socket of sockets) socket.terminate();
    await vi.waitFor(() => {
      expect(socketOpens).toBeGreaterThan(previousOpens);
      expect(model.getSnapshot()).not.toBe(before);
      expect(model.getSnapshot().status).toBe('ready');
    });
    await model.retry();
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    await client.terminalsModel.close(terminal.id);
    expect(host.terminals.resourceCount()).toBe(0);
    await owner.dispose();
    await expect(model.listCommandHistory()).rejects.toThrow('TERMINAL_FACTS_MODEL_CLOSED');
  } finally {
    channel?.dispose();
    await client?.fiber.dispose();
    for (const socket of sockets) {
      socket.on('error', () => {});
      socket.terminate();
    }
    await application?.shutdown.shutdown(0);
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
