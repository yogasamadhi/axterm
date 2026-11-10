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

it('uses the actual Web Profile local authority, authenticated body upload and generated file Client without an Electron shell', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-web-import-profile-'));
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
      requiredServices: ['fileGrants', 'fileImports', 'filesController', 'webStartup'],
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
    const directory = await model.create({ kind: 'home-directory' });
    expect(directory?.rootPath).toBe(join(home, 'workspace'));
    const imported = await model.importFile(new File(['actual Web body'], 'browser-file.txt'));
    expect((await model.readText(imported.grantId, 1024)).content).toBe('actual Web body');
    await vi.waitFor(() => {
      const state = model!.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.grants.some((row) => row.grantId === imported.grantId),
      ).toBe(true);
    });
    await model.revoke(imported.grantId);
    await expect(model.create({ kind: 'open-file' })).rejects.toMatchObject({
      code: 'files/failure',
      details: { reason: 'unavailable' },
    });
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
