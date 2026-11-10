import { parseKeyboardRequest, parseWindowPresentationState } from '@axterm/plugin-api/shortcuts';
import type {
  AxtermKeyboardApi,
  AxtermKeyboardRequest,
  DesktopShortcutInput,
} from '@axterm/plugin-api/shortcuts';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { DroppedDirectories } from './directory-drop.ts';
import type { DesktopBootBridge, DesktopBootPayload } from '@axterm/web/bootstrap';
if (process.isMainFrame && location.protocol === 'axterm-app:' && location.hostname === 'app') {
  const bridge: DesktopBootBridge = Object.freeze({
    ready: () =>
      ipcRenderer.invoke('desktop:bootstrap', { type: 'ready' }) as Promise<DesktopBootPayload>,
    failed: () =>
      ipcRenderer.invoke('desktop:bootstrap', {
        type: 'failed',
        code: 'CLIENT_BOOT_FAILED',
      }) as Promise<void>,
  });
  contextBridge.exposeInMainWorld('axtermDesktopBoot', bridge);
  const keyboardRequest = (request: AxtermKeyboardRequest): Promise<void> =>
    ipcRenderer.invoke('desktop:keyboard', parseKeyboardRequest(request)) as Promise<void>;
  const keyboard: AxtermKeyboardApi = Object.freeze<AxtermKeyboardApi>({
    configure: (generation, definitions, snapshot) =>
      keyboardRequest({ type: 'configure', generation, definitions, snapshot }),
    recording: (active) => keyboardRequest({ type: 'recording', active }),
    clear: () => keyboardRequest({ type: 'clear' }),
    windowAction: (generation, action) => keyboardRequest({ type: 'window', generation, action }),
    windowState: async (generation) =>
      parseWindowPresentationState(
        await ipcRenderer.invoke(
          'desktop:keyboard',
          parseKeyboardRequest({ type: 'window-state', generation }),
        ),
      ),
    closeWindow: (revision) => keyboardRequest({ type: 'close', revision }),
    subscribe(listener) {
      const receive = (_event: Electron.IpcRendererEvent, input: DesktopShortcutInput) =>
        listener(input);
      ipcRenderer.on('desktop:keyboard-input', receive);
      return () => {
        ipcRenderer.removeListener('desktop:keyboard-input', receive);
      };
    },
  });
  contextBridge.exposeInMainWorld('axtermDesktopKeyboard', keyboard);

  const collector = new DroppedDirectories((file) => webUtils.getPathForFile(file));
  window.addEventListener(
    'drop',
    (event) => {
      if (
        !event.isTrusted ||
        !(event.target instanceof Element) ||
        !event.target.closest('[data-axterm-directory-drop]')
      )
        return;
      const ownerToken =
        event.target
          .closest('[data-axterm-directory-drop]')
          ?.getAttribute('data-axterm-directory-drop') ?? '';
      if (ownerToken && !/^[0-9a-f-]{36}$/u.test(ownerToken)) return;
      if (
        !Array.from(event.dataTransfer?.items ?? []).some(
          (item) => item.kind === 'file' && item.webkitGetAsEntry()?.isDirectory,
        )
      )
        return;
      collector.capture(event, ownerToken ? 32 : 1);
      event.preventDefault();
      event.stopImmediatePropagation();
      void ipcRenderer.invoke('desktop:directory-drop', collector.takePaths()).then(
        (result) =>
          window.postMessage(
            {
              type: 'axterm:native-directory-drop',
              ticket: result.ticket,
              tickets: result.tickets,
              ownerToken,
            },
            location.origin,
          ),
        () =>
          window.postMessage(
            { type: 'axterm:native-directory-drop', failed: true, ownerToken },
            location.origin,
          ),
      );
    },
    true,
  );
}
