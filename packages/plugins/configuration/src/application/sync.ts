import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageCommandError, type StorageCommandJournal } from '@axterm/plugin-api';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import {
  syncProfileInputSchema,
  syncProfilePatchSchema,
  syncProfileSchema,
  syncOperationSchema,
  syncComparisonSchema,
  axtermSyncCommitResultSchema,
  type SyncProfile,
  type SyncProfileInput,
  type SyncProfilePatch,
  type SyncOperation,
  type SyncOperationResult,
  type SyncCommandOutcome,
  type SyncFailure,
  type AxtermSyncDocument,
  type AxtermSyncCommitResult,
} from '@axterm/plugin-api/configuration-sync';
import type { AxtermConfigurationPreview } from '@axterm/plugin-api/configuration-portable';
import type {
  OwnedSyncProfiles,
  SyncProfileRecord,
  SyncProfileRunState,
} from '../adapters/sync-profiles.ts';
import type { SyncIntents } from '../adapters/sync-intents.ts';
import type { SyncResourceCoordinator } from '../adapters/sync-coordination.ts';
import type { AxtermSyncDataSource, SyncProvider, SyncRemoteObject } from '../ports/sync.ts';
import { SyncEnvelopeCodec } from './sync-crypto.ts';
import { SyncWorkflowError, SyncApplicationError } from './sync-errors.ts';
import { PortableApplicationError } from './portable-errors.ts';

export interface SyncBackupWriter {
  write(grantId: string, contents: Uint8Array, signal: AbortSignal): Promise<void>;
}
/** Configuration owns facts and IO lifetimes; provider requests are never transparently retried. */
export class ConfigurationSyncApplication {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly running = new Map<string, AbortController>();
  private readonly providers = new Map<SyncProfile['provider'], SyncProvider>();
  private readonly codec: SyncEnvelopeCodec;
  private readonly previews = new Set<string>();
  private readonly schedule = new Map<string, { signature: string; due: number }>();
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly profiles: OwnedSyncProfiles,
    private readonly intents: SyncIntents,
    private readonly coordinator: SyncResourceCoordinator,
    private readonly commands: StorageCommandJournal,
    private readonly generation: string,
    private readonly source: AxtermSyncDataSource,
    private readonly resolveSecret: (ref: string) => Promise<string>,
    providers: readonly SyncProvider[],
    private readonly backup: SyncBackupWriter,
    automatic: boolean,
  ) {
    this.codec = new SyncEnvelopeCodec(resolveSecret);
    for (const provider of providers) this.providers.set(provider.type, provider);
    this.refreshSchedule(performance.now());
    if (automatic) {
      this.timer = setInterval(() => void this.tick().catch(() => {}), 10_000);
      this.timer.unref?.();
    }
  }
  initialize(): Promise<void> {
    return this.track(
      (async () => {
        for (const profile of this.profiles.listRecords()) {
          try {
            await this.coordinator.withResource(
              profile.id,
              async (lease) => {
                this.intents.recoverResource(lease);
                const current = this.profiles.getRecord(profile.id);
                if (
                  ['checking', 'uploading'].includes(current.state) ||
                  (current.pendingPreviewId && !this.source.getPreview(current.pendingPreviewId))
                ) {
                  this.domain.transaction(() => {
                    this.profiles.setRunState(current.id, {
                      state: 'failed',
                      pendingPreviewId: null,
                      lastErrorCode: 'SYNC_INTERRUPTED',
                    });
                    if (current.autoSyncEnabled)
                      this.profiles.update(
                        current.id,
                        { autoSyncEnabled: false },
                        '"v' + this.profiles.get(current.id).version + '"',
                      );
                  });
                }
              },
              this.lifetime.signal,
            );
          } catch (error) {
            // Another Profile's actual lease remains authoritative, even across generations.
            if (!(error instanceof SyncWorkflowError && error.reason === 'conflict')) throw error;
          }
        }
      })(),
    );
  }
  snapshot() {
    this.assertOpen();
    return { profiles: this.profiles.list(), runs: this.intents.list() };
  }
  outcome(commandId: string): SyncCommandOutcome {
    this.assertOpen();
    return this.intents.outcome(commandId);
  }
  create(commandId: string, generation: string, input: SyncProfileInput): Promise<SyncProfile> {
    this.admit(generation);
    const parsed = syncProfileInputSchema.parse(input);
    return this.track(
      (async () => {
        await this.requireSecret(parsed.accessCredentialRef);
        if (parsed.encryptionCredentialRef)
          await this.requireSecret(parsed.encryptionCredentialRef);
        this.assertOpen();
        const profile = this.commands.execute(commandId, 'sync/create', parsed, () =>
          publicProfile(this.profiles.create(parsed)),
        );
        this.refreshSchedule(performance.now());
        return profile;
      })(),
    );
  }
  update(
    commandId: string,
    generation: string,
    id: string,
    input: SyncProfilePatch,
    ifMatch: string | undefined,
  ): Promise<SyncProfile> {
    this.admit(generation);
    const parsed = syncProfilePatchSchema.parse(input);
    return this.track(
      this.coordinator.withResource(
        id,
        async (lease) => {
          this.intents.recoverResource(lease);
          if (parsed.accessCredentialRef) await this.requireSecret(parsed.accessCredentialRef);
          if (parsed.encryptionCredentialRef)
            await this.requireSecret(parsed.encryptionCredentialRef);
          lease.assert();
          const profile = this.commands.execute(
            commandId,
            'sync/update',
            { id, input: parsed, ifMatch },
            () => publicProfile(this.profiles.update(id, parsed, ifMatch)),
          );
          // A reference can be shared with another domain; replacing it never deletes Vault data.
          this.refreshSchedule(performance.now());
          return profile;
        },
        this.lifetime.signal,
      ),
    );
  }
  remove(
    commandId: string,
    generation: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<void> {
    this.admit(generation);
    return this.track(
      this.coordinator.withResource(
        id,
        async (lease) => {
          this.intents.recoverResource(lease);
          const deleted = this.commands.execute(commandId, 'sync/delete', { id, ifMatch }, () => {
            const record = this.profiles.delete(id, ifMatch);
            return { id, previewId: record.pendingPreviewId };
          });
          if (deleted.previewId) this.cancelPreview(deleted.previewId);
          this.schedule.delete(id);
        },
        this.lifetime.signal,
      ),
    );
  }
  run(
    commandId: string,
    generation: string,
    id: string,
    operation: SyncOperation,
    signal: AbortSignal,
    grantId?: string,
    automatic = false,
  ): Promise<SyncCommandOutcome> {
    this.admit(generation);
    commandId = z.uuid().parse(commandId).toLowerCase();
    const selected = syncOperationSchema.parse(operation);
    if (selected === 'backup' && (!grantId || grantId.length > 256))
      throw new SyncWorkflowError('invalid-input');
    const profile = this.profiles.getRecord(id);
    this.intents.reserve(commandId, generation, id, selected, profile.version);
    const controller = new AbortController();
    const cancellation = AbortSignal.any([this.lifetime.signal, controller.signal, signal]);
    this.running.set(commandId, controller);
    const task = this.coordinator
      .withResource(
        id,
        async (lease) => {
          this.intents.recoverResource(lease, commandId);
          this.intents.running(commandId, lease);
          const current = this.profiles.getRecord(id);
          if (automatic && !this.automaticDue(current, commandId))
            throw new SyncWorkflowError('conflict');
          if (!current.accessCredentialRef) throw new SyncWorkflowError('not-configured');
          const provider = this.providers.get(current.provider);
          if (!provider) throw new SyncWorkflowError('unavailable');
          const timeout = setTimeout(() => controller.abort(), 30_000);
          timeout.unref?.();
          let writeStarted = false;
          let createdPreview: string | undefined;
          try {
            const accessSecret = await this.requireSecret(current.accessCredentialRef);
            lease.assert();
            if (selected !== 'backup') {
              if (current.pendingPreviewId) this.cancelPreview(current.pendingPreviewId);
              this.profiles.setRunState(id, {
                state: selected === 'upload' ? 'uploading' : 'checking',
                pendingPreviewId: null,
                lastErrorCode: null,
              });
            }
            const context = { profile: publicProfile(current), accessSecret };
            let result: SyncOperationResult;
            let state: SyncProfileRunState = {
              state: 'idle',
              lastErrorCode: null,
              pendingPreviewId: null,
            };
            if (selected === 'backup') {
              const bytes = await provider.readBackup(context, lease.signal);
              lease.assert();
              if (bytes === null) throw new SyncWorkflowError('not-found');
              if (bytes.length > 24 * 1024 * 1024) throw new SyncWorkflowError('capacity');
              writeStarted = true;
              await this.backup.write(grantId!, bytes, lease.signal);
              lease.assert();
              result = {
                operation: selected,
                value: {
                  bytes: bytes.length,
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                },
              };
            } else {
              // Do not race a snapshot promise against provider IO: every admitted task must be joined.
              const local =
                selected === 'compare' || selected === 'upload'
                  ? await this.source.snapshot(current.selectedCategories)
                  : undefined;
              lease.assert();
              const contents =
                selected === 'upload' ? await this.codec.encode(local!, current) : undefined;
              lease.assert();
              const remote = await provider.load(context, lease.signal);
              lease.assert();
              if (selected === 'upload') {
                writeStarted = true;
                const saved = await provider.save(
                  context,
                  contents!,
                  remote?.revision ?? null,
                  lease.signal,
                );
                lease.assert();
                state = {
                  ...state,
                  remoteRevision: saved.revision,
                  lastSyncAt: new Date().toISOString(),
                };
                // Filled with the committed public profile inside the facts/outcome transaction below.
                result = {
                  operation: selected,
                  value: {
                    profile: publicProfile(current),
                    direction: 'upload',
                    uploaded: true,
                    preview: null,
                  },
                };
              } else {
                const document = remote ? await this.codec.decode(remote.contents, current) : null;
                lease.assert();
                state.remoteRevision = remote?.revision ?? null;
                if (selected === 'test')
                  result = {
                    operation: selected,
                    value: {
                      reachable: true,
                      remoteExists: remote !== null,
                      revision: remote?.revision ?? null,
                    },
                  };
                else if (selected === 'compare')
                  result = {
                    operation: selected,
                    value: comparison(current, local!, remote, document),
                  };
                else {
                  if (!document) throw new SyncWorkflowError('not-found');
                  const preview = await this.source.preview(document, current.selectedCategories);
                  this.previews.add(preview.previewId);
                  createdPreview = preview.previewId;
                  lease.assert();
                  state = {
                    ...state,
                    state: 'download-preview',
                    pendingPreviewId: preview.previewId,
                  };
                  result = {
                    operation: selected,
                    value: { profile: publicProfile(current), preview },
                  };
                }
              }
            }
            return this.domain.transaction(() => {
              lease.assert();
              const updated = publicProfile(
                selected === 'backup' ? current : this.profiles.setRunState(id, state),
              );
              if (result.operation === 'upload' || result.operation === 'download-preview')
                result.value.profile = updated;
              return this.intents.finish(commandId, 'completed', result);
            });
          } catch (error) {
            // Once a provider or atomic backup write started, a lost response cannot prove non-commit.
            const uncertain =
              writeStarted &&
              !(error instanceof SyncApplicationError && error.code === 'SYNC_REMOTE_CONFLICT');
            const reason = uncertain ? 'uncertain' : syncFailure(error, lease.signal);
            if (createdPreview) this.cancelPreview(createdPreview);
            this.domain.transaction(() => {
              if (selected !== 'backup')
                this.profiles.setRunState(id, {
                  state: 'failed',
                  lastErrorCode: 'SYNC_' + reason.toUpperCase().replaceAll('-', '_'),
                  pendingPreviewId: null,
                });
              this.intents.finish(commandId, uncertain ? 'uncertain' : 'failed', undefined, reason);
              if (uncertain && selected === 'upload' && current.autoSyncEnabled)
                this.profiles.update(
                  id,
                  { autoSyncEnabled: false },
                  '"v' + this.profiles.get(id).version + '"',
                );
            });
            return this.intents.outcome(commandId);
          } finally {
            clearTimeout(timeout);
          }
        },
        cancellation,
      )
      .catch((error) => {
        // Includes pre-provider lease conflicts and failed release; never repeats the action.
        const outcome = this.intents.outcome(commandId);
        if (outcome.receipt.status === 'queued' || outcome.receipt.status === 'running')
          return this.intents.finish(
            commandId,
            'failed',
            undefined,
            syncFailure(error, cancellation),
          );
        throw error;
      })
      .finally(() => {
        this.running.delete(commandId);
      });
    return this.track(task);
  }
  pendingPreview(id: string): AxtermConfigurationPreview {
    this.assertOpen();
    const profile = this.profiles.getRecord(id);
    const preview = profile.pendingPreviewId
      ? this.source.getPreview(profile.pendingPreviewId)
      : null;
    if (profile.state !== 'download-preview' || !preview) throw new SyncWorkflowError('not-found');
    return preview;
  }
  commit(
    commandId: string,
    generation: string,
    id: string,
    previewId: string,
  ): Promise<AxtermSyncCommitResult> {
    this.admit(generation);
    return this.track(
      this.coordinator.withResource(
        id,
        async (lease) => {
          this.intents.recoverResource(lease);
          lease.assert();
          const result = this.source.commit(previewId, (importPreview) =>
            this.commands.execute(commandId, 'sync/commit', { id, previewId }, () => {
              const profile = this.profiles.getRecord(id);
              if (profile.state !== 'download-preview' || profile.pendingPreviewId !== previewId)
                throw new SyncWorkflowError('conflict');
              const imported = importPreview();
              const updated = this.profiles.setRunState(id, {
                state: 'idle',
                lastSyncAt: new Date().toISOString(),
                pendingPreviewId: null,
                lastErrorCode: null,
              });
              return axtermSyncCommitResultSchema.parse({
                profile: publicProfile(updated),
                result: imported,
              });
            }),
          );
          this.previews.delete(previewId);
          return result;
        },
        this.lifetime.signal,
      ),
    );
  }
  cancelDownload(commandId: string, generation: string, id: string): Promise<SyncProfile> {
    this.admit(generation);
    return this.track(
      this.coordinator.withResource(
        id,
        async (lease) => {
          this.intents.recoverResource(lease);
          let preview: string | null = null;
          const result = this.commands.execute(commandId, 'sync/cancel-preview', { id }, () => {
            preview = this.profiles.getRecord(id).pendingPreviewId;
            return publicProfile(
              this.profiles.setRunState(id, {
                state: 'idle',
                pendingPreviewId: null,
                lastErrorCode: null,
              }),
            );
          });
          if (preview) this.cancelPreview(preview);
          return result;
        },
        this.lifetime.signal,
      ),
    );
  }
  cancel(commandId: string): void {
    this.assertOpen();
    if (!z.uuid().safeParse(commandId).success) throw new SyncWorkflowError('invalid-input');
    this.running.get(commandId.toLowerCase())?.abort();
  }
  async tick(now = performance.now()): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    this.refreshSchedule(now);
    const candidates = this.profiles
      .listRecords()
      .filter((profile) => {
        const schedule = this.schedule.get(profile.id);
        return schedule && now >= schedule.due && this.automaticDue(profile);
      })
      .slice(0, 2);
    await Promise.allSettled(
      candidates.map((profile) => {
        this.schedule.get(profile.id)!.due = now + profile.autoSyncIntervalMinutes * 60_000;
        return this.run(
          randomUUID(),
          this.generation,
          profile.id,
          'upload',
          this.lifetime.signal,
          undefined,
          true,
        );
      }),
    );
  }
  resourceCount(): number {
    return this.pending.size + this.running.size + this.coordinator.resourceCount();
  }
  active(): boolean {
    return this.pending.size > 0 || this.coordinator.active();
  }
  close(): Promise<void> {
    this.lifetime.abort();
    clearInterval(this.timer);
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.pending]);
      await this.coordinator.close();
      for (const preview of this.previews) this.source.cancel(preview);
      this.previews.clear();
      this.schedule.clear();
    })());
  }
  private automaticDue(profile: SyncProfileRecord, ignoredCommandId?: string): boolean {
    return (
      profile.autoSyncEnabled &&
      profile.autoSyncDirection === 'upload' &&
      ['idle', 'failed'].includes(profile.state) &&
      !this.intents
        .list()
        .some(
          (run) =>
            run.commandId !== ignoredCommandId &&
            run.profileId === profile.id &&
            ['queued', 'running'].includes(run.status),
        ) &&
      (!profile.lastSyncAt ||
        Date.now() - Date.parse(profile.lastSyncAt) >= profile.autoSyncIntervalMinutes * 60_000)
    );
  }
  private refreshSchedule(now: number): void {
    const profiles = this.profiles.listRecords();
    const ids = new Set(profiles.map((profile) => profile.id));
    for (const id of this.schedule.keys()) if (!ids.has(id)) this.schedule.delete(id);
    for (const profile of profiles) {
      const signature = JSON.stringify([
        profile.autoSyncEnabled,
        profile.autoSyncIntervalMinutes,
        profile.autoSyncDirection,
      ]);
      if (this.schedule.get(profile.id)?.signature !== signature)
        this.schedule.set(profile.id, {
          signature,
          due: now + profile.autoSyncIntervalMinutes * 60_000,
        });
    }
  }
  private cancelPreview(preview: string): void {
    this.source.cancel(preview);
    this.previews.delete(preview);
  }
  private async requireSecret(ref: string): Promise<string> {
    const value = await this.resolveSecret(ref);
    if (!value || value.length > 131_072) throw new SyncWorkflowError('not-configured');
    return value;
  }
  private assertOpen(): void {
    if (this.lifetime.signal.aborted) throw new SyncWorkflowError('closed');
  }
  private admit(generation: string): void {
    this.assertOpen();
    if (generation !== this.generation) throw new SyncWorkflowError('stale-generation');
    if (this.pending.size >= 4) throw new SyncWorkflowError('capacity');
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
}
function publicProfile(record: SyncProfileRecord): SyncProfile {
  const { accessCredentialRef: _access, encryptionCredentialRef: _encryption, ...value } = record;
  return syncProfileSchema.parse(value);
}
export function syncFailure(error: unknown, signal?: AbortSignal): SyncFailure {
  if (error instanceof SyncWorkflowError) return error.reason;
  if (signal?.aborted) return 'cancelled';
  if (error instanceof z.ZodError) return 'invalid-input';
  if (error instanceof StorageCommandError)
    return error.code === 'receipt-expired'
      ? 'receipt-expired'
      : error.code === 'conflict'
        ? 'conflict'
        : 'unavailable';
  if (error instanceof PortableApplicationError)
    return error.code === 'ATTACHMENT_EXPIRED'
      ? 'not-found'
      : error.code === 'CONFLICT'
        ? 'conflict'
        : 'invalid-input';
  if (error instanceof SyncApplicationError) {
    const reasons: Partial<Record<SyncApplicationError['code'], SyncFailure>> = {
      NOT_FOUND: 'not-found',
      CONFLICT: 'conflict',
      PRECONDITION_FAILED: 'conflict',
      CAPABILITY_UNAVAILABLE: 'unavailable',
      INVALID_STATE: 'invalid-input',
      VALIDATION_ERROR: 'invalid-input',
      PAYLOAD_TOO_LARGE: 'capacity',
      CAPACITY_EXCEEDED: 'capacity',
      SYNC_NOT_CONFIGURED: 'not-configured',
      SYNC_FORMAT_UNSUPPORTED: 'invalid-input',
      SYNC_REMOTE_CONFLICT: 'remote-conflict',
      SYNC_REMOTE_INVALID: 'remote-invalid',
      SYNC_PROVIDER_FAILED: 'provider-failed',
      SYNC_GIST_CLONE_REQUIRED: 'gist-clone-required',
      SYNC_GITEE_TRUNCATED: 'gitee-truncated',
      SYNC_ABORTED: 'cancelled',
    };
    return reasons[error.code] ?? 'unavailable';
  }
  return 'unavailable';
}
function comparison(
  profile: SyncProfileRecord,
  local: AxtermSyncDocument,
  remoteObject: SyncRemoteObject | null,
  remote: AxtermSyncDocument | null,
) {
  return syncComparisonSchema.parse({
    profileId: profile.id,
    remoteExists: remote !== null,
    remoteRevision: remoteObject?.revision ?? null,
    remoteUpdatedAt: remoteObject?.updatedAt ?? null,
    deviceName: remote?.deviceName ?? null,
    appVersion: remote?.appVersion ?? null,
    checkedAt: new Date().toISOString(),
    categories: profile.selectedCategories.map((category) => {
      const item = local.categories[category];
      if (!item) throw new SyncWorkflowError('unavailable');
      const other = remote?.categories[category];
      return {
        category,
        localCount: item.count,
        remoteCount: other?.count ?? 0,
        localHash: item.hash,
        remoteHash: other?.hash ?? null,
        state: !other
          ? 'local-only'
          : item.hash === other.hash
            ? 'equal'
            : item.count === 0
              ? 'remote-only'
              : other.count === 0
                ? 'local-only'
                : 'different',
      };
    }),
  });
}
