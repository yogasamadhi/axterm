import { chmod, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Create a private temporary credential file without returning the token to presentation code. */
export async function createLaunchTokenFile(
  directory: string,
  token: string,
): Promise<{ path: string; dispose(): Promise<void> }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(directory, 'launch-'));
  const path = join(root, 'credential');
  let disposal: Promise<void> | undefined;
  const dispose = () => (disposal ??= rm(root, { recursive: true, force: true }));
  try {
    await chmod(root, 0o700);
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(token);
      await file.sync();
    } finally {
      await file.close();
    }
    return { path, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
