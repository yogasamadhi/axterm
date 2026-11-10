import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownedStorage } from '../../../../tests/fixtures/level3-owned-storage.ts';
import { productDomains } from '@axterm/data-schema';
import { KnownHosts } from '../src/adapters/known-hosts.ts';
const etagFor = (version: number) => `"v${version}"`;

describe('Known Host Key repository', () => {
  it('lists, replaces and revokes versioned trust records with durable events', async () => {
    const storage = await ownedStorage();
    const domain = await storage.open(productDomains.connections);
    const repository = new KnownHosts(domain);
    try {
      const accepted = repository.save({
        host: 'ssh.example.test',
        port: 2222,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:first',
        publicKey: 'first-public-key',
      });
      expect(repository.list()).toEqual([accepted]);
      expect(accepted.version).toBe(1);

      const changed = repository.save({
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
      expect(repository.get(accepted.host, accepted.port)).toEqual(changed);
      expect(() =>
        repository.remove(randomUUID(), changed.id, etagFor(accepted.version)),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED', status: 412 }));

      repository.remove(randomUUID(), changed.id, etagFor(changed.version));
      expect(repository.list()).toEqual([]);
      expect(domain.events(0).map(({ type }) => type)).toEqual([
        'known-host-key.accepted',
        'known-host-key.changed',
        'known-host-key.revoked',
      ]);
    } finally {
      await storage.close();
    }
  });
});
