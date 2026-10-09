import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  createLineEchoFixture,
  protocolFixtureCatalog,
  ProtocolFixtureRegistry,
  type ProtocolFixtureName,
} from '../fixtures/protocols/registry';

describe('product protocol fixture registry', () => {
  it('catalogues every protocol family and owns deterministic cleanup', async () => {
    const expected: ProtocolFixtureName[] = [
      'ssh',
      'sftp',
      'ftp',
      'ftps',
      'telnet',
      'serial',
      'rdp',
      'vnc',
      'spice',
      'web',
      'zmodem',
      'xmodem',
      'trzsz',
      'ai',
      'sync',
      'mcp',
    ];
    expect(protocolFixtureCatalog.map(({ name }) => name)).toEqual(expected);

    const registry = new ProtocolFixtureRegistry();
    registry.register(createLineEchoFixture('telnet'));
    try {
      const running = await registry.start('telnet');
      expect(await registry.start('telnet')).toBe(running);
      const received = await new Promise<string>((resolveData, reject) => {
        const socket = createConnection(
          { host: String(running.endpoints.host), port: Number(running.endpoints.port) },
          () => socket.write('axterm-fixture'),
        );
        socket.once('data', (data) => {
          resolveData(data.toString());
          socket.destroy();
        });
        socket.once('error', reject);
      });
      expect(received).toBe('axterm-fixture');
      await registry.stopAll();
      expect(registry.running).toEqual([]);
      await expect(
        new Promise<void>((resolveConnection, reject) => {
          const socket = createConnection({
            host: String(running.endpoints.host),
            port: Number(running.endpoints.port),
          });
          socket.once('connect', () => {
            socket.destroy();
            resolveConnection();
          });
          socket.once('error', reject);
        }),
      ).rejects.toBeDefined();
    } finally {
      await registry.stopAll();
    }
  });
});
