import { app, dialog } from 'electron';
import { parsePanelFrame, type PanelFrame } from './native-panel-protocol.ts';

/** Native shell helper only: never resolve a Profile or initialize product storage. */
if (!process.connected || !process.send) app.exit(1);
app.name = 'Axterm';
process.once('disconnect', () => app.exit(1));
let admitted = false;
const deadline = setTimeout(() => app.exit(1), 305_000);
function send(frame: PanelFrame): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('NATIVE_PANEL_CLOSED'));
      return;
    }
    process.send(parsePanelFrame(frame), (error) =>
      error ? reject(new Error('NATIVE_PANEL_IO')) : resolve(),
    );
  });
}
process.on('message', (value) => {
  let frame: PanelFrame;
  try {
    frame = parsePanelFrame(value);
  } catch {
    app.exit(1);
    return;
  }
  if (admitted || frame.type !== 'select') {
    app.exit(1);
    return;
  }
  admitted = true;
  void (async () => {
    await app.whenReady();
    app.focus({ steal: true });
    const selection =
      frame.selection === 'save-file'
        ? dialog.showSaveDialog({ title: 'Axterm' })
        : dialog.showOpenDialog({
            title: 'Axterm',
            properties: frame.selection === 'open-directory' ? ['openDirectory'] : ['openFile'],
          });
    await send({ kind: 'axterm-native-panel', version: 1, id: frame.id, type: 'ready' });
    const result = await selection;
    const path = result.canceled
      ? null
      : (('filePath' in result ? result.filePath : result.filePaths[0]) ?? null);
    await send({ kind: 'axterm-native-panel', version: 1, id: frame.id, type: 'result', path });
    clearTimeout(deadline);
    app.exit(0);
  })().catch(() => app.exit(1));
});
