import { expect, it, vi } from 'vitest';
import type { TerminalChannel, PtyPort } from '../ports/terminal-channel.ts';
import type {
  TerminalRecorderFactory,
  TerminalRecorder,
  TerminalRecordingWriterOptions,
} from '../ports/terminal-recording.ts';
import { TerminalService } from './terminal-service.ts';
import { TerminalObservation } from './terminal-observation.ts';
function fixture(
  recorders: TerminalRecorderFactory = {
    open: async () => {
      throw new Error('recording not selected');
    },
  },
  close = async () => {},
) {
  const exits = new Set<(code: number | null) => void>();
  const channel: TerminalChannel = {
    shellIntegrationKind: 'unsupported',
    write: vi.fn(),
    resize: vi.fn(),
    signal: vi.fn(),
    onData: () => () => {},
    onExit: (listener) => {
      exits.add(listener);
      return () => {
        exits.delete(listener);
      };
    },
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(close),
  };
  const port: PtyPort = { open: () => channel };
  return {
    service: new TerminalService(port, recorders, 1),
    channel,
    exit: () => {
      for (const listener of exits) listener(0);
    },
  };
}
it('holds closing native channels in task facts and capacity until their actual close completes', async () => {
  const gate = Promise.withResolvers<void>();
  const { service } = fixture(undefined, () => gate.promise);
  const observation = new TerminalObservation(service, 'generation-a');
  const updates = observation.watch(new AbortController().signal)[Symbol.asyncIterator]();
  expect((await updates.next()).value).toMatchObject({
    type: 'baseline',
    revision: 0,
    sessions: [],
  });
  const terminal = await service.createLocal({ cols: 80, rows: 24 });
  expect((await updates.next()).value).toMatchObject({
    type: 'upsert',
    revision: 1,
    session: { id: terminal.id },
  });
  const closing = service.close(terminal.id);
  expect((await updates.next()).value).toEqual({ type: 'remove', revision: 2, id: terminal.id });
  expect(service.resourceCount()).toBe(1);
  await expect(service.createLocal({ cols: 80, rows: 24 })).rejects.toThrow('capacity');
  gate.resolve();
  await closing;
  expect(service.resourceCount()).toBe(0);
  observation.dispose();
  await service.dispose();
  expect((await updates.next()).done).toBe(true);
});
it('cancels and drains a recording that opens while its terminal plugin unloads, rejecting duplicate opens', async () => {
  const opening = Promise.withResolvers<TerminalRecorder>();
  let options: TerminalRecordingWriterOptions | undefined;
  const { service, channel } = fixture({
    open: (input) => {
      options = input;
      return opening.promise;
    },
  });
  const terminal = await service.createLocal({ cols: 80, rows: 24 });
  const input = {
    path: 'owned-grant-fixture',
    fileName: 'fixture.log',
    timestamps: false,
    includeRecent: false,
  };
  const recording = service.startRecording(terminal.id, input);
  await expect(service.startRecording(terminal.id, input)).rejects.toThrow('already opening');
  const draining = service.dispose();
  expect(options?.signal?.aborted).toBe(true);
  await expect(service.createLocal({ cols: 80, rows: 24 })).rejects.toThrow('closing');
  const writer = { bytesWritten: 0, write: vi.fn(() => true), close: vi.fn(async () => {}) };
  opening.resolve(writer);
  await expect(recording).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
  await draining;
  expect(writer.close).toHaveBeenCalledOnce();
  expect(channel.close).toHaveBeenCalledOnce();
  expect(service.resourceCount()).toBe(0);
});
it('bounds metadata followers and queues, replaces complete baselines, and cleans never-read or pending iterators', async () => {
  const { service, exit } = fixture();
  const observation = new TerminalObservation(service, 'generation-b');
  const idle = observation.watch(new AbortController().signal)[Symbol.asyncIterator]();
  let terminal = await service.createLocal({ cols: 80, rows: 24 });
  for (let index = 0; index < 35; index++) {
    await service.close(terminal.id);
    terminal = await service.createLocal({ cols: 80, rows: 24 });
  }
  exit();
  await expect(idle.next()).rejects.toMatchObject({
    code: 'terminals/failure',
    details: { reason: 'capacity' },
  });
  const refreshed = observation.watch(new AbortController().signal)[Symbol.asyncIterator]();
  expect((await refreshed.next()).value).toMatchObject({
    type: 'baseline',
    generation: 'generation-b',
    sessions: [{ id: terminal.id, state: 'closed' }],
  });
  const pending = refreshed.next();
  const neverRead = Array.from({ length: 63 }, () =>
    observation.watch(new AbortController().signal),
  );
  expect(() => observation.watch(new AbortController().signal)).toThrow('capacity');
  observation.dispose();
  expect((await pending).done).toBe(true);
  for (const stream of neverRead)
    expect((await stream[Symbol.asyncIterator]().next()).done).toBe(true);
  await service.dispose();
});
it('closes the native channel even when a socket cleanup callback rejects', async () => {
  const { service, channel } = fixture();
  const terminal = await service.createLocal({ cols: 80, rows: 24 });
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: () => {},
    close: () => {
      throw new Error('PRIVATE_SOCKET_FAILURE');
    },
    on: () => {},
    off: () => {},
  };
  service.attach(terminal.id, socket);
  await expect(service.close(terminal.id)).rejects.toThrow('PRIVATE_SOCKET_FAILURE');
  expect(channel.close).toHaveBeenCalledOnce();
  expect(service.resourceCount()).toBe(1);
  await expect(service.dispose()).rejects.toThrow('TERMINAL_DRAIN_FAILED');
});
it('keeps an exited terminal active only while its recording file is still draining', async () => {
  const gate = Promise.withResolvers<void>();
  const writer = { bytesWritten: 0, write: () => true, close: vi.fn(() => gate.promise) };
  const { service, exit } = fixture({ open: async () => writer });
  const terminal = await service.createLocal({ cols: 80, rows: 24 });
  await service.startRecording(terminal.id, {
    path: 'controlled-file',
    fileName: 'log',
    timestamps: false,
    includeRecent: false,
  });
  exit();
  expect(service.activeTaskCount()).toBe(1);
  let closed = false;
  const pending = service.close(terminal.id).then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  gate.resolve();
  await pending;
  expect(writer.close).toHaveBeenCalledOnce();
  expect(service.activeTaskCount()).toBe(0);
  await service.dispose();
});

it('reserves asynchronous allocation capacity and joins a late channel before disposal completes', async () => {
  const opening = Promise.withResolvers<TerminalChannel>();
  const cleanup = Promise.withResolvers<void>();
  const { channel } = fixture(undefined, () => cleanup.promise);
  let signal: AbortSignal | undefined;
  const service = new TerminalService(
    {
      open: (input) => {
        signal = input.signal;
        return opening.promise;
      },
    },
    {
      open: async () => {
        throw new Error('unused');
      },
    },
    1,
  );
  const pending = service.createLocal({ cols: 80, rows: 24 });
  void pending.catch(() => {});
  expect(service.activeTaskCount()).toBe(1);
  await expect(service.createLocal({ cols: 80, rows: 24 })).rejects.toThrow('capacity');
  let disposed = false;
  const disposal = service.dispose().then(() => {
    disposed = true;
  });
  expect(signal?.aborted).toBe(true);
  opening.resolve(channel);
  await vi.waitFor(() => expect(channel.close).toHaveBeenCalledOnce());
  expect(disposed).toBe(false);
  expect(service.resourceCount()).toBeGreaterThan(0);
  cleanup.resolve();
  await disposal;
  await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
  expect(service.resourceCount()).toBe(0);
  expect(service.list()).toEqual([]);
});
it('retains a late allocation whose close fails and reports unsuccessful disposal', async () => {
  const opening = Promise.withResolvers<TerminalChannel>();
  const { channel } = fixture(undefined, async () => {
    throw new Error('CLOSE_FAILED');
  });
  const service = new TerminalService(
    { open: () => opening.promise },
    {
      open: async () => {
        throw new Error('unused');
      },
    },
    1,
  );
  const pending = service.createLocal({ cols: 80, rows: 24 });
  void pending.catch(() => {});
  const disposal = service.dispose();
  void disposal.catch(() => {});
  opening.resolve(channel);
  await expect(pending).rejects.toThrow('CLOSE_FAILED');
  await expect(disposal).rejects.toThrow('TERMINAL_DRAIN_FAILED');
  expect(service.resourceCount()).toBe(1);
});

it('retains disconnected metadata while joining actual native shutdown and a concurrent explicit close exactly once', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(undefined, async () => {
    await gate;
  });
  const terminal = await f.service.createLocal({ cols: 80, rows: 24 });
  const disconnecting = f.service.disconnect(terminal.id);
  await vi.waitFor(() => expect(f.service.get(terminal.id).state).toBe('closed'));
  expect(f.service.activeTaskCount()).toBeGreaterThan(0);
  let completed = false;
  const closing = f.service.close(terminal.id).then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(f.service.list()).toEqual([]);
  release();
  await disconnecting;
  await closing;
  expect(f.channel.close).toHaveBeenCalledOnce();
  expect(f.service.activeTaskCount()).toBe(0);
  expect(f.service.resourceCount()).toBe(0);
  await f.service.dispose();
});
