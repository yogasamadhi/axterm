import { expect, it } from 'vitest';
import {
  StreamInbox,
  ClientUplinkQueue,
} from '../../packages/infra/gateway/src/client/stream-client.ts';
import { RemoteEventQueue } from '../../packages/infra/gateway/src/index.ts';
import {
  MAX_REMOTE_BUFFER_BYTES,
  MAX_REMOTE_QUEUED_FRAMES,
} from '../../packages/api/plugin-api/src/stream-protocol.ts';

it.each(['bytes', 'frames'] as const)(
  'fails and discards a stalled Client downlink by %s, then rejects later frames',
  async (kind) => {
    const inbox = new StreamInbox();
    const frame = {
      type: 'item',
      streamId: 'fixture',
      value: kind === 'bytes' ? 'x'.repeat(MAX_REMOTE_BUFFER_BYTES) : null,
    } as const;
    if (kind === 'frames')
      for (let i = 0; i < MAX_REMOTE_QUEUED_FRAMES; i++) expect(inbox.push(frame)).toBe(true);
    expect(inbox.push(frame)).toBe(false);
    expect(inbox.push(frame)).toBe(false);
    await expect(inbox.next()).rejects.toThrow('receive budget exceeded');
  },
);

it.each(['bytes', 'frames'] as const)(
  'terminates overflowing Client uplinks by %s without replaying queued items',
  async (kind) => {
    const queue = new ClientUplinkQueue('fixture/follow');
    const item = kind === 'bytes' ? 'x'.repeat(MAX_REMOTE_BUFFER_BYTES) : null;
    if (kind === 'frames') for (let i = 0; i < MAX_REMOTE_QUEUED_FRAMES; i++) queue.push(item);
    expect(() => queue.push(item)).toThrow('send budget exceeded');
    await expect(queue.next()).rejects.toMatchObject({ code: 'gateway/uplink-overflow' });
    expect(() => queue.push(null)).toThrow('terminated');
  },
);

it('reclaims Client queue budgets after reads and wakes blocked readers', async () => {
  const queue = new ClientUplinkQueue('fixture/follow');
  const inbox = new StreamInbox();
  for (let i = 0; i < MAX_REMOTE_QUEUED_FRAMES * 2; i++) {
    queue.push(i);
    expect(await queue.next()).toEqual({ done: false, value: i });
    expect(inbox.push({ type: 'item', streamId: 'fixture', value: i })).toBe(true);
    expect(await inbox.next()).toMatchObject({ value: i });
  }
  const next = inbox.next();
  inbox.fail(new Error('disposed'));
  await expect(next).rejects.toThrow('disposed');
  queue.end();
  expect(await queue.next()).toEqual({ done: true, value: undefined });
});

it('fails an overflowing Host event generation and clears stale events on abort', async () => {
  const queue = new RemoteEventQueue();
  for (let i = 0; i <= MAX_REMOTE_QUEUED_FRAMES; i++)
    queue.push({ type: 'emit', event: 'fixture/update', args: [i] });
  const iterator = queue.iterate(new AbortController().signal);
  await expect(iterator.next()).rejects.toThrow('receive budget exceeded');
  const cancelled = new RemoteEventQueue();
  cancelled.push({ type: 'emit', event: 'fixture/update', args: ['stale'] });
  const abort = new AbortController();
  abort.abort();
  expect(await cancelled.iterate(abort.signal).next()).toEqual({ done: true, value: undefined });
});
