import { reconnectLevel3Client } from '../support/level3-reconnect.ts';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import { fileGrantSchema } from '@axterm/plugin-api/files';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as ClientGateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Catalog from '../../packages/plugins/catalog/src/client/index.ts';
import * as FilesClient from '../../packages/plugins/files/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';

it('runs the real Catalog Bundle and generated Remote with authenticated atomic Client projections and reconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-catalog-profile-'));
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  const sockets = new Set<WebSocket>();
  const wire: string[] = [];
  try {
    const profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'isolated-catalog-profile',
        private: true,
        axterm: {
          profile: {
            bundles: [
              '@axterm/bundle-base',
              '@axterm/bundle-web',
              '@axterm/bundle-catalog',
              '@axterm/bundle-files',
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
      requiredServices: ['catalog', 'catalogController', 'webStartup', 'files', 'fileImports'],
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
          socket.on('message', (data) => wire.push(data.toString()));
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(ClientGateway);
    await client.plugin(FilesClient);
    const owner = client.plugin(Catalog);
    await owner;
    const model = client.catalogModel;
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    const initial = model.getSnapshot();
    if (initial.status !== 'ready') throw new Error('Missing initial Catalog baseline');
    const key = randomUUID();
    const command = {
      host: { name: 'Remote destination', hostname: 'fixture.example', username: 'operator' },
      bookmark: { title: 'Remote destination' },
    };
    const receipt = await model.createSshBookmark(key, command, initial.baseline.bookmarks.etag);
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(state.status === 'ready' && state.baseline.cursor).toBe(receipt.cursor);
    });
    expect(await model.createSshBookmark(key, command, initial.baseline.bookmarks.etag)).toEqual(
      receipt,
    );
    await reconnectLevel3Client(client, sockets);
    await model.createHostGroup(randomUUID(), { name: 'After reconnect' });
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.hostGroups.some(({ name }) => name === 'After reconnect'),
      ).toBe(true);
    });
    expect(host.catalog.listHosts()).toHaveLength(1);
    const source = Array.from(
      { length: 100 },
      (_, index) => `Host imported-${index}\n User operator\n`,
    ).join('');
    const upload = await fetch(origin + '/api/files/import', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/octet-stream',
        'x-axterm-file-name': 'config',
        'x-axterm-file-size': String(Buffer.byteLength(source)),
      },
      body: source,
    });
    expect(upload.status).toBe(200);
    const grant = fileGrantSchema.parse(await upload.json());
    const prepared = await model.previewSshConfigImport({ grantId: grant.grantId });
    expect(prepared.summary.selected).toBe(100);
    const beforeImport = model.getSnapshot();
    if (beforeImport.status !== 'ready') throw new Error('Missing accepted Catalog facts');
    const importKey = randomUUID();
    const importInput = {
      previewId: prepared.previewId,
      groupId: null,
      items: prepared.items.flatMap((item) => (item.draft ? [item.draft] : [])),
    };
    const imported = await model.commitSshConfigImport(
      importKey,
      importInput,
      beforeImport.baseline.bookmarks.etag,
    );
    expect(imported.summary.imported).toBe(100);
    const report = await model.getSshConfigImportReport(imported.reportId);
    expect(report.createdHosts).toHaveLength(100);
    expect(JSON.stringify(report)).not.toContain(home);
    expect((await client.remote.files.revokeFileGrant(grant.grantId)).ok).toBe(true);
    await reconnectLevel3Client(client, sockets);
    expect(
      await model.commitSshConfigImport(
        importKey,
        importInput,
        beforeImport.baseline.bookmarks.etag,
      ),
    ).toEqual(imported);
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(state.status === 'ready' && state.baseline.hosts.length).toBe(101);
    });
    const canceled = new AbortController();
    canceled.abort();
    await expect(
      model.getSshConfigImportReport(imported.reportId, canceled.signal),
    ).rejects.toThrow();

    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((frame) => Buffer.byteLength(frame) <= 1024 * 1024)).toBe(true);
    expect(wire.join('')).not.toContain(token);
    await owner.dispose();
    await expect(model.createHostGroup(randomUUID(), { name: 'Closed' })).rejects.toThrow(
      'CATALOG_MODEL_CLOSED',
    );
  } finally {
    await client?.fiber.dispose();
    for (const socket of sockets) socket.terminate();
    await application?.shutdown.shutdown(0);
    await rm(home, { recursive: true, force: true });
  }
});
