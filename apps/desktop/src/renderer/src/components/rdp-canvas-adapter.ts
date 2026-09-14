import type { createRuntimeClient } from '@workspace/client';
import type { RdpCredentialBootstrap, RdpSession } from '@workspace/contracts';
import type initIronRdp from 'ironrdp-wasm';
import type {
  ClipboardData,
  DesktopSize,
  DeviceEvent,
  Extension,
  InputTransaction,
  Session,
  SessionBuilder,
  setup as setupIronRdp,
} from 'ironrdp-wasm';
import { registerAuthenticatedWebSocket } from './authenticated-websocket';

type Client = ReturnType<typeof createRuntimeClient>;
interface IronRdpModule {
  default: typeof initIronRdp;
  setup: typeof setupIronRdp;
  ClipboardData: typeof ClipboardData;
  DesktopSize: typeof DesktopSize;
  DeviceEvent: typeof DeviceEvent;
  Extension: typeof Extension;
  InputTransaction: typeof InputTransaction;
  SessionBuilder: typeof SessionBuilder;
}

let modulePromise: Promise<IronRdpModule> | undefined;

async function loadIronRdp(): Promise<IronRdpModule> {
  modulePromise ??= import('ironrdp-wasm').then(async (module) => {
    await module.default();
    module.setup('warn');
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
  private cleanupSocketRegistration: (() => void) | undefined;
  private inputCleanup: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly client: Client,
    private readonly id: string,
    private readonly canvas: HTMLCanvasElement,
    private readonly metadata: RdpSession,
    private readonly callbacks: RdpCanvasCallbacks,
  ) {}

  async connect(): Promise<void> {
    this.callbacks.onState('loading');
    let credentials: RdpCredentialBootstrap | undefined;
    try {
      const [module, descriptor, claimed] = await Promise.all([
        loadIronRdp(),
        this.client.rdpSocketDescriptor(this.id),
        this.client.claimRdpCredentials(this.id),
      ]);
      if (this.disposed) return;
      this.module = module;
      credentials = claimed;
      this.cleanupSocketRegistration = registerAuthenticatedWebSocket(
        descriptor.url,
        descriptor.protocols,
      );
      const builder = new module.SessionBuilder();
      const desktopSize = new module.DesktopSize(this.metadata.width, this.metadata.height);
      builder.username(credentials.username);
      builder.password(credentials.password);
      if (credentials.domain) builder.serverDomain(credentials.domain);
      builder.destination(credentials.destination);
      builder.proxyAddress(descriptor.url);
      builder.authToken('none');
      builder.desktopSize(desktopSize);
      builder.renderCanvas(this.canvas);
      builder.extension(new module.Extension('enable_credssp', true));
      if (this.metadata.clipboard) {
        builder.remoteClipboardChangedCallback((data: ClipboardData) => {
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
      this.cleanupSocketRegistration?.();
      this.cleanupSocketRegistration = undefined;
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
      void this.session
        .run()
        .then((info) => this.callbacks.onState('closed', info.reason()))
        .catch((error: unknown) =>
          this.callbacks.onState('failed', rdpErrorMessage(error, this.callbacks.fallbackError)),
        );
    } catch (error) {
      if (credentials) credentials.password = '';
      this.cleanupSocketRegistration?.();
      this.cleanupSocketRegistration = undefined;
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
    const tx = new this.module.InputTransaction();
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
          ? this.module.DeviceEvent.keyPressed(code)
          : this.module.DeviceEvent.keyReleased(code),
      );
    this.session.applyInputs(tx);
  }

  async syncClipboard() {
    if (!this.session || !this.module || !this.metadata.clipboard) return;
    const text = await navigator.clipboard.readText().catch(() => '');
    if (!text) return;
    const data = new this.module.ClipboardData();
    data.addText('text/plain', text);
    await this.session.onClipboardPaste(data);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanupSocketRegistration?.();
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
      const code = KEY_SCANCODES[event.code];
      if (code === undefined) return;
      const transaction = new this.module.InputTransaction();
      transaction.addEvent(
        pressed
          ? this.module.DeviceEvent.keyPressed(code)
          : this.module.DeviceEvent.keyReleased(code),
      );
      this.session.applyInputs(transaction);
    };
    const keydown = (event: KeyboardEvent) => applyKey(event, true);
    const keyup = (event: KeyboardEvent) => applyKey(event, false);
    const mousemove = (event: MouseEvent) => {
      if (!this.session || !this.module) return;
      const point = canvasPoint(canvas, event);
      const transaction = new this.module.InputTransaction();
      transaction.addEvent(this.module.DeviceEvent.mouseMove(point.x, point.y));
      this.session.applyInputs(transaction);
    };
    const mousebutton = (event: MouseEvent, pressed: boolean) => {
      event.preventDefault();
      canvas.focus();
      if (!this.session || !this.module) return;
      const transaction = new this.module.InputTransaction();
      transaction.addEvent(
        pressed
          ? this.module.DeviceEvent.mouseButtonPressed(event.button)
          : this.module.DeviceEvent.mouseButtonReleased(event.button),
      );
      this.session.applyInputs(transaction);
    };
    const mousedown = (event: MouseEvent) => mousebutton(event, true);
    const mouseup = (event: MouseEvent) => mousebutton(event, false);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!this.session || !this.module) return;
      const transaction = new this.module.InputTransaction();
      if (event.deltaY)
        transaction.addEvent(
          this.module.DeviceEvent.wheelRotations(true, event.deltaY > 0 ? -1 : 1, 1),
        );
      if (event.deltaX)
        transaction.addEvent(
          this.module.DeviceEvent.wheelRotations(false, event.deltaX > 0 ? -1 : 1, 1),
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

function rdpErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'backtrace' in error) {
    try {
      return String((error as { backtrace(): string }).backtrace());
    } catch {
      return fallback;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

// RDP set-1 scan codes. Extended keys retain the 0xE000 prefix expected by IronRDP.
const KEY_SCANCODES: Readonly<Record<string, number>> = {
  Escape: 0x0001,
  Digit1: 0x0002,
  Digit2: 0x0003,
  Digit3: 0x0004,
  Digit4: 0x0005,
  Digit5: 0x0006,
  Digit6: 0x0007,
  Digit7: 0x0008,
  Digit8: 0x0009,
  Digit9: 0x000a,
  Digit0: 0x000b,
  Minus: 0x000c,
  Equal: 0x000d,
  Backspace: 0x000e,
  Tab: 0x000f,
  KeyQ: 0x0010,
  KeyW: 0x0011,
  KeyE: 0x0012,
  KeyR: 0x0013,
  KeyT: 0x0014,
  KeyY: 0x0015,
  KeyU: 0x0016,
  KeyI: 0x0017,
  KeyO: 0x0018,
  KeyP: 0x0019,
  BracketLeft: 0x001a,
  BracketRight: 0x001b,
  Enter: 0x001c,
  ControlLeft: 0x001d,
  KeyA: 0x001e,
  KeyS: 0x001f,
  KeyD: 0x0020,
  KeyF: 0x0021,
  KeyG: 0x0022,
  KeyH: 0x0023,
  KeyJ: 0x0024,
  KeyK: 0x0025,
  KeyL: 0x0026,
  Semicolon: 0x0027,
  Quote: 0x0028,
  Backquote: 0x0029,
  ShiftLeft: 0x002a,
  Backslash: 0x002b,
  KeyZ: 0x002c,
  KeyX: 0x002d,
  KeyC: 0x002e,
  KeyV: 0x002f,
  KeyB: 0x0030,
  KeyN: 0x0031,
  KeyM: 0x0032,
  Comma: 0x0033,
  Period: 0x0034,
  Slash: 0x0035,
  ShiftRight: 0x0036,
  NumpadMultiply: 0x0037,
  AltLeft: 0x0038,
  Space: 0x0039,
  CapsLock: 0x003a,
  F1: 0x003b,
  F2: 0x003c,
  F3: 0x003d,
  F4: 0x003e,
  F5: 0x003f,
  F6: 0x0040,
  F7: 0x0041,
  F8: 0x0042,
  F9: 0x0043,
  F10: 0x0044,
  F11: 0x0057,
  F12: 0x0058,
  ControlRight: 0xe01d,
  AltRight: 0xe038,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
  MetaLeft: 0xe05b,
  MetaRight: 0xe05c,
};
