import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { resolveLevel3PackagedArtifact } from './level3-packaged-artifact';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';

/** Visual/interaction journeys execute the real main entry, never a direct Shell constructor. */
type LaunchOptions = Omit<NonNullable<Parameters<typeof electron.launch>[0]>, 'env'> & {
  env?: NodeJS.ProcessEnv;
};
export async function launchLevel3Desktop(options: LaunchOptions) {
  const args = options.args ?? [];
  const configured = args.find((arg) => arg.startsWith('--user-data-dir='))?.slice(16);
  if (!configured) throw new Error('An isolated test home is required');
  const [home, temporary] = await Promise.all([realpath(configured), realpath(tmpdir())]);
  const suffix = relative(temporary, home);
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`))
    throw new Error('Desktop test home must be a temporary descendant');
  const artifact = await resolveLevel3PackagedArtifact({
    result: process.env.AXTERM_LEVEL3_PACKAGE_RESULT?.trim(),
    candidate: process.env.AXTERM_LOCAL_OPTIMIZATION_APP?.trim(),
  });
  const app = await electron.launch({
    ...options,
    ...(artifact ? { executablePath: artifact.executablePath, cwd: home } : {}),
    args: [
      ...(artifact ? [] : [resolve('apps/desktop/lib/shell/main.js')]),
      ...args.filter(
        (arg) => arg !== resolve('apps/desktop') && !arg.startsWith('--user-data-dir='),
      ),
    ],
    env: {
      ...Object.fromEntries(
        Object.entries(options.env ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ELECTRON_RENDERER_URL: '',
      ELECTRON_RUN_AS_NODE: '',
      HOME: home,
      ZDOTDIR: home,
      AXTERM_HOME: home,
      AXTERM_LEGACY_HOME: resolve(home, 'absent-legacy-source'),
      ...(process.platform === 'win32' ? {} : { SHELL: '/bin/bash' }),
      NODE_OPTIONS: '',
      NODE_PATH: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      ...(artifact
        ? { PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin' }
        : {}),
    },
  });
  try {
    if (artifact) {
      const layout = await app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        path: app.getAppPath(),
      }));
      expect(layout).toEqual({
        packaged: true,
        path: artifact.appDirectory,
      });
    }
    return app;
  } catch (error) {
    await closeLevel3Desktop(app);
    throw error;
  }
}

/** Explicitly accept only the real active-task exit prompt in the test's isolated app. */
export async function closeLevel3Desktop(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (options: Electron.MessageBoxOptions) => {
      if (
        options.message !== 'Active tasks may be interrupted.' ||
        options.buttons?.join(',') !== 'Cancel,Quit'
      )
        throw new Error('Unexpected Desktop dialog during test shutdown');
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  await app.close();
}
