import { reconnectLevel3Client } from '../support/level3-reconnect.ts';
import type {} from '@axterm/infra-web-startup';
import { Context } from '@deepseek-ai/cordis';
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
} from '../../packages/infra/connection/src/client/index.ts';
import * as ClientGateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Settings from '../../packages/plugins/configuration/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import {
  Generation2Database as ProductDatabase,
  seedGeneration2History,
} from '../fixtures/migration/generation2-database.ts';

it('runs generated Settings Remote and Client models with the actual Catalog and Terminal history owners', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-settings-profile-'));
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  const sockets = new Set<WebSocket>();
  try {
    // Only an isolated fixture is upgraded in place here; production copying remains M7.
    await mkdir(join(home, 'data-v2'), { mode: 0o700 });
    const legacy = await ProductDatabase.open(join(home, 'data-v2/axterm.sqlite'));
    try {
      seedGeneration2History(legacy);
    } finally {
      legacy.close();
    }
    const profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'isolated-settings-profile',
        private: true,
        axterm: {
          profile: {
            bundles: [
              '@axterm/bundle-base',
              '@axterm/bundle-web',
              '@axterm/bundle-catalog',
              '@axterm/bundle-configuration',
            ],
          },
        },
      }),
    );
    application = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: {},
      patchFiles: [],
      args: [],
      requiredServices: ['configurationController', 'catalog', 'terminalHistory', 'webStartup'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const host = application.ctx;
    const previousHistory = host.terminalHistory.state();
    expect(
      host.catalogController.listConnectionHistory(host.runtimeIdentity.generation, {}).total,
    ).toBe(1);
    const origin = new URL(host.webStartup.url).origin;
    const token = (await readFile(host.webStartup.tokenFile!, 'utf8')).trim();
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
          const socket = new WebSocket(url, { headers: { cookie, origin } });
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(ClientGateway);
    const owner = client.plugin(Settings);
    await owner;
    const model = client.settingsModel;
    const credentials = client.savedCredentialsModel;
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(credentials.getSnapshot().status).toBe('ready'));
    const secret = 'SAVED_PROFILE_SECRET_CANARY';
    const action = credentials.create({ kind: 'sshPassword', label: 'Profile credential', secret });
    const created = await action.result;
    expect(created.status).toBe('completed');
    await vi.waitFor(() => {
      const state = credentials.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.credentials.some((item) => item.ref === created.ref),
      ).toBe(true);
      expect(JSON.stringify(state)).not.toContain(secret);
    });
    expect(await credentials.outcome(action.commandId)).toEqual(created);
    const duplicate = await client.remote.configuration.createCredential(
      action.commandId,
      created.generation,
      { kind: 'sshPassword', label: 'Changed', secret: 'DIFFERENT_SECRET' },
    );
    expect(duplicate).toMatchObject({
      ok: false,
      error: {
        code: 'configuration/credentials-failure',
        details: { reason: 'already-submitted' },
      },
    });
    const stale = await client.remote.configuration.replaceCredential(
      randomUUID(),
      randomUUID(),
      created.ref,
      'STALE_SECRET',
    );
    expect(stale).toMatchObject({ ok: false, error: { details: { reason: 'stale-generation' } } });
    const replaced = await credentials.replace(created.ref, 'REPLACED_PROFILE_SECRET').result;
    expect(replaced.status).toBe('completed');
    await reconnectLevel3Client(client, sockets);
    await credentials.retry();
    await vi.waitFor(() => expect(credentials.getSnapshot().status).toBe('ready'));
    expect((await credentials.remove(created.ref).result).status).toBe('completed');
    await vi.waitFor(() => {
      const state = credentials.getSnapshot();
      expect(state.status === 'ready' && state.baseline.credentials.length).toBe(0);
    });
    const initial = model.getSnapshot();
    if (initial.status !== 'ready') throw new Error('Missing settings baseline');
    expect(initial.baseline.settings.version).toBe(1);
    const key = randomUUID();
    const patch = {
      appearance: { language: 'ja' as const },
      privacy: { connectionHistoryEnabled: false, commandHistoryEnabled: false },
    };
    const receipt = await model.updateSettings(key, patch, '"v1"');
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(state.status === 'ready' && state.baseline.cursor).toBe(receipt.cursor);
    });
    expect(host.configuration.getSettings().appearance.language).toBe('ja');
    expect(
      host.catalogController.listConnectionHistory(host.runtimeIdentity.generation, {}).total,
    ).toBe(0);
    expect(host.terminalHistory.state().revision).toBe(previousHistory.revision + 1);
    expect(await model.updateSettings(key, patch, '"v1"')).toEqual(receipt);
    expect(host.terminalHistory.state().revision).toBe(previousHistory.revision + 1);
    await reconnectLevel3Client(client, sockets);
    await model.updateSettings(randomUUID(), { appearance: { language: 'en' } }, '"v2"');
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(state.status === 'ready' && state.baseline.settings.appearance.language).toBe('en');
    });
    await model.retry();
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    await owner.dispose();
    await expect(
      model.updateSettings(randomUUID(), { appearance: { theme: 'light' } }, '"v3"'),
    ).rejects.toThrow('SETTINGS_MODEL_CLOSED');
  } finally {
    await client?.fiber.dispose();
    for (const socket of sockets) {
      socket.on('error', () => {});
      socket.terminate();
    }
    await application?.shutdown.shutdown(0);
    await rm(home, { recursive: true, force: true });
  }
});
