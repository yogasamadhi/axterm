import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { credentialRef } from '@axterm/plugin-api/credentials';
import { engineRunInputSchema, type EngineEvent } from '@axterm/engine-api';
import type {} from '@axterm/engine-api/host';
import { piSseText, piSseEnd } from '../fixtures/pi-sse.ts';

it('loads the real Pi Bundle in an isolated headless Profile, runs built code and drains without replay on restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-pi-profile-'));
  const listener = createServer();
  let attempts = 0;
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  listener.on('request', (req, res) => {
    attempts++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (attempts === 1)
        res.end(piSseText('openai-chat', 'Built Pi result') + piSseEnd('openai-chat'));
      else {
        res.write(piSseText('openai-chat', 'partial'));
        res.once('close', () => closed.resolve());
        entered.resolve();
      }
    });
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const patch = join(home, 'pi.patch.json');
  await writeFile(
    patch,
    JSON.stringify([
      {
        id: 'engine-pi',
        config: {
          providers: {
            fixture: {
              provider: 'axterm-fixture',
              api: 'openai-completions',
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              credentialRef: 'PI_FIXTURE_KEY',
              models: [{ id: 'fixture-model' }],
              timeoutMs: 1000,
            },
          },
        },
      },
    ]),
  );
  const options = {
    profile: 'headless',
    home,
    installAnchor: resolve('apps/cli/package.json'),
    templates: { headless: { bundles: ['@axterm/bundle-base', '@axterm/bundle-engine-pi'] } },
    patchFiles: [patch],
    args: [],
    requiredServices: ['engines', 'credentials', 'desktopTaskInspection'],
  };
  let app: Awaited<ReturnType<typeof runProfile>> | undefined;
  try {
    app = await runProfile(options);
    const generation = app.ctx.runtimeIdentity.generation;
    expect(app.ctx.get('webStartup')).toBeUndefined();
    expect(app.ctx.engines.list()).toMatchObject([
      {
        id: 'pi',
        state: 'ready',
        capabilities: { cancellation: true, tools: true, resume: false },
      },
    ]);
    await app.ctx.credentials.set(credentialRef('PI_FIXTURE_KEY'), 'PROFILE_PRIVATE_KEY');
    const session = await app.ctx.engines.openSession('pi', { sessionId: 'application-session' });
    const events: EngineEvent[] = [];
    const request = engineRunInputSchema.parse({
      runId: 'app-run',
      providerId: 'fixture',
      model: 'fixture-model',
      system: 'Visible system',
      prompt: 'Visible user',
      context: '',
    });
    expect(
      await session.run(request, {
        event: async (event) => {
          events.push(event);
        },
      }).done,
    ).toEqual({ status: 'completed' });
    expect(events).toContainEqual({ type: 'delta', text: 'Built Pi result' });
    expect(await app.ctx.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: false,
    });
    const pending = session.run({ ...request, runId: 'cancelled-run' }, { event: async () => {} });
    await entered.promise;
    expect(await app.ctx.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: true,
    });
    await app.shutdown.shutdown(0);
    app = undefined;
    expect(await pending.done).toEqual({ status: 'cancelled' });
    await closed.promise;
    await expect(stat(join(home, 'profiles/headless/launch'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    app = await runProfile(options);
    expect(app.ctx.runtimeIdentity.generation).not.toBe(generation);
    expect(attempts).toBe(2);
    expect(await app.ctx.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: false,
    });
    await app.shutdown.shutdown(0);
    app = undefined;
  } finally {
    await app?.shutdown.shutdown(0);
    const done = once(listener, 'close');
    listener.close();
    listener.closeAllConnections();
    await done;
    await rm(home, { recursive: true, force: true });
  }
});
