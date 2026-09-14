import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const clients: Array<{ dispose(): void }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe('Runtime desktop window capability proxy', () => {
  it('keeps the Host token inside Runtime and exposes typed authenticated operations', async () => {
    const hostToken = 'host-token-that-must-never-reach-renderer-responses';
    const receivedAuthorization: Array<string | undefined> = [];
    const actions: string[] = [];
    const updaterActions: string[] = [];
    let updaterState = {
      state: 'available' as const,
      availableVersion: '0.11.0',
    };
    const state = {
      minimized: false,
      maximized: false,
      fullScreen: false,
      focused: true,
      visible: true,
      canMinimize: true,
      canMaximize: true,
      canClose: true,
    };
    const preferenceState = {
      preferences: {
        titleBarStyle: 'custom' as const,
        opacity: 1,
        zoomFactor: 1,
        bounds: null as null | { x: number; y: number; width: number; height: number },
        globalHotkey: 'Control+2',
        allowMultiInstance: false,
        confirmBeforeExit: false,
      },
      requiresRestart: false,
      globalHotkeyRegistered: true,
    };
    const host = createServer(async (request, response) => {
      receivedAuthorization.push(request.headers.authorization);
      if (request.headers.authorization !== `Bearer ${hostToken}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === 'GET' && request.url === '/host/v1/desktop/window') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(state));
        return;
      }
      if (request.method === 'GET' && request.url === '/host/v1/updater/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(updaterState));
        return;
      }
      if (request.method === 'POST' && request.url === '/host/v1/updater/actions') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action: string };
        updaterActions.push(input.action);
        updaterState = {
          state: 'available',
          availableVersion: '0.11.0',
        };
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(updaterState));
        return;
      }
      if (request.method === 'POST' && request.url === '/host/v1/desktop/window/actions') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action: string };
        actions.push(input.action);
        if (input.action === 'toggle-maximize') state.maximized = !state.maximized;
        if (input.action === 'toggle-fullscreen') state.fullScreen = !state.fullScreen;
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ accepted: true, state }));
        return;
      }
      if (request.method === 'GET' && request.url === '/host/v1/desktop/window/preferences') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(preferenceState));
        return;
      }
      if (request.method === 'PATCH' && request.url === '/host/v1/desktop/window/preferences') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<
          typeof preferenceState.preferences
        >;
        Object.assign(preferenceState.preferences, input);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(preferenceState));
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(host);
    host.listen(0, '127.0.0.1');
    await once(host, 'listening');
    const address = host.address() as AddressInfo;

    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'desktop',
      hostCapabilityUrl: `http://127.0.0.1:${address.port}`,
      hostCapabilityToken: hostToken,
    });
    runtimes.push(runtime);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    clients.push(client);

    expect((await fetch(`${runtime.baseUrl}/api/v1/desktop/window`)).status).toBe(401);
    const before = await client.windowStatus();
    expect(before.maximized).toBe(false);
    const result = await client.performWindowAction('toggle-maximize');
    expect(result).toMatchObject({ accepted: true, state: { maximized: true } });
    const fullScreen = await client.performWindowAction('toggle-fullscreen');
    expect(fullScreen).toMatchObject({ accepted: true, state: { fullScreen: true } });
    expect(await client.windowPreferences()).toEqual(preferenceState);
    expect(await client.updaterStatus()).toEqual({
      state: 'available',
      availableVersion: '0.11.0',
    });
    expect(await client.performUpdaterAction('download')).toEqual({
      state: 'available',
      availableVersion: '0.11.0',
    });
    expect(
      await client.updateWindowPreferences({
        opacity: 0.85,
        zoomFactor: 1.25,
        bounds: { x: 10, y: 20, width: 1180, height: 780 },
      }),
    ).toEqual({
      preferences: {
        titleBarStyle: 'custom',
        opacity: 0.85,
        zoomFactor: 1.25,
        bounds: { x: 10, y: 20, width: 1180, height: 780 },
        globalHotkey: 'Control+2',
        allowMultiInstance: false,
        confirmBeforeExit: false,
      },
      requiresRestart: false,
      globalHotkeyRegistered: true,
    });
    expect(actions).toEqual(['toggle-maximize', 'toggle-fullscreen']);
    expect(updaterActions).toEqual(['download']);
    expect(receivedAuthorization.length).toBeGreaterThanOrEqual(8);
    expect(
      receivedAuthorization.every((authorization) => authorization === `Bearer ${hostToken}`),
    ).toBe(true);
    expect(JSON.stringify({ before, result })).not.toContain(hostToken);
  });

  it('returns capability unavailable in headless mode', async () => {
    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
    });
    runtimes.push(runtime);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    clients.push(client);

    await expect(client.windowStatus()).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      status: 503,
    });
    await expect(client.windowPreferences()).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      status: 503,
    });
    await expect(client.updaterStatus()).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      status: 503,
    });
    await expect(client.performUpdaterAction('check')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      status: 503,
    });
  });
});
