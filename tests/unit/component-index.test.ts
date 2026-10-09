import { describe, expect, it } from 'vitest';
import {
  componentIndexFromBunReport,
  missingPackagedComponents,
  serializeComponentIndex,
} from '../../scripts/commercialization/generate-component-index.mjs';

describe('production component index', () => {
  it('sorts and deduplicates every installed package version without turning it into a rights claim', () => {
    const index = componentIndexFromBunReport({
      MIT: [
        { name: 'z', versions: ['2.0.0', '1.0.0'], license: 'MIT' },
        { name: 'a', versions: ['1.0.0'], license: 'MIT' },
        { name: 'z', versions: ['1.0.0'], license: 'MIT' },
      ],
      ISC: [{ name: 'b', versions: ['3.0.0'] }],
    });
    expect(index.components).toEqual([
      { name: 'a', version: '1.0.0', license: 'MIT' },
      { name: 'b', version: '3.0.0', license: 'ISC' },
      { name: 'z', version: '1.0.0', license: 'MIT' },
      { name: 'z', version: '2.0.0', license: 'MIT' },
    ]);
    expect(serializeComponentIndex(index)).toContain(
      '"This index is not a complete SBOM or legal clearance."',
    );
  });

  it('flags an actual packaged component missing from the source index or changing its license', () => {
    const index = componentIndexFromBunReport({
      MIT: [{ name: 'included', versions: ['1.0.0'], license: 'MIT' }],
    });
    expect(
      missingPackagedComponents(index, [
        { name: '@workspace/shared', version: '0.10.0', license: null },
        { name: 'included', version: '1.0.0', license: 'MIT' },
        { name: 'included', version: '1.0.0', license: 'ISC' },
        { name: 'missing', version: '2.0.0', license: 'MIT' },
      ]),
    ).toEqual(['included@1.0.0: ISC != MIT', 'missing@2.0.0: MIT != undefined']);
  });

  it('rejects conflicting declarations instead of silently choosing a license', () => {
    expect(() =>
      componentIndexFromBunReport({
        MIT: [{ name: 'same', versions: ['1.0.0'], license: 'MIT' }],
        ISC: [{ name: 'same', versions: ['1.0.0'], license: 'ISC' }],
      }),
    ).toThrow('Conflicting license declarations');
  });
});
