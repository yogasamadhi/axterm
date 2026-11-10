import { expect, it, vi } from 'vitest';
import { TerminalTransferCommands } from '../../packages/plugins/terminals/src/adapters/terminal-transfer/commands.ts';
it('coalesces concurrent keys and rejects changed intents without a second protocol admission', async () => {
  const commands = new TerminalTransferCommands(),
    key = crypto.randomUUID(),
    done = Promise.withResolvers<{ accepted: true }>(),
    perform = vi.fn(() => done.promise);
  const first = commands.execute(key, { terminal: 'one', action: 'receive' }, perform),
    second = commands.execute(key, { terminal: 'one', action: 'receive' }, perform);
  expect(second).toBe(first);
  await expect(
    commands.execute(key, { terminal: 'two', action: 'receive' }, perform),
  ).rejects.toMatchObject({ details: { reason: 'conflict' } });
  done.resolve({ accepted: true });
  expect(await first).toEqual({ accepted: true });
  expect(perform).toHaveBeenCalledOnce();
  await commands.close();
});
it('never re-executes an uncertain failure and joins actual command completion on withdrawal', async () => {
  const commands = new TerminalTransferCommands(),
    key = crypto.randomUUID(),
    perform = vi.fn(async () => {
      throw Error('LOST_AFTER_ADMISSION');
    });
  await expect(commands.execute(key, { action: 'receive' }, perform)).rejects.toThrow(
    'LOST_AFTER_ADMISSION',
  );
  await expect(commands.execute(key, { action: 'receive' }, perform)).rejects.toThrow(
    'LOST_AFTER_ADMISSION',
  );
  expect(perform).toHaveBeenCalledOnce();
  const done = Promise.withResolvers<void>(),
    running = commands.execute(crypto.randomUUID(), { action: 'other' }, () => done.promise);
  await Promise.resolve();
  let closed = false;
  const closing = commands.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  done.resolve();
  await running;
  await closing;
  await expect(commands.execute(crypto.randomUUID(), {}, perform)).rejects.toMatchObject({
    details: { reason: 'closed' },
  });
});
