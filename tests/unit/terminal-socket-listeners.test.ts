import { describe, expect, it, vi } from 'vitest';
import { bindTerminalSocketListeners } from '../../apps/desktop/src/renderer/src/components/terminal-socket-listeners';

function handlers() {
  return { message: vi.fn(), open: vi.fn(), close: vi.fn() };
}
describe('terminal socket attachment ownership', () => {
  it('detaches every listener on close and delivers no queued events to the closed owner', () => {
    const socket = new EventTarget();
    const remove = vi.spyOn(socket, 'removeEventListener');
    const h = handlers();
    const dispose = bindTerminalSocketListeners(socket, h);
    socket.dispatchEvent(new Event('open'));
    socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1]) }));
    socket.dispatchEvent(new Event('close'));
    socket.dispatchEvent(new Event('open'));
    socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([2]) }));
    socket.dispatchEvent(new Event('close'));
    dispose();
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.message).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(remove.mock.calls.map(([name]) => name).sort()).toEqual(['close', 'message', 'open']);
  });
  it('retires old attachments without disrupting a replacement or fabricating a close', () => {
    const old = new EventTarget();
    const next = new EventTarget();
    const oldHandlers = handlers();
    const nextHandlers = handlers();
    const retireOld = bindTerminalSocketListeners(old, oldHandlers);
    const retireNext = bindTerminalSocketListeners(next, nextHandlers);
    retireOld();
    old.dispatchEvent(new MessageEvent('message', { data: 'late old control' }));
    old.dispatchEvent(new Event('close'));
    next.dispatchEvent(new MessageEvent('message', { data: 'current control' }));
    expect(oldHandlers.message).not.toHaveBeenCalled();
    expect(oldHandlers.close).not.toHaveBeenCalled();
    expect(nextHandlers.message).toHaveBeenCalledOnce();
    retireNext();
  });
});
