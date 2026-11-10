import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalFileLease } from '@axterm/plugin-api/host';
import { GrantedConfigSources } from '../../packages/plugins/catalog/src/adapters/config-sources.ts';
import { createManagedImportFixture } from '../support/level3-managed-import-fixture.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await createManagedImportFixture();
  cleanups.push(() => f.close());
  const path = join(f.home, 'config');
  await writeFile(path, 'Host actual\n User operator\n');
  const grant = await f.capabilities.registry.createTrustedPath(path, 'file', ['read']);
  const owner = new GrantedConfigSources(() => ({ files: f.files, grants: f.ctx.fileGrants }));
  cleanups.push(() => owner.dispose());
  return { ...f, grant, owner };
}
it('reserves capacity for failed actual lease cleanup and retries every retained lease on disposal', async () => {
  const f = await fixture();
  const open = f.files.open.bind(f.files);
  const restored: (() => void)[] = [];
  let allocations = 0;
  const closed = new Set<LocalFileLease>();
  vi.spyOn(f.files, 'open').mockImplementation(async (...args) => {
    const lease = await open(...args);
    allocations++;
    const close = lease.close.bind(lease);
    const failure = vi
      .spyOn(lease, 'close')
      .mockRejectedValue(new Error('ACTUAL_CLOSE_NOT_FINISHED'));
    restored.push(() =>
      failure.mockImplementation(async () => {
        await close();
        closed.add(lease);
      }),
    );
    return lease;
  });
  for (let index = 0; index < 4; index++)
    await expect(
      f.owner.run(new AbortController().signal, async (scope) => {
        await scope.resolveGrant(f.grant.grantId);
      }),
    ).rejects.toThrow('CATALOG_IMPORT_LEASE_CLOSE_FAILED');
  expect(allocations).toBe(4);
  expect(closed.size).toBe(0);
  await expect(
    f.owner.run(new AbortController().signal, async () => undefined),
  ).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
  for (const restore of restored) restore();
  await f.owner.dispose();
  expect(closed.size).toBe(4);
  await expect(
    f.owner.run(new AbortController().signal, async () => undefined),
  ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
});
it('joins a noncooperating late acquisition before completing cancellation and never exposes its content', async () => {
  const f = await fixture();
  const open = f.files.open.bind(f.files);
  const acquired = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  vi.spyOn(f.files, 'open').mockImplementation(async (...args) => {
    const lease = await open(...args);
    acquired.resolve();
    await gate.promise;
    return lease;
  });
  const abort = new AbortController();
  const read = f.owner.run(abort.signal, async (scope) =>
    (await scope.resolveGrant(f.grant.grantId)).path.read(1024),
  );
  const rejected = expect(read).rejects.toThrow();
  await acquired.promise;
  abort.abort();
  let drained = false;
  const closing = f.owner.dispose().then(() => {
    drained = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(drained).toBe(false);
  gate.resolve();
  await rejected;
  await closing;
  expect(drained).toBe(true);
});
