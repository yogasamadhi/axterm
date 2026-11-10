import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import {
  CredentialProvider,
  encodeOpaqueCredentialRef,
  decodeOpaqueCredentialRef,
  isCredentialRefName,
  parseCredentialKey,
  type CredentialRef,
  type CredentialKey,
  type CredentialRecord,
  type CredentialInfo,
  type CredentialRecordInfo,
  type CredentialRecordEntry,
  type ResolvedCredential,
} from '@axterm/infra-credentials';
import {
  createSavedCredentialSchema,
  SavedCredentialStorageError,
  savedCredentialMetadataSchema,
  savedCredentialRefSchema,
  credentialMutationMarkerSchema,
  type CredentialMutationMarker,
  type SavedCredentialMetadata,
} from '@axterm/plugin-api/saved-credentials';
import type { SavedCredentialsService } from '@axterm/plugin-api/host';
import { EncryptedVault, VaultError, type VaultAddress, type VaultMetadata } from './vault.ts';
export {
  EncryptedVault,
  VaultError,
  addressSchema as vaultAddressSchema,
  metadataSchema as vaultMetadataSchema,
} from './vault.ts';
export type { VaultAddress, VaultMetadata } from './vault.ts';

const recordSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('api-key'),
      key: z.string().min(1).optional(),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('grant'), payload: z.json() }).strict(),
]);
function parseRecord(value: unknown, stored = false): CredentialRecord {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new VaultError(stored ? 'CORRUPT' : 'INVALID');
  if (parsed.data.kind === 'grant') return parsed.data;
  return {
    kind: 'api-key',
    ...(parsed.data.key === undefined ? {} : { key: parsed.data.key }),
    ...(parsed.data.env === undefined ? {} : { env: parsed.data.env }),
  };
}
function decodeRecord(text: string | undefined): CredentialRecord | undefined {
  if (text === undefined) return undefined;
  try {
    return parseRecord(JSON.parse(text), true);
  } catch {
    throw new VaultError('CORRUPT');
  }
}
export interface Config {
  readonly directory: string;
}
export const Config: schema<Config> = schema.object({ directory: schema.string().required() });

/** Local provider for Web/headless. Desktop uses the shell's physical Vault through its native port. */
export interface CredentialVaultPort {
  open(): Promise<void>;
  close(): Promise<void>;
  list(): Promise<readonly VaultMetadata[]>;
  get(ref: string): Promise<string>;
  createAt(
    ref: string,
    input: { kind: string; label: string; secret: string },
    mutation: CredentialMutationMarker,
  ): Promise<VaultMetadata>;
  replaceManaged(
    ref: string,
    secret: string,
    mutation: CredentialMutationMarker,
  ): Promise<VaultMetadata>;
  replace(ref: string, secret: string): Promise<VaultMetadata>;
  delete(ref: string): Promise<void>;
  deleteManaged?(
    ref: string,
    expected: CredentialMutationMarker,
  ): Promise<'deleted' | 'missing' | 'changed'>;
  readAddress(address: VaultAddress): Promise<string | undefined>;
  addresses(space: VaultAddress['space']): Promise<readonly VaultAddress[]>;
  modifyAddress(
    address: VaultAddress,
    mutate: (current: string | undefined) => Promise<string | undefined>,
  ): Promise<string | undefined>;
  deleteAddress(address: VaultAddress): Promise<boolean>;
}
function validateSavedRef(ref: string): void {
  if (!savedCredentialRefSchema.safeParse(ref).success) throw new VaultError('INVALID');
}
function validateMutation(mutation: CredentialMutationMarker): void {
  if (!credentialMutationMarkerSchema.safeParse(mutation).success) throw new VaultError('INVALID');
}
function savedMetadata(item: VaultMetadata): SavedCredentialMetadata {
  return savedCredentialMetadataSchema.parse({
    ref: item.ref,
    kind: item.kind,
    label: item.label,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    storage: item.storage,
  });
}
export class VaultCredentials extends CredentialProvider {
  readonly saved: SavedCredentialsService = {
    list: () => this.savedPerform(async () => (await this.vault.list()).map(savedMetadata)),
    inspect: (ref) =>
      this.savedPerform(async () => {
        validateSavedRef(ref);
        const item = (await this.vault.list()).find((item) => item.ref === ref);
        return item
          ? {
              metadata: savedMetadata(item),
              ...(item.mutation ? { mutation: { ...item.mutation } } : {}),
            }
          : undefined;
      }),
    createAt: (ref, input, mutation) =>
      this.savedPerform(async () => {
        validateSavedRef(ref);
        validateMutation(mutation);
        const parsed = createSavedCredentialSchema.safeParse(input);
        if (!parsed.success) throw new VaultError('INVALID');
        const item = await this.vault.createAt(ref, parsed.data, mutation);
        this.notifyUpdated(encodeOpaqueCredentialRef(ref));
        return savedMetadata(item);
      }),
    replace: (ref, secret, mutation) =>
      this.savedPerform(async () => {
        validateSavedRef(ref);
        validateMutation(mutation);
        if (typeof secret !== 'string' || !secret || secret.length > 131072)
          throw new VaultError('INVALID');
        const item = await this.vault.replaceManaged(ref, secret, mutation);
        this.notifyUpdated(encodeOpaqueCredentialRef(ref));
        return savedMetadata(item);
      }),
    removeOwned: (ref, expected) =>
      this.savedPerform(async () => {
        validateSavedRef(ref);
        validateMutation(expected);
        if (!this.vault.deleteManaged) throw new VaultError('INVALID');
        const result = await this.vault.deleteManaged(ref, expected);
        if (result === 'deleted') this.notifyUpdated(encodeOpaqueCredentialRef(ref));
        return result;
      }),
    remove: (ref) =>
      this.savedPerform(async () => {
        validateSavedRef(ref);
        await this.vault.delete(ref);
        this.notifyUpdated(encodeOpaqueCredentialRef(ref));
      }),
  };

  private readonly ready: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  private accepting = true;
  constructor(
    ctx: Context,
    private readonly vault: CredentialVaultPort,
  ) {
    super(ctx);
    ctx.effect(
      () => async () => {
        this.accepting = false;
        await Promise.allSettled([...this.pending]);
        await this.vault.close();
      },
      'credentials.vault.close',
    );
    this.ready = this.vault.open();
    // The class init awaits the same readiness promise; consume immediate failures as well.
    void this.ready.catch(() => {});
  }
  async [Service.init](): Promise<void> {
    await this.ready;
  }
  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.perform(async () => {
      const value = await this.resolveValue(ref);
      return value ? { value, source: 'application-vault' } : undefined;
    });
  }
  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return this.perform(async () => {
      const configured = !!(await this.resolveValue(ref));
      return { configured, writable: true, ...(configured ? { source: 'application-vault' } : {}) };
    });
  }
  override set(ref: CredentialRef, value: string): Promise<void> {
    return this.perform(async () => {
      if (typeof value !== 'string' || !value) throw new VaultError('INVALID');
      const legacy = this.legacyReference(ref);
      if (legacy) await this.vault.replace(legacy, value);
      else await this.vault.modifyAddress({ space: 'reference', key: ref }, async () => value);
      this.notifyUpdated(ref);
    });
  }
  override unset(ref: CredentialRef): Promise<void> {
    return this.perform(async () => {
      const legacy = this.legacyReference(ref);
      let changed: boolean;
      if (legacy) {
        changed = (await this.vault.list()).some((entry) => entry.ref === legacy);
        await this.vault.delete(legacy);
      } else changed = await this.vault.deleteAddress({ space: 'reference', key: ref });
      if (changed) this.notifyUpdated(ref);
    });
  }
  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.perform(() => this.readRecordCore(key));
  }
  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    return this.perform(async () => {
      const record = await this.readRecordCore(key);
      return record
        ? { configured: true, writable: true, kind: record.kind }
        : { configured: false, writable: true };
    });
  }
  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return this.perform(async () => {
      const result: CredentialRecordEntry[] = [];
      for (const address of await this.vault.addresses('record')) {
        const key = this.recordKey(address.key);
        const record = await this.readRecordCore(key);
        if (record) result.push({ key, kind: record.kind });
      }
      return result;
    });
  }
  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return this.perform(async () => {
      key = this.recordKey(key);
      let changed = false;
      const value = await this.vault.modifyAddress({ space: 'record', key }, async (current) => {
        const next = await mutate(decodeRecord(current));
        if (next === undefined) return undefined;
        const validated = parseRecord(next);
        changed = true;
        return JSON.stringify(validated);
      });
      if (changed) this.notifyRecordUpdated(key);
      return decodeRecord(value);
    });
  }
  override deleteRecord(key: CredentialKey): Promise<void> {
    return this.perform(async () => {
      key = this.recordKey(key);
      if (await this.vault.deleteAddress({ space: 'record', key })) this.notifyRecordUpdated(key);
    });
  }
  private recordKey(value: string): CredentialKey {
    try {
      return parseCredentialKey(value);
    } catch {
      throw new VaultError('INVALID');
    }
  }
  private readRecordCore(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.vault.readAddress({ space: 'record', key: this.recordKey(key) }).then(decodeRecord);
  }
  private legacyReference(ref: CredentialRef): string | undefined {
    if (!isCredentialRefName(ref)) throw new VaultError('INVALID');
    if (!ref.startsWith('CREF1_')) return undefined;
    try {
      return decodeOpaqueCredentialRef(ref);
    } catch {
      throw new VaultError('INVALID');
    }
  }
  private async resolveValue(ref: CredentialRef): Promise<string | undefined> {
    const legacy = this.legacyReference(ref);
    if (!legacy) return this.vault.readAddress({ space: 'reference', key: ref });
    try {
      return await this.vault.get(legacy);
    } catch (error) {
      if (error instanceof VaultError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }
  private savedPerform<T>(operation: () => Promise<T>): Promise<T> {
    return this.perform(operation).catch((error: unknown) => {
      if (error instanceof VaultError) {
        const code =
          error.code === 'INVALID'
            ? 'invalid'
            : error.code === 'NOT_FOUND'
              ? 'not-found'
              : error.code === 'CONFLICT'
                ? 'conflict'
                : error.code === 'CLOSED'
                  ? 'closed'
                  : 'unavailable';
        throw new SavedCredentialStorageError(code);
      }
      throw new SavedCredentialStorageError('unavailable');
    });
  }
  private perform<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new VaultError('CLOSED'));
    const task = this.ready.then(operation);
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
}
export class LocalVaultCredentials extends VaultCredentials {
  static readonly Config = Config;
  constructor(ctx: Context, config: Config) {
    super(ctx, new EncryptedVault(config.directory));
  }
}
export default LocalVaultCredentials;
