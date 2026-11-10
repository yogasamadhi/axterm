import { Context } from '@deepseek-ai/cordis';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import * as Connection from '@axterm/infra-connection';
import type { HostConnectionService } from '../../packages/infra/connection/src/rpc-host.ts';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { ConfigurationPortableHttp } from '../../packages/plugins/configuration/src/adapters/portable-http.ts';
import {
  CONFIGURATION_EXPORT_PATH,
  CONFIGURATION_INSPECT_PATH,
  CONFIGURATION_PREVIEW_PATH,
  CONFIGURATION_MAX_FILE_BYTES,
} from '@axterm/plugin-api/configuration-portable';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  const generation = randomUUID();
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation,
    mode: 'headless',
    startedAt: new Date().toISOString(),
    pid: process.pid,
    appVersion: '0.10.0',
  });
  await ctx.plugin(MemoryCredentials);
  await ctx.plugin(Connection);
  const contents = Buffer.from('{"file":"' + 'x'.repeat(256 * 1024) + '"}');
  const inspect = vi.fn(async (bytes: Uint8Array) => ({
    appVersion: '0.10.0',
    exportedAt: new Date().toISOString(),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    entityCount: 0,
    issues: [],
    issueCount: 0,
    issuesTruncated: false,
  }));
  const preview = vi.fn(async () => {
    throw new Error('PRIVATE_PROVIDER_CANARY');
  });
  const route = new ConfigurationPortableHttp(ctx, generation, {
    exportContents: async () => contents,
    inspectContents: inspect,
    previewContents: preview,
  });
  cleanup.push(() => route.close());
  const service = ctx.connection as HostConnectionService;
  const handler = service.createSharedFetchHandler('/api');
  const request = (path: string, body?: BodyInit, headers: Record<string, string> = {}) => {
    const options: RequestInit & { duplex: 'half' } = {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-axterm-generation': generation,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
      duplex: 'half',
    };
    return handler.fetch(new Request('http://localhost' + path, options), service.browserPeer);
  };
  return { route, contents, inspect, preview, request, generation };
}
it('uses owned exact streaming routes with generation checks and bounded metadata, never generic Remote or legacy REST', async () => {
  const f = await fixture();
  const read = await f.request(CONFIGURATION_EXPORT_PATH);
  expect(read.headers.get('content-disposition')).toContain('axterm-configuration.json');
  expect(Buffer.from(await read.arrayBuffer())).toEqual(f.contents);
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('{'));
      controller.enqueue(Buffer.from('}'));
      controller.close();
    },
  });
  const inspected = await f.request(CONFIGURATION_INSPECT_PATH, input);
  expect(inspected.status).toBe(200);
  expect(await inspected.json()).toMatchObject({ bytes: 2, entityCount: 0 });
  expect(f.inspect).toHaveBeenCalledTimes(1);
  const stale = await f.request(CONFIGURATION_INSPECT_PATH, '{}', {
    'x-axterm-generation': randomUUID(),
  });
  expect(stale.status).toBe(410);
  expect(f.inspect).toHaveBeenCalledTimes(1);
  const invalid = await f.request(CONFIGURATION_PREVIEW_PATH, '{}', {
    'x-axterm-apply-settings': 'yes',
  });
  expect(invalid.status).toBe(400);
  expect(f.preview).not.toHaveBeenCalled();
  const rejected = await f.request(CONFIGURATION_PREVIEW_PATH, '{}', {
    'x-axterm-apply-settings': '0',
  });
  expect(rejected.status).toBe(503);
  expect(await rejected.text()).not.toContain('PRIVATE_PROVIDER_CANARY');
  expect((await f.request('/api/v1/configuration/export')).status).toBe(404);
  expect(f.route.resourceCount()).toBe(0);
});
it('cancels oversized bodies and drains all stalled uploads on unload without admitting more than four', async () => {
  const f = await fixture();
  let cancelled = 0;
  const oversize = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const refused = await f.request(CONFIGURATION_INSPECT_PATH, oversize, {
    'content-length': String(CONFIGURATION_MAX_FILE_BYTES + 1),
  });
  expect(refused.status).toBe(413);
  expect(cancelled).toBe(1);
  expect(f.inspect).not.toHaveBeenCalled();
  const bodies = Array.from(
    { length: 4 },
    () =>
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      }),
  );
  const requests = bodies.map((body) => f.request(CONFIGURATION_INSPECT_PATH, body));
  await vi.waitFor(() => expect(f.route.resourceCount()).toBe(4));
  expect((await f.request(CONFIGURATION_INSPECT_PATH, '{}')).status).toBe(413);
  await f.route.close();
  for (const result of await Promise.all(requests))
    expect((await result.json()).details.reason).toBe('cancelled');
  expect(cancelled).toBe(5);
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.route.resourceCount()).toBe(0);
  expect((await f.request(CONFIGURATION_EXPORT_PATH)).status).toBe(404);
});
it('owns an unconsumed export body until cancellation and closes its stream during unload', async () => {
  const f = await fixture();
  const response = await f.request(CONFIGURATION_EXPORT_PATH);
  expect(f.route.resourceCount()).toBe(1);
  await f.route.close();
  await expect(response.arrayBuffer()).rejects.toThrow('CONFIGURATION_STREAM_CANCELLED');
  expect(f.route.resourceCount()).toBe(0);
});
