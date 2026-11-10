import { expect, it } from 'vitest';
import * as Legacy from '../fixtures/migration/generation2-contracts/host-capabilities/desktop.ts';
import * as Current from '@axterm/plugin-api/files';
import { FileDirectoryProjection } from '../../packages/plugins/files/src/client/directory-projection.ts';
it('retains current file entry defaults, portable paths, permissions and conflict input behavior', () => {
  for (const [oldSchema, newSchema, inputs] of [
    [
      Legacy.grantedEntryCreateRequestSchema,
      Current.grantedEntryCreateRequestSchema,
      [
        { name: '  document.txt ', type: 'file' },
        { path: 'folder', name: 'new-folder', type: 'directory' },
      ],
    ],
    [
      Legacy.grantedEntryRenameRequestSchema,
      Current.grantedEntryRenameRequestSchema,
      [{ path: 'folder/source.txt', name: ' renamed.txt ' }],
    ],
    [
      Legacy.grantedEntryChmodRequestSchema,
      Current.grantedEntryChmodRequestSchema,
      [{ path: 'folder/source.txt', mode: 0o640 }],
    ],
    [
      Legacy.grantedEntriesOperationRequestSchema,
      Current.grantedEntriesOperationRequestSchema,
      [
        { paths: ['folder/source.txt'], destination: '', operation: 'copy' },
        { paths: ['folder'], destination: 'target', operation: 'move', conflict: 'skip' },
      ],
    ],
  ] as const)
    for (const input of inputs) expect(newSchema.parse(input)).toEqual(oldSchema.parse(input));
  for (const value of [
    '../outside',
    '/absolute',
    'folder/../outside',
    'folder\\file',
    '\0',
    'a//b',
  ])
    expect(Current.grantedDirectoryPathSchema.safeParse(value).success).toBe(
      Legacy.grantedDirectoryPathSchema.safeParse(value).success,
    );
  const input: Current.GrantedEntryCreate = { name: 'SDK file', type: 'file' };
  expect(Current.grantedEntryCreateRequestSchema.parse(input).path).toBe('');
});
it('publishes directory metadata only after a complete validated snapshot and rejects reordered replacements', () => {
  const projection = new FileDirectoryProjection();
  const content = {
    grantId: 'selected',
    rootName: 'root',
    path: '',
    entries: [{ name: 'file', path: 'file', type: 'file', size: 0 }],
    truncated: false,
  };
  const text = JSON.stringify(content);
  expect(
    projection.accept({ type: 'begin', mode: 'baseline', generation: 'generation', cursor: 0 }),
  ).toBeUndefined();
  expect(projection.accept({ type: 'chunk', offset: 0, text, final: true })).toBeUndefined();
  const baseline = projection.accept({ type: 'commit', cursor: 0 })!;
  expect(baseline.entries).toEqual(content.entries);
  expect(Object.isFrozen(baseline.entries[0])).toBe(true);
  expect(() =>
    projection.accept({
      type: 'begin',
      mode: 'replace',
      generation: 'another-generation',
      cursor: 1,
    }),
  ).toThrow('FILE_DIRECTORY_PROJECTION_INVALID');
});

it('rejects ambiguous nondecimal bulk HTTP bounds and keeps canonical nonce, quota and default permissions', () => {
  expect(
    Current.localFileReadQuerySchema.parse({
      grantId: 'grant',
      path: 'file',
      start: '0',
      end: '16',
    }),
  ).toMatchObject({ start: 0, end: 16 });
  for (const value of ['', '-1', '0x10', '1e3', '1.5', ' 16 ', '9007199254740992'])
    expect(
      Current.localFileReadQuerySchema.safeParse({ grantId: 'grant', path: 'file', start: value })
        .success,
    ).toBe(false);
  expect(Current.localFileWriteQuerySchema.parse({ grantId: 'grant', path: 'file' })).toMatchObject(
    { overwrite: false, mode: 0o600 },
  );
  const headers = {
    key: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    bytes: String(Current.MAX_FILE_HTTP_BYTES),
    sha256: 'a'.repeat(64),
  };
  expect(Current.localFileWriteHeadersSchema.parse(headers)).toMatchObject({
    key: headers.key.toLowerCase(),
    bytes: Current.MAX_FILE_HTTP_BYTES,
  });
  expect(
    Current.localFileWriteHeadersSchema.safeParse({
      ...headers,
      bytes: String(Current.MAX_FILE_HTTP_BYTES + 1),
    }).success,
  ).toBe(false);
  expect(Current.localFileWriteHeadersSchema.safeParse({ ...headers, bytes: null }).success).toBe(
    false,
  );
});
