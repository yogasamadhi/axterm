import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutputConsumer } from '../../apps/desktop/src/renderer/src/components/terminal-output-consumer';
import {
  TERMINAL_OUTPUT_PENDING_MAX_FRAMES,
  terminalOutputFlowSchema,
} from '../../packages/contracts/src';

function fixture() {
  const callbacks: Array<() => void> = [];
  let time = 0;
  const progress = vi.fn();
  const writer = {
    write: vi.fn((_data: string | Uint8Array, done: () => void) => callbacks.push(done)),
  };
  const consumer = new TerminalOutputConsumer(writer, () => time, progress);
  return { callbacks, progress, writer, consumer, advance: (ms: number) => (time += ms) };
}
afterEach(() => vi.useRealTimers());

describe('owned terminal parser consumption', () => {
  it('bounds tiny pending callbacks and rejects empty frames before decoding', () => {
    const f = fixture();
    const decode = vi.fn(() => 'x');
    expect(f.consumer.write(decode, 0)).toBe(false);
    for (let i = 0; i < TERMINAL_OUTPUT_PENDING_MAX_FRAMES; i++)
      expect(f.consumer.write('x', 1)).toBe(true);
    expect(f.consumer.write(decode, 1)).toBe(false);
    expect(decode).not.toHaveBeenCalled();
    expect(f.consumer.snapshot().pendingBytes).toBe(TERMINAL_OUTPUT_PENDING_MAX_FRAMES);
    f.callbacks[0]!();
    expect(f.consumer.write(decode, 1)).toBe(true);
    f.consumer.dispose();
    expect(f.consumer.snapshot().pendingBytes).toBe(0);
  });
  it('retires a failed parser and ignores its later completion callback', () => {
    let complete: (() => void) | undefined;
    const consumer = new TerminalOutputConsumer(
      {
        write: (_data, done) => {
          complete = done;
          throw new Error('parser failed');
        },
      },
      () => 0,
      () => {},
    );
    expect(consumer.write('data', 4)).toBe(false);
    expect(consumer.snapshot()).toMatchObject({
      disposed: true,
      pendingBytes: 0,
      abandonedBytes: 4,
    });
    complete!();
    expect(consumer.snapshot().consumedBytes).toBe(0);
    expect(consumer.write('later', 5)).toBe(false);
  });
  it('batches parsed bytes, bounds the flush timer, and flushes the retired socket before disposal', () => {
    vi.useFakeTimers();
    const callbacks: Array<() => void> = [];
    const ack = vi.fn();
    const consumer = new TerminalOutputConsumer(
      { write: (_data, done) => callbacks.push(done) },
      () => 0,
      () => {},
      ack,
    );
    const flow = terminalOutputFlowSchema.parse({
      streamId: '00000000-0000-4000-8000-000000000001',
      highWaterBytes: 256 * 1024,
      lowWaterBytes: 64 * 1024,
      maxPendingBytes: 512 * 1024,
      maxFrameBytes: 64 * 1024,
    });
    consumer.configureFlow(flow);
    for (let i = 0; i < 12; i++) {
      consumer.write('', 4096);
      callbacks[i]!();
    }
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenLastCalledWith(flow.streamId, 32 * 1024);
    expect(vi.getTimerCount()).toBe(1);
    consumer.dispose();
    expect(ack).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenLastCalledWith(flow.streamId, 48 * 1024);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(ack).toHaveBeenCalledTimes(2);
  });
  it('releases a tiny-frame producer below the batching threshold without acknowledging unparsed bytes', () => {
    vi.useFakeTimers();
    const callbacks: Array<() => void> = [];
    const ack = vi.fn();
    const consumer = new TerminalOutputConsumer(
      { write: (_data, done) => callbacks.push(done) },
      () => 0,
      () => {},
      ack,
    );
    const flow = terminalOutputFlowSchema.parse({
      streamId: '00000000-0000-4000-8000-000000000001',
      highWaterBytes: 256 * 1024,
      lowWaterBytes: 64 * 1024,
      maxPendingBytes: 512 * 1024,
      maxFrameBytes: 64 * 1024,
    });
    consumer.configureFlow(flow);
    consumer.write('unparsed', 4);
    vi.advanceTimersByTime(100);
    expect(ack).not.toHaveBeenCalled();
    callbacks[0]!();
    vi.advanceTimersByTime(25);
    expect(ack).toHaveBeenLastCalledWith(flow.streamId, 4);
    ack.mockClear();
    for (let i = 0; i < 4096; i++) {
      consumer.write('x', 1);
      callbacks[i + 1]!();
    }
    consumer.write('unparsed tail', 3);
    vi.advanceTimersByTime(24);
    expect(ack).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ack).toHaveBeenLastCalledWith(flow.streamId, 4100);
    consumer.dispose();
    callbacks.at(-1)!();
    expect(ack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('acknowledges parsed raw bytes to one negotiated stream and ignores callbacks after disposal', () => {
    vi.useFakeTimers();
    const callbacks: Array<() => void> = [];
    const ack = vi.fn();
    const consumer = new TerminalOutputConsumer(
      { write: (_data, done) => callbacks.push(done) },
      () => 0,
      () => {},
      ack,
    );
    const flow = terminalOutputFlowSchema.parse({
      streamId: '00000000-0000-4000-8000-000000000001',
      highWaterBytes: 256 * 1024,
      lowWaterBytes: 64 * 1024,
      maxPendingBytes: 512 * 1024,
      maxFrameBytes: 64 * 1024,
    });
    expect(consumer.configureFlow(flow)).toBe(true);
    consumer.write('display-expanded', 5);
    consumer.write('tail', 4);
    expect(ack).not.toHaveBeenCalled();
    callbacks[0]!();
    expect(ack).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(ack).toHaveBeenLastCalledWith(flow.streamId, 5);
    expect(
      consumer.configureFlow({ ...flow, streamId: '00000000-0000-4000-8000-000000000002' }),
    ).toBe(false);
    consumer.dispose();
    callbacks[1]!();
    expect(ack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects parser overflow before decoding or adding any additional output queue', () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) expect(f.consumer.write('', 64 * 1024)).toBe(true);
    const decode = vi.fn(() => 'not decoded');
    expect(f.consumer.write(decode, 1)).toBe(false);
    expect(decode).not.toHaveBeenCalled();
    expect(f.consumer.snapshot().pendingBytes).toBe(512 * 1024);
    f.callbacks[0]!();
    expect(f.consumer.write(decode, 1)).toBe(true);
    expect(decode).toHaveBeenCalledOnce();
    expect(f.consumer.write(decode, 64 * 1024 + 1)).toBe(false);
    f.consumer.dispose();
  });
  it('counts raw transport bytes even when decoding expands or withholds text', () => {
    const f = fixture();
    const replayFinished = vi.fn();
    f.consumer.write('', 1);
    f.consumer.write('\\033[31m', 5, replayFinished);
    expect(f.consumer.snapshot()).toMatchObject({
      receivedBytes: 6,
      consumedBytes: 0,
      pendingBytes: 6,
      peakPendingBytes: 6,
    });
    f.advance(50);
    f.callbacks[0]!();
    expect(replayFinished).not.toHaveBeenCalled();
    f.advance(20);
    f.callbacks[1]!();
    expect(f.consumer.snapshot()).toMatchObject({
      consumedBytes: 6,
      pendingBytes: 0,
      writeCalls: 2,
      completedWrites: 2,
      peakCallbackMs: 70,
    });
    expect(replayFinished).toHaveBeenCalledOnce();
  });
  it('does not revive a disposed owner when the vendor finishes pending output', () => {
    const f = fixture();
    const afterConsumed = vi.fn();
    f.consumer.write(new Uint8Array(10), 10, afterConsumed);
    f.consumer.dispose();
    const count = f.progress.mock.calls.length;
    f.callbacks[0]!();
    f.consumer.write('later', 5);
    f.consumer.dispose();
    expect(f.progress).toHaveBeenCalledTimes(count);
    expect(afterConsumed).not.toHaveBeenCalled();
    expect(f.writer.write).toHaveBeenCalledOnce();
    expect(f.consumer.snapshot()).toMatchObject({
      disposed: true,
      consumedBytes: 0,
      pendingBytes: 0,
      abandonedBytes: 10,
    });
  });
  it('counts a vendor completion once and exposes only numeric metadata', () => {
    const f = fixture();
    f.consumer.write('not retained secret fixture', 27);
    f.callbacks[0]!();
    f.callbacks[0]!();
    const snapshot = f.consumer.snapshot();
    expect(snapshot).toMatchObject({ consumedBytes: 27, pendingBytes: 0, completedWrites: 1 });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    snapshot.pendingBytes = 999;
    expect(f.consumer.snapshot().pendingBytes).toBe(0);
  });
});
