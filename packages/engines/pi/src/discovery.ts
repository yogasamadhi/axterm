import { EngineError } from '@axterm/engine-api';
import { aiProviderSchema, type AiProvider } from '@axterm/plugin-api/ai';
import type { ConnectionsApplication } from '@axterm/plugin-api/host';
import { requestThroughProxy } from './proxy-http.ts';

/** Selected legacy metadata operation only. No Agent, model stream parser or credential persistence. */
export async function discoverLegacyModels(
  raw: AiProvider,
  apiKey: string,
  signal: AbortSignal,
  connections?: Pick<ConnectionsApplication, 'openStream'>,
): Promise<string[]> {
  const provider = aiProviderSchema.parse(raw);
  if (provider.engineId !== 'pi' || provider.pi || !provider.baseUrl)
    throw new EngineError('unsupported');
  if (signal.aborted) throw new EngineError('cancelled');
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), provider.timeoutMs);
  const active = AbortSignal.any([signal, timeout.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const endpoint = new URL('models', provider.baseUrl.replace(/\/?$/, '/'));
    const headers = new Headers({
      accept: 'application/json',
      ...(provider.auth === 'x-api-key'
        ? { 'x-api-key': apiKey }
        : { authorization: `Bearer ${apiKey}` }),
      ...(provider.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
    });
    if (provider.proxy && !connections) throw new EngineError('missing');
    const response =
      provider.proxy && connections
        ? await requestThroughProxy(
            connections,
            endpoint,
            { method: 'GET', headers, signal: active },
            { mode: 'custom', endpoint: provider.proxy },
            provider.timeoutMs,
          )
        : await fetch(endpoint, { method: 'GET', headers, signal: active, redirect: 'error' });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new EngineError('provider-failed');
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      received += item.value.byteLength;
      if (received > 2 * 1024 * 1024) throw new EngineError('capacity');
      text += decoder.decode(item.value, { stream: true });
    }
    const parsed: unknown = JSON.parse(text + decoder.decode());
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
          .map((item: unknown) =>
            typeof item === 'string'
              ? item
              : item && typeof item === 'object'
                ? String(
                    (item as { id?: unknown }).id ??
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
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError(signal.aborted ? 'cancelled' : 'provider-failed');
  } finally {
    timeout.abort();
    clearTimeout(timer);
    await closeReader(reader);
  }
}

async function closeReader(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): Promise<void> {
  try {
    await reader?.cancel();
  } catch (error) {
    if (error instanceof EngineError && error.code === 'drain-failed') throw error;
  } finally {
    reader?.releaseLock();
  }
}
