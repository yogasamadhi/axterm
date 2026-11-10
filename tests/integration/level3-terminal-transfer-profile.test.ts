import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { TerminalTransferAction } from '@axterm/plugin-api/terminals';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import Registry from '@axterm/infra-typert-registry';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import {
  installConnection,
  type ConnectionWebSocket,
  type ConnectionHandle,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import type {} from '@axterm/infra-web-startup';
import type {} from '../../packages/plugins/terminals/src/index.ts';
it.skipIf(process.platform === 'win32').each([
  ['xmodem', 'download'],
  ['xmodem', 'upload'],
  ['zmodem', 'download'],
  ['zmodem', 'upload'],
  ['trzsz', 'download'],
  ['trzsz', 'upload'],
] as const)(
  '%s %s through authenticated generated Remote, real PTY and Files authority',
  async (protocol, direction) => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-transfer-profile-'));
    let app: Awaited<ReturnType<typeof runProfile>> | undefined,
      client: Context | undefined,
      stream: Terminals.TerminalStream | undefined;
    const sockets = new Set<WebSocket>(),
      output: string[] = [];
    try {
      const source = join(home, 'source.bin'),
        bytes = Buffer.alloc(8192, 0xa5);
      bytes.set([0, 255, 1, 13, 10]);
      await writeFile(source, bytes);
      const profile = join(home, 'profiles/web');
      await mkdir(profile, { recursive: true });
      await writeFile(
        join(profile, 'package.json'),
        JSON.stringify({
          name: 'owned-terminal-protocol-profile',
          private: true,
          axterm: {
            profile: {
              bundles: [
                '@axterm/bundle-base',
                '@axterm/bundle-web',
                '@axterm/bundle-terminals',
                '@axterm/bundle-files',
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
              stagingDirectory: join(profile, 'terminal-stages'),
              shell: process.execPath,
              shellArgs: [
                resolve(
                  `packages/plugins/terminals/tests/terminal-transfer/fixtures/${protocol}-peer.mjs`,
                ),
                direction === 'download' ? source : join(home, 'received.bin'),
                direction === 'download' ? 'send' : 'receive',
              ],
              cwd: home,
              env: { HOME: home, HISTFILE: '/dev/null' },
              maxSessions: 2,
            },
          },
        ]),
      );
      app = await runProfile({
        profile: 'web',
        home,
        installAnchor: resolve('apps/cli/package.json'),
        templates: {},
        patchFiles: [],
        args: [],
        requiredServices: ['terminalController', 'filesController', 'webStartup'],
        prepare(ctx) {
          ctx.provide('webAssets', {
            index: resolve('apps/web/dist/index.html'),
            authenticationPage: resolve('apps/web/dist/auth.html'),
          });
        },
      });
      const host = app.ctx,
        origin = new URL(host.webStartup.url).origin,
        token = (await readFile(host.webStartup.tokenFile!, 'utf8')).trim();
      const auth = await fetch(origin + '/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(auth.status).toBe(200);
      const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
      client = new Context();
      await client.plugin(Registry);
      installConnection(client, {
        interactions: 'answer',
        transport: {
          streamBaseUrl: origin + '/',
          fetch: (input, init) =>
            fetch(new URL(input, origin + '/'), {
              ...init,
              headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
            }),
          createWebSocket: (url) => {
            const ws = new WebSocket(url, { headers: { cookie, origin } });
            sockets.add(ws);
            ws.once('close', () => sockets.delete(ws));
            return ws as unknown as ConnectionWebSocket;
          },
        },
      });
      await client.plugin(Gateway);
      await client.plugin(Terminals);
      const model = client.terminalsModel;
      await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
      const terminal = await model.create({ kind: 'local', cols: 80, rows: 24 });
      await vi.waitFor(async () =>
        expect(
          await client!.remote.terminals.getTerminalTransfer(
            host.runtimeIdentity.generation,
            terminal.id,
          ),
        ).toMatchObject({ ok: true, value: null }),
      );
      const connection = client.get('connection') as unknown as ConnectionHandle;
      stream = new Terminals.TerminalStream(connection, {
        terminalId: terminal.id,
        writer: {
          write(value, consumed) {
            output.push(typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
            consumed();
          },
        },
      });
      const readiness =
        protocol === 'trzsz' ? 'AXTERM_PEER_READY' : `AXTERM_${protocol.toUpperCase()}_READY`;
      await vi.waitFor(() =>
        expect(output.join('')).toContain(
          readiness + '_' + (direction === 'download' ? 'SEND' : 'RECEIVE'),
        ),
      );
      let grant;
      if (direction === 'download')
        grant = await host.fileGrants.create({ kind: 'downloads-directory' });
      else {
        const selected = await host.fileImports.prepare(
          { name: 'upload.bin', size: bytes.length, editable: false },
          new AbortController().signal,
        );
        const lease = await host.files.open(selected.grantId, 'write');
        try {
          await lease.write(lease.path, Readable.from([bytes]));
        } finally {
          await lease.close();
        }
        grant = await host.fileImports.commit(selected.grantId, new AbortController().signal);
      }
      expect(grant).toBeDefined();
      if (protocol !== 'xmodem' || direction !== 'upload')
        host.terminals.insertText(terminal.id, '!');
      let input: TerminalTransferAction;
      if (protocol === 'xmodem')
        input = {
          action: 'start',
          protocol,
          direction,
          grantId: grant!.grantId,
          ...(direction === 'download' ? { fileName: 'download.bin' } : {}),
        };
      else {
        await vi.waitFor(() => {
          const current = model.getSnapshot();
          expect(current.status === 'ready' && current.baseline.sessions[0]?.transfer?.state).toBe(
            'waiting-selection',
          );
        });
        const current = model.getSnapshot();
        if (current.status !== 'ready') throw Error('MODEL_NOT_READY');
        input = {
          action: 'provide-selection',
          protocol,
          grantId: grant!.grantId,
          runId: current.baseline.sessions[0]!.transfer!.runId!,
        };
      }
      const key = randomUUID();
      const accepted = await model.performTransfer(
        key,
        terminal.id,
        input,
        new AbortController().signal,
      );
      expect(accepted.protocol).toBe(protocol);
      if (protocol === 'xmodem' && direction === 'upload')
        host.terminals.insertText(terminal.id, '!');
      expect(
        await model.performTransfer(key, terminal.id, input, new AbortController().signal),
      ).toEqual(accepted);
      await vi.waitFor(
        () =>
          expect(model.getSnapshot()).toMatchObject({
            status: 'ready',
            baseline: {
              sessions: [
                expect.objectContaining({
                  id: terminal.id,
                  transfer: expect.objectContaining({ state: 'completed' }),
                }),
              ],
            },
          }),
        { timeout: 5000 },
      );
      expect(
        await readFile(
          direction === 'upload'
            ? join(home, 'received.bin')
            : join(home, 'downloads', protocol === 'xmodem' ? 'download.bin' : 'source.bin'),
        ),
      ).toEqual(bytes);
      await host.fileGrants.revoke(grant!.grantId);
      await model.close(terminal.id);
      stream.dispose();
      stream = undefined;
      expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
        active: false,
      });
    } finally {
      stream?.dispose();
      if (client) await client.fiber.dispose();
      for (const socket of sockets) socket.terminate();
      if (app) await app.shutdown.shutdown(0);
      await rm(home, { recursive: true, force: true });
    }
  },
);
