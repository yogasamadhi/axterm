import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopBootstrapApi, DesktopDirectoryDropApi } from '@workspace/contracts/desktop';

import { DroppedDirectories } from './dropped-directories';

const bootstrap: DesktopBootstrapApi = {
  resolve: () => ipcRenderer.invoke('desktop:bootstrap'),
};
contextBridge.exposeInMainWorld('desktopBootstrap', Object.freeze(bootstrap));

const droppedDirectories = new DroppedDirectories((file) => webUtils.getPathForFile(file));
const captureDrop = (event: DragEvent) => droppedDirectories.capture(event);
const directoryDrop: DesktopDirectoryDropApi = {
  takePaths: () => droppedDirectories.takePaths(),
};
window.addEventListener('drop', captureDrop, true);
window.addEventListener(
  'pagehide',
  () => {
    window.removeEventListener('drop', captureDrop, true);
    droppedDirectories.clear();
  },
  { once: true },
);
contextBridge.exposeInMainWorld('desktopDirectoryDrop', Object.freeze(directoryDrop));
