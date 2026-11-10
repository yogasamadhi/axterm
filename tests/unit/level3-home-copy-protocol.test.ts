import { DatabaseSync } from 'node:sqlite';
import { failureCode } from '../../apps/desktop-host/src/copy-worker.ts';
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  homeCopyInitializeSchema,
  homeCopyReceiptSchema,
  homeCopyResultSchema,
  parentControlSchema,
} from '../../apps/desktop-host/src/protocol.ts';
const id = crypto.randomUUID(),
  source = 'a'.repeat(64),
  createdAt = new Date().toISOString();
it('keeps migration a finite strict startup input outside running Desktop Host dispatch', () => {
  const value = {
    kind: 'axterm-home-copy',
    version: 1,
    source: resolve('source'),
    home: resolve('target'),
    action: 'copy',
  };
  expect(homeCopyInitializeSchema.safeParse(value).success).toBe(true);
  for (const invalid of [
    { ...value, method: 'exec' },
    { ...value, home: 'relative' },
    { ...value, action: 'install' },
    { ...value, source: 'x'.repeat(4097) },
  ])
    expect(homeCopyInitializeSchema.safeParse(invalid).success).toBe(false);
  expect(parentControlSchema.safeParse(value).success).toBe(false);
});
it('requires a coherent ordered publication and rejects malformed recovery journals', () => {
  const value = {
    version: 1,
    id,
    source,
    createdAt,
    state: 'committed',
    published: ['data-v2', 'vault-v2', 'desktop'],
  };
  expect(homeCopyReceiptSchema.safeParse(value).success).toBe(true);
  for (const invalid of [
    { ...value, published: [] },
    { ...value, published: ['data-v2', 'data-v2', 'desktop'] },
    { ...value, state: 'prepared' },
    { ...value, extra: 'ignored' },
    { ...value, source: 'private/path' },
  ])
    expect(homeCopyReceiptSchema.safeParse(invalid).success).toBe(false);
});
it('accepts only bounded redacted copy outcomes with no token or exception payload', () => {
  const value = {
    kind: 'axterm-home-copy-result',
    version: 1,
    ok: false,
    code: 'DATA_COPY_VAULT_INVALID',
  };
  expect(homeCopyResultSchema.safeParse(value).success).toBe(true);
  expect(
    homeCopyResultSchema.safeParse({ ...value, exception: 'private diagnostic' }).success,
  ).toBe(false);
  expect(homeCopyResultSchema.safeParse({ ...value, code: 'private diagnostic' }).success).toBe(
    false,
  );
  expect(
    homeCopyResultSchema.safeParse({ kind: 'axterm-home-copy-result', version: 1, ok: true, id })
      .success,
  ).toBe(true);
});

it('reports actual SQLite full-media errors through a bounded redacted code', () => {
  const database = new DatabaseSync(':memory:');
  try {
    expect(() =>
      database.exec(
        'PRAGMA page_size=512; PRAGMA max_page_count=2; CREATE TABLE item(value BLOB); INSERT INTO item VALUES(zeroblob(10000));',
      ),
    ).toThrow();
    try {
      database.exec('INSERT INTO item VALUES(zeroblob(10000));');
    } catch (error) {
      expect(failureCode(error)).toBe('DATA_COPY_NO_SPACE');
    }
    expect(failureCode(Error('PRIVATE_SOURCE_DIAGNOSTIC'))).toBe('DATA_COPY_RECOVERY_REQUIRED');
  } finally {
    database.close();
  }
});
