import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GLOBAL_PROXY,
  DEFAULT_HOST_PROXY,
} from '../../../api/plugin-api/src/schemas/resources.ts';
import { productDomains } from '@axterm/data-schema';
import { SettingsRepository } from '../../configuration/src/adapters/settings-repository.ts';
import {
  catalogStorage as openCatalog,
  readMigrationMarker,
} from '../../../../tests/fixtures/level3-catalog-storage.ts';
import { HostRepository } from '../src/adapters/host-repository.ts';
import { applyHistoricalSql } from '../../../../tests/fixtures/migration/historical-sql.ts';
const etagFor = (version: number) => '"v' + version + '"';

async function catalogStorage(path: string) {
  const storage = await openCatalog(path);
  const settings = new SettingsRepository(await storage.open(productDomains.configuration));
  return { ...storage, settings };
}

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
    let database = await catalogStorage(path);
    const host = new HostRepository(database.sql, () => []).createHost({
      name: 'pre-proxy host',
      hostname: 'legacy.example.test',
      username: 'operator',
      authType: 'agent',
    });
    await database.close();

    const legacy = new DatabaseSync(path);
    for (const column of ['proxy_credential_ref', 'proxy_username', 'proxy_url', 'proxy_mode'])
      legacy.exec(`ALTER TABLE hosts DROP COLUMN ${column}`);
    legacy.exec(
      "DELETE FROM app_meta WHERE key='migration:7'; DELETE FROM app_settings WHERE section='network';",
    );
    applyHistoricalSql(legacy, 7);
    legacy.close();

    database = await catalogStorage(path);
    try {
      const repository = new HostRepository(database.sql, () => []);
      expect(repository.getHost(host.id).proxy).toEqual(DEFAULT_HOST_PROXY);
      expect(database.settings.getSettings().network.proxy).toEqual(DEFAULT_GLOBAL_PROXY);
      expect(await readMigrationMarker(path, 7)).toBeDefined();
      expect(() =>
        database.sql.run("UPDATE hosts SET proxy_mode='ambient' WHERE id=?", host.id),
      ).toThrow();
    } finally {
      await database.close();
    }
  });

  it('persists safe global and per-Host proxy metadata across restart and sparse updates', async () => {
    const path = await databasePath();
    let database = await catalogStorage(path);
    let repository = new HostRepository(database.sql, () => []);
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
    const settings = database.settings.updateSettings(
      {
        network: {
          proxy: { mode: 'custom', endpoint: { url: 'https://global.example.test:8443' } },
        },
      },
      etagFor(database.settings.getSettings().version),
    );
    const renamed = repository.updateHost(
      host.id,
      { name: 'renamed proxy host' },
      etagFor(host.version),
    );
    expect(renamed.proxy).toEqual(host.proxy);
    await database.close();

    database = await catalogStorage(path);
    repository = new HostRepository(database.sql, () => []);
    try {
      expect(repository.getHost(host.id)).toEqual(renamed);
      expect(database.settings.getSettings()).toEqual(settings);
      expect(JSON.stringify(repository.getHost(host.id))).not.toContain('proxy-secret');
    } finally {
      await database.close();
    }
  });

  it('migrates and persists structured ProxyCommand metadata across restart', async () => {
    const path = await databasePath();
    let database = await catalogStorage(path);
    const repository = new HostRepository(database.sql, () => []);
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
      database.sql.get<{ proxy_mode: string }>('SELECT proxy_mode FROM hosts WHERE id=?', host.id),
    ).toMatchObject({ proxy_mode: 'direct' });
    await database.close();

    database = await catalogStorage(path);
    try {
      expect(new HostRepository(database.sql, () => []).getHost(host.id).proxy).toEqual(host.proxy);
      expect(await readMigrationMarker(path, 11)).toBeDefined();
    } finally {
      await database.close();
    }
  });
});
