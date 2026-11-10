import { ConfigurationPortableHttp } from './adapters/portable-http.ts';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { RemoteError, remoteErrorOf, StorageCommandError } from '@axterm/plugin-api';
import {
  configurationPortableSnapshotSchema,
  CONFIGURATION_PORTABLE_MAX_SNAPSHOT_BYTES,
  type AxtermConfigurationPreview,
  type AxtermConfigurationInspectResult,
  type AxtermConfigurationExportResult,
  type AxtermConfigurationImportResult,
  type ConfigurationPortableFailure,
  type ConfigurationPortableUpdate,
} from '@axterm/plugin-api/configuration-portable';
import { ConfigurationPortableApplication } from './application/portable.ts';
import { PortableApplicationError } from './application/portable-errors.ts';
import { ConfigurationPortableStore } from './adapters/portable-store.ts';
import { ConfigurationPortableFiles } from './adapters/portable-files.ts';
import { CredentialSnapshotObservation } from './credential-observation.ts';
import type { SettingsApplication } from './application/settings.ts';

const failure = (reason: ConfigurationPortableFailure) =>
  new RemoteError('configuration/portable-failure', 'The configuration operation failed', {
    reason,
  });
/** One Configuration-owned workflow lifetime, paired with its selected collaborating owners. */
export class ConfigurationPortableRuntime {
  private readonly lifetime = new AbortController();
  private readonly http = new Set<ConfigurationPortableHttp>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly observation: CredentialSnapshotObservation;
  private closing: Promise<void> | undefined;
  constructor(
    readonly application: ConfigurationPortableApplication,
    generation: string,
  ) {
    this.observation = new CredentialSnapshotObservation(
      generation,
      async () =>
        configurationPortableSnapshotSchema.parse({ previews: application.listPreviews() }),
      undefined,
      failure,
      CONFIGURATION_PORTABLE_MAX_SNAPSHOT_BYTES,
    );
  }
  bindHttp(ctx: Context, generation: string): () => Promise<void> {
    const server = new ConfigurationPortableHttp(ctx, generation, this);
    this.http.add(server);
    return async () => {
      await server.close();
      this.http.delete(server);
    };
  }
  exportContents(signal: AbortSignal): Promise<Uint8Array> {
    return this.run(() => this.application.exportContents(), signal);
  }
  inspectContents(
    contents: Uint8Array,
    signal: AbortSignal,
  ): Promise<AxtermConfigurationInspectResult> {
    return this.run(() => this.application.inspectContents(contents), signal);
  }
  previewContents(
    contents: Uint8Array,
    applySettings: boolean,
    signal: AbortSignal,
  ): Promise<AxtermConfigurationPreview> {
    return this.run(() => this.application.previewContents(contents, applySettings), signal);
  }
  active(): boolean {
    return this.pending.size > 0 || [...this.http].some((server) => server.resourceCount() > 0);
  }

  export(grantId: string, signal: AbortSignal): Promise<AxtermConfigurationExportResult> {
    return this.run(
      () => this.application.export(grantId, AbortSignal.any([signal, this.lifetime.signal])),
      signal,
    );
  }
  inspect(grantId: string, signal: AbortSignal): Promise<AxtermConfigurationInspectResult> {
    return this.run(
      () => this.application.inspect(grantId, AbortSignal.any([signal, this.lifetime.signal])),
      signal,
    );
  }
  preview(
    grantId: string,
    applySettings: boolean,
    signal: AbortSignal,
  ): Promise<AxtermConfigurationPreview> {
    return this.run(
      () =>
        this.application.preview(
          grantId,
          applySettings,
          AbortSignal.any([signal, this.lifetime.signal]),
        ),
      signal,
    );
  }
  commit(commandId: string, previewId: string): Promise<AxtermConfigurationImportResult> {
    return this.run(() => this.application.commit(previewId, commandId));
  }
  cancel(previewId: string): Promise<void> {
    return this.run(() => this.application.cancelPreview(previewId));
  }
  watch(signal: AbortSignal): AsyncIterable<ConfigurationPortableUpdate> {
    if (this.lifetime.signal.aborted) throw failure('closed');
    return this.observation.watch(AbortSignal.any([signal, this.lifetime.signal]));
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      this.application.close();
      await Promise.all([...this.http].map((server) => server.close()));
      await this.observation.dispose();
      await Promise.allSettled([...this.pending]);
    })());
  }
  private run<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(failure('closed'));
    // Four documents/previews, at most 16 MiB each, share one bounded admission budget.
    if (this.pending.size >= 4) return Promise.reject(failure('capacity'));
    const task = Promise.resolve()
      .then(() => {
        if (this.lifetime.signal.aborted) throw failure('closed');
        return operation();
      })
      .catch((error) => {
        if (this.lifetime.signal.aborted || signal?.aborted) throw failure('cancelled');
        const marked = remoteErrorOf(error);
        if (marked?.code === 'configuration/portable-failure') throw marked;
        if (error instanceof StorageCommandError)
          throw failure(
            error.code === 'receipt-expired'
              ? 'receipt-expired'
              : error.code === 'conflict'
                ? 'conflict'
                : 'invalid-input',
          );
        if (error instanceof PortableApplicationError) {
          const reasons: Partial<
            Record<PortableApplicationError['code'], ConfigurationPortableFailure>
          > = {
            CLOSED: 'closed',
            VALIDATION_ERROR: 'invalid-input',
            INVALID_STATE: 'invalid-input',
            PRECONDITION_FAILED: 'stale',
            CONFLICT: 'conflict',
            PAYLOAD_TOO_LARGE: 'capacity',
            CAPACITY_EXCEEDED: 'capacity',
            ATTACHMENT_EXPIRED: 'stale',
          };
          throw failure(reasons[error.code] ?? 'unavailable');
        }
        if (marked?.details && typeof marked.details === 'object' && 'reason' in marked.details) {
          const reason = marked.details.reason;
          if (
            reason === 'closed' ||
            reason === 'cancelled' ||
            reason === 'capacity' ||
            reason === 'conflict' ||
            reason === 'not-found'
          )
            throw failure(reason);
        }
        throw failure('unavailable');
      });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    configurationPortable: ConfigurationPortableRuntime;
  }
}

export function installPortableConfiguration(
  ctx: Context,
  domain: RelationalDomain,
  settings: SettingsApplication,
): { close(): Promise<void> } {
  const runtimes = new Set<ConfigurationPortableRuntime>();
  let closed = false;
  ctx.inject(['catalog', 'terminalFacts', 'connections', 'automation'], (scope) => {
    if (closed) return;
    const catalog = scope.catalog.configurationImport;
    const automation = scope.automation.configurationImport;
    const connections = scope.connections;
    if (!catalog || !automation || !connections.participant) throw failure('unavailable');
    const terminals = scope.terminalFacts;
    const store = new ConfigurationPortableStore(domain, (operation) =>
      scope.storage.domain.transaction(
        [
          domain.participant,
          scope.catalog.participant,
          terminals.participant,
          connections.participant!,
          scope.automation.participant,
        ],
        operation,
      ),
    );
    const app = new ConfigurationPortableApplication(
      store,
      {
        listHosts: () => scope.catalog.listHosts(),
        listHostGroups: () => scope.catalog.listHostGroups(),
        createHost: (input) => catalog.hosts.createHost(input),
        createHostGroup: (input) => catalog.hosts.createHostGroup(input),
        listTerminalProfiles: () => terminals.listProfiles(),
        createTerminalProfile(input) {
          const result = terminals.createProfile(randomUUID(), input);
          return terminals.getProfile(result.ids[0]!);
        },
        listTunnelProfiles: () => connections.listTunnelProfiles(),
        createTunnelProfile(input) {
          const result = connections.createTunnelProfile(randomUUID(), input);
          const created = connections
            .listTunnelProfiles()
            .find((item) => item.id === result.ids[0]);
          if (!created) throw failure('unavailable');
          return created;
        },
        getSettings: () => settings.getSettings(),
        updateSettings(input, ifMatch) {
          settings.importSettings(randomUUID(), input, ifMatch);
        },
      },
      catalog.bookmarks,
      catalog.profiles,
      automation.quickCommands,
      {
        list: () => terminals.listThemes(),
        create(input) {
          const result = terminals.createTheme(randomUUID(), input);
          const created = terminals.listThemes().find((item) => item.id === result.ids[0]);
          if (!created) throw failure('unavailable');
          return created;
        },
      },
      automation.triggers,
      new ConfigurationPortableFiles(() => scope.get('files')),
      scope.runtimeIdentity.appVersion,
    );
    const runtime = new ConfigurationPortableRuntime(app, scope.runtimeIdentity.generation);
    runtimes.add(runtime);
    scope.provide('configurationPortable', runtime);
    scope.inject(['connection'], (http) => {
      http.effect(() => runtime.bindHttp(http, scope.runtimeIdentity.generation));
    });
    scope.effect(() => async () => {
      await runtime.close();
      runtimes.delete(runtime);
    });
    scope.inject(['desktopTaskInspection'], (tasks) => {
      tasks.desktopTaskInspection.register('configuration.portable', {
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
