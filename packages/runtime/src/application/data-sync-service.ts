import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { scrypt } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import {
  axtermSyncCommitResultSchema,
  axtermSyncDownloadPreviewResultSchema,
  backupSyncRemoteResultSchema,
  syncComparisonSchema,
  syncProfileInputSchema,
  syncProfilePatchSchema,
  syncProfileSchema,
  syncRunResultSchema,
  testSyncProfileResultSchema,
  type AxtermConfigurationPreview,
  type AxtermSyncDocument,
  type AxtermSyncCommitResult,
  type AxtermSyncDownloadPreviewResult,
  type BackupSyncRemoteResult,
  type SyncComparison,
  type SyncDirection,
  type SyncProfile,
  type SyncProfileInput,
  type SyncProfilePatch,
  type SyncRunResult,
} from '@workspace/contracts';
import type {
  SyncProfileRecord,
  SyncProfileRepository,
} from '../adapters/sqlite/sync-profile-repository';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type {
  AxtermSyncDataSource,
  SyncProvider,
  SyncProviderContext,
  SyncRemoteObject,
  SyncSecretResolver,
} from '../ports/data-sync';
import { parseAxtermSyncDocument } from '../adapters/data-sync/axterm-sync-document';
import { ApplicationError, isApplicationError } from './errors';

const maxRemoteBytes = 24 * 1024 * 1024;
const maxPlainBytes = 16 * 1024 * 1024;
const providerTimeoutMs = 30_000;
const autoPollMs = 10_000;

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

export class DataSyncService {
  private readonly providers = new Map<SyncProfile['provider'], SyncProvider>();
  private readonly running = new Map<string, AbortController>();
  private readonly autoTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly profiles: SyncProfileRepository,
    providers: readonly SyncProvider[],
    private readonly secrets: SyncSecretResolver | undefined,
    private readonly backupGrants:
      Pick<HostCapabilityClient, 'resolveGrant'> | undefined = undefined,
    private readonly axtermDataSource: AxtermSyncDataSource | undefined = undefined,
  ) {
    for (const provider of providers) this.providers.set(provider.type, provider);
    this.profiles.recoverInterrupted();
    this.autoTimer = setInterval(() => void this.tick(), autoPollMs);
    this.autoTimer.unref?.();
  }

  list(): SyncProfile[] {
    return this.profiles.list().filter((profile) => profile.format === 'axterm-sync-v1');
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
    this.sourceFor(previous);
    const updated = this.profiles.update(id, command, ifMatch);
    const retiredRefs = [previous.accessCredentialRef, previous.encryptionCredentialRef].filter(
      (ref): ref is string =>
        !!ref && ref !== updated.accessCredentialRef && ref !== updated.encryptionCredentialRef,
    );
    if (this.secrets?.delete)
      await Promise.allSettled(
        retiredRefs
          .filter((ref) => !this.profiles.credentialReferenceInUse(ref))
          .map((ref) => this.secrets!.delete!(ref)),
      );
    return publicProfile(updated);
  }

  async delete(id: string, ifMatch: string | undefined): Promise<void> {
    if (this.running.has(id)) throw new ApplicationError('CONFLICT', 'Sync profile is busy', 409);
    this.sourceFor(this.profiles.getRecord(id));
    const deleted = this.profiles.delete(id, ifMatch);
    const refs = [deleted.accessCredentialRef, deleted.encryptionCredentialRef].filter(
      (ref): ref is string => !!ref,
    );
    if (this.secrets?.delete)
      await Promise.allSettled(
        refs
          .filter((ref) => !this.profiles.credentialReferenceInUse(ref))
          .map((ref) => this.secrets!.delete!(ref)),
      );
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

  async backupRemote(id: string, grantId: string): Promise<BackupSyncRemoteResult> {
    if (this.running.has(id)) throw new ApplicationError('CONFLICT', 'Sync profile is busy', 409);
    if (!this.backupGrants)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Desktop save capability is unavailable',
        503,
      );
    const profile = this.profiles.getRecord(id);
    this.sourceFor(profile);
    if (!profile.accessCredentialRef)
      throw new ApplicationError('SYNC_NOT_CONFIGURED', 'Sync credentials are not configured', 409);
    const provider = this.providers.get(profile.provider);
    if (!provider)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Sync provider is unavailable', 503);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new ApplicationError('SYNC_ABORTED', 'Sync backup timed out', 409)),
      providerTimeoutMs,
    );
    timeout.unref?.();
    this.running.set(id, controller);
    try {
      const grant = await this.backupGrants.resolveGrant(grantId);
      if (grant.kind !== 'save-target' || !grant.permissions.includes('write'))
        throw new ApplicationError('INVALID_STATE', 'A writable save grant is required', 409);
      const accessSecret = await this.requireSecret(profile.accessCredentialRef);
      if (controller.signal.aborted)
        throw new ApplicationError('SYNC_ABORTED', 'Sync backup was canceled', 409);
      let remote: Uint8Array | null;
      try {
        remote = await provider.readBackup(
          { profile: publicProfile(profile), accessSecret },
          controller.signal,
        );
      } catch (cause) {
        throw normalizeSyncError(cause, controller.signal);
      }
      if (!remote) throw new ApplicationError('NOT_FOUND', 'No remote sync document exists', 404);
      const contents = Buffer.from(remote);
      if (contents.length > maxRemoteBytes)
        throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Remote sync object exceeds 24 MiB', 413);
      if (controller.signal.aborted)
        throw new ApplicationError('SYNC_ABORTED', 'Sync backup was canceled', 409);
      try {
        await writeBackupAtomic(grant.path, contents, controller.signal);
      } catch {
        if (controller.signal.aborted)
          throw new ApplicationError('SYNC_ABORTED', 'Sync backup was canceled', 409);
        throw new ApplicationError('SYNC_BACKUP_WRITE_FAILED', 'Could not save sync backup', 409);
      }
      return backupSyncRemoteResultSchema.parse({
        bytes: contents.length,
        sha256: createHash('sha256').update(contents).digest('hex'),
      });
    } finally {
      clearTimeout(timeout);
      this.running.delete(id);
    }
  }

  async compare(id: string): Promise<SyncComparison> {
    return this.exclusive(id, 'checking', async (profile, provider, context, signal) => {
      const [local, remoteObject] = await Promise.all([
        this.sourceFor(profile).snapshot(profile.selectedCategories),
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
    if (direction !== 'upload')
      throw new ApplicationError('SYNC_FORMAT_UNSUPPORTED', 'Use Axterm download preview', 409);
    return this.upload(id);
  }

  async previewAxtermDownload(id: string): Promise<AxtermSyncDownloadPreviewResult> {
    return this.exclusive(id, 'checking', async (profile, provider, context, signal) => {
      const source = this.axtermSourceFor(profile);
      const remote = await provider.load(context, signal);
      if (!remote) throw new ApplicationError('NOT_FOUND', 'No remote sync document exists', 404);
      const document = parseAxtermSyncDocument(await this.decode(remote.contents, profile));
      const preview = await source.preview(document, profile.selectedCategories);
      const updated = this.profiles.setRunState(id, {
        state: 'download-preview',
        remoteRevision: remote.revision,
        lastErrorCode: null,
        pendingPreviewId: preview.previewId,
      });
      return axtermSyncDownloadPreviewResultSchema.parse({
        profile: publicProfile(updated),
        preview,
      });
    });
  }

  pendingAxtermDownload(id: string): AxtermConfigurationPreview {
    const profile = this.profiles.getRecord(id);
    const source = this.axtermSourceFor(profile);
    if (profile.state !== 'download-preview' || !profile.pendingPreviewId)
      throw new ApplicationError('NOT_FOUND', 'No Axterm sync download preview is pending', 404);
    const preview = source.getPreview(profile.pendingPreviewId);
    if (!preview)
      throw new ApplicationError('NOT_FOUND', 'Axterm sync download preview expired', 404);
    return preview;
  }

  async commitAxtermDownload(id: string, previewId: string): Promise<AxtermSyncCommitResult> {
    const profile = this.profiles.getRecord(id);
    const source = this.axtermSourceFor(profile);
    if (profile.state !== 'download-preview' || profile.pendingPreviewId !== previewId)
      throw new ApplicationError('PRECONDITION_FAILED', 'Sync preview is no longer current', 412);
    const result = await source.commit(previewId);
    const updated = this.profiles.setRunState(id, {
      state: 'idle',
      lastSyncAt: new Date().toISOString(),
      lastErrorCode: null,
      pendingPreviewId: null,
    });
    return axtermSyncCommitResultSchema.parse({ profile: publicProfile(updated), result });
  }

  cancelAxtermDownload(id: string): SyncProfile {
    const profile = this.profiles.getRecord(id);
    const source = this.axtermSourceFor(profile);
    if (profile.pendingPreviewId) source.cancel(profile.pendingPreviewId);
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
          this.supportsAutomaticDirection(profile) &&
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
        if (profile.format === 'axterm-sync-v1')
          this.axtermDataSource?.cancel(profile.pendingPreviewId);
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
      const document = await this.sourceFor(profile).snapshot(profile.selectedCategories);
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
    this.sourceFor(profile);
    if (!profile.accessCredentialRef)
      throw new ApplicationError('SYNC_NOT_CONFIGURED', 'Sync credentials are not configured', 409);
    const provider = this.providers.get(profile.provider);
    if (!provider)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Sync provider is unavailable', 503);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new ApplicationError('SYNC_ABORTED', 'Sync request timed out', 409)),
      providerTimeoutMs,
    );
    timeout.unref?.();
    this.running.set(id, controller);
    try {
      const accessSecret = await this.requireSecret(profile.accessCredentialRef);
      if (controller.signal.aborted) {
        if (profile.pendingPreviewId) this.sourceFor(profile).cancel(profile.pendingPreviewId);
        this.profiles.setRunState(id, {
          state: 'failed',
          lastErrorCode: 'SYNC_ABORTED',
          pendingPreviewId: null,
        });
        throw new ApplicationError('SYNC_ABORTED', 'Sync request was canceled', 409);
      }
      if (profile.pendingPreviewId) this.sourceFor(profile).cancel(profile.pendingPreviewId);
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
      }
    } finally {
      clearTimeout(timeout);
      this.running.delete(id);
    }
  }

  private async encode(
    document: AxtermSyncDocument,
    profile: ReturnType<SyncProfileRepository['getRecord']>,
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
    if (!record.encrypted) return parseAxtermSyncDocument(record.document);
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

  private async requireSecret(ref: string): Promise<string> {
    if (!this.secrets)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Local credential Vault is unavailable',
        503,
      );
    return this.secrets.resolve(ref);
  }

  private hasSource(profile: SyncProfileRecord): boolean {
    return profile.format === 'axterm-sync-v1' && !!this.axtermDataSource;
  }

  private supportsAutomaticDirection(profile: SyncProfileRecord): boolean {
    return this.hasSource(profile) && profile.autoSyncDirection === 'upload';
  }

  private sourceFor(profile: SyncProfileRecord): AxtermSyncDataSource {
    if (profile.format !== 'axterm-sync-v1')
      throw new ApplicationError('SYNC_FORMAT_UNSUPPORTED', 'Legacy sync is disabled', 409);
    if (this.axtermDataSource) return this.axtermDataSource;
    throw new ApplicationError(
      'SYNC_FORMAT_UNSUPPORTED',
      'Axterm sync profile format is not available in this version',
      409,
    );
  }

  private axtermSourceFor(profile: SyncProfileRecord): AxtermSyncDataSource {
    if (profile.format !== 'axterm-sync-v1')
      throw new ApplicationError(
        'SYNC_FORMAT_UNSUPPORTED',
        'This operation requires an Axterm sync profile',
        409,
      );
    if (this.axtermDataSource) return this.axtermDataSource;
    throw new ApplicationError(
      'SYNC_FORMAT_UNSUPPORTED',
      'Axterm sync profile format is not available in this version',
      409,
    );
  }
}

function comparison(
  profile: SyncProfileRecord,
  local: AxtermSyncDocument,
  remoteObject: SyncRemoteObject | null,
  remote: AxtermSyncDocument | null,
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

function boundedEnvelope(envelope: PlainEnvelope | EncryptedEnvelope): string {
  const contents = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(contents) > maxRemoteBytes)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Sync envelope exceeds 24 MiB', 413);
  return contents;
}

async function writeBackupAtomic(
  path: string,
  contents: Buffer,
  signal: AbortSignal,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    if (signal.aborted) throw signal.reason;
    await handle.close();
    await rename(temporary, path);
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
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
  if (record.format !== 'axterm-sync-v1')
    throw new ApplicationError('SYNC_FORMAT_UNSUPPORTED', 'Legacy sync is disabled', 409);
  const { accessCredentialRef: _access, encryptionCredentialRef: _encryption, ...profile } = record;
  return syncProfileSchema.parse(profile);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
