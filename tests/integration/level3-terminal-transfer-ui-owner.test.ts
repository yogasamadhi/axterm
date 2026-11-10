import { expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import { terminalSessionSchema, type TerminalTransferState } from '@axterm/plugin-api/terminals';
import type { FileGrantActions } from '@axterm/plugin-api/files';
import type {
  TerminalsModel,
  TerminalsState,
} from '../../packages/plugins/terminals/src/client/index.ts';
import { TerminalTransferUiOwner } from '../../packages/plugins/terminals/src/client/transfer-owner.ts';
const id = crypto.randomUUID(),
  generation = crypto.randomUUID();
function fixture() {
  const listeners = new Set<() => void>();
  let transfer: TerminalTransferState | undefined,
    gen = generation;
  const model = {
    getSnapshot: () =>
      ({
        status: 'ready',
        baseline: {
          type: 'baseline',
          revision: 0,
          generation: gen,
          sessions: [
            terminalSessionSchema.parse({
              id,
              kind: 'local',
              title: 'Fixture',
              state: 'ready',
              createdAt: new Date().toISOString(),
              ...(transfer ? { transfer } : {}),
            }),
          ],
        },
      }) as TerminalsState,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    performTransfer: vi.fn(async () => transfer!),
  } as unknown as TerminalsModel;
  const grant = {
    grantId: 'selected',
    kind: 'directory' as const,
    name: 'Selected',
    permissions: ['read' as const, 'write' as const],
    createdAt: new Date().toISOString(),
  };
  const grants = {
    createInGeneration: vi.fn(async () => grant),
    revokeInGeneration: vi.fn(async () => {}),
  } as unknown as FileGrantActions;
  const owner = new TerminalTransferUiOwner(model, grants);
  return {
    model,
    grants,
    owner,
    grant,
    set(value: TerminalTransferState | undefined) {
      transfer = value;
      for (const fn of listeners) fn();
    },
    replace() {
      gen = crypto.randomUUID();
      for (const fn of listeners) fn();
    },
    listeners,
  };
}
const state = (
  runId: string = crypto.randomUUID(),
  status: TerminalTransferState['state'] = 'waiting-peer',
): TerminalTransferState => ({
  terminalId: id,
  runId,
  protocol: 'xmodem',
  direction: 'download',
  state: status,
  updatedAt: new Date().toISOString(),
});
it('keeps selected authority until accepted run terminal facts, ignoring an older completed baseline', async () => {
  const f = fixture(),
    accepted = state();
  f.set(state(crypto.randomUUID(), 'completed'));
  vi.mocked(f.model.performTransfer).mockResolvedValue(accepted);
  await f.owner.start(id, 'download');
  expect(f.grants.revokeInGeneration!).not.toHaveBeenCalled();
  f.set(state(crypto.randomUUID(), 'completed'));
  expect(f.grants.revokeInGeneration!).not.toHaveBeenCalled();
  f.set(state(accepted.runId, 'completed'));
  await vi.waitFor(() =>
    expect(f.grants.revokeInGeneration!).toHaveBeenCalledExactlyOnceWith('selected', generation),
  );
  await f.owner.close();
  expect(f.listeners.size).toBe(0);
});
it('retains an unknown admission and retries the exact key and captured action', async () => {
  const f = fixture(),
    accepted = state();
  vi.mocked(f.model.performTransfer)
    .mockRejectedValueOnce(Error('LOST_ACK'))
    .mockResolvedValue(accepted);
  await expect(f.owner.start(id, 'download')).rejects.toThrow('LOST_ACK');
  expect(f.grants.revokeInGeneration!).not.toHaveBeenCalled();
  expect(f.owner.getSnapshot().uncertain).toEqual([id]);
  const original = vi.mocked(f.model.performTransfer).mock.calls[0]!;
  await f.owner.retry(id);
  const retry = vi.mocked(f.model.performTransfer).mock.calls[1]!;
  expect(retry.slice(0, 3)).toEqual(original.slice(0, 3));
  f.set(state(accepted.runId, 'completed'));
  await vi.waitFor(() => expect(f.grants.revokeInGeneration!).toHaveBeenCalledOnce());
  await f.owner.close();
});
it('waits for late native selection during close and revokes it before reporting drained', async () => {
  const f = fixture(),
    selected = Promise.withResolvers<typeof f.grant>();
  vi.mocked(f.grants.createInGeneration!).mockImplementation(() => selected.promise);
  const choosing = f.owner.start(id, 'download');
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  selected.resolve(f.grant);
  await choosing;
  await closing;
  expect(f.grants.revokeInGeneration!).toHaveBeenCalledOnce();
  expect(f.model.performTransfer).not.toHaveBeenCalled();
});
it('does not revoke retired-generation authorities against the replacement Host', async () => {
  const f = fixture();
  vi.mocked(f.model.performTransfer).mockResolvedValue(state());
  await f.owner.start(id, 'download');
  f.replace();
  await expect(f.owner.close()).rejects.toThrow('UNDRAINED');
  expect(f.grants.revokeInGeneration!).not.toHaveBeenCalled();
});
it('refuses to report unresolved admission or failed native cleanup as drained', async () => {
  const f = fixture();
  vi.mocked(f.model.performTransfer).mockRejectedValue(Error('LOST_ACK'));
  await expect(f.owner.start(id, 'download')).rejects.toThrow();
  await expect(f.owner.close()).rejects.toThrow('UNDRAINED');
  expect(f.grants.revokeInGeneration!).not.toHaveBeenCalled();
  const g = fixture(),
    accepted = state();
  vi.mocked(g.model.performTransfer).mockResolvedValue(accepted);
  await g.owner.start(id, 'download');
  vi.mocked(g.grants.revokeInGeneration!).mockRejectedValue(Error('NATIVE_NOT_DRAINED'));
  g.set(state(accepted.runId, 'completed'));
  await vi.waitFor(() => expect(g.owner.getSnapshot().error).toBe(true));
  await expect(g.owner.close()).rejects.toThrow('UNDRAINED');
});

it('releases only its retired run when another window has already started a later transfer', async () => {
  const f = fixture(),
    accepted = state();
  vi.mocked(f.model.performTransfer).mockResolvedValueOnce(accepted);
  await f.owner.start(id, 'download');
  f.set(state());
  vi.mocked(f.model.performTransfer).mockRejectedValue(
    new RemoteError('terminals/failure', 'Run retired', { reason: 'invalid-input' }),
  );
  await f.owner.close();
  expect(vi.mocked(f.model.performTransfer).mock.calls[1]?.[2]).toEqual({
    action: 'cancel',
    runId: accepted.runId,
  });
  expect(f.grants.revokeInGeneration!).toHaveBeenCalledOnce();
});
