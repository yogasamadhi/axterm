import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
afterEach(async () => Promise.all(runtimes.splice(0).map((runtime) => runtime.close())));

describe('desktop deep-link Runtime ingress', () => {
  it('requires its generation token and delivers a single-use intent through the client API', async () => {
    const generation = randomUUID();
    const ingressToken = 'runtime-ingress-token';
    const runtime = await startRuntime({
      generation,
      appVersion: '0.10.0',
      mode: 'headless',
      runtimeIngressToken: ingressToken,
    });
    runtimes.push(runtime);
    const source = 'axterm://operator:temporary-secret@host.test:2323?type=telnet';
    const post = (token: string, requestGeneration = generation) =>
      fetch(`${runtime.baseUrl}/desktop/v1/deep-links`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Runtime-Generation': requestGeneration,
        },
        body: JSON.stringify({ source }),
      });

    expect((await post('wrong-token')).status).toBe(401);
    expect((await post(ingressToken, randomUUID())).status).toBe(401);
    const accepted = await post(ingressToken);
    expect(accepted.status).toBe(202);
    expect(JSON.stringify(await accepted.json())).not.toContain('temporary-secret');

    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    try {
      const intent = await client.nextDeepLinkIntent();
      expect(intent).toMatchObject({ status: 'ready', protocol: 'telnet', source });
      expect(await client.nextDeepLinkIntent()).toBeNull();
    } finally {
      client.dispose();
    }
  });
});
