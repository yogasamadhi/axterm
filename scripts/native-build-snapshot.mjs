import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Capture one mutable native build directory and return an idempotent restoration function.
 * electron-builder must consume its Electron ABI output before restoration runs.
 *
 * @param {string} target
 */
export async function snapshotNativeBuildDirectory(target) {
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'axterm-native-build-'));
  const snapshotPath = join(snapshotRoot, 'saved');
  const existed = await lstat(target).then(
    () => true,
    () => false,
  );
  if (existed)
    await cp(target, snapshotPath, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });

  let restored = false;
  return async () => {
    if (restored) return;
    await rm(target, { recursive: true, force: true });
    if (existed) {
      await mkdir(dirname(target), { recursive: true });
      await cp(snapshotPath, target, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    }
    await rm(snapshotRoot, { recursive: true, force: true });
    restored = true;
  };
}
