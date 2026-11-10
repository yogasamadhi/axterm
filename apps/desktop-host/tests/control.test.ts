import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ownHostControl, type HostedApplication } from '../src/control.ts';
import type { HostControl } from '../src/protocol.ts';
class Peer extends EventEmitter {
  connected = true;
  readonly frames: HostControl[] = [];
  send(message: object, callback: (error: Error | null) => void): boolean {
    this.frames.push(message as HostControl);
    callback(null);
    return true;
  }
  disconnect() {
    this.connected = false;
    this.emit('disconnect');
  }
}
const generation = randomUUID();
const initialize = () => ({
  kind: 'axterm-desktop-control',
  version: 1,
  type: 'initialize',
  generation,
  home: '/test-isolated-home',
  verifier: { generation, digest: 'a'.repeat(64) },
});
const control = (type: string) => ({
  kind: 'axterm-desktop-control',
  version: 1,
  generation,
  type,
});
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
});
function application(): HostedApplication {
  return {
    origin: 'http://127.0.0.1:4312',
    injections: [],
    stop: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ active: false })),
  };
}
it('owns one control endpoint, ignores native frames, and drains before acknowledging shutdown', async () => {
  const peer = new Peer();
  const app = application();
  const dispose = ownHostControl(peer, async () => app);
  expect(() => ownHostControl(peer, async () => app)).toThrow('UNAVAILABLE');
  peer.emit('message', { kind: 'axterm-native', type: 'request' });
  expect(peer.frames).toEqual([]);
  peer.emit('message', initialize());
  await flush();
  expect(peer.frames).toEqual([{ ...control('ready'), origin: app.origin, injections: [] }]);
  peer.emit('message', control('shutdown'));
  await dispose();
  expect(app.stop).toHaveBeenCalledOnce();
  expect(peer.frames.at(-1)).toEqual(control('stopped'));
  expect(peer.listenerCount('message')).toBe(0);
  expect(peer.listenerCount('disconnect')).toBe(0);
  expect(peer.connected).toBe(false);
});
it('rejects malformed, wrong-version, relative-home, business and oversized frames before starting any application', async () => {
  for (const frame of [
    { ...initialize(), version: 2 },
    { ...initialize(), home: '../home' },
    { ...initialize(), credential: 'PRIVATE' },
    { ...control('invoke'), method: 'terminals.spawn' },
    { ...initialize(), home: '/' + 'x'.repeat(9000) },
  ]) {
    const peer = new Peer();
    const start = vi.fn(async () => application());
    const failed = vi.fn();
    const dispose = ownHostControl(peer, start, failed);
    peer.emit('message', frame);
    await flush();
    await dispose();
    expect(start).not.toHaveBeenCalled();
    expect(peer.connected).toBe(false);
    expect(failed).toHaveBeenCalledOnce();
    expect(JSON.stringify(peer.frames)).not.toContain('PRIVATE');
  }
});
it('rejects duplicate initialization while retaining channel ownership until the admitted startup drains', async () => {
  const peer = new Peer();
  const gate = Promise.withResolvers<HostedApplication>();
  const app = application();
  const dispose = ownHostControl(peer, () => gate.promise);
  peer.emit('message', initialize());
  peer.emit('message', initialize());
  await flush();
  expect(() => ownHostControl(peer, async () => app)).toThrow('UNAVAILABLE');
  expect(peer.connected).toBe(true);
  gate.resolve(app);
  await dispose();
  expect(app.stop).toHaveBeenCalledOnce();
  expect(peer.frames.some((frame) => frame.type === 'ready')).toBe(false);
  expect(peer.frames.at(-1)).toMatchObject({ type: 'failed', code: 'HOST_CONTROL_INVALID' });
});
it('reports known tasks and treats inspection rejection and timeout as active, without leaving timers', async () => {
  vi.useFakeTimers();
  const peer = new Peer();
  const app = application();
  const dispose = ownHostControl(peer, async () => app);
  peer.emit('message', initialize());
  await flush();
  const inspect = () => peer.emit('message', { ...control('inspect-quit'), id: randomUUID() });
  inspect();
  await flush();
  expect(peer.frames.at(-1)).toMatchObject({ type: 'inspection', active: false, known: true });
  vi.mocked(app.inspect).mockRejectedValueOnce(new Error('PRIVATE_TASK_EXCEPTION'));
  inspect();
  await flush();
  expect(peer.frames.at(-1)).toMatchObject({ active: true, known: false });
  let signal: AbortSignal | undefined;
  vi.mocked(app.inspect).mockImplementationOnce((input) => {
    signal = input;
    return new Promise(() => {});
  });
  inspect();
  await flush();
  await vi.advanceTimersByTimeAsync(1000);
  expect(signal?.aborted).toBe(true);
  expect(peer.frames.at(-1)).toMatchObject({ active: true, known: false });
  for (let index = 0; index < 20; index++) inspect();
  await flush();
  expect(app.inspect).toHaveBeenCalledTimes(3);
  expect(peer.frames.at(-1)).toMatchObject({ type: 'inspection', active: true, known: false });
  expect(JSON.stringify(peer.frames)).not.toContain('PRIVATE_TASK_EXCEPTION');
  await dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels pending inspection on disconnect, rejects stale generations and clears initialization deadlines', async () => {
  vi.useFakeTimers();
  const peer = new Peer();
  const app = application();
  const dispose = ownHostControl(peer, async () => app);
  peer.emit('message', initialize());
  await flush();
  peer.emit('message', { ...control('shutdown'), generation: randomUUID() });
  await flush();
  await dispose();
  expect(peer.frames.at(-1)).toMatchObject({
    type: 'failed',
    code: 'HOST_CONTROL_INVALID',
    generation,
  });
  expect(vi.getTimerCount()).toBe(0);
  const idle = new Peer();
  const notStarted = vi.fn(async () => application());
  const stopIdle = ownHostControl(idle, notStarted);
  await vi.advanceTimersByTimeAsync(15_000);
  await stopIdle();
  expect(idle.connected).toBe(false);
  expect(notStarted).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('contains startup exceptions and refuses a non-loopback advertised Host', async () => {
  for (const start of [
    async () => {
      throw new Error('PRIVATE_STARTUP_EXCEPTION');
    },
    async () => ({ ...application(), origin: 'http://external.invalid:4312' }),
  ]) {
    const peer = new Peer();
    const failed = vi.fn();
    const dispose = ownHostControl(peer, start, failed);
    peer.emit('message', initialize());
    await flush();
    await dispose();
    expect(peer.frames.at(-1)).toMatchObject({ type: 'failed', code: 'HOST_STARTUP_FAILED' });
    expect(failed).toHaveBeenCalledOnce();
    expect(JSON.stringify(peer.frames)).not.toContain('PRIVATE');
  }
});
