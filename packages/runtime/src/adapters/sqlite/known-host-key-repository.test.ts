import { describe, expect, it } from 'vitest';
import { ProductDatabase } from './database';
import { etagFor, ProductRepository } from './product-repository';

describe('Known Host Key repository', () => {
  it('lists, replaces and revokes versioned trust records with durable events', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    try {
      const accepted = repository.saveKnownHostKey({
        host: 'ssh.example.test',
        port: 2222,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:first',
        publicKey: 'first-public-key',
      });
      expect(repository.listKnownHostKeys()).toEqual([accepted]);
      expect(accepted.version).toBe(1);

      const changed = repository.saveKnownHostKey({
        host: accepted.host,
        port: accepted.port,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:changed',
        publicKey: 'changed-public-key',
      });
      expect(changed).toMatchObject({
        id: accepted.id,
        firstSeenAt: accepted.firstSeenAt,
        fingerprint: 'SHA256:changed',
        version: 2,
      });
      expect(repository.getKnownHostKey(accepted.host, accepted.port)).toEqual(changed);
      expect(() => repository.deleteKnownHostKey(changed.id, etagFor(accepted.version))).toThrow(
        'Known Host Key changed',
      );

      repository.deleteKnownHostKey(changed.id, etagFor(changed.version));
      expect(repository.listKnownHostKeys()).toEqual([]);
      expect(repository.listEvents().map(({ type }) => type)).toEqual([
        'known-host-key.accepted',
        'known-host-key.changed',
        'known-host-key.revoked',
      ]);
    } finally {
      database.close();
    }
  });
});
