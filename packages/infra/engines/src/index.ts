import { Service, type Context } from '@deepseek-ai/cordis';
import { RegistrationLifetime } from '@axterm/infra-scope';
import type {} from '@axterm/plugin-api/host';
import {
  EngineError,
  engineErrorCodeSchema,
  engineDescriptorSchema,
  engineSessionInputSchema,
  engineRunInputSchema,
  engineExecutionOptionsSchema,
  type EngineExecutionOptions,
  engineEventSchema,
  engineToolRequestSchema,
  engineToolResultSchema,
  type EngineDescriptor,
  type EngineSessionInput,
  type EngineSessionHandle,
  type EngineRunInput,
  type EngineRunObserver,
  type EngineRunHandle,
  type EngineRunOutcome,
  type EngineErrorCode,
} from '@axterm/engine-api';
import type {
  EngineProvider,
  EngineProviderSession,
  EnginesService,
} from '@axterm/engine-api/host';

const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new EngineError('invalid');
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Copy before asynchronous provider entry; configuration never joins visible input/event facts. */
function executionOptions(raw: EngineExecutionOptions): EngineExecutionOptions {
  let value: unknown;
  try {
    const pending: { value: unknown; depth: number }[] = [{ value: raw, depth: 0 }];
    let nodes = 0;
    let encodedBytes = 0;
    const account = (count: number) => {
      encodedBytes += count;
      if (encodedBytes > 128 * 1024) throw new EngineError('capacity');
    };
    const jsonStringBytes = (text: string): number => {
      if (text.length > 128 * 1024) throw new EngineError('capacity');
      return bytes(text);
    };
    while (pending.length) {
      const item = pending.pop()!;
      if (++nodes > 8192 || item.depth > 32) throw new EngineError('capacity');
      if (item.value === null) {
        account(4);
        continue;
      }
      if (typeof item.value === 'string') {
        account(jsonStringBytes(item.value));
        continue;
      }
      if (typeof item.value === 'boolean') {
        account(item.value ? 4 : 5);
        continue;
      }
      if (typeof item.value === 'number') {
        if (!Number.isFinite(item.value)) throw new EngineError('invalid');
        account(String(item.value).length);
        continue;
      }
      if (!item.value || typeof item.value !== 'object') throw new EngineError('invalid');
      if (
        !Array.isArray(item.value) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(item.value))
      )
        throw new EngineError('invalid');
      const entries = Object.entries(item.value);
      if (entries.length > 8192) throw new EngineError('capacity');
      if (
        Array.isArray(item.value) &&
        (entries.length !== item.value.length ||
          entries.some(
            ([key]) =>
              !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (item.value as unknown[]).length,
          ))
      )
        throw new EngineError('invalid');
      account(2 + Math.max(0, entries.length - 1));
      for (const [key, child] of entries) {
        if (item.depth === 0 && key === 'configuration' && child === undefined) continue;
        if (!Array.isArray(item.value)) account(jsonStringBytes(key) + 1);
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
    const encoded = JSON.stringify(raw);
    if (encoded === undefined) throw new EngineError('invalid');
    if (new TextEncoder().encode(encoded).byteLength > 128 * 1024)
      throw new EngineError('capacity');
    value = JSON.parse(encoded);
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError('invalid');
  }
  return freeze(parse(engineExecutionOptionsSchema, value));
}
interface Entry {
  readonly descriptor: EngineDescriptor;
  readonly provider: EngineProvider;
  readonly sessions: Set<Session>;
  closing: boolean;
  failed: boolean;
}
interface Running {
  readonly abort: AbortController;
  readonly done: Promise<EngineRunOutcome>;
}
/** Execution ownership only. Application facts, approvals and persistence stay in the AI owner. */
export default class Engines extends Service implements EnginesService {
  private readonly entries = new Map<string, Entry>();
  private readonly registrations: RegistrationLifetime;
  private closed = false;
  constructor(ctx: Context) {
    super(ctx, 'engines');
    this.registrations = new RegistrationLifetime(ctx);
    ctx.inject(['desktopTaskInspection'], (scope) => {
      scope.desktopTaskInspection.register('engines', {
        inspect: (signal) => {
          signal.throwIfAborted();
          this.assertOpen();
          return {
            active: [...this.entries.values()].some(
              (entry) =>
                entry.failed ||
                entry.closing ||
                [...entry.sessions].some((session) => session.active()),
            ),
          };
        },
        dispose: async () => {
          this.closed = true;
          for (const entry of this.entries.values()) entry.closing = true;
          const outcomes = await Promise.allSettled(
            [...this.entries.values()].flatMap((entry) =>
              [...entry.sessions].map((session) => session.close()),
            ),
          );
          if (outcomes.some((outcome) => outcome.status === 'rejected'))
            throw new EngineError('drain-failed');
        },
      });
    });
    ctx.effect(() => () => {
      this.closed = true;
    });
  }
  register(id: string, provider: EngineProvider): () => Promise<void> {
    this.assertOpen();
    const descriptor = freeze(
      parse(engineDescriptorSchema, {
        id,
        label: provider.label,
        capabilities: provider.capabilities,
        state: 'ready',
      }),
    );
    if (typeof provider.openSession !== 'function') throw new EngineError('invalid');
    if (this.entries.has(id)) throw new EngineError('duplicate');
    if (this.entries.size >= 64) throw new EngineError('capacity');
    const entry: Entry = {
      descriptor,
      provider,
      sessions: new Set(),
      closing: false,
      failed: false,
    };
    const dispose = this.registrations.owner(this.ctx).effect(() => {
      this.entries.set(id, entry);
      this.changed(id);
      return async () => {
        entry.closing = true;
        this.changed(id);
        const outcomes = await Promise.allSettled(
          [...entry.sessions].map((session) => session.close()),
        );
        if (outcomes.some((outcome) => outcome.status === 'rejected')) {
          entry.failed = true;
          this.changed(id);
          throw new EngineError('drain-failed');
        }
        if (this.entries.get(id) === entry) this.entries.delete(id);
        this.changed(id);
      };
    }, 'engines.register');
    let ending: Promise<void> | undefined;
    return () =>
      (ending ??= Promise.resolve(dispose()).then(() => {
        if (entry.failed) throw new EngineError('drain-failed');
      }));
  }
  list(): readonly EngineDescriptor[] {
    this.assertOpen();
    return Object.freeze(
      [...this.entries.values()].map((entry) =>
        freeze({
          ...entry.descriptor,
          state: entry.failed
            ? ('failed' as const)
            : entry.closing
              ? ('draining' as const)
              : ('ready' as const),
        }),
      ),
    );
  }
  async openSession(
    engineId: string,
    raw: EngineSessionInput,
    signal?: AbortSignal,
  ): Promise<EngineSessionHandle> {
    this.assertOpen();
    if (signal?.aborted) throw new EngineError('cancelled');
    const input = freeze(parse(engineSessionInputSchema, raw));
    const entry = this.entries.get(engineId);
    if (!entry) throw new EngineError('missing');
    if (entry.closing) throw new EngineError('closed');
    if (input.resumeHandle && !entry.descriptor.capabilities.resume)
      throw new EngineError('unsupported');
    if (entry.sessions.size >= 128) throw new EngineError('capacity');
    if ([...entry.sessions].some((session) => session.sessionId === input.sessionId))
      throw new EngineError('duplicate');
    const session = new Session(engineId, input, entry, () => this.closed);
    const dispose = this.registrations.owner(this.ctx).effect(() => {
      entry.sessions.add(session);
      return async () => {
        await session.drain();
        entry.sessions.delete(session);
      };
    }, 'engines.session');
    session.dispose = dispose;
    session.bindSignal(signal);
    try {
      await session.open();
      return session;
    } catch (error) {
      try {
        await session.close();
      } catch {
        throw new EngineError('drain-failed');
      }
      throw error;
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new EngineError('closed');
  }
  private changed(id: string): void {
    for (const listener of this.ctx.events.dispatch('emit', ['engines/changed', id]) as Array<
      (id: string) => unknown
    >) {
      try {
        void Promise.resolve(listener(id)).catch(() =>
          this.ctx.logger.warn('ENGINE_OBSERVER_FAILED'),
        );
      } catch {
        this.ctx.logger.warn('ENGINE_OBSERVER_FAILED');
      }
    }
  }
}

class Session implements EngineSessionHandle {
  readonly sessionId: string;
  dispose: () => Promise<void> = async () => {};
  private readonly lifetime = new AbortController();
  private handle: EngineProviderSession | undefined;
  private opening: Promise<void> | undefined;
  private openingSettled = false;
  private running: Running | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private unsafeHandle = false;
  private readonly runs = new Set<string>();
  private unbindSignal: (() => void) | undefined;
  constructor(
    readonly engineId: string,
    private readonly input: EngineSessionInput,
    private readonly entry: Entry,
    private readonly registryClosed: () => boolean,
  ) {
    this.sessionId = input.sessionId;
  }
  bindSignal(signal?: AbortSignal): void {
    if (!signal) return;
    const abort = () => {
      // Mark/abort synchronously, then join and withdraw the owned registration.
      void this.drain().catch(() => {});
      void this.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    this.unbindSignal = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  }
  open(): Promise<void> {
    return (this.opening ??= Promise.resolve()
      .then(async () => {
        if (this.closed || this.entry.closing || this.registryClosed())
          throw new EngineError('cancelled');
        try {
          const handle = await this.entry.provider.openSession(this.input, this.lifetime.signal);
          if (handle && typeof handle.close === 'function') this.handle = handle;
          else if (handle) this.unsafeHandle = true;
          if (!handle || typeof handle.run !== 'function' || typeof handle.close !== 'function')
            throw new EngineError('invalid');
        } catch {
          throw new EngineError(
            this.closed || this.entry.closing ? 'cancelled' : 'provider-failed',
          );
        }
        if (this.closed || this.entry.closing || this.registryClosed())
          throw new EngineError('cancelled');
      })
      .finally(() => {
        this.openingSettled = true;
      }));
  }
  run(
    raw: EngineRunInput,
    observer: EngineRunObserver,
    rawOptions: EngineExecutionOptions = {},
  ): EngineRunHandle {
    this.assertOpen();
    const options = executionOptions(rawOptions);
    const input = freeze(parse(engineRunInputSchema, raw));
    if (bytes(input) > 1024 * 1024) throw new EngineError('capacity');
    if (typeof observer.event !== 'function') throw new EngineError('invalid');
    if (input.tools && !this.entry.descriptor.capabilities.tools)
      throw new EngineError('unsupported');
    if (input.tools && typeof observer.tool !== 'function')
      throw new EngineError('tool-unavailable');
    if (this.running) throw new EngineError('busy');
    if (this.runs.has(input.runId)) throw new EngineError('duplicate');
    if (this.runs.size >= 4096) throw new EngineError('capacity');
    this.runs.add(input.runId);
    const abort = new AbortController();
    const done = this.execute(input, observer, abort, options);
    const running: Running = { abort, done };
    this.running = running;
    void done.then(() => {
      if (this.running === running) this.running = undefined;
    });
    return Object.freeze({
      runId: input.runId,
      done,
      cancel: async () => {
        if (!this.entry.descriptor.capabilities.cancellation) throw new EngineError('unsupported');
        abort.abort();
        await done;
      },
    });
  }
  active(): boolean {
    return !this.openingSettled || this.running !== undefined || this.closed;
  }
  close(): Promise<void> {
    // Cordis removes a failed effect too; retain and re-observe the actual drain outcome.
    return Promise.resolve(this.dispose()).then(() => this.drain());
  }
  drain(): Promise<void> {
    this.closed = true;
    this.unbindSignal?.();
    this.unbindSignal = undefined;
    this.lifetime.abort();
    this.running?.abort.abort();
    return (this.closing ??= Promise.resolve().then(async () => {
      await this.opening?.catch(() => {});
      let failed = this.unsafeHandle;
      try {
        await this.handle?.close();
      } catch {
        failed = true;
      }
      await this.running?.done;
      if (failed) throw new EngineError('drain-failed');
    }));
  }
  private assertOpen(): void {
    if (this.closed || this.entry.closing || this.registryClosed() || !this.handle)
      throw new EngineError('closed');
  }
  private async execute(
    input: EngineRunInput,
    observer: EngineRunObserver,
    abort: AbortController,
    options: EngineExecutionOptions,
  ): Promise<EngineRunOutcome> {
    // Defer provider invocation until the running ownership record exists.
    await Promise.resolve();
    const signal = AbortSignal.any([abort.signal, this.lifetime.signal]);
    let failure: EngineErrorCode | undefined;
    let delivering: Promise<unknown> | undefined;
    let completed = false;
    let events = 0;
    let output = 0;
    const calls = new Set<string>();
    const fail = (code: EngineErrorCode): never => {
      failure ??= code;
      abort.abort();
      throw new EngineError(code);
    };
    const deliver = <T>(operation: () => Promise<T>): Promise<T> => {
      const rejected = (code: EngineErrorCode): Promise<never> => {
        if (code !== 'cancelled') {
          failure ??= code;
          abort.abort();
        }
        const rejected = Promise.reject<never>(new EngineError(code));
        void rejected.catch(() => {});
        return rejected;
      };
      if (delivering) return rejected('backpressure');
      if (signal.aborted) return rejected('cancelled');
      const task = Promise.resolve().then(operation);
      delivering = task;
      // A provider that forgets to await cannot create an unhandled rejection or bypass draining.
      void task.then(
        () => {
          if (delivering === task) delivering = undefined;
        },
        () => {
          if (delivering === task) delivering = undefined;
        },
      );
      return task;
    };
    try {
      signal.throwIfAborted();
      await this.handle!.run(input, {
        signal,
        ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
        emit: (raw) =>
          deliver(async () => {
            let event;
            try {
              event = freeze(parse(engineEventSchema, raw));
            } catch {
              return fail('invalid');
            }
            if (completed) return fail('invalid');
            if (++events > 32768) return fail('capacity');
            if (event.type === 'delta') {
              output += new TextEncoder().encode(event.text).byteLength;
              if (output > 2 * 1024 * 1024) return fail('capacity');
            }
            if (event.type === 'commandProposal' && !input.allowCommandProposal)
              return fail('unsupported');
            try {
              await observer.event(event);
            } catch {
              return fail('sink-failed');
            }
            if (signal.aborted) throw new EngineError('cancelled');
            if (event.type === 'completed') completed = true;
          }),
        tool: (raw) =>
          deliver(async () => {
            if (completed) return fail('invalid');
            if (!input.tools || !this.entry.descriptor.capabilities.tools || !observer.tool)
              return fail('tool-unavailable');
            let request;
            try {
              if (bytes(raw) > 32768) return fail('capacity');
              request = freeze(parse(engineToolRequestSchema, raw));
            } catch {
              return fail('invalid');
            }
            if (calls.has(request.callId)) return fail('duplicate');
            if (calls.size >= 50) return fail('capacity');
            calls.add(request.callId);
            try {
              const result = freeze(
                parse(engineToolResultSchema, await observer.tool(request, signal)),
              );
              if (bytes(result) > 32768) return fail('capacity');
              signal.throwIfAborted();
              return result;
            } catch {
              if (signal.aborted && !failure) throw new EngineError('cancelled');
              return fail('tool-unavailable');
            }
          }),
      });
      await delivering;
      if (failure) return { status: 'failed', code: failure };
      if (signal.aborted) return { status: 'cancelled' };
      return completed ? { status: 'completed' } : { status: 'failed', code: 'provider-failed' };
    } catch (error) {
      const providerCode =
        error instanceof EngineError ? engineErrorCodeSchema.safeParse(error.code) : undefined;
      const cancelled = signal.aborted;
      abort.abort();
      await delivering?.catch(() => {});
      if (failure) return { status: 'failed', code: failure };
      return cancelled
        ? { status: 'cancelled' }
        : { status: 'failed', code: providerCode?.success ? providerCode.data : 'provider-failed' };
    } finally {
      abort.abort();
    }
  }
}
