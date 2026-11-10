import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { CLIENT_PLATFORM_MODULES, validatePlatformSeed } from '../../scripts/client-platform.mjs';
const seed = (keys: string[]) =>
  `export function getStaticModules(){ return {${keys.join(',')}}; }`;
it('accepts the real formatted browser seed and equivalent quoted or identifier keys', async () => {
  await expect(
    validatePlatformSeed(await readFile('apps/web/src/seed.ts', 'utf8')),
  ).resolves.toBeUndefined();
  for (const quote of [true, false]) {
    const keys = CLIENT_PLATFORM_MODULES.map(
      (name) => `${!quote && /^[a-z]+$/.test(name) ? name : JSON.stringify(name)}: namespace`,
    );
    await expect(validatePlatformSeed(seed(keys))).resolves.toBeUndefined();
  }
});
it('rejects missing, extra, duplicate, computed and unprovable seed tables', async () => {
  const keys = CLIENT_PLATFORM_MODULES.map((name) => `${JSON.stringify(name)}: namespace`);
  for (const source of [
    ...keys.map((_, index) => seed(keys.filter((_, candidate) => candidate !== index))),
    seed([...keys, 'unknown: namespace']),
    seed([...keys, keys[0]!]),
    seed([...keys.slice(1), '[key]: namespace']),
    seed([...keys, '...other']),
    'export function getStaticModules(){return other;}',
  ])
    await expect(validatePlatformSeed(source)).rejects.toThrow('CLIENT_PLATFORM_SEED_DRIFT');
});
