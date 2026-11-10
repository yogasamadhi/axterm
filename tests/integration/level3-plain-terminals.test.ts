import { randomUUID } from 'node:crypto';
import { SerialPortMock } from 'serialport';
import { expect, it, vi } from 'vitest';
import { bookmarkSchema, createBookmarkSchema } from '@axterm/plugin-api/catalog';
import type { TerminalChannel } from '@axterm/plugin-api/host';
import { PlainTerminals } from '../../packages/plugins/connections/src/application/plain-terminals.ts';
import { NodeSerialAdapter } from '../../packages/plugins/connections/src/adapters/serial/node-serial-adapter.ts';
import { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';

function bookmark() {
  const now = new Date().toISOString();
  return bookmarkSchema.parse({
    ...createBookmarkSchema.parse({
      protocol: 'serial',
      hostId: null,
      title: 'Controlled Serial',
      serial: {
        path: '/dev/AXTERM-LEVEL3-MOCK',
        encoding: 'gbk',
        baudRate: 57600,
        closeSequence: '',
        closeSequenceDelayMs: 0,
      },
    }),
    id: randomUUID(),
    position: 0,
    connectionDisplay: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
}
const noCredential = {
  resolveCredential: vi.fn(async () => {
    throw new Error('Serial cannot request credentials');
  }),
};
const noTelnet = {
  connect: vi.fn(async () => {
    throw new Error('Serial cannot use Telnet');
  }),
};

it('registers maintained SerialPort mock channels with the sole terminal owner and drains them on protocol unload', async () => {
  SerialPortMock.binding.reset();
  SerialPortMock.binding.createPort('/dev/AXTERM-LEVEL3-MOCK', { echo: true, record: true });
  const selected = bookmark();
  const terminals = new TerminalService(
    {
      open: () => {
        throw new Error('Serial cannot open a PTY');
      },
    },
    {
      open: async () => {
        throw new Error('Recording was not requested');
      },
    },
  );
  const serial = new NodeSerialAdapter(
    (input) => new SerialPortMock({ ...input, autoOpen: false }),
  );
  const service = new PlainTerminals(
    {
      getBookmark: () => selected,
      getConnectionProfile: () => {
        throw new Error('Serial cannot resolve credentials');
      },
    },
    noCredential,
    serial,
    noTelnet,
    {
      registerExternal: (metadata, channel, kind) =>
        terminals.registerExternal({ ...metadata, id: randomUUID() }, channel, kind),
      close: (id) => terminals.close(id),
    },
  );
  try {
    const opened = await service.open({
      kind: 'serial',
      bookmarkId: selected.id,
      cols: 80,
      rows: 24,
      profileId: randomUUID(),
    });
    expect(opened).toMatchObject({
      kind: 'serial',
      title: selected.title,
      bookmarkId: selected.id,
      behavior: { encoding: 'gbk' },
    });
    expect(service.resourceCount()).toBe(2);
    expect(terminals.resourceCount()).toBe(1);
    await service.close();
    expect(service.resourceCount()).toBe(0);
    expect(terminals.resourceCount()).toBe(0);
    expect(noCredential.resolveCredential).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await terminals.dispose();
    SerialPortMock.binding.reset();
  }
});

it('bounds admitted opens and waits for late channels and their actual close before ending cancellation', async () => {
  const selected = bookmark();
  const opened: ((channel: TerminalChannel) => void)[] = [];
  const closed = Promise.withResolvers<void>();
  const close = vi.fn(() => closed.promise);
  const register = vi.fn(() => {
    throw new Error('Canceled channels cannot become sessions');
  });
  const service = new PlainTerminals(
    {
      getBookmark: () => selected,
      getConnectionProfile: () => {
        throw new Error('Unused');
      },
    },
    noCredential,
    { list: async () => [], open: () => new Promise((resolve) => opened.push(resolve)) },
    noTelnet,
    { registerExternal: register, close: async () => {} },
  );
  const input = { kind: 'serial' as const, bookmarkId: selected.id, cols: 80, rows: 24 };
  const pending = Array.from({ length: 32 }, () => service.open(input));
  const outcomes = Promise.allSettled(pending);
  expect(() => service.open(input)).toThrow('capacity exceeded');
  await vi.waitFor(() => expect(opened).toHaveLength(32));
  let stopped = false;
  const stopping = service.close().then(() => {
    stopped = true;
  });
  const channel: TerminalChannel = {
    write: () => {},
    resize: () => {},
    signal: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    pause: () => {},
    resume: () => {},
    close,
  };
  for (const resolve of opened) resolve(channel);
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(32));
  expect(stopped).toBe(false);
  expect(service.resourceCount()).toBe(32);
  closed.resolve();
  await stopping;
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
  expect(register).not.toHaveBeenCalled();
  expect(service.resourceCount()).toBe(0);
});
