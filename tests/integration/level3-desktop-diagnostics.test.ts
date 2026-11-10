import { RemoteError } from '@axterm/plugin-api';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Sqlite from '@axterm/infra-storage-sqlite';
import * as Domains from '@axterm/infra-storage-domain';
import { commandPayloadHash } from '@axterm/infra-storage-domain';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { DesktopUpdates } from '../../packages/plugins/desktop/src/updater.ts';
import {
  DesktopDiagnosticsOwner,
  desktopDiagnosticsDomain,
} from '../../packages/plugins/desktop/src/diagnostics.ts';
import { DiagnosticExportCommands } from '../../packages/plugins/desktop/src/client/diagnostics-commands.ts';
import type { FileGrantActions } from '@axterm/plugin-api/files';
const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function boot(path = ':memory:', generation = randomUUID()) {
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'web',
    appVersion: '0.10.0',
  });
  await ctx.plugin(Storage);
  await ctx.plugin(Sqlite, { path });
  await ctx.plugin(Domains, { backend: 'sqlite' });
  const domain = await ctx.storage.domain.open(desktopDiagnosticsDomain);
  ctx.effect(() => () => domain.close());
  const updates = new DesktopUpdates(() => undefined);
  ctx.effect(() => () => updates.close());
  const owner = new DesktopDiagnosticsOwner(ctx, domain, updates);
  ctx.effect(() => () => owner.close());
  return { ctx, domain, owner, generation };
}
async function directory() {
  const d = await mkdtemp(join(tmpdir(), 'axterm-diagnostic-'));
  cleanup.push(() => rm(d, { recursive: true, force: true }));
  return d;
}
async function withFiles() {
  const home = await directory(),
    f = await boot(),
    registry = new NativeFileGrantRegistry(f.generation);
  cleanup.push(() => registry.close());
  const files = new GrantedStreamingFiles(() => ({
    authorize: async (id, permission, signal) => {
      const lifetime = signal ?? new AbortController().signal,
        authority = await registry.authorize(id, permission, lifetime);
      let active = true;
      return {
        authority,
        signal: lifetime,
        assert: () => {
          if (!active || lifetime.aborted || !registry.list().items.some((x) => x.grantId === id))
            throw Error('GRANT_RETIRED');
        },
        dispose: () => {
          active = false;
        },
      };
    },
  }));
  cleanup.push(() => files.close());
  f.ctx.provide('files', files);
  const path = join(home, 'diagnostics.json'),
    grant = await registry.createTrustedPath(path, 'save-target', ['write']);
  return { ...f, home, path, grant, files, registry };
}
it('persists bounded metadata logs through real SQLite and never formats secret arguments or errors', async () => {
  const home = await directory(),
    path = join(home, 'records.sqlite'),
    f = await boot(path);
  f.owner.capture({
    ts: Date.now(),
    type: 'error',
    args: [new Error('PRIVATE_PASSWORD'), { token: 'PRIVATE_TOKEN' }],
  });
  f.owner.capture({ ts: Date.now(), type: 'warn', args: ['HOST_FAILED', 'PRIVATE_ARGUMENT'] });
  const logs = await f.owner.logs();
  expect(logs.lines).toHaveLength(2);
  expect(logs.lines.join('\n')).toContain('HOST_FAILED');
  expect(logs.lines.join('\n')).not.toMatch(/PRIVATE_(PASSWORD|TOKEN|ARGUMENT)/u);
  await f.ctx.fiber.dispose();
  const next = await boot(path);
  expect(await next.owner.logs()).toEqual(logs);
  for (let batch = 0; batch < 20; batch++) {
    for (let i = 0; i < 100; i++)
      next.owner.capture({ ts: Date.now(), type: 'info', args: ['SECRET_FREEFORM'] });
    await next.owner.logs();
  }
  const bounded = await next.owner.logs();
  expect(bounded.lines.length).toBeLessThanOrEqual(1000);
  expect(bounded.truncated).toBe(true);
  expect(Buffer.byteLength(bounded.lines.join('\n'))).toBeLessThanOrEqual(256 * 1024);
  expect(bounded.lines.join('\n')).not.toContain('SECRET_FREEFORM');
});
it('exports through actual writable authority and returns the immutable receipt without rewriting the file', async () => {
  const f = await withFiles(),
    key = randomUUID(),
    open = vi.spyOn(f.files, 'open');
  f.owner.capture({
    ts: Date.now(),
    type: 'error',
    args: ['HOST_FAILED', { password: 'NEVER_EXPORT_THIS' }],
  });
  const result = await f.owner.export(
    key,
    f.generation,
    f.grant.grantId,
    new AbortController().signal,
  );
  const text = await readFile(f.path, 'utf8'),
    payload = JSON.parse(text);
  expect(payload).toMatchObject({
    format: 'axterm-diagnostics-v1',
    runtime: { generation: f.generation, database: 'ok' },
  });
  expect(payload.logs.lines).toHaveLength(1);
  expect(text).not.toContain('NEVER_EXPORT_THIS');
  expect(text).not.toContain(f.home);
  expect(result.bytes).toBe(Buffer.byteLength(text));
  expect(f.owner.outcome(key, f.generation)).toEqual({ phase: 'complete', result });
  if (process.platform !== 'win32') expect((await lstat(f.path)).mode & 0o777).toBe(0o600);
  await writeFile(f.path, 'USER_CHANGED_AFTER_EXPORT');
  expect(
    await f.owner.export(key, f.generation, f.grant.grantId, new AbortController().signal),
  ).toEqual(result);
  expect(await readFile(f.path, 'utf8')).toBe('USER_CHANGED_AFTER_EXPORT');
  expect(open).toHaveBeenCalledOnce();
  expect(f.files.resourceCount()).toBe(0);
  expect(() =>
    f.owner.export(key, f.generation, 'other-grant', new AbortController().signal),
  ).toThrow();
  expect(() => f.owner.outcome(key, randomUUID())).toThrow();
});
it('does not replay a persisted pending export and refuses readonly file authority', async () => {
  const f = await withFiles(),
    key = randomUUID();
  await f.domain.table('exports').put(key, {
    fingerprint: commandPayloadHash({ generation: f.generation, grantId: f.grant.grantId }),
    generation: f.generation,
    phase: 'pending',
  });
  const open = vi.spyOn(f.files, 'open');
  expect(() =>
    f.owner.export(key, f.generation, f.grant.grantId, new AbortController().signal),
  ).toThrow('diagnostics failed');
  expect(open).not.toHaveBeenCalled();
  const source = join(f.home, 'readonly.txt');
  await writeFile(source, 'KEEP');
  const grant = await f.registry.createTrustedPath(source, 'file', ['read']);
  await expect(
    f.owner.export(randomUUID(), f.generation, grant.grantId, new AbortController().signal),
  ).rejects.toMatchObject({ details: { reason: 'uncertain' } });
  expect(await readFile(source, 'utf8')).toBe('KEEP');
  expect(f.files.resourceCount()).toBe(0);
});
it('cancels and joins a real lease write before returning drain or closing the owner', async () => {
  const f = await withFiles(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    open = f.files.open.bind(f.files);
  vi.spyOn(f.files, 'open').mockImplementation(async (...args) => {
    const lease = await open(...args),
      write = lease.write.bind(lease);
    lease.write = async (...input) => {
      entered.resolve();
      await release.promise;
      return write(...input);
    };
    return lease;
  });
  const key = randomUUID(),
    task = f.owner.export(key, f.generation, f.grant.grantId, new AbortController().signal),
    failed = expect(task).rejects.toMatchObject({ details: { reason: 'uncertain' } });
  await entered.promise;
  let drained = false,
    closed = false;
  const drain = f.owner.drain(key, f.generation).then(
    () => {
      drained = true;
    },
    () => {
      drained = true;
    },
  );
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(closed).toBe(false);
  release.resolve();
  await failed;
  await drain;
  await closing;
  expect(f.files.resourceCount()).toBe(0);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('holds closing until an already-admitted readonly task inspection actually settles', async () => {
  const f = await boot(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.ctx.provide('desktopTaskInspection', {
    register: () => async () => {},
    inspect: async () => {
      entered.resolve();
      await release.promise;
      return { active: false };
    },
  });
  const read = f.owner.snapshot(new AbortController().signal),
    failed = expect(read).rejects.toThrow();
  await entered.promise;
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release.resolve();
  await failed;
  await closing;
});
it('checks a lost export acknowledgement using its original receipt and never opens a second picker or rewrites', async () => {
  const generation = randomUUID(),
    grantId = randomUUID(),
    create = vi.fn(async () => ({
      grantId,
      kind: 'save-target' as const,
      name: 'diagnostics.json',
      permissions: ['write' as const],
      createdAt: new Date().toISOString(),
    })),
    revoke = vi.fn(async () => {}),
    result = { bytes: 42, createdAt: new Date().toISOString() };
  const files: FileGrantActions = {
    create,
    createInGeneration: create,
    revoke,
    revokeInGeneration: revoke,
    importFile: async () => {
      throw Error('UNUSED');
    },
  };
  const port = {
    export: vi.fn<ConstructorParameters<typeof DiagnosticExportCommands>[2]['export']>(async () => {
      throw Error('lost ack');
    }),
    outcome: vi.fn(async () => ({ phase: 'complete' as const, result })),
    drain: vi.fn(async () => ({ phase: 'uncertain' as const })),
  };
  const commands = new DiagnosticExportCommands(() => generation, files, port);
  await expect(commands.export()).rejects.toThrow();
  expect(commands.getSnapshot().uncertain).toBe(true);
  expect(() => commands.export()).toThrow('BUSY');
  await commands.retry();
  expect(port.outcome).toHaveBeenCalledWith(port.export.mock.calls[0]![0], generation);
  expect(create).toHaveBeenCalledOnce();
  expect(port.export).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith(grantId, generation);
  expect(commands.getSnapshot().result).toEqual(result);
  await commands.close();
});

it('revokes a real admission on a definite export refusal but retains ownership when revocation fails', async () => {
  const generation = randomUUID(),
    grantId = 'export-grant';
  const revoke = vi.fn(async () => {}),
    create = vi.fn(async () => ({ grantId }));
  const port = {
    export: vi.fn(async () => {
      throw new RemoteError('desktop/failure', 'CANARY', { reason: 'invalid-input' });
    }),
    outcome: vi.fn(async () => ({ phase: 'not-found' as const })),
    drain: vi.fn(async () => ({ phase: 'not-found' as const })),
  };
  const commands = new DiagnosticExportCommands(
    () => generation,
    {
      createInGeneration: create,
      revokeInGeneration: revoke,
    } as unknown as ConstructorParameters<typeof DiagnosticExportCommands>[1],
    port,
  );
  await expect(commands.export()).rejects.toThrow('DIAGNOSTIC_EXPORT_FAILED');
  expect(revoke).toHaveBeenCalledWith(grantId, generation);
  expect(commands.getSnapshot().uncertain).toBe(false);
  revoke.mockRejectedValueOnce(Error('REVOKE_UNCONFIRMED'));
  await expect(commands.export()).rejects.toThrow('DIAGNOSTIC_EXPORT_FAILED');
  expect(commands.getSnapshot()).toMatchObject({ busy: false, uncertain: true });
  expect(() => commands.export()).toThrow('BUSY');
  await commands.retry().catch(() => {});
  expect(revoke).toHaveBeenCalledTimes(3);
  await commands.close();
});
