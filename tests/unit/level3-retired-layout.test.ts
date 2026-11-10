import { expect, it } from 'vitest';
import {
  inspectRetiredEngineering,
  retiredProductionPaths,
} from '../../scripts/level3-retired-layout.mjs';
const current = () => ({
  rootPackage: { scripts: { build: 'node scripts/build-level3.mjs' } },
  desktopPackage: {
    name: '@axterm/desktop',
    main: 'lib/shell/main.js',
    axterm: { migrationValidation: true },
    dependencies: { '@axterm/desktop-host': 'workspace:*' },
  },
  typeConfig: {
    compilerOptions: { paths: { '@axterm/plugin-api': ['packages/api/plugin-api/src/index.ts'] } },
  },
  workflow: 'node scripts/package-desktop.mjs',
  present: [] as string[],
});
it('admits actual Shell engineering defaults and rejects every retired production entry', () => {
  expect(inspectRetiredEngineering(current())).toEqual([]);
  for (const path of retiredProductionPaths)
    expect(inspectRetiredEngineering({ ...current(), present: [path] }).join(' ')).toContain(
      'Retired production',
    );
});
it.each(['root commands', 'desktop manifest', 'type aliases', 'CI workflow'])(
  'rejects a retired selection in %s',
  (owner) => {
    const value = current();
    if (owner === 'root commands')
      value.rootPackage.scripts.build = 'pnpm --filter @workspace/desktop build';
    if (owner === 'desktop manifest') value.desktopPackage.main = 'apps/desktop/src/main/index.ts';
    if (owner === 'type aliases')
      value.typeConfig.compilerOptions.paths['@axterm/plugin-api'] = [
        'packages/contracts/src/index.ts',
      ];
    if (owner === 'CI workflow') value.workflow = 'electron-vite build';
    expect(inspectRetiredEngineering(value).join(' ')).toContain(owner);
  },
);
it('rejects business adapters on the Shell and the old contract producer', () => {
  expect(
    inspectRetiredEngineering({
      ...current(),
      desktopPackage: { ...current().desktopPackage, dependencies: { ssh2: '1.17.0' } },
    }).join(' '),
  ).toContain('Shell-owned');
  expect(
    inspectRetiredEngineering({
      ...current(),
      rootPackage: { scripts: { 'openapi:generate': 'old-generator' } },
    }).join(' '),
  ).toContain('OpenAPI');
});
