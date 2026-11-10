import { DatabaseSync } from 'node:sqlite';
import { productDomains } from '@axterm/data-schema';
import { CatalogStorage } from '../../packages/plugins/catalog/src/adapters/catalog-storage.ts';
import { ownedStorage, assertTemporaryStoragePath } from './level3-owned-storage.ts';
/** Every Catalog read/write enters its actual storage domain; the fixture adds no global SQL method. */
export async function catalogStorage(path: string) {
  const storage = await ownedStorage(path);
  const domain = await storage.open(productDomains.catalog);
  return { ...storage, domain, sql: new CatalogStorage(domain) };
}
/** Independent read-only bootstrap witness on a private temporary medium; not an application capability. */
export async function readMigrationMarker(path: string, id: number) {
  if (path === ':memory:' || !Number.isInteger(id) || id < 1 || id > 42)
    throw Error('A file-backed historical migration is required');
  await assertTemporaryStoragePath(path);
  const input = new DatabaseSync(path, { readOnly: true });
  try {
    return input.prepare('SELECT value FROM app_meta WHERE key=?').get(`migration:${id}`);
  } finally {
    input.close();
  }
}
