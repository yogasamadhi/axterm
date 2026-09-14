import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SSH_CONNECTION_OPTIONS,
  sshConfigImportDraftSchema,
  type SshConfigImportDraft,
  type SshConfigImportPreviewItem,
} from '../../packages/contracts/src';
import {
  draftsFromPreview,
  importStatusLabelKeys,
  parseEditedDraft,
  replaceDraft,
  replaceIncludeGrant,
  selectedDraftCount,
} from '../../apps/desktop/src/renderer/src/app/ssh-config-import/ssh-config-import-model';

const draft: SshConfigImportDraft = {
  id: 'entry-1',
  selected: true,
  name: 'app',
  title: 'Application',
  description: '',
  hostname: 'app.example.test',
  port: 22,
  username: 'deploy',
  authType: 'agent',
  proxy: { mode: 'inherit' },
  proxyJumps: ['gateway'],
  connectionOptions: DEFAULT_SSH_CONNECTION_OPTIONS,
};

describe('SSH Config import preview model', () => {
  it('keeps Electerm-style editable JSON within the typed safe draft boundary', () => {
    const edited = parseEditedDraft(
      JSON.stringify({
        ...draft,
        title: 'Production application',
        hostname: 'app.internal.example',
        proxy: { mode: 'direct' },
        connectionOptions: {
          ...draft.connectionOptions,
          connectionTimeoutMs: 12_000,
          compression: false,
        },
      }),
      draft.id,
      (value) => sshConfigImportDraftSchema.parse(value),
      { invalidJson: 'invalid JSON', immutableId: 'immutable id' },
    );
    expect(edited).toMatchObject({
      id: draft.id,
      title: 'Production application',
      hostname: 'app.internal.example',
      proxy: { mode: 'direct' },
      connectionOptions: { connectionTimeoutMs: 12_000, compression: false },
    });
    expect(() =>
      parseEditedDraft('{bad json', draft.id, (value) => sshConfigImportDraftSchema.parse(value), {
        invalidJson: 'invalid JSON',
        immutableId: 'immutable id',
      }),
    ).toThrow('invalid JSON');
    expect(() =>
      parseEditedDraft(
        JSON.stringify({ ...draft, id: 'replacement' }),
        draft.id,
        (value) => sshConfigImportDraftSchema.parse(value),
        { invalidJson: 'invalid JSON', immutableId: 'immutable id' },
      ),
    ).toThrow('immutable id');
    expect(() =>
      parseEditedDraft(
        JSON.stringify({
          ...draft,
          connectionOptions: { ...draft.connectionOptions, connectionTimeoutMs: 1 },
        }),
        draft.id,
        (value) => sshConfigImportDraftSchema.parse(value),
        { invalidJson: 'invalid JSON', immutableId: 'immutable id' },
      ),
    ).toThrow();
  });

  it('copies preview drafts, preserves status labels and counts explicit selection', () => {
    const previewItems: SshConfigImportPreviewItem[] = [
      {
        id: draft.id,
        index: 0,
        line: 1,
        sourceName: 'config',
        alias: 'app',
        status: 'imported',
        draft,
        notices: [],
      },
      {
        id: 'skipped-1',
        index: 1,
        line: 4,
        sourceName: 'include.conf',
        alias: '*.internal',
        status: 'skipped',
        draft: null,
        notices: [],
      },
    ];
    const drafts = draftsFromPreview(previewItems);
    drafts[0]!.title = 'Changed locally';
    expect(draft.title).toBe('Application');
    expect(selectedDraftCount(drafts)).toBe(1);
    expect(selectedDraftCount(replaceDraft(drafts, { ...draft, selected: false }))).toBe(0);
    expect(importStatusLabelKeys).toEqual({
      imported: 'sshConfigImport.willImport',
      linked: 'sshConfigImport.willLink',
      unchanged: 'sshConfigImport.unchanged',
      skipped: 'sshConfigImport.skip',
    });
  });

  it('drops and reports every descendant grant when an Include authorization is replaced', () => {
    expect(
      replaceIncludeGrant(
        [
          { includeId: 'root/i0', grantId: 'directory-old' },
          { includeId: 'root/i0/f0/i0', grantId: 'nested-old' },
          { includeId: 'root/i1', grantId: 'sibling' },
        ],
        { includeId: 'root/i0', grantId: 'directory-new' },
      ),
    ).toEqual({
      bindings: [
        { includeId: 'root/i1', grantId: 'sibling' },
        { includeId: 'root/i0', grantId: 'directory-new' },
      ],
      removedGrantIds: ['directory-old', 'nested-old'],
    });
  });
});
