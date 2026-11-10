import { expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import { ImportAutosaveGuard } from '../../packages/plugins/configuration/src/client/import-autosave.ts';
it('drains before IO and holds applied or unknown settings until restart', async () => {
  let admit!: () => void;
  const barrier = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const release = vi.fn(),
    pause = vi.fn(async () => {
      await barrier;
      return release;
    }),
    io = vi.fn(async () => ({ settings: 'applied' as const }));
  const guard = new ImportAutosaveGuard(() => ({ pause })),
    task = guard.run('one', 'generation', () => true, io);
  await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
  expect(io).not.toHaveBeenCalled();
  expect(() => guard.run('one', 'generation', () => true, io)).toThrow('UNAVAILABLE');
  admit();
  await task;
  expect(io).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  await guard.close();
  expect(release).toHaveBeenCalledOnce();
});
it('keeps the same pause for an unknown reply and explicit receipt retry', async () => {
  const release = vi.fn(),
    pause = vi.fn(async () => release),
    guard = new ImportAutosaveGuard(() => ({ pause }));
  await expect(
    guard.run(
      'one',
      'generation',
      () => true,
      async () => {
        throw Error('reply lost');
      },
    ),
  ).rejects.toThrow('lost');
  expect(release).not.toHaveBeenCalled();
  await guard.run(
    'one',
    'generation',
    () => true,
    async () => ({ result: { settings: 'applied' as const } }),
  );
  expect(pause).toHaveBeenCalledOnce();
  await guard.close();
  expect(release).toHaveBeenCalledOnce();
});
it('releases preserved settings and a definite uncommitted refusal', async () => {
  const release = vi.fn(),
    guard = new ImportAutosaveGuard(() => ({ pause: async () => release }));
  await guard.run(
    'one',
    'generation',
    () => true,
    async () => ({ settings: 'preserved' as const }),
  );
  expect(release).toHaveBeenCalledTimes(1);
  await expect(
    guard.run(
      'two',
      'generation',
      () => true,
      async () => {
        throw new RemoteError('configuration/portable-failure', 'rejected', { reason: 'stale' });
      },
    ),
  ).rejects.toMatchObject({ code: 'configuration/portable-failure' });
  expect(release).toHaveBeenCalledTimes(2);
  await guard.close();
  expect(release).toHaveBeenCalledTimes(2);
});
it('rejects a retired generation after acquiring the actual barrier and bounds retained unknowns', async () => {
  const release = vi.fn(),
    guard = new ImportAutosaveGuard(() => ({ pause: async () => release })),
    io = vi.fn(async () => ({ settings: 'applied' as const }));
  await expect(guard.run('retired', 'old', () => false, io)).rejects.toThrow('RETIRED');
  expect(io).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  for (let n = 0; n < 8; n++)
    await expect(
      guard.run(
        String(n),
        'current',
        () => true,
        async () => {
          throw Error('unknown');
        },
      ),
    ).rejects.toThrow('unknown');
  expect(() => guard.run('overflow', 'current', () => true, io)).toThrow('CAPACITY');
  await guard.close();
  expect(release).toHaveBeenCalledTimes(9);
});
