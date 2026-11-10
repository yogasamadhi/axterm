import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ownedClientCss } from '../../scripts/client-css.mjs';
import { retainBootstrapCss } from '../../scripts/retain-bootstrap-css.mjs';
it('keeps document bootstrap styles without turning plugin styles into global side effects', () => {
  const plugin = retainBootstrapCss(resolve('.'));
  for (const path of [
    'apps/web/src/auth.module.css',
    'apps/web/src/base.module.css',
    'packages/infra/ui-theme/lib/bootstrap.module.css',
  ]) {
    expect(plugin.transform('export default {}', resolve(path))?.moduleSideEffects).toBe(
      'no-treeshake',
    );
  }
  expect(
    plugin.transform(
      'export default {}',
      resolve('packages/plugins/catalog/src/client/ui/tree/bookmark-tree.module.css'),
    ),
  ).toBeNull();
  expect(
    plugin.transform('export default {}', resolve('packages/framework/loader/lib/index.js')),
  ).toBeNull();
});
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
it('compiles owned CSS Modules to stable class maps and explicit text without executing DOM injection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-owned-css-'));
  directories.push(directory);
  await mkdir(join(directory, 'src/client'), { recursive: true });
  await writeFile(
    join(directory, 'src/client/frame.module.css'),
    '.frame { color: var(--ax-color-text); } .frame[data-state="ready"] { display: grid; }',
  );
  const plugin = ownedClientCss(directory);
  const id = await plugin.resolveId(
    './frame.module.css',
    join(directory, 'lib/types/client/index.js'),
  );
  expect(id).toContain('src/client/frame.module.css');
  const source = await plugin.load(id!);
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(source!).toString('base64')
  );
  expect(module.default.frame).toMatch(/^ax_[a-f0-9]{10}_frame$/);
  expect(module.cssText).toContain('.' + module.default.frame + '[data-state="ready"]');
  expect(source).not.toMatch(/document|appendChild|createElement/u);
  expect(await plugin.load(id!)).toBe(source);
});
it('refuses CSS escaping its owner or introducing unreviewed imports and asset URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-owned-css-'));
  directories.push(directory);
  await mkdir(join(directory, 'src/client'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: {} }));
  const plugin = ownedClientCss(directory);
  await expect(
    plugin.resolveId('../../../outside.css', join(directory, 'lib/types/client/index.js')),
  ).rejects.toThrow('escaped');
  await expect(
    plugin.resolveId('other/styles.css', join(directory, 'lib/types/client/index.js')),
  ).rejects.toThrow('owned relative');
  for (const source of [
    '@import "https://example.invalid/styles.css";',
    '.icon { background: url(https://example.invalid/pixel); }',
  ]) {
    await writeFile(join(directory, 'src/client/unsafe.module.css'), source);
    const id = await plugin.resolveId(
      './unsafe.module.css',
      join(directory, 'src/client/index.ts'),
    );
    await expect(plugin.load(id!)).rejects.toThrow('explicit package asset');
  }
});

it('bundles an explicitly declared vendor stylesheet as text while retaining its global selectors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-vendor-css-'));
  directories.push(directory);
  await mkdir(join(directory, 'node_modules/fixture-css'), { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ dependencies: { 'fixture-css': '1.0.0' } }),
  );
  await writeFile(
    join(directory, 'node_modules/fixture-css/package.json'),
    JSON.stringify({
      name: 'fixture-css',
      version: '1.0.0',
      exports: { './theme.css': './theme.css' },
    }),
  );
  await writeFile(
    join(directory, 'node_modules/fixture-css/theme.css'),
    '.vendor-terminal { display: block; }',
  );
  const plugin = ownedClientCss(directory);
  const id = await plugin.resolveId(
    'fixture-css/theme.css',
    join(directory, 'lib/types/client/index.js'),
  );
  const source = await plugin.load(id!);
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(source!).toString('base64')
  );
  expect(module.cssText).toContain('.vendor-terminal');
  expect(module.default).toEqual({});
});
