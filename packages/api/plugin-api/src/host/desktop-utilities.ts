import type { UpdaterAction, UpdaterStatus } from '../desktop-updater.ts';
export interface NativeExternalUrls {
  open(key: string, url: string, signal: AbortSignal): Promise<void>;
  drain(key: string): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    nativeExternalUrls: NativeExternalUrls;
  }
}

export interface NativeDesktopUpdater {
  status(signal: AbortSignal): Promise<UpdaterStatus>;
  perform(key: string, action: UpdaterAction, signal: AbortSignal): Promise<UpdaterStatus>;
  drain(key: string): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    nativeDesktopUpdater: NativeDesktopUpdater;
  }
}
