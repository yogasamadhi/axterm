import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductDatabase } from '../adapters/sqlite/database';
import { etagFor, ProductRepository } from '../adapters/sqlite/product-repository';
import { ProxyConnectionError } from '../adapters/proxy/tcp-proxy-connector';
import type { ProxyConnector } from '../ports/proxy-connector';
import type { ProxyCommandRunner } from '../ports/proxy-command-runner';
import { ProxyService } from './proxy-service';

const databases: ProductDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function repository() {
  const database = await ProductDatabase.open();
  databases.push(database);
  return new ProductRepository(database);
}

describe('ProxyService', () => {
  it('resolves an inherited global proxy credential only while opening the tunnel', async () => {
    const products = await repository();
    products.updateSettings(
      {
        network: {
          proxy: {
            mode: 'custom',
            endpoint: {
              url: 'socks5h://proxy.example.test:1081',
              username: 'operator',
              credentialRef: 'cred_proxy',
            },
          },
        },
      },
      etagFor(products.getSettings().version),
    );
    const host = products.createHost({
      name: 'inherited proxy host',
      hostname: 'ssh.example.test',
      username: 'root',
      authType: 'agent',
    });
    const socket = new PassThrough();
    const connect = vi.fn<ProxyConnector['connect']>(async () => socket);
    const resolveCredential = vi.fn(async () => 'proxy-password');
    const service = new ProxyService(products, { connect }, { resolveCredential } as never);

    await expect(
      service.connectForHost(host, { host: host.hostname, port: host.port }, 12_000),
    ).resolves.toBe(socket);
    expect(resolveCredential).toHaveBeenCalledWith('cred_proxy');
    expect(connect).toHaveBeenCalledWith({
      proxy: {
        url: 'socks5h://proxy.example.test:1081',
        username: 'operator',
        password: 'proxy-password',
      },
      target: { host: 'ssh.example.test', port: 22 },
      timeoutMs: 12_000,
    });
    expect(JSON.stringify(products.getSettings())).not.toContain('proxy-password');
  });

  it('lets a Host explicitly bypass the global proxy', async () => {
    const products = await repository();
    products.updateSettings(
      {
        network: {
          proxy: {
            mode: 'custom',
            endpoint: { url: 'http://proxy.example.test:8080' },
          },
        },
      },
      etagFor(products.getSettings().version),
    );
    const host = products.createHost({
      name: 'direct host',
      hostname: 'direct.example.test',
      username: 'root',
      authType: 'agent',
      proxy: { mode: 'direct' },
    });
    const connect = vi.fn<ProxyConnector['connect']>();
    const service = new ProxyService(products, { connect });

    await expect(
      service.connectForHost(host, { host: host.hostname, port: host.port }, 10_000),
    ).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });

  it('runs a Host ProxyCommand with the validated target and username', async () => {
    const products = await repository();
    const host = products.createHost({
      name: 'command proxy host',
      hostname: 'ssh.example.test',
      username: 'operator',
      authType: 'agent',
      proxy: {
        mode: 'command',
        command: { executable: 'proxy-helper', arguments: ['--host=%h', '--port=%p', '--user=%r'] },
      },
    });
    const socket = new PassThrough();
    const commandConnect = vi.fn<ProxyCommandRunner['connect']>(async () => socket);
    const connector = { connect: vi.fn<ProxyConnector['connect']>() };
    const service = new ProxyService(products, connector, undefined, {
      connect: commandConnect,
    });

    await expect(
      service.connectForHost(host, { host: host.hostname, port: host.port }, 10_000),
    ).resolves.toBe(socket);
    expect(commandConnect).toHaveBeenCalledWith({
      command: host.proxy.mode === 'command' ? host.proxy.command : undefined,
      target: { host: 'ssh.example.test', port: 22 },
      username: 'operator',
      timeoutMs: 10_000,
    });
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('tests an unsaved authenticated endpoint, returns safe metadata and closes its socket', async () => {
    const products = await repository();
    const socket = new PassThrough();
    const destroy = vi.spyOn(socket, 'destroy');
    const connect = vi.fn<ProxyConnector['connect']>(async () => socket);
    const service = new ProxyService(products, { connect });

    const result = await service.test({
      source: {
        kind: 'custom',
        endpoint: {
          url: 'https://127.0.0.1:9443',
          username: 'alice',
          credentialRef: null,
        },
        temporaryPassword: 'not-returned',
      },
      target: { host: 'target.example.test', port: 22 },
      timeoutMs: 2_000,
    });

    expect(connect).toHaveBeenCalledWith({
      proxy: {
        url: 'https://127.0.0.1:9443',
        username: 'alice',
        password: 'not-returned',
      },
      target: { host: 'target.example.test', port: 22 },
      timeoutMs: 2_000,
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      reachable: true,
      protocol: 'https',
      proxyHost: '127.0.0.1',
      proxyPort: 9443,
      target: { host: 'target.example.test', port: 22 },
    });
    expect(JSON.stringify(result)).not.toMatch(/alice|not-returned/);
  });

  it('maps connector failures to stable typed application errors', async () => {
    const products = await repository();
    const service = new ProxyService(products, {
      connect: async () => {
        throw new ProxyConnectionError('PROXY_AUTH_REQUIRED', 'upstream may contain a secret');
      },
    });

    await expect(
      service.test({
        source: {
          kind: 'custom',
          endpoint: { url: 'http://proxy.example.test:8080' },
        },
        target: { host: 'target.example.test', port: 22 },
      }),
    ).rejects.toMatchObject({
      code: 'PROXY_AUTH_REQUIRED',
      message: 'Proxy authentication was rejected',
      status: 409,
    });
  });
});
