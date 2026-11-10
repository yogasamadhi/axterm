// Axterm first-party relational sync facts, owned by Configuration (ADR-069).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  syncProfileInputSchema,
  syncProfilePatchSchema,
  syncProfileSchema,
  type SyncDirection,
  type SyncProfile,
  type SyncProfileInput,
  type SyncProfilePatch,
  type SyncProviderType,
} from '@axterm/plugin-api/configuration-sync';
import { SyncApplicationError as ApplicationError } from '../application/sync-errors.ts';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
const etagFor = (version: number) => '"v' + version + '"';

interface SyncProfileRow {
  id: string;
  provider: SyncProviderType;
  format: 'axterm-sync-v1';
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

export interface SyncProfileRecord extends Omit<SyncProfile, 'format'> {
  format: SyncProfileRow['format'];
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

export class OwnedSyncProfiles {
  constructor(private readonly database: RelationalDomain) {}

  listRecords(): SyncProfileRecord[] {
    this.assertBounds();
    return this.database
      .all<SyncProfileRow>('SELECT * FROM sync_profiles ORDER BY lower(name), id LIMIT 5')
      .map(recordFromRow);
  }

  list(): SyncProfile[] {
    return this.listRecords()
      .filter((record) => record.format === 'axterm-sync-v1')
      .map(publicProfile);
  }

  getRecord(id: string): SyncProfileRecord {
    this.assertBounds();
    const row = this.database.get<SyncProfileRow>('SELECT * FROM sync_profiles WHERE id=?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Sync profile not found', 404);
    return recordFromRow(row);
  }

  get(id: string): SyncProfile {
    return publicProfile(this.getRecord(id));
  }

  private createCore(input: SyncProfileInput): SyncProfileRecord {
    const command = syncProfileInputSchema.parse(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.database.run(
        `INSERT INTO sync_profiles(
          id, provider, format, name, endpoint_url, remote_id, username,
          access_credential_ref, encryption_credential_ref, selected_categories,
          auto_sync_enabled, auto_sync_interval_minutes, auto_sync_direction,
          state, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, 1)`,
        id,
        command.provider,
        'axterm-sync-v1',
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

  private updateCore(
    id: string,
    input: SyncProfilePatch,
    ifMatch: string | undefined,
  ): SyncProfileRecord {
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
    if (current.version >= Number.MAX_SAFE_INTEGER)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Sync profile version capacity exceeded');
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

  private setRunStateCore(id: string, state: SyncProfileRunState): SyncProfileRecord {
    const current = this.getRecord(id);
    if (current.version >= Number.MAX_SAFE_INTEGER)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Sync profile version capacity exceeded');
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

  private deleteCore(id: string, ifMatch: string | undefined): SyncProfileRecord {
    const current = this.getRecord(id);
    if (ifMatch !== etagFor(current.version))
      throw new ApplicationError('PRECONDITION_FAILED', 'Sync profile changed', 412);
    this.database.run('DELETE FROM sync_profiles WHERE id=? AND version=?', id, current.version);
    return current;
  }

  create(input: SyncProfileInput): SyncProfileRecord {
    return this.database.transaction(() => {
      this.assertBounds();
      if (this.listRecords().length >= 4)
        throw new ApplicationError(
          'CAPACITY_EXCEEDED',
          'At most four sync provider profiles are supported',
        );
      const value = this.createCore(input);
      this.database.appendEvent('configuration/sync-profile-created', { id: value.id });
      return value;
    });
  }
  update(id: string, input: SyncProfilePatch, ifMatch: string | undefined): SyncProfileRecord {
    return this.database.transaction(() => {
      this.assertInactive(id);
      const value = this.updateCore(id, input, ifMatch);
      this.database.appendEvent('configuration/sync-profile-updated', { id });
      return value;
    });
  }
  delete(id: string, ifMatch: string | undefined): SyncProfileRecord {
    return this.database.transaction(() => {
      this.assertInactive(id);
      const value = this.deleteCore(id, ifMatch);
      this.database.appendEvent('configuration/sync-profile-deleted', { id });
      return value;
    });
  }
  setRunState(id: string, state: SyncProfileRunState): SyncProfileRecord {
    return this.database.transaction(() => {
      const value = this.setRunStateCore(id, state);
      this.database.appendEvent('configuration/sync-profile-state', { id, state: value.state });
      return value;
    });
  }
  private assertInactive(id: string): void {
    if (
      this.database.get(
        "SELECT command_id FROM axterm_sync_run_intents WHERE sync_profile_id=? AND status='running' LIMIT 1",
        id,
      )
    )
      throw new ApplicationError('CONFLICT', 'Sync profile has an active operation');
  }
  private assertBounds(): void {
    const budget = this.database.get<{
      count: number;
      bytes: number;
    }>(`SELECT COUNT(*) AS count, COALESCE(SUM(
      length(CAST(id AS BLOB))+length(CAST(provider AS BLOB))+length(CAST(format AS BLOB))+length(CAST(name AS BLOB))+
      length(CAST(endpoint_url AS BLOB))+length(CAST(remote_id AS BLOB))+COALESCE(length(CAST(username AS BLOB)),0)+
      COALESCE(length(CAST(access_credential_ref AS BLOB)),0)+COALESCE(length(CAST(encryption_credential_ref AS BLOB)),0)+
      length(CAST(selected_categories AS BLOB))+COALESCE(length(CAST(remote_revision AS BLOB)),0)+
      COALESCE(length(CAST(last_error_code AS BLOB)),0)+COALESCE(length(CAST(pending_preview_id AS BLOB)),0)+
      length(CAST(created_at AS BLOB))+length(CAST(updated_at AS BLOB))+COALESCE(length(CAST(last_sync_at AS BLOB)),0)),0) AS bytes FROM sync_profiles`)!;
    if (budget.count > 4 || budget.bytes > 512 * 1024)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Sync profile facts exceed capacity');
  }
}

function recordFromRow(row: SyncProfileRow): SyncProfileRecord {
  const selectedCategories = JSON.parse(row.selected_categories) as unknown;
  const value = storageSyncProfileSchema.parse({
    id: row.id,
    provider: row.provider,
    format: row.format,
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
  if (record.format !== 'axterm-sync-v1')
    throw new ApplicationError('SYNC_FORMAT_UNSUPPORTED', 'Legacy sync is disabled', 409);
  const { accessCredentialRef: _access, encryptionCredentialRef: _encryption, ...profile } = record;
  return syncProfileSchema.parse(profile);
}

const storageSyncProfileSchema = syncProfileSchema.extend({
  format: z.literal('axterm-sync-v1'),
});
