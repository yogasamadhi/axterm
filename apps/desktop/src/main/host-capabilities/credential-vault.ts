import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  hostCredentialMetadataSchema,
  type HostCredentialMetadata,
} from '@workspace/contracts/desktop';

const keyBytes = 32;
const nonceBytes = 12;
const tagBytes = 16;

interface EncryptedSecret {
  version: 1;
  algorithm: 'aes-256-gcm';
  nonce: string;
  tag: string;
  ciphertext: string;
}

export class CredentialVault {
  private metadata = new Map<string, HostCredentialMetadata>();
  private masterKey: Buffer | undefined;

  constructor(private readonly directory: string) {}

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => {});
    this.masterKey = await this.loadOrCreateMasterKey();
    try {
      const parsed = JSON.parse(
        await readFile(join(this.directory, 'metadata.json'), 'utf8'),
      ) as unknown;
      if (!Array.isArray(parsed)) throw new Error('Credential metadata is invalid');
      this.metadata = new Map(
        parsed.flatMap((item) => {
          const result = hostCredentialMetadataSchema.safeParse(item);
          return result.success ? [[result.data.ref, result.data] as const] : [];
        }),
      );
    } catch (error) {
      if (isMissingFile(error)) this.metadata.clear();
      else throw error;
    }
  }

  close(): void {
    this.masterKey?.fill(0);
    this.masterKey = undefined;
    this.metadata.clear();
  }

  list(): HostCredentialMetadata[] {
    return [...this.metadata.values()].map((item) => ({ ...item }));
  }

  async put(input: {
    kind: string;
    label: string;
    secret: string;
  }): Promise<HostCredentialMetadata> {
    const ref = `cred_${randomUUID()}`;
    const now = new Date().toISOString();
    const metadata: HostCredentialMetadata = {
      ref,
      kind: input.kind,
      label: input.label,
      createdAt: now,
      updatedAt: now,
      storage: 'local',
    };
    await this.writeSecret(ref, input.secret);
    this.metadata.set(ref, metadata);
    await this.writeMetadata();
    return metadata;
  }

  async get(ref: string): Promise<string> {
    const metadata = this.metadata.get(ref);
    if (!metadata) throw new Error('Credential not found');
    const payload = parseEncryptedSecret(await readFile(this.secretPath(ref), 'utf8'));
    const decipher = createDecipheriv(
      payload.algorithm,
      this.requireMasterKey(),
      Buffer.from(payload.nonce, 'base64'),
    );
    decipher.setAAD(Buffer.from(ref, 'utf8'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  async replace(ref: string, secret: string): Promise<HostCredentialMetadata> {
    const current = this.metadata.get(ref);
    if (!current) throw new Error('Credential not found');
    await this.writeSecret(ref, secret);
    const next: HostCredentialMetadata = {
      ...current,
      storage: 'local',
      updatedAt: new Date().toISOString(),
    };
    this.metadata.set(ref, next);
    await this.writeMetadata();
    return next;
  }

  async delete(ref: string): Promise<void> {
    const current = this.metadata.get(ref);
    if (!current) return;
    this.metadata.delete(ref);
    await unlink(this.secretPath(ref)).catch(() => {});
    await this.writeMetadata();
  }

  private async loadOrCreateMasterKey(): Promise<Buffer> {
    const path = join(this.directory, 'master.key');
    try {
      const key = await readFile(path);
      if (key.byteLength !== keyBytes) throw new Error('Credential vault key is invalid');
      await chmod(path, 0o600).catch(() => {});
      return key;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const key = randomBytes(keyBytes);
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(key);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return key;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      key.fill(0);
      const existing = await readFile(path);
      if (existing.byteLength !== keyBytes)
        throw new Error('Credential vault key is invalid', { cause: error });
      return existing;
    }
  }

  private async writeSecret(ref: string, secret: string) {
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv('aes-256-gcm', this.requireMasterKey(), nonce);
    cipher.setAAD(Buffer.from(ref, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const payload: EncryptedSecret = {
      version: 1,
      algorithm: 'aes-256-gcm',
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    const temporary = `${this.secretPath(ref)}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    await rename(temporary, this.secretPath(ref));
  }

  private async writeMetadata() {
    const path = join(this.directory, 'metadata.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...this.metadata.values()])}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) throw new Error('Credential vault is closed');
    return this.masterKey;
  }

  private secretPath(ref: string) {
    if (!/^cred_[0-9a-f-]{36}$/.test(ref)) throw new Error('Invalid credential reference');
    return join(this.directory, `${ref}.bin`);
  }
}

function parseEncryptedSecret(value: string): EncryptedSecret {
  const parsed = JSON.parse(value) as Partial<EncryptedSecret>;
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== 'aes-256-gcm' ||
    typeof parsed.nonce !== 'string' ||
    Buffer.from(parsed.nonce, 'base64').byteLength !== nonceBytes ||
    typeof parsed.tag !== 'string' ||
    Buffer.from(parsed.tag, 'base64').byteLength !== tagBytes ||
    typeof parsed.ciphertext !== 'string'
  )
    throw new Error('Credential payload is invalid');
  return parsed as EncryptedSecret;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
