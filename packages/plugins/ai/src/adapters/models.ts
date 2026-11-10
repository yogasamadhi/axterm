import { ApplicationError, type AiErrorCode } from '../application/errors.ts';
import type { Context } from '@deepseek-ai/cordis';
import {
  EngineError,
  engineExecutionOptionsSchema,
  type EngineExecutionOptions,
} from '@axterm/engine-api';
import { aiProviderSchema, type AiProvider } from '@axterm/plugin-api/ai';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import type {} from '@axterm/engine-api/host';
import type { AiModelsPort, AiModelProvider } from '../ports/models.ts';
import type { ModelRequest, ModelEvent } from '../ports/model-provider.ts';
import { EngineModelProvider } from './engine-model.ts';
import { discoverOwnedModels } from './model-discovery.ts';
import { piMetadata } from './pi-metadata.ts';

/** Application provider facts become reference-only execution metadata, never literal credentials. */
export function piBinding(provider: AiProvider, model: string): EngineExecutionOptions {
  if (provider.engineId !== 'pi') throw new EngineError('unsupported');
  const credentialRef = provider.credentialRef;
  const baseUrl = provider.baseUrl;
  if (!credentialRef || !baseUrl) throw new EngineError('invalid');
  const pi = provider.pi;
  const models = [...(pi?.models ?? [])];
  if (!models.some((item) => item.id === model) && (!pi || pi.api || pi.modelOverrides[model]?.api))
    models.push({ id: model });
  const api =
    pi?.api ??
    (!pi
      ? provider.protocol === 'anthropic'
        ? 'anthropic-messages'
        : provider.protocol === 'openai-responses'
          ? 'openai-responses'
          : 'openai-completions'
      : undefined);
  return engineExecutionOptionsSchema.parse({
    configuration: {
      kind: 'pi-provider-v1',
      providerId: provider.id,
      provider: {
        provider: pi?.id ?? 'axterm-custom',
        baseUrl,
        credentialRef: encodeOpaqueCredentialRef(credentialRef),
        headerCredentialRefs: Object.fromEntries(
          Object.entries(pi?.headerCredentialRefs ?? {}).map(([name, ref]) => [
            name,
            encodeOpaqueCredentialRef(ref),
          ]),
        ),
        models,
        modelOverrides: pi?.modelOverrides ?? {},
        timeoutMs: provider.timeoutMs,
        ...(api ? { api } : {}),
        ...(!pi ? { legacy: { apiPath: provider.apiPath, auth: provider.auth } } : {}),
        // Connection's credential adapter owns the mapping of its application proxy reference.
        ...(provider.proxy ? { proxy: provider.proxy } : {}),
      },
    },
  });
}

/** Owns probes and execution adapters through actual close, independently of consumer iteration. */
export class AiModels implements AiModelsPort {
  private readonly lifetime = new AbortController();
  private readonly adapters = new Set<EngineModelProvider>();
  private readonly probes = new Set<Promise<string[]>>();
  private failedDrain = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {}
  skills() {
    return piMetadata.skills();
  }
  skillInstructions(useCase: string) {
    return piMetadata.instructions(useCase);
  }
  catalog() {
    return piMetadata.catalog();
  }
  supportsApplicationTools(provider: AiProvider): boolean {
    const engine = this.ctx.engines.list().find((item) => item.id === provider.engineId);
    return (
      engine?.state === 'ready' && engine.capabilities.tools && engine.capabilities.cancellation
    );
  }
  resourceCount(): number {
    return this.adapters.size + this.probes.size + (this.failedDrain ? 1 : 0);
  }
  async create(
    raw: AiProvider,
    testModel?: string,
    signal?: AbortSignal,
  ): Promise<AiModelProvider> {
    this.assertOpen();
    const provider = aiProviderSchema.parse(raw);
    if (!provider.enabled) throw new EngineError('closed');
    return {
      stream: (input) => this.applicationStream(provider, input, signal),
      listModels: (querySignal) => {
        this.assertOpen();
        if (this.probes.size >= 32) throw new EngineError('capacity');
        const owned = AbortSignal.any([
          this.lifetime.signal,
          ...(signal ? [signal] : []),
          ...(querySignal ? [querySignal] : []),
        ]);
        const task = Promise.resolve().then(() => this.probe(provider, testModel, owned));
        this.probes.add(task);
        void task.then(
          () => this.probes.delete(task),
          (error) => {
            this.probes.delete(task);
            if (error instanceof EngineError && error.code === 'drain-failed')
              this.failedDrain = true;
          },
        );
        return task;
      },
    };
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return (this.closing ??= (async () => {
      const outcomes = await Promise.allSettled(
        [...this.adapters].map(async (adapter) => {
          await adapter.close();
          this.adapters.delete(adapter);
        }),
      );
      await Promise.allSettled([...this.probes]);
      if (this.failedDrain || outcomes.some((result) => result.status === 'rejected')) {
        this.failedDrain = true;
        throw new EngineError('drain-failed');
      }
    })());
  }
  private async *applicationStream(
    provider: AiProvider,
    input: ModelRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelEvent> {
    try {
      yield* this.stream(provider, input, signal);
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      if (error.code === 'drain-failed') this.failedDrain = true;
      const codes: Record<EngineError['code'], AiErrorCode> = {
        invalid: 'AI_ENGINE_INVALID',
        duplicate: 'AI_ENGINE_INVALID',
        missing: 'AI_ENGINE_MISSING',
        unsupported: 'AI_ENGINE_UNSUPPORTED',
        'tool-unavailable': 'AI_ENGINE_UNSUPPORTED',
        closed: 'AI_ENGINE_UNAVAILABLE',
        busy: 'AI_ENGINE_UNAVAILABLE',
        capacity: 'AI_ENGINE_CAPACITY',
        backpressure: 'AI_ENGINE_CAPACITY',
        cancelled: 'AI_ENGINE_CANCELLED',
        'provider-failed': 'AI_PROVIDER_FAILED',
        'drain-failed': 'AI_ENGINE_DRAIN_FAILED',
        'sink-failed': 'AI_ENGINE_OUTPUT_FAILED',
      };
      throw new ApplicationError(codes[error.code], 'The selected Engine could not complete', 503);
    }
  }
  private async *stream(
    provider: AiProvider,
    input: ModelRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelEvent> {
    this.assertOpen();
    if (this.adapters.size >= 64) throw new EngineError('capacity');
    const owned = AbortSignal.any([
      input.signal,
      this.lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    const adapter = new EngineModelProvider(
      this.ctx.engines,
      provider.engineId,
      provider.id,
      provider.engineId === 'pi' ? piBinding(provider, input.model) : undefined,
    );
    this.adapters.add(adapter);
    try {
      yield* adapter.stream({ ...input, signal: owned });
    } finally {
      await adapter.close();
      this.adapters.delete(adapter);
    }
  }
  private async probe(
    provider: AiProvider,
    testModel: string | undefined,
    signal: AbortSignal,
  ): Promise<string[]> {
    this.assertOpen();
    if (signal.aborted) throw new EngineError('cancelled');
    if (provider.engineId !== 'pi') throw new EngineError('unsupported');
    if (!provider.pi) return discoverOwnedModels(this.ctx, provider, signal);
    const ids = [
      ...new Set([
        ...(this.catalog()
          .find((item) => item.id === provider.pi!.id)
          ?.models.map((model) => model.id) ?? []),
        ...provider.pi.models.map((model) => model.id),
      ]),
    ].slice(0, 500);
    if (!ids.length) throw new EngineError('missing');
    for await (const _event of this.stream(provider, {
      model: testModel ?? ids[0]!,
      system: 'Reply OK.',
      prompt: 'OK',
      context: '',
      signal,
    })) {
      /* actual Pi probe, no visible log of internal probe text */
    }
    return ids;
  }
  private assertOpen(): void {
    if (this.lifetime.signal.aborted) throw new EngineError('closed');
  }
}
