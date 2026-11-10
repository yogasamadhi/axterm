import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { TunnelProfileInput } from '@axterm/plugin-api/connections';
import { OwnedTunnelProfiles } from '../../packages/plugins/connections/src/adapters/tunnel-profiles.ts';
import { KnownHosts } from '../../packages/plugins/connections/src/adapters/known-hosts.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.connections);
  cleanups.push(() => domain.close());
  const hostId = randomUUID();
  const repository = new OwnedTunnelProfiles(domain, (id) => {
    if (id !== hostId) throw new Error('Controlled missing Host');
  });
  const input: TunnelProfileInput = {
    name: 'Owned forwarding',
    hostId,
    type: 'local',
    bindHost: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: 22,
    allowNonLoopback: false,
  };
  return { domain, repository, input };
}
it('commits profile facts and compact receipts once and replays them after update and deletion without recreating a row', async () => {
  const f = await fixture();
  const key = randomUUID();
  const created = f.repository.create(key, f.input);
  expect(f.repository.create(key, f.input)).toEqual(created);
  expect(f.repository.list()).toHaveLength(1);
  expect(new KnownHosts(f.domain).retainedBy(f.input.hostId)).toEqual(['tunnel']);
  expect(() => f.repository.create(key, { ...f.input, name: 'Changed identity' })).toThrow();
  const id = created.ids[0]!;
  const updateKey = randomUUID();
  const updated = f.repository.update(updateKey, id, { name: 'Updated' }, '"v1"');
  expect(f.repository.update(updateKey, id, { name: 'Updated' }, '"v1"')).toEqual(updated);
  expect(f.repository.get(id)).toMatchObject({ name: 'Updated', version: 2 });
  const removeKey = randomUUID();
  const removed = f.repository.remove(removeKey, id, '"v2"');
  expect(f.repository.remove(removeKey, id, '"v2"')).toEqual(removed);
  expect(f.repository.create(key, f.input)).toEqual(created);
  expect(f.repository.list()).toEqual([]);
  expect(new KnownHosts(f.domain).retainedBy(f.input.hostId)).toEqual([]);
  expect(f.domain.events(0).map((event) => event.type)).toEqual([
    'tunnel-profile.created',
    'tunnel-profile.updated',
    'tunnel-profile.deleted',
  ]);
});
it('rolls back missing Host, stale version, invalid opt-in and incoherent partial patches with their receipts', async () => {
  const f = await fixture();
  expect(() => f.repository.create(randomUUID(), { ...f.input, hostId: randomUUID() })).toThrow(
    'missing Host',
  );
  expect(() => f.repository.create(randomUUID(), { ...f.input, bindHost: '0.0.0.0' })).toThrow();
  expect(f.repository.list()).toEqual([]);
  const created = f.repository.create(randomUUID(), f.input);
  const id = created.ids[0]!;
  expect(() =>
    f.repository.update(randomUUID(), id, { name: 'Missing revision' }, undefined),
  ).toThrow('If-Match');
  expect(() => f.repository.update(randomUUID(), id, { name: 'Stale revision' }, '"v0"')).toThrow(
    'changed',
  );
  expect(() => f.repository.update(randomUUID(), id, { type: 'dynamic' }, '"v1"')).toThrow();
  expect(f.repository.get(id)).toMatchObject({ ...f.input, version: 1 });
  const updated = f.repository.update(
    randomUUID(),
    id,
    { type: 'dynamic', targetHost: null, targetPort: null },
    '"v1"',
  );
  expect(updated.version).toBe(2);
  expect(f.repository.get(id)).toMatchObject({
    type: 'dynamic',
    targetHost: null,
    targetPort: null,
  });
});
it('rejects oversized persisted records without parsing or rewriting their stored bytes', async () => {
  const f = await fixture();
  const id = randomUUID();
  const now = new Date().toISOString();
  const payload = JSON.stringify({ ...f.input, name: 'a'.repeat(300000) });
  f.domain.run(
    'INSERT INTO tunnel_profiles(id,name,payload,created_at,updated_at,version) VALUES(?,?,?,?,?,1)',
    id,
    'Large stored fixture',
    payload,
    now,
    now,
  );
  expect(() => f.repository.get(id)).toThrow('capacity');
  expect(() => f.repository.list()).toThrow('capacity');
  expect(
    f.domain.get<{ payload: string }>('SELECT payload FROM tunnel_profiles WHERE id=?', id)!
      .payload,
  ).toBe(payload);
});
it('revokes known host trust atomically with exact version and durable idempotent receipts', async () => {
  const f = await fixture(),
    known = new KnownHosts(f.domain),
    first = known.save({
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:fixture',
      publicKey: 'fixture-public-key',
    });
  const key = randomUUID();
  const before = f.domain.cursor();
  expect(() => known.remove(key, first.id, undefined)).toThrow('version');
  expect(() => known.remove(key, first.id, '"v0"')).toThrow('changed');
  expect(f.domain.cursor()).toBe(before);
  expect(known.list()).toHaveLength(1);
  const receipt = known.remove(key, first.id, '"v1"');
  expect(known.remove(key, first.id, '"v1"')).toEqual(receipt);
  expect(known.list()).toEqual([]);
  expect(f.domain.events(before).map((event) => event.type)).toEqual(['known-host-key.revoked']);
  const next = known.save({
    host: first.host,
    port: first.port,
    algorithm: first.algorithm,
    fingerprint: 'SHA256:replacement',
    publicKey: 'replacement-public-key',
  });
  expect(next.id).not.toBe(first.id);
  expect(known.remove(key, first.id, '"v1"')).toEqual(receipt);
  expect(known.get(first.host, first.port)?.publicKey).toBe('replacement-public-key');
});
