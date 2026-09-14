import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParentEnvelope } from '../../packages/contracts/src/host-capabilities/desktop';
import { RuntimeSupervisor } from '../../apps/desktop/src/main/supervisor/runtime-supervisor';
import {
  isTrustedClipboardPermission,
  isTrustedDocument,
} from '../../apps/desktop/src/main/windows/security';

class FakeChild extends EventEmitter {
  messages: ParentEnvelope[] = [];
  postMessage(envelope: ParentEnvelope) {
    this.messages.push(envelope);
    if (envelope.type === 'shutdown') this.emit('exit', 0);
  }
  kill() {
    this.emit('exit', 1);
    return true;
  }
}
afterEach(() => vi.useRealTimers());
function ready(
  supervisor: RuntimeSupervisor,
  child: FakeChild,
  generation = supervisor.generation,
) {
  child.emit('message', {
    type: 'ready',
    pid: 42,
    bootstrap: {
      baseUrl: 'http://127.0.0.1:49152',
      apiVersion: 'v1',
      appVersion: '0.1.0',
      runtimeId: randomUUID(),
      generation,
      bootstrapToken: 'b'.repeat(43),
    },
  });
}
describe('desktop runtime supervision', () => {
  it('validates discovery and rotates generation after bounded crash backoff', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const supervisor = new RuntimeSupervisor({
      startup: { appVersion: '0.1.0' },
      restartDelay: () => 10,
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    supervisor.start();
    const first = children[0]!;
    ready(supervisor, first, randomUUID());
    expect(() => supervisor.resolve()).toThrow();
    ready(supervisor, first);
    const generation = supervisor.resolve().generation;
    first.emit('message', { type: 'ssh.connect', password: 'must-be-ignored' });
    expect(supervisor.state).toBe('ready');
    first.kill();
    expect(() => supervisor.resolve()).toThrow();
    await vi.advanceTimersByTimeAsync(10);
    expect(supervisor.generation).not.toBe(generation);
    ready(supervisor, children[1]!);
    expect(supervisor.restartCount).toBe(1);
    await supervisor.stop();
    expect(supervisor.state).toBe('stopped');
    expect(first.listenerCount('message')).toBe(0);
    expect(children[1]!.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds startup failures and cancels all scheduled restarts on shutdown', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const supervisor = new RuntimeSupervisor({
      startup: { appVersion: '0.1.0' },
      fork: () => new FakeChild(),
      startupTimeoutMs: 10,
      restartDelay: () => 1,
      onUnavailable: failed,
    });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(supervisor.state).toBe('degraded');
    expect(supervisor.restartCount).toBe(3);
    expect(failed).toHaveBeenCalledTimes(1);
    await supervisor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('force-kills a child that ignores shutdown', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.postMessage = () => {};
    const supervisor = new RuntimeSupervisor({
      startup: { appVersion: '0.1.0' },
      fork: () => child,
    });
    supervisor.start();
    ready(supervisor, child);
    const stopped = supervisor.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopped;
    expect(supervisor.state).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });
});
it('restricts bootstrap and navigation to the trusted top-level document origin', () => {
  const origin = 'http://127.0.0.1:1234';
  expect(isTrustedDocument(`${origin}/`, origin)).toBe(true);
  expect(isTrustedDocument(`${origin}/index.html`, origin)).toBe(true);
  for (const url of [
    'file:///etc/passwd',
    `${origin}.evil.example/`,
    `${origin}/assets/x.js`,
    `${origin}/?token=x`,
    'http://127.0.0.1:1235/',
    'https://example.com/',
    'not-a-url',
  ])
    expect(isTrustedDocument(url, origin)).toBe(false);
});
it('allows clipboard access only for the trusted top-level application document', () => {
  const origin = 'http://127.0.0.1:1234';
  for (const permission of ['clipboard-read', 'clipboard-sanitized-write'])
    expect(isTrustedClipboardPermission(permission, `${origin}/`, origin, origin)).toBe(true);

  for (const permission of ['notifications', 'media', 'deprecated-sync-clipboard-read'])
    expect(isTrustedClipboardPermission(permission, `${origin}/`, origin, origin)).toBe(false);

  expect(
    isTrustedClipboardPermission('clipboard-read', `${origin}/assets/frame.html`, origin, origin),
  ).toBe(false);
  expect(
    isTrustedClipboardPermission('clipboard-read', `${origin}/`, origin, 'https://example.com'),
  ).toBe(false);
  expect(isTrustedClipboardPermission('clipboard-read', `${origin}/`, origin, 'not-a-url')).toBe(
    false,
  );
});
