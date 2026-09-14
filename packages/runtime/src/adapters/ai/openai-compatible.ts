import { request as requestHttp, type IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import type { AiProviderAuth, AiProviderProtocol, ProxyEndpointConfig } from '@workspace/contracts';
import type { ModelEvent, ModelProvider, ModelRequest } from '../../ports/model-provider';
import { TcpProxyConnector } from '../proxy/tcp-proxy-connector';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_LIST_BYTES = 2 * 1024 * 1024;

export interface AiProviderAdapterOptions {
  protocol?: AiProviderProtocol;
  apiPath?: string;
  auth?: AiProviderAuth;
  proxy?: (Omit<ProxyEndpointConfig, 'credentialRef'> & { password?: string }) | null;
  timeoutMs?: number;
}

interface SseEvent {
  event: string;
  data: string;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  private readonly protocol: AiProviderProtocol;
  private readonly apiPath: string;
  private readonly auth: AiProviderAuth;
  private readonly proxy: AiProviderAdapterOptions['proxy'];
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    options: AiProviderAdapterOptions = {},
  ) {
    this.protocol = options.protocol ?? 'openai-chat';
    this.apiPath = options.apiPath ?? defaultApiPath(this.protocol);
    this.auth = options.auth ?? (this.protocol === 'anthropic' ? 'x-api-key' : 'bearer');
    this.proxy = options.proxy ?? null;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await requestModel(
      endpointFor(this.baseUrl, '/models'),
      {
        method: 'GET',
        headers: this.headers(),
        signal: signal ?? new AbortController().signal,
      },
      this.proxy,
      this.timeoutMs,
    );
    await requireSuccessful(response);
    const parsed = JSON.parse(await readText(response, MAX_MODEL_LIST_BYTES)) as unknown;
    const source = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)
        ? (parsed as { data: unknown[] }).data
        : parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { models?: unknown }).models)
          ? (parsed as { models: unknown[] }).models
          : [];
    return [
      ...new Set(
        source
          .map((item) =>
            typeof item === 'string'
              ? item
              : item && typeof item === 'object'
                ? String(
                    (item as { id?: unknown; name?: unknown; model?: unknown }).id ??
                      (item as { name?: unknown }).name ??
                      (item as { model?: unknown }).model ??
                      '',
                  )
                : '',
          )
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 512),
      ),
    ].slice(0, 500);
  }

  async *stream(input: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await requestModel(
      endpointFor(this.baseUrl, this.apiPath),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(buildRequest(this.protocol, input)),
        signal: input.signal,
      },
      this.proxy,
      this.timeoutMs,
    );
    await requireSuccessful(response);
    if (!response.body) throw new Error('Model provider returned an empty response');
    for await (const event of readSse(response.body, input.signal)) {
      if (event.data === '[DONE]') {
        yield { type: 'completed' };
        return;
      }
      const parsed = parseEvent(event.data);
      if (!parsed) continue;
      for (const normalized of normalizeEvent(this.protocol, event.event, parsed)) {
        yield normalized;
        if (normalized.type === 'completed') return;
      }
    }
    yield { type: 'completed' };
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(this.auth === 'x-api-key'
        ? { 'x-api-key': this.apiKey }
        : { Authorization: `Bearer ${this.apiKey}` }),
      ...(this.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
    };
  }
}

function defaultApiPath(protocol: AiProviderProtocol): string {
  if (protocol === 'openai-responses') return '/responses';
  if (protocol === 'anthropic') return '/messages';
  return '/chat/completions';
}

function endpointFor(baseUrl: string, apiPath: string): URL {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Unsupported model endpoint');
  return new URL(apiPath.replace(/^\/+/, ''), base);
}

function promptWithContext(input: ModelRequest): string {
  return input.context ? `${input.prompt}\n\nContext:\n${input.context}` : input.prompt;
}

function buildRequest(protocol: AiProviderProtocol, input: ModelRequest): Record<string, unknown> {
  const prompt = promptWithContext(input);
  if (protocol === 'openai-responses')
    return {
      model: input.model,
      instructions: input.system,
      input: prompt,
      stream: true,
    };
  if (protocol === 'anthropic')
    return {
      model: input.model,
      system: input.system,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4_096,
      stream: true,
    };
  return {
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: prompt },
    ],
  };
}

function parseEvent(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    throw new Error('Model provider returned malformed stream data');
  }
}

function* normalizeEvent(
  protocol: AiProviderProtocol,
  eventName: string,
  value: Record<string, unknown>,
): Generator<ModelEvent> {
  if (protocol === 'openai-responses') {
    const type = String(value.type ?? eventName);
    if (type === 'response.output_text.delta' && typeof value.delta === 'string')
      yield { type: 'delta', text: value.delta };
    if (type === 'response.output_item.added') {
      const item = object(value.item);
      if (item?.type === 'function_call')
        yield {
          type: 'toolCallDelta',
          index: number(value.output_index),
          id: string(item.call_id ?? item.id),
          name: string(item.name),
          arguments: string(item.arguments),
        };
    }
    if (type === 'response.function_call_arguments.delta')
      yield {
        type: 'toolCallDelta',
        index: number(value.output_index),
        id: string(value.item_id),
        arguments: string(value.delta),
      };
    if (type === 'response.completed') {
      const usage = object(object(value.response)?.usage);
      if (usage)
        yield {
          type: 'usage',
          inputTokens: optionalNumber(usage.input_tokens),
          outputTokens: optionalNumber(usage.output_tokens),
        };
      yield { type: 'completed' };
    }
    return;
  }

  if (protocol === 'anthropic') {
    const type = String(value.type ?? eventName);
    if (type === 'content_block_start') {
      const block = object(value.content_block);
      if (block?.type === 'tool_use')
        yield {
          type: 'toolCallDelta',
          index: number(value.index),
          id: string(block.id),
          name: string(block.name),
          arguments: block.input === undefined ? '' : JSON.stringify(block.input),
        };
    }
    if (type === 'content_block_delta') {
      const delta = object(value.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string')
        yield { type: 'delta', text: delta.text };
      if (delta?.type === 'input_json_delta')
        yield {
          type: 'toolCallDelta',
          index: number(value.index),
          arguments: string(delta.partial_json),
        };
    }
    if (type === 'message_start') {
      const usage = object(object(value.message)?.usage);
      if (usage) yield { type: 'usage', inputTokens: optionalNumber(usage.input_tokens) };
    }
    if (type === 'message_delta') {
      const usage = object(value.usage);
      if (usage) yield { type: 'usage', outputTokens: optionalNumber(usage.output_tokens) };
    }
    if (type === 'message_stop') yield { type: 'completed' };
    return;
  }

  const choices = Array.isArray(value.choices) ? value.choices : [];
  const choice = object(choices[0]);
  const delta = object(choice?.delta);
  if (typeof delta?.content === 'string' && delta.content)
    yield { type: 'delta', text: delta.content };
  const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
  for (const rawCall of toolCalls) {
    const call = object(rawCall);
    const fn = object(call?.function);
    if (!call) continue;
    yield {
      type: 'toolCallDelta',
      index: number(call.index),
      id: string(call.id),
      name: string(fn?.name),
      arguments: string(fn?.arguments),
    };
  }
  const usage = object(value.usage);
  if (usage)
    yield {
      type: 'usage',
      inputTokens: optionalNumber(usage.prompt_tokens),
      outputTokens: optionalNumber(usage.completion_tokens),
    };
  if (choice?.finish_reason) yield { type: 'completed' };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  let ended = false;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        break;
      }
      received += chunk.value.length;
      if (received > MAX_RESPONSE_BYTES) throw new Error('Model response exceeded limit');
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const match = /\r?\n\r?\n/.exec(buffer.slice(boundary));
        const delimiterLength = match?.[0].length ?? 2;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + delimiterLength);
        const event = parseSseBlock(block);
        if (event) yield event;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    const tail = parseSseBlock(buffer);
    if (tail) yield tail;
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): SseEvent | undefined {
  let event = '';
  const data = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    const value = separator < 0 ? '' : rawLine.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : undefined;
}

async function requireSuccessful(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => undefined);
  throw new Error(`Model provider rejected request (${response.status})`);
}

async function readText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.length;
      if (received > maximumBytes) throw new Error('Model provider response exceeded limit');
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function requestModel(
  endpoint: URL,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
  proxy: AiProviderAdapterOptions['proxy'],
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]);
  if (!proxy)
    return fetch(endpoint, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: 'error',
      signal,
    });

  const rawSocket = await new TcpProxyConnector().connect({
    proxy: {
      url: proxy.url,
      ...(proxy.username ? { username: proxy.username, password: proxy.password } : {}),
    },
    target: {
      host: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    },
    timeoutMs,
    signal,
  });
  const socket =
    endpoint.protocol === 'https:'
      ? await secureSocket(rawSocket, endpoint.hostname, signal)
      : rawSocket;
  try {
    return await requestOnSocket(endpoint, init, socket, signal);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function secureSocket(
  socket: Socket,
  hostname: string,
  signal: AbortSignal,
): Promise<TLSSocket> {
  if (signal.aborted) {
    socket.destroy();
    throw signal.reason;
  }
  return new Promise<TLSSocket>((resolve, reject) => {
    const tls = connectTls({
      socket,
      ...(isIP(hostname) ? {} : { servername: hostname }),
      ALPNProtocols: ['http/1.1'],
    });
    const cleanup = () => {
      tls.off('secureConnect', connected);
      tls.off('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const connected = () => {
      cleanup();
      resolve(tls);
    };
    const failed = (error: Error) => {
      cleanup();
      tls.destroy();
      reject(error);
    };
    const aborted = () => failed(new Error('Model provider request was canceled'));
    tls.once('secureConnect', connected);
    tls.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function requestOnSocket(
  endpoint: URL,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  socket: Socket,
  signal: AbortSignal,
): Promise<Response> {
  const request = endpoint.protocol === 'https:' ? requestHttps : requestHttp;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        method: init.method,
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: {
          ...init.headers,
          ...(init.body === undefined ? {} : { 'Content-Length': Buffer.byteLength(init.body) }),
        },
        agent: false,
        signal,
        createConnection: () => socket,
      },
      resolve,
    );
    outgoing.once('error', reject);
    outgoing.end(init.body);
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, String(value));
  }
  return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
    status: response.statusCode ?? 500,
    ...(response.statusMessage ? { statusText: response.statusMessage } : {}),
    headers,
  });
}
