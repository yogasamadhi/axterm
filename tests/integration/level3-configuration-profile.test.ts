import { reconnectLevel3Client } from '../support/level3-reconnect.ts';
import type {} from '@axterm/infra-web-startup';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
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
import * as ClientGateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Settings from '../../packages/plugins/configuration/src/client/index.ts';
import { ConfigurationPortableModel } from '../../packages/plugins/configuration/src/client/portable.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import {
  CONFIGURATION_EXPORT_PATH,
  CONFIGURATION_INSPECT_PATH,
  axtermConfigurationDocumentSchema,
} from '@axterm/plugin-api/configuration-portable';
import { axtermConfigurationDocumentSchema as frozenDocumentSchema } from '../fixtures/migration/generation2-contracts/schemas/axterm-configuration.ts';
import { hostSchema, createHostSchema } from '@axterm/plugin-api/catalog';
it('uses authenticated owned file routes, generated Remote and reconnecting preview models with the actual default Profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-configuration-profile-'));
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  let model: ConfigurationPortableModel | undefined;
  const sockets = new Set<WebSocket>();
  try {
    application = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: PROFILE_TEMPLATES,
      patchFiles: [],
      args: [],
      requiredServices: ['configurationPortable', 'webStartup'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const host = application.ctx;
    const origin = new URL(host.webStartup.url).origin;
    expect(
      (
        await fetch(origin + CONFIGURATION_EXPORT_PATH, {
          headers: { 'x-axterm-generation': host.runtimeIdentity.generation },
        })
      ).status,
    ).toBe(401);
    const token = (await readFile(host.webStartup.tokenFile!, 'utf8')).trim();
    const auth = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(auth.status).toBe(200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    let requests = 0;
    const authenticatedFetch = (input: string | URL, init: RequestInit) => {
      requests++;
      return fetch(new URL(input, origin + '/'), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
      });
    };
    client = new Context();
    await client.plugin(Registry);
    installConnection(client, {
      interactions: 'answer',
      recovery: { backoffBaseMs: 10 },
      transport: {
        streamBaseUrl: origin + '/',
        fetch: authenticatedFetch,
        createWebSocket(url) {
          const socket = new WebSocket(url, { headers: { cookie, origin } });
          sockets.add(socket);
          socket.on('error', () => {});
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(ClientGateway);
    await client.plugin(Settings);
    model = new ConfigurationPortableModel(client, authenticatedFetch);
    await vi.waitFor(() => expect(model!.getSnapshot().status).toBe('ready'));
    const exported = axtermConfigurationDocumentSchema.parse(
      JSON.parse(await (await model.exportDownload()).text()),
    );
    expect(frozenDocumentSchema.parse(exported)).toEqual(exported);
    const id = randomUUID();
    const now = new Date().toISOString();
    exported.data.hosts.push(
      hostSchema.parse({
        ...createHostSchema.parse({
          name: 'Imported through file HTTP',
          hostname: 'configuration.example.test',
          username: 'operator',
        }),
        id,
        createdAt: now,
        updatedAt: now,
        version: 1,
      }),
    );
    const file = new Blob([JSON.stringify(exported)], { type: 'application/json' });
    expect((await model.inspectUpload(file)).entityCount).toBe(1);
    const preview = await model.previewUpload(file, false);
    expect(preview.canCommit).toBe(true);
    await vi.waitFor(() => {
      const state = model!.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.previews.some((item) => item.previewId === preview.previewId),
      ).toBe(true);
    });
    await reconnectLevel3Client(client, sockets);
    await model.retry();
    await vi.waitFor(() => {
      const state = model!.getSnapshot();
      expect(state.status === 'ready' && state.baseline.previews[0]?.previewId).toBe(
        preview.previewId,
      );
    });
    const command = randomUUID();
    const result = await model.commit(command, preview.previewId);
    expect(result.counts.create).toBe(1);
    expect(await model.commit(command, preview.previewId)).toEqual(result);
    expect(host.catalog.listHosts()).toHaveLength(1);
    expect(host.catalog.listHosts()[0]!.id).not.toBe(id);
    await vi.waitFor(() => {
      const state = model!.getSnapshot();
      expect(state.status === 'ready' && state.baseline.previews.length).toBe(0);
    });
    const stale = await authenticatedFetch(CONFIGURATION_INSPECT_PATH, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'application/json', 'x-axterm-generation': randomUUID() },
    });
    expect(stale.status).toBe(410);
    const invalid = await authenticatedFetch(CONFIGURATION_INSPECT_PATH, {
      method: 'POST',
      body: '{"secret":"PRIVATE_INVALID_DOCUMENT_CANARY"',
      headers: {
        'content-type': 'application/json',
        'x-axterm-generation': host.runtimeIdentity.generation,
      },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('PRIVATE_INVALID_DOCUMENT_CANARY');
    const before = requests;
    await expect(
      model.inspectUpload(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)])),
    ).rejects.toMatchObject({ details: { reason: 'capacity' } });
    expect(requests).toBe(before);
    expect(host.connections.list()).toEqual([]);
    expect(host.terminals.list()).toEqual([]);
  } finally {
    await model?.dispose();
    await client?.fiber.dispose();
    for (const socket of sockets) socket.terminate();
    await application?.shutdown.shutdown(0);
    await rm(home, { recursive: true, force: true });
  }
});
