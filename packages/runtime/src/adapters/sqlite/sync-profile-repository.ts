import { randomUUID } from 'node:crypto';
import {
  syncProfileInputSchema,
  syncProfilePatchSchema,
  syncProfileSchema,
  type SyncDirection,
  type SyncProfile,
  type SyncProfileInput,
  type SyncProfilePatch,
  type SyncProviderType,
} from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import type { ProductDatabase } from './database';
import { etagFor } from './product-repository';

interface SyncProfileRow {
  id: string;
  provider: SyncProviderType;
  name: string;
  endpoint_url: string;
  remote_id: string;
  username: string | null;
  access_credential_ref: string | null;
  encryption_credential_ref: string | null;
  selected_categories: string;
  auto_sync_enabled: number;
  auto_sync_interval_minutes: number;
  auto_sync_direction: SyncDirection;
  state: SyncProfile['state'];
  remote_revision: string | null;
  last_sync_at: string | null;
  last_error_code: string | null;
  pending_preview_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface SyncProfileRecord extends SyncProfile {
  accessCredentialRef: string | null;
  encryptionCredentialRef: string | null;
}

export interface SyncProfileRunState {
  state: SyncProfile['state'];
  remoteRevision?: string | null;
  lastSyncAt?: string | null;
  lastErrorCode?: string | null;
  pendingPreviewId?: string | null;
}

export class SyncProfileRepository {
  constructor(private readonly database: ProductDatabase) {}

  listRecords(): SyncProfileRecord[] {
    return this.database
      .all<SyncProfileRow>('SELECT * FROM sync_profiles ORDER BY lower(name), id')
      .map(recordFromRow);
  }

  list(): SyncProfile[] {
    return this.listRecords().map(publicProfile);
  }

  getRecord(id: string): SyncProfileRecord {
    const row = this.database.get<SyncProfileRow>('SELECT * FROM sync_profiles WHERE id=?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Sync profile not found', 404);
    return recordFromRow(row);
  }

  get(id: string): SyncProfile {
    return publicProfile(this.getRecord(id));
  }

  create(input: SyncProfileInput): SyncProfileRecord {
    const command = syncProfileInputSchema.parse(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.database.run(
        `INSERT INTO sync_profiles(
          id, provider, name, endpoint_url, remote_id, username,
          access_credential_ref, encryption_credential_ref, selected_categories,
          auto_sync_enabled, auto_sync_interval_minutes, auto_sync_direction,
          state, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, 1)`,
        id,
        command.provider,
        command.name,
        command.endpointUrl,
        command.remoteId,
        command.username,
        command.accessCredentialRef,
        command.encryptionCredentialRef,
        JSON.stringify(command.selectedCategories),
        command.autoSyncEnabled ? 1 : 0,
        command.autoSyncIntervalMinutes,
        command.autoSyncDirection,
        now,
        now,
      );
    } catch (cause) {
      if (cause instanceof Error && /unique|constraint/iu.test(cause.message))
        throw new ApplicationError(
          'CONFLICT',
          `A ${command.provider} sync profile already exists`,
          409,
        );
      throw cause;
    }
    return this.getRecord(id);
  }

  update(id: string, input: SyncProfilePatch, ifMatch: string | undefined): SyncProfileRecord {
    const command = syncProfilePatchSchema.parse(input);
    const current = this.getRecord(id);
    if (ifMatch !== etagFor(current.version))
      throw new ApplicationError('PRECONDITION_FAILED', 'Sync profile changed', 412);
    const accessCredentialRef = command.clearAccessCredential
      ? null
      : (command.accessCredentialRef ?? current.accessCredentialRef);
    const encryptionCredentialRef = command.clearEncryptionCredential
      ? null
      : command.encryptionCredentialRef === undefined
        ? current.encryptionCredentialRef
        : command.encryptionCredentialRef;
    const now = new Date().toISOString();
    this.database.run(
      `UPDATE sync_profiles SET
        name=?, endpoint_url=?, remote_id=?, username=?,
        access_credential_ref=?, encryption_credential_ref=?, selected_categories=?,
        auto_sync_enabled=?, auto_sync_interval_minutes=?, auto_sync_direction=?,
        updated_at=?, version=version+1
       WHERE id=? AND version=?`,
      command.name ?? current.name,
      command.endpointUrl ?? current.endpointUrl,
      command.remoteId ?? current.remoteId,
      command.username === undefined ? current.username : command.username,
      accessCredentialRef,
      encryptionCredentialRef,
      JSON.stringify(command.selectedCategories ?? current.selectedCategories),
      (command.autoSyncEnabled ?? current.autoSyncEnabled) ? 1 : 0,
      command.autoSyncIntervalMinutes ?? current.autoSyncIntervalMinutes,
      command.autoSyncDirection ?? current.autoSyncDirection,
      now,
      id,
      current.version,
    );
    return this.getRecord(id);
  }

  setRunState(id: string, state: SyncProfileRunState): SyncProfileRecord {
    const current = this.getRecord(id);
    const now = new Date().toISOString();
    this.database.run(
      `UPDATE sync_profiles SET state=?, remote_revision=?, last_sync_at=?, last_error_code=?,
       pending_preview_id=?, updated_at=?, version=version+1 WHERE id=? AND version=?`,
      state.state,
      state.remoteRevision === undefined ? current.remoteRevision : state.remoteRevision,
      state.lastSyncAt === undefined ? current.lastSyncAt : state.lastSyncAt,
      state.lastErrorCode === undefined ? current.lastErrorCode : state.lastErrorCode,
      state.pendingPreviewId === undefined ? current.pendingPreviewId : state.pendingPreviewId,
      now,
      id,
      current.version,
    );
    return this.getRecord(id);
  }

  delete(id: string, ifMatch: string | undefined): SyncProfileRecord {
    const current = this.getRecord(id);
    if (ifMatch !== etagFor(current.version))
      throw new ApplicationError('PRECONDITION_FAILED', 'Sync profile changed', 412);
    this.database.run('DELETE FROM sync_profiles WHERE id=? AND version=?', id, current.version);
    return current;
  }

  recoverInterrupted(): void {
    this.database.run(
      `UPDATE sync_profiles SET state='failed', last_error_code='SYNC_INTERRUPTED',
       pending_preview_id=NULL, updated_at=?, version=version+1
       WHERE state IN ('checking','uploading','download-preview')`,
      new Date().toISOString(),
    );
  }
}

function recordFromRow(row: SyncProfileRow): SyncProfileRecord {
  const selectedCategories = JSON.parse(row.selected_categories) as unknown;
  const value = syncProfileSchema.parse({
    id: row.id,
    provider: row.provider,
    name: row.name,
    endpointUrl: row.endpoint_url,
    remoteId: row.remote_id,
    username: row.username,
    accessCredentialConfigured: !!row.access_credential_ref,
    encryptionConfigured: !!row.encryption_credential_ref,
    selectedCategories,
    autoSyncEnabled: !!row.auto_sync_enabled,
    autoSyncIntervalMinutes: row.auto_sync_interval_minutes,
    autoSyncDirection: row.auto_sync_direction,
    state: row.state,
    remoteRevision: row.remote_revision,
    lastSyncAt: row.last_sync_at,
    lastErrorCode: row.last_error_code,
    pendingPreviewId: row.pending_preview_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
  return {
    ...value,
    accessCredentialRef: row.access_credential_ref,
    encryptionCredentialRef: row.encryption_credential_ref,
  };
}

function publicProfile(record: SyncProfileRecord): SyncProfile {
  const { accessCredentialRef: _access, encryptionCredentialRef: _encryption, ...profile } = record;
  return syncProfileSchema.parse(profile);
}
