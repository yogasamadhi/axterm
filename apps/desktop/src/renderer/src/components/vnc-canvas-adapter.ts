import type { createRuntimeClient } from '@workspace/client';
import type { VncCredentialBootstrap, VncSession } from '@workspace/contracts';
import type RFB from '@novnc/novnc';
import { registerAuthenticatedWebSocket } from './authenticated-websocket';

type Client = ReturnType<typeof createRuntimeClient>;

export interface VncCanvasCallbacks {
  onState(state: 'loading' | 'ready' | 'closed' | 'failed', message?: string): void;
  onRemoteClipboard?(text: string): void;
  onDesktopName?(name: string): void;
  onServerVerification?(summary: string): void;
  messages: {
    connected: string;
    closed: string;
    disconnected: string;
    sessionFailed: string;
    securityFailure(status?: number): string;
    credentialsRequired(types: readonly string[]): string;
    serverIdentity: string;
  };
}

/** Owns the noVNC object and its transient credentials outside React state. */
export class VncCanvasAdapter {
  private rfb: RFB | undefined;
  private cleanupSocketRegistration: (() => void) | undefined;
  private credentials: VncCredentialBootstrap | undefined;
  private disposed = false;

  constructor(
    private readonly client: Client,
    private readonly id: string,
    private readonly target: HTMLElement,
    private readonly metadata: VncSession,
    private readonly callbacks: VncCanvasCallbacks,
  ) {}

  async connect(): Promise<void> {
    this.callbacks.onState('loading');
    try {
      const [{ default: Rfb }, descriptor, credentials] = await Promise.all([
        import('@novnc/novnc'),
        this.client.vncSocketDescriptor(this.id),
        this.client.claimVncCredentials(this.id),
      ]);
      if (this.disposed) {
        credentials.password = '';
        return;
      }
      this.credentials = credentials;
      this.cleanupSocketRegistration = registerAuthenticatedWebSocket(
        descriptor.url,
        descriptor.protocols,
      );
      const rfb = new Rfb(this.target, descriptor.url, {
        shared: this.metadata.shared,
        credentials,
      });
      this.rfb = rfb;
      this.cleanupSocketRegistration();
      this.cleanupSocketRegistration = undefined;
      rfb.viewOnly = this.metadata.viewOnly;
      rfb.clipViewport = this.metadata.clipViewport;
      rfb.scaleViewport = this.metadata.scaleViewport;
      rfb.qualityLevel = this.metadata.qualityLevel;
      rfb.compressionLevel = this.metadata.compressionLevel;
      rfb.showDotCursor = this.metadata.showDotCursor;
      rfb.background = '#101216';
      rfb.addEventListener('connect', this.handleConnect);
      rfb.addEventListener('disconnect', this.handleDisconnect);
      rfb.addEventListener('securityfailure', this.handleSecurityFailure);
      rfb.addEventListener('credentialsrequired', this.handleCredentialsRequired);
      rfb.addEventListener('clipboard', this.handleClipboard);
      rfb.addEventListener('desktopname', this.handleDesktopName);
      rfb.addEventListener('serververification', this.handleServerVerification);
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
    if (this.rfb) this.rfb.viewOnly = value;
  }

  setClipViewport(value: boolean) {
    if (this.rfb) this.rfb.clipViewport = value;
  }

  setScaleViewport(value: boolean) {
    if (this.rfb) this.rfb.scaleViewport = value;
  }

  setQualityLevel(value: number) {
    if (this.rfb) this.rfb.qualityLevel = value;
  }

  setCompressionLevel(value: number) {
    if (this.rfb) this.rfb.compressionLevel = value;
  }

  sendCtrlAltDelete() {
    this.rfb?.sendCtrlAltDel();
  }

  approveServer() {
    this.rfb?.approveServer();
  }

  focus() {
    this.rfb?.focus({ preventScroll: true });
  }

  blur() {
    this.rfb?.blur();
  }

  async syncClipboard() {
    if (!this.rfb || !this.metadata.clipboard || this.rfb.viewOnly) return;
    const text = await navigator.clipboard.readText().catch(() => '');
    if (text) this.rfb.clipboardPasteFrom(text);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanupSocketRegistration?.();
    this.cleanupSocketRegistration = undefined;
    this.clearCredentials();
    const rfb = this.rfb;
    this.rfb = undefined;
    if (!rfb) return;
    rfb.removeEventListener('connect', this.handleConnect);
    rfb.removeEventListener('disconnect', this.handleDisconnect);
    rfb.removeEventListener('securityfailure', this.handleSecurityFailure);
    rfb.removeEventListener('credentialsrequired', this.handleCredentialsRequired);
    rfb.removeEventListener('clipboard', this.handleClipboard);
    rfb.removeEventListener('desktopname', this.handleDesktopName);
    rfb.removeEventListener('serververification', this.handleServerVerification);
    rfb.disconnect();
    this.target.replaceChildren();
  }

  private readonly handleConnect = () => {
    this.clearCredentials();
    this.callbacks.onState('ready', this.callbacks.messages.connected);
    this.rfb?.focus({ preventScroll: true });
  };

  private readonly handleDisconnect = (event: Event) => {
    this.clearCredentials();
    const detail = customDetail<{ clean?: boolean }>(event);
    this.callbacks.onState(
      detail.clean ? 'closed' : 'failed',
      detail.clean ? this.callbacks.messages.closed : this.callbacks.messages.disconnected,
    );
  };

  private readonly handleSecurityFailure = (event: Event) => {
    const detail = customDetail<{ status?: number; reason?: string }>(event);
    this.clearCredentials();
    this.callbacks.onState(
      'failed',
      detail.reason || this.callbacks.messages.securityFailure(detail.status),
    );
  };

  private readonly handleCredentialsRequired = (event: Event) => {
    const detail = customDetail<{ types?: string[] }>(event);
    const credentials = this.credentials;
    if (credentials) {
      this.rfb?.sendCredentials(credentials);
      return;
    }
    this.callbacks.onState(
      'failed',
      this.callbacks.messages.credentialsRequired(detail.types ?? []),
    );
  };

  private readonly handleClipboard = (event: Event) => {
    if (!this.metadata.clipboard) return;
    const detail = customDetail<{ text?: string }>(event);
    if (typeof detail.text === 'string') this.callbacks.onRemoteClipboard?.(detail.text);
  };

  private readonly handleDesktopName = (event: Event) => {
    const detail = customDetail<{ name?: string }>(event);
    if (detail.name) this.callbacks.onDesktopName?.(detail.name);
  };

  private readonly handleServerVerification = (event: Event) => {
    const detail = customDetail<{ type?: string; publickey?: Uint8Array }>(event);
    const suffix = detail.publickey
      ? ` · ${hex(detail.publickey.slice(0, 12))}${detail.publickey.length > 12 ? '…' : ''}`
      : '';
    this.callbacks.onServerVerification?.(
      `${detail.type || this.callbacks.messages.serverIdentity}${suffix}`,
    );
  };

  private clearCredentials() {
    if (!this.credentials) return;
    this.credentials.password = '';
    this.credentials.username = '';
    this.credentials = undefined;
  }
}

function customDetail<T>(event: Event): T {
  return (event as CustomEvent<T>).detail ?? ({} as T);
}

function hex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(':');
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
