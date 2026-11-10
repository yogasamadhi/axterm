import { expect, it, vi } from 'vitest';
import type { ConnectionsState } from '../../packages/plugins/connections/src/client/index.ts';
import { InteractionResponses } from '../../packages/plugins/connections/src/client/ui/response-owner.ts';
const initial = (): ConnectionsState => ({
  status: 'ready',
  baseline: {
    generation: crypto.randomUUID(),
    cursor: 0,
    revision: 0,
    connections: [],
    ftpConnections: [],
    knownHosts: [],
    tunnelProfiles: [],
    tunnels: [],
    interactions: Array.from({ length: 9 }, () => ({
      id: crypto.randomUUID(),
      kind: 'temporarySecret',
      severity: 'warning',
      title: 'Transient answer',
      detail: '',
      fields: [],
      createdAt: new Date().toISOString(),
    })),
  },
});
it('submits one copied response, refuses duplicates and joins the actual accepted response on close', async () => {
  const state = initial();
  if (state.status !== 'ready') throw new Error('fixture');
  const completion = Promise.withResolvers<void>();
  const respondInteraction = vi.fn(() => completion.promise);
  const owner = new InteractionResponses({ getSnapshot: () => state, respondInteraction });
  const values = { password: 'TRANSIENT_CANARY' };
  const command = owner.respond(state.baseline.generation, state.baseline.interactions[0]!.id, {
    accepted: true,
    values,
  });
  values.password = 'CHANGED_AFTER_ADMISSION';
  await expect(
    owner.respond(state.baseline.generation, state.baseline.interactions[0]!.id, {
      accepted: true,
    }),
  ).rejects.toThrow('PENDING');
  const close = owner.dispose();
  expect(owner.dispose()).toBe(close);
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(respondInteraction).toHaveBeenCalledExactlyOnceWith(state.baseline.interactions[0]!.id, {
    accepted: true,
    values: { password: 'TRANSIENT_CANARY' },
  });
  await expect(
    owner.respond(state.baseline.generation, state.baseline.interactions[1]!.id, {
      accepted: false,
    }),
  ).rejects.toThrow('CLOSED');
  completion.resolve();
  await command;
  await close;
  expect(closed).toBe(true);
});
it('withdraws an answer when its generation or challenge retires before actual submission, without replay', async () => {
  let state = initial();
  if (state.status !== 'ready') throw new Error('fixture');
  const original = state.baseline;
  const respondInteraction = vi.fn(async () => {});
  const owner = new InteractionResponses({ getSnapshot: () => state, respondInteraction });
  const command = owner.respond(original.generation, original.interactions[0]!.id, {
    accepted: true,
  });
  state = { status: 'connecting' };
  await expect(command).rejects.toThrow('RETIRED');
  state = { status: 'ready', baseline: { ...original, generation: crypto.randomUUID() } };
  await expect(
    owner.respond(original.generation, original.interactions[0]!.id, { accepted: true }),
  ).rejects.toThrow('RETIRED');
  state = { status: 'ready', baseline: { ...original, interactions: [] } };
  await expect(
    owner.respond(original.generation, original.interactions[0]!.id, { accepted: true }),
  ).rejects.toThrow('RETIRED');
  expect(respondInteraction).not.toHaveBeenCalled();
  await owner.dispose();
});
it('bounds concurrent accepted responses and drains transport rejection without retrying it', async () => {
  const state = initial();
  if (state.status !== 'ready') throw new Error('fixture');
  const completion = Promise.withResolvers<void>();
  const respondInteraction = vi.fn(() => completion.promise);
  const owner = new InteractionResponses({ getSnapshot: () => state, respondInteraction });
  const commands = state.baseline.interactions
    .slice(0, 8)
    .map((interaction) =>
      owner.respond(state.baseline.generation, interaction.id, { accepted: false }),
    );
  const settled = Promise.allSettled(commands);
  await expect(
    owner.respond(state.baseline.generation, state.baseline.interactions[8]!.id, {
      accepted: false,
    }),
  ).rejects.toThrow('CAPACITY');
  const close = owner.dispose();
  completion.reject(new Error('Controlled transport failure'));
  expect((await settled).every((value) => value.status === 'rejected')).toBe(true);
  await close;
  expect(respondInteraction).toHaveBeenCalledTimes(8);
});
