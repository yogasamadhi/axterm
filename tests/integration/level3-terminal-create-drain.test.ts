import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { terminalSessionSchema, type TerminalSession } from '@axterm/plugin-api/terminals';
import type { OpenBookmarkTerminalInput } from '@axterm/plugin-api/host';
import DesktopTasks from '../../packages/plugins/desktop/src/tasks.ts';
import TerminalController from '../../packages/plugins/terminals/src/index.ts';
import LocalSubprocessRuntime from '../../packages/infra/subprocess-local/src/index.ts';

it('counts admitted creates before channels exist and joins their canceled late completion on unload', async () => {
  const ctx = new Context();
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  const requests: {
    input: OpenBookmarkTerminalInput;
    signal: AbortSignal;
    resolve(value: TerminalSession): void;
  }[] = [];
  ctx.provide('connections', {
    openBookmarkTerminal: (input: OpenBookmarkTerminalInput, signal: AbortSignal) =>
      new Promise<TerminalSession>((resolve) => requests.push({ input, signal, resolve })),
  });
  await ctx.plugin(DesktopTasks);
  await ctx.plugin(LocalSubprocessRuntime);
  await ctx.plugin(TerminalController, { shellArgs: [], env: {}, maxSessions: 2 });
  const owner = ctx.terminalController;
  const input = { kind: 'serial' as const, bookmarkId: randomUUID(), cols: 80, rows: 24 };
  await expect(
    owner.createTerminal(randomUUID(), randomUUID(), input, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'terminals/failure', details: { reason: 'stale' } });
  expect(requests).toHaveLength(0);
  const key = randomUUID(),
    bookmarkId = input.bookmarkId;
  const pending = [
    owner.createTerminal(ctx.runtimeIdentity.generation, key, input, new AbortController().signal),
    owner.createTerminal(
      ctx.runtimeIdentity.generation,
      randomUUID(),
      input,
      new AbortController().signal,
    ),
  ];
  pending.push(
    owner.createTerminal(
      ctx.runtimeIdentity.generation,
      key,
      { ...input },
      new AbortController().signal,
    ),
  );
  input.bookmarkId = randomUUID();
  const outcomes = Promise.allSettled(pending);
  let stopping: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.every((request) => request.input.bookmarkId === bookmarkId)).toBe(true);
    expect(owner.getTerminalCommandOutcome(ctx.runtimeIdentity.generation, key)).toEqual({
      status: 'pending',
    });
    await expect(
      owner.createTerminal(
        ctx.runtimeIdentity.generation,
        randomUUID(),
        input,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'terminals/failure',
      details: { reason: 'capacity' },
    });
    expect(owner.getTerminalCommandOutcome(ctx.runtimeIdentity.generation, randomUUID())).toEqual({
      status: 'missing',
    });
    expect(() => owner.getTerminalCommandOutcome(randomUUID(), randomUUID())).toThrow(
      'generation changed',
    );
    expect(ctx.terminals.resourceCount()).toBe(0);
    expect(await ctx.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: true,
    });
    let stopped = false;
    stopping = ctx.fiber.dispose().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(requests.every((request) => request.signal.aborted)).toBe(true));
    expect(stopped).toBe(false);
    for (const request of requests)
      request.resolve(
        terminalSessionSchema.parse({
          id: randomUUID(),
          kind: 'serial',
          bookmarkId: request.input.bookmarkId,
          title: 'Late fixture',
          state: 'ready',
          createdAt: new Date().toISOString(),
        }),
      );
    const ended = await outcomes;
    expect(
      ended.every(
        (result) =>
          result.status === 'rejected' &&
          result.reason.code === 'terminals/failure' &&
          result.reason.details.reason === 'cancelled',
      ),
    ).toBe(true);
    await stopping;
    expect(stopped).toBe(true);
  } finally {
    for (const request of requests)
      request.resolve(
        terminalSessionSchema.parse({
          id: randomUUID(),
          kind: 'serial',
          title: 'Cleanup',
          state: 'ready',
          createdAt: new Date().toISOString(),
        }),
      );
    await outcomes;
    await (stopping ?? ctx.fiber.dispose());
  }
});
