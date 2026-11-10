import type { Context } from '@deepseek-ai/cordis';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import FileGrants from './file-grants.ts';
import { ShellFileGrantCapabilities } from './file-capabilities.ts';
import {
  nativeCapabilities,
  NativeError,
  NATIVE_REQUEST_TIMEOUT_MS,
  MAX_NATIVE_REQUESTS,
  type NativeMethod,
  type NativeInput,
  type NativeOutput,
} from './protocol.ts';
export const inject = ['runtimeIdentity'];
/** Web has no Electron shell. Its one local owner uses the same closed file authority contract in process. */
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  const config = z
    .object({
      directory: z.string().refine(isAbsolute),
      workspace: z.string().refine(isAbsolute),
      downloads: z.string().refine(isAbsolute),
    })
    .strict()
    .parse(raw);
  const lifetime = new AbortController();
  const calls = new Set<Promise<unknown>>();
  const capabilities = new ShellFileGrantCapabilities(
    ctx.runtimeIdentity.generation,
    {
      choose: async () => {
        throw new NativeError('UNAVAILABLE');
      },
      defaultDirectory: (kind) => (kind === 'home' ? config.workspace : config.downloads),
      retire: () => {},
    },
    join(config.directory, ctx.runtimeIdentity.generation),
  );
  const owned: { grants?: FileGrants } = {};
  const setup = Promise.resolve().then(async () => {
    lifetime.signal.throwIfAborted();
    await mkdir(config.workspace, { recursive: true, mode: 0o700 });
    lifetime.signal.throwIfAborted();
    await mkdir(config.downloads, { recursive: true, mode: 0o700 });
    lifetime.signal.throwIfAborted();
  });
  void setup.catch(() => {});
  ctx.effect(() => async () => {
    lifetime.abort();
    const stopped = await Promise.allSettled([
      owned.grants?.close(),
      capabilities.close(),
      setup,
      ...calls,
    ]);
    if (stopped.slice(0, 2).some((result) => result.status === 'rejected'))
      throw new NativeError('IO');
  });
  await setup;
  lifetime.signal.throwIfAborted();
  const handlers = capabilities.handlers();
  const native = {
    generation: ctx.runtimeIdentity.generation,
    signal: lifetime.signal,
    call: <K extends NativeMethod>(
      method: K,
      input: NativeInput<K>,
      signal?: AbortSignal,
      timeoutMs = NATIVE_REQUEST_TIMEOUT_MS,
    ): Promise<NativeOutput<K>> => {
      if (lifetime.signal.aborted) return Promise.reject(new NativeError('CLOSED'));
      if (!Object.hasOwn(handlers, method)) return Promise.reject(new NativeError('UNAVAILABLE'));
      if (calls.size >= MAX_NATIVE_REQUESTS) return Promise.reject(new NativeError('LIMIT'));
      const schema = nativeCapabilities[method];
      const maximum = 'maxTimeoutMs' in schema ? schema.maxTimeoutMs : NATIVE_REQUEST_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum)
        return Promise.reject(new NativeError('INVALID'));
      const parsed = schema.input.safeParse(input);
      if (!parsed.success) return Promise.reject(new NativeError('INVALID'));
      const owned = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(timeoutMs),
        ...(signal ? [signal] : []),
      ]);
      const handler = (
        handlers as Record<string, (input: unknown, signal: AbortSignal) => unknown>
      )[method]!;
      const task = Promise.resolve().then(async () => {
        owned.throwIfAborted();
        const result = await handler(parsed.data, owned);
        owned.throwIfAborted();
        const output = schema.output.safeParse(result);
        if (!output.success) throw new NativeError('FAILED');
        return output.data as NativeOutput<K>;
      });
      calls.add(task);
      void task.then(
        () => calls.delete(task),
        () => calls.delete(task),
      );
      return task;
    },
  };
  owned.grants = new FileGrants(ctx, native);
}
