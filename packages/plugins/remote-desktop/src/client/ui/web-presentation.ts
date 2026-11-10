import type { NativeWebViewPresentation } from '@axterm/plugin-api/remote-desktop';
import type { WebSessionModel } from '../web-model.ts';
/** UI geometry only: one in-flight intent and one replaceable latest intent. */
export class WebPresentation {
  private visible = false;
  private disposed = false;
  private latest: NativeWebViewPresentation | undefined;
  private running: Promise<void> | undefined;
  private closing?: Promise<void>;
  private last = '';
  private readonly resize: ResizeObserver;
  private readonly overlays: MutationObserver;
  constructor(
    private readonly model: Pick<WebSessionModel, 'present' | 'getSnapshot'>,
    private readonly id: string,
    private readonly generation: string,
    private readonly stage: HTMLElement,
    private readonly failed: () => void,
  ) {
    this.resize = new ResizeObserver(this.sync);
    this.resize.observe(stage);
    this.overlays = new MutationObserver(this.sync);
    this.overlays.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'data-state', 'style', 'class'],
    });
    window.addEventListener('resize', this.sync);
    document.addEventListener('scroll', this.sync, true);
    document.addEventListener('visibilitychange', this.sync);
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.sync();
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.disposed = true;
      this.resize.disconnect();
      this.overlays.disconnect();
      window.removeEventListener('resize', this.sync);
      document.removeEventListener('scroll', this.sync, true);
      document.removeEventListener('visibilitychange', this.sync);
      this.latest = undefined;
      await this.running;
      if (this.current()) await this.model.present(this.id, { visible: false });
    })());
  }
  private current(): boolean {
    const state = this.model.getSnapshot();
    return state.status === 'ready' && state.baseline.generation === this.generation;
  }
  private readonly sync = () => {
    if (this.disposed || !this.current()) return;
    const covered = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="dialog"],[role="alertdialog"],[role="menu"]',
      ),
    ].some((element) => element.getClientRects().length > 0);
    const rect = this.stage.getBoundingClientRect();
    const visible =
      this.visible && !document.hidden && !covered && rect.width > 0 && rect.height > 0;
    const value: NativeWebViewPresentation = visible
      ? {
          visible: true,
          bounds: {
            x: Math.max(0, Math.round(rect.left)),
            y: Math.max(0, Math.round(rect.top)),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          },
        }
      : { visible: false };
    const encoded = JSON.stringify(value);
    if (encoded === this.last) return;
    this.last = encoded;
    this.latest = value;
    this.drain();
  };
  private drain(): void {
    if (this.running) return;
    this.running = (async () => {
      while (this.latest && !this.disposed && this.current()) {
        const next = this.latest;
        this.latest = undefined;
        try {
          await this.model.present(this.id, next);
        } catch {
          this.last = '';
          if (!this.disposed) this.failed();
          break;
        }
      }
    })().finally(() => {
      this.running = undefined;
      if (this.latest && !this.disposed) this.drain();
    });
  }
}
