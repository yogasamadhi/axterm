import { z } from 'zod';
import { pluginToolInputSchema } from '@axterm/plugin-api/plugins';
import type { Context } from '@deepseek-ai/cordis';
import { EngineError, type EngineRunInput } from '@axterm/engine-api';
import type {
  EngineProvider,
  EngineProviderSession,
  EngineRunContext,
} from '@axterm/engine-api/host';
import type {} from '@axterm/plugin-api/host';
import type { ConnectionsApplication } from '@axterm/plugin-api/host';
import { credentialRef } from '@axterm/plugin-api/credentials';
import { streamPiAgent, piCatalog, type PiProviderConfig } from '@axterm/engine-pi-core';
import { Config, piEngineConfigSchema, piExecutionBindingSchema } from './config.ts';
import { requestThroughProxy } from './proxy-http.ts';
import { VisibleSecrets } from './visible-secrets.ts';
export { Config, piEngineConfigSchema };
export const inject = ['engines', 'credentials'];

/** Thin Provider over the existing pinned Pi Agent/API loop. Application callbacks retain all tool policy. */
export class PiEngineProvider implements EngineProvider {
  readonly label = 'Pi';
  readonly capabilities = Object.freeze({ cancellation: true, tools: true, resume: false });
  private readonly config: Config;
  constructor(
    private readonly ctx: Context,
    config: Config,
  ) {
    try {
      this.config = piEngineConfigSchema.parse(config);
    } catch {
      throw new EngineError('invalid');
    }
  }
  async openSession(_input: unknown, signal: AbortSignal): Promise<EngineProviderSession> {
    signal.throwIfAborted();
    const lifetime = new AbortController();
    const tasks = new Set<Promise<void>>();
    let closed = false;
    let closing: Promise<void> | undefined;
    return {
      run: (input, context) => {
        if (closed) return Promise.reject(new EngineError('closed'));
        const task = this.run(
          input,
          context,
          AbortSignal.any([signal, lifetime.signal, context.signal]),
        );
        tasks.add(task);
        void task.then(
          () => tasks.delete(task),
          () => tasks.delete(task),
        );
        return task;
      },
      close: () => {
        closed = true;
        lifetime.abort();
        return (closing ??= Promise.allSettled([...tasks]).then(() => {}));
      },
    };
  }
  private async resolve(ref: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const value = await this.ctx.credentials.resolve(credentialRef(ref));
    signal.throwIfAborted();
    if (!value) throw new EngineError('missing');
    return value.value;
  }
  private async run(
    input: EngineRunInput,
    context: EngineRunContext,
    signal: AbortSignal,
  ): Promise<void> {
    const binding =
      context.configuration === undefined
        ? undefined
        : piExecutionBindingSchema.safeParse(context.configuration);
    if (binding !== undefined && (!binding.success || binding.data.providerId !== input.providerId))
      throw new EngineError('invalid');
    const configured = binding?.success
      ? binding.data.provider
      : Object.hasOwn(this.config.providers, input.providerId)
        ? this.config.providers[input.providerId]
        : undefined;
    if (!configured) throw new EngineError('missing');
    const known =
      configured.models.some((model) => model.id === input.model) ||
      piCatalog().some(
        (provider) =>
          provider.id === configured.provider &&
          provider.models.some((model) => model.id === input.model),
      );
    if (!known) throw new EngineError('missing');
    const apiKey = await this.resolve(configured.credentialRef, signal);
    const resolvedSecrets = [apiKey];
    const headers: Record<string, string | null> = Object.create(null) as Record<
      string,
      string | null
    >;
    for (const [name, ref] of Object.entries(configured.headerCredentialRefs)) {
      const value = await this.resolve(ref, signal);
      headers[name] = value;
      resolvedSecrets.push(value);
    }
    const visible = new VisibleSecrets(resolvedSecrets);
    const containsSecret = (text: string) =>
      resolvedSecrets.some((secret) => secret && text.includes(secret));
    if (configured.legacy) {
      if (configured.legacy.auth === 'x-api-key') {
        headers['x-api-key'] = apiKey;
        headers.authorization = null;
      } else headers.authorization = `Bearer ${apiKey}`;
    }
    const provider: PiProviderConfig = {
      id: configured.provider,
      models: configured.models,
      modelOverrides: Object.assign(
        Object.create(null) as PiProviderConfig['modelOverrides'],
        configured.modelOverrides,
      ),
      ...(configured.api ? { api: configured.api } : {}),
    };
    const lifetime = new AbortController();
    const activeSignal = AbortSignal.any([signal, lifetime.signal]);
    let policyFailure: EngineError | undefined;
    const rejectSecretCommand = (): never => {
      policyFailure ??= new EngineError('tool-unavailable');
      lifetime.abort();
      throw policyFailure;
    };
    const readers = new Map<ReadableStreamDefaultReader<Uint8Array>, () => Promise<void>>();
    const transport: typeof globalThis.fetch = async (resource, init) => {
      activeSignal.throwIfAborted();
      const request = new Request(resource, init);
      const endpoint = new URL(request.url);
      if (configured.legacy && request.method === 'POST') {
        const base = new URL(configured.baseUrl);
        // An API path is path data, including a literal colon. It cannot select an origin.
        base.pathname =
          base.pathname.replace(/\/?$/, '/') + configured.legacy.apiPath.replace(/^\/+/, '');
        endpoint.href = base.href;
      }
      const body = request.method === 'GET' ? undefined : await request.text();
      if (body && Buffer.byteLength(body) > 1024 * 1024) throw new EngineError('capacity');
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), configured.timeoutMs);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        if (reader) {
          readers.delete(reader);
          reader.releaseLock();
        }
      };
      try {
        const requestInit = {
          method: request.method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.any([activeSignal, request.signal, timeout.signal]),
        };
        const connections: ConnectionsApplication | undefined = configured.proxy
          ? this.ctx.reflect.get('connections')
          : undefined;
        if (configured.proxy && !connections) throw new EngineError('missing');
        const response =
          configured.proxy && connections
            ? await requestThroughProxy(
                connections,
                endpoint,
                requestInit,
                { mode: 'custom', endpoint: configured.proxy },
                configured.timeoutMs,
              )
            : await globalThis.fetch(endpoint, { ...requestInit, redirect: 'error' });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw new EngineError('provider-failed');
        }
        reader = response.body.getReader();
        let received = 0;
        const source = reader;
        readers.set(reader, async () => {
          try {
            await source.cancel();
          } catch {
            // Aborted model IO may reject cancel; releasing the owned reader/timer still runs.
          } finally {
            release();
          }
        });
        const bounded = new ReadableStream<Uint8Array>(
          {
            async pull(sink) {
              try {
                const item = await source.read();
                if (item.done) {
                  release();
                  sink.close();
                  return;
                }
                received += item.value.byteLength;
                if (received > 4 * 1024 * 1024) throw new EngineError('capacity');
                sink.enqueue(item.value);
              } catch {
                await source.cancel().catch(() => {});
                release();
                sink.error(new EngineError(activeSignal.aborted ? 'cancelled' : 'provider-failed'));
              }
            },
            async cancel() {
              try {
                await source.cancel();
              } finally {
                release();
              }
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(bounded, { status: response.status, headers: response.headers });
      } catch (error) {
        if (reader) await reader.cancel().catch(() => {});
        release();
        if (error instanceof EngineError) throw error;
        throw new EngineError(activeSignal.aborted ? 'cancelled' : 'provider-failed');
      }
    };
    try {
      for await (const event of streamPiAgent({
        provider,
        baseUrl: configured.baseUrl,
        model: input.model,
        apiKey,
        headers,
        timeoutMs: configured.timeoutMs,
        system: input.system,
        prompt: input.prompt,
        context: input.context,
        signal: activeSignal,
        fetch: transport,
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
        ...(input.requireComplete === undefined ? {} : { requireComplete: input.requireComplete }),
        allowCommandProposal:
          input.allowCommandProposal === true || (input.tools && !(input.toolNames ?? []).length),
        ...(input.tools && (input.toolNames ?? []).includes('plugins.manage')
          ? {
              pluginManagementTool: {
                parameters: z.toJSONSchema(z.object({ request: pluginToolInputSchema }).strict()),
                execute: async (
                  args: Record<string, unknown>,
                  callId: string,
                  signal: AbortSignal,
                ) => {
                  signal.throwIfAborted();
                  const parsed = z.object({ request: pluginToolInputSchema }).strict().parse(args);
                  if (containsSecret(JSON.stringify(parsed))) rejectSecretCommand();
                  return context.tool({
                    callId,
                    name: 'plugins.manage',
                    arguments: z
                      .record(z.string(), z.json())
                      .parse(JSON.parse(JSON.stringify(parsed))),
                  });
                },
              },
            }
          : {}),
        ...(input.tools && (input.allowCommandProposal === true || !(input.toolNames ?? []).length)
          ? {
              executeCommand: async (
                command: string,
                toolCallId: string,
                toolSignal: AbortSignal,
              ) => {
                toolSignal.throwIfAborted();
                if (containsSecret(command)) rejectSecretCommand();
                return context.tool({
                  callId: toolCallId,
                  name: 'workspace.exec',
                  arguments: { command },
                });
              },
            }
          : {}),
      })) {
        if (policyFailure) throw policyFailure;
        if (event.type === 'delta') {
          const text = visible.push(event.text);
          if (text) await context.emit({ type: 'delta', text });
        } else if (event.type === 'completed') {
          const text = visible.finish();
          if (text) await context.emit({ type: 'delta', text });
          await context.emit(event);
        } else {
          if (event.type === 'commandProposal' && containsSecret(event.command))
            rejectSecretCommand();
          await context.emit(event);
        }
      }
      if (policyFailure) throw policyFailure;
    } catch (error) {
      if (policyFailure) throw policyFailure;
      if (error instanceof EngineError) throw error;
      throw new EngineError(activeSignal.aborted ? 'cancelled' : 'provider-failed');
    } finally {
      visible.discard();
      lifetime.abort();
      await Promise.allSettled([...readers.values()].map((close) => close()));
    }
  }
}
export function apply(ctx: Context, config: Config): void {
  ctx.engines.register('pi', new PiEngineProvider(ctx, config));
}
