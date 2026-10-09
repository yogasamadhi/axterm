import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { AiProviderProtocol } from '@workspace/contracts';
import type { ModelEvent } from '../../ports/model-provider';
import { PiModelProvider } from './pi-provider';
import {
  piTestProvider,
  piSseStart,
  piSseText,
  piSseEnd,
  piSseHidden,
} from '../../../../../tests/fixtures/pi-sse';

const protocols: AiProviderProtocol[] = ['openai-chat', 'openai-responses', 'anthropic'];
async function fixture(handler: (response: ServerResponse) => void) {
  const server = createServer((_request, response) => handler(response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Protocol fixture did not listen');
  return {
    url: `http://127.0.0.1:${address.port}/v1/`,
    close: async () => {
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
    },
  };
}
const request = (signal: AbortSignal) => ({
  model: 'fixture',
  prompt: 'explicit review',
  context: 'bounded',
  system: 'safe role',
  signal,
});

describe.each(protocols)('%s provider lifecycle', (protocol) => {
  it('streams visible text and ignores private reasoning fields', async () => {
    const f = await fixture((response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        piSseStart(protocol) +
          piSseHidden(protocol) +
          piSseText(protocol, 'visible result') +
          piSseEnd(protocol),
      );
    });
    try {
      const events: ModelEvent[] = [];
      for await (const event of new PiModelProvider(
        piTestProvider(f.url, protocol),
        'fixture-secret',
        null,
      ).stream(request(new AbortController().signal)))
        events.push(event);
      expect(events).toContainEqual({ type: 'delta', text: 'visible result' });
      expect(JSON.stringify(events)).not.toContain('HIDDEN_REASONING_CANARY');
    } finally {
      await f.close();
    }
  });
  it('aborts a real partial HTTP stream after one visible event', async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const f = await fixture((response) => {
      response.on('close', closed);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(piSseStart(protocol) + piSseText(protocol, 'first'));
    });
    const controller = new AbortController();
    try {
      const iterator = new PiModelProvider(piTestProvider(f.url, protocol), 'fixture-secret', null)
        .stream(request(controller.signal))
        [Symbol.asyncIterator]();
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: { type: 'delta', text: 'first' },
      });
      controller.abort();
      await expect(iterator.next()).rejects.toThrow();
      await disconnected;
      await iterator.return?.();
    } finally {
      controller.abort();
      await f.close();
    }
  });
  it('fails a rejected stream without exposing upstream response bodies or auth values', async () => {
    const f = await fixture((response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end('{"error":"UPSTREAM_SECRET_CANARY"}');
    });
    try {
      const iterator = new PiModelProvider(
        piTestProvider(f.url, protocol),
        'AUTH_SECRET_CANARY',
        null,
      )
        .stream(request(new AbortController().signal))
        [Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow('Pi model provider request failed');
      await iterator.return?.();
    } finally {
      await f.close();
    }
  });
});
