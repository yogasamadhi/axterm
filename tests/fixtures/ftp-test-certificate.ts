import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { promisify } from 'node:util';

let context: Promise<SecureContext> | undefined;
let certificate: Promise<{ key: Buffer; cert: Buffer }> | undefined;
/** Test-only OpenSSL prerequisite; ephemeral keys never enter source, logs or user home. */
export function getFtpTestSecureContext(): Promise<SecureContext> {
  return (context ??= getFtpTestCertificate().then((value) => createSecureContext(value)));
}
export function getFtpTestCertificate(): Promise<{ key: Buffer; cert: Buffer }> {
  return (certificate ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-ftp-tls-fixture-'));
    try {
      const key = join(directory, 'key.pem');
      const cert = join(directory, 'cert.pem');
      await promisify(execFile)(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-subj',
          '/CN=localhost',
          '-days',
          '2',
          '-addext',
          'subjectAltName=IP:127.0.0.1,DNS:localhost',
        ],
        { timeout: 5000 },
      );
      return { key: await readFile(key), cert: await readFile(cert) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })());
}
