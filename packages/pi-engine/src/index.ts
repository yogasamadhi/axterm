import { runAgentLoop } from '../../../vendor/pi/packages/agent/src/agent-loop.ts';
import { Type } from 'typebox';
import type { AgentMessage } from '../../../vendor/pi/packages/agent/src/types.ts';
import type { Model, Message, ProviderStreams } from '../../../vendor/pi/packages/ai/src/types.ts';
import { builtinProviders } from '../../../vendor/pi/packages/ai/src/providers/all.ts';
import { openAICompletionsApi } from '../../../vendor/pi/packages/ai/src/api/openai-completions.lazy.ts';
import { openAIResponsesApi } from '../../../vendor/pi/packages/ai/src/api/openai-responses.lazy.ts';
import { azureOpenAIResponsesApi } from '../../../vendor/pi/packages/ai/src/api/azure-openai-responses.lazy.ts';
import { anthropicMessagesApi } from '../../../vendor/pi/packages/ai/src/api/anthropic-messages.lazy.ts';
import { googleGenerativeAIApi } from '../../../vendor/pi/packages/ai/src/api/google-generative-ai.lazy.ts';
import { mistralConversationsApi } from '../../../vendor/pi/packages/ai/src/api/mistral-conversations.lazy.ts';
import { piMessagesApi } from '../../../vendor/pi/packages/ai/src/api/pi-messages.lazy.ts';
import type { PiApi, PiCatalogProvider, PiEngineEvent, PiEngineRequest } from './public';
import { modelFetchScope } from './scoped-fetch';
import skills from '../catalog/skills.generated.json' with { type: 'json' };

export function piSkills() {
  return skills.map((skill) => ({ ...skill }));
}

const providers = builtinProviders();
const apis: Record<PiApi, ProviderStreams> = {
  'openai-completions': openAICompletionsApi(),
  'openai-responses': openAIResponsesApi(),
  'azure-openai-responses': azureOpenAIResponsesApi(),
  'anthropic-messages': anthropicMessagesApi(),
  'google-generative-ai': googleGenerativeAIApi(),
  'mistral-conversations': mistralConversationsApi(),
  'pi-messages': piMessagesApi(),
};

export function piCatalog(): PiCatalogProvider[] {
  return providers.map((provider) => {
    const models = provider.getModels().filter((model) => Object.hasOwn(apis, model.api));
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? models[0]?.baseUrl ?? '',
      apiKeyAvailable: !!provider.auth.apiKey && models.length > 0,
      models: models.map(({ id, name, api, reasoning, input, cost, contextWindow, maxTokens }) => ({
        id,
        name,
        api: api as PiApi,
        reasoning,
        input: [...input],
        cost: {
          input: cost.input,
          output: cost.output,
          cacheRead: cost.cacheRead,
          cacheWrite: cost.cacheWrite,
        },
        contextWindow,
        maxTokens,
      })),
    };
  });
}

function resolveModel(request: PiEngineRequest): Model<PiApi> {
  const builtin = providers
    .find(({ id }) => id === request.provider.id)
    ?.getModels()
    .find(({ id }) => id === request.model);
  const custom = request.provider.models.find(({ id }) => id === request.model);
  const override = request.provider.modelOverrides[request.model];
  const metadata = { ...builtin, ...custom, ...override };
  const api = override?.api ?? custom?.api ?? request.provider.api ?? builtin?.api;
  if (!api || !Object.hasOwn(apis, api)) throw new Error('Unsupported Pi model API');
  return {
    ...metadata,
    id: request.model,
    name: metadata.name ?? request.model,
    provider: request.provider.id,
    api: api as PiApi,
    baseUrl: override?.baseUrl ?? custom?.baseUrl ?? request.baseUrl,
    reasoning: metadata.reasoning ?? false,
    input: metadata.input ?? ['text'],
    cost: metadata.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: metadata.contextWindow ?? 128_000,
    maxTokens: Math.min(metadata.maxTokens ?? 4_096, 32_768),
    compat: { ...builtin?.compat, ...custom?.compat, ...override?.compat },
  } as Model<PiApi>;
}

export async function* streamPiAgent(request: PiEngineRequest): AsyncGenerator<PiEngineEvent> {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const model = resolveModel(request);
  // A rendezvous channel applies backpressure; it never retains unconsumed model events.
  let pending: { event: PiEngineEvent; consumed(): void } | undefined;
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: unknown;
  let outputBytes = 0;
  let providerEvents = 0;
  const emit = async (event: PiEngineEvent) => {
    signal.throwIfAborted();
    if (event.type === 'delta') {
      outputBytes += Buffer.byteLength(event.text);
      if (outputBytes > 2 * 1024 * 1024) throw new Error('Model response exceeded limit');
    }
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        pending = undefined;
        reject(new Error('Model provider request was canceled'));
        wake?.();
      };
      pending = {
        event,
        consumed: () => {
          signal.removeEventListener('abort', aborted);
          resolve();
        },
      };
      signal.addEventListener('abort', aborted, { once: true });
      wake?.();
    });
  };
  const prompt: Message = {
    role: 'user',
    content: request.context ? `${request.prompt}\n\nContext:\n${request.context}` : request.prompt,
    timestamp: Date.now(),
  };
  const task = runAgentLoop(
    [prompt],
    {
      messages: [{ role: 'system', content: request.system, timestamp: Date.now() }],
      tools: request.allowCommandProposal
        ? [
            {
              name: 'workspace_exec',
              label: 'Propose workspace command',
              description:
                'Propose one shell command on the selected terminal target. Execution always requires separate user approval. Never choose a different host or directory.',
              parameters: Type.Object(
                { command: Type.String({ minLength: 1, maxLength: 8192 }) },
                { additionalProperties: false },
              ),
              execute: async () => {
                throw new Error('Only Runtime Application Service may execute commands');
              },
            },
          ]
        : [],
    },
    {
      model,
      apiKey: request.apiKey,
      fetch: request.fetch,
      headers: request.headers,
      env: {},
      timeoutMs: request.timeoutMs,
      maxRetries: 0,
      transport: 'sse',
      maxTokens: model.maxTokens,
      onProviderStreamEvent: () => {
        if (++providerEvents > 16_384) {
          controller.abort();
          throw new Error('Model stream event limit exceeded');
        }
      },
      convertToLlm: (messages: AgentMessage[]) =>
        messages.filter((message): message is Message =>
          ['system', 'user', 'assistant', 'toolResult'].includes(message.role),
        ),
      finishTurn: () => ({ action: 'end' }),
      beforeToolCall: async () => ({
        block: true,
        terminate: true,
        reason: 'Explicit application approval required',
      }),
    },
    async (event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
        await emit({ type: 'delta', text: event.assistantMessageEvent.delta });
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message;
        if (message.stopReason === 'error' || message.stopReason === 'aborted')
          throw new Error('Model provider request failed');
        const calls = message.content.filter((block) => block.type === 'toolCall');
        if (calls.length) {
          const call = calls[0]!;
          const args = call.arguments;
          if (
            !request.allowCommandProposal ||
            calls.length !== 1 ||
            call.name !== 'workspace_exec' ||
            message.stopReason === 'length' ||
            !args ||
            Object.keys(args).length !== 1 ||
            typeof args.command !== 'string' ||
            !args.command.trim() ||
            args.command.length > 8192
          )
            throw new Error('Invalid application command proposal');
        }
        await emit({
          type: 'usage',
          inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
          outputTokens: message.usage.output,
        });
        if (calls.length)
          await emit({ type: 'commandProposal', command: calls[0]!.arguments.command as string });
        await emit({ type: 'completed' });
      }
    },
    signal,
    (m, context, options) => {
      if (m.api !== 'google-generative-ai')
        return apis[m.api as PiApi].streamSimple(m, context, options);
      // Pi's Google adapter does not expose SDK fetch injection. The build binds its SDK
      // to this request-local transport, without changing process-global fetch.
      return modelFetchScope.run(request.fetch, () =>
        apis['google-generative-ai'].streamSimple(m, context, {
          ...options,
          fetch: undefined,
          onPayload: (value) => {
            const payload = value as { config?: { httpOptions?: Record<string, unknown> } };
            return {
              ...payload,
              config: {
                ...payload.config,
                httpOptions: { ...payload.config?.httpOptions, retryOptions: { attempts: 1 } },
              },
            };
          },
        }),
      );
    },
  )
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      ended = true;
      wake?.();
    });
  try {
    while (true) {
      if (pending) {
        const value = pending;
        pending = undefined;
        value.consumed();
        yield value.event;
      } else if (ended) {
        if (failure) throw failure;
        return;
      } else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  } finally {
    controller.abort();
    await task;
  }
}
