import { expect, it } from 'vitest';
import { assertProfileBundleDependencies } from '../../scripts/profile-dependency-check.mjs';
const templates = { desktop: { bundles: ['@axterm/bundle-base', '@axterm/bundle-market'] } };
it('requires direct production Bundle dependencies instead of development or transitive availability', () => {
  expect(() =>
    assertProfileBundleDependencies(
      {
        dependencies: {
          '@axterm/bundle-base': 'workspace:*',
          '@axterm/bundle-market': 'workspace:*',
        },
      },
      templates,
    ),
  ).not.toThrow();
  for (const manifest of [
    { dependencies: { '@axterm/cli': 'workspace:*' } },
    {
      dependencies: { '@axterm/bundle-base': 'workspace:*' },
      devDependencies: { '@axterm/bundle-market': 'workspace:*' },
    },
    {
      dependencies: { '@axterm/bundle-base': 'workspace:*' },
      peerDependencies: { '@axterm/bundle-market': 'workspace:*' },
    },
  ])
    expect(() => assertProfileBundleDependencies(manifest, templates)).toThrow(
      'PROFILE_BUNDLE_DEPENDENCY_MISSING',
    );
  expect(() =>
    assertProfileBundleDependencies({ dependencies: {} }, templates, ['missing']),
  ).toThrow('PROFILE_TEMPLATE_UNAVAILABLE');
});
