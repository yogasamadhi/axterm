import type { RelationalDomain } from '@axterm/plugin-api/storage';
export interface CopiedReferences {
  readonly credentialRefs: readonly string[];
  readonly backgroundIds: readonly string[];
  readonly themeIds: readonly string[];
}
/** Called only inside the declaring owner's facet. No cross-domain queries or mutation. */
export function copiedReferences(
  domain: RelationalDomain,
  tables: readonly string[],
): CopiedReferences {
  const credentials = new Set<string>(),
    backgrounds = new Set<string>(),
    themes = new Set<string>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 64) throw Error('DATA_COPY_REFERENCE_DEPTH');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === 'credentialRef' ||
          key.endsWith('CredentialRef') ||
          key.endsWith('credential_ref')) &&
        item !== null &&
        item !== undefined
      ) {
        if (typeof item !== 'string' || !/^cred_[0-9a-f-]{36}$/i.test(item))
          throw Error('DATA_COPY_INVALID_CREDENTIAL_REFERENCE');
        credentials.add(item);
      }
      if (key.endsWith('CredentialRefs') && item && typeof item === 'object') {
        for (const ref of Object.values(item)) {
          if (typeof ref !== 'string' || !/^cred_[0-9a-f-]{36}$/i.test(ref))
            throw Error('DATA_COPY_INVALID_CREDENTIAL_REFERENCE');
          credentials.add(ref);
        }
      }
      if (key === 'themeId' && item !== null && item !== undefined) {
        if (typeof item !== 'string' || !/^[0-9a-f-]{36}$/i.test(item))
          throw Error('DATA_COPY_INVALID_THEME_REFERENCE');
        themes.add(item);
      }
      if (key === 'assetId' && item !== null && item !== undefined) {
        if (typeof item !== 'string' || !/^[0-9a-f-]{36}$/i.test(item))
          throw Error('DATA_COPY_INVALID_ASSET_REFERENCE');
        backgrounds.add(item);
      }
      visit(item, depth + 1);
    }
    if (credentials.size + backgrounds.size + themes.size > 100_000)
      throw Error('DATA_COPY_REFERENCE_CAPACITY');
  };
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw Error('DATA_COPY_INVALID_TABLE');
    for (let offset = 0; ; offset += 256) {
      const rows = domain.all<Record<string, unknown>>(
        `SELECT * FROM "${table}" LIMIT 256 OFFSET ?`,
        offset,
      );
      for (const row of rows) {
        visit(row);
        for (const [column, value] of Object.entries(row)) {
          if (
            typeof value !== 'string' ||
            !(column === 'payload' || column.endsWith('_payload') || column.endsWith('_json'))
          )
            continue;
          if (Buffer.byteLength(value) > 4 * 1024 * 1024) throw Error('DATA_COPY_RECORD_CAPACITY');
          visit(JSON.parse(value));
        }
      }
      if (rows.length < 256) break;
    }
  }
  return {
    credentialRefs: Object.freeze([...credentials]),
    backgroundIds: Object.freeze([...backgrounds]),
    themeIds: Object.freeze([...themes]),
  };
}
