import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server as SshServer, utils } from 'ssh2';
import { createCertificateIdentity } from './certificate-identity';
import { Ssh2Transport } from './ssh2-transport';

const execFile = promisify(execFileCallback);
let directory: string;
let privateKey: string;
let certificate: string;
let otherPrivateKey: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'axterm-certificate-'));
  const caPath = join(directory, 'ca');
  const userPath = join(directory, 'user');
  const otherPath = join(directory, 'other');
  await execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', caPath]);
  await execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'key-passphrase', '-f', userPath]);
  await execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', otherPath]);
  await execFile('ssh-keygen', [
    '-q',
    '-s',
    caPath,
    '-I',
    'axterm-test',
    '-n',
    'operator',
    '-V',
    '-1m:+1h',
    `${userPath}.pub`,
  ]);
  [privateKey, certificate, otherPrivateKey] = await Promise.all([
    readFile(userPath, 'utf8'),
    readFile(`${userPath}-cert.pub`, 'utf8'),
    readFile(otherPath, 'utf8'),
  ]);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('OpenSSH certificate identity', () => {
  it('combines the public certificate with its encrypted private signer', () => {
    const identity = createCertificateIdentity(privateKey, certificate, 'key-passphrase');
    const payload = Buffer.from('certificate-authentication-payload');
    const signature = identity.sign(payload);

    expect(identity.type).toBe('ssh-ed25519-cert-v01@openssh.com');
    expect(identity.isPrivateKey()).toBe(true);
    expect(signature).toBeInstanceOf(Buffer);
    expect(identity.verify(payload, signature)).toBe(true);
    expect(identity.getPrivatePEM()).toContain('PRIVATE KEY');
  });

  it('rejects a certificate paired with another signer or the wrong passphrase', () => {
    expect(() => createCertificateIdentity(otherPrivateKey, certificate)).toThrow('does not match');
    expect(() => createCertificateIdentity(privateKey, certificate, 'wrong')).toThrow(
      'valid private key',
    );
  });

  it('sends the certificate blob and a private-key signature over the SSH protocol', async () => {
    const requests: Array<{ algorithm: string; signed: boolean }> = [];
    const hostKey = utils.generateKeyPairSync('ed25519').private;
    const server = new SshServer({ hostKeys: [hostKey] }, (connection) => {
      connection.on('authentication', (context) => {
        if (
          context.method === 'publickey' &&
          context.key.algo === 'ssh-ed25519-cert-v01@openssh.com'
        ) {
          requests.push({ algorithm: context.key.algo, signed: !!context.signature });
          context.accept();
        } else context.reject(['publickey']);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('SSH certificate fixture did not bind');
    let handle;
    try {
      handle = await new Ssh2Transport().connect({
        host: '127.0.0.1',
        port: address.port,
        username: 'operator',
        privateKey,
        certificate,
        passphrase: 'key-passphrase',
        connectionTimeoutMs: 5_000,
        keepaliveIntervalMs: 0,
        keepaliveCountMax: 3,
        compression: false,
        algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
        verifyHostKey: async () => true,
        keyboardInteractive: async () => [],
      });
      expect(requests).toEqual([
        { algorithm: 'ssh-ed25519-cert-v01@openssh.com', signed: false },
        { algorithm: 'ssh-ed25519-cert-v01@openssh.com', signed: true },
      ]);
    } finally {
      await handle?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
