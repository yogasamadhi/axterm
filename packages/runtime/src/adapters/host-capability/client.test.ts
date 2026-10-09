import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostCapabilityClient } from './client';

describe('HostCapabilityClient granted text', () => {
  const grants = new Map<string, string>();
  const server = createServer((request, response) => {
    const match = /^\/host\/v1\/grants\/([^/]+)\/resolve$/.exec(request.url ?? '');
    const path = match?.[1] ? grants.get(decodeURIComponent(match[1])) : undefined;
    if (!path) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'GRANT_NOT_FOUND' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        grantId: match?.[1],
        kind: 'file',
        name: path.split('/').at(-1),
        permissions: ['read'],
        createdAt: new Date(0).toISOString(),
        path,
      }),
    );
  });
  let directory = '';
  let client: HostCapabilityClient;

  beforeAll(async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'axterm-granted-text-'));
    const files = {
      valid: Buffer.from('-----BEGIN TEST KEY-----\n你好\n'),
      prefix: Buffer.from('alpha你好omega'),
      binary: Buffer.from([0x61, 0, 0x62]),
      oversized: Buffer.alloc(2 * 1024 * 1024 + 1, 65),
      invalid: Buffer.from([0xc3, 0x28]),
    };
    for (const [id, contents] of Object.entries(files)) {
      const path = resolve(directory, `${id}.txt`);
      await writeFile(path, contents);
      grants.set(id, path);
    }
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    client = new HostCapabilityClient(`http://127.0.0.1:${address.port}`, 'test-token');
  });

  afterAll(async () => {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  });

  it('reads a bounded UTF-8 file selected through a host grant', async () => {
    await expect(client.readGrantedText('valid')).resolves.toEqual({
      name: 'valid.txt',
      content: '-----BEGIN TEST KEY-----\n你好\n',
    });
  });

  it('rejects oversized and invalid UTF-8 input without returning file contents', async () => {
    await expect(client.readGrantedText('oversized')).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });
    await expect(client.readGrantedText('invalid')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('sniffs text and decodes a bounded UTF-8 prefix without a broken trailing code point', async () => {
    await expect(client.readGrantedTextPrefix('prefix', 7, 100)).resolves.toEqual({
      name: 'prefix.txt',
      size: Buffer.byteLength('alpha你好omega'),
      content: 'alpha',
      includedBytes: 5,
      truncated: true,
    });
    await expect(client.readGrantedTextPrefix('binary', 50, 100)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });
});
