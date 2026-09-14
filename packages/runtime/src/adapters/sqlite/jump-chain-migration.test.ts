import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductDatabase } from './database';
import { etagFor, ProductRepository } from './product-repository';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('ordered jump-host persistence', () => {
  it('persists, reorders, validates and removes bounded Host references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-jump-chain-'));
    directories.push(directory);
    const path = join(directory, 'product.sqlite');
    let database = await ProductDatabase.open(path);
    let products = new ProductRepository(database);
    const first = products.createHost(hostInput('first-hop'));
    const second = products.createHost(hostInput('second-hop'));
    let target = products.createHost({
      ...hostInput('target'),
      jumpHostIds: [first.id, second.id],
    });
    expect(products.hostRetentionReasons(first.id)).toContain('jumpHost');
    expect(() =>
      products.updateHost(
        target.id,
        { jumpHostIds: [first.id, first.id] },
        etagFor(target.version),
      ),
    ).toThrow(/cycle/iu);
    database.close();

    database = await ProductDatabase.open(path);
    products = new ProductRepository(database);
    target = products.getHost(target.id);
    expect(target.jumpHostIds).toEqual([first.id, second.id]);
    target = products.updateHost(
      target.id,
      { jumpHostIds: [second.id, first.id] },
      etagFor(target.version),
    );
    expect(target.jumpHostIds).toEqual([second.id, first.id]);
    expect(database.get("SELECT value FROM app_meta WHERE key='migration:12'")).toBeDefined();
    database.close();
  });
});

function hostInput(name: string) {
  return {
    name,
    hostname: `${name}.example.test`,
    username: 'operator',
    authType: 'agent' as const,
  };
}
