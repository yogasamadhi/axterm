import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { scrypt } from 'node:crypto';
import {
  syncCategorySchema,
  syncCommitResultSchema,
  syncComparisonSchema,
  syncProfileInputSchema,
  syncProfilePatchSchema,
  syncRunResultSchema,
  testSyncProfileResultSchema,
  type ElectermDataImportResult,
  type ElectermDataPreview,
  type SyncComparison,
  type SyncDirection,
  type SyncProfile,
  type SyncProfileInput,
  type SyncProfilePatch,
  type SyncRunResult,
} from '@workspace/contracts';
import type { SyncProfileRepository } from '../adapters/sqlite/sync-profile-repository';
import { stableHash } from '../adapters/sqlite/product-repository';
import type {
  SyncDataDocument,
  SyncDataSource,
  SyncProvider,
  SyncProviderContext,
  SyncRemoteObject,
  SyncSecretResolver,
} from '../ports/data-sync';
import { ApplicationError, isApplicationError } from './errors';

const maxRemoteBytes = 24 * 1024 * 1024;
const maxPlainBytes = 16 * 1024 * 1024;
const providerTimeoutMs = 30_000;
const autoPollMs = 10_000;

interface PlainEnvelope {
  formatVersion: 1;
  encrypted: false;
  document: SyncDataDocument;
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

export class DataSyncService {
  private readonly providers = new Map<SyncProfile['provider'], SyncProvider>();
  private readonly running = new Map<string, AbortController>();
  private readonly autoTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly profiles: SyncProfileRepository,
    providers: readonly SyncProvider[],
    private readonly dataSource: SyncDataSource,
    private readonly secrets: SyncSecretResolver | undefined,
  ) {
    for (const provider of providers) this.providers.set(provider.type, provider);
    this.profiles.recoverInterrupted();
    this.autoTimer = setInterval(() => void this.tick(), autoPollMs);
    this.autoTimer.unref?.();
  }

  list(): SyncProfile[] {
    return this.profiles.list();
  }

  async create(input: SyncProfileInput): Promise<SyncProfile> {
    const command = syncProfileInputSchema.parse(input);
    await this.requireSecret(command.accessCredentialRef);
    if (command.encryptionCredentialRef) await this.requireSecret(command.encryptionCredentialRef);
    return publicProfile(this.profiles.create(command));
  }

  async update(
    id: string,
    input: SyncProfilePatch,
    ifMatch: string | undefined,
  ): Promise<SyncProfile> {
    const command = syncProfilePatchSchema.parse(input);
    if (command.accessCredentialRef) await this.requireSecret(command.accessCredentialRef);
    if (command.encryptionCredentialRef) await this.requireSecret(command.encryptionCredentialRef);
    const previous = this.profiles.getRecord(id);
    const updated = this.profiles.update(id, command, ifMatch);
    const retiredRefs = [previous.accessCredentialRef, previous.encryptionCredentialRef].filter(
      (ref): ref is string =>
        !!ref && ref !== updated.accessCredentialRef && ref !== updated.encryptionCredentialRef,
    );
    if (this.secrets?.delete)
      await Promise.allSettled(retiredRefs.map((ref) => this.secrets!.delete!(ref)));
    return publicProfile(updated);
  }

  async delete(id: string, ifMatch: string | undefined): Promise<void> {
    if (this.running.has(id)) throw new ApplicationError('CONFLICT', 'Sync profile is busy', 409);
    const deleted = this.profiles.delete(id, ifMatch);
    const refs = [deleted.accessCredentialRef, deleted.encryptionCredentialRef].filter(
      (ref): ref is string => !!ref,
    );
    if (this.secrets?.delete)
      await Promise.allSettled(refs.map((ref) => this.secrets!.delete!(ref)));
  }

  async test(id: string) {
    return this.exclusive(id, 'checking', async (profile, provider, context, signal) => {
      const remote = await provider.load(context, signal);
      if (remote) await this.decode(remote.contents, profile);
      this.profiles.setRunState(id, {
        state: 'idle',
        remoteRevision: remote?.revision ?? null,
        lastErrorCode: null,
      });
      return testSyncProfileResultSchema.parse({
        reachable: true,
        remoteExists: !!remote,
        revision: remote?.revision ?? null,
      });
    });
  }

  async compare(id: string): Promise<SyncComparison> {
    return this.exclusive(id, 'checking', async (profile, provider, context, signal) => {
      const [local, remoteObject] = await Promise.all([
        this.dataSource.snapshot(profile.selectedCategories),
        provider.load(context, signal),
      ]);
      const remote = remoteObject ? await this.decode(remoteObject.contents, profile) : null;
      const result = comparison(profile, local, remoteObject, remote);
      this.profiles.setRunState(id, {
        state: 'idle',
        remoteRevision: remoteObject?.revision ?? null,
        lastErrorCode: null,
      });
      return result;
    });
  }

  async run(id: string, direction: SyncDirection): Promise<SyncRunResult> {
    return direction === 'upload' ? this.upload(id) : this.download(id);
  }

  async commitDownload(
    id: string,
    previewId: string,
    treeEtag: string | undefined,
  ): Promise<{ profile: SyncProfile; result: ElectermDataImportResult }> {
    const profile = this.profiles.getRecord(id);
    if (profile.state !== 'download-preview' || profile.pendingPreviewId !== previewId)
      throw new ApplicationError('PRECONDITION_FAILED', 'Sync preview is no longer current', 412);
    if (!treeEtag)
      throw new ApplicationError(
        'PRECONDITION_REQUIRED',
        'Bookmark tree If-Match is required',
        428,
      );
    const result = await this.dataSource.commit(previewId, treeEtag);
    const updated = this.profiles.setRunState(id, {
      state: 'idle',
      lastSyncAt: new Date().toISOString(),
      lastErrorCode: null,
      pendingPreviewId: null,
    });
    return syncCommitResultSchema.parse({ profile: publicProfile(updated), result });
  }

  pendingDownload(id: string): ElectermDataPreview {
    const profile = this.profiles.getRecord(id);
    if (profile.state !== 'download-preview' || !profile.pendingPreviewId)
      throw new ApplicationError('NOT_FOUND', 'No sync download preview is pending', 404);
    const preview = this.dataSource.getPreview(profile.pendingPreviewId);
    if (!preview) throw new ApplicationError('NOT_FOUND', 'Sync download preview expired', 404);
    return preview;
  }

  cancelDownload(id: string): SyncProfile {
    const profile = this.profiles.getRecord(id);
    if (profile.pendingPreviewId) this.dataSource.cancel(profile.pendingPreviewId);
    return publicProfile(
      this.profiles.setRunState(id, {
        state: 'idle',
        pendingPreviewId: null,
        lastErrorCode: null,
      }),
    );
  }

  cancel(id: string): void {
    this.running.get(id)?.abort(new ApplicationError('SYNC_ABORTED', 'Sync canceled', 409));
  }

  async tick(now = Date.now()): Promise<void> {
    const candidates = this.profiles
      .listRecords()
      .filter(
        (profile) =>
          profile.autoSyncEnabled &&
          (profile.state === 'idle' || profile.state === 'failed') &&
          !this.running.has(profile.id) &&
          now - Date.parse(profile.lastSyncAt ?? profile.updatedAt) >=
            profile.autoSyncIntervalMinutes * 60_000,
      );
    await Promise.allSettled(
      candidates.slice(0, 2).map((profile) => this.run(profile.id, profile.autoSyncDirection)),
    );
  }

  async close(): Promise<void> {
    clearInterval(this.autoTimer);
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled(
      this.profiles.listRecords().flatMap((profile) => {
        if (!profile.pendingPreviewId) return [];
        this.dataSource.cancel(profile.pendingPreviewId);
        return [];
      }),
    );
    this.running.clear();
  }

  resourceCount(): number {
    return this.running.size;
  }

  private async upload(id: string): Promise<SyncRunResult> {
    return this.exclusive(id, 'uploading', async (profile, provider, context, signal) => {
      const document = await this.dataSource.snapshot(profile.selectedCategories);
      const contents = await this.encode(document, profile);
      const existing = await provider.load(context, signal);
      const saved = await provider.save(context, contents, existing?.revision ?? null, signal);
      const updated = this.profiles.setRunState(id, {
        state: 'idle',
        remoteRevision: saved.revision,
        lastSyncAt: new Date().toISOString(),
        lastErrorCode: null,
        pendingPreviewId: null,
      });
      return syncRunResultSchema.parse({
        profile: publicProfile(updated),
        direction: 'upload',
        uploaded: true,
        preview: null,
      });
    });
  }

  private async download(id: string): Promise<SyncRunResult> {
    return this.exclusive(id, 'checking', async (profile, provider, context, signal) => {
      const remote = await provider.load(context, signal);
      if (!remote) throw new ApplicationError('NOT_FOUND', 'No remote sync document exists', 404);
      const document = await this.decode(remote.contents, profile);
      const preview = await this.dataSource.preview(document, profile.selectedCategories);
      const updated = this.profiles.setRunState(id, {
        state: 'download-preview',
        remoteRevision: remote.revision,
        lastErrorCode: null,
        pendingPreviewId: preview.previewId,
      });
      return syncRunResultSchema.parse({
        profile: publicProfile(updated),
        direction: 'download',
        uploaded: false,
        preview,
      });
    });
  }

  private async exclusive<T>(
    id: string,
    state: 'checking' | 'uploading',
    operation: (
      profile: ReturnType<SyncProfileRepository['getRecord']>,
      provider: SyncProvider,
      context: SyncProviderContext,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.running.has(id)) throw new ApplicationError('CONFLICT', 'Sync profile is busy', 409);
    const profile = this.profiles.getRecord(id);
    if (!profile.accessCredentialRef)
      throw new ApplicationError('SYNC_NOT_CONFIGURED', 'Sync credentials are not configured', 409);
    const provider = this.providers.get(profile.provider);
    if (!provider)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Sync provider is unavailable', 503);
    const accessSecret = await this.requireSecret(profile.accessCredentialRef);
    if (profile.pendingPreviewId) this.dataSource.cancel(profile.pendingPreviewId);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new ApplicationError('SYNC_ABORTED', 'Sync request timed out', 409)),
      providerTimeoutMs,
    );
    timeout.unref?.();
    this.running.set(id, controller);
    this.profiles.setRunState(id, { state, lastErrorCode: null, pendingPreviewId: null });
    try {
      return await operation(
        profile,
        provider,
        { profile: publicProfile(profile), accessSecret },
        controller.signal,
      );
    } catch (cause) {
      const error = normalizeSyncError(cause, controller.signal);
      this.profiles.setRunState(id, {
        state: 'failed',
        lastErrorCode: error.code,
        pendingPreviewId: null,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      this.running.delete(id);
    }
  }

  private async encode(
    document: SyncDataDocument,
    profile: ReturnType<SyncProfileRepository['getRecord']>,
  ) {
    const validated = validateDocument(document);
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
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      formatVersion: 1,
      encrypted: true,
      algorithm: 'aes-256-gcm+scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    key.fill(0);
    return boundedEnvelope(envelope);
  }

  private async decode(contents: string, profile: ReturnType<SyncProfileRepository['getRecord']>) {
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
    if (!record.encrypted) return validateDocument(record.document);
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
      return validateDocument(JSON.parse(plaintext.toString('utf8')) as unknown);
    } catch (cause) {
      if (isApplicationError(cause)) throw cause;
      throw new ApplicationError(
        'SYNC_REMOTE_INVALID',
        'Remote sync object could not be decrypted',
        409,
      );
    }
  }

  private async requireSecret(ref: string): Promise<string> {
    if (!this.secrets)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Local credential Vault is unavailable',
        503,
      );
    return this.secrets.resolve(ref);
  }
}

function comparison(
  profile: SyncProfile,
  local: SyncDataDocument,
  remoteObject: SyncRemoteObject | null,
  remote: SyncDataDocument | null,
): SyncComparison {
  return syncComparisonSchema.parse({
    profileId: profile.id,
    remoteExists: !!remote,
    remoteRevision: remoteObject?.revision ?? null,
    remoteUpdatedAt: remoteObject?.updatedAt ?? null,
    deviceName: remote?.deviceName ?? null,
    appVersion: remote?.appVersion ?? null,
    categories: profile.selectedCategories.map((category) => {
      const localItem = local.categories[category];
      if (!localItem)
        throw new ApplicationError(
          'INVALID_STATE',
          `Local ${category} snapshot is unavailable`,
          409,
        );
      const remoteItem = remote?.categories[category];
      return {
        category,
        localCount: localItem.count,
        remoteCount: remoteItem?.count ?? 0,
        localHash: localItem.hash,
        remoteHash: remoteItem?.hash ?? null,
        state: !remoteItem
          ? 'local-only'
          : localItem.hash === remoteItem.hash
            ? 'equal'
            : localItem.count === 0
              ? 'remote-only'
              : remoteItem.count === 0
                ? 'local-only'
                : 'different',
      };
    }),
    checkedAt: new Date().toISOString(),
  });
}

function validateDocument(value: unknown): SyncDataDocument {
  const record = asRecord(value);
  const categories = asRecord(record?.categories);
  if (
    record?.formatVersion !== 1 ||
    typeof record.deviceName !== 'string' ||
    !record.deviceName ||
    record.deviceName.length > 128 ||
    typeof record.appVersion !== 'string' ||
    record.appVersion.length > 80 ||
    typeof record.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.generatedAt)) ||
    !categories
  )
    throw new ApplicationError('SYNC_REMOTE_INVALID', 'Sync document header is invalid', 409);
  const parsedCategories: Partial<SyncDataDocument['categories']> = {};
  for (const [name, item] of Object.entries(categories)) {
    const category = syncCategorySchema.safeParse(name);
    const candidate = asRecord(item);
    if (
      !category.success ||
      !candidate ||
      !Number.isSafeInteger(candidate.count) ||
      Number(candidate.count) < 0 ||
      Number(candidate.count) > 100_000 ||
      typeof candidate.hash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(candidate.hash) ||
      candidate.hash !== stableHash(candidate.value)
    )
      throw new ApplicationError('SYNC_REMOTE_INVALID', `Sync category ${name} is invalid`, 409);
    parsedCategories[category.data] = {
      count: Number(candidate.count),
      hash: candidate.hash,
      value: candidate.value,
    };
  }
  return {
    formatVersion: 1,
    deviceName: record.deviceName,
    appVersion: record.appVersion,
    generatedAt: record.generatedAt,
    categories: parsedCategories,
  };
}

function boundedEnvelope(envelope: PlainEnvelope | EncryptedEnvelope): string {
  const contents = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(contents) > maxRemoteBytes)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Sync envelope exceeds 24 MiB', 413);
  return contents;
}

function normalizeSyncError(cause: unknown, signal: AbortSignal): ApplicationError {
  if (isApplicationError(cause)) return cause;
  if (signal.aborted) return new ApplicationError('SYNC_ABORTED', 'Sync request was canceled', 409);
  return new ApplicationError('SYNC_PROVIDER_FAILED', 'Sync provider request failed', 409);
}

function deriveSyncKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function publicProfile(record: ReturnType<SyncProfileRepository['getRecord']>): SyncProfile {
  const { accessCredentialRef: _access, encryptionCredentialRef: _encryption, ...profile } = record;
  return profile;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
