import { expect, it } from 'vitest';
import { runtimeDependencyNames } from '../../scripts/stage-level3-desktop.mjs';
import {
  inspectElectronLocaleFamilies,
  normalizeElectronLocale,
} from '../../scripts/electron-locale-families.mjs';
it('omits only optional ambient peers while retaining required and declared runtime edges', () => {
  expect(
    runtimeDependencyNames({
      peerDependencies: {
        '@types/react': '*',
        '@types/required': '*',
        runtimePeer: '*',
        optionalRuntime: '*',
      },
      peerDependenciesMeta: {
        '@types/react': { optional: true },
        optionalRuntime: { optional: true },
      },
      dependencies: { react: '*' },
      optionalDependencies: { native: '*' },
    }),
  ).toEqual(['@types/required', 'native', 'optionalRuntime', 'react', 'runtimePeer']);
  for (const field of ['dependencies', 'optionalDependencies'])
    expect(
      runtimeDependencyNames({
        peerDependencies: { '@types/react': '*' },
        peerDependenciesMeta: { '@types/react': { optional: true } },
        [field]: { '@types/react': '*' },
      }),
    ).toEqual(['@types/react']);
});
it('accepts all actual selected Electron grammatical-gender variants without accepting other languages', () => {
  const base = ['en', 'en_GB', 'ja', 'zh_CN', 'zh_TW'];
  const names = base.flatMap((name) => [
    name,
    ...['FEMININE', 'MASCULINE', 'NEUTER'].map((gender) => name + '_' + gender),
  ]);
  expect(inspectElectronLocaleFamilies(names)).toEqual([]);
  expect(normalizeElectronLocale('zh_TW_NEUTER')).toBe('zh_TW');
  for (const extra of [
    'fr',
    'fr_FEMININE',
    'ja_NEUTER_FEMININE',
    'en_NEUTER_FEMININE',
    'zh_HK',
    'unknown',
  ])
    expect(inspectElectronLocaleFamilies([...names, extra])).toContain(
      'Unexpected Electron locale: ' + extra,
    );
  for (const missing of ['en', 'ja', 'zh_CN', 'zh_TW']) {
    const remaining = ['en', 'ja', 'zh_CN', 'zh_TW'].filter((name) => name !== missing);
    expect(inspectElectronLocaleFamilies(remaining)).toHaveLength(1);
  }
});
