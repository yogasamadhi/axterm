import { createTerminalOutputDecoder, decodeTerminalOutput } from './rendering/output.ts';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionGeneration, ConnectionWebSocket } from '@axterm/infra-connection/client';
import {
  terminalOutputFlowSchema,
  TERMINAL_OUTPUT_HIGH_WATER_BYTES,
  TERMINAL_OUTPUT_LOW_WATER_BYTES,
  TERMINAL_OUTPUT_PENDING_MAX_BYTES,
  TERMINAL_OUTPUT_FRAME_MAX_BYTES,
  TERMINAL_OUTPUT_PENDING_MAX_FRAMES,
} from '@axterm/plugin-api/terminals';
import { TerminalStream, type TerminalStreamOptions } from './stream.ts';

class Socket implements ConnectionWebSocket {
  private readonly events = new EventTarget();
  addEventListener: ConnectionWebSocket['addEventListener'] = (event, listener, options) => {
    this.events.addEventListener(event, listener as EventListener, options);
  };
  removeEventListener: ConnectionWebSocket['removeEventListener'] = (event, listener) => {
    this.events.removeEventListener(event, listener as EventListener);
  };
  readyState = 1;
  bufferedAmount = 0;
  binaryType = '';
  readonly frames: Array<string | Uint8Array> = [];
  send(data: string | Uint8Array) {
    this.frames.push(data);
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.events.dispatchEvent(new Event('close'));
  });
  receive(data: unknown) {
    this.events.dispatchEvent(new MessageEvent('message', { data }));
  }
}
const owners: TerminalStream[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function fixture(
  writer?: { write(data: string | Uint8Array, done: () => void): void },
  decodeOutput?: TerminalStreamOptions['decodeOutput'],
  replay?: TerminalStreamOptions['replay'],
) {
  const socket = new Socket();
  const subscribers = new Set<() => void>();
  let generation: ConnectionGeneration | undefined = { id: 1, host: { home: '/fixture' } };
  const control = vi.fn();
  const issue = vi.fn();
  const closed = vi.fn();
  const output = writer ?? { write: vi.fn((_data, done) => done()) };
  const stream = new TerminalStream(
    {
      openWebSocket(path) {
        expect(path).toMatch(/^\/streams\/terminals\?id=/);
        return socket;
      },
      generation: {
        getSnapshot: () => generation,
        subscribe: (callback) => {
          subscribers.add(callback);
          return () => {
            subscribers.delete(callback);
          };
        },
      },
    },
    {
      terminalId: crypto.randomUUID(),
      writer: output,
      control,
      issue,
      closed,
      ...(replay ? { replay } : {}),
      ...(decodeOutput ? { decodeOutput } : {}),
    },
  );
  owners.push(stream);
  const flow = terminalOutputFlowSchema.parse({
    streamId: crypto.randomUUID(),
    highWaterBytes: TERMINAL_OUTPUT_HIGH_WATER_BYTES,
    lowWaterBytes: TERMINAL_OUTPUT_LOW_WATER_BYTES,
    maxPendingBytes: TERMINAL_OUTPUT_PENDING_MAX_BYTES,
    maxFrameBytes: TERMINAL_OUTPUT_FRAME_MAX_BYTES,
  });
  const ready = () => socket.receive(JSON.stringify({ type: 'ready', outputFlow: flow }));
  return {
    stream,
    socket,
    ready,
    flow,
    issue,
    control,
    closed,
    subscribers,
    output,
    loseGeneration() {
      generation = undefined;
      for (const callback of [...subscribers]) callback();
    },
  };
}
it('keeps byte frames outside metadata and acknowledges only completed parser consumption', () => {
  vi.useFakeTimers();
  let complete: (() => void) | undefined;
  const write = vi.fn((_data, done: () => void) => {
    complete = done;
  });
  const f = fixture({ write });
  expect(f.stream.sendInput('before-ready')).toBe(false);
  f.ready();
  expect(f.socket.binaryType).toBe('arraybuffer');
  f.socket.receive(Uint8Array.from([65, 66]).buffer);
  expect(write).toHaveBeenCalledOnce();
  expect(f.stream.metrics()).toMatchObject({ receivedBytes: 2, consumedBytes: 0 });
  expect(f.socket.frames).toEqual([]);
  complete!();
  vi.advanceTimersByTime(25);
  expect(
    f.socket.frames.map((frame) => (typeof frame === 'string' ? JSON.parse(frame) : frame)),
  ).toEqual([{ type: 'outputConsumed', streamId: f.flow.streamId, consumedBytes: 2 }]);
  expect(f.stream.sendInput('echo hello\r')).toBe(true);
  expect(f.socket.frames.at(-1)).toBeInstanceOf(Uint8Array);
  expect(f.stream.resize(0, 24)).toBe(false);
  expect(f.stream.resize(80, 24)).toBe(true);
  expect(f.stream.ping('probe')).toBe(true);
  expect(JSON.stringify(f.stream.metrics())).not.toContain('echo hello');
});
it('bounds pending parser work and revokes late completion after disposal', () => {
  const callbacks: Array<() => void> = [];
  const f = fixture({
    write: (_data, done) => {
      callbacks.push(done);
    },
  });
  f.ready();
  for (let i = 0; i <= TERMINAL_OUTPUT_PENDING_MAX_FRAMES; i++)
    f.socket.receive(new Uint8Array([65]));
  expect(f.issue).toHaveBeenCalledWith('TERMINAL_OUTPUT_LIMIT');
  expect(f.stream.metrics()).toMatchObject({ disposed: true, pendingBytes: 0 });
  const before = f.stream.metrics();
  callbacks[0]!();
  expect(f.stream.metrics()).toEqual(before);
  expect(f.closed).toHaveBeenCalledOnce();
});
it.each(['{', JSON.stringify({ type: 'ready' }), new Uint8Array([1])])(
  'closes malformed or unnegotiated input',
  (data) => {
    const f = fixture();
    f.socket.receive(data);
    expect(f.issue).toHaveBeenCalledWith('TERMINAL_PROTOCOL_INVALID');
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.subscribers.size).toBe(0);
  },
);
it('cancels bounded pending stdin on generation loss without replay or retained timers', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.ready();
  f.socket.bufferedAmount = 1024 * 1024;
  expect(f.stream.sendInput('must never replay')).toBe(true);
  expect(f.socket.frames).toEqual([]);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  f.loseGeneration();
  f.socket.bufferedAmount = 0;
  vi.advanceTimersByTime(60_000);
  expect(f.socket.frames).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.subscribers.size).toBe(0);
  expect(f.closed).toHaveBeenCalledOnce();
});
it('times out missing negotiation and always closes after observer failures', () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.advanceTimersByTime(15_000);
  expect(f.issue).toHaveBeenCalledWith('TERMINAL_STREAM_UNAVAILABLE');
  expect(f.closed).toHaveBeenCalledOnce();
  const bad = fixture({
    write: () => {
      throw new Error('private parser failure');
    },
  });
  bad.ready();
  bad.socket.receive(new Uint8Array([1]));
  expect(bad.socket.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(bad.issue.mock.calls)).not.toContain('private parser failure');
});

it('decodes split GBK lazily while acknowledging original bytes, including expanded raw ESC display', () => {
  vi.useFakeTimers();
  const decoder = createTerminalOutputDecoder('gbk'),
    text: Array<string | Uint8Array> = [];
  const f = fixture(
    {
      write(data, done) {
        text.push(data);
        done();
      },
    },
    (bytes) => decodeTerminalOutput(decoder, bytes, true),
  );
  f.ready();
  f.socket.receive(Uint8Array.of(0xd6).buffer);
  f.socket.receive(Uint8Array.of(0xd0, 0xce, 0xc4).buffer);
  f.socket.receive(Uint8Array.of(0x1b, 0x5b, 0x30, 0x6d).buffer);
  expect(text).toEqual(['', '中文', '\\033[0m']);
  vi.advanceTimersByTime(25);
  expect(f.stream.metrics()).toMatchObject({ receivedBytes: 8, consumedBytes: 8 });
  expect(
    f.socket.frames.map((frame) => (typeof frame === 'string' ? JSON.parse(frame) : frame)),
  ).toEqual([{ type: 'outputConsumed', streamId: f.flow.streamId, consumedBytes: 8 }]);
});
it('rejects oversized frames before invoking a supplied output decoder', () => {
  const decode = vi.fn((bytes) => bytes);
  const f = fixture(undefined, decode);
  f.ready();
  f.socket.receive(new Uint8Array(TERMINAL_OUTPUT_FRAME_MAX_BYTES + 1).buffer);
  expect(decode).not.toHaveBeenCalled();
  expect(f.closed).toHaveBeenCalledOnce();
});

it('holds replay markers until actual final parser consumption and rejects replay boundary violations', () => {
  const completed: (() => void)[] = [],
    replay = vi.fn();
  const f = fixture(
    {
      write: (_data, done) => {
        completed.push(done);
      },
    },
    undefined,
    replay,
  );
  f.ready();
  f.socket.receive(
    JSON.stringify({ type: 'replay', lastSequence: 2, byteLength: 2, truncated: false }),
  );
  expect(replay.mock.calls).toEqual([[true]]);
  f.socket.receive(new Uint8Array([65]));
  f.socket.receive(new Uint8Array([66]));
  expect(replay.mock.calls).toEqual([[true]]);
  completed[0]!();
  expect(replay.mock.calls).toEqual([[true]]);
  completed[1]!();
  expect(replay.mock.calls).toEqual([[true], [false]]);
  f.socket.receive(
    JSON.stringify({ type: 'replay', lastSequence: 2, byteLength: 0, truncated: false }),
  );
  expect(f.issue).not.toHaveBeenCalled();
  for (const byte of [67, 68]) {
    f.socket.receive(
      JSON.stringify({ type: 'replay', lastSequence: byte, byteLength: 1, truncated: false }),
    );
    f.socket.receive(new Uint8Array([byte]));
  }
  completed[2]!();
  expect(replay.mock.calls).toEqual([[true], [false], [true], [true]]);
  completed[3]!();
  expect(replay.mock.calls).toEqual([[true], [false], [true], [true], [false]]);

  const bad = fixture();
  bad.ready();
  bad.socket.receive(
    JSON.stringify({ type: 'replay', lastSequence: 1, byteLength: 1, truncated: false }),
  );
  bad.socket.receive(new Uint8Array([65, 66]));
  expect(bad.issue).toHaveBeenCalledWith('TERMINAL_PROTOCOL_INVALID');
  expect(bad.output.write).not.toHaveBeenCalled();
});
it('cannot complete retired replay from a late parser callback or keep its generation listener', () => {
  let complete: (() => void) | undefined;
  const replay = vi.fn(),
    f = fixture(
      {
        write: (_data, done) => {
          complete = done;
        },
      },
      undefined,
      replay,
    );
  f.ready();
  f.socket.receive(
    JSON.stringify({ type: 'replay', lastSequence: 1, byteLength: 1, truncated: false }),
  );
  f.socket.receive(new Uint8Array([65]));
  f.loseGeneration();
  complete!();
  expect(replay.mock.calls).toEqual([[true]]);
  expect(f.subscribers.size).toBe(0);
  expect(f.closed).toHaveBeenCalledOnce();
});
it('detaches every actual byte-channel listener on close and ignores queued retired events', () => {
  const f = fixture(),
    remove = vi.spyOn(f.socket, 'removeEventListener');
  f.ready();
  f.socket.receive(new Uint8Array([65]));
  expect(f.output.write).toHaveBeenCalledOnce();
  f.socket.close();
  f.socket.receive(new Uint8Array([66]));
  f.socket.close();
  f.stream.dispose();
  expect(f.output.write).toHaveBeenCalledOnce();
  expect(f.closed).toHaveBeenCalledOnce();
  expect(remove.mock.calls.map(([name]) => name).sort()).toEqual(['close', 'error', 'message']);
  expect(f.subscribers.size).toBe(0);
});
it('retires one actual channel without changing its replacement or delivering late output', () => {
  const old = fixture(),
    next = fixture();
  old.ready();
  next.ready();
  old.stream.dispose();
  old.socket.receive(new Uint8Array([65]));
  old.socket.close();
  next.socket.receive(new Uint8Array([66]));
  expect(old.output.write).not.toHaveBeenCalled();
  expect(old.closed).toHaveBeenCalledOnce();
  expect(next.output.write).toHaveBeenCalledOnce();
  expect(next.closed).not.toHaveBeenCalled();
  expect(next.subscribers.size).toBe(1);
});
