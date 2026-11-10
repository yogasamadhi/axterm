import type { RemoteDesktopCredentials, RdpSession } from '@axterm/plugin-api/remote-desktop';
import type * as IronRdpPackage from '@devolutions/iron-remote-desktop-rdp';
import type { ProtocolSurface } from './workspace-owner.ts';
import type { VendorSocketBinding } from './vendor-sockets.ts';
import { RDP_SCANCODES } from './rdp-scancodes.ts';

type IronRdpModule = typeof IronRdpPackage;
type Session = Awaited<
  ReturnType<InstanceType<IronRdpModule['Backend']['SessionBuilder']>['connect']>
>;
type RemoteClipboard = {
  items(): Array<{ mimeType(): string; value(): unknown }>;
};

let modulePromise: Promise<IronRdpModule> | undefined;

async function loadIronRdp(): Promise<IronRdpModule> {
  modulePromise ??= import('@devolutions/iron-remote-desktop-rdp').then(async (module) => {
    await module.init('warn');
    return module;
  });
  return modulePromise;
}

export interface RdpCanvasCallbacks {
  onState(state: 'loading' | 'ready' | 'closed' | 'failed', message?: string): void;
  onRemoteClipboard?(text: string): void;
  fallbackError: string;
}

/** Keeps the IronRDP vendor object outside React state and product stores. */
export class RdpCanvasAdapter {
  private session: Session | undefined;
  private module: IronRdpModule | undefined;
  private binding: VendorSocketBinding | undefined;
  private readonly lifetime = new AbortController();
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private running: Promise<void> | undefined;
  private inputCleanup: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly surface: ProtocolSurface,
    private readonly id: string,
    private readonly canvas: HTMLCanvasElement,
    private readonly metadata: RdpSession,
    private readonly callbacks: RdpCanvasCallbacks,
  ) {}

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(Error('REMOTE_DESKTOP_SURFACE_CLOSED'));
    return (this.opening ??= this.connectOwned());
  }
  private async connectOwned(): Promise<void> {
    this.callbacks.onState('loading');
    let credentials: RemoteDesktopCredentials | undefined;
    try {
      const module = await loadIronRdp();
      this.lifetime.signal.throwIfAborted();
      const claimed = await this.surface.claimCredentials(this.id, this.lifetime.signal);
      credentials = claimed;
      if (this.disposed) {
        credentials.password = '';
        return;
      }
      this.module = module;
      this.binding = this.surface.bindSocket(this.id, 1);
      const builder = new module.Backend.SessionBuilder();
      const desktopSize = new module.Backend.DesktopSize(this.metadata.width, this.metadata.height);
      builder.username(credentials.username);
      builder.password(credentials.password);
      if (credentials.domain) builder.serverDomain(credentials.domain);
      builder.destination(credentials.destination);
      builder.proxyAddress(this.binding.url);
      builder.authToken('none');
      builder.desktopSize(desktopSize);
      builder.renderCanvas(this.canvas);
      builder.extension(module.enableCredssp(true));
      if (this.metadata.clipboard) {
        builder.remoteClipboardChangedCallback((data: RemoteClipboard) => {
          for (const item of data.items()) {
            if (item.mimeType() === 'text/plain')
              this.callbacks.onRemoteClipboard?.(String(item.value()));
          }
        });
        builder.forceClipboardUpdateCallback(() => void this.syncClipboard());
      }
      builder.setCursorStyleCallbackContext(this.canvas);
      builder.setCursorStyleCallback((style: string) => {
        this.canvas.style.cursor = style || 'default';
      });
      // The local Vault secret is never retained by this adapter after the
      // connect builder consumes it.
      credentials.password = '';
      this.session = await builder.connect();
      if (this.disposed) {
        this.session.shutdown();
        return;
      }
      const size = this.session.desktopSize();
      this.canvas.width = size.width;
      this.canvas.height = size.height;
      this.installInputHandlers();
      this.canvas.focus();
      this.callbacks.onState('ready');
      this.running = this.session
        .run()
        .then(() => {
          if (!this.disposed) this.callbacks.onState('closed');
        })
        .catch((error: unknown) => {
          if (!this.disposed)
            this.callbacks.onState('failed', rdpErrorMessage(error, this.callbacks.fallbackError));
        });
    } catch (error) {
      if (credentials) credentials.password = '';
      if (!this.disposed)
        this.callbacks.onState('failed', rdpErrorMessage(error, this.callbacks.fallbackError));
    }
  }

  resize(width: number, height: number) {
    this.session?.resize(width, height);
    this.canvas.width = width;
    this.canvas.height = height;
  }

  sendCtrlAltDelete() {
    if (!this.session || !this.module) return;
    const tx = new this.module.Backend.InputTransaction();
    for (const [pressed, code] of [
      [true, 0x1d],
      [true, 0x38],
      [true, 0xe053],
      [false, 0xe053],
      [false, 0x38],
      [false, 0x1d],
    ] as const)
      tx.addEvent(
        pressed
          ? this.module.Backend.DeviceEvent.keyPressed(code)
          : this.module.Backend.DeviceEvent.keyReleased(code),
      );
    this.session.applyInputs(tx);
  }

  async syncClipboard() {
    if (!this.session || !this.module || !this.metadata.clipboard) return;
    const text = await navigator.clipboard.readText().catch(() => '');
    if (!text) return;
    const data = new this.module.Backend.ClipboardData();
    data.addText('text/plain', text);
    await this.session.onClipboardPaste(data);
  }

  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.disposed = true;
      this.lifetime.abort();
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.stopVendor()),
        this.binding?.close(),
        this.opening,
        this.running,
      ]);
      const late = await Promise.allSettled([
        Promise.resolve().then(() => this.stopVendor()),
        this.binding?.close(),
      ]);
      if ([...results, ...late].some((value) => value.status === 'rejected'))
        throw Error('REMOTE_DESKTOP_SURFACE_UNDRAINED');
    })());
  }
  private stopVendor() {
    this.inputCleanup?.();
    this.session?.releaseAllInputs();
    this.session?.shutdown();
    this.session = undefined;
  }

  private installInputHandlers() {
    const canvas = this.canvas;
    const applyKey = (event: KeyboardEvent, pressed: boolean) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.session || !this.module) return;
      const code = RDP_SCANCODES[event.code];
      if (code === undefined) return;
      const transaction = new this.module.Backend.InputTransaction();
      transaction.addEvent(
        pressed
          ? this.module.Backend.DeviceEvent.keyPressed(code)
          : this.module.Backend.DeviceEvent.keyReleased(code),
      );
      this.session.applyInputs(transaction);
    };
    const keydown = (event: KeyboardEvent) => applyKey(event, true);
    const keyup = (event: KeyboardEvent) => applyKey(event, false);
    const mousemove = (event: MouseEvent) => {
      if (!this.session || !this.module) return;
      const point = canvasPoint(canvas, event);
      const transaction = new this.module.Backend.InputTransaction();
      transaction.addEvent(this.module.Backend.DeviceEvent.mouseMove(point.x, point.y));
      this.session.applyInputs(transaction);
    };
    const mousebutton = (event: MouseEvent, pressed: boolean) => {
      event.preventDefault();
      canvas.focus();
      if (!this.session || !this.module) return;
      const transaction = new this.module.Backend.InputTransaction();
      transaction.addEvent(
        pressed
          ? this.module.Backend.DeviceEvent.mouseButtonPressed(event.button)
          : this.module.Backend.DeviceEvent.mouseButtonReleased(event.button),
      );
      this.session.applyInputs(transaction);
    };
    const mousedown = (event: MouseEvent) => mousebutton(event, true);
    const mouseup = (event: MouseEvent) => mousebutton(event, false);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!this.session || !this.module) return;
      const transaction = new this.module.Backend.InputTransaction();
      if (event.deltaY)
        transaction.addEvent(
          this.module.Backend.DeviceEvent.wheelRotations(true, event.deltaY > 0 ? -1 : 1, 1),
        );
      if (event.deltaX)
        transaction.addEvent(
          this.module.Backend.DeviceEvent.wheelRotations(false, event.deltaX > 0 ? -1 : 1, 1),
        );
      this.session.applyInputs(transaction);
    };
    const contextmenu = (event: MouseEvent) => event.preventDefault();
    const focus = () => void this.syncClipboard();
    canvas.addEventListener('keydown', keydown);
    canvas.addEventListener('keyup', keyup);
    canvas.addEventListener('mousemove', mousemove);
    canvas.addEventListener('mousedown', mousedown);
    canvas.addEventListener('mouseup', mouseup);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('contextmenu', contextmenu);
    canvas.addEventListener('focus', focus);
    this.inputCleanup = () => {
      canvas.removeEventListener('keydown', keydown);
      canvas.removeEventListener('keyup', keyup);
      canvas.removeEventListener('mousemove', mousemove);
      canvas.removeEventListener('mousedown', mousedown);
      canvas.removeEventListener('mouseup', mouseup);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('contextmenu', contextmenu);
      canvas.removeEventListener('focus', focus);
    };
  }
}

function canvasPoint(canvas: HTMLCanvasElement, event: MouseEvent) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        canvas.width - 1,
        Math.round((event.clientX - bounds.left) * (canvas.width / bounds.width)),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        canvas.height - 1,
        Math.round((event.clientY - bounds.top) * (canvas.height / bounds.height)),
      ),
    ),
  };
}

function rdpErrorMessage(_error: unknown, fallback: string): string {
  return fallback;
}
