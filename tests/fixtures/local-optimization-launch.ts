import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

/** Reuse the same functional journeys against an explicitly installed Mac candidate. */
export async function launchLocalOptimizationApp(options: Parameters<typeof electron.launch>[0]) {
  const candidate = process.env.AXTERM_LOCAL_OPTIMIZATION_APP?.trim();
  if (!candidate) return electron.launch(options);
  if (process.platform !== 'darwin') throw new Error('Local candidate validation requires macOS');
  const artifact = await realpath(candidate);
  const app = await electron.launch({
    ...options,
    executablePath: join(artifact, 'Contents/MacOS/Axterm'),
    args: (options?.args ?? []).filter((arg) => arg !== resolve('apps/desktop')),
    cwd: tmpdir(),
    env: { ...options?.env, ELECTRON_RENDERER_URL: '', PATH: '/usr/bin:/bin' },
  });
  try {
    const layout = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      path: app.getAppPath(),
    }));
    expect(layout.packaged).toBe(true);
    expect(layout.path).toBe(join(artifact, 'Contents/Resources/app.asar'));
    expect(layout.path.startsWith(resolve('apps/desktop'))).toBe(false);
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
