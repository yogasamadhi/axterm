import { describe, expect, it } from 'vitest';
import { productionSbomFromIndex } from '../../scripts/commercialization/generate-production-sbom.mjs';

describe('production SPDX dependency inventory', () => {
  it('records deterministic package identities and its artifact-review limits', () => {
    const sbom = productionSbomFromIndex(
      {
        components: [
          { name: '@scope/item', version: '2.0.0', license: 'MIT OR Apache-2.0' },
          { name: 'plain', version: '1.0.0', license: 'ISC' },
        ],
      },
      { name: 'axterm', version: '0.10.0' },
    );
    expect(sbom).toMatchObject({
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      documentNamespace: expect.stringContaining('/0.10.0/'),
      comment: expect.stringContaining('not an exact platform artifact SBOM'),
    });
    expect(sbom.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '@scope/item',
          versionInfo: '2.0.0',
          externalRefs: [
            expect.objectContaining({ referenceLocator: 'pkg:npm/%40scope/item@2.0.0' }),
          ],
        }),
      ]),
    );
    expect(sbom.documentDescribes).toEqual(
      sbom.packages.map((item: { SPDXID: string }) => item.SPDXID),
    );
  });
});
