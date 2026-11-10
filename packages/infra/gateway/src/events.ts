// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/api/remotes/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
// Application-neutral selection registry replaces the DSH Agent and product event catalog.
import { homedir } from 'node:os';
import { Service, type Context } from '@deepseek-ai/cordis';
import { isRemoteJsonValue, type TypertResourceReader } from '@axterm/plugin-api';
import type {
  RemoteEventRegistration,
  RemoteEventSelections,
  RemoteEventContextSelector,
  TypertRemoteEventDispatch,
  TypertRemoteEventInvocation,
} from '@axterm/plugin-api/host';
import { carrierKeyOf, RegistrationLifetime } from '@axterm/infra-scope';
import { Deque } from '@axterm/infra-deque';
interface RuntimeEntry {
  readonly event: string;
  readonly mode: 'emit' | 'waterfall';
  readonly resources?: Readonly<Record<string, TypertResourceReader>>;
  readonly context?: RemoteEventContextSelector;
}
interface Queued {
  readonly value: TypertRemoteEventDispatch;
  readonly bytes: number;
}
class EventQueue {
  private readonly buffer = new Deque<Queued>();
  private bytes = 0;
  private wake: (() => void) | undefined;
  private closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    while (this.buffer.size) {
      const queued = this.buffer.popFront()!;
      if ('context' in queued.value) queued.value.reject(new Error('REMOTE_EVENT_SOURCE_CLOSED'));
    }
    this.bytes = 0;
  }
  push(value: TypertRemoteEventDispatch, bytes: number): boolean {
    if (this.closed || this.buffer.size >= 256 || this.bytes + bytes > 1024 * 1024) return false;
    this.buffer.pushBack({ value, bytes });
    this.bytes += bytes;
    this.wake?.();
    return true;
  }
  async *iterate(signal: AbortSignal): AsyncGenerator<TypertRemoteEventDispatch> {
    const abort = () => {
      this.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted && !this.closed) {
        const next = this.buffer.popFront();
        if (next) {
          this.bytes -= next.bytes;
          yield next.value;
        } else
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            if (signal.aborted) abort();
          });
      }
    } finally {
      signal.removeEventListener('abort', abort);
      this.close();
      this.wake = undefined;
    }
  }
}
/** Owns the generation source; domain owners select events and retain their own business policy. */
export default class RemoteEvents extends Service implements RemoteEventSelections {
  static inject = ['typertGateway'];
  private readonly entries = new Set<string>();
  private readonly registrations: RegistrationLifetime;
  private readonly lifetime = new AbortController();
  private readonly queue = new EventQueue();
  private sourceSignal: AbortSignal | undefined;
  private closed = false;
  constructor(ctx: Context) {
    super(ctx, 'remoteEvents');
    this.registrations = new RegistrationLifetime(ctx);
    const abortSource = () => this.queue.close();
    const unregister = ctx.typertGateway.registerRemoteEvents(
      (signal) => {
        this.sourceSignal = signal;
        signal.addEventListener('abort', abortSource, { once: true });
        if (signal.aborted) abortSource();
        return this.queue.iterate(signal);
      },
      { home: homedir() },
    );
    ctx.effect(() => async () => {
      this.closed = true;
      this.lifetime.abort();
      this.queue.close();
      await unregister();
      this.sourceSignal?.removeEventListener('abort', abortSource);
    });
  }
  register(selection: RemoteEventRegistration): () => Promise<void> {
    if (this.closed || this.sourceSignal?.aborted) throw new Error('REMOTE_EVENT_SOURCE_CLOSED');
    const entry = selection as unknown as RuntimeEntry;
    if (
      !/^[a-z][a-z0-9:/_.-]{0,255}$/i.test(entry.event) ||
      entry.event.startsWith('internal/') ||
      !['emit', 'waterfall'].includes(entry.mode) ||
      (entry.mode === 'waterfall' && typeof entry.context !== 'function')
    )
      throw new Error('REMOTE_EVENT_SELECTION_INVALID');
    if (this.entries.has(entry.event)) throw new Error('REMOTE_EVENT_SELECTION_DUPLICATE');
    if (this.entries.size >= 256) throw new Error('REMOTE_EVENT_SELECTION_CAPACITY');
    const owner = new AbortController();
    const dispatch = (receiver: unknown, ...args: unknown[]) => {
      if (this.closed || owner.signal.aborted || this.sourceSignal?.aborted)
        throw new Error('REMOTE_EVENT_SOURCE_CLOSED');
      if (entry.mode === 'emit') {
        if (!args.every((value) => isRemoteJsonValue(value)))
          throw new Error('REMOTE_EVENT_ARGUMENTS_INVALID');
        const bytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
        if (
          !this.queue.push(
            {
              event: entry.event,
              args,
              ...(entry.resources ? { resources: entry.resources } : {}),
            },
            bytes,
          )
        )
          throw new Error('REMOTE_EVENT_QUEUE_CAPACITY');
        return;
      }
      const [request, next] = args;
      if (typeof request !== 'object' || request === null || typeof next !== 'function')
        throw new Error('REMOTE_EVENT_ARGUMENTS_INVALID');
      const key = carrierKeyOf(receiver);
      if (!key) return next();
      const context = entry.context!(receiver, request);
      if (!context) return next();
      if (context.subject !== key) throw new Error('REMOTE_EVENT_SCOPE_INVALID');
      const raw = request as Record<string, unknown>;
      const inputSignal = raw.signal;
      if (inputSignal !== undefined && !(inputSignal instanceof AbortSignal))
        throw new Error('REMOTE_EVENT_SIGNAL_INVALID');
      const signal = AbortSignal.any([
        owner.signal,
        this.lifetime.signal,
        ...(this.sourceSignal ? [this.sourceSignal] : []),
        ...(inputSignal ? [inputSignal] : []),
      ]);
      const publicArgs = Object.fromEntries(
        Object.entries(raw).filter(([name]) => name !== context.scope.subject && name !== 'signal'),
      );
      if (!isRemoteJsonValue(publicArgs)) throw new Error('REMOTE_EVENT_ARGUMENTS_INVALID');
      const bytes = Buffer.byteLength(JSON.stringify(publicArgs), 'utf8');
      const outcome = Promise.withResolvers<unknown>();
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        action();
      };
      const abort = () => finish(() => outcome.reject(new Error('REMOTE_EVENT_CANCELLED')));
      const dispatch: TypertRemoteEventInvocation = {
        event: entry.event,
        request: { ...raw, signal },
        context,
        resolve: (value) =>
          finish(() => {
            if (value.kind === 'result') outcome.resolve(value.value);
            else
              void Promise.resolve()
                .then(() => {
                  signal.throwIfAborted();
                  return next();
                })
                .then(outcome.resolve, outcome.reject);
          }),
        reject: () => finish(() => outcome.reject(new Error('REMOTE_EVENT_FAILED'))),
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (!this.queue.push(dispatch, bytes))
        finish(() => outcome.reject(new Error('REMOTE_EVENT_QUEUE_CAPACITY')));
      return outcome.promise;
    };
    return this.registrations.owner(this.ctx).effect(() => {
      this.entries.add(entry.event);
      const dispose = this.ctx.on(
        entry.event as never,
        function (this: unknown, ...args: unknown[]) {
          return dispatch(this, ...args);
        } as never,
      );
      return () => {
        owner.abort();
        dispose();
        this.entries.delete(entry.event);
      };
    });
  }
}
