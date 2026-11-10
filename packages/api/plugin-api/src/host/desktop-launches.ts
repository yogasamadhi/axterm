import type {} from '@deepseek-ai/cordis';
import type { DesktopLaunch } from '../session-intents.ts';
/** Startup-owned native input port. No business service dispatch is exposed. */
export interface NativeDesktopLaunches {
  next(windowId: string, signal: AbortSignal): Promise<DesktopLaunch | null>;
}
