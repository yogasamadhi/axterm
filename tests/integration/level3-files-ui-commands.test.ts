import { expect, it, vi } from 'vitest';
import { FilesUiCommands } from '../../packages/plugins/files/src/client/ui/commands.ts';
import { TransferGrantHandoffs } from '../../packages/plugins/files/src/client/ui/transfer-grants.ts';
import type { FileGrantsModel } from '../../packages/plugins/files/src/client/index.ts';
import type { TransferClientActions, Transfer } from '@axterm/plugin-api/transfers';
const generation = crypto.randomUUID();
const receipt = (id: string) => ({ id, operation: 'test', cursor: 1, changedCount: 1 });
function files() {
  return {
    getSnapshot: () => ({ status: 'ready', baseline: { generation, grants: [], cursor: 0 } }),
    getFileOperationOutcome: vi.fn(),
    revokeInGeneration: vi.fn(async () => {}),
  } as unknown as FileGrantsModel;
}
it('checks lost acknowledgements without replay and explicitly retries only the captured key', async () => {
  const model = files(),
    abort = new AbortController(),
    commands = new FilesUiCommands(model, abort.signal),
    perform = vi.fn(async (_key: string) => {
      throw Error('LOST_ACK');
    });
  await expect(commands.file(perform)).rejects.toThrow('LOST_ACK');
  const id = commands.getSnapshot()[0]!.id;
  vi.mocked(model.getFileOperationOutcome).mockResolvedValue({
    status: 'completed',
    id,
    generation,
    operation: 'test',
    receipt: receipt(id),
  });
  expect(await commands.retry(id)).toEqual(receipt(id));
  expect(perform).toHaveBeenCalledOnce();
  expect(commands.getSnapshot()).toEqual([]);
  const next = vi.fn(async (key) => {
    if (next.mock.calls.length === 1) throw Error('LOST_BEFORE_ADMISSION');
    return receipt(key);
  });
  await expect(commands.file(next)).rejects.toThrow();
  const key = commands.getSnapshot()[0]!.id;
  vi.mocked(model.getFileOperationOutcome).mockResolvedValue({ status: 'missing', id: key });
  expect(await commands.retry(key)).toEqual(receipt(key));
  expect(next.mock.calls.map((call) => call[0])).toEqual([key, key]);
  await commands.close();
});
it('does not treat missing acknowledgement as proof of disposal', async () => {
  const model = files(),
    commands = new FilesUiCommands(model, new AbortController().signal);
  await expect(
    commands.file(async () => {
      throw Error('LOST_ACK');
    }),
  ).rejects.toThrow();
  const id = commands.getSnapshot()[0]!.id;
  vi.mocked(model.getFileOperationOutcome).mockResolvedValue({ status: 'missing', id });
  await expect(commands.close()).rejects.toThrow('UNDRAINED');
});
it('keeps an active transfer grant after tab release and revokes it only after terminal facts', async () => {
  const model = files(),
    now = new Date().toISOString();
  let transfer: Transfer = {
    id: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    direction: 'upload',
    state: 'running',
    bytesTransferred: 0,
    createdAt: now,
    updatedAt: now,
  };
  const callbacks = new Set<() => void>(),
    transfers = {
      subscribe: (fn: () => void) => {
        callbacks.add(fn);
        return () => callbacks.delete(fn);
      },
      getSnapshot: () => ({ status: 'ready', baseline: { generation, items: [transfer] } }),
      create: vi.fn(async () => transfer),
      get: vi.fn(async () => transfer),
      cancel: vi.fn(async () => {}),
      getCommandOutcome: vi.fn(),
    } as unknown as TransferClientActions;
  const handoff = new TransferGrantHandoffs(model, transfers);
  try {
    await handoff.create(crypto.randomUUID(), {
      direction: 'upload',
      target: { protocol: 'sftp', connectionId: transfer.connectionId },
      grantId: 'directory',
      remotePath: '/file',
    });
    await handoff.release('directory', generation);
    expect(model.revokeInGeneration).not.toHaveBeenCalled();
    transfer = { ...transfer, state: 'succeeded' };
    for (const fn of callbacks) fn();
    await vi.waitFor(() =>
      expect(model.revokeInGeneration).toHaveBeenCalledExactlyOnceWith('directory', generation),
    );
  } finally {
    await handoff.close();
  }
  expect(callbacks.size).toBe(0);
});
it('retains an uncertain transfer acceptance and refuses to discard its grant', async () => {
  const model = files(),
    transfers = {
      subscribe: () => () => {},
      getSnapshot: () => ({ status: 'ready', baseline: { generation, items: [] } }),
      create: vi.fn(async () => {
        throw Error('LOST_ACK');
      }),
      getCommandOutcome: vi.fn(async () => ({ status: 'missing' })),
    } as unknown as TransferClientActions;
  const handoff = new TransferGrantHandoffs(model, transfers);
  await expect(
    handoff.create(crypto.randomUUID(), {
      direction: 'upload',
      target: { protocol: 'sftp', connectionId: crypto.randomUUID() },
      grantId: 'copy',
      remotePath: '/file',
    }),
  ).rejects.toThrow();
  await handoff.release('copy', generation);
  expect(model.revokeInGeneration).not.toHaveBeenCalled();
  await expect(handoff.close()).rejects.toThrow('UNCERTAIN');
  expect(handoff.resourceCount()).toBeGreaterThan(0);
});

it('retains old generation handoffs and refuses replacement Host cleanup', async () => {
  const model = files(),
    next = crypto.randomUUID();
  const transfer = { id: crypto.randomUUID(), state: 'running' } as Transfer;
  const transfers = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', baseline: { generation, items: [transfer] } }),
    create: vi.fn(async () => transfer),
    get: vi.fn(async () => transfer),
    cancel: vi.fn(),
  } as unknown as TransferClientActions;
  const handoff = new TransferGrantHandoffs(model, transfers);
  await handoff.create(crypto.randomUUID(), {
    direction: 'upload',
    target: { protocol: 'sftp', connectionId: crypto.randomUUID() },
    grantId: 'retired',
    remotePath: '/file',
  });
  vi.spyOn(model, 'getSnapshot').mockReturnValue({
    status: 'ready',
    baseline: { generation: next, cursor: 0, grants: [] },
  });
  await expect(handoff.close()).rejects.toThrow('GENERATION_CHANGED');
  expect(model.revokeInGeneration).not.toHaveBeenCalled();
  expect(transfers.cancel).not.toHaveBeenCalled();
  expect(transfers.get).not.toHaveBeenCalled();
  expect(handoff.resourceCount()).toBe(1);
});

it('retries actual failed revocation without dropping the owned grant or replaying transfer creation', async () => {
  const model = files();
  vi.mocked(model.revokeInGeneration).mockRejectedValueOnce(Error('TEMPORARY_IO'));
  let transfer = { id: crypto.randomUUID(), state: 'running' } as Transfer;
  const transfers = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', baseline: { generation, items: [transfer] } }),
    create: vi.fn(async () => transfer),
    get: vi.fn(async () => transfer),
  } as unknown as TransferClientActions;
  const handoff = new TransferGrantHandoffs(model, transfers);
  try {
    await handoff.create(crypto.randomUUID(), {
      direction: 'upload',
      target: { protocol: 'sftp', connectionId: crypto.randomUUID() },
      grantId: 'retry',
      remotePath: '/file',
    });
    await handoff.release('retry', generation);
    transfer = { ...transfer, state: 'succeeded' };
    await expect(handoff.release('retry', generation)).rejects.toThrow('TEMPORARY_IO');
    expect(handoff.resourceCount()).toBe(1);
    await handoff.release('retry', generation);
    expect(handoff.resourceCount()).toBe(0);
    expect(model.revokeInGeneration).toHaveBeenCalledTimes(2);
    expect(transfers.create).toHaveBeenCalledOnce();
  } finally {
    await handoff.close();
  }
});

it.each(['accepted', 'generation-changed', 'traversal'] as const)(
  'resolves terminal home children through Files before transfer admission: %s',
  async (mode) => {
    let currentGeneration = generation;
    const model = files();
    model.getSnapshot = () => ({
      status: 'ready',
      baseline: { generation: currentGeneration, grants: [], cursor: 0 },
    });
    model.getRemoteHome = vi.fn(async () => {
      if (mode === 'generation-changed') currentGeneration = crypto.randomUUID();
      return { path: '/home/operator/' };
    });
    const now = new Date().toISOString();
    const transfer: Transfer = {
      id: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
      direction: 'upload',
      state: 'succeeded',
      bytesTransferred: 0,
      createdAt: now,
      updatedAt: now,
    };
    const transfers = {
      subscribe: () => () => {},
      getSnapshot: () => ({
        status: 'ready',
        baseline: { generation: currentGeneration, items: [transfer] },
      }),
      create: vi.fn(async () => transfer),
      get: vi.fn(async () => transfer),
    } as unknown as TransferClientActions;
    const handoff = new TransferGrantHandoffs(model, transfers);
    const key = crypto.randomUUID();
    const input = {
      direction: 'upload' as const,
      target: { protocol: 'sftp' as const, connectionId: transfer.connectionId },
      grantId: crypto.randomUUID(),
      remotePath: mode === 'traversal' ? './../escape' : './terminal file.txt',
      recursive: false,
      conflict: 'skip' as const,
    };
    try {
      if (mode === 'accepted') {
        await expect(handoff.create(key, input)).resolves.toEqual(transfer);
        expect(transfers.create).toHaveBeenCalledExactlyOnceWith(key, {
          ...input,
          remotePath: '/home/operator/terminal file.txt',
        });
        expect(input.remotePath).toBe('./terminal file.txt');
      } else {
        await expect(handoff.create(key, input)).rejects.toThrow(
          mode === 'traversal' ? 'FILES_HANDOFF_INVALID_PATH' : 'FILES_HANDOFF_GENERATION_CHANGED',
        );
        expect(transfers.create).not.toHaveBeenCalled();
      }
      expect(model.getRemoteHome).toHaveBeenCalledTimes(mode === 'traversal' ? 0 : 1);
    } finally {
      await handoff.close();
    }
  },
);
