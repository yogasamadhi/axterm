import { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import DesktopTasks from '../../packages/plugins/desktop/src/tasks.ts';
it('pairs caller/provider lifetime, retains closing tasks until their owner drains, and rejects duplicate owners', async () => {
  const root = new Context();
  const provider = root.plugin(DesktopTasks);
  await provider;
  const drain = Promise.withResolvers<void>();
  const dispose = vi.fn(() => drain.promise);
  const caller = root.plugin({
    inject: ['desktopTaskInspection'],
    apply(ctx) {
      ctx.desktopTaskInspection.register('terminals', {
        inspect: () => ({ active: true }),
        dispose,
      });
    },
  });
  await caller;
  expect(await root.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
    active: true,
  });
  expect(() =>
    root.desktopTaskInspection.register('terminals', {
      inspect: () => ({ active: false }),
      dispose: () => {},
    }),
  ).toThrow('DUPLICATE');
  const closing = caller.dispose();
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  expect(await root.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
    active: true,
  });
  drain.resolve();
  await closing;
  expect(await root.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
    active: false,
  });
  const cached = root.desktopTaskInspection;
  await provider.dispose();
  expect(() =>
    cached.register('later', { inspect: () => ({ active: false }), dispose: () => {} }),
  ).toThrow();
  await root.fiber.dispose();
});
it('fails closed on contributor errors, cancellation and changes during an inspection', async () => {
  const root = new Context();
  await root.plugin(DesktopTasks);
  let inspect = () => Promise.resolve({ active: false });
  const dispose = root.desktopTaskInspection.register('fixture', {
    inspect: () => inspect(),
    dispose: () => {},
  });
  inspect = () => Promise.reject(new Error('PRIVATE_DATA'));
  await expect(root.desktopTaskInspection.inspect(new AbortController().signal)).rejects.toThrow(
    'DESKTOP_TASK_STATE_UNAVAILABLE',
  );
  const gate = Promise.withResolvers<{ active: boolean }>();
  inspect = () => gate.promise;
  const pending = root.desktopTaskInspection.inspect(new AbortController().signal);
  await dispose();
  gate.resolve({ active: false });
  await expect(pending).rejects.toThrow('DESKTOP_TASK_STATE_CHANGED');
  const abort = new AbortController();
  abort.abort();
  await expect(root.desktopTaskInspection.inspect(abort.signal)).rejects.toThrow();
  await root.fiber.dispose();
});
