import type {} from '../../packages/plugins/automation/lib/typert.remote-client.js';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import type { FileGrants } from '@axterm/plugin-api/host';
import type {
  FileRenamePort,
  RenameScope,
} from '../../packages/plugins/automation/src/ports/file-renamer.ts';
import { GrantedFileRenamer } from '../../packages/plugins/automation/src/adapters/file-renamer.ts';
import { FileRenamer } from '../../packages/plugins/automation/src/application/file-renamer.ts';
import { RenameProjection } from '../../packages/plugins/automation/src/client/file-renames.ts';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(wrap?: (scope: RenameScope) => RenameScope) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-l3-renamer-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const generation = randomUUID();
  const registry = new NativeFileGrantRegistry(generation);
  cleanups.push(() => registry.close());
  const leases = new Set<AbortController>();
  const grants: Pick<FileGrants, 'authorize'> = {
    authorize: async (id, permission) => {
      const controller = new AbortController();
      const authority = await registry.authorize(id, permission, controller.signal);
      leases.add(controller);
      return {
        authority,
        signal: controller.signal,
        assert: () => {
          controller.signal.throwIfAborted();
        },
        dispose: () => {
          controller.abort();
          leases.delete(controller);
        },
      };
    },
  };
  const native = new GrantedFileRenamer(() => grants);
  const port: FileRenamePort = {
    open: async (id) => {
      const scope = await native.open(id);
      return wrap ? wrap(scope) : scope;
    },
  };
  const service = new FileRenamer(generation, port);
  cleanups.push(() => service.close());
  const grant = await registry.createTrustedPath(directory, 'directory', ['read', 'write']);
  return {
    directory,
    registry,
    service,
    grant,
    leases,
    generation,
    revoke: () => {
      for (const item of leases) item.abort();
    },
  };
}
it('reviews nested files with existing template semantics and executes once through live directory authority', async () => {
  const f = await fixture();
  await mkdir(join(f.directory, 'child'));
  await writeFile(join(f.directory, 'Alpha.txt'), 'alpha');
  await writeFile(join(f.directory, 'child/Beta.txt'), 'beta');
  await writeFile(join(f.directory, 'ignore.bin'), 'ignore');
  const preview = await f.service.preview({
    grantId: f.grant.grantId,
    includeSubfolders: true,
    fileTypes: '.txt',
    template: '{name}-{n:2}.{ext}',
    preserveCase: false,
  });
  expect(preview.items).toEqual([
    { source: 'Alpha.txt', target: 'alpha-01.txt', state: 'ready' },
    { source: 'child/Beta.txt', target: 'child/beta-02.txt', state: 'ready' },
  ]);
  const key = randomUUID();
  const [first, repeated] = await Promise.all([
    f.service.run(key, preview.id),
    f.service.run(key, preview.id),
  ]);
  expect(repeated).toEqual(first);
  expect(first.renamed).toBe(2);
  expect(await readFile(join(f.directory, 'alpha-01.txt'), 'utf8')).toBe('alpha');
  expect(await readFile(join(f.directory, 'child/beta-02.txt'), 'utf8')).toBe('beta');
  expect(f.leases.size).toBe(0);
  expect(await f.service.run(key, preview.id)).toEqual(first);
  await expect(f.service.run(key, randomUUID())).rejects.toMatchObject({
    details: { reason: 'conflict' },
  });
});
it('rejects conflicts, changed source identity, symlink escapes and revoked reviews without changing bytes', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'one.txt'), 'original');
  await writeFile(join(f.directory, 'one.out'), 'keep');
  const conflict = await f.service.preview({
    grantId: f.grant.grantId,
    fileTypes: 'txt',
    template: '{name}.out',
  });
  expect(conflict.canRun).toBe(false);
  await expect(f.service.run(randomUUID(), conflict.id)).rejects.toMatchObject({
    details: { reason: 'precondition-failed' },
  });
  await f.service.discard(conflict.id);
  await rm(join(f.directory, 'one.out'));
  const changed = await f.service.preview({ grantId: f.grant.grantId });
  await rename(join(f.directory, 'one.txt'), join(f.directory, 'old.txt'));
  await writeFile(join(f.directory, 'one.txt'), 'replacement');
  await expect(f.service.run(randomUUID(), changed.id)).rejects.toMatchObject({
    details: { reason: 'precondition-failed' },
  });
  expect(await readFile(join(f.directory, 'one.txt'), 'utf8')).toBe('replacement');
  const revoked = await f.service.preview({ grantId: f.grant.grantId });
  f.revoke();
  await vi.waitFor(() => expect(f.service.baseline().previews).toHaveLength(0));
  await expect(f.service.run(randomUUID(), revoked.id)).rejects.toMatchObject({
    details: { reason: 'precondition-failed' },
  });
  await symlink(tmpdir(), join(f.directory, 'outside'));
  const skipped = await f.service.preview({ grantId: f.grant.grantId, includeSubfolders: true });
  expect(skipped.items.every((item) => !item.source.startsWith('outside/'))).toBe(true);
  expect(skipped.total).toBe(2);
  await f.service.discard(skipped.id);
});
it('rolls back a failed second publication and keeps a failed command nonce from retrying mutations', async () => {
  let calls = 0;
  const f = await fixture((scope) => ({
    ...scope,
    move: async (from, to, version) => {
      if (++calls === 2) throw new Error('injected write failure');
      return scope.move(from, to, version);
    },
  }));
  await writeFile(join(f.directory, 'a.txt'), 'a');
  await writeFile(join(f.directory, 'b.txt'), 'b');
  const preview = await f.service.preview({ grantId: f.grant.grantId });
  const key = randomUUID();
  await expect(f.service.run(key, preview.id)).rejects.toMatchObject({
    details: { reason: 'unavailable' },
  });
  expect((await readdir(f.directory)).sort()).toEqual(['a.txt', 'b.txt']);
  expect(await readFile(join(f.directory, 'a.txt'), 'utf8')).toBe('a');
  const before = calls;
  await expect(f.service.run(key, preview.id)).rejects.toBeDefined();
  expect(calls).toBe(before);
  expect(f.service.baseline().recoveries).toHaveLength(0);
  expect(f.leases.size).toBe(0);
});
it('retains uncertain rollback ownership and recovers only with fresh authority for the same directory', async () => {
  let rejectWrites = true;
  let calls = 0;
  const f = await fixture((scope) => ({
    ...scope,
    move: async (from, to, version) => {
      if (rejectWrites && ++calls >= 2) throw new Error('injected disk failure');
      return scope.move(from, to, version);
    },
  }));
  await writeFile(join(f.directory, 'a.txt'), 'a');
  await writeFile(join(f.directory, 'b.txt'), 'b');
  const preview = await f.service.preview({ grantId: f.grant.grantId });
  await expect(f.service.run(randomUUID(), preview.id)).rejects.toMatchObject({
    details: { reason: 'uncertain' },
  });
  expect(f.service.baseline().recoveries).toEqual([
    { previewId: preview.id, items: [{ source: 'a.txt', current: 'a-1.txt' }] },
  ]);
  expect(f.service.resourceCount()).toBeGreaterThan(0);
  const other = join(f.directory, 'other');
  await mkdir(other);
  const wrong = await f.registry.createTrustedPath(other, 'directory', ['read', 'write']);
  await expect(f.service.recover(preview.id, wrong.grantId)).rejects.toMatchObject({
    details: { reason: 'precondition-failed' },
  });
  rejectWrites = false;
  const fresh = await f.registry.createTrustedPath(f.directory, 'directory', ['read', 'write']);
  await f.service.recover(preview.id, fresh.grantId);
  expect(f.service.baseline().recoveries).toHaveLength(0);
  expect((await readdir(f.directory)).sort()).toEqual(['a.txt', 'b.txt', 'other']);
  expect(f.leases.size).toBe(0);
});
it('publishes complete atomic transient baselines and replaces the old generation on reconnect', async () => {
  const f = await fixture();
  const abort = new AbortController();
  const stream = f.service.watch(abort.signal)[Symbol.asyncIterator]();
  const projection = new RenameProjection();
  const next = async () => {
    for (;;) {
      const item = await stream.next();
      if (item.done) throw new Error('ended');
      const result = projection.accept(item.value);
      if (result) return result;
    }
  };
  expect((await next()).previews).toHaveLength(0);
  await writeFile(join(f.directory, 'a.txt'), 'a');
  const preview = await f.service.preview({ grantId: f.grant.grantId });
  const baseline = await next();
  expect(baseline.previews[0]?.id).toBe(preview.id);
  expect(Object.isFrozen(baseline.previews)).toBe(true);
  const invalid = new RenameProjection();
  invalid.accept({ type: 'begin', generation: f.generation, revision: 0 });
  expect(() => invalid.accept({ type: 'chunk', offset: 1, text: '{}', final: true })).toThrow();
  projection.reset();
  const fresh = { ...baseline, generation: randomUUID(), revision: 0, previews: [] };
  const text = JSON.stringify(fresh);
  projection.accept({ type: 'begin', generation: fresh.generation, revision: 0 });
  projection.accept({ type: 'chunk', offset: 0, text, final: true });
  expect(projection.accept({ type: 'commit', revision: 0 })?.previews).toEqual([]);
  abort.abort();
  await stream.return?.();
  await f.service.close();
  expect(f.leases.size).toBe(0);
});

it('retains original flat case-preserving template, byte contents and idempotent completion of two reviewed files', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'alpha.txt'), 'alpha');
  await writeFile(join(f.directory, 'beta.txt'), 'beta');
  const preview = await f.service.preview({
    grantId: f.grant.grantId,
    template: '{name}-{n:2}.{ext}',
    fileTypes: 'txt',
    includeSubfolders: false,
    startNumber: 1,
    preserveCase: true,
  });
  expect(preview).toMatchObject({ total: 2, ready: 2, conflicts: 0, canRun: true });
  expect(preview.items).toEqual([
    { source: 'alpha.txt', target: 'alpha-01.txt', state: 'ready' },
    { source: 'beta.txt', target: 'beta-02.txt', state: 'ready' },
  ]);
  const key = randomUUID(),
    first = await f.service.run(key, preview.id),
    repeated = await f.service.run(key, preview.id);
  expect(repeated).toEqual(first);
  expect(first.renamed).toBe(2);
  expect(await readFile(join(f.directory, 'alpha-01.txt'), 'utf8')).toBe('alpha');
  expect((await readdir(f.directory)).sort()).toContain('beta-02.txt');
  expect(await readFile(join(f.directory, 'beta-02.txt'), 'utf8')).toBe('beta');
  expect(f.service.baseline().previews).toEqual([]);
  expect(f.leases.size).toBe(0);
});
it('retains the original release-log target conflict and refuses confirmed execution without changing either file', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'release.log'), 'one');
  await writeFile(join(f.directory, 'release-1.out'), 'existing');
  const preview = await f.service.preview({
    grantId: f.grant.grantId,
    template: '{name}-{n}.out',
    fileTypes: 'log',
  });
  expect(preview.conflicts).toBe(1);
  expect(preview.canRun).toBe(false);
  await expect(f.service.run(randomUUID(), preview.id)).rejects.toMatchObject({
    details: { reason: 'precondition-failed' },
  });
  expect(await readFile(join(f.directory, 'release.log'), 'utf8')).toBe('one');
  expect(await readFile(join(f.directory, 'release-1.out'), 'utf8')).toBe('existing');
  await f.service.discard(preview.id);
  expect(f.leases.size).toBe(0);
});
