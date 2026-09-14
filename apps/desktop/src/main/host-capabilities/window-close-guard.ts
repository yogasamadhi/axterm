import type { BrowserWindow, Event } from 'electron';

type CloseGuardWindow = Pick<BrowserWindow, 'close' | 'isDestroyed'>;
type CloseEvent = Pick<Event, 'preventDefault'>;

/** Serializes one native exit confirmation and lets an approved close pass exactly once. */
export class WindowCloseGuard {
  private readonly approved = new WeakSet<CloseGuardWindow>();
  private readonly pending = new WeakSet<CloseGuardWindow>();

  constructor(private readonly confirm: (target: CloseGuardWindow) => Promise<boolean>) {}

  handle(
    target: CloseGuardWindow,
    event: CloseEvent,
    options: { confirmBeforeExit: boolean; bypass: boolean },
  ): void {
    if (options.bypass || !options.confirmBeforeExit || this.approved.delete(target)) return;
    event.preventDefault();
    if (this.pending.has(target)) return;
    this.pending.add(target);
    void this.confirm(target)
      .then((accepted) => {
        if (!accepted || target.isDestroyed()) return;
        this.approved.add(target);
        target.close();
      })
      .finally(() => this.pending.delete(target));
  }
}
