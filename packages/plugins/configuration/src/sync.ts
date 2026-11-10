import type { Context } from '@deepseek-ai/cordis';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { RemoteError } from '@axterm/plugin-api';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import { DomainCommands } from '@axterm/infra-storage-domain';
import {
  syncSnapshotSchema,
  type SyncFailure,
  type SyncUpdate,
} from '@axterm/plugin-api/configuration-sync';
import { ConfigurationSyncApplication, syncFailure } from './application/sync.ts';
import { AxtermConfigurationSyncDataSource } from './application/sync-source.ts';
import { SyncWorkflowError } from './application/sync-errors.ts';
import { OwnedSyncProfiles } from './adapters/sync-profiles.ts';
import { SyncIntents } from './adapters/sync-intents.ts';
import { SyncResourceCoordinator } from './adapters/sync-coordination.ts';
import { SyncBackupFiles } from './adapters/sync-backup.ts';
import {
  CustomSyncProvider,
  GistSyncProvider,
  WebDavSyncProvider,
} from './adapters/sync-providers.ts';
import { CredentialSnapshotObservation } from './credential-observation.ts';
import type {} from './portable.ts';
const failure = (reason: SyncFailure) =>
  new RemoteError('configuration/sync-failure', 'The sync operation failed', { reason });
export class ConfigurationSyncRuntime {
  private readonly observation: CredentialSnapshotObservation;
  private closed = false;
  private readonly opening: Promise<void>;
  private closing: Promise<void> | undefined;
  constructor(
    readonly application: ConfigurationSyncApplication,
    generation: string,
  ) {
    this.opening = application.initialize();
    void this.opening.catch(() => {});
    this.observation = new CredentialSnapshotObservation(
      generation,
      async () => {
        await this.opening;
        return syncSnapshotSchema.parse(application.snapshot());
      },
      undefined,
      failure,
      4 * 1024 * 1024,
    );
  }
  async call<T>(operation: (app: ConfigurationSyncApplication) => T | Promise<T>): Promise<T> {
    try {
      if (this.closed) throw new SyncWorkflowError('closed');
      await this.opening;
      if (this.closed) throw new SyncWorkflowError('closed');
      return await operation(this.application);
    } catch (error) {
      throw failure(syncFailure(error));
    }
  }
  watch(signal: AbortSignal): AsyncIterable<SyncUpdate> {
    if (this.closed) throw failure('closed');
    return this.observation.watch(signal);
  }
  active(): boolean {
    return this.application.active();
  }
  close(): Promise<void> {
    this.closed = true;
    return (this.closing ??= (async () => {
      const closing = this.application.close();
      void closing.catch(() => {});
      await this.observation.dispose();
      await closing;
    })());
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    configurationSync: ConfigurationSyncRuntime;
  }
}
export function installSyncConfiguration(
  ctx: Context,
  domain: RelationalDomain,
  profile: string,
  directory: string,
): { close(): Promise<void> } {
  const runtimes = new Set<ConfigurationSyncRuntime>();
  let closed = false;
  ctx.inject(['configurationPortable'], (scope) => {
    if (closed) return;
    const coordinator = new SyncResourceCoordinator(directory);
    const application = new ConfigurationSyncApplication(
      domain,
      new OwnedSyncProfiles(domain),
      new SyncIntents(domain, profile, scope.runtimeIdentity.generation),
      coordinator,
      new DomainCommands(domain, 'axterm_configuration_command_receipts'),
      scope.runtimeIdentity.generation,
      new AxtermConfigurationSyncDataSource(scope.configurationPortable.application),
      async (ref) => {
        const value = await scope.get('credentials')?.resolve(encodeOpaqueCredentialRef(ref));
        if (!value) throw new SyncWorkflowError('not-configured');
        return value.value;
      },
      [
        new GistSyncProvider('github'),
        new GistSyncProvider('gitee'),
        new WebDavSyncProvider(),
        new CustomSyncProvider(),
      ],
      new SyncBackupFiles(() => scope.get('files')),
      scope.runtimeIdentity.mode !== 'headless',
    );
    const runtime = new ConfigurationSyncRuntime(application, scope.runtimeIdentity.generation);
    runtimes.add(runtime);
    scope.provide('configurationSync', runtime);
    scope.effect(() => async () => {
      await runtime.close();
      runtimes.delete(runtime);
    });
    scope.inject(['desktopTaskInspection'], (tasks) => {
      tasks.desktopTaskInspection.register('configuration.sync', {
        inspect(signal) {
          signal.throwIfAborted();
          return { active: runtime.active() };
        },
        dispose: () => runtime.close(),
      });
    });
  });
  return {
    async close() {
      closed = true;
      await Promise.all([...runtimes].map((runtime) => runtime.close()));
    },
  };
}
