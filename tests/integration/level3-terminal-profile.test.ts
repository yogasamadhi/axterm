import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type {} from '@axterm/infra-web-startup';
import type {} from '../../packages/plugins/terminals/src/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import {
  installConnection,
  type ConnectionWebSocket,
  type ConnectionHandle,
} from '../../packages/infra/connection/src/client/index.ts';
import Registry from '@axterm/infra-typert-registry';
import * as ClientGateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import { TERMINAL_STREAM_PATH } from '@axterm/plugin-api/terminals';

it.skipIf(process.platform === 'win32')(
  'runs the real terminal Bundle with generated Remote, baseline/deltas, authenticated binary PTY and unload cleanup',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-profile-'));
    let application: Awaited<ReturnType<typeof runProfile>> | undefined;
    let client: Context | undefined;
    const sockets = new Set<WebSocket>();
    let terminalStream: Terminals.TerminalStream | undefined;
    try {
      const profile = join(home, 'profiles/web');
      await mkdir(profile, { recursive: true });
      await writeFile(
        join(profile, 'package.json'),
        JSON.stringify({
          name: 'isolated-terminal-profile',
          private: true,
          axterm: {
            profile: {
              bundles: ['@axterm/bundle-base', '@axterm/bundle-web', '@axterm/bundle-terminals'],
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
              shell: '/bin/sh',
              shellArgs: ['-f'],
              cwd: home,
              env: { HOME: home, HISTFILE: '/dev/null', ENV: '' },
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
        requiredServices: ['terminalController', 'desktopTaskInspection', 'webStartup'],
        prepare(ctx) {
          ctx.provide('webAssets', {
            index: resolve('apps/web/dist/index.html'),
            authenticationPage: resolve('apps/web/dist/auth.html'),
          });
        },
      });
      const host = application.ctx;
      expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
        active: false,
      });
      const origin = new URL(host.webStartup.url).origin;
      const tokenFile = host.webStartup.tokenFile!;
      const token = (await readFile(tokenFile, 'utf8')).trim();
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
        recovery: { backoffBaseMs: 10 },
        transport: {
          streamBaseUrl: origin + '/',
          fetch: (input, init) =>
            fetch(new URL(input, origin + '/'), {
              ...init,
              headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
            }),
          createWebSocket: (url) => {
            const ws = new WebSocket(url, { headers: { cookie, origin } });
            return ws as unknown as ConnectionWebSocket;
          },
        },
      });
      await client.plugin(ClientGateway);
      const modelOwner = client.plugin(Terminals);
      await modelOwner;
      const model = client.terminalsModel;
      const connection = client.get('connection') as unknown as ConnectionHandle;
      await vi.waitFor(() => expect(connection.generation.getSnapshot()).toBeDefined());
      const initialGeneration = connection.generation.getSnapshot()!;
      await vi.waitFor(() =>
        expect(model.getSnapshot()).toMatchObject({
          status: 'ready',
          baseline: { sessions: [], revision: 0 },
        }),
      );
      const key = randomUUID();
      const request = { kind: 'local' as const, cols: 80, rows: 24 };
      const first = await model.create(request, key);
      expect(await model.create(request, key)).toEqual(first);
      expect(host.terminals.resourceCount()).toBe(1);
      expect(await model.getCommandOutcome(host.runtimeIdentity.generation, key)).toEqual({
        status: 'accepted',
        id: first.id,
      });
      expect(await model.getCommandOutcome(host.runtimeIdentity.generation, randomUUID())).toEqual({
        status: 'missing',
      });
      await expect(model.create({ ...request, cols: 81 }, key)).rejects.toMatchObject({
        code: 'terminals/failure',
        details: { reason: 'conflict' },
      });
      await expect(model.close(first.id, randomUUID())).rejects.toMatchObject({
        code: 'terminals/failure',
        details: { reason: 'stale' },
      });
      await expect(model.getCommandOutcome(randomUUID(), key)).rejects.toMatchObject({
        code: 'terminals/failure',
        details: { reason: 'stale' },
      });
      expect(host.terminals.resourceCount()).toBe(1);
      const second = await model.create({ kind: 'local', cols: 80, rows: 24 });
      await vi.waitFor(() => {
        const state = model.getSnapshot();
        expect(
          state.status === 'ready' && state.baseline.sessions.map((session) => session.id),
        ).toEqual([first.id, second.id]);
      });
      expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
        active: true,
      });
      const full = await client.remote.terminals.getSnapshot();
      expect(full.ok).toBe(true);
      const endpoint =
        origin.replace('http:', 'ws:') +
        TERMINAL_STREAM_PATH +
        '?' +
        new URLSearchParams({ id: first.id, clientId: randomUUID() });
      const denied = new WebSocket(endpoint, { headers: { origin } });
      sockets.add(denied);
      await new Promise<void>((resolve, reject) => {
        denied.once('unexpected-response', (_req, response) => {
          expect(response.statusCode).toBe(401);
          response.resume();
          denied.terminate();
          resolve();
        });
        denied.on('error', () => {});
        denied.once('open', () => reject(new Error('Unauthenticated terminal stream opened')));
      });
      let output = '';
      const decoder = new TextDecoder();
      const controls: unknown[] = [];
      terminalStream = new Terminals.TerminalStream(connection, {
        terminalId: first.id,
        writer: {
          write(bytes, consumed) {
            output = (
              output + (typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true }))
            ).slice(-16_384);
            consumed();
          },
        },
        control: (control) => controls.push(control),
      });
      await vi.waitFor(() =>
        expect(controls).toContainEqual(expect.objectContaining({ type: 'ready' })),
      );
      expect(
        terminalStream.sendInput(
          "printf '\\101\\130\\124\\105\\122\\115\\137\\120\\124\\131\\137\\117\\113\\n'\r",
        ),
      ).toBe(true);
      await vi.waitFor(() => expect(output).toContain('AXTERM_PTY_OK'));
      expect(terminalStream.resize(100, 30)).toBe(true);
      expect(terminalStream.ping('controlled-probe')).toBe(true);
      await vi.waitFor(() =>
        expect(controls).toContainEqual({ type: 'pong', nonce: 'controlled-probe' }),
      );
      expect(terminalStream.metrics().receivedBytes).toBeGreaterThan(0);
      const before = model.getSnapshot();
      connection.reconnect();
      await vi.waitFor(() => {
        expect(connection.generation.getSnapshot()?.id).toBeGreaterThan(initialGeneration.id);
        const state = model.getSnapshot();
        expect(state.status).toBe('ready');
        expect(state).not.toBe(before);
        if (state.status === 'ready')
          expect(state.baseline.sessions.map((session) => session.id)).toEqual([
            first.id,
            second.id,
          ]);
      });
      expect(terminalStream.metrics().disposed).toBe(true);
      await model.close(first.id);
      await model.close(first.id);
      await model.close(second.id);
      await vi.waitFor(() =>
        expect(model.getSnapshot()).toMatchObject({ status: 'ready', baseline: { sessions: [] } }),
      );
      expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
        active: false,
      });
      expect(host.terminals.resourceCount()).toBe(0);
      await modelOwner.dispose();
      expect(() => model.subscribe(() => {})).toThrow('CLOSED');
      await client.fiber.dispose();
      client = undefined;
      await application.shutdown.shutdown(0);
      application = undefined;
      await expect(readFile(tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    } finally {
      terminalStream?.dispose();
      for (const socket of sockets) {
        socket.on('error', () => {});
        socket.terminate();
      }
      await client?.fiber.dispose();
      await application?.shutdown.shutdown(0);
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
