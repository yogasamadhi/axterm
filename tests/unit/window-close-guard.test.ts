import { describe, expect, it, vi } from 'vitest';
import { WindowCloseGuard } from '../../apps/desktop/src/main/host-capabilities/window-close-guard';

function createTarget() {
  let destroyed = false;
  return {
    target: {
      close: vi.fn(),
      isDestroyed: () => destroyed,
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

describe('WindowCloseGuard', () => {
  it('allows unguarded and shutdown closes without opening a confirmation', () => {
    const confirm = vi.fn(async () => true);
    const guard = new WindowCloseGuard(confirm);
    const { target } = createTarget();
    const event = { preventDefault: vi.fn() };

    guard.handle(target, event, { confirmBeforeExit: false, bypass: false });
    guard.handle(target, event, { confirmBeforeExit: true, bypass: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('lets a custom close pass without a second native prompt', () => {
    const confirm = vi.fn(async () => true);
    const guard = new WindowCloseGuard(confirm);
    const { target } = createTarget();
    const event = { preventDefault: vi.fn() };

    guard.approveNextClose(target);
    guard.handle(target, event, { confirmBeforeExit: true, bypass: false });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    guard.handle(target, event, { confirmBeforeExit: true, bypass: false });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('serializes pending prompts, keeps a canceled window and passes one approved close', async () => {
    let resolveConfirmation: ((accepted: boolean) => void) | undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (resolveConfirmation = resolve)));
    const guard = new WindowCloseGuard(confirm);
    const { target } = createTarget();
    const first = { preventDefault: vi.fn() };
    const repeated = { preventDefault: vi.fn() };

    guard.handle(target, first, { confirmBeforeExit: true, bypass: false });
    guard.handle(target, repeated, { confirmBeforeExit: true, bypass: false });
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    resolveConfirmation?.(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(target.close).not.toHaveBeenCalled();

    guard.handle(target, first, { confirmBeforeExit: true, bypass: false });
    resolveConfirmation?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(target.close).toHaveBeenCalledOnce();

    const approvedEvent = { preventDefault: vi.fn() };
    guard.handle(target, approvedEvent, { confirmBeforeExit: true, bypass: false });
    expect(approvedEvent.preventDefault).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('does not close a destroyed window after confirmation resolves', async () => {
    const { target, destroy } = createTarget();
    let resolveConfirmation: ((accepted: boolean) => void) | undefined;
    const guard = new WindowCloseGuard(
      () => new Promise<boolean>((resolve) => (resolveConfirmation = resolve)),
    );
    guard.handle(target, { preventDefault: vi.fn() }, { confirmBeforeExit: true, bypass: false });
    destroy();
    resolveConfirmation?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(target.close).not.toHaveBeenCalled();
  });
});
