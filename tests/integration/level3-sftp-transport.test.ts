import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type * as Ssh2 from 'ssh2';
import { expect, it } from 'vitest';
import { Ssh2Transport } from '../../packages/plugins/connections/src/adapters/ssh2/ssh2-transport.ts';
import { OwnedFileLease } from '../../packages/plugins/connections/src/adapters/file-lease.ts';
import { installSftpWire } from '../fixtures/sftp-wire.ts';
const ssh = createRequire(
  new URL('../../packages/plugins/connections/package.json', import.meta.url),
)('ssh2') as typeof Ssh2;
it('creates and closes an empty file over a real SFTP channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-sftp-transport-'));
  const peers = new Set<Ssh2.Connection>();
  const server = new ssh.Server(
    { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
    (peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.once('close', () => peers.delete(peer));
      peer.on('authentication', (request) => request.accept());
      peer.on('ready', () =>
        peer.on('session', (accept) =>
          accept().on('sftp', (approve) => installSftpWire(approve(), root)),
        ),
      );
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unbound');
  let handle: Awaited<ReturnType<Ssh2Transport['connect']>> | undefined;
  let lease: OwnedFileLease | undefined;
  try {
    handle = await new Ssh2Transport().connect({
      host: '127.0.0.1',
      port: address.port,
      username: 'fixture',
      password: 'fixture',
      connectionTimeoutMs: 3000,
      keepaliveIntervalMs: 0,
      keepaliveCountMax: 1,
      compression: false,
      algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
      verifyHostKey: async () => true,
      keyboardInteractive: async () => [],
    });
    lease = new OwnedFileLease(await handle.openSftp(), new AbortController().signal, () => {});
    const stream = lease.filesystem.writeStream('/empty', { flags: 'wx', mode: 0o600 });
    const closed = once(stream, 'close');
    stream.end(Buffer.alloc(0));
    await closed;
    expect(await readFile(join(root, 'empty'))).toHaveLength(0);
    const bytes = Buffer.alloc(1024 * 1024 + 513);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    await pipeline(
      Readable.from([bytes]),
      lease.filesystem.writeStream('/binary', { flags: 'wx', mode: 0o600 }),
    );
    await pipeline(
      Readable.from([Buffer.from('tail')]),
      lease.filesystem.writeStream('/binary', { flags: 'a', mode: 0o600 }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of lease.filesystem.readStream('/binary'))
      chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([bytes, Buffer.from('tail')]));
    const range: Buffer[] = [];
    for await (const chunk of lease.filesystem.readStream('/binary', { start: 11, end: 35 }))
      range.push(Buffer.from(chunk));
    expect(Buffer.concat(range)).toEqual(bytes.subarray(11, 36));
    await expect(
      pipeline(
        lease.filesystem.readStream('/absent'),
        lease.filesystem.writeStream('/failed', { flags: 'wx', mode: 0o600 }),
      ),
    ).rejects.toBeDefined();
    await lease.close();
    expect(lease.resourceCount()).toBe(0);
  } finally {
    await handle?.close();
    await lease?.close();
    for (const peer of peers) peer.end();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
