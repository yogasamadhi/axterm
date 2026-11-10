import type { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import { RemoteError, type RemoteResult } from '@axterm/plugin-api';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
import type {
  PluginCommandInput,
  PluginCommandReceipt,
  PluginCommandOutcome,
  PluginManagementUpdate,
} from '@axterm/plugin-api/plugins';
import { PluginsModel } from '../../packages/plugins/plugins/src/client/model.ts';

const input: PluginCommandInput = {
  operation: 'install',
  spec: '@fixture/plugin@1.0.0',
  enabled: true,
  replace: false,
};
const baseline = (): PluginManagementUpdate => ({
  type: 'baseline',
  cursor: 0,
  snapshot: {
    generation: 'host-generation',
    inventory: { packages: [], entries: [], builds: [], transactions: [] },
    commands: [],
  },
});
function waitForAbort(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
function fixture() {
  let frames = [baseline()];
  const submit = vi.fn(
    async (
      id: string,
      generation: string,
      _input: PluginCommandInput,
      _signal?: AbortSignal,
    ): Promise<RemoteResult<PluginCommandReceipt>> => {
      const now = new Date().toISOString();
      return {
        ok: true,
        value: {
          id,
          generation,
          operation: 'install',
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      };
    },
  );
  const outcome = vi.fn(
    async (_id: string, _signal?: AbortSignal): Promise<RemoteResult<PluginCommandOutcome>> => ({
      ok: true,
      value: { status: 'missing' },
    }),
  );
  const watch = vi.fn(async function* (signal: AbortSignal) {
    for (const frame of frames) yield frame;
    await waitForAbort(signal);
  });
  const model = new PluginsModel({
    remote: {
      $stream: (options: RemoteStreamOptions<PluginManagementUpdate>) =>
        new RemoteStream(
          { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
          options,
        ),
      plugins: {
        watchPlugins: watch,
        executePluginCommand: submit,
        getPluginCommandOutcome: outcome,
      },
    },
  } as unknown as Context);
  return {
    model,
    submit,
    outcome,
    watch,
    frames: (next: PluginManagementUpdate[]) => {
      frames = next;
    },
  };
}
it('queries an accepted command after a lost ACK and never repeats the mutation', async () => {
  const f = fixture();
  try {
    await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
    let accepted: PluginCommandReceipt;
    f.submit.mockImplementation(async (id, generation) => {
      const now = new Date().toISOString();
      accepted = {
        id,
        generation,
        operation: 'install',
        status: 'completed',
        result: { changed: true, application: 'applied' },
        createdAt: now,
        updatedAt: now,
      };
      throw new Error('Lost ACK after durable reservation');
    });
    f.outcome.mockImplementation(async (id) => ({
      ok: true,
      value: { status: 'known', receipt: { ...accepted!, id } },
    }));
    const receipt = await f.model.execute(input);
    expect(receipt.status).toBe('completed');
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.outcome).toHaveBeenCalledExactlyOnceWith(receipt.id, expect.any(AbortSignal));
  } finally {
    await f.model.close();
  }
});
it('rejects invalid package paths locally and does not poll or consume capacity for a definitive refusal', async () => {
  const f = fixture();
  try {
    await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
    await expect(f.model.execute({ ...input, spec: '/arbitrary/host/file.tgz' })).rejects.toThrow();
    expect(f.submit).not.toHaveBeenCalled();
    f.submit.mockResolvedValue({
      ok: false,
      error: new RemoteError('plugins/failure', 'Refused', { reason: 'permission' }),
    });
    for (let count = 0; count < 10; count++)
      await expect(f.model.execute(input)).rejects.toMatchObject({ code: 'plugins/failure' });
    expect(f.submit).toHaveBeenCalledTimes(10);
    expect(f.outcome).not.toHaveBeenCalled();
  } finally {
    await f.model.close();
  }
});
it('refuses a skipped cursor and recovers through a fresh baseline after explicit retry', async () => {
  const f = fixture();
  try {
    await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
    f.frames([baseline(), { ...baseline(), type: 'replace', cursor: 2 }]);
    await f.model.retry();
    await expect.poll(() => f.model.getSnapshot().status).toBe('error');
    f.frames([baseline()]);
    await f.model.retry();
    await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
    expect(f.submit).not.toHaveBeenCalled();
  } finally {
    await f.model.close();
  }
});
it('cancels outcome waits on disposal while leaving already-admitted work with the Host owner', async () => {
  const f = fixture();
  await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
  const pending = f.model.execute(input);
  const rejected = expect(pending).rejects.toThrow();
  await expect.poll(() => f.outcome.mock.calls.length).toBeGreaterThan(0);
  await f.model.close();
  await rejected;
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.submit.mock.calls[0]![3]!.aborted).toBe(true);
  await expect(f.model.execute(input)).rejects.toThrow('CLOSED');
});
it('cancels a cross-plugin caller wait while the owning model continues readonly reconciliation', async () => {
  const f = fixture(),
    caller = new AbortController();
  try {
    await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
    const already = new AbortController();
    already.abort();
    await expect(f.model.execute(input, already.signal)).rejects.toThrow('WAIT_CANCELLED');
    expect(f.submit).not.toHaveBeenCalled();
    const waiting = f.model.execute(input, caller.signal);
    const rejected = expect(waiting).rejects.toThrow('WAIT_CANCELLED');
    await expect.poll(() => f.outcome.mock.calls.length).toBeGreaterThan(0);
    caller.abort();
    await rejected;
    const before = f.outcome.mock.calls.length;
    await expect.poll(() => f.outcome.mock.calls.length, { timeout: 1500 }).toBeGreaterThan(before);
    expect(f.submit).toHaveBeenCalledTimes(1);
  } finally {
    await f.model.close();
  }
});
