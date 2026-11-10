import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import Engines from '../../packages/infra/engines/src/index.ts';
import {
  EngineError,
  type EngineEvent,
  type EngineRunInput,
  type EngineRunObserver,
} from '@axterm/engine-api';
import type {
  EngineProvider,
  EngineProviderSession,
  EngineRunContext,
} from '@axterm/engine-api/host';

const roots: Context[] = [];
afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => root.fiber.dispose()));
});
async function boot() {
  const root = new Context();
  roots.push(root);
  await root.plugin(Engines);
  return root;
}
const input = (runId = 'run'): EngineRunInput => ({
  runId,
  providerId: 'configured-provider',
  model: 'fixed-model',
  system: 'Visible system',
  prompt: 'Visible user',
  context: 'Bounded context',
  tools: false,
});
const observer = (): EngineRunObserver => ({ event: async () => {} });
function provider(
  session: Partial<EngineProviderSession> = {},
  capabilities: Partial<EngineProvider['capabilities']> = {},
): EngineProvider {
  return {
    label: 'Fixture engine',
    capabilities: { cancellation: true, tools: false, resume: false, ...capabilities },
    openSession: async () => ({
      run: async (_input, ctx) => {
        await ctx.emit({ type: 'delta', text: 'visible result' });
        await ctx.emit({ type: 'completed' });
      },
      close: async () => {},
      ...session,
    }),
  };
}

it('rejects aborted allocation before calling a provider and joins a late opening handle before reporting cancellation', async () => {
  const root = await boot();
  let entered = false;
  let providerSignal: AbortSignal | undefined;
  let releaseOpen!: () => void;
  let releaseClose!: () => void;
  let closeStarted = false;
  const allocation = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const closure = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  root.engines.register('slow-open', {
    label: 'Slow',
    capabilities: { cancellation: true, tools: false, resume: false },
    async openSession(_input, signal) {
      entered = true;
      providerSignal = signal;
      await allocation;
      return {
        run: async () => {},
        close: async () => {
          closeStarted = true;
          await closure;
        },
      };
    },
  });
  await expect(
    root.engines.openSession('slow-open', { sessionId: 'already-aborted' }, AbortSignal.abort()),
  ).rejects.toThrow('CANCELLED');
  expect(entered).toBe(false);
  const controller = new AbortController();
  const opening = root.engines.openSession(
    'slow-open',
    { sessionId: 'opening' },
    controller.signal,
  );
  let settled = false;
  void opening.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.waitFor(() => expect(entered).toBe(true));
  controller.abort();
  expect(providerSignal?.aborted).toBe(true);
  expect(settled).toBe(false);
  releaseOpen();
  await vi.waitFor(() => expect(closeStarted).toBe(true));
  expect(settled).toBe(false);
  releaseClose();
  await expect(opening).rejects.toThrow('CANCELLED');
  const replacement = root.engines.openSession('slow-open', { sessionId: 'opening' });
  await (await replacement).close();
});

it('binds the caller signal to the complete Engine session and waits for actual provider closure', async () => {
  const root = await boot();
  let release!: () => void;
  let closing = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  root.engines.register(
    'signal-owned',
    provider({
      close: async () => {
        closing = true;
        await held;
      },
    }),
  );
  const controller = new AbortController();
  const session = await root.engines.openSession(
    'signal-owned',
    { sessionId: 'owned' },
    controller.signal,
  );
  controller.abort();
  await vi.waitFor(() => expect(closing).toBe(true));
  expect(() => session.run(input(), observer())).toThrow('CLOSED');
  let closed = false;
  const close = session.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await close;
  expect(closed).toBe(true);
  await (await root.engines.openSession('signal-owned', { sessionId: 'owned' })).close();
});

it('selects exact engines, preserves immutable capability metadata and rejects missing/duplicate/unsupported operations', async () => {
  const root = await boot();
  const first = provider();
  const close = vi.fn(async () => {});
  const remove = root.engines.register('first', first);
  root.engines.register('second', provider({ close }));
  first.capabilities.tools = true;
  expect(root.engines.list().map((item) => item.id)).toEqual(['first', 'second']);
  expect(root.engines.list()[0]!.capabilities.tools).toBe(false);
  expect(Object.isFrozen(root.engines.list()[0]!.capabilities)).toBe(true);
  expect(() => root.engines.register('first', provider())).toThrow('DUPLICATE');
  await expect(root.engines.openSession('absent', { sessionId: 'session' })).rejects.toThrow(
    'MISSING',
  );
  await expect(
    root.engines.openSession('first', { sessionId: 'session', resumeHandle: 'opaque' }),
  ).rejects.toThrow('UNSUPPORTED');
  const session = await root.engines.openSession('first', { sessionId: 'session' });
  await expect(root.engines.openSession('first', { sessionId: 'session' })).rejects.toThrow(
    'DUPLICATE',
  );
  const events: EngineEvent[] = [];
  const run = session.run(input(), {
    event: async (event) => {
      events.push(event);
    },
  });
  expect(() => session.run(input('other'), observer())).toThrow('BUSY');
  expect(await run.done).toEqual({ status: 'completed' });
  expect(events.map((event) => event.type)).toEqual(['delta', 'completed']);
  expect(() => session.run(input(), observer())).toThrow('DUPLICATE');
  expect(() => session.run({ ...input('tools'), tools: true }, observer())).toThrow('UNSUPPORTED');
  await session.close();
  await session.close();
  expect(() => session.run(input('late'), observer())).toThrow('CLOSED');
  await remove();
  await remove();
  expect(root.engines.list().map((item) => item.id)).toEqual(['second']);
  const second = await root.engines.openSession('second', { sessionId: 'second' });
  await second.close();
  expect(close).toHaveBeenCalledOnce();
});

it('unregisters only after cancellation and actual run/handle draining; replacement cannot steal closing ownership', async () => {
  const root = await boot();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<AbortSignal>();
  const closed = vi.fn(() => release.promise);
  let remove: () => Promise<void> = async () => {};
  const owner = root.plugin({
    inject: ['engines'],
    apply(ctx) {
      remove = ctx.engines.register(
        'slow',
        provider({
          run: async (_input, ctx) => {
            started.resolve(ctx.signal);
            await release.promise;
            ctx.signal.throwIfAborted();
          },
          close: closed,
        }),
      );
    },
  });
  await owner;
  const session = await root.engines.openSession('slow', { sessionId: 'session' });
  const run = session.run(input(), observer());
  const signal = await started.promise;
  let finished = false;
  const ending = remove().then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(root.engines.list()[0]!.state).toBe('draining');
  expect(finished).toBe(false);
  expect(() => root.engines.register('slow', provider())).toThrow('DUPLICATE');
  await expect(root.engines.openSession('slow', { sessionId: 'late' })).rejects.toThrow('CLOSED');
  release.resolve();
  await ending;
  expect(await run.done).toEqual({ status: 'cancelled' });
  expect(closed).toHaveBeenCalledOnce();
  expect(root.engines.list()).toEqual([]);
  root.engines.register('slow', provider());
  await remove();
  expect(root.engines.list()[0]!.state).toBe('ready');
  await owner.dispose();
});

it('consumer unload aborts and closes a late provider session before completing', async () => {
  const root = await boot();
  const opening = Promise.withResolvers<EngineProviderSession>();
  const started = Promise.withResolvers<AbortSignal>();
  const close = vi.fn(async () => {});
  root.engines.register('late', {
    ...provider(),
    openSession: async (_input, signal) => {
      started.resolve(signal);
      return opening.promise;
    },
  });
  let pending: Promise<unknown> = Promise.resolve();
  const consumer = root.plugin({
    inject: ['engines'],
    apply(ctx) {
      pending = ctx.engines.openSession('late', { sessionId: 'consumer-session' });
      void pending.catch(() => {});
    },
  });
  await consumer;
  const signal = await started.promise;
  let ended = false;
  const ending = consumer.dispose().then(() => {
    ended = true;
  });
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(ended).toBe(false);
  opening.resolve({ run: async () => {}, close });
  await expect(pending).rejects.toThrow('CANCELLED');
  await ending;
  expect(close).toHaveBeenCalledOnce();
  const session = await root.engines.openSession('late', { sessionId: 'consumer-session' });
  await session.close();
});

it('reports unsupported cancellation while unload still aborts and joins actual work', async () => {
  const root = await boot();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<AbortSignal>();
  root.engines.register(
    'uncancellable',
    provider(
      {
        run: async (_input, ctx) => {
          started.resolve(ctx.signal);
          await gate.promise;
        },
        close: async () => {
          gate.resolve();
        },
      },
      { cancellation: false },
    ),
  );
  const session = await root.engines.openSession('uncancellable', { sessionId: 's' });
  const run = session.run(input(), observer());
  const signal = await started.promise;
  await expect(run.cancel()).rejects.toThrow('UNSUPPORTED');
  expect(signal.aborted).toBe(false);
  await session.close();
  expect(signal.aborted).toBe(true);
  expect(await run.done).toEqual({ status: 'cancelled' });
});

it('redacts provider failures and refuses hidden reasoning, post-completion events and unbounded visible output', async () => {
  const root = await boot();
  let behavior: EngineProviderSession['run'] = async () => {
    throw new Error('PRIVATE_PROVIDER_SECRET');
  };
  root.engines.register('failures', provider({ run: (...args) => behavior(...args) }));
  const session = await root.engines.openSession('failures', { sessionId: 's' });
  expect(await session.run(input('failure'), observer()).done).toEqual({
    status: 'failed',
    code: 'provider-failed',
  });
  behavior = async (_input, ctx) => {
    await ctx.emit({ type: 'thinking', text: 'PRIVATE_REASONING' } as unknown as EngineEvent);
  };
  expect(await session.run(input('reasoning'), observer()).done).toEqual({
    status: 'failed',
    code: 'invalid',
  });
  behavior = async (_input, ctx) => {
    await ctx.emit({ type: 'completed' });
    await ctx.emit({ type: 'delta', text: 'late' });
  };
  expect(await session.run(input('late'), observer()).done).toEqual({
    status: 'failed',
    code: 'invalid',
  });
  behavior = async (_input, ctx) => {
    for (let i = 0; i < 9; i++) await ctx.emit({ type: 'delta', text: 'x'.repeat(262144) });
  };
  expect(await session.run(input('capacity'), observer()).done).toEqual({
    status: 'failed',
    code: 'capacity',
  });
  expect(() =>
    session.run(
      {
        ...input('input-capacity'),
        context: '你'.repeat(131072),
        system: '你'.repeat(131072),
        prompt: '你'.repeat(131072),
      },
      observer(),
    ),
  ).toThrow('CAPACITY');
  let late: EngineRunContext | undefined;
  behavior = async (_input, ctx) => {
    late = ctx;
    await ctx.emit({ type: 'completed' });
  };
  expect(await session.run(input('last'), observer()).done).toEqual({ status: 'completed' });
  await expect(late!.emit({ type: 'delta', text: 'after settlement' })).rejects.toThrow(
    'CANCELLED',
  );
  await session.close();
});

it('enforces awaited event backpressure and drains the unacknowledged application sink', async () => {
  const root = await boot();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  root.engines.register(
    'backpressure',
    provider({
      run: async (_input, ctx) => {
        void ctx.emit({ type: 'delta', text: 'first' });
        await ctx.emit({ type: 'delta', text: 'second' });
      },
    }),
  );
  const session = await root.engines.openSession('backpressure', { sessionId: 's' });
  let ended = false;
  const run = session.run(input(), {
    event: async () => {
      entered.resolve();
      await gate.promise;
    },
  });
  void run.done.then(() => {
    ended = true;
  });
  await entered.promise;
  await Promise.resolve();
  expect(ended).toBe(false);
  gate.resolve();
  expect(await run.done).toEqual({ status: 'failed', code: 'backpressure' });
  await session.close();
});

it('routes tools only through the application, rejects duplicate calls and contains approval/sink errors', async () => {
  const root = await boot();
  let behavior: EngineProviderSession['run'] = async (_input, ctx) => {
    await ctx.tool({ callId: 'one', name: 'workspace.exec', arguments: { command: 'pwd' } });
    await ctx.tool({ callId: 'one', name: 'workspace.exec', arguments: { command: 'pwd' } });
  };
  root.engines.register(
    'tools',
    provider({ run: (...args) => behavior(...args) }, { tools: true }),
  );
  const session = await root.engines.openSession('tools', { sessionId: 's' });
  const tool = vi.fn(async () => ({ text: 'approved output', isError: false }));
  expect(await session.run({ ...input('no-tools') }, { event: async () => {}, tool }).done).toEqual(
    { status: 'failed', code: 'tool-unavailable' },
  );
  expect(tool).not.toHaveBeenCalled();
  expect(
    await session.run({ ...input('tools'), tools: true }, { event: async () => {}, tool }).done,
  ).toEqual({ status: 'failed', code: 'duplicate' });
  expect(tool).toHaveBeenCalledOnce();
  const deny = vi.fn(async () => {
    throw new Error('PRIVATE_APPROVAL_FAILURE');
  });
  expect(
    await session.run({ ...input('denied'), tools: true }, { event: async () => {}, tool: deny })
      .done,
  ).toEqual({ status: 'failed', code: 'tool-unavailable' });
  expect(deny).toHaveBeenCalledOnce();
  behavior = async (_input, ctx) => {
    await ctx.emit({ type: 'delta', text: 'visible' });
  };
  expect(
    await session.run(input('sink'), {
      event: async () => {
        throw new Error('PRIVATE_SINK_FAILURE');
      },
    }).done,
  ).toEqual({ status: 'failed', code: 'sink-failed' });
  await session.close();
});

it('retains failed handle ownership, and closes malformed handles when a close operation exists', async () => {
  const root = await boot();
  const close = vi.fn(async () => {
    throw new Error('PRIVATE_CLOSE_FAILURE');
  });
  const remove = root.engines.register('broken', provider({ close }));
  const session = await root.engines.openSession('broken', { sessionId: 's' });
  await expect(session.close()).rejects.toThrow('DRAIN_FAILED');
  await expect(remove()).rejects.toThrow('DRAIN_FAILED');
  expect(root.engines.list()[0]!.state).toBe('failed');
  expect(() => root.engines.register('broken', provider())).toThrow('DUPLICATE');
  const cleanup = vi.fn(async () => {});
  root.engines.register('malformed', {
    ...provider(),
    openSession: async () => ({ run: null, close: cleanup }) as unknown as EngineProviderSession,
  });
  await expect(root.engines.openSession('malformed', { sessionId: 'bad' })).rejects.toThrow(
    'PROVIDER_FAILED',
  );
  expect(cleanup).toHaveBeenCalledOnce();
  const cached = root.engines;
  await root.fiber.dispose();
  expect(() => cached.register('stale', provider())).toThrow();
});

it('contains secret-bearing metadata observers without changing committed registrations', async () => {
  const root = await boot();
  const warn = vi.spyOn(root.logger, 'warn').mockImplementation(() => {});
  root.on('engines/changed', async () => {
    throw new Error('PRIVATE_OBSERVER');
  });
  const remove = root.engines.register('safe', provider());
  await Promise.resolve();
  expect(root.engines.list()[0]!.id).toBe('safe');
  await remove();
  expect(warn).toHaveBeenCalled();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
  expect(new EngineError('missing').code).toBe('missing');
});

it('joins cancellation through an in-flight application tool callback', async () => {
  const root = await boot();
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  root.engines.register(
    'tool-cancel',
    provider(
      {
        run: async (_input, ctx) => {
          await ctx.tool({ callId: 'call', name: 'workspace.exec', arguments: { command: 'pwd' } });
        },
      },
      { tools: true },
    ),
  );
  const session = await root.engines.openSession('tool-cancel', { sessionId: 's' });
  const run = session.run(
    { ...input(), tools: true },
    {
      event: async () => {},
      tool: async (_request, signal) => {
        entered.resolve(signal);
        await release.promise;
        signal.throwIfAborted();
        return { text: 'actual result', isError: false };
      },
    },
  );
  const signal = await entered.promise;
  let ended = false;
  const cancel = run.cancel().then(() => {
    ended = true;
  });
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(ended).toBe(false);
  release.resolve();
  await cancel;
  expect(await run.done).toEqual({ status: 'cancelled' });
  await session.close();
});

it('exposes active Engine work to Desktop task inspection and drains it on shutdown', async () => {
  const { default: DesktopTasks } = await import('../../packages/plugins/desktop/src/tasks.ts');
  const root = new Context();
  roots.push(root);
  await root.plugin(DesktopTasks);
  await root.plugin(Engines);
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  root.engines.register(
    'desktop',
    provider({
      run: async (_input, ctx) => {
        entered.resolve();
        await release.promise;
        ctx.signal.throwIfAborted();
      },
      close: async () => {
        release.resolve();
      },
    }),
  );
  const session = await root.engines.openSession('desktop', { sessionId: 's' });
  expect(await root.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
    active: false,
  });
  const run = session.run(input(), observer());
  await entered.promise;
  expect(await root.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
    active: true,
  });
  await session.close();
  expect(await run.done).toEqual({ status: 'cancelled' });
  expect(await root.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
    active: false,
  });
});

it('denies tool execution after a completed event and exposes no callback for unsupported tools', async () => {
  const root = await boot();
  const tool = vi.fn(async () => ({ text: 'should not execute', isError: false }));
  root.engines.register(
    'completed-tools',
    provider(
      {
        run: async (_input, ctx) => {
          await ctx.emit({ type: 'completed' });
          await ctx.tool({ callId: 'late', name: 'workspace.exec', arguments: { command: 'pwd' } });
        },
      },
      { tools: true },
    ),
  );
  const session = await root.engines.openSession('completed-tools', { sessionId: 's' });
  expect(() => session.run({ ...input(), tools: true }, observer())).toThrow('TOOL_UNAVAILABLE');
  expect(
    await session.run({ ...input('actual'), tools: true }, { event: async () => {}, tool }).done,
  ).toEqual({ status: 'failed', code: 'invalid' });
  expect(tool).not.toHaveBeenCalled();
  await session.close();
});

it('copies bounded execution bindings before provider entry without mixing them into visible input/events', async () => {
  const root = await boot();
  const configured = {
    configuration: { provider: { credentialRef: 'RUN_REFERENCE', models: ['one'] } },
  };
  let captured: unknown;
  root.engines.register(
    'configured',
    provider({
      run: async (input, context) => {
        captured = context.configuration;
        expect(Object.isFrozen(context.configuration)).toBe(true);
        expect(Object.isFrozen((context.configuration as { provider: object }).provider)).toBe(
          true,
        );
        expect(JSON.stringify(input)).not.toContain('RUN_REFERENCE');
        await context.emit({ type: 'completed' });
      },
    }),
  );
  const session = await root.engines.openSession('configured', { sessionId: 'bound-session' });
  const run = session.run(input(), observer(), configured);
  configured.configuration.provider.credentialRef = 'MUTATED_REFERENCE';
  configured.configuration.provider.models.push('two');
  expect(await run.done).toEqual({ status: 'completed' });
  expect(captured).toEqual({ provider: { credentialRef: 'RUN_REFERENCE', models: ['one'] } });
  await session.close();
});
it('rejects invalid, non-JSON, excessive and deep bindings before consuming a run identity or invoking the provider', async () => {
  const root = await boot();
  const execute = vi.fn(async () => {});
  root.engines.register('binding-limits', provider({ run: execute }));
  const session = await root.engines.openSession('binding-limits', { sessionId: 'limits' });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  let deep: unknown = 'leaf';
  for (let i = 0; i < 34; i++) deep = { child: deep };
  for (const raw of [
    { unexpected: true },
    { configuration: { value: NaN } },
    { configuration: new Date() },
    { configuration: { callback: () => {} } },
    { configuration: circular },
    { configuration: Array(1) },
    { configuration: Symbol('invalid') },
    { configuration: ['x'.repeat(100 * 1024), 'y'.repeat(100 * 1024)] },
    { configuration: deep },
    { configuration: 'x'.repeat(128 * 1024) },
    { configuration: Array.from({ length: 8193 }, () => 0) },
  ]) {
    expect(() => session.run(input(), observer(), raw as never)).toThrow(
      /ENGINE_(INVALID|CAPACITY)/,
    );
  }
  expect(execute).not.toHaveBeenCalled();
  expect(await session.run(input(), observer()).done).toEqual({
    status: 'failed',
    code: 'provider-failed',
  });
  expect(execute).toHaveBeenCalledOnce();
  await session.close();
});

it('never treats execution configuration as tool or approval authority', async () => {
  const root = await boot();
  const tool = vi.fn(async () => ({ text: 'unexpected', isError: false }));
  root.engines.register(
    'binding-policy',
    provider(
      {
        run: async (_input, context) => {
          await context.tool({
            callId: 'configured-attempt',
            name: 'plugins.add',
            arguments: { package: 'unapproved' },
          });
          await context.emit({ type: 'completed' });
        },
      },
      { tools: true },
    ),
  );
  const session = await root.engines.openSession('binding-policy', { sessionId: 'policy' });
  const run = session.run(
    input(),
    { event: async () => {}, tool },
    { configuration: { tools: true, approval: 'approved' } },
  );
  expect(await run.done).toEqual({ status: 'failed', code: 'tool-unavailable' });
  expect(tool).not.toHaveBeenCalled();
  await session.close();
});
