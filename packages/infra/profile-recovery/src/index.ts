// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@axterm/infra-atomic-write';

export const PROFILE_RECOVERY_MARKER = '.axterm-recovery.json';
function directory(home: string, profile: string): string {
  if (!isAbsolute(home) || !/^[a-z][a-z0-9-]*$/u.test(profile))
    throw new Error('PROFILE_RECOVERY_INVALID');
  return join(home, 'profiles', profile);
}
/** Any marker, including an interrupted or damaged intent, keeps external code disabled. */
export function profileRecoveryActive(home: string, profile: string): boolean {
  try {
    lstatSync(join(directory(home, profile), PROFILE_RECOVERY_MARKER));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('PROFILE_RECOVERY_UNAVAILABLE', { cause: error });
  }
}
/** Native/offline bootstrap operation. Never imports or parses Profile code or configuration. */
export async function prepareProfileRecovery(home: string, profile: string): Promise<void> {
  const dir = directory(home, profile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await withFileLock(
    join(dir, 'profile-runtime'),
    async () => {
      const marker = join(dir, PROFILE_RECOVERY_MARKER);
      const backup = `cordis.patch.${Date.now()}-${randomUUID()}.backup.yml`;
      // Commit the fail-closed intent before changing the patch; retries retain prior backups.
      await writeFileAtomic(
        marker,
        JSON.stringify({ version: 1, profile, backup, phase: 'preparing' }),
        {
          mode: 0o600,
          dirMode: 0o700,
        },
      );
      let present = true;
      try {
        await rename(join(dir, 'cordis.patch.yml'), join(dir, backup));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        present = false;
      }
      await writeFileAtomic(
        marker,
        JSON.stringify({ version: 1, profile, backup: present ? backup : null, phase: 'ready' }),
        {
          mode: 0o600,
          dirMode: 0o700,
        },
      );
    },
    { waitMs: 0 },
  );
}

/** Explicit offline action. Backups are never restored or executed by clearing this marker. */
export async function clearProfileRecovery(
  home: string,
  profile: string,
  confirmed: boolean,
): Promise<void> {
  if (!confirmed) throw new Error('PROFILE_RECOVERY_CONFIRMATION_REQUIRED');
  const dir = directory(home, profile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await withFileLock(
    join(dir, 'profile-runtime'),
    () => rm(join(dir, PROFILE_RECOVERY_MARKER), { force: true }),
    { waitMs: 0 },
  );
}
