import { Context } from '@deepseek-ai/cordis';
import { DesktopRuntimeController } from '../../packages/plugins/desktop/src/index.ts';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { externalHttpUrlSchema } from '@axterm/plugin-api/desktop';
import { ShellExternalUrls } from '../../packages/infra/desktop-native/src/external-urls.ts';
import { DesktopExternalUrls } from '../../packages/plugins/desktop/src/external-urls.ts';
import { DesktopLinksClient } from '../../packages/plugins/desktop/src/client/external-urls.ts';
import type { RuntimeBaseline } from '@axterm/plugin-api';
it('accepts only bounded HTTP(S) targets and normalizes them without allowing native execution schemes', () => {
  expect(externalHttpUrlSchema.parse('HTTPS://EXAMPLE.COM')).toBe('https://example.com/');
  for (const input of [
    'not a url',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///tmp/file',
    'mailto:x@example.com',
    'https://example.com/\nanything',
    'https://example.com/' + 'a'.repeat(4096),
  ])
    expect(externalHttpUrlSchema.safeParse(input).success).toBe(false);
});
it('deduplicates exact native link requests, rejects a changed target and joins actual OS work during drain/close', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opener = vi.fn(async () => {
    await gate;
  });
  const owner = new ShellExternalUrls(opener),
    handlers = owner.handlers(),
    signal = new AbortController().signal,
    key = randomUUID();
  const first = handlers['externalUrl.open']({ key, url: 'https://example.invalid/a' }, signal);
  const second = handlers['externalUrl.open']({ key, url: 'https://example.invalid/a' }, signal);
  expect(() =>
    handlers['externalUrl.open']({ key, url: 'https://example.invalid/b' }, signal),
  ).toThrow();
  await vi.waitFor(() => expect(opener).toHaveBeenCalledOnce());
  let drained = false,
    closed = false;
  const drain = Promise.resolve(handlers['externalUrl.drain']({ key }, signal)).then(() => {
    drained = true;
  });
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(closed).toBe(false);
  release();
  await Promise.all([first, second, drain, closing]);
  expect(opener).toHaveBeenCalledOnce();
  expect(() =>
    handlers['externalUrl.open']({ key: randomUUID(), url: 'https://example.invalid/' }, signal),
  ).toThrow();
});
it('waits for the original native key after a canceled request instead of launching again', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = {
    open: vi.fn(async () => {
      throw { code: 'CANCELLED' };
    }),
    drain: vi.fn(async () => {
      await gate;
    }),
  };
  const owner = new DesktopExternalUrls(() => native),
    key = randomUUID();
  const opening = owner.open(key, 'https://example.invalid/', new AbortController().signal);
  const refused = expect(opening).rejects.toMatchObject({
    code: 'desktop/failure',
    details: { reason: 'uncertain' },
  });
  await vi.waitFor(() => expect(native.drain).toHaveBeenCalledWith(key));
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await refused;
  await closing;
  expect(native.open).toHaveBeenCalledOnce();
});
it('keeps Web opening in the original call stack and never uses the desktop native Remote', async () => {
  const invoke = vi.fn(),
    browser = vi.fn();
  const baseline: RuntimeBaseline = {
    type: 'baseline',
    health: { status: 'ok' },
    version: { apiVersion: 'v1', appVersion: 'test' },
    metadata: {
      runtimeId: randomUUID(),
      generation: randomUUID(),
      startedAt: new Date().toISOString(),
      pid: 1,
      mode: 'web',
      state: 'ready',
    },
  };
  const client = new DesktopLinksClient(() => ({ status: 'ready', baseline }), invoke, browser);
  const opening = client.openExternal('https://EXAMPLE.invalid');
  expect(browser).toHaveBeenCalledWith('https://example.invalid/');
  expect(invoke).not.toHaveBeenCalled();
  await opening;
  await client.close();
  await expect(client.openExternal('https://example.invalid')).rejects.toThrow('UNAVAILABLE');
});

it('fences old generations before native dispatch and refuses unavailable shell capability', async () => {
  const ctx = new Context(),
    generation = randomUUID();
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation,
    startedAt: new Date().toISOString(),
    pid: 1,
    mode: 'web',
    appVersion: 'test',
  });
  const controller = new DesktopRuntimeController(ctx);
  try {
    expect(() =>
      controller.openExternal(
        randomUUID(),
        randomUUID(),
        'https://example.invalid/',
        new AbortController().signal,
      ),
    ).toThrow();
    await expect(
      controller.openExternal(
        generation,
        randomUUID(),
        'https://example.invalid/',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'desktop/failure', details: { reason: 'unavailable' } });
    await expect(
      controller.openExternal(
        generation,
        randomUUID(),
        'file:///tmp/file',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'desktop/failure', details: { reason: 'invalid-input' } });
  } finally {
    await ctx.fiber.dispose();
  }
});
