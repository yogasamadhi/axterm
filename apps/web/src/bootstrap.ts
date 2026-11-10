import type { IndexInjection } from '@axterm/infra-web-server/types';
export type { IndexInjection } from '@axterm/infra-web-server/types';
export interface DesktopBootPayload {
  readonly injections: readonly IndexInjection[];
  readonly streamBaseUrl: string;
  readonly windowId?: string;
  readonly presentationSlot?: string;
  readonly platform: 'darwin' | 'win32' | 'linux';
}
/** Startup only. Credentials, raw IPC, filesystem and business methods are never exposed. */
export interface DesktopBootBridge {
  ready(): Promise<DesktopBootPayload>;
  failed(): Promise<void>;
}
declare global {
  interface Window {
    axtermDesktopBoot?: DesktopBootBridge;
  }
}
