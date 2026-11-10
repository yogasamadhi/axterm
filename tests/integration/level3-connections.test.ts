import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type {
  Connection,
  ConnectionsBaseline,
  ConnectionsUpdate,
  Interaction,
} from '@axterm/plugin-api/connections';
import { KnownHosts } from '../../packages/plugins/connections/src/adapters/known-hosts.ts';
import { RuntimeCommands } from '../../packages/plugins/connections/src/adapters/runtime-commands.ts';
import { InteractionService } from '../../packages/plugins/connections/src/application/interaction-service.ts';
import { ConnectionObservation } from '../../packages/plugins/connections/src/observation.ts';
import { ConnectionsProjection } from '../../packages/plugins/connections/src/client/projection.ts';
import type { ConnectionEvents } from '../../packages/plugins/connections/src/ports/events.ts';

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
});
async function facts() {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.connections);
  return { ctx, domain, known: new KnownHosts(domain) };
}
const keyInput = (publicKey = 'fixture-key') => ({
  host: 'fixture.example',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:' + publicKey,
  publicKey,
});
const connection = (id = randomUUID()): Connection => ({
  id,
  hostId: randomUUID(),
  state: 'ready',
  reconnectAttempt: 0,
  nextReconnectAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

it('owns known-host writes, records only key metadata and refuses a key changed after confirmation', async () => {
  const { domain, known } = await facts();
  const accepted = known.save(keyInput(), null);
  const cursor = domain.cursor();
  expect(known.save(keyInput(), null)).toEqual(accepted);
  expect(domain.cursor()).toBe(cursor);
  const changed = known.save(keyInput('replacement'), { version: 1 });
  expect(changed).toMatchObject({ id: accepted.id, version: 2, firstSeenAt: accepted.firstSeenAt });
  expect(() => known.save(keyInput('racing-key'), { version: 1 })).toThrowError(
    expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
  );
  expect(known.get('fixture.example', 22)).toEqual(changed);
  expect(known.list()).toEqual([changed]);
  expect(domain.events(0).map((event) => event.type)).toEqual([
    'known-host-key.accepted',
    'known-host-key.changed',
  ]);
  expect(JSON.stringify(domain.events(0))).not.toContain('publicKey');
  expect(() => domain.all('SELECT id FROM hosts')).toThrow();
  expect(() => domain.run('DELETE FROM settings')).toThrow();
});

it('coalesces in-flight network opens, refuses changed nonces and never stores plaintext input or retries an uncertain failure', async () => {
  const current = connection();
  const commands = new RuntimeCommands(() => current);
  const pending = Promise.withResolvers<Connection>();
  const apply = vi.fn(() => pending.promise);
  const key = randomUUID();
  const input = { temporarySecret: 'NONCE_SESSION_SECRET' };
  const first = commands.execute(key, 'create', input, apply);
  expect(commands.outcome(key)).toEqual({ status: 'pending' });
  expect(commands.outcome(randomUUID())).toEqual({ status: 'missing' });
  expect(commands.execute(key.toUpperCase(), 'create', input, apply)).toBe(first);
  await expect(
    commands.execute(key, 'create', { temporarySecret: 'changed' }, apply),
  ).rejects.toMatchObject({ reason: 'conflict' });
  await expect(commands.execute(key, 'retry', input, apply)).rejects.toMatchObject({
    reason: 'conflict',
  });
  await Promise.resolve();
  expect(apply).toHaveBeenCalledTimes(1);
  pending.resolve(current);
  await expect(first).resolves.toEqual(current);
  expect(commands.outcome(key.toUpperCase())).toEqual({ status: 'accepted', id: current.id });
  expect(JSON.stringify(commands)).not.toContain(input.temporarySecret);
  expect(await commands.execute(key, 'create', input, apply)).toEqual(current);
  const failureKey = randomUUID();
  const fail = vi.fn(() => {
    throw new Error('fixture-uncertain-network-outcome');
  });
  await expect(commands.execute(failureKey, 'create', {}, fail)).rejects.toThrow(
    'fixture-uncertain-network-outcome',
  );
  await expect(commands.execute(failureKey, 'create', {}, fail)).rejects.toMatchObject({
    reason: 'unavailable',
  });
  expect(fail).toHaveBeenCalledTimes(1);
  expect(commands.outcome(failureKey)).toEqual({ status: 'uncertain' });
  expect(JSON.stringify(commands.outcome(failureKey))).not.toContain(
    'fixture-uncertain-network-outcome',
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await expect(commands.execute(randomUUID(), 'create', cyclic, apply)).rejects.toMatchObject({
    reason: 'invalid-input',
  });
  await commands.dispose();
  await expect(commands.execute(randomUUID(), 'create', {}, apply)).rejects.toMatchObject({
    reason: 'closed',
  });
});

it('keeps network nonce tombstones after compact outcomes expire and drains a pending operation on unload', async () => {
  const current = connection();
  const commands = new RuntimeCommands(() => current);
  const apply = vi.fn(() => current);
  const firstKey = randomUUID();
  await commands.execute(firstKey, 'create', {}, apply);
  for (let i = 0; i < 2000; i++) await commands.execute(randomUUID(), 'create', {}, apply);
  await expect(commands.execute(firstKey, 'create', {}, apply)).rejects.toMatchObject({
    reason: 'receipt-expired',
  });
  expect(apply).toHaveBeenCalledTimes(2001);
  const pending = Promise.withResolvers<Connection>();
  const operation = commands.execute(randomUUID(), 'create', {}, () => pending.promise);
  await Promise.resolve();
  const drained = vi.fn();
  const dispose = commands.dispose().then(drained);
  await Promise.resolve();
  expect(drained).not.toHaveBeenCalled();
  pending.resolve(current);
  await operation;
  await dispose;
  expect(drained).toHaveBeenCalledOnce();
});

const challenge = (connectionId = randomUUID()) => ({
  kind: 'keyboardInteractive' as const,
  connectionId,
  severity: 'info' as const,
  title: 'Authentication',
  detail: 'Controlled fixture',
  fields: [{ id: 'password', label: 'Password', secret: true }],
});
it('bounds interactions, rejects unknown answer fields, cancels by connection and never broadcasts secret answers', async () => {
  const publish = vi.fn();
  const interactions = new InteractionService({ publish } as ConnectionEvents);
  const input = challenge();
  const pending = interactions.request(input);
  input.fields[0]!.label = 'mutated';
  const metadata = interactions.list()[0]!;
  expect(metadata.fields[0]!.label).toBe('Password');
  expect(() =>
    interactions.respond(metadata.id, {
      accepted: true,
      remember: false,
      values: { unknown: 'x' },
    }),
  ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  interactions.respond(metadata.id, {
    accepted: true,
    remember: false,
    values: { password: 'INTERACTION_SECRET' },
  });
  expect(await pending).toMatchObject({
    accepted: true,
    values: { password: 'INTERACTION_SECRET' },
  });
  expect(JSON.stringify(publish.mock.calls)).not.toContain('INTERACTION_SECRET');
  const abort = new AbortController();
  const aborted = interactions.request(challenge(), 120_000, abort.signal);
  abort.abort();
  expect(await aborted).toMatchObject({ accepted: false });
  const waiting = Array.from({ length: 64 }, () =>
    interactions.request(challenge(input.connectionId)),
  );
  expect(() => interactions.request(challenge())).toThrowError(
    expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }),
  );
  interactions.cancelConnection(input.connectionId);
  expect((await Promise.all(waiting)).every((reply) => !reply.accepted)).toBe(true);
  expect(interactions.resourceCount()).toBe(0);
  const expired = interactions.request(challenge(), 1);
  await expect(expired).rejects.toMatchObject({ code: 'INVALID_STATE' });
  interactions.close();
  expect(() => interactions.request(challenge())).toThrowError(
    expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }),
  );
});

async function commit(
  iterator: AsyncIterator<ConnectionsUpdate>,
  projection: ConnectionsProjection,
): Promise<ConnectionsBaseline> {
  for (let i = 0; i < 1000; i++) {
    const frame = await iterator.next();
    if (frame.done) throw new Error('Unexpected fixture stream end');
    const state = projection.accept(frame.value);
    if (state) return state;
  }
  throw new Error('No fixture commit');
}
it('commits complete connection baselines and atomic live/durable deltas without retaining interaction answers', async () => {
  const { ctx, domain, known } = await facts();
  const live: Connection[] = [];
  const prompts: Interaction[] = [];
  const observation = new ConnectionObservation(
    ctx,
    domain,
    known,
    () => live.slice(),
    () => prompts.slice(),
  );
  try {
    const stream = observation.watch(new AbortController().signal);
    const projection = new ConnectionsProjection();
    const first = await commit(stream, projection);
    expect(first).toMatchObject({
      cursor: 0,
      revision: 0,
      connections: [],
      ftpConnections: [],
      interactions: [],
      knownHosts: [],
    });
    live.push(connection());
    observation.publish('connection.status', live[0]!);
    const second = await commit(stream, projection);
    expect(second.connections).toEqual(live);
    expect(second.cursor).toBe(first.cursor);
    expect(second.revision).toBeGreaterThan(first.revision);
    known.save(keyInput(), null);
    const third = await commit(stream, projection);
    expect(third.cursor).toBeGreaterThan(second.cursor);
    expect(third.connections).toEqual(live);
    expect(third.knownHosts).toHaveLength(1);
    expect(Object.isFrozen(third.knownHosts[0])).toBe(true);
    await stream.return?.();
  } finally {
    await observation.dispose();
  }
});

it('drains unread and paused observers and rejects malformed, reordered and cross-generation client fragments', async () => {
  const { ctx, domain, known } = await facts();
  const observation = new ConnectionObservation(
    ctx,
    domain,
    known,
    () => [],
    () => [],
  );
  const abort = new AbortController();
  const streams = Array.from({ length: 64 }, () => observation.watch(abort.signal));
  expect(() => observation.watch(new AbortController().signal)).toThrowError(
    expect.objectContaining({ details: { reason: 'capacity' } }),
  );
  await streams[0]!.next();
  abort.abort();
  await observation.dispose();
  for (const stream of streams) expect((await stream.next()).done).toBe(true);
  const projection = new ConnectionsProjection();
  const begin: ConnectionsUpdate = {
    type: 'begin',
    mode: 'baseline',
    generation: 'fixture',
    cursor: 0,
    revision: 0,
    collections: [
      'connections',
      'ftpConnections',
      'interactions',
      'knownHosts',
      'tunnelProfiles',
      'tunnels',
    ],
  };
  projection.accept(begin);
  expect(() =>
    projection.accept({
      type: 'chunk',
      collection: 'connections',
      offset: 1,
      text: '[]',
      final: true,
    }),
  ).toThrow('CONNECTIONS_PROJECTION_INVALID');
  projection.reset();
  projection.accept(begin);
  for (const collection of begin.collections)
    projection.accept({ type: 'chunk', collection, offset: 0, text: '[]', final: true });
  expect(projection.accept({ type: 'commit', revision: 0 })).toMatchObject({ connections: [] });
  expect(() =>
    projection.accept({ ...begin, mode: 'delta', generation: 'other', revision: 1 }),
  ).toThrow('CONNECTIONS_PROJECTION_INVALID');
});
