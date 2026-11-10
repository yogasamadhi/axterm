import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
interface Metadata {
  ref: string;
  kind: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  storage: 'local';
}
/** Historical format input writer, derived from the frozen Axterm generation 2 Vault.
 * Only test fixtures import this writer. No reads, updates, resolution or product Vault service.
 * AES-256-GCM uses the retained opaque credentialRef as AAD, a raw 32-byte master.key,
 * per-ref JSON .bin envelopes and metadata.json with storage:'local'.
 */
export class Generation2Vault {
  private key: Buffer | undefined;
  private readonly metadata: Metadata[] = [];
  constructor(private readonly directory: string) {}
  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.key = randomBytes(32);
    await writeFile(join(this.directory, 'master.key'), this.key, { flag: 'wx', mode: 0o600 });
  }
  async put(input: { kind: string; label: string; secret: string }): Promise<Metadata> {
    if (!this.key) throw Error('Fixture Vault closed');
    const ref = `cred_${randomUUID()}`,
      now = new Date().toISOString(),
      nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(ref, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(input.secret, 'utf8'), cipher.final()]);
    await writeFile(
      join(this.directory, `${ref}.bin`),
      JSON.stringify({
        version: 1,
        algorithm: 'aes-256-gcm',
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    const metadata: Metadata = {
      ref,
      kind: input.kind,
      label: input.label,
      createdAt: now,
      updatedAt: now,
      storage: 'local',
    };
    this.metadata.push(metadata);
    await writeFile(join(this.directory, 'metadata.json'), JSON.stringify(this.metadata) + '\n', {
      mode: 0o600,
    });
    return metadata;
  }
  close(): void {
    this.key?.fill(0);
    this.key = undefined;
  }
}
