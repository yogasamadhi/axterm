import { expect, it, vi } from 'vitest';
import type { DesktopWindowPresentationState } from '@axterm/plugin-api/shortcuts';
import { WindowControlsOwner } from '../../packages/plugins/desktop/src/client/window-controls-owner.ts';
const state = (fullScreen = false): DesktopWindowPresentationState => ({
  minimized: false,
  maximized: false,
  fullScreen,
  focused: true,
  visible: true,
  canMinimize: true,
  canMaximize: true,
  canClose: true,
});
it('joins one actual read, rejects stale pre-action reads and refreshes after the captured action', async () => {
  const old = Promise.withResolvers<DesktopWindowPresentationState>();
  const getState = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(state(true)),
    act = vi.fn(async () => {}),
    owner = new WindowControlsOwner({ getState, act });
  const reading = owner.refresh();
  expect(owner.refresh()).toBe(reading);
  await vi.waitFor(() => expect(getState).toHaveBeenCalledOnce());
  const action = owner.perform('fullscreen');
  await vi.waitFor(() => expect(act).toHaveBeenCalledOnce());
  await expect(owner.perform('minimize')).rejects.toThrow('UNAVAILABLE');
  old.resolve(state(false));
  await reading;
  expect(owner.getSnapshot().value).toBeUndefined();
  await action;
  expect(owner.getSnapshot()).toMatchObject({
    value: { fullScreen: true },
    busy: false,
    error: false,
  });
  expect(getState).toHaveBeenCalledTimes(2);
  await owner.close();
});
it('cancels scheduled reads and joins actual late native work without publishing after close', async () => {
  const late = Promise.withResolvers<DesktopWindowPresentationState>(),
    getState = vi.fn(() => late.promise),
    owner = new WindowControlsOwner({ getState, act: async () => {} }),
    listener = vi.fn();
  owner.subscribe(listener);
  const reading = owner.refresh();
  await vi.waitFor(() => expect(getState).toHaveBeenCalledOnce());
  owner.schedule();
  owner.schedule();
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  late.resolve(state());
  await reading;
  await closing;
  expect(listener).not.toHaveBeenCalled();
  expect(getState).toHaveBeenCalledOnce();
  await expect(owner.refresh()).rejects.toThrow('CLOSED');
});
