import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
async function canonical(path: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = resolve(path);
  for (;;) {
    try {
      return join(await realpath(cursor), ...suffix);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new Error('DESKTOP_HOME_UNAVAILABLE', { cause: error });
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error('DESKTOP_HOME_UNAVAILABLE', { cause: error });
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}
/** Development cannot target the production home, its descendants or a symlink alias. */
export async function resolveShellHome(
  configured: string | undefined,
  packaged: boolean,
  userHome = homedir(),
  migrationValidation = false,
): Promise<string> {
  const productionAllowed = packaged && !migrationValidation;
  if (!configured && !productionAllowed) throw new Error('DEVELOPMENT_HOME_REQUIRED');
  if (configured && !isAbsolute(configured)) throw new Error('AXTERM_HOME_MUST_BE_ABSOLUTE');
  const selected = configured ?? join(userHome, '.axterm');
  if (!productionAllowed) {
    const [home, production] = await Promise.all([
      canonical(selected),
      canonical(join(userHome, '.axterm')),
    ]);
    const insensitive = process.platform === 'darwin' || process.platform === 'win32';
    const suffix = relative(
      insensitive ? production.toLowerCase() : production,
      insensitive ? home.toLowerCase() : home,
    );
    if (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
      throw new Error('DEVELOPMENT_HOME_MUST_BE_ISOLATED');
  }
  return resolve(selected);
}

/** Validation never discovers product data; a product operator can choose a current source. */
export function resolveLegacyShellSource(
  configured: string | undefined,
  packaged: boolean,
  migrationValidation: boolean,
  fallback: string,
): string | undefined {
  if (!packaged || migrationValidation) return undefined;
  if (
    configured !== undefined &&
    (!configured || !isAbsolute(configured) || configured.includes('\0'))
  )
    throw new Error('DESKTOP_LEGACY_HOME_MUST_BE_ABSOLUTE');
  return configured ?? fallback;
}
