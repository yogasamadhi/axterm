import type { Menu, MenuItemConstructorOptions, Tray } from 'electron';

interface TrayNativePort {
  createTray(): Pick<Tray, 'setToolTip' | 'setContextMenu' | 'destroy' | 'isDestroyed'>;
  buildMenu(items: MenuItemConstructorOptions[]): Menu;
}

/** One application-owned menu bar item, independent of windows and Runtime generations. */
export class MacosTrayController {
  private tray: ReturnType<TrayNativePort['createTray']> | undefined;
  private closed = false;

  constructor(
    private readonly productName: string,
    private readonly showWindow: () => void,
    private readonly native: TrayNativePort,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly actions?: { newWindow(): void; quit(): void },
  ) {}

  start(): void {
    if (this.closed || this.tray || this.platform !== 'darwin') return;
    const tray = this.native.createTray();
    try {
      tray.setToolTip(this.productName);
      tray.setContextMenu(
        this.native.buildMenu([
          {
            id: 'axterm-show-window',
            label: this.productName,
            click: () => {
              if (!this.closed) this.showWindow();
            },
          },
          { type: 'separator' },
          ...(this.actions
            ? [
                {
                  id: 'axterm-new-window',
                  label: 'New Window',
                  click: () => {
                    if (!this.closed) this.actions?.newWindow();
                  },
                },
                {
                  id: 'axterm-quit',
                  label: 'Quit',
                  click: () => {
                    if (!this.closed) this.actions?.quit();
                  },
                },
              ]
            : [{ role: 'quit' as const }]),
        ]),
      );
      this.tray = tray;
    } catch (error) {
      tray.destroy();
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    const tray = this.tray;
    this.tray = undefined;
    if (!tray || tray.isDestroyed()) return;
    try {
      tray.setContextMenu(null);
    } finally {
      tray.destroy();
    }
  }
}
