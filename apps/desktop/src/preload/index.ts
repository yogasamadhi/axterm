import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBootstrapApi } from '@workspace/contracts/desktop';

const bootstrap: DesktopBootstrapApi = {
  resolve: () => ipcRenderer.invoke('desktop:bootstrap'),
};
contextBridge.exposeInMainWorld('desktopBootstrap', Object.freeze(bootstrap));
