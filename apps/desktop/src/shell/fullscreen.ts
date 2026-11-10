import type { BrowserWindow } from 'electron';
type FullscreenWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isFocused' | 'isFullScreen' | 'setFullScreen'
> &
  Partial<Pick<BrowserWindow, 'isSimpleFullScreen' | 'setSimpleFullScreen'>>;
export function desktopWindowFullscreen(window: FullscreenWindow): boolean {
  if (window.isDestroyed()) throw Error('WINDOW_ACTION_UNAVAILABLE');
  return window.isFullScreen() || (window.isSimpleFullScreen?.() ?? false);
}
/** Retained native/simple macOS fallback; this controls only the bridge's already-owned window. */
export function toggleDesktopFullscreen(
  window: FullscreenWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  if (window.isDestroyed()) throw Error('WINDOW_ACTION_UNAVAILABLE');
  const native = window.isFullScreen(),
    simple = window.isSimpleFullScreen?.() ?? false;
  if (simple) window.setSimpleFullScreen?.(false);
  else if (native) window.setFullScreen(false);
  else if (platform === 'darwin' && !window.isFocused() && window.setSimpleFullScreen)
    window.setSimpleFullScreen(true);
  else window.setFullScreen(true);
}
