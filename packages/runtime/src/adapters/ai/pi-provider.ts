import { piCatalog, piSkills, streamPiAgent, type PiProviderConfig } from '@workspace/pi-engine';
import { aiProviderSchema, aiSkillSchema, type AiProvider } from '@workspace/contracts';
import type { ModelEvent, ModelProvider, ModelRequest } from '../../ports/model-provider';
import { discoverLegacyModels, requestModel, type AiModelProxy } from './model-http';

export { piCatalog };

export function piSkillCatalog() {
  return piSkills().map(({ body: _body, ...skill }) => aiSkillSchema.parse(skill));
}
export function piSkillInstructions(useCase: string) {
  const skill = piSkills().find((item) => item.useCase === useCase);
  return skill ? `<skill name="${skill.id}">\n${skill.body}\n</skill>` : undefined;
}

export class PiModelProvider implements ModelProvider {
  constructor(
    private readonly provider: AiProvider,
    private readonly apiKey: string,
    private readonly proxy: AiModelProxy,
    private readonly headers: Record<string, string> = {},
    private readonly testModel?: string,
  ) {
    this.provider = aiProviderSchema.parse(provider);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (!this.provider.pi)
      return discoverLegacyModels(this.provider, this.apiKey, this.proxy, signal);
    const ids = [
      ...new Set([
        ...(piCatalog()
          .find(({ id }) => id === this.provider.pi?.id)
          ?.models.map(({ id }) => id) ?? []),
        ...this.provider.pi.models.map(({ id }) => id),
      ]),
    ].slice(0, 500);
    if (!ids.length) throw new Error('No configured Pi models');
    // Probe through the actual Pi API, since most providers do not expose OpenAI /models.
    for await (const _event of this.stream({
      model: this.testModel ?? ids[0]!,
      system: 'Reply OK.',
      prompt: 'OK',
      context: '',
      signal: signal ?? new AbortController().signal,
    })) {
      /* drain */
    }
    return ids;
  }

  async *stream(input: ModelRequest): AsyncIterable<ModelEvent> {
    const provider = this.provider;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      input.signal,
      controller.signal,
      AbortSignal.timeout(provider.timeoutMs),
    ]);
    const legacyApi =
      provider.protocol === 'anthropic'
        ? 'anthropic-messages'
        : provider.protocol === 'openai-responses'
          ? 'openai-responses'
          : 'openai-completions';
    const config: PiProviderConfig = provider.pi ?? {
      id: 'axterm-custom',
      api: legacyApi,
      models: [],
      modelOverrides: {},
    };
    const activeBody: { value: ReadableStream<Uint8Array> | null } = { value: null };
    const fetchModel: typeof globalThis.fetch = async (resource, init) => {
      signal.throwIfAborted();
      const request = new Request(resource, init);
      let endpoint = new URL(request.url);
      if (!provider.pi && request.method === 'POST')
        endpoint = new URL(
          provider.apiPath.replace(/^\/+/, ''),
          provider.baseUrl.replace(/\/?$/, '/'),
        );
      const body = request.method === 'GET' ? undefined : await request.text();
      if (body && Buffer.byteLength(body) > 1024 * 1024)
        throw new Error('Model request exceeded limit');
      const response = await requestModel(
        endpoint,
        {
          method: request.method === 'GET' ? 'GET' : 'POST',
          headers: requestHeaders(request.headers),
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.any([signal, request.signal]),
        },
        this.proxy,
        provider.timeoutMs,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Model provider rejected request (${response.status})`);
      }
      if (!response.body) throw new Error('Model provider returned an empty response');
      let bytes = 0;
      activeBody.value = response.body;
      const reader = response.body.getReader();
      const bounded = new ReadableStream<Uint8Array>(
        {
          async pull(sink) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                reader.releaseLock();
                sink.close();
                return;
              }
              bytes += chunk.value.byteLength;
              if (bytes > 4 * 1024 * 1024) throw new Error('Model response exceeded limit');
              sink.enqueue(chunk.value);
            } catch (error) {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
              sink.error(error);
            }
          },
          async cancel() {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(bounded, { status: response.status, headers: response.headers });
    };
    try {
      for await (const event of streamPiAgent({
        ...input,
        provider: config,
        baseUrl: provider.baseUrl,
        apiKey: this.apiKey,
        signal,
        fetch: fetchModel,
        timeoutMs: provider.timeoutMs,
        headers: {
          ...this.headers,
          ...(!provider.pi
            ? provider.auth === 'x-api-key'
              ? { 'x-api-key': this.apiKey, authorization: null }
              : { authorization: `Bearer ${this.apiKey}` }
            : {}),
        },
      }))
        yield event;
    } catch {
      // Pi/SDK errors can contain request headers and provider bodies; expose a stable failure.
      throw new Error(
        signal.aborted
          ? 'Model provider request was canceled or timed out'
          : 'Pi model provider request failed',
      );
    } finally {
      controller.abort();
      if (activeBody.value && !activeBody.value.locked)
        await activeBody.value.cancel().catch(() => undefined);
    }
  }
}

function requestHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}
