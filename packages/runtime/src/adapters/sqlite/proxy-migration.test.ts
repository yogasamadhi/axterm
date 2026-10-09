import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_GLOBAL_PROXY, DEFAULT_HOST_PROXY } from '@workspace/contracts';
import { ProductDatabase } from './database';
import { etagFor, ProductRepository } from './product-repository';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-proxy-migration-'));
  directories.push(directory);
  return join(directory, 'product.sqlite');
}

describe('SSH proxy migration and persistence', () => {
  it('upgrades existing Hosts to inherit with a direct global default', async () => {
    const path = await databasePath();
    let database = await ProductDatabase.open(path);
    const host = new ProductRepository(database).createHost({
      name: 'pre-proxy host',
      hostname: 'legacy.example.test',
      username: 'operator',
      authType: 'agent',
    });
    database.close();

    const legacy = new DatabaseSync(path);
    for (const column of ['proxy_credential_ref', 'proxy_username', 'proxy_url', 'proxy_mode'])
      legacy.exec(`ALTER TABLE hosts DROP COLUMN ${column}`);
    legacy.exec(
      "DELETE FROM app_meta WHERE key='migration:7'; DELETE FROM app_settings WHERE section='network';",
    );
    legacy.close();

    database = await ProductDatabase.open(path);
    try {
      const repository = new ProductRepository(database);
      expect(repository.getHost(host.id).proxy).toEqual(DEFAULT_HOST_PROXY);
      expect(repository.getSettings().network.proxy).toEqual(DEFAULT_GLOBAL_PROXY);
      expect(database.get("SELECT value FROM app_meta WHERE key='migration:7'")).toBeDefined();
      expect(() =>
        database.run("UPDATE hosts SET proxy_mode='ambient' WHERE id=?", host.id),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('persists safe global and per-Host proxy metadata across restart and sparse updates', async () => {
    const path = await databasePath();
    let database = await ProductDatabase.open(path);
    let repository = new ProductRepository(database);
    let host = repository.createHost({
      name: 'proxy host',
      hostname: 'ssh.example.test',
      username: 'operator',
      authType: 'agent',
    });
    host = repository.updateHost(
      host.id,
      {
        proxy: {
          mode: 'custom',
          endpoint: {
            url: 'socks5h://proxy.example.test:1080',
            username: 'proxy-user',
            credentialRef: 'cred_proxy_password',
          },
        },
      },
      etagFor(host.version),
    );
    const settings = repository.updateSettings(
      {
        network: {
          proxy: { mode: 'custom', endpoint: { url: 'https://global.example.test:8443' } },
        },
      },
      etagFor(repository.getSettings().version),
    );
    const renamed = repository.updateHost(
      host.id,
      { name: 'renamed proxy host' },
      etagFor(host.version),
    );
    expect(renamed.proxy).toEqual(host.proxy);
    database.close();

    database = await ProductDatabase.open(path);
    repository = new ProductRepository(database);
    try {
      expect(repository.getHost(host.id)).toEqual(renamed);
      expect(repository.getSettings()).toEqual(settings);
      expect(JSON.stringify(repository.getHost(host.id))).not.toContain('proxy-secret');
    } finally {
      database.close();
    }
  });

  it('migrates and persists structured ProxyCommand metadata across restart', async () => {
    const path = await databasePath();
    let database = await ProductDatabase.open(path);
    const repository = new ProductRepository(database);
    const host = repository.createHost({
      name: 'command proxy host',
      hostname: 'target.example.test',
      username: 'operator',
      authType: 'agent',
      proxy: {
        mode: 'command',
        command: {
          executable: '/usr/bin/nc',
          arguments: ['%h', '%p'],
        },
      },
    });
    expect(
      database.get<{ proxy_mode: string }>('SELECT proxy_mode FROM hosts WHERE id=?', host.id),
    ).toMatchObject({ proxy_mode: 'direct' });
    database.close();

    database = await ProductDatabase.open(path);
    try {
      expect(new ProductRepository(database).getHost(host.id).proxy).toEqual(host.proxy);
      expect(database.get("SELECT value FROM app_meta WHERE key='migration:11'")).toBeDefined();
    } finally {
      database.close();
    }
  });
});
