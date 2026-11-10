import { ImportAutosaveGuard } from './import-autosave.ts';
import { RemoteError } from '@axterm/plugin-api';
import {
  CONFIGURATION_EXPORT_PATH,
  CONFIGURATION_INSPECT_PATH,
  CONFIGURATION_PREVIEW_PATH,
  CONFIGURATION_MAX_FILE_BYTES,
  configurationPortableFailureSchema,
  axtermConfigurationInspectResultSchema,
  axtermConfigurationPreviewSchema,
} from '@axterm/plugin-api/configuration-portable';
import type { Context } from '@deepseek-ai/cordis';
import type {
  AxtermConfigurationExportResult,
  AxtermConfigurationInspectResult,
  AxtermConfigurationPreview,
  AxtermConfigurationImportResult,
  ConfigurationPortableBaseline,
  ConfigurationPortableUpdate,
  ConfigurationPortableFailure,
} from '@axterm/plugin-api/configuration-portable';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { ConfigurationPortableProjection } from './portable-projection.ts';
export type ConfigurationPortableState =
  | { readonly status: 'connecting' }
  | {
      readonly status: 'ready';
      readonly baseline: ConfigurationPortableBaseline;
      readonly inspection?: AxtermConfigurationInspectResult;
      readonly exported?: AxtermConfigurationExportResult;
      readonly receipt?: AxtermConfigurationImportResult;
    }
  | { readonly status: 'error'; readonly message: string };
/** Owns complete generation-local preview metadata; portable file bodies stay in Host streaming IO. */
export class ConfigurationPortableModel {
  private state: ConfigurationPortableState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private readonly commands = new Set<Promise<unknown>>();
  private stream: RemoteStream<ConfigurationPortableUpdate>;
  private done: Promise<void>;
  private readonly lifetime = new AbortController();
  private closing = false;
  private readonly importAutosave = new ImportAutosaveGuard(() =>
    this.ctx.get('workspaceAutosaveUi'),
  );
  private disposed = false;
  private retrying: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    private readonly request: (input: string, init: RequestInit) => Promise<Response> = (
      input,
      init,
    ) => globalThis.fetch(input, init),
  ) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): ConfigurationPortableState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async export(grantId: string): Promise<AxtermConfigurationExportResult> {
    this.admit();
    const generation = this.generation();
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.exportConfiguration(
          grantId,
          this.lifetime.signal,
        );
        if (!result.ok) throw result.error;
        this.sameGeneration(generation);
        if (this.state.status === 'ready') this.publish({ ...this.state, exported: result.value });
        return result.value;
      })(),
    );
  }
  async inspect(grantId: string): Promise<AxtermConfigurationInspectResult> {
    this.admit();
    const generation = this.state.status === 'ready' ? this.state.baseline.generation : undefined;
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.inspectConfiguration(
          grantId,
          this.lifetime.signal,
        );
        if (!result.ok) throw result.error;
        if (this.state.status === 'ready' && this.state.baseline.generation === generation)
          this.publish({ ...this.state, inspection: result.value });
        return result.value;
      })(),
    );
  }
  async preview(grantId: string, applySettings: boolean): Promise<AxtermConfigurationPreview> {
    this.admit();
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.previewConfiguration(
          grantId,
          applySettings,
          this.lifetime.signal,
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async commit(commandId: string, previewId: string): Promise<AxtermConfigurationImportResult> {
    this.admit();
    const generation = this.state.status === 'ready' ? this.state.baseline.generation : undefined;
    return this.track(
      this.importAutosave.run(
        commandId,
        generation!,
        () => this.state.status === 'ready' && this.state.baseline.generation === generation,
        async () => {
          const result = await this.ctx.remote.configuration.importConfiguration(
            commandId,
            previewId,
          );
          if (!result.ok) throw result.error;
          if (this.state.status === 'ready' && this.state.baseline.generation === generation)
            this.publish({ ...this.state, receipt: result.value });
          return result.value;
        },
      ),
    );
  }
  async cancel(previewId: string): Promise<void> {
    this.admit();
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.cancelConfigurationPreview(previewId);
        if (!result.ok) throw result.error;
      })(),
    );
  }
  inspectUpload(file: Blob): Promise<AxtermConfigurationInspectResult> {
    this.admit();
    return this.track(
      (async () => {
        const generation = this.generation();
        const response = await this.http(CONFIGURATION_INSPECT_PATH, file, generation);
        const value = axtermConfigurationInspectResultSchema.parse(
          JSON.parse(new TextDecoder().decode(await this.bytes(response, 1024 * 1024))),
        );
        this.sameGeneration(generation);
        if (this.state.status === 'ready') this.publish({ ...this.state, inspection: value });
        return value;
      })(),
    );
  }
  previewUpload(file: Blob, applySettings: boolean): Promise<AxtermConfigurationPreview> {
    this.admit();
    return this.track(
      (async () => {
        const generation = this.generation();
        const response = await this.http(
          CONFIGURATION_PREVIEW_PATH,
          file,
          generation,
          applySettings,
        );
        const value = axtermConfigurationPreviewSchema.parse(
          JSON.parse(new TextDecoder().decode(await this.bytes(response, 1024 * 1024))),
        );
        this.sameGeneration(generation);
        return value;
      })(),
    );
  }
  exportDownload(): Promise<Blob> {
    this.admit();
    return this.track(
      (async () => {
        const generation = this.generation();
        const response = await this.http(CONFIGURATION_EXPORT_PATH, undefined, generation);
        const bytes = await this.bytes(response, CONFIGURATION_MAX_FILE_BYTES);
        this.sameGeneration(generation);
        return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/json' });
      })(),
    );
  }
  private generation(): string {
    if (this.state.status !== 'ready')
      throw new RemoteError('configuration/portable-failure', 'Configuration is unavailable', {
        reason: 'unavailable',
      });
    return this.state.baseline.generation;
  }
  private sameGeneration(generation: string): void {
    if (this.state.status !== 'ready' || this.state.baseline.generation !== generation)
      throw new RemoteError('configuration/portable-failure', 'Configuration generation changed', {
        reason: 'stale',
      });
  }
  private async http(
    path: string,
    file: Blob | undefined,
    generation: string,
    applySettings?: boolean,
  ): Promise<Response> {
    if (file && (!file.size || file.size > CONFIGURATION_MAX_FILE_BYTES))
      throw new RemoteError('configuration/portable-failure', 'Configuration exceeds file limits', {
        reason: 'capacity',
      });
    const response = await this.request(path.slice(1), {
      method: file ? 'POST' : 'GET',
      headers: {
        'x-axterm-generation': generation,
        ...(file ? { 'content-type': 'application/json' } : {}),
        ...(applySettings !== undefined
          ? { 'x-axterm-apply-settings': applySettings ? '1' : '0' }
          : {}),
      },
      ...(file ? { body: file } : {}),
      signal: this.lifetime.signal,
    });
    if (!response.ok) {
      let reason: ConfigurationPortableFailure = 'unavailable';
      try {
        const result: unknown = JSON.parse(
          new TextDecoder().decode(await this.bytes(response, 16384)),
        );
        if (
          result &&
          typeof result === 'object' &&
          'details' in result &&
          result.details &&
          typeof result.details === 'object' &&
          'reason' in result.details
        ) {
          const parsed = configurationPortableFailureSchema.safeParse(result.details.reason);
          if (parsed.success) reason = parsed.data;
        }
      } catch {
        await response.body?.cancel().catch(() => {});
      }
      throw new RemoteError(
        'configuration/portable-failure',
        'The configuration file operation failed',
        { reason },
      );
    }
    return response;
  }
  private async bytes(response: Response, limit: number): Promise<Uint8Array> {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      await response.body?.cancel();
      throw new Error('CONFIGURATION_RESPONSE_CAPACITY');
    }
    if (!response.body) throw new Error('CONFIGURATION_RESPONSE_MISSING');
    const reader = response.body.getReader();
    const aborted = () => {
      void reader.cancel().catch(() => {});
    };
    this.lifetime.signal.addEventListener('abort', aborted, { once: true });
    try {
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        this.lifetime.signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error('CONFIGURATION_RESPONSE_CAPACITY');
        }
        chunks.push(item.value);
      }
      this.lifetime.signal.throwIfAborted();
      const contents = new Uint8Array(size);
      let offset = 0;
      for (const item of chunks) {
        contents.set(item, offset);
        offset += item.byteLength;
      }
      return contents;
    } finally {
      this.lifetime.signal.removeEventListener('abort', aborted);
      reader.releaseLock();
    }
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.closing) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.closing = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.commands]);
    await this.importAutosave.close();
    this.disposed = true;
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  private admit(): void {
    this.assertOpen();
    if (this.commands.size >= 32) throw new Error('CONFIGURATION_PORTABLE_CAPACITY');
  }
  private assertOpen(): void {
    if (this.closing) throw new Error('CONFIGURATION_PORTABLE_CLOSED');
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.commands.add(task);
    void task.then(
      () => this.commands.delete(task),
      () => this.commands.delete(task),
    );
    return task;
  }
  private open(): RemoteStream<ConfigurationPortableUpdate> {
    return this.ctx.remote.$stream({
      name: 'configuration.portable',
      open: (signal) => this.ctx.remote.configuration.watchConfigurationPreviews(signal),
      ended: () => new RemoteStreamCarrierError('Configuration generation ended'),
    });
  }
  private async consume(stream: RemoteStream<ConfigurationPortableUpdate>): Promise<void> {
    const projection = new ConfigurationPortableProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          const previous = this.state;
          this.publish({
            ...(previous.status === 'ready' && previous.baseline.generation === baseline.generation
              ? previous
              : {}),
            status: 'ready',
            baseline,
          });
          item.accept();
        }
      }
    } catch {
      if (!this.disposed)
        this.publish({ status: 'error', message: 'Configuration previews are unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: ConfigurationPortableState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('CONFIGURATION_PORTABLE_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    configurationPortableModel: ConfigurationPortableModel;
  }
}
