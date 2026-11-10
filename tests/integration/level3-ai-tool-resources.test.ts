import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import LocalSubprocess from '../../packages/infra/subprocess-local/src/index.ts';
import { AiToolResources } from '../../packages/plugins/ai/src/adapters/tool-resources.ts';
import { AiToolService } from '../../packages/plugins/ai/src/application/ai-tool-service.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-ai-tools-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  await ctx.plugin(LocalSubprocess);
  const resources = new AiToolResources(ctx, directory);
  cleanup.push(() => resources.close());
  const tools = new AiToolService(resources);
  return { ctx, resources, tools, directory };
}
it.skipIf(process.platform === 'win32')(
  'runs real fixed diagnostics through the subprocess owner and rejects arbitrary executable/argument inputs',
  async () => {
    const f = await fixture();
    const memory = await f.tools.execute('system.inspectMemory', {}, 'local-runtime');
    expect(memory).toMatchObject({ platform: process.platform, totalBytes: expect.any(Number) });
    const processes = (await f.tools.execute('system.inspectProcesses', {}, 'local-runtime')) as {
      stdout: string;
    };
    expect(processes.stdout).toContain(String(process.pid));
    const disks = (await f.tools.execute('system.inspectDisk', {}, 'local-runtime')) as {
      stdout: string;
    };
    expect(disks.stdout).toContain('Filesystem');
    expect(f.resources.resourceCount()).toBe(0);
    await expect(f.resources.fixedCommand('/bin/sh', ['-c', 'echo unwanted'])).rejects.toThrow(
      'unavailable',
    );
    await expect(
      f.resources.fixedCommand('systemctl', ['status', '--no-pager', 'bad; echo unwanted']),
    ).rejects.toThrow('unavailable');
    expect(f.resources.resourceCount()).toBe(0);
    await f.resources.close();
    await expect(f.tools.execute('system.inspectDisk', {}, 'local-runtime')).rejects.toThrow(
      'closed',
    );
  },
);
it('validates MCP arguments and delegates remote reads to Files with a live cancellation signal', async () => {
  const f = await fixture();
  const id = randomUUID();
  const list = vi.fn(async (target, path, signal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    signal.throwIfAborted();
    return { target, path, entries: [] };
  });
  const readText = vi.fn(async (_target, path, signal) => {
    signal.throwIfAborted();
    return { path, content: 'bounded', revision: 'v1', lineEnding: 'lf' as const };
  });
  f.ctx.provide('remoteFiles', { list, readText });
  const proposal = f.tools.mcpProposal('sftp.list', { connectionId: id, path: '/selected' });
  expect(await f.tools.execute(proposal.name, proposal.args, proposal.target)).toEqual([]);
  expect(list).toHaveBeenCalledWith(
    { protocol: 'sftp', connectionId: id },
    '/selected',
    expect.any(AbortSignal),
  );
  expect(
    await f.tools.execute('sftp.readText', { connectionId: id, path: '/text' }, id),
  ).toMatchObject({ content: 'bounded' });
  for (const args of [
    { connectionId: id, path: 'relative' },
    { connectionId: id, path: '/ok', extra: true },
  ])
    expect(() => f.tools.mcpProposal('sftp.list', args)).toThrow();
  expect(() =>
    f.tools.mcpProposal('terminal.execReadOnly', { connectionId: id, action: 'rm' }),
  ).toThrow();
  expect(() => f.tools.mcpProposal('workspace.exec', { command: 'pwd' })).toThrow(
    'not allowlisted',
  );
  expect(list).toHaveBeenCalledTimes(1);
  expect(readText).toHaveBeenCalledTimes(1);
  const definitions = f.tools.mcpTools();
  expect(definitions.find((tool) => tool.name === 'terminal.exec')?.risk).toBe('mutating');
  expect(definitions.every((tool) => tool.name !== 'workspace.exec')).toBe(true);
});
it('retains ownership of canceled remote reads until the Files owner actually returns', async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>((resolve) => (entered = resolve));
  const drain = new Promise<void>((resolve) => (release = resolve));
  f.ctx.provide('remoteFiles', {
    list: async (target, path, signal) => {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await drain;
      return { target, path, entries: [] };
    },
    readText: async () => {
      throw new Error('unused');
    },
  });
  const pending = f.tools.execute(
    'sftp.list',
    { connectionId: randomUUID(), path: '/' },
    randomUUID(),
  );
  void pending.catch(() => {});
  await start;
  let closed = false;
  const closing = f.resources.close().then(() => (closed = true));
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.resources.resourceCount()).toBe(1);
  release();
  await closing;
  await expect(pending).rejects.toThrow();
  expect(f.resources.resourceCount()).toBe(0);
});
