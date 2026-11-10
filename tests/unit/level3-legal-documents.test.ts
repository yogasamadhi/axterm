import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { LegalDocuments } from '../../packages/plugins/configuration/src/legal.ts';
import { RuntimeLegalDocuments, runtimeLegalId } from '../../apps/desktop/src/shell/legal.ts';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(text = 'Axterm license · 许可\n'.repeat(6000)) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-legal-')),
    id = 'a'.repeat(24),
    bytes = Buffer.from(text),
    descriptor = {
      id,
      name: 'LICENSE',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ version: 1, documents: [descriptor] }),
  );
  await writeFile(join(directory, id + '.txt'), bytes);
  const owner = new LegalDocuments(directory);
  cleanups.push(async () => {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, id, text, descriptor, owner };
}
it('streams exact bounded UTF-8 package content and rejects arbitrary paths or changed content', async () => {
  const f = await fixture();
  expect(Object.isFrozen(f.owner.list())).toBe(true);
  let offset = 0,
    text = '';
  for await (const chunk of f.owner.read(f.id, new AbortController().signal)) {
    expect(chunk.offset).toBe(offset);
    expect(chunk.text.length).toBeLessThanOrEqual(32768);
    offset += chunk.text.length;
    text += chunk.text;
  }
  expect(text).toBe(f.text);
  await expect(
    f.owner.read('../LICENSE', new AbortController().signal)[Symbol.asyncIterator]().next(),
  ).rejects.toMatchObject({ code: 'configuration/failure' });
  await writeFile(join(f.directory, f.id + '.txt'), Buffer.alloc(f.descriptor.bytes, 120));
  await expect(
    (async () => {
      for await (const _chunk of f.owner.read(f.id, new AbortController().signal)) {
        /* Only complete verified content is published. */
      }
    })(),
  ).rejects.toMatchObject({ code: 'configuration/failure' });
});
it('cancels and joins actual admitted file IO when its owner unloads', async () => {
  const f = await fixture(),
    iterator = f.owner.read(f.id, new AbortController().signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);
  await f.owner.close();
  await expect(iterator.next()).rejects.toMatchObject({ code: 'configuration/failure' });
  expect(() => f.owner.list()).toThrow();
});
it('allows only two exact Shell documents and rejects credential/path/query/traversal variants', () => {
  expect(runtimeLegalId('axterm-app://app/desktop/licenses/electron')).toBe('electron');
  expect(runtimeLegalId('axterm-app://app/desktop/licenses/chromium')).toBe('chromium');
  for (const value of [
    'file:///etc/passwd',
    'axterm-app://user@app/desktop/licenses/electron',
    'axterm-app://app:80/desktop/licenses/electron',
    'axterm-app://app/desktop/licenses/electron?token=x',
    'axterm-app://app/desktop/licenses/electron#x',
    'axterm-app://app/desktop/licenses/unknown',
    'axterm-app://app/desktop/licenses/%2e%2e/LICENSE',
    'axterm-app://other/desktop/licenses/electron',
  ])
    expect(runtimeLegalId(value)).toBeUndefined();
});
it('serves sandboxed runtime documents without Host credentials and drains unconsumed responses', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'LICENSE'), 'Electron license');
  await writeFile(join(f.directory, 'LICENSES.chromium.html'), '<h1>Chromium notices</h1>');
  const owner = new RuntimeLegalDocuments({ directory: f.directory, packaged: false });
  cleanups.push(() => owner.close());
  const request = () => new Request('axterm-app://app/desktop/licenses/chromium');
  const response = await owner.serve(request(), new AbortController().signal);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toContain('sandbox');
  expect(response.headers.get('authorization')).toBeNull();
  expect(await response.text()).toContain('Chromium notices');
  const head = await owner.serve(
    new Request('axterm-app://app/desktop/licenses/electron', { method: 'HEAD' }),
    new AbortController().signal,
  );
  expect(await head.text()).toBe('');
  expect(head.headers.get('content-length')).toBe('16');
  const pending = await owner.serve(request(), new AbortController().signal);
  await owner.close();
  await pending.text().catch(() => undefined);
  expect((await owner.serve(request(), new AbortController().signal)).status).toBe(503);
});
