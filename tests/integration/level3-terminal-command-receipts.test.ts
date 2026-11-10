import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { terminalSessionSchema } from '@axterm/plugin-api/terminals';
import { TerminalCreationCommands } from '../../packages/plugins/terminals/src/adapters/creation-commands.ts';
it('coalesces actual creation, retains uncertain outcomes and joins pending allocation before clearing metadata', async () => {
  const terminal = terminalSessionSchema.parse({
    id: randomUUID(),
    kind: 'local',
    title: 'Receipt fixture',
    state: 'ready',
    createdAt: new Date().toISOString(),
  });
  const pending = Promise.withResolvers<typeof terminal>();
  const owner = new TerminalCreationCommands(() => terminal);
  const apply = vi.fn(() => pending.promise);
  const key = randomUUID();
  const input = { environment: { PRIVATE_EXECUTION_INPUT: 'TRANSIENT_VALUE' } };
  const opening = owner.execute(key, 'create', input, apply);
  expect(owner.execute(key.toUpperCase(), 'create', input, apply)).toBe(opening);
  expect(owner.outcome(key)).toEqual({ status: 'pending' });
  expect(owner.outcome(randomUUID())).toEqual({ status: 'missing' });
  await expect(owner.execute(key, 'create', {}, apply)).rejects.toMatchObject({
    reason: 'conflict',
  });
  const failKey = randomUUID();
  const failure = vi.fn(() => {
    throw new Error('Unknown creation result');
  });
  await expect(owner.execute(failKey, 'create', {}, failure)).rejects.toThrow(
    'Unknown creation result',
  );
  expect(owner.outcome(failKey)).toEqual({ status: 'uncertain' });
  await expect(owner.execute(failKey, 'create', {}, failure)).rejects.toMatchObject({
    reason: 'unavailable',
  });
  expect(failure).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stop = owner.dispose().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(apply).toHaveBeenCalledTimes(1);
  pending.resolve(terminal);
  await opening;
  await stop;
  expect(stopped).toBe(true);
  await expect(owner.execute(randomUUID(), 'create', {}, apply)).rejects.toMatchObject({
    reason: 'closed',
  });
});
