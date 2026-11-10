import { join, resolve } from 'node:path';
import type { ElectronApplication } from '@playwright/test';

/** Replace only the already selected native chooser result, keeping the real grant/Remote path. */
export async function setLevel3NativeSelection(
  app: ElectronApplication,
  path: string,
  kind: 'open-directory' | 'open-file' | 'save-file',
): Promise<void> {
  const layout = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  const module = layout.packaged
    ? join(layout.path, 'lib/shell/file-chooser.js')
    : resolve('apps/desktop/lib/shell/file-chooser.js');
  await app.evaluate(
    (_electron, input) => {
      const { ElectronFileChooser } = process
        .getBuiltinModule('node:module')
        .createRequire(input.module)(input.module);
      ElectronFileChooser.prototype.choose = async function (kind: string, signal: AbortSignal) {
        signal.throwIfAborted();
        if (kind !== input.kind) throw new Error('Unexpected native selection kind');
        return input.path;
      };
    },
    { module, path, kind },
  );
}
