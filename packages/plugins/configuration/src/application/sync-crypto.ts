import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import type { AxtermSyncDocument } from '@axterm/plugin-api/configuration-sync';
import type { SyncProfileRecord } from '../adapters/sync-profiles.ts';
import { parseAxtermSyncDocument } from './sync-document.ts';
import {
  SyncApplicationError as ApplicationError,
  isSyncApplicationError as isApplicationError,
} from './sync-errors.ts';
const maxRemoteBytes = 24 * 1024 * 1024;
const maxPlainBytes = 16 * 1024 * 1024;
interface PlainEnvelope {
  formatVersion: 1;
  encrypted: false;
  document: AxtermSyncDocument;
}

interface EncryptedEnvelope {
  formatVersion: 1;
  encrypted: true;
  algorithm: 'aes-256-gcm+scrypt';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Preserves Axterm's version-one envelope. Only a per-operation Vault resolver enters here. */
export class SyncEnvelopeCodec {
  constructor(private readonly requireSecret: (ref: string) => Promise<string>) {}
  async encode(
    document: AxtermSyncDocument,
    profile: Pick<SyncProfileRecord, 'encryptionCredentialRef'>,
  ) {
    const validated = parseAxtermSyncDocument(document);
    const plaintext = JSON.stringify(validated);
    if (Buffer.byteLength(plaintext) > maxPlainBytes)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Sync document exceeds 16 MiB', 413);
    if (!profile.encryptionCredentialRef) {
      return boundedEnvelope({ formatVersion: 1, encrypted: false, document: validated });
    }
    const password = await this.requireSecret(profile.encryptionCredentialRef);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveSyncKey(password, salt);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return boundedEnvelope({
        formatVersion: 1,
        encrypted: true,
        algorithm: 'aes-256-gcm+scrypt',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      });
    } finally {
      key.fill(0);
    }
  }

  async decode(contents: string, profile: Pick<SyncProfileRecord, 'encryptionCredentialRef'>) {
    if (Buffer.byteLength(contents) > maxRemoteBytes)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Remote sync object exceeds 24 MiB', 413);
    let envelope: unknown;
    try {
      envelope = JSON.parse(contents) as unknown;
    } catch {
      throw new ApplicationError('SYNC_REMOTE_INVALID', 'Remote sync object is invalid JSON', 409);
    }
    const record = asRecord(envelope);
    if (record?.formatVersion !== 1 || typeof record.encrypted !== 'boolean')
      throw new ApplicationError('SYNC_REMOTE_INVALID', 'Remote sync envelope is unsupported', 409);
    if (!record.encrypted) {
      try {
        return parseAxtermSyncDocument(record.document);
      } catch {
        throw new ApplicationError('SYNC_REMOTE_INVALID', 'Remote sync document is invalid', 409);
      }
    }
    if (!profile.encryptionCredentialRef)
      throw new ApplicationError(
        'SYNC_NOT_CONFIGURED',
        'Sync encryption password is required',
        409,
      );
    if (
      record.algorithm !== 'aes-256-gcm+scrypt' ||
      ![record.salt, record.iv, record.tag, record.ciphertext].every(
        (value) => typeof value === 'string',
      )
    )
      throw new ApplicationError('SYNC_REMOTE_INVALID', 'Encrypted sync envelope is invalid', 409);
    try {
      const password = await this.requireSecret(profile.encryptionCredentialRef);
      const salt = Buffer.from(record.salt as string, 'base64');
      const iv = Buffer.from(record.iv as string, 'base64');
      const tag = Buffer.from(record.tag as string, 'base64');
      const ciphertext = Buffer.from(record.ciphertext as string, 'base64');
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16)
        throw new Error('invalid encrypted parameters');
      const key = await deriveSyncKey(password, salt);
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } finally {
        key.fill(0);
      }
      if (plaintext.length > maxPlainBytes) throw new Error('decrypted document is too large');
      return parseAxtermSyncDocument(JSON.parse(plaintext.toString('utf8')) as unknown);
    } catch (cause) {
      if (isApplicationError(cause)) throw cause;
      throw new ApplicationError(
        'SYNC_REMOTE_INVALID',
        'Remote sync object could not be decrypted',
        409,
      );
    }
  }
}
function boundedEnvelope(envelope: PlainEnvelope | EncryptedEnvelope): string {
  const contents = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(contents) > maxRemoteBytes)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Sync envelope exceeds 24 MiB', 413);
  return contents;
}

function deriveSyncKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
