import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_AGENT,
  DEFAULT_SSH_STARTUP,
  DEFAULT_SSH_X11,
} from '@workspace/contracts';
import { ProductDatabase } from './database';
import { etagFor, ProductRepository } from './product-repository';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-ssh-options-'));
  directories.push(directory);
  return join(directory, 'product.sqlite');
}

const hostInput = {
  name: 'legacy host',
  hostname: 'legacy.example.test',
  username: 'operator',
  authType: 'agent' as const,
};

describe('SSH connection option migration', () => {
  it('backfills certificate and strict Agent settings for rows created before migration 16', async () => {
    const path = await databasePath();
    let database = await ProductDatabase.open(path);
    const legacyHost = new ProductRepository(database).createHost(hostInput);
    database.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('ALTER TABLE hosts DROP COLUMN ssh_agent');
    legacy.exec('ALTER TABLE hosts DROP COLUMN certificate_credential_ref');
    legacy.prepare("DELETE FROM app_meta WHERE key='migration:16'").run();
    legacy.close();

    database = await ProductDatabase.open(path);
    try {
      const host = new ProductRepository(database).getHost(legacyHost.id);
      expect(host.certificateCredentialRef).toBeNull();
      expect(host.sshAgent).toEqual(DEFAULT_SSH_AGENT);
      expect(database.get("SELECT value FROM app_meta WHERE key='migration:16'")).toBeDefined();
      expect(() => database.run("UPDATE hosts SET ssh_agent='[]' WHERE id=?", host.id)).toThrow();
    } finally {
      database.close();
    }
  });

  it('backfills the disabled X11 policy for rows created before migration 15', async () => {
    const path = await databasePath();
    let database = await ProductDatabase.open(path);
    const legacyHost = new ProductRepository(database).createHost(hostInput);
    database.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('ALTER TABLE hosts DROP COLUMN ssh_x11');
    legacy.prepare("DELETE FROM app_meta WHERE key='migration:15'").run();
    legacy.close();

    database = await ProductDatabase.open(path);
    try {
      expect(new ProductRepository(database).getHost(legacyHost.id).x11).toEqual(DEFAULT_SSH_X11);
      expect(database.get("SELECT value FROM app_meta WHERE key='migration:15'")).toBeDefined();
      expect(() =>
        database.run("UPDATE hosts SET ssh_x11='[]' WHERE id=?", legacyHost.id),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('backfills the strict startup object for rows created before migration 14', async () => {
    const path = await databasePath();
    let database = await ProductDatabase.open(path);
    const legacyHost = new ProductRepository(database).createHost(hostInput);
    database.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('ALTER TABLE hosts DROP COLUMN ssh_startup');
    legacy.prepare("DELETE FROM app_meta WHERE key='migration:14'").run();
    legacy.close();

    database = await ProductDatabase.open(path);
    try {
      expect(new ProductRepository(database).getHost(legacyHost.id).startup).toEqual(
        DEFAULT_SSH_STARTUP,
      );
      expect(database.get("SELECT value FROM app_meta WHERE key='migration:14'")).toBeDefined();
      expect(() =>
        database.run("UPDATE hosts SET ssh_startup='[]' WHERE id=?", legacyHost.id),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('backfills strict defaults for rows created before migration 4', async () => {
    const path = await databasePath();
    let database = await ProductDatabase.open(path);
    const legacyHost = new ProductRepository(database).createHost(hostInput);
    database.close();

    const legacy = new DatabaseSync(path);
    for (const column of [
      'reconnect_max_attempts',
      'reconnect_delay_ms',
      'reconnect_mode',
      'compression',
      'keepalive_count_max',
      'keepalive_interval_ms',
      'connection_timeout_ms',
    ])
      legacy.exec(`ALTER TABLE hosts DROP COLUMN ${column}`);
    legacy.prepare("DELETE FROM app_meta WHERE key='migration:4'").run();
    legacy.close();

    database = await ProductDatabase.open(path);
    try {
      expect(new ProductRepository(database).getHost(legacyHost.id).connectionOptions).toEqual(
        DEFAULT_SSH_CONNECTION_OPTIONS,
      );
      expect(database.get("SELECT value FROM app_meta WHERE key='migration:4'")).toBeDefined();
      expect(() =>
        database.run('UPDATE hosts SET connection_timeout_ms=999 WHERE id=?', legacyHost.id),
      ).toThrow();
      expect(() =>
        database.run("UPDATE hosts SET reconnect_mode='forever' WHERE id=?", legacyHost.id),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('merges, persists and rolls back nested option patches through the Host repository', async () => {
    const path = await databasePath();
    let database = await ProductDatabase.open(path);
    let repository = new ProductRepository(database);
    const host = repository.createHost({
      ...hostInput,
      startup: {
        directory: '/srv/project',
        environment: { APP_MODE: 'test' },
        loginScripts: [{ command: 'source ~/.profile', delayMs: 100 }],
        runScripts: [],
      },
      x11: { enabled: true, display: ':7.1' },
      certificateCredentialRef: 'credential-certificate',
      sshAgent: { enabled: true, path: '/tmp/agent.sock' },
    });
    const updated = repository.updateHost(
      host.id,
      {
        connectionOptions: {
          connectionTimeoutMs: 27_000,
          compression: false,
          algorithms: {
            kex: ['curve25519-sha256'],
            cipher: ['aes256-ctr'],
            serverHostKey: ['ssh-ed25519'],
            hmac: ['hmac-sha2-256-etm@openssh.com'],
          },
          reconnectPolicy: { mode: 'automatic', delayMs: 800, maxAttempts: 4 },
        },
        startup: {
          runScripts: [{ command: 'printf ready', delayMs: 500 }],
        },
        x11: { display: ':8' },
        sshAgent: { enabled: false },
      },
      etagFor(host.version),
    );
    expect(updated.connectionOptions).toEqual({
      ...DEFAULT_SSH_CONNECTION_OPTIONS,
      connectionTimeoutMs: 27_000,
      compression: false,
      algorithms: {
        kex: ['curve25519-sha256'],
        cipher: ['aes256-ctr'],
        serverHostKey: ['ssh-ed25519'],
        hmac: ['hmac-sha2-256-etm@openssh.com'],
      },
      reconnectPolicy: { mode: 'automatic', delayMs: 800, maxAttempts: 4 },
    });
    expect(updated.startup).toEqual({
      directory: '/srv/project',
      environment: { APP_MODE: 'test' },
      loginScripts: [
        {
          command: 'source ~/.profile',
          delayMs: 100,
          sendEnter: true,
          waitForOutput: true,
          settleIdleMs: 400,
          settleTimeoutMs: 3_000,
        },
      ],
      runScripts: [
        {
          command: 'printf ready',
          delayMs: 500,
          sendEnter: true,
          waitForOutput: true,
          settleIdleMs: 400,
          settleTimeoutMs: 3_000,
        },
      ],
    });
    expect(updated.x11).toEqual({ enabled: true, display: ':8' });
    expect(updated.certificateCredentialRef).toBe('credential-certificate');
    expect(updated.sshAgent).toEqual({ enabled: false, path: '/tmp/agent.sock' });
    const eventCount = repository.listEvents().length;
    expect(() =>
      database.transaction(() => {
        repository.updateHost(
          host.id,
          { connectionOptions: { keepaliveIntervalMs: 0 } },
          etagFor(updated.version),
        );
        throw new Error('force rollback');
      }),
    ).toThrow('force rollback');
    expect(repository.getHost(host.id)).toEqual(updated);
    expect(repository.listEvents()).toHaveLength(eventCount);
    database.close();

    database = await ProductDatabase.open(path);
    repository = new ProductRepository(database);
    try {
      expect(repository.getHost(host.id)).toEqual(updated);
    } finally {
      database.close();
    }
  });
});
