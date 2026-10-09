import { describe, expect, it } from 'vitest';
import { axtermSyncDocumentSchema, type AxtermConfigurationDocument } from '@workspace/contracts';
import { axtermSyncDocumentFromSnapshot, parseAxtermSyncDocument } from './axterm-sync-document';

function snapshot(): AxtermConfigurationDocument {
  return {
    format: 'axterm-configuration',
    formatVersion: 1,
    appVersion: '0.10.0-test',
    exportedAt: '2026-09-21T00:00:00.000Z',
    vaultSecretValues: 'omitted',
    data: {
      hostGroups: [{ id: 'host-group-1', name: 'Operations', sortOrder: 0 }],
      hosts: [{ id: 'host-1', name: 'ops.example.test' }],
      bookmarkGroups: [{ id: 'bookmark-group-1', name: 'Operations', parentId: null, position: 0 }],
      bookmarks: [{ id: 'bookmark-1', type: 'ssh', title: 'Operations', hostId: 'host-1' }],
      connectionProfiles: [{ id: 'connection-profile-1', name: 'Operations' }],
      terminalProfiles: [{ id: 'terminal-profile-1', name: 'Compact' }],
      tunnelProfiles: [{ id: 'tunnel-profile-1', name: 'Operations tunnel' }],
      quickCommandGroups: [
        { id: 'command-group-1', name: 'Operations', parentId: null, position: 0 },
      ],
      quickCommands: [{ id: 'command-1', name: 'Uptime', groupId: 'command-group-1' }],
      terminalThemes: [{ id: 'theme-1', name: 'Operations night' }],
      triggers: [{ id: 'trigger-1', name: 'Ready' }],
      settings: {
        fileManager: { remoteAddressBookmarks: [{ id: 'address-1', hostId: null, path: '/srv' }] },
        workspace: { namedWorkspaces: [{ id: 'workspace-1', name: 'Operations' }] },
      },
    },
    omissions: {
      fields: ['data.connectionProfiles[0].passwordCredentialRef'],
      excludedCollections: ['vault-secret-values'],
    },
  } as unknown as AxtermConfigurationDocument;
}

describe('Axterm sync document', () => {
  it('uses Axterm-owned category values without legacy portable fields or credential refs', () => {
    const document = axtermSyncDocumentFromSnapshot(
      snapshot(),
      ['bookmarks', 'profiles', 'addressBookmarks', 'workspaces', 'triggers'],
      { deviceName: '  desktop-a  ', generatedAt: '2026-09-21T01:00:00.000Z' },
    );
    expect(parseAxtermSyncDocument(document)).toMatchObject({
      format: 'axterm-sync',
      formatVersion: 1,
      deviceName: 'desktop-a',
      appVersion: '0.10.0-test',
      generatedAt: '2026-09-21T01:00:00.000Z',
      categories: {
        bookmarks: { count: 4 },
        profiles: { count: 3 },
        addressBookmarks: { count: 1 },
        workspaces: { count: 1 },
        triggers: { count: 1 },
      },
    });
    expect(JSON.stringify(document)).not.toContain('_axterm');
    expect(JSON.stringify(document)).not.toContain('credentialRef');
    expect(document.categories.bookmarks?.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(document.categories.settings).toBeUndefined();
  });

  it('rejects malformed, credential-bearing and integrity-mismatched categories', () => {
    const document = axtermSyncDocumentFromSnapshot(snapshot(), ['bookmarks'], {
      deviceName: 'desktop-a',
      generatedAt: '2026-09-21T01:00:00.000Z',
    });
    const credentialBearing = structuredClone(document);
    credentialBearing.categories.bookmarks!.value = {
      credentialRef: 'forged-vault-reference',
    };
    expect(axtermSyncDocumentSchema.safeParse(credentialBearing).success).toBe(false);

    const staleHash = structuredClone(document);
    staleHash.categories.bookmarks!.hash = '0'.repeat(64);
    let caught: unknown;
    try {
      parseAxtermSyncDocument(staleHash);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'SYNC_REMOTE_INVALID',
    });

    expect(
      axtermSyncDocumentSchema.safeParse({
        ...document,
        categories: {},
      }).success,
    ).toBe(false);
  });
});
