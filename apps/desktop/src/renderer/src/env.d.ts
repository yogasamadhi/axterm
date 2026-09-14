import type { DesktopBootstrapApi } from '@workspace/contracts/desktop';
import './xterm-ligatures';

declare global {
  interface Window {
    desktopBootstrap: DesktopBootstrapApi;
  }
}
