import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import type { FileGrants, LocalFileLease } from '@axterm/plugin-api/host';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { AiHostCapabilities } from '../../packages/plugins/ai/src/adapters/host-capabilities.ts';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-ai-file-owner-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new NativeFileGrantRegistry(randomUUID());
  cleanups.push(() => registry.close());
  let released = 0;
  const live = new Map<AbortController, string>();
  const files = new GrantedStreamingFiles(() => ({
    authorize: async (id, permission, signal) => {
      const abort = new AbortController();
      live.set(abort, id);
      const lifetime = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
      const authority = await registry.authorize(id, permission, lifetime);
      let active = true;
      return {
        authority,
        signal: lifetime,
        assert: () => {
          if (!active || lifetime.aborted) throw new Error('grant canceled');
        },
        dispose: () => {
          if (active) {
            active = false;
            released++;
            live.delete(abort);
            abort.abort();
          }
        },
      };
    },
  }));
  cleanups.push(() => files.close());
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  ctx.provide('files', files);
  const revoke = vi.fn(async (id: string) => {
    registry.revoke(id);
    for (const [abort, key] of live) if (key === id) abort.abort();
  });
  ctx.provide('fileGrants', { revoke } as unknown as FileGrants);
  const host = new AiHostCapabilities(ctx);
  cleanups.push(() => host.close());
  const grant = async (bytes: Uint8Array | string) => {
    const path = join(directory, randomUUID() + '.txt');
    await writeFile(path, bytes);
    return { path, grant: await registry.createTrustedPath(path, 'file', ['read']) };
  };
  return { ctx, host, files, grant, revoke, released: () => released };
}
it('reads a bounded UTF-8 prefix through the real file owner and closes the authority without exposing its path', async () => {
  const f = await fixture();
  const source = await f.grant('aaaaaa😀tail');
  const value = await f.host.readGrantedTextPrefix(
    source.grant.grantId,
    8,
    100,
    new AbortController().signal,
  );
  expect(value).toMatchObject({ content: 'aaaaaa', includedBytes: 6, truncated: true });
  expect(JSON.stringify(value)).not.toContain(source.path);
  expect(f.released()).toBe(1);
  expect(f.files.resourceCount()).toBe(0);
  expect(f.host.resourceCount()).toBe(0);
  await f.host.revokeGrant(source.grant.grantId);
  expect(f.revoke).toHaveBeenCalledWith(source.grant.grantId, expect.anything());
  expect(await readFile(source.path, 'utf8')).toBe('aaaaaa😀tail');
});
it('rejects binary, invalid UTF-8, empty and oversized sources while releasing every real lease', async () => {
  const f = await fixture();
  for (const bytes of [
    Buffer.from([65, 0, 66]),
    Buffer.from([0xc3, 0x28]),
    Buffer.alloc(0),
    Buffer.alloc(101, 65),
  ]) {
    const source = await f.grant(bytes);
    await expect(
      f.host.readGrantedTextPrefix(source.grant.grantId, 50, 100, new AbortController().signal),
    ).rejects.toThrow();
    expect(await readFile(source.path)).toEqual(bytes);
    expect(f.files.resourceCount()).toBe(0);
  }
  expect(f.released()).toBe(4);
  expect(f.host.resourceCount()).toBe(0);
});
it('joins a canceled late file lease before closing and never returns its previously authorized bytes', async () => {
  const f = await fixture();
  const source = await f.grant('late private text');
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.ctx.set('files', {
    open: async (id: string, permission: 'read', signal?: AbortSignal): Promise<LocalFileLease> => {
      const lease = await f.files.open(id, permission, signal);
      ready.resolve();
      await release.promise;
      return lease;
    },
  });
  const pending = f.host.readGrantedTextPrefix(
    source.grant.grantId,
    50,
    100,
    new AbortController().signal,
  );
  void pending.catch(() => {});
  await ready.promise;
  let closed = false;
  const close = f.host.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.host.resourceCount()).toBe(1);
  release.resolve();
  await expect(pending).rejects.toThrow();
  await close;
  expect(f.files.resourceCount()).toBe(0);
  expect(f.released()).toBe(1);
  expect(f.host.resourceCount()).toBe(0);
});
it('keeps a late credential resolution owned until it settles and refuses to return its value after cancellation', async () => {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  const resolved = Promise.withResolvers<{ value: string }>();
  const resolve = vi.fn(() => resolved.promise);
  ctx.provide('credentials', { resolve });
  const host = new AiHostCapabilities(ctx);
  cleanups.push(() => host.close());
  const pending = host.resolveCredential('existing-reference');
  void pending.catch(() => {});
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  let closed = false;
  const close = host.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  resolved.resolve({ value: 'LATE_PRIVATE_KEY' });
  await expect(pending).rejects.toThrow();
  await close;
  expect(host.resourceCount()).toBe(0);
});

it('retains failed grant revocation and retries the actual authority cleanup before reporting a successful close', async () => {
  const f = await fixture();
  const source = await f.grant('controlled text');
  f.revoke.mockRejectedValueOnce(new Error('controlled revoke failure'));
  await expect(f.host.revokeGrant(source.grant.grantId)).rejects.toThrow('could not be revoked');
  expect(f.host.resourceCount()).toBe(1);
  await f.host.close();
  expect(f.revoke).toHaveBeenCalledTimes(2);
  expect(f.host.resourceCount()).toBe(0);
});
