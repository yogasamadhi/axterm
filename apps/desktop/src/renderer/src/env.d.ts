import type { DesktopBootstrapApi, DesktopDirectoryDropApi } from '@workspace/contracts/desktop';
import './xterm-ligatures';

declare global {
  interface Window {
    desktopBootstrap: DesktopBootstrapApi;
    desktopDirectoryDrop?: DesktopDirectoryDropApi;
  }
}
