import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Settings from '../../packages/plugins/configuration/src/client/index.ts';
import * as Files from '../../packages/plugins/files/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
it('imports a real owner-streamed file through authenticated Remote into local Vault and keeps only metadata in Client facts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-granted-credential-'));
  let app: Awaited<ReturnType<typeof runProfile>> | undefined, client: Context | undefined;
  const sockets = new Set<WebSocket>();
  const networkFetch = globalThis.fetch;
  try {
    app = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: PROFILE_TEMPLATES,
      patchFiles: [],
      args: [],
      requiredServices: ['configurationController', 'fileImports', 'webStartup'],
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
    const connected = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(connected.status).toBe(200);
    const cookie = connected.headers.get('set-cookie')!.split(';')[0]!;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      networkFetch(
        new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          origin + '/',
        ),
        { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie } },
      ),
    );
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
          const socket = new WebSocket(url, { headers: { cookie, origin } });
          sockets.add(socket);
          socket.on('error', () => {});
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(Gateway);
    await client.plugin(Files);
    await client.plugin(Settings);
    await vi.waitFor(() =>
      expect(client!.savedCredentialsModel.getSnapshot().status).toBe('ready'),
    );
    const secret = 'PRIVATE_STREAMED_KEY_CANARY';
    const grant = await client.fileGrantActions.importFile(
      new File([secret], 'selected-key.pem', { type: 'application/octet-stream' }),
    );
    const submission = client.savedCredentialActions.submitFromGrant({
      kind: 'privateKey',
      label: 'Selected SSH key',
      grantId: grant.grantId,
    });
    const receipt = await submission.result;
    expect(receipt.status).toBe('completed');
    expect(receipt.ref).toMatch(/^cred_/u);
    expect(receipt.ref).not.toBe(grant.grantId);
    expect(submission.generation).toBe(host.runtimeIdentity.generation);
    expect(await host.credentials.resolve(encodeOpaqueCredentialRef(receipt.ref))).toMatchObject({
      value: secret,
    });
    expect(await client.savedCredentialActions.outcome(submission.commandId)).toEqual(receipt);
    await vi.waitFor(() => {
      const state = client!.savedCredentialsModel.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.credentials.some((value) => value.ref === receipt.ref),
      ).toBe(true);
    });
    expect(JSON.stringify(client.savedCredentialsModel.getSnapshot())).not.toContain(secret);
    expect(JSON.stringify(receipt)).not.toContain(secret);
    await client.fileGrantActions.revoke(grant.grantId);
    const refused = await client.savedCredentialActions.submitFromGrant({
      kind: 'privateKey',
      label: 'Revoked source',
      grantId: grant.grantId,
    }).result;
    expect(refused).toMatchObject({ status: 'failed', reason: 'invalid-input' });
    expect((await host.credentials.saved!.list()).map((value) => value.ref)).toEqual([receipt.ref]);
  } finally {
    for (const socket of sockets) socket.terminate();
    await client?.fiber.dispose();
    await app?.shutdown.shutdown(0);
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
