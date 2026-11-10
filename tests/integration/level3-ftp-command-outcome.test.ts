import { expect, it, vi } from 'vitest';
import { RuntimeCommands } from '../../packages/plugins/connections/src/adapters/runtime-commands.ts';
it('exposes the exact allocated FTP resource after failure without re-executing protocol IO', async () => {
  const id = crypto.randomUUID(),
    key = crypto.randomUUID(),
    commands = new RuntimeCommands(() => ({ id }), true),
    perform = vi.fn(async () => {
      commands.bindResource(key, id);
      throw Error('FTP_FAILURE_AFTER_ALLOCATION');
    });
  await expect(
    commands.execute(key, 'create', { bookmarkId: 'fixture' }, perform),
  ).rejects.toThrow();
  expect(commands.boundResourceOutcome(key)).toEqual({ status: 'accepted', id });
  await expect(
    commands.execute(key, 'create', { bookmarkId: 'fixture' }, perform),
  ).rejects.toThrow();
  expect(perform).toHaveBeenCalledOnce();
  await commands.dispose();
});
it('distinguishes a failed admission before allocation from pending and unknown outcomes', async () => {
  const commands = new RuntimeCommands((id) => ({ id }), true),
    key = crypto.randomUUID(),
    ready = Promise.withResolvers<void>();
  expect(commands.boundResourceOutcome(key)).toEqual({ status: 'missing' });
  const task = commands.execute(key, 'create', {}, async () => {
    await ready.promise;
    throw Error('NO_RESOURCE_ALLOCATED');
  });
  expect(commands.boundResourceOutcome(key)).toEqual({ status: 'pending' });
  ready.resolve();
  await expect(task).rejects.toThrow();
  expect(commands.boundResourceOutcome(key)).toEqual({ status: 'rejected' });
  await commands.dispose();
});
it('rejects unconfigured or conflicting resource association and changed intent keys', async () => {
  const unconfigured = new RuntimeCommands((id) => ({ id }));
  expect(() => unconfigured.bindResource(crypto.randomUUID(), 'resource')).toThrow();
  const commands = new RuntimeCommands((id) => ({ id }), true),
    key = crypto.randomUUID(),
    id = crypto.randomUUID();
  const first = commands.execute(key, 'create', { bookmarkId: 'one' }, async () => {
    commands.bindResource(key, id);
    expect(() => commands.bindResource(key, crypto.randomUUID())).toThrow('CONFLICT');
    return { id };
  });
  await first;
  await expect(
    commands.execute(key, 'create', { bookmarkId: 'two' }, async () => ({ id })),
  ).rejects.toThrow('CONFLICT');
  await commands.dispose();
  await unconfigured.dispose();
});
