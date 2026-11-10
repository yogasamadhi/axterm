import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Transfer } from '@axterm/plugin-api/transfers';
import { TransferProgress } from '../../packages/plugins/transfers/src/progress.ts';
import { TransferControls } from '../../packages/plugins/transfers/src/adapters/runtime-controls.ts';
import { TransferSnapshotObservation } from '../../packages/plugins/transfers/src/observation.ts';
import { TransfersProjection } from '../../packages/plugins/transfers/src/client/projection.ts';
import type { Context } from '@deepseek-ai/cordis';
import { RemoteError } from '@axterm/plugin-api';
import { TransfersModel } from '../../packages/plugins/transfers/src/client/index.ts';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';

afterEach(() => vi.useRealTimers());
const fact = (): Transfer => ({
  id: randomUUID(),
  connectionId: randomUUID(),
  direction: 'upload',
  state: 'running',
  bytesTransferred: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

it('coalesces progress independently of durable cursors, retains unread updates and drains waiting followers', async () => {
  vi.useFakeTimers();
  const item = fact();
  const progress = new TransferProgress(randomUUID(), () => ({ items: [item], factCursor: 7 }));
  const stream = progress.watch(new AbortController().signal);
  try {
    expect((await stream.next()).value).toMatchObject({ revision: 0, factCursor: 7 });
    for (let index = 1; index <= 100; index++) {
      item.bytesTransferred = index;
      progress.publish('transfer.progress', item);
    }
    await vi.advanceTimersByTimeAsync(250);
    expect((await stream.next()).value).toMatchObject({
      revision: 1,
      factCursor: 7,
      items: [{ bytesTransferred: 100 }],
    });
    const pending = stream.next();
    await progress.close();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(() => progress.watch(new AbortController().signal)).toThrow('unavailable');
  } finally {
    await progress.close();
  }
});

it('limits progress followers, including unopened iterators, and releases their admission on return', async () => {
  const progress = new TransferProgress(randomUUID(), () => ({ items: [], factCursor: 0 }));
  const streams = Array.from({ length: 32 }, () => progress.watch(new AbortController().signal));
  expect(() => progress.watch(new AbortController().signal)).toThrow('unavailable');
  await streams[0]!.return!();
  await progress.watch(new AbortController().signal).return!();
  await progress.close();
});

it('publishes complete transfer facts atomically and advances frame revision separately from fact cursor', async () => {
  const item = fact();
  const observer = new TransferSnapshotObservation(randomUUID(), async () => ({
    items: [item],
    factCursor: 23,
    hasMore: false,
    limit: 500,
  }));
  const stream = observer.watch(new AbortController().signal);
  const projection = new TransfersProjection();
  try {
    let baseline;
    for (let index = 0; index < 10 && !baseline; index++) {
      const frame = await stream.next();
      expect(frame.done).toBe(false);
      baseline = projection.accept(frame.value!);
    }
    expect(baseline).toMatchObject({ revision: 0, factCursor: 23, items: [item] });
    expect(Object.isFrozen(baseline?.items[0])).toBe(true);
  } finally {
    await stream.return!();
    await observer.dispose();
  }
});

it('never reapplies a control nonce after a partial failure and rejects changed command identity', () => {
  const controls = new TransferControls();
  const key = randomUUID();
  const perform = vi.fn(() => {
    throw new Error('uncertain failure after mutation');
  });
  expect(() => controls.execute(key, 'pause', { id: 1 }, perform)).toThrow('uncertain');
  expect(() => controls.execute(key, 'pause', { id: 1 }, perform)).toThrow('uncertain');
  expect(perform).toHaveBeenCalledTimes(1);
  expect(() => controls.execute(key, 'resume', { id: 1 }, perform)).toThrow('identity changed');
  const success = randomUUID();
  const result = controls.execute(success, 'cancel', {}, () => ({ accepted: true }));
  result.accepted = false;
  expect(controls.execute(success, 'cancel', {}, perform)).toEqual({ accepted: true });
  controls.close();
  expect(() => controls.execute(success, 'cancel', {}, perform)).toThrow('closed');
});

it('recreates both model streams after a terminal failure and never exposes private error details', async () => {
  const generation = randomUUID();
  const facts = new TransferSnapshotObservation(generation, async () => ({
    items: [],
    factCursor: 0,
    hasMore: false,
    limit: 500,
  }));
  const progress = new TransferProgress(generation, () => ({ items: [], factCursor: 0 }));
  let failed = false;
  const mounted: RemoteStream<unknown>[] = [];
  const context = {
    remote: {
      $stream: <Item>(options: RemoteStreamOptions<Item>) => {
        const stream = new RemoteStream(
          { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
          options,
        );
        mounted.push(stream);
        return stream;
      },
      transfers: {
        watchTransfers: (signal: AbortSignal) => {
          if (!failed) {
            failed = true;
            throw new RemoteError('transfers/failure', 'PRIVATE_FIXTURE_ERROR', {
              reason: 'unavailable',
            });
          }
          return facts.watch(signal);
        },
        watchTransferProgress: (signal: AbortSignal) => progress.watch(signal),
      },
    },
  } as unknown as Context;
  const model = new TransfersModel(context);
  try {
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('error'));
    expect(JSON.stringify(model.getSnapshot())).not.toContain('PRIVATE_FIXTURE_ERROR');
    const retry = model.retry();
    expect(model.retry()).toBe(retry);
    await retry;
    await vi.waitFor(() =>
      expect(model.getSnapshot()).toMatchObject({
        status: 'ready',
        baseline: { generation, factCursor: 0, items: [] },
      }),
    );
    expect(mounted).toHaveLength(4);
  } finally {
    await model.dispose();
    await facts.dispose();
    await progress.close();
  }
  expect(() => model.retry()).toThrow('TRANSFERS_MODEL_CLOSED');
});
