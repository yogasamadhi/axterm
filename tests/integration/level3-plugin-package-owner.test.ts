import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessService,
} from '@axterm/plugin-api/host';
import Local from '@axterm/infra-subprocess-local';
import { PackageRunner } from '../../packages/infra/plugin-manager/src/package-runner.ts';
function fake() {
  const done = Promise.withResolvers<SubprocessOutcome>(),
    dispose = Promise.withResolvers<void>();
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: { readFrom: () => ({ text: 'bounded', nextOffset: 7, lossy: false }) } },
    done: done.promise,
    terminate: vi.fn(),
    waitForExit: async () => true,
    dispose: vi.fn(() => dispose.promise),
  };
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => handle);
  const subprocess: SubprocessService = {
    spawn,
    spawnTerminal: vi.fn(),
    resolveExecutable: vi.fn(),
    terminalEnvironment: vi.fn(),
  };
  return { done, dispose, handle, spawn, subprocess };
}
it('reserves package execution before async admission, captures input and waits for actual range disposal', async () => {
  const f = fake(),
    invocation = { command: '/owned/node', args: ['/owned/pnpm.mjs'], env: { OWNED: 'initial' } };
  const runner = new PackageRunner(f.subprocess, invocation, '/owned/profile');
  const args = ['view', 'fixture'],
    options = { timeoutMs: 10_000, env: { REQUEST: 'initial' } };
  const result = runner.run(args, options);
  invocation.command = '/changed';
  invocation.args[0] = '/changed';
  invocation.env.OWNED = 'changed';
  args[1] = 'changed';
  options.env.REQUEST = 'changed';
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(1));
  expect(f.spawn.mock.calls[0]![0]).toMatchObject({
    argv: ['/owned/node', '/owned/pnpm.mjs', 'view', 'fixture'],
    env: { OWNED: 'initial', REQUEST: 'initial' },
    cwd: '/owned/profile',
  });
  f.done.resolve({ exitCode: 0, signal: null });
  await vi.waitFor(() => expect(f.handle.dispose).toHaveBeenCalledTimes(1));
  let closed = false;
  const closing = runner.close().then(() => {
    closed = true;
  });
  expect(runner.resourceCount()).toBe(1);
  expect(closed).toBe(false);
  await expect(runner.run(['view'], { timeoutMs: 100 })).rejects.toThrow('CLOSED');
  f.dispose.resolve();
  expect((await result).stdout).toBe('bounded');
  await closing;
  expect(runner.resourceCount()).toBe(0);
});
it('retains a failed cleanup handle, denies new intake and rejects a drain that cannot prove release', async () => {
  const f = fake(),
    runner = new PackageRunner(
      f.subprocess,
      { command: '/owned/node', args: [], env: {} },
      '/owned/profile',
    );
  f.handle.dispose = vi.fn(async () => {
    throw new Error('Controlled cleanup failure');
  });
  f.done.resolve({ exitCode: 0, signal: null });
  await expect(runner.run(['view'], { timeoutMs: 1000 })).rejects.toThrow('UNAVAILABLE');
  expect(runner.cleanupFailed()).toBe(true);
  expect(runner.resourceCount()).toBe(1);
  await expect(runner.run(['view'], { timeoutMs: 1000 })).rejects.toThrow('CAPACITY');
  await expect(runner.close()).rejects.toThrow('UNAVAILABLE');
});
it('cancels a real package command and joins its surviving child through the shared subprocess provider', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-package-range-')),
    ctx = new Context();
  let runner: PackageRunner | undefined;
  try {
    await ctx.plugin(Local);
    runner = new PackageRunner(
      ctx.subprocess,
      { command: process.execPath, args: [], env: {} },
      home,
    );
    const marker = join(home, 'child-pid');
    const script = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000);`;
    const abort = new AbortController();
    const result = Promise.allSettled([
      runner.run(['-e', script], { signal: abort.signal, timeoutMs: 5000 }),
    ]);
    let pid = 0;
    await vi.waitFor(
      async () => {
        pid = Number(await readFile(marker, 'utf8'));
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
    abort.abort();
    const [outcome] = await result;
    expect(outcome).toMatchObject({ status: 'rejected', reason: { reason: 'cancelled' } });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(runner.resourceCount()).toBe(0);
  } finally {
    await runner?.close();
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
}, 10_000);
