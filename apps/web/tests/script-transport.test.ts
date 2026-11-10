// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ScriptBundleTransport } from '../src/script-transport.ts';
afterEach(() => {
  document.head.innerHTML = '';
  vi.useRealTimers();
});
function base() {
  const el = document.createElement('base');
  el.href = 'http://127.0.0.1:4312/';
  document.head.append(el);
}
it('rejects foreign authorities, credentials, schemes and oversized references before adding scripts', async () => {
  base();
  const transport = new ScriptBundleTransport(document);
  for (const url of [
    'https://127.0.0.1:4312/x.js',
    'http://foreign.invalid/x.js',
    'file:///tmp/x.js',
    'http://secret@127.0.0.1:4312/x.js',
    './x.js?token=secret',
    './x.js#secret',
    'x'.repeat(4097),
  ])
    await expect(transport.load(url)).rejects.toThrow('AUTHORITY_REFUSED');
  expect(document.querySelectorAll('script')).toHaveLength(0);
  transport.close();
});
it('cleans script handlers and timers on successful load, error, timeout and disposal', async () => {
  base();
  vi.useFakeTimers();
  const transport = new ScriptBundleTransport(document, 50);
  const loaded = transport.load('./first.js');
  const first = document.querySelector('script')!;
  first.dispatchEvent(new Event('load'));
  await loaded;
  expect(first.onload).toBeNull();
  expect(document.querySelector('script')).toBeNull();
  const failed = transport.load('./bad.js');
  const failedCheck = expect(failed).rejects.toThrow('UNAVAILABLE');
  document.querySelector('script')!.dispatchEvent(new Event('error'));
  await failedCheck;
  const timed = transport.load('./slow.js');
  const timedCheck = expect(timed).rejects.toThrow('TIMEOUT');
  await vi.advanceTimersByTimeAsync(50);
  await timedCheck;
  const cancelled = transport.load('./pending.js');
  const cancelledCheck = expect(cancelled).rejects.toThrow('CLOSED');
  transport.close();
  transport.close();
  await cancelledCheck;
  expect(document.querySelector('script')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await expect(transport.load('./late.js')).rejects.toThrow('CLOSED');
});
it('bounds pending script capacity and rejects invalid runtime limits', async () => {
  base();
  const transport = new ScriptBundleTransport(document, 100, 1);
  const pending = transport.load('./held.js');
  const check = expect(pending).rejects.toThrow('CLOSED');
  await expect(transport.load('./overflow.js')).rejects.toThrow('CAPACITY');
  transport.close();
  await check;
  expect(() => new ScriptBundleTransport(document, 0)).toThrow('LIMIT_INVALID');
  expect(() => new ScriptBundleTransport(document, 100, 33)).toThrow('LIMIT_INVALID');
});
