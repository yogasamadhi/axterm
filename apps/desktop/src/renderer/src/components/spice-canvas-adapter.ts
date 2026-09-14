import type { createRuntimeClient } from '@workspace/client';
import type { SpiceCredentialBootstrap, SpiceSession } from '@workspace/contracts';
import type { SpiceMainConn as SpiceMainConnection } from 'spice-client';
import { registerAuthenticatedWebSocket } from './authenticated-websocket';

type Client = ReturnType<typeof createRuntimeClient>;

export interface SpiceCanvasCallbacks {
  onState(state: 'loading' | 'ready' | 'closed' | 'failed', message?: string): void;
  messages: {
    connecting: string;
    connected: string;
    closed: string;
    failed: string;
    sessionFailed: string;
  };
}

/** Owns the spice-client object and transient ticket outside React state. */
export class SpiceCanvasAdapter {
  private connection: SpiceMainConnection | undefined;
  private credentials: SpiceCredentialBootstrap | undefined;
  private cleanupSocketRegistration: (() => void) | undefined;
  private credentialTimer: number | undefined;
  private viewOnly: boolean;
  private disposed = false;

  constructor(
    private readonly client: Client,
    private readonly id: string,
    private readonly target: HTMLElement,
    private readonly metadata: SpiceSession,
    private readonly callbacks: SpiceCanvasCallbacks,
  ) {
    this.viewOnly = metadata.viewOnly;
  }

  async connect(): Promise<void> {
    this.callbacks.onState('loading', this.callbacks.messages.connecting);
    try {
      const [module, descriptor, credentials] = await Promise.all([
        import('spice-client'),
        this.client.spiceSocketDescriptor(this.id),
        this.client.claimSpiceCredentials(this.id),
      ]);
      if (this.disposed) {
        credentials.password = '';
        return;
      }
      this.credentials = credentials;
      this.target.id = `spice-screen-${this.id}`;
      this.cleanupSocketRegistration = registerAuthenticatedWebSocket(
        descriptor.url,
        descriptor.protocols,
        16,
      );
      this.installInputBoundary();
      const connection = new module.SpiceMainConn({
        uri: descriptor.url,
        password: credentials.password,
        screen_id: this.target.id,
        scale_view: this.metadata.scaleViewport,
        onsuccess: () => {
          if (this.disposed) return;
          this.callbacks.onState('ready', this.callbacks.messages.connected);
          // Child channels inherit the ticket shortly after MAIN_INIT. Keep it
          // only for that bounded window, then overwrite every vendor copy.
          this.credentialTimer = window.setTimeout(() => this.clearCredentials(), 5_000);
        },
        onerror: (error: unknown) => {
          this.clearCredentials();
          if (!this.disposed)
            this.callbacks.onState(
              'failed',
              errorMessage(error, this.callbacks.messages.sessionFailed),
            );
        },
        onagent: () => undefined,
      });
      this.connection = connection;
      connection.on('connection_status', this.handleConnectionStatus);
      this.setScaleViewport(this.metadata.scaleViewport);
    } catch (error) {
      this.clearCredentials();
      this.cleanupSocketRegistration?.();
      this.cleanupSocketRegistration = undefined;
      if (!this.disposed)
        this.callbacks.onState(
          'failed',
          errorMessage(error, this.callbacks.messages.sessionFailed),
        );
    }
  }

  setViewOnly(value: boolean) {
    this.viewOnly = value;
  }

  setScaleViewport(value: boolean) {
    if (this.connection) this.connection.scale_view = value;
    const canvas = this.target.querySelector('canvas');
    if (canvas) {
      canvas.style.maxWidth = value ? '100%' : 'none';
      canvas.style.maxHeight = value ? '100%' : 'none';
      canvas.style.objectFit = value ? 'contain' : 'fill';
    }
  }

  sendCtrlAltDelete() {
    if (!this.viewOnly && this.connection)
      void import('spice-client').then(({ sendCtrlAltDel }) => sendCtrlAltDel(this.connection!));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearCredentials();
    this.cleanupSocketRegistration?.();
    this.cleanupSocketRegistration = undefined;
    this.removeInputBoundary();
    const connection = this.connection;
    this.connection = undefined;
    if (connection) {
      connection.off('connection_status', this.handleConnectionStatus);
      connection.stop();
    }
    this.target.replaceChildren();
    this.target.removeAttribute('id');
  }

  private readonly handleConnectionStatus = (status: string) => {
    if (this.disposed) return;
    if (status === 'disconnected') {
      this.clearCredentials();
      this.callbacks.onState('closed', this.callbacks.messages.closed);
    } else if (status === 'error') {
      this.clearCredentials();
      this.callbacks.onState('failed', this.callbacks.messages.failed);
    }
  };

  private readonly filterInput = (event: Event) => {
    if (!this.viewOnly) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly correctPointer = (event: Event) => {
    if (!(event instanceof MouseEvent)) return;
    const canvas = this.target.querySelector('canvas');
    if (!canvas?.width || !canvas.height) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const scale = Math.min(bounds.width / canvas.width, bounds.height / canvas.height);
    const x = (event.clientX - bounds.left - (bounds.width - canvas.width * scale) / 2) / scale;
    const y = (event.clientY - bounds.top - (bounds.height - canvas.height * scale) / 2) / scale;
    Object.defineProperty(event, 'offsetX', {
      configurable: true,
      value: Math.max(0, Math.min(x, canvas.width - 1)),
    });
    Object.defineProperty(event, 'offsetY', {
      configurable: true,
      value: Math.max(0, Math.min(y, canvas.height - 1)),
    });
  };

  private installInputBoundary() {
    for (const type of INPUT_EVENTS) this.target.addEventListener(type, this.filterInput, true);
    this.target.addEventListener('mousemove', this.correctPointer, true);
  }

  private removeInputBoundary() {
    for (const type of INPUT_EVENTS) this.target.removeEventListener(type, this.filterInput, true);
    this.target.removeEventListener('mousemove', this.correctPointer, true);
  }

  private clearCredentials() {
    if (this.credentialTimer !== undefined) window.clearTimeout(this.credentialTimer);
    this.credentialTimer = undefined;
    if (this.credentials) this.credentials.password = '';
    this.credentials = undefined;
    if (!this.connection) return;
    this.connection.password = '';
    const children = [
      this.connection.display,
      this.connection.inputs,
      this.connection.cursor,
      ...(this.connection.extra_channels ?? []),
      ...(this.connection.ports ?? []),
    ];
    for (const child of children) if (child) child.password = '';
  }
}

const INPUT_EVENTS = [
  'keydown',
  'keyup',
  'mousedown',
  'mouseup',
  'mousemove',
  'wheel',
  'contextmenu',
] as const;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
