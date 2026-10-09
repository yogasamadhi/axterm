declare module '@novnc/novnc' {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket | RTCDataChannel,
      options?: { shared?: boolean; credentials?: RfbCredentials },
    );
    viewOnly: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;
    readonly capabilities: { power: boolean };
    approveServer(): void;
    sendCredentials(credentials: RfbCredentials): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
  }
}
