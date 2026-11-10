import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import Engines from '../../packages/infra/engines/src/index.ts';
import { EngineModelProvider } from '../../packages/plugins/ai/src/adapters/engine-model.ts';
import type { EngineProvider } from '@axterm/engine-api/host';
import type { ModelRequest } from '../../packages/plugins/ai/src/ports/model-provider.ts';
const roots: Context[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await root.fiber.dispose();
});
async function boot(provider: EngineProvider, id = 'chosen') {
  const ctx = new Context();
  roots.push(ctx);
  await ctx.plugin(Engines);
  ctx.engines.register(id, provider);
  return ctx;
}
const input = (signal = new AbortController().signal): ModelRequest => ({
  model: 'fixture',
  system: 'system',
  prompt: 'visible',
  context: 'reviewed',
  signal,
});
const base = (): EngineProvider => ({
  label: 'Fixture',
  capabilities: { cancellation: true, tools: true, resume: false },
  openSession: async () => ({
    run: async (_input, ctx) => {
      await ctx.emit({ type: 'delta', text: 'visible' });
      await ctx.emit({ type: 'completed' });
    },
    close: async () => {},
  }),
});

it('uses the exact Engine and immutable execution binding without creating an Agent loop or persisting execution handles', async () => {
  const fixture = base();
  let configured: unknown;
  let received: unknown;
  let closed = 0;
  fixture.openSession = async () => ({
    run: async (request, ctx) => {
      received = request;
      configured = ctx.configuration;
      await ctx.emit({ type: 'delta', text: 'visible' });
      await ctx.emit({ type: 'completed' });
    },
    close: async () => {
      closed++;
    },
  });
  const ctx = await boot(fixture);
  const adapter = new EngineModelProvider(ctx.engines, 'chosen', 'provider', {
    configuration: { credentialRef: 'REFERENCE_ONLY' },
  });
  const events = [];
  for await (const event of adapter.stream(input())) events.push(event);
  expect(events).toEqual([{ type: 'delta', text: 'visible' }, { type: 'completed' }]);
  expect(configured).toEqual({ credentialRef: 'REFERENCE_ONLY' });
  expect(Object.isFrozen(configured)).toBe(true);
  expect(received).toMatchObject({
    model: 'fixture',
    providerId: 'provider',
    prompt: 'visible',
    context: 'reviewed',
    tools: false,
  });
  expect(closed).toBe(1);
  await expect(
    new EngineModelProvider(ctx.engines, 'missing', 'provider').stream(input()).next(),
  ).rejects.toThrow('MISSING');
});
it('acknowledges one event only after the application advances and closes if the consumer stops early', async () => {
  const fixture = base();
  let acknowledged = 0;
  let closed = 0;
  fixture.openSession = async () => ({
    run: async (_input, ctx) => {
      await ctx.emit({ type: 'delta', text: 'first' });
      acknowledged++;
      await ctx.emit({ type: 'delta', text: 'second' });
      acknowledged++;
      await ctx.emit({ type: 'completed' });
    },
    close: async () => {
      closed++;
    },
  });
  const ctx = await boot(fixture);
  const iterator = new EngineModelProvider(ctx.engines, 'chosen', 'provider').stream(input());
  expect((await iterator.next()).value).toEqual({ type: 'delta', text: 'first' });
  expect(acknowledged).toBe(0);
  await iterator.return(undefined);
  expect(closed).toBe(1);
  expect(acknowledged).toBeLessThanOrEqual(1);
});
it('cancels and drains an Engine while the application consumer is paused on a yielded event', async () => {
  const fixture = base();
  let closed = 0;
  fixture.openSession = async () => ({
    run: async (_input, ctx) => {
      await ctx.emit({ type: 'delta', text: 'held' });
      await ctx.emit({ type: 'completed' });
    },
    close: async () => {
      closed++;
    },
  });
  const ctx = await boot(fixture);
  const controller = new AbortController();
  const iterator = new EngineModelProvider(ctx.engines, 'chosen', 'provider').stream(
    input(controller.signal),
  );
  await iterator.next();
  controller.abort();
  await vi.waitFor(() => expect(closed).toBe(1));
  await iterator.return(undefined);
});
it('forwards only workspace.exec through the application tool callback with the owned signal', async () => {
  const fixture = base();
  let result: unknown;
  fixture.openSession = async () => ({
    run: async (_input, ctx) => {
      result = await ctx.tool({
        callId: 'tool',
        name: 'workspace.exec',
        arguments: { command: 'pwd' },
      });
      await ctx.emit({ type: 'completed' });
    },
    close: async () => {},
  });
  const ctx = await boot(fixture);
  const execute = vi.fn(async (_command: string, _id: string, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    return { text: 'actual output', isError: false };
  });
  for await (const _event of new EngineModelProvider(ctx.engines, 'chosen', 'provider').stream({
    ...input(),
    executeCommand: execute,
  })) {
    /* consume */
  }
  expect(execute).toHaveBeenCalledOnce();
  expect(result).toEqual({ text: 'actual output', isError: false });
});
it('refuses unsupported cancellation and tools before opening an execution session', async () => {
  const original = base();
  const open = vi.fn(original.openSession);
  const fixture: EngineProvider = {
    ...original,
    openSession: open,
    capabilities: { cancellation: false, tools: false, resume: false },
  };
  const ctx = await boot(fixture);
  await expect(
    new EngineModelProvider(ctx.engines, 'chosen', 'provider').stream(input()).next(),
  ).rejects.toThrow('UNSUPPORTED');
  expect(open).not.toHaveBeenCalled();
  ctx.engines.register('no-tools', {
    ...original,
    openSession: open,
    capabilities: { cancellation: true, tools: false, resume: false },
  });
  await expect(
    new EngineModelProvider(ctx.engines, 'no-tools', 'provider')
      .stream({
        ...input(),
        executeCommand: async () => ({ text: 'not executed', isError: false }),
      })
      .next(),
  ).rejects.toThrow('UNSUPPORTED');
  expect(open).not.toHaveBeenCalled();
});
it('propagates provider failure without accepting successful completion', async () => {
  const fixture = base();
  fixture.openSession = async () => ({
    run: async () => {
      throw new Error('PRIVATE_PROVIDER_ERROR');
    },
    close: async () => {},
  });
  const ctx = await boot(fixture);
  await expect(
    new EngineModelProvider(ctx.engines, 'chosen', 'provider').stream(input()).next(),
  ).rejects.toThrow('PROVIDER_FAILED');
});

it('captures the application binding before a delayed Engine allocation', async () => {
  const fixture = base();
  let opened = false;
  let finish!: () => void;
  let received: unknown;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  fixture.openSession = async () => {
    opened = true;
    await held;
    return {
      run: async (_input, ctx) => {
        received = ctx.configuration;
        await ctx.emit({ type: 'completed' });
      },
      close: async () => {},
    };
  };
  const ctx = await boot(fixture);
  const options = { configuration: { credentialRef: 'ORIGINAL_REFERENCE' } };
  const iterator = new EngineModelProvider(ctx.engines, 'chosen', 'provider', options).stream(
    input(),
  );
  const first = iterator.next();
  await vi.waitFor(() => expect(opened).toBe(true));
  options.configuration.credentialRef = 'CHANGED_REFERENCE';
  finish();
  await first;
  await iterator.next();
  expect(received).toEqual({ credentialRef: 'ORIGINAL_REFERENCE' });
});

it('denies foreign tools and additional command fields before reaching application effects', async () => {
  for (const request of [
    { callId: 'one', name: 'files.delete', arguments: { command: 'pwd' } },
    { callId: 'two', name: 'workspace.exec', arguments: { command: 'pwd', approved: true } },
  ]) {
    const fixture = base();
    fixture.openSession = async () => ({
      run: async (_input, ctx) => {
        await ctx.tool(request);
      },
      close: async () => {},
    });
    const ctx = await boot(fixture);
    const execute = vi.fn(async () => ({ text: 'not executed', isError: false }));
    await expect(
      new EngineModelProvider(ctx.engines, 'chosen', 'provider')
        .stream({ ...input(), executeCommand: execute })
        .next(),
    ).rejects.toThrow('TOOL_UNAVAILABLE');
    expect(execute).not.toHaveBeenCalled();
  }
});

it('drains the adapter independently of a consumer paused on yield and rejects later streams', async () => {
  const fixture = base();
  let closed = 0;
  fixture.openSession = async () => ({
    run: async (_input, ctx) => {
      await ctx.emit({ type: 'delta', text: 'held' });
      await ctx.emit({ type: 'completed' });
    },
    close: async () => {
      closed++;
    },
  });
  const ctx = await boot(fixture);
  const adapter = new EngineModelProvider(ctx.engines, 'chosen', 'provider');
  const iterator = adapter.stream(input());
  await iterator.next();
  expect(adapter.resourceCount()).toBe(1);
  await adapter.close();
  expect(closed).toBe(1);
  expect(adapter.resourceCount()).toBe(0);
  await expect(adapter.stream(input()).next()).rejects.toThrow('CLOSED');
  await iterator.return(undefined);
});
it('holds adapter ownership through a canceled late allocation and actual delayed close', async () => {
  const fixture = base();
  let finishOpen!: () => void;
  let finishClose!: () => void;
  let entered = false;
  let closing = false;
  const allocation = new Promise<void>((resolve) => {
    finishOpen = resolve;
  });
  const closure = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  fixture.openSession = async () => {
    entered = true;
    await allocation;
    return {
      run: async () => {},
      close: async () => {
        closing = true;
        await closure;
      },
    };
  };
  const ctx = await boot(fixture);
  const adapter = new EngineModelProvider(ctx.engines, 'chosen', 'provider');
  const iterator = adapter.stream(input());
  const first = iterator.next();
  void first.catch(() => {});
  await vi.waitFor(() => expect(entered).toBe(true));
  let closed = false;
  const close = adapter.close().then(() => {
    closed = true;
  });
  expect(adapter.resourceCount()).toBe(1);
  finishOpen();
  await vi.waitFor(() => expect(closing).toBe(true));
  expect(closed).toBe(false);
  expect(adapter.resourceCount()).toBe(1);
  finishClose();
  await close;
  await expect(first).rejects.toThrow('CANCELLED');
  expect(adapter.resourceCount()).toBe(0);
});
