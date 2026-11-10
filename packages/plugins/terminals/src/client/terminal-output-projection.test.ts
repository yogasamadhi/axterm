import { afterEach, expect, it, vi } from 'vitest';
import { TerminalOutputConsumer } from './terminal-output-consumer.ts';
import { TerminalOutputProjection } from './terminal-output-projection.ts';

afterEach(() => vi.useRealTimers());
it('bounds DOM observation while accounting every real parser callback immediately', () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const projection = new TerminalOutputProjection(publish);
  const callbacks: Array<() => void> = [];
  const consumer = new TerminalOutputConsumer(
    { write: (_data, done) => callbacks.push(done) },
    () => 0,
    projection.update,
  );
  for (let index = 0; index < 4000; index++) {
    expect(consumer.write('x', 1)).toBe(true);
    callbacks[index]!();
  }
  expect(consumer.snapshot()).toMatchObject({ consumedBytes: 4000, pendingBytes: 0 });
  expect(publish).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(16);
  expect(publish).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenLastCalledWith(consumer.snapshot());
  consumer.write('unparsed', 8);
  consumer.dispose();
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({ disposed: true, abandonedBytes: 8, consumedBytes: 4000 }),
  );
  expect(vi.getTimerCount()).toBe(0);
  callbacks.at(-1)!();
  projection.update({ ...consumer.snapshot(), consumedBytes: 9999 });
  vi.advanceTimersByTime(100);
  expect(publish).toHaveBeenCalledTimes(2);
});
