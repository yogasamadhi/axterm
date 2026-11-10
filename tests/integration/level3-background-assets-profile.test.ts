import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import * as Configuration from '../../packages/plugins/configuration/src/client/index.ts';
import type {} from '../../packages/infra/web-startup/src/index.ts';
import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import remote from '../../packages/plugins/files/lib/typert.remote-client.js';
import { FileGrantsModel } from '../../packages/plugins/files/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';

it('imports background chunks through actual Files authority, persists metadata and receipts, fences generations and authenticates binary HTTP', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-background-profile-'));
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  let model: FileGrantsModel | undefined;
  let unmount: (() => void | Promise<void>) | undefined;
  try {
    application = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: PROFILE_TEMPLATES,
      patchFiles: [],
      args: [],
      requiredServices: [
        'fileGrants',
        'fileImports',
        'filesController',
        'webStartup',
        'terminalController',
        'terminalFacts',
        'configuration',
      ],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const host = application.ctx;
    expect(host.get('desktopNative')).toBeUndefined();
    const origin = new URL(host.webStartup.url).origin;
    const token = (await readFile(host.webStartup.tokenFile!, 'utf8')).trim();
    const auth = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(auth.status).toBe(200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    const request = (input: string | URL, init: RequestInit) =>
      fetch(new URL(input, origin + '/'), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
      });
    client = new Context();
    await client.plugin(Registry);
    installConnection(client, {
      interactions: 'answer',
      transport: {
        streamBaseUrl: origin + '/',
        fetch: request,
        createWebSocket: (url) =>
          new WebSocket(url, { headers: { cookie, origin } }) as unknown as ConnectionWebSocket,
      },
    });
    await client.plugin(Gateway);
    unmount = await client.remote.$mount(remote);
    model = new FileGrantsModel(client, request);
    await vi.waitFor(() => expect(model!.getSnapshot().status).toBe('ready'));
    await client.plugin(Configuration);
    await client.plugin(Terminals);
    const assets = client.terminalAssetsModel;
    await vi.waitFor(() => expect(assets.getSnapshot().status).toBe('ready'));
    const state = assets.getSnapshot();
    if (state.status !== 'ready') throw Error('Assets not ready');
    const generation = state.baseline.generation;
    const png = new PNG({ width: 256, height: 128 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 31 + (i >> 8)) % 256;
    const bytes = PNG.sync.write(png, { deflateLevel: 0 });
    expect(bytes.length).toBeGreaterThan(65536);
    const imported = await model.importFile(
      new File([new Uint8Array(bytes).buffer], 'background.png'),
    );
    const key = randomUUID(),
      receipt = await assets.importAsset(key, imported.grantId, generation);
    expect(receipt.asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(receipt.asset.bytes).toBe(bytes.length);
    await model.revoke(imported.grantId);
    expect(await assets.importAsset(key, imported.grantId, generation)).toEqual(receipt);
    await vi.waitFor(() => {
      const current = assets.getSnapshot();
      expect(
        current.status === 'ready' &&
          current.baseline.assets.some((value) => value.id === receipt.asset.id),
      ).toBe(true);
    });
    const descriptor = await assets.content(receipt.asset.id, generation);
    expect(descriptor).toEqual({
      asset: receipt.asset,
      href: 'terminals/background-assets/' + receipt.asset.id,
    });
    const path = '/' + descriptor.href;
    expect((await fetch(origin + path)).status).toBe(401);
    const image = await request(path, {});
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('no-store');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    expect((await request(path + '?token=forbidden', {})).status).toBe(404);
    expect(
      await client.remote.terminals.deleteTerminalBackgroundAsset(
        randomUUID(),
        receipt.asset.id,
        1,
        randomUUID(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'terminals/failure', details: { reason: 'stale' } },
    });
    await vi.waitFor(() => expect(client!.settingsModel.getSnapshot().status).toBe('ready'));
    const current = client.settingsModel.getSnapshot();
    if (current.status !== 'ready') throw Error('Settings unavailable');
    const original = current.baseline.settings.terminal.visual.background;
    expect(application.ctx.get('terminalAssetReferences')).toBeDefined();
    await expect(
      client.settingsModel.updateSettings(
        randomUUID(),
        {
          terminal: {
            visual: {
              ...current.baseline.settings.terminal.visual,
              background: { ...original, kind: 'image', assetId: randomUUID() },
            },
          },
        },
        '"v' + current.baseline.settings.version + '"',
      ),
    ).rejects.toMatchObject({
      code: 'configuration/failure',
      details: { reason: 'invalid-input' },
    });
    expect(application.ctx.configuration.getSettings().version).toBe(
      current.baseline.settings.version,
    );

    const applied = await client.settingsModel.updateSettings(
      randomUUID(),
      {
        terminal: {
          visual: {
            ...current.baseline.settings.terminal.visual,
            background: { ...original, kind: 'image', assetId: receipt.asset.id },
          },
        },
      },
      '"v' + current.baseline.settings.version + '"',
    );
    await expect(
      assets.deleteAsset(randomUUID(), receipt.asset.id, 1, generation),
    ).rejects.toMatchObject({ code: 'terminals/failure', details: { reason: 'conflict' } });
    await client.settingsModel.updateSettings(
      randomUUID(),
      {
        terminal: {
          visual: { ...current.baseline.settings.terminal.visual, background: original },
        },
      },
      '"v' + applied.version + '"',
    );
    const deleted = await assets.deleteAsset(randomUUID(), receipt.asset.id, 1, generation);
    expect(deleted.id).toBe(receipt.asset.id);
    await vi.waitFor(() => {
      const current = assets.getSnapshot();
      expect(current.status === 'ready' && current.baseline.assets.length === 0).toBe(true);
    });
    expect((await request(path, {})).status).toBe(404);
    await model.dispose();
    model = undefined;
    await unmount();
    unmount = undefined;
    await client.fiber.dispose();
    client = undefined;
    await application.shutdown.shutdown(0);
    application = undefined;
  } finally {
    await model?.dispose();
    await unmount?.();
    await client?.fiber.dispose();
    await application?.shutdown.shutdown(0);
    await rm(home, { recursive: true, force: true });
  }
});
