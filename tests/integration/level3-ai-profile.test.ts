import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Ai from '../../packages/plugins/ai/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';

it('activates the actual AI Bundle, native Vault, generated faces and Pi, then retains facts across Profile replacement without replay', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-ai-profile-'));
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  let requests = 0;
  const listener = createServer((request, response) => {
    requests++;
    expect(request.headers.authorization).toBe('Bearer AI_PROFILE_FIXTURE_KEY');
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        piSseStart('openai-chat') +
          piSseText('openai-chat', 'Profile execution') +
          piSseEnd('openai-chat'),
      );
    });
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  const boot = () =>
    runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: {
        web: {
          bundles: [
            ...PROFILE_TEMPLATES.web!.bundles,
            '@axterm/bundle-engine-pi',
            '@axterm/bundle-ai',
          ],
        },
      },
      patchFiles: [],
      args: [],
      requiredServices: ['aiController', 'webStartup'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
  try {
    application = await boot();
    const host = application.ctx;
    const generation = host.runtimeIdentity.generation;
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
      transport: {
        streamBaseUrl: origin + '/',
        fetch: (input, init) =>
          fetch(new URL(input, origin + '/'), {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          }),
        createWebSocket: (url) =>
          new WebSocket(url, { headers: { cookie, origin } }) as unknown as ConnectionWebSocket,
      },
    });
    await client.plugin(Gateway);
    await client.plugin(Ai);
    await vi.waitFor(() => expect(client!.aiModel.getSnapshot().status).toBe('ready'));
    const credential = await host.configurationController.createCredential(
      randomUUID(),
      generation,
      {
        kind: 'aiApiKey',
        label: 'AI Profile fixture',
        secret: 'AI_PROFILE_FIXTURE_KEY',
      },
    );
    expect(credential.status).toBe('completed');
    const ref = credential.ref;
    const provider = await client.aiModel.createProvider(randomUUID(), {
      name: 'Profile provider',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      credentialRef: ref,
      enabled: true,
    });
    const model = await client.aiModel.createModel(randomUUID(), {
      name: 'Profile model',
      providerId: provider.ids[0]!,
      model: 'profile-fixture',
      capabilities: ['chat'],
    });
    const runKey = randomUUID();
    const run = await client.aiModel.startRun(runKey, {
      modelId: model.ids[0]!,
      useCase: 'chat',
      prompt: 'Profile request',
      context: '',
    });
    expect(await client.aiModel.getRunCommandOutcome(generation, runKey)).toEqual({
      status: 'accepted',
      id: run.id,
    });
    expect(await client.aiModel.getRunCommandOutcome(generation, randomUUID())).toEqual({
      status: 'missing',
    });
    await expect(client.aiModel.getRunCommandOutcome(randomUUID(), runKey)).rejects.toMatchObject({
      code: 'ai/failure',
    });
    const selected = await client.aiModel.openRun(run.id);
    await vi.waitFor(() => {
      expect(selected.getSnapshot().visible.run.state).toBe('succeeded');
      expect(selected.getSnapshot().visible.output).toBe('Profile execution');
    });
    expect(requests).toBe(1);
    const saved = await client.aiModel.getRun(run.id);
    await client.fiber.dispose();
    client = undefined;
    await application.shutdown.shutdown(0);
    application = undefined;
    application = await boot();
    expect(application.ctx.runtimeIdentity.generation).not.toBe(generation);
    expect(application.ctx.aiController.getRun(run.id)).toEqual(saved);
    expect(() =>
      application!.ctx.aiController.cancelRun(randomUUID(), generation, run.id),
    ).toThrow();
    expect(requests).toBe(1);
    const bytes = await readFile(join(home, 'data-v2/axterm.sqlite'));
    expect(bytes.includes(Buffer.from('AI_PROFILE_FIXTURE_KEY'))).toBe(false);
  } finally {
    await client?.fiber.dispose();
    await application?.shutdown.shutdown(0);
    const closed = once(listener, 'close');
    listener.close();
    listener.closeAllConnections();
    await closed;
    await rm(home, { recursive: true, force: true });
  }
});
