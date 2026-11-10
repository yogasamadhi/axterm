import { expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import type { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import { TerminalTransfers } from '../../packages/plugins/terminals/src/application/terminal-transfer.ts';
import type { TerminalTransferState } from '@axterm/plugin-api/terminals';
import type {
  TerminalTransferAdapter,
  TerminalTransferAdapterListener,
} from '../../packages/plugins/terminals/src/ports/terminal-transfer.ts';
import type { TerminalTransferStage } from '../../packages/plugins/terminals/src/ports/terminal-transfer-staging.ts';
function fixture() {
  const id = crypto.randomUUID(),
    states: TerminalTransferState[] = [];
  let listener: TerminalTransferAdapterListener | undefined;
  const adapter = {
    setListener: (value: TerminalTransferAdapterListener) => {
      listener = value;
    },
    receive: vi.fn(() => true),
    observeInput: vi.fn(),
    command: vi.fn(),
    close: vi.fn(),
    drain: vi.fn(async () => {}),
    resourceCount: () => 0,
    closeAll: vi.fn(async () => {}),
  } satisfies TerminalTransferAdapter;
  const abort = new AbortController(),
    stage = {
      signal: abort.signal,
      path: '/private/receive',
      name: 'copy',
      kind: 'directory',
      recordName: vi.fn((_name: string) => {}),
      publish: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } satisfies TerminalTransferStage;
  const staging = {
    prepare: vi.fn(async () => stage),
    resourceCount: () => 0,
    close: vi.fn(async () => {}),
  };
  const terminals = {
    get: vi.fn(() => ({ id })),
    writeRaw: vi.fn(),
    publishRawOutput: vi.fn(),
    setTransferState: (_id: string, state: TerminalTransferState) => states.push(state),
  } as unknown as TerminalService;
  const app = new TerminalTransfers(terminals, adapter, staging);
  return {
    id,
    app,
    adapter,
    stage,
    staging,
    states,
    abort,
    event: (event: string, rest: object = {}) =>
      listener!.onEvent(id, 'xmodem', { event, ...rest }),
  };
}
it('publishes terminal completion only after protocol drain, live Files publication and stage cleanup', async () => {
  const f = fixture(),
    publish = Promise.withResolvers<void>();
  f.stage.publish.mockImplementation(() => publish.promise);
  try {
    await f.app.perform(f.id, {
      action: 'start',
      protocol: 'xmodem',
      direction: 'download',
      grantId: 'selected',
    });
    f.event('file-size', { size: 12 });
    f.event('file-complete');
    await vi.waitFor(() => expect(f.stage.publish).toHaveBeenCalledOnce());
    expect(f.app.get(f.id)?.state).toBe('transferring');
    expect(f.stage.close).not.toHaveBeenCalled();
    publish.resolve();
    await vi.waitFor(() => expect(f.app.get(f.id)?.state).toBe('completed'));
    expect(f.stage.close).toHaveBeenCalledOnce();
    expect(f.app.get(f.id)?.transferredBytes).toBe(12);
  } finally {
    publish.resolve();
    await f.app.closeAll();
  }
});
it('publishes an honest failure and releases live authority when final destination publication fails', async () => {
  const f = fixture();
  f.stage.publish.mockRejectedValue(Error('DESTINATION_EXISTS'));
  try {
    await f.app.perform(f.id, {
      action: 'start',
      protocol: 'xmodem',
      direction: 'download',
      grantId: 'selected',
    });
    f.event('file-complete');
    await vi.waitFor(() =>
      expect(f.app.get(f.id)).toMatchObject({
        state: 'failed',
        errorCode: 'TRANSFER_PUBLICATION_FAILED',
      }),
    );
    expect(f.stage.close).toHaveBeenCalledOnce();
  } finally {
    await f.app.closeAll();
  }
});
it('joins a late selection result before completing cancel and does not dispatch late protocol commands', async () => {
  const f = fixture(),
    prepared = Promise.withResolvers<typeof f.stage>();
  f.staging.prepare.mockImplementation(() => prepared.promise);
  const selecting = f.app.perform(f.id, {
    action: 'start',
    protocol: 'xmodem',
    direction: 'download',
    grantId: 'selected',
  });
  await vi.waitFor(() => expect(f.staging.prepare).toHaveBeenCalledOnce());
  let canceled = false;
  const cancel = f.app.perform(f.id, { action: 'cancel' }).then(() => {
    canceled = true;
  });
  await Promise.resolve();
  expect(canceled).toBe(false);
  prepared.resolve(f.stage);
  await expect(selecting).rejects.toThrow();
  await cancel;
  expect(f.adapter.command).not.toHaveBeenCalled();
  expect(f.stage.close).toHaveBeenCalledOnce();
  await f.app.closeAll();
});
it('cancels a revoked Files authority and joins actual protocol cleanup before stage release', async () => {
  const f = fixture(),
    drained = Promise.withResolvers<void>();
  try {
    await f.app.perform(f.id, {
      action: 'start',
      protocol: 'xmodem',
      direction: 'download',
      grantId: 'selected',
    });
    f.adapter.drain.mockImplementation(() => drained.promise);
    f.abort.abort();
    await vi.waitFor(() => expect(f.adapter.drain).toHaveBeenCalled());
    expect(f.stage.close).not.toHaveBeenCalled();
    drained.resolve();
    await vi.waitFor(() => expect(f.stage.close).toHaveBeenCalledOnce());
    expect(f.app.get(f.id)?.state).toBe('failed');
  } finally {
    drained.resolve();
    await f.app.closeAll();
  }
});
it('retains failed engine cleanup and refuses to report the owner as drained', async () => {
  const f = fixture();
  await f.app.perform(f.id, {
    action: 'start',
    protocol: 'xmodem',
    direction: 'download',
    grantId: 'selected',
  });
  f.adapter.drain.mockRejectedValue(Error('ENGINE_STILL_ACTIVE'));
  await expect(f.app.perform(f.id, { action: 'cancel' })).rejects.toThrow('ENGINE_STILL_ACTIVE');
  expect(f.stage.close).not.toHaveBeenCalled();
  expect(f.app.resourceCount()).toBeGreaterThan(0);
  await expect(f.app.closeAll()).rejects.toThrow('UNDRAINED');
});

it('lets a confirmed protocol completion finish atomic publication after the peer naturally exits', async () => {
  const f = fixture(),
    published = Promise.withResolvers<void>();
  f.stage.publish.mockImplementation(() => published.promise);
  try {
    await f.app.perform(f.id, {
      action: 'start',
      protocol: 'xmodem',
      direction: 'download',
      grantId: 'selected',
    });
    f.event('file-complete');
    await vi.waitFor(() => expect(f.stage.publish).toHaveBeenCalledOnce());
    f.app.closed(f.id);
    expect(f.stage.close).not.toHaveBeenCalled();
    published.resolve();
    await vi.waitFor(() => expect(f.states.at(-1)?.state).toBe('completed'));
    expect(f.stage.close).toHaveBeenCalledOnce();
  } finally {
    published.resolve();
    await f.app.closeAll();
  }
});

it('requires the exact detected run for late selections and scoped cancellation', async () => {
  const f = fixture();
  try {
    f.app.onEvent(f.id, 'zmodem', { event: 'receive-start' });
    const run = f.states.at(-1)!.runId!;
    await expect(
      f.app.perform(f.id, {
        action: 'provide-selection',
        protocol: 'zmodem',
        runId: crypto.randomUUID(),
        grantId: 'selected',
      }),
    ).rejects.toThrow();
    expect(f.staging.prepare).not.toHaveBeenCalled();
    await expect(
      f.app.perform(f.id, { action: 'cancel', runId: crypto.randomUUID() }),
    ).rejects.toThrow();
    expect(f.app.get(f.id)?.state).toBe('waiting-selection');
    await f.app.perform(f.id, {
      action: 'provide-selection',
      protocol: 'zmodem',
      runId: run,
      grantId: 'selected',
    });
    expect(f.staging.prepare).toHaveBeenCalledOnce();
  } finally {
    await f.app.closeAll();
  }
});

it('retains the existing unsupported destination error after final owned Files publication and drains once', async () => {
  const f = fixture();
  f.stage.publish.mockRejectedValue(
    new RemoteError('files/failure', 'The authorized stream could not complete', {
      reason: 'unsupported-destination',
    }),
  );
  try {
    await f.app.perform(f.id, {
      action: 'start',
      protocol: 'xmodem',
      direction: 'download',
      grantId: 'selected',
    });
    f.event('file-complete');
    await vi.waitFor(() =>
      expect(f.app.get(f.id)).toMatchObject({
        state: 'failed',
        errorCode: 'TRANSFER_DESTINATION_UNSUPPORTED',
      }),
    );
    expect(f.stage.publish).toHaveBeenCalledOnce();
    expect(f.stage.close).toHaveBeenCalledOnce();
    expect(f.adapter.drain).toHaveBeenCalledOnce();
  } finally {
    await f.app.closeAll();
  }
});

it('routes the concrete protocol filename to its stage owner and drains metadata write failure without an uncontrolled callback exception', async () => {
  const f = fixture();
  f.stage.recordName.mockImplementation(() => {
    throw new Error('PRIVATE_METADATA_WRITE_CANARY');
  });
  try {
    await f.app.perform(f.id, {
      action: 'start',
      protocol: 'xmodem',
      direction: 'download',
      grantId: 'selected',
    });
    expect(() => f.event('file-start', { name: 'source.bin' })).not.toThrow();
    expect(f.stage.recordName).toHaveBeenCalledWith('source.bin');
    await vi.waitFor(() =>
      expect(f.app.get(f.id)).toMatchObject({
        state: 'failed',
        errorCode: 'TRANSFER_METADATA_FAILED',
      }),
    );
    expect(f.stage.close).toHaveBeenCalledOnce();
    expect(f.adapter.drain).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.app.get(f.id))).not.toContain('PRIVATE_METADATA_WRITE_CANARY');
  } finally {
    await f.app.closeAll();
  }
});
