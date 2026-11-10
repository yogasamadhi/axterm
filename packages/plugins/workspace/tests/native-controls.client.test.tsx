// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useNativeControls } from '../src/client/native-controls.ts';
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.platform;
  vi.unstubAllGlobals();
});
function Example() {
  const ref = useRef<HTMLDivElement>(null);
  useNativeControls(ref);
  return <div ref={ref} />;
}
async function fixture(platform: string) {
  document.documentElement.dataset.platform = platform;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const pending = new Map<number, FrameRequestCallback>();
  let nonce = 0;
  const request = vi.fn((callback: FrameRequestCallback) => {
    pending.set(++nonce, callback);
    return nonce;
  });
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
  const disconnect = vi.fn(),
    observe = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = observe;
      disconnect = disconnect;
    },
  );
  Object.defineProperty(window, 'outerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Example />));
  const shell = container.firstElementChild as HTMLElement;
  const frame = () => {
    const [id, callback] = pending.entries().next().value as [number, FrameRequestCallback];
    pending.delete(id);
    callback(0);
  };
  return { pending, frame, shell, request, disconnect, observe };
}
it('retains physical exclusions at three zoom factors and reconciles delayed metrics within thirty frames', async () => {
  const f = await fixture('darwin');
  expect(f.shell.style.getPropertyValue('--ax-native-controls-width')).toBe('80px');
  for (const zoom of [0.5, 1, 2]) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 / zoom });
    window.dispatchEvent(new Event('resize'));
    expect(f.shell.style.getPropertyValue('--ax-native-controls-width')).toBe(`${80 / zoom}px`);
    expect(f.shell.style.getPropertyValue('--ax-native-controls-height')).toBe(`${38 / zoom}px`);
  }
  Object.defineProperty(window, 'outerWidth', { configurable: true, value: 2560 });
  window.dispatchEvent(new Event('resize'));
  for (let i = 0; i < 8; i++) f.frame();
  Object.defineProperty(window, 'outerWidth', { configurable: true, value: 1280 });
  f.frame();
  expect(f.shell.style.getPropertyValue('--ax-native-controls-width')).toBe('40px');
  for (let i = 9; i < 30; i++) f.frame();
  expect(f.pending.size).toBe(0);
  window.dispatchEvent(new Event('resize'));
  expect(f.pending.size).toBe(1);
  await act(async () => root!.unmount());
  root = undefined;
  expect(f.pending.size).toBe(0);
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(f.shell.style.getPropertyValue('--ax-native-controls-width')).toBe('');
  window.dispatchEvent(new Event('resize'));
  expect(f.pending.size).toBe(0);
});
it('does not reserve native space or subscribe measurements in Web', async () => {
  const f = await fixture('web');
  expect(f.pending.size).toBe(0);
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.shell.style.getPropertyValue('--ax-native-controls-width')).toBe('');
});
