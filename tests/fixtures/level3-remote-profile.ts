import type {} from '@axterm/infra-web-startup';
import { Context } from '@deepseek-ai/cordis';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import catalogRemote from '../../packages/plugins/catalog/lib/typert.remote-client.js';
import * as Configuration from '../../packages/plugins/configuration/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
/** Unwrap only the generated public transport union; never translate old endpoints or error DTOs. */
export async function remoteValue<T>(
  request: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<T> {
  const result = await request;
  if (!result.ok) throw result.error;
  return result.value;
}
/** Actual authenticated Profile + public Client models, confined to an existing private temporary home. */
export async function remoteProfile(
  home: string,
  options: { terminals?: boolean; application?: boolean } = {},
) {
  const suffix = relative(await realpath(tmpdir()), await realpath(home));
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`))
    throw Error('Private temporary Profile home required');
  const profile = join(home, 'profiles/web');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'isolated-retained-remote-profile',
      private: true,
      axterm: {
        profile: {
          bundles: options.application
            ? PROFILE_TEMPLATES.web!.bundles
            : [
                '@axterm/bundle-base',
                '@axterm/bundle-web',
                '@axterm/bundle-catalog',
                '@axterm/bundle-configuration',
                ...(options.terminals ? ['@axterm/bundle-terminals'] : []),
              ],
        },
      },
    }),
  );
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  const client = new Context(),
    sockets = new Set<WebSocket>();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await client.fiber.dispose();
      } finally {
        for (const socket of sockets) socket.terminate();
        await application?.shutdown.shutdown(0);
      }
    })());
  try {
    application = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: {},
      patchFiles: [],
      args: [],
      requiredServices: [
        'configurationController',
        'catalogController',
        'webStartup',
        ...(options.terminals ? ['terminalController', 'terminalFacts'] : []),
        ...(options.application ? ['aiController'] : []),
      ],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const origin = new URL(application.ctx.webStartup.url).origin;
    const token = (await readFile(application.ctx.webStartup.tokenFile!, 'utf8')).trim();
    const auth = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const cookie = auth.headers.get('set-cookie')?.split(';')[0];
    if (auth.status !== 200 || !cookie) throw Error('Profile authentication failed');
    const request = (input: string | URL, init: RequestInit) =>
      fetch(new URL(input, origin + '/'), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
      });
    await client.plugin(Registry);
    installConnection(client, {
      interactions: 'answer',
      recovery: { backoffBaseMs: 10 },
      transport: {
        streamBaseUrl: origin + '/',
        fetch: request,
        createWebSocket: (url) => {
          const socket = new WebSocket(url, { headers: { cookie, origin } });
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(Gateway);
    const unmountCatalog = await client.remote.$mount(catalogRemote);
    client.effect(() => unmountCatalog);
    await client.plugin(Configuration);
    await vi.waitFor(() => {
      if (client.settingsModel.getSnapshot().status !== 'ready')
        throw Error('Profile baseline unavailable');
    });
    return { application, client, close, request };
  } catch (error) {
    await close();
    throw error;
  }
}
