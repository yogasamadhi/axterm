import { describe, expect, it } from 'vitest';
import {
  commitElectermDataSchema,
  electermDataExportResultSchema,
  electermDataImportResultSchema,
  electermDataPreviewSchema,
  exportElectermDataSchema,
  previewElectermDataSchema,
} from '../../packages/contracts/src/index';

const timestamp = '2026-09-12T00:00:00.000Z';

describe('Electerm data migration contract', () => {
  it('keeps the preview bounded, field-oriented and free of credential values', () => {
    const preview = electermDataPreviewSchema.parse({
      previewId: '00000000-0000-4000-8000-000000000001',
      sourceName: 'electerm-data.json',
      sourceVersion: '1',
      treeEtag: '"bookmark-tree-v1"',
      expiresAt: timestamp,
      counts: {
        create: 1,
        unchanged: 0,
        skip: 0,
        groups: 0,
        profiles: 0,
        sshBookmarks: 1,
        quickCommands: 0,
        settings: 0,
        credentialMetadata: 0,
      },
      entries: [
        {
          key: 'sshBookmark:production',
          kind: 'sshBookmark',
          sourceId: 'production',
          name: 'Production',
          action: 'create',
          reasons: [],
          mappedFields: ['host', 'password'],
          omittedFields: ['sshTunnels'],
        },
      ],
    });
    expect(preview.entries[0]).toMatchObject({
      action: 'create',
      mappedFields: ['host', 'password'],
    });
    expect(JSON.stringify(preview)).not.toMatch(/credentialRef|secretValue/u);
    expect(() => electermDataPreviewSchema.parse({ ...preview, secret: 'forbidden' })).toThrow();
  });

  it('uses strict grant, commit, result and export shapes', () => {
    expect(previewElectermDataSchema.parse({ grantId: 'grant_import' })).toEqual({
      grantId: 'grant_import',
    });
    expect(
      commitElectermDataSchema.parse({ previewId: '00000000-0000-4000-8000-000000000001' }),
    ).toEqual({ previewId: '00000000-0000-4000-8000-000000000001' });
    expect(exportElectermDataSchema.parse({ grantId: 'grant_export' })).toEqual({
      grantId: 'grant_export',
    });
    expect(() =>
      previewElectermDataSchema.parse({ grantId: 'grant', path: '/private/file' }),
    ).toThrow();

    const tree = { revision: 1, etag: '"bookmark-tree-v1"', groups: [], bookmarks: [] };
    expect(
      electermDataImportResultSchema.parse({
        previewId: '00000000-0000-4000-8000-000000000001',
        counts: {
          create: 0,
          unchanged: 0,
          skip: 0,
          groups: 0,
          profiles: 0,
          sshBookmarks: 0,
          quickCommands: 0,
          settings: 0,
          credentialMetadata: 0,
        },
        createdCredentialCount: 0,
        settingsApplied: false,
        credentialMetadataReported: 0,
        tree,
      }).tree,
    ).toEqual(tree);
    expect(
      electermDataExportResultSchema.parse({
        bytes: 42,
        groups: 0,
        profiles: 0,
        sshBookmarks: 0,
        quickCommands: 0,
        omittedCredentialCount: 0,
        credentialMetadataCount: 0,
        settingsIncluded: true,
        createdAt: timestamp,
      }).bytes,
    ).toBe(42);
  });
});
