import { Context, Service } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import type { TypertLookup, TypertContext } from '@axterm/plugin-api';
import type { TypertRemoteEventSource, TypertRemoteEventDispatch } from '@axterm/plugin-api/host';
import { scopeTarget, type Scoped } from '@axterm/infra-scope';
import RemoteEvents from '../../packages/infra/gateway/src/events.ts';

interface Subject {
  readonly sourceFixture: true;
}
declare module '@axterm/plugin-api' {
  interface TypertLookupMap {
    sourceFixture: TypertLookup<Subject, string>;
  }
  interface TypertContextMap {
    sourceFixture: TypertContext<string>;
  }
  interface TypertRemoteEventSelection {
    'source/notice': true;
    'source/approval': true;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    'source/notice'(value: string): void;
    'source/approval'(
      this: Scoped<Context>,
      request: { workspace: Subject; label: string; signal: AbortSignal },
      next: () => Promise<boolean>,
    ): Promise<boolean>;
  }
}

const roots: Context[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
});
async function harness() {
  const root = new Context();
  roots.push(root);
  const abort = new AbortController();
  let iterator: AsyncIterator<TypertRemoteEventDispatch>;
  class GatewayProbe extends Service {
    constructor(ctx: Context) {
      super(ctx, 'typertGateway');
    }
    registerRemoteEvents(source: TypertRemoteEventSource) {
      iterator = source(abort.signal)[Symbol.asyncIterator]();
      return async () => {
        abort.abort();
        await iterator.return?.();
      };
    }
  }
  await root.plugin(GatewayProbe);
  const provider = root.plugin(RemoteEvents);
  await provider;
  return { root, provider, abort, next: () => iterator.next() };
}

it('owns selected notifications across caller/provider unload and rejects duplicate or unsafe selections', async () => {
  const { root, provider, next } = await harness();
  const caller = root.plugin({
    inject: ['remoteEvents'],
    apply(ctx) {
      ctx.remoteEvents.register({ event: 'source/notice', mode: 'emit' });
    },
  });
  await caller;
  expect(() => root.remoteEvents.register({ event: 'source/notice', mode: 'emit' })).toThrow(
    'DUPLICATE',
  );
  root.emit('source/notice', 'first');
  expect((await next()).value).toEqual({ event: 'source/notice', args: ['first'] });
  // Runtime validation also protects JavaScript plugins without the SDK type checker.
  expect(() =>
    root.remoteEvents.register({ event: 'internal/private', mode: 'emit' } as never),
  ).toThrow('INVALID');
  await caller.dispose();
  const unregister = root.remoteEvents.register({ event: 'source/notice', mode: 'emit' });
  root.emit('source/notice', 'replacement');
  expect((await next()).value).toMatchObject({ args: ['replacement'] });
  await unregister();
  const cached = root.remoteEvents;
  const pending = next();
  await provider.dispose();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(() => cached.register({ event: 'source/notice', mode: 'emit' })).toThrow();
});

it('bounds a stalled source by count and bytes and closes even an iterator never started by its consumer', async () => {
  const first = await harness();
  first.root.remoteEvents.register({ event: 'source/notice', mode: 'emit' });
  for (let i = 0; i < 256; i++) first.root.emit('source/notice', 'bounded');
  expect(() => first.root.emit('source/notice', 'overflow')).toThrow('QUEUE_CAPACITY');
  first.abort.abort();
  await first.provider.dispose();
  const second = await harness();
  second.root.remoteEvents.register({ event: 'source/notice', mode: 'emit' });
  expect(() => second.root.emit('source/notice', 'x'.repeat(1024 * 1024))).toThrow(
    'QUEUE_CAPACITY',
  );
  expect(() => second.root.emit('source/notice', new Date() as never)).toThrow('ARGUMENTS_INVALID');
});

it('routes scoped waterfalls, delegates once, and prevents continuation after caller cancellation', async () => {
  const { root, next } = await harness();
  const subject: Subject = { sourceFixture: true };
  root.remoteEvents.register({
    event: 'source/approval',
    mode: 'waterfall',
    context: () => ({
      value: root,
      subject,
      scope: { context: 'sourceFixture', id: 'one', subject: 'workspace' },
    }),
  });
  const fallback = vi.fn(async () => false);
  const signal = new AbortController();
  const invoke = () =>
    root.waterfall(
      scopeTarget(root, subject),
      'source/approval',
      { workspace: subject, label: 'safe label', signal: signal.signal },
      fallback,
    );
  const accepted = invoke();
  const first = (await next()).value!;
  if (!('context' in first)) throw new Error('Missing scoped invocation');
  first.resolve({ kind: 'result', value: true });
  first.resolve({ kind: 'next' });
  expect(await accepted).toBe(true);
  expect(fallback).not.toHaveBeenCalled();
  const delegated = invoke();
  const second = (await next()).value!;
  if (!('context' in second)) throw new Error('Missing scoped invocation');
  second.resolve({ kind: 'next' });
  expect(await delegated).toBe(false);
  expect(fallback).toHaveBeenCalledOnce();
  const cancelled = invoke();
  const rejection = expect(cancelled).rejects.toThrow('CANCELLED');
  const third = (await next()).value!;
  signal.abort();
  if (!('context' in third)) throw new Error('Missing scoped invocation');
  third.resolve({ kind: 'next' });
  await rejection;
  expect(fallback).toHaveBeenCalledOnce();
});

it('redacts arbitrary rejections and cancels queued scoped work on owner unload', async () => {
  const { root, next } = await harness();
  const subject: Subject = { sourceFixture: true };
  const unregister = root.remoteEvents.register({
    event: 'source/approval',
    mode: 'waterfall',
    context: () => ({
      value: root,
      subject,
      scope: { context: 'sourceFixture', id: 'one', subject: 'workspace' },
    }),
  });
  const fallback = vi.fn(async () => false);
  const failed = root.waterfall(
    scopeTarget(root, subject),
    'source/approval',
    { workspace: subject, label: 'safe', signal: new AbortController().signal },
    fallback,
  );
  const failedResult = expect(failed).rejects.toThrow(/^REMOTE_EVENT_FAILED$/);
  const invocation = (await next()).value!;
  if (!('context' in invocation)) throw new Error('Missing scoped invocation');
  invocation.reject(new Error('fixture-private-listener-value'));
  await failedResult;
  const pending = root.waterfall(
    scopeTarget(root, subject),
    'source/approval',
    { workspace: subject, label: 'safe', signal: new AbortController().signal },
    fallback,
  );
  const rejected = expect(pending).rejects.toThrow('CANCELLED');
  await unregister();
  await rejected;
  expect(fallback).not.toHaveBeenCalled();
});
