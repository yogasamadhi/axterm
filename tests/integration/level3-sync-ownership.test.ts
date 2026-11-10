import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { OwnedSyncProfiles } from '../../packages/plugins/configuration/src/adapters/sync-profiles.ts';
import { SyncIntents } from '../../packages/plugins/configuration/src/adapters/sync-intents.ts';
import { SyncResourceCoordinator } from '../../packages/plugins/configuration/src/adapters/sync-coordination.ts';
import type { withFileLock } from '@axterm/infra-atomic-write';
import { syncProfileInputSchema } from '@axterm/plugin-api/configuration-sync';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-sync-ownership-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.configuration);
  cleanup.push(() => domain.close());
  const profiles = new OwnedSyncProfiles(domain);
  const profile = profiles.create(
    syncProfileInputSchema.parse({
      provider: 'webdav',
      name: 'Owned WebDAV',
      endpointUrl: 'http://127.0.0.1:8972/dav',
      remoteId: 'configuration',
      accessCredentialRef: 'cred_' + randomUUID(),
      selectedCategories: ['settings'],
    }),
  );
  const generation = randomUUID();
  const intents = new SyncIntents(domain, 'first', generation);
  const coordinator = new SyncResourceCoordinator(join(home, 'leases'));
  cleanup.push(() => coordinator.close().catch(() => {}));
  await coordinator.init();
  return { home, ctx, domain, profiles, profile, generation, intents, coordinator };
}
it('reserves before provider activity, rejects duplicate/different actions, and keeps stable compact completed outcomes', async () => {
  const f = await fixture();
  const command = randomUUID();
  expect(() =>
    f.intents.reserve(command, randomUUID(), f.profile.id, 'test', f.profile.version),
  ).toThrow('STALE_GENERATION');
  expect(f.domain.all('SELECT * FROM axterm_sync_run_intents')).toEqual([]);
  const queued = f.intents.reserve(command, f.generation, f.profile.id, 'test', f.profile.version);
  expect(queued.receipt.status).toBe('queued');
  expect(() =>
    f.intents.reserve(command, f.generation, f.profile.id, 'upload', f.profile.version),
  ).toThrow('ALREADY_SUBMITTED');
  const finished = await f.coordinator.withResource(f.profile.id, async (lease) => {
    f.intents.recoverResource(lease, command);
    f.intents.running(command, lease);
    return f.intents.finish(command, 'completed', {
      operation: 'test',
      value: { reachable: true, remoteExists: false, revision: null },
    });
  });
  f.domain.appendEvent('configuration/test-later-cursor', {});
  expect(f.intents.outcome(command)).toEqual(finished);
  expect(f.intents.finish(command, 'failed', undefined, 'provider-failed')).toEqual(finished);
  expect(JSON.stringify(f.intents.list())).not.toContain('accessCredentialRef');
  expect(() => f.domain.run('DELETE FROM hosts')).toThrow();
});
it('recovers only after holding the actual lease and leaves another live Profile queued intent untouched', async () => {
  const f = await fixture();
  const original = randomUUID();
  f.intents.reserve(original, f.generation, f.profile.id, 'upload', f.profile.version);
  await f.coordinator.withResource(f.profile.id, async (lease) => {
    f.intents.running(original, lease);
  });
  const foreign = new SyncIntents(f.domain, 'other', randomUUID());
  const otherGeneration = randomUUID();
  const another = new SyncIntents(f.domain, 'live', otherGeneration);
  const queued = randomUUID();
  another.reserve(queued, otherGeneration, f.profile.id, 'compare', f.profile.version);
  await f.coordinator.withResource(f.profile.id, async (lease) => {
    foreign.recoverResource(lease);
  });
  expect(f.intents.outcome(original).receipt.status).toBe('interrupted');
  expect(another.outcome(queued).receipt.status).toBe('queued');
  expect(() =>
    f.intents.reserve(original, f.generation, f.profile.id, 'upload', f.profile.version),
  ).toThrow('ALREADY_SUBMITTED');
});
it('holds coordination until a canceled late operation really drains and revokes its lease guard', async () => {
  const f = await fixture();
  const second = new SyncResourceCoordinator(join(f.home, 'leases'));
  cleanup.push(() => second.close());
  await second.init();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let assert: (() => void) | undefined;
  const operation = f.coordinator.withResource(f.profile.id, async (lease) => {
    assert = lease.assert;
    entered.resolve();
    await release.promise;
    return 'drained';
  });
  await entered.promise;
  const called = vi.fn(async () => 'unexpected');
  await expect(second.withResource(f.profile.id, called)).rejects.toThrow('CONFLICT');
  expect(called).not.toHaveBeenCalled();
  let ended = false;
  const closing = f.coordinator.close().then(() => {
    ended = true;
  });
  await Promise.resolve();
  expect(ended).toBe(false);
  expect(f.coordinator.active()).toBe(true);
  expect(() => assert!()).toThrow('CANCELLED');
  await expect(second.withResource(f.profile.id, called)).rejects.toThrow('CONFLICT');
  release.resolve();
  expect(await operation).toBe('drained');
  await closing;
  expect(ended).toBe(true);
  expect(
    await second.withResource(f.profile.id, async (lease) => {
      lease.assert();
      return 'next';
    }),
  ).toBe('next');
});
it('coordinates with a real external process and takes over only after its holder has exited', async () => {
  const f = await fixture();
  const script = join(f.home, 'holder.mjs');
  const module = pathToFileURL(resolve('packages/infra/atomic-write/lib/index.js')).href;
  await writeFile(
    script,
    `import {withFileLock} from ${JSON.stringify(module)};process.on('message',()=>{});await withFileLock(${JSON.stringify(join(f.home, 'leases', f.profile.id))},async()=>{process.send('held');await new Promise(()=>{});},{waitMs:0});`,
  );
  const child = fork(script, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  });
  await once(child, 'message');
  await expect(f.coordinator.withResource(f.profile.id, async () => 'wrong')).rejects.toThrow(
    'CONFLICT',
  );
  child.kill('SIGTERM');
  await exited;
  expect(
    await f.coordinator.withResource(f.profile.id, async (lease) => {
      lease.assert();
      return 'recovered';
    }),
  ).toBe('recovered');
});
it('retains failed release ownership and refuses a successor instead of reporting an empty task set', async () => {
  const f = await fixture();
  const failRelease: typeof withFileLock = async (_path, operation) => {
    await operation();
    throw new Error('PRIVATE_RELEASE_PATH');
  };
  const owner = new SyncResourceCoordinator(join(f.home, 'failure'), failRelease);
  cleanup.push(() => owner.close().catch(() => {}));
  await owner.init();
  await expect(owner.withResource(f.profile.id, async () => 'committed')).rejects.toThrow(
    'SYNC_UNAVAILABLE',
  );
  expect(owner.active()).toBe(true);
  await expect(owner.withResource(f.profile.id, async () => 'must-not-run')).rejects.toThrow(
    'SYNC_UNAVAILABLE',
  );
  await expect(owner.close()).rejects.toThrow('SYNC_UNAVAILABLE');
});
