import type DesktopFileGrants from '../../packages/infra/desktop-native/src/file-grants.ts';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createManagedImportFixture } from '../support/level3-managed-import-fixture.ts';
import { AiHostCapabilities } from '../../packages/plugins/ai/src/adapters/host-capabilities.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await createManagedImportFixture();
  cleanups.push(() => f.close());
  f.ctx.provide('files', f.files);
  const ai = new AiHostCapabilities(f.ctx);
  cleanups.push(() => ai.close());
  return {
    ...f,
    grants: f.ctx.fileGrants as DesktopFileGrants,
    ai,
    async grant(name: string, bytes: Uint8Array) {
      const path = join(f.home, name);
      await writeFile(path, bytes);
      const grant = await f.capabilities.registry.createTrustedPath(path, 'file', ['read']);
      return { grant, path };
    },
  };
}
it('retains granted complete UTF-8 key text and the exact two MiB upper boundary through the actual Host owner', async () => {
  const f = await fixture(),
    contents = '-----BEGIN TEST KEY-----\n你好\n';
  const { grant } = await f.grant('valid.txt', Buffer.from(contents));
  expect(await f.ctx.fileGrants.readText(grant.grantId, 2 * 1024 * 1024)).toEqual({
    name: 'valid.txt',
    content: contents,
  });
  const full = await f.grant('boundary.txt', Buffer.alloc(2 * 1024 * 1024, 65));
  const result = await f.ctx.fileGrants.readText(full.grant.grantId, 2 * 1024 * 1024);
  expect(result.content.length).toBe(2 * 1024 * 1024);
  expect(result.content.startsWith('AAA')).toBe(true);
  expect(result.content.endsWith('AAA')).toBe(true);
  expect(f.files.resourceCount()).toBe(0);
  expect(f.grants.resourceCount()).toBe(0);
});
it('rejects oversized and malformed granted UTF-8 without returning content, modifying source or retaining leases', async () => {
  const f = await fixture();
  for (const [name, bytes, reason] of [
    ['oversized.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 65), 'capacity'],
    ['invalid.txt', Buffer.from([0xc3, 0x28]), 'invalid-input'],
  ] as const) {
    const { grant, path } = await f.grant(name, bytes);
    await expect(f.ctx.fileGrants.readText(grant.grantId, 2 * 1024 * 1024)).rejects.toMatchObject({
      code: 'files/failure',
      details: { reason },
    });
    expect(await readFile(path)).toEqual(bytes);
    expect(f.files.resourceCount()).toBe(0);
    expect(f.grants.resourceCount()).toBe(0);
  }
});
it('retains text sniffing and exact UTF-8 prefix truncation without a broken trailing code point through live Files leases', async () => {
  const f = await fixture(),
    prefix = await f.grant('prefix.txt', Buffer.from('alpha你好omega')),
    binary = await f.grant('binary.txt', Buffer.from([0x61, 0, 0x62]));
  expect(
    await f.ai.readGrantedTextPrefix(prefix.grant.grantId, 7, 100, new AbortController().signal),
  ).toEqual({
    name: 'prefix.txt',
    size: Buffer.byteLength('alpha你好omega'),
    content: 'alpha',
    includedBytes: 5,
    truncated: true,
  });
  await expect(
    f.ai.readGrantedTextPrefix(binary.grant.grantId, 50, 100, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  expect(f.ai.resourceCount()).toBe(0);
  expect(f.files.resourceCount()).toBe(0);
  expect(f.grants.resourceCount()).toBe(0);
});
