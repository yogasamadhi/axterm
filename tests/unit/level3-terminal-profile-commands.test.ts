import { expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import { terminalProfileSchema, terminalProfileInputSchema } from '@axterm/plugin-api/terminals';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { TerminalFactsState } from '../../packages/plugins/terminals/src/client/facts.ts';
import { TerminalProfileCommands } from '../../packages/plugins/terminals/src/client/profiles/commands.ts';
function fixture() {
  let generation = crypto.randomUUID(),
    ready = true;
  const input = terminalProfileInputSchema.parse({ name: 'Terminal', shell: null, cwd: null });
  const profile = terminalProfileSchema.parse({
    ...input,
    id: crypto.randomUUID(),
    version: 8,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const create = vi.fn(async (_key: string, _input: unknown) => ({ ids: [profile.id], cursor: 2 }));
  const update = vi.fn(
    async (_key: string, _id: string, _input: unknown, _version: string | undefined) => ({
      ids: [profile.id],
      cursor: 2,
    }),
  );
  const remove = vi.fn(async (_key: string, _id: string, _version: string | undefined) => ({
    ids: [profile.id],
    cursor: 3,
  }));
  const model = {
    getSnapshot: () =>
      (ready
        ? { status: 'ready', baseline: { generation, profiles: [profile] } }
        : { status: 'connecting' }) as TerminalFactsState,
    createTerminalProfile: create,
    updateTerminalProfile: update,
    deleteTerminalProfile: remove,
  };
  const setDefault = vi.fn(async (_key: string, _id: string | null, _version: string) => ({
    version: 5,
    cursor: 4,
  }));
  const configuration = {
    getSnapshot: () => ({ status: 'ready', baseline: { generation, settings: { version: 4 } } }),
    setDefaultTerminalProfile: setDefault,
  } as unknown as ConfigurationClientActions;
  const commands = new TerminalProfileCommands(model, configuration);
  return {
    input,
    profile,
    create,
    update,
    remove,
    model,
    commands,
    setDefault,
    changeGeneration: () => {
      generation = crypto.randomUUID();
    },
    disconnect: () => {
      ready = false;
    },
  };
}
it('creates, edits and deletes profiles through Terminals with captured versions', async () => {
  const f = fixture();
  await f.commands.save(f.input);
  await f.commands.save({ ...f.input, name: 'Updated' }, f.profile);
  await f.commands.remove(f.profile);
  expect(f.create).toHaveBeenCalledWith(expect.any(String), f.input);
  expect(f.update).toHaveBeenCalledWith(
    expect.any(String),
    f.profile.id,
    expect.objectContaining({ name: 'Updated' }),
    '"v8"',
  );
  expect(f.remove).toHaveBeenCalledWith(expect.any(String), f.profile.id, '"v8"');
  expect(f.commands.getSnapshot().completed).toBe(3);
  await f.commands.close();
});
it('uses Configuration ownership and its captured version for default selection', async () => {
  const f = fixture();
  await f.commands.setDefault(f.profile.id);
  expect(f.setDefault).toHaveBeenCalledWith(expect.any(String), f.profile.id, '"v4"');
  expect(() => f.commands.setDefault('missing')).toThrow('TERMINAL_PROFILE_MISSING');
  await f.commands.setDefault(null);
  expect(f.setDefault).toHaveBeenLastCalledWith(expect.any(String), null, '"v4"');
  await f.commands.close();
});
it('retries uncertain writes with exactly the original key and payload', async () => {
  const f = fixture();
  f.update.mockRejectedValueOnce(new Error('lost ACK'));
  await f.commands.save(f.input, f.profile);
  expect(f.commands.getSnapshot().uncertain).toBe(true);
  expect(() => f.commands.save(f.input)).toThrow('TERMINAL_PROFILE_BUSY');
  await f.commands.retry();
  expect(f.update.mock.calls[0]).toEqual(f.update.mock.calls[1]);
  expect(f.commands.getSnapshot().uncertain).toBe(false);
  await f.commands.close();
});
it('reports definite version conflicts without keeping a replayable intent', async () => {
  const f = fixture();
  f.update.mockRejectedValueOnce(
    new RemoteError('terminals/failure', 'STALE', { reason: 'precondition-failed' }),
  );
  await f.commands.save(f.input, f.profile);
  expect(f.commands.getSnapshot()).toMatchObject({ failed: true, uncertain: false });
  expect(() => f.commands.retry()).toThrow('TERMINAL_PROFILE_NOT_UNCERTAIN');
  await f.commands.close();
});
it('does not send an old intent when generation changes before admission executes', async () => {
  const f = fixture();
  const pending = f.commands.save(f.input);
  f.changeGeneration();
  await pending;
  expect(f.create).not.toHaveBeenCalled();
  expect(f.commands.getSnapshot()).toMatchObject({ failed: true, uncertain: false });
  await f.commands.close();
});
it('does not replay an uncertain old generation and denies unresolved unload', async () => {
  const f = fixture();
  f.create.mockRejectedValueOnce(new Error('lost ACK'));
  await f.commands.save(f.input);
  f.changeGeneration();
  await f.commands.retry();
  expect(f.create).toHaveBeenCalledTimes(1);
  await f.commands.close();
  const disconnected = fixture();
  disconnected.create.mockRejectedValueOnce(new Error('lost ACK'));
  await disconnected.commands.save(disconnected.input);
  disconnected.disconnect();
  await expect(disconnected.commands.close()).rejects.toThrow('TERMINAL_PROFILE_DRAIN_UNCERTAIN');
});
it('joins an admitted command on disposal and rejects subsequent admissions', async () => {
  const f = fixture();
  let finish!: () => void;
  f.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ids: [f.profile.id], cursor: 2 });
      }),
  );
  const pending = f.commands.save(f.input);
  await Promise.resolve();
  const close = f.commands.close();
  expect(() => f.commands.save(f.input)).toThrow('TERMINAL_PROFILE_BUSY');
  finish();
  await pending;
  await close;
});
