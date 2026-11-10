import { LegalDocuments } from './legal.ts';
import type { LegalDocumentsBaseline, LegalDocumentChunk } from '@axterm/plugin-api/configuration';
import { SettingsVisualReferences } from './visual-references.ts';
import type { TerminalRecoveryPreferences } from '@axterm/plugin-api/configuration';
import { TemporaryCredentialCleanup } from './application/temporary-credentials.ts';
import { createHash } from 'node:crypto';
import {
  workspacePresentationSchema,
  workspacePresentationSlotSchema,
  type WorkspacePresentation,
  type WorkspacePresentationBinding,
  type WorkspacePresentationReceipt,
} from '@axterm/plugin-api/configuration';
import { installSyncConfiguration, type ConfigurationSyncRuntime } from './sync.ts';
import type * as Sync from '@axterm/plugin-api/configuration-sync';
import { installPortableConfiguration, type ConfigurationPortableRuntime } from './portable.ts';
import type * as Portable from '@axterm/plugin-api/configuration-portable';
import {
  Remote,
  RemoteError,
  remoteErrorOf,
  StorageCommandError,
  TypertRemoteService,
} from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
import {
  updateSettingsSchema,
  type Settings,
  type SettingsReceipt,
  type UpdateSettingsInput,
  type ConfigurationFailureReason,
} from '@axterm/plugin-api/configuration';
import { productDomains } from '@axterm/data-schema';
import { DomainCommands } from '@axterm/infra-storage-domain';
import type { Context } from '@deepseek-ai/cordis';
import { z, ZodError } from 'zod';
import type * as Credentials from '@axterm/plugin-api/saved-credentials';
import { savedCredentialsSnapshotSchema } from '@axterm/plugin-api/saved-credentials';
import { CredentialIntents } from './adapters/credential-intents.ts';
import { SavedCredentialWorkflow } from './application/saved-credentials.ts';
import { CredentialWorkflowError } from './application/errors.ts';
import { CredentialSnapshotObservation } from './credential-observation.ts';
import { SettingsRepository } from './adapters/settings-repository.ts';
import { SettingsHistory } from './history.ts';
import { SettingsError } from './application/errors.ts';
import { SettingsObservation } from './observation.ts';
import type { SettingsUpdate } from '@axterm/plugin-api/configuration';
import { SettingsApplication } from './application/settings.ts';
export const inject = ['storage', 'storageDomain', 'runtimeIdentity'];
declare module '@deepseek-ai/cordis' {
  interface Context {
    configurationController: ConfigurationController;
  }
}
export class ConfigurationController extends TypertRemoteService {
  private open = true;
  private readonly legal = new LegalDocuments();
  private closing?: Promise<void>;
  constructor(
    ctx: Context,
    private readonly settings: SettingsApplication,
    private readonly observation: SettingsObservation,
    private readonly credentials?: SavedCredentialWorkflow,
    private readonly credentialObservation?: CredentialSnapshotObservation,
    private readonly portable?: () => ConfigurationPortableRuntime | undefined,
    private readonly sync?: () => ConfigurationSyncRuntime | undefined,
  ) {
    super(ctx, 'configurationController', { namespace: 'configuration' });
    ctx.effect(() => () => this.close());
    if (credentials)
      ctx.inject(['desktopTaskInspection'], (scope) => {
        scope.desktopTaskInspection.register('configuration.credentials', {
          inspect: (signal) => {
            signal.throwIfAborted();
            return { active: credentials.active() };
          },
          dispose: () => this.close(),
        });
      });
  }
  private syncWorkflow(): ConfigurationSyncRuntime {
    const workflow = this.open ? this.sync?.() : undefined;
    if (!workflow)
      throw new RemoteError('configuration/sync-failure', 'Sync is unavailable', {
        reason: this.open ? 'unavailable' : 'closed',
      });
    return workflow;
  }
  @Remote({ mode: 'stream' }) watchSync(signal: AbortSignal): AsyncIterable<Sync.SyncUpdate> {
    return this.syncWorkflow().watch(signal);
  }
  @Remote createSyncProfile(
    commandId: string,
    generation: string,
    input: Sync.SyncProfileInput,
  ): Promise<Sync.SyncProfile> {
    return this.syncWorkflow().call((app) => app.create(commandId, generation, input));
  }
  @Remote updateSyncProfile(
    commandId: string,
    generation: string,
    id: string,
    input: Sync.SyncProfilePatch,
    ifMatch: string | undefined,
  ): Promise<Sync.SyncProfile> {
    return this.syncWorkflow().call((app) => app.update(commandId, generation, id, input, ifMatch));
  }
  @Remote deleteSyncProfile(
    commandId: string,
    generation: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<void> {
    return this.syncWorkflow().call((app) => app.remove(commandId, generation, id, ifMatch));
  }
  @Remote runSync(
    commandId: string,
    generation: string,
    id: string,
    operation: Sync.SyncOperation,
    grantId: string | undefined,
    signal: AbortSignal,
  ): Promise<Sync.SyncCommandOutcome> {
    return this.syncWorkflow().call((app) =>
      app.run(commandId, generation, id, operation, signal, grantId),
    );
  }
  @Remote getSyncOutcome(commandId: string): Promise<Sync.SyncCommandOutcome> {
    return this.syncWorkflow().call((app) => app.outcome(commandId));
  }
  @Remote cancelSync(commandId: string): Promise<void> {
    return this.syncWorkflow().call((app) => app.cancel(commandId));
  }
  @Remote getSyncDownloadPreview(id: string): Promise<Portable.AxtermConfigurationPreview> {
    return this.syncWorkflow().call((app) => app.pendingPreview(id));
  }
  @Remote commitSyncDownload(
    commandId: string,
    generation: string,
    id: string,
    previewId: string,
  ): Promise<Sync.AxtermSyncCommitResult> {
    return this.syncWorkflow().call((app) => app.commit(commandId, generation, id, previewId));
  }
  @Remote cancelSyncDownload(
    commandId: string,
    generation: string,
    id: string,
  ): Promise<Sync.SyncProfile> {
    return this.syncWorkflow().call((app) => app.cancelDownload(commandId, generation, id));
  }
  @Remote async exportConfiguration(
    grantId: string,
    signal: AbortSignal,
  ): Promise<Portable.AxtermConfigurationExportResult> {
    return this.portableWorkflow().export(grantId, signal);
  }
  @Remote async inspectConfiguration(
    grantId: string,
    signal: AbortSignal,
  ): Promise<Portable.AxtermConfigurationInspectResult> {
    return this.portableWorkflow().inspect(grantId, signal);
  }
  @Remote async previewConfiguration(
    grantId: string,
    applySettings: boolean,
    signal: AbortSignal,
  ): Promise<Portable.AxtermConfigurationPreview> {
    return this.portableWorkflow().preview(grantId, applySettings, signal);
  }
  @Remote async importConfiguration(
    commandId: string,
    previewId: string,
  ): Promise<Portable.AxtermConfigurationImportResult> {
    return this.portableWorkflow().commit(commandId, previewId);
  }
  @Remote async cancelConfigurationPreview(previewId: string): Promise<void> {
    return this.portableWorkflow().cancel(previewId);
  }
  @Remote({ mode: 'stream' }) watchConfigurationPreviews(
    signal: AbortSignal,
  ): AsyncIterable<Portable.ConfigurationPortableUpdate> {
    return this.portableWorkflow().watch(signal);
  }
  private portableWorkflow(): ConfigurationPortableRuntime {
    const workflow = this.open ? this.portable?.() : undefined;
    if (!workflow)
      throw new RemoteError(
        'configuration/portable-failure',
        'Configuration workflow is unavailable',
        { reason: this.open ? 'unavailable' : 'closed' },
      );
    return workflow;
  }
  @Remote async listCredentials(): Promise<readonly Credentials.SavedCredentialMetadata[]> {
    return this.credentialCall(() => this.saved().list());
  }
  @Remote({ mode: 'stream' }) watchCredentials(
    signal: AbortSignal,
  ): AsyncIterable<Credentials.SavedCredentialsUpdate> {
    if (!this.open || !this.credentialObservation)
      throw new RemoteError(
        'configuration/credentials-failure',
        'Credential inventory is unavailable',
        { reason: this.open ? 'unavailable' : 'closed' },
      );
    return this.credentialObservation.watch(signal);
  }
  @Remote async createCredential(
    commandId: string,
    generation: string,
    input: Credentials.CreateSavedCredentialInput,
  ): Promise<Credentials.CredentialCommandReceipt> {
    return this.credentialCall(() => this.saved().create(commandId, generation, input));
  }
  @Remote async importCredentialFromGrant(
    commandId: string,
    generation: string,
    input: Credentials.CreateGrantedCredentialInput,
    signal: AbortSignal,
  ): Promise<Credentials.CredentialCommandReceipt> {
    return this.credentialCall(() => {
      const files = this.ctx.get('fileGrants');
      if (!files) throw new CredentialWorkflowError('unavailable');
      return this.saved().createFromGrant(
        commandId,
        generation,
        input,
        async (grantId, maxBytes, signal) =>
          (await files.readText(grantId, maxBytes, signal)).content,
        signal,
      );
    });
  }
  @Remote async replaceCredential(
    commandId: string,
    generation: string,
    ref: string,
    secret: string,
  ): Promise<Credentials.CredentialCommandReceipt> {
    return this.credentialCall(() => this.saved().replace(commandId, generation, ref, secret));
  }
  @Remote async deleteCredential(
    commandId: string,
    generation: string,
    ref: string,
  ): Promise<Credentials.CredentialCommandReceipt> {
    return this.credentialCall(() => this.saved().remove(commandId, generation, ref));
  }
  @Remote async getCredentialOutcome(
    commandId: string,
  ): Promise<Credentials.CredentialCommandReceipt> {
    return this.credentialCall(() => this.saved().outcome(commandId));
  }
  close(): Promise<void> {
    this.open = false;
    return (this.closing ??= (async () => {
      await Promise.all([
        this.observation.dispose(),
        this.credentialObservation?.dispose(),
        this.credentials?.close(),
        this.legal.close(),
      ]);
    })());
  }
  private saved(): SavedCredentialWorkflow {
    if (!this.credentials) throw new CredentialWorkflowError('unavailable');
    return this.credentials;
  }
  private async credentialCall<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      if (!this.open) throw new CredentialWorkflowError('closed');
      return await operation();
    } catch (error) {
      throw new RemoteError(
        'configuration/credentials-failure',
        'The credential operation failed',
        {
          reason: error instanceof CredentialWorkflowError ? error.reason : 'unavailable',
        },
      );
    }
  }
  @Remote listLegalDocuments(): LegalDocumentsBaseline {
    return this.call(() => ({
      generation: this.ctx.runtimeIdentity.generation,
      documents: this.legal.list(),
    }));
  }
  @Remote({ mode: 'stream' }) readLegalDocument(
    id: string,
    signal: AbortSignal,
  ): AsyncIterable<LegalDocumentChunk> {
    if (!this.open)
      throw new RemoteError('configuration/failure', 'Legal documents are closed', {
        reason: 'closed',
      });
    return this.legal.read(id, signal);
  }
  @Remote getSettings(): Settings {
    return this.call(() => this.settings.getSettings());
  }
  @Remote({ mode: 'stream' }) watchSettings(signal: AbortSignal): AsyncIterable<SettingsUpdate> {
    return this.call(() => this.observation.watch(signal));
  }
  @Remote bindWorkspacePresentation(slot: string): WorkspacePresentationBinding {
    return this.call(() => {
      const input = workspacePresentationSlotSchema.parse(slot),
        profile = this.ctx.runtimeIdentity.profileName ?? this.ctx.runtimeIdentity.mode;
      return {
        key: createHash('sha256').update(profile).digest('hex').slice(0, 32) + '_' + input,
        generation: this.ctx.runtimeIdentity.generation,
        importRevision: this.settings.getSettings().workspace.importRevision,
      };
    });
  }
  @Remote async saveWorkspacePresentation(
    key: string,
    slot: string,
    input: WorkspacePresentation,
    version: number,
    generation: string,
    importRevision: number,
  ): Promise<WorkspacePresentationReceipt> {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('configuration/failure', 'Workspace generation is retired', {
          reason: 'conflict',
        });
      return this.settings.saveWorkspacePresentation(
        z.uuid().parse(key),
        this.bindWorkspacePresentation(slot).key,
        workspacePresentationSchema.parse(input),
        z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 1)
          .parse(version),
        generation,
        z.number().int().nonnegative().parse(importRevision),
      );
    });
  }
  @Remote setTerminalRecoveryPreferences(
    key: string,
    input: TerminalRecoveryPreferences,
    ifMatch: string | undefined,
    generation: string,
  ): SettingsReceipt {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError(
          'configuration/failure',
          'Monitor preferences generation is retired',
          { reason: 'conflict' },
        );
      return this.settings.updateSettings(
        key,
        updateSettingsSchema.parse({
          terminal: updateSettingsSchema.shape.terminal
            .unwrap()
            .pick({
              autoReconnectTerminal: true,
              restoreTerminalSessionOnReload: true,
              shortcutBarEnabled: true,
              commandSuggestionsEnabled: true,
              dragDropBehavior: true,
            })
            .strict()
            .parse(input),
        }),
        ifMatch,
      );
    });
  }
  @Remote setLegacyShortcutBindings(
    key: string,
    bindings: Settings['shortcuts']['bindings'],
    ifMatch: string | undefined,
    generation: string,
  ): SettingsReceipt {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('configuration/failure', 'Shortcut generation is retired', {
          reason: 'conflict',
        });
      return this.settings.updateSettings(
        key,
        updateSettingsSchema.parse({ shortcuts: { bindings } }),
        ifMatch,
      );
    });
  }
  @Remote setShortcutDocument(
    key: string,
    document: NonNullable<Settings['shortcuts']['document']>,
    ifMatch: string | undefined,
    generation: string,
    resetTerminalGestures: boolean,
  ): SettingsReceipt {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('configuration/failure', 'Shortcut generation is retired', {
          reason: 'conflict',
        });
      return this.settings.updateSettings(
        key,
        updateSettingsSchema.parse({
          shortcuts: { document },
          ...(resetTerminalGestures ? { resetTerminalGestures: true as const } : {}),
        }),
        ifMatch,
      );
    });
  }
  @Remote setMonitorPreferences(
    key: string,
    input: Settings['monitor'],
    ifMatch: string | undefined,
    generation: string,
  ): SettingsReceipt {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError(
          'configuration/failure',
          'Monitor preferences generation is retired',
          { reason: 'conflict' },
        );
      return this.settings.updateSettings(
        key,
        updateSettingsSchema.parse({ monitor: input }),
        ifMatch,
      );
    });
  }
  @Remote setTerminalShortcutBarButtons(
    key: string,
    buttons: Settings['terminal']['shortcutBarButtons'],
    ifMatch: string | undefined,
    generation: string,
  ): SettingsReceipt {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError(
          'configuration/failure',
          'Terminal key preferences generation is retired',
          { reason: 'conflict' },
        );
      return this.settings.updateSettings(
        key,
        updateSettingsSchema.parse({ terminal: { shortcutBarButtons: buttons } }),
        ifMatch,
      );
    });
  }
  @Remote setTerminalVisual(
    key: string,
    visual: Settings['terminal']['visual'],
    ifMatch: string | undefined,
    generation: string,
  ): SettingsReceipt {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('configuration/failure', 'Terminal visual generation is retired', {
          reason: 'conflict',
        });
      return this.settings.updateSettings(
        key,
        updateSettingsSchema.parse({ terminal: { visual } }),
        ifMatch,
      );
    });
  }
  @Remote updateSettings(
    key: string,
    input: UpdateSettingsInput,
    ifMatch: string | undefined,
  ): SettingsReceipt {
    return this.call(() => {
      const command = updateSettingsSchema.parse(input);
      return this.settings.updateSettings(key, command, ifMatch);
    });
  }
  private call<T>(operation: () => T): T {
    if (!this.open)
      throw new RemoteError('configuration/failure', 'Configuration is closed', {
        reason: 'closed',
      });
    try {
      return operation();
    } catch (error) {
      const marked = remoteErrorOf(error);
      if (marked?.code === 'configuration/failure') throw marked;
      let reason: ConfigurationFailureReason = 'unavailable';
      if (error instanceof SettingsError)
        reason =
          error.code === 'PRECONDITION_REQUIRED' ? 'precondition-required' : 'precondition-failed';
      else if (error instanceof ZodError) reason = 'invalid-input';
      else if (error instanceof StorageCommandError)
        reason =
          error.code === 'receipt-expired'
            ? 'receipt-expired'
            : error.code === 'conflict'
              ? 'conflict'
              : 'invalid-input';
      throw new RemoteError('configuration/failure', 'The settings operation failed', { reason });
    }
  }
}
export async function apply(ctx: Context, raw?: unknown): Promise<void> {
  const config = z
    .object({
      profile: z.string().min(1).max(128).optional(),
      coordinationDirectory: z.string().min(1).max(4096).optional(),
    })
    .strict()
    .parse(raw ?? {});
  const owned: {
    controller?: ConfigurationController;
    portable?: { close(): Promise<void> };
    sync?: { close(): Promise<void> };
  } = {};
  const opening = ctx.storage.domain.open(productDomains.configuration);
  ctx.effect(() => async () => {
    await owned.controller?.close();
    await owned.sync?.close();
    await owned.portable?.close();
    await (await opening.catch(() => undefined))?.close();
  });
  const domain = await opening;
  const history = new SettingsHistory(ctx);
  const store = new SettingsRepository(domain);
  const commands = new DomainCommands(domain, 'axterm_configuration_command_receipts');
  const references = new SettingsVisualReferences(ctx);
  const settings = new SettingsApplication(
    store,
    {
      transaction: (input, operation) =>
        ctx.storage.domain.transaction(
          [
            domain.participant,
            ...history.participants(input?.privacy),
            ...references.participants(input),
          ],
          operation,
        ),
      purgeHistory: (privacy) => history.purge(privacy),
      validateReferences: (input) => references.validate(input),
    },
    commands,
    () => domain.cursor(),
  );
  const observation = new SettingsObservation(domain, ctx.runtimeIdentity.generation, () =>
    settings.getSettings(),
  );
  const credentials = config.profile
    ? new SavedCredentialWorkflow(
        ctx.runtimeIdentity.generation,
        new CredentialIntents(domain, config.profile, ctx.runtimeIdentity.generation),
        () => ctx.get('credentials')?.saved,
      )
    : undefined;
  const credentialObservation = credentials
    ? new CredentialSnapshotObservation(ctx.runtimeIdentity.generation, async () =>
        savedCredentialsSnapshotSchema.parse({ credentials: await credentials.list() }),
      )
    : undefined;
  const temporaryCredentials = new TemporaryCredentialCleanup(
    ctx.runtimeIdentity.generation,
    credentials,
    () => ctx.get('credentials')?.saved,
  );
  ctx.provide('temporaryCredentials', temporaryCredentials);
  ctx.effect(() => () => temporaryCredentials.close());
  const controller = new ConfigurationController(
    ctx,
    settings,
    observation,
    credentials,
    credentialObservation,
    () => ctx.get('configurationPortable'),
    () => ctx.get('configurationSync'),
  );
  owned.controller = controller;
  owned.portable = installPortableConfiguration(ctx, domain, settings);
  if (config.profile && config.coordinationDirectory)
    owned.sync = installSyncConfiguration(
      ctx,
      domain,
      config.profile,
      config.coordinationDirectory,
    );
  ctx.provide('configuration', {
    participant: domain.participant,
    getSettings: () => controller.getSettings(),
  });
}
