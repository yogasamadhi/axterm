import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
} from '@axterm/plugin-api/host';
import LocalSubprocessRuntime from '../../packages/infra/subprocess-local/src/index.ts';
import {
  bindManagedProcess,
  spawnSubprocess,
} from '../../packages/infra/subprocess-local/src/spawn.ts';
import { scrubbedParentEnv } from '../../packages/infra/subprocess/src/index.ts';

const roots: Context[] = [];
const handles: SubprocessHandle[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.dispose()));
  await Promise.allSettled(roots.splice(0).map((ctx) => ctx.fiber.dispose()));
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function spec(code = 'process.stdout.write("complete");'): SubprocessSpawnSpec {
  return {
    argv: [process.execPath, '-e', code],
    cwd: process.cwd(),
    graceMs: 100,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4, spill: { maxBytes: 1024 } },
      stderr: { maxBytes: 16 },
    },
  };
}
async function boot() {
  const root = new Context();
  roots.push(root);
  await root.plugin(LocalSubprocessRuntime);
  return root;
}
it('joins a real child, preserves bounded output until disposal and deletes only its private spill', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-subprocess-range-'));
  directories.push(directory);
  const handle = spawnSubprocess(spec(), { spillDir: directory });
  handles.push(handle);
  expect(await handle.done).toEqual({ exitCode: 0, signal: null });
  expect(await handle.waitForExit()).toBe(true);
  const output = handle.collected.stdout!.readFrom(0);
  expect(output).toMatchObject({ text: 'lete', lossy: true, nextOffset: 8 });
  expect(await readFile(output.spillPath!, 'utf8')).toBe('complete');
  await handle.dispose();
  await handle.dispose();
  expect(await readdir(directory)).toEqual([]);
  expect(() => handle.collected.stdout!.readFrom(0)).toThrow('CLOSED');
});
it('rejects invalid and pre-aborted requests before process or spill allocation', () => {
  const spawn = vi.fn();
  for (const bad of [
    { ...spec(), argv: [] },
    { ...spec(), cwd: 'relative' },
    { ...spec(), graceMs: 0 },
    { ...spec(), env: { PRIVATE_TOKEN: 'secret\0value' } },
    { ...spec(), signal: AbortSignal.abort(new Error('private cancellation canary')) },
    { ...spec(), stdio: { stdin: 'ignore', stdout: { maxBytes: 1, spill: null }, stderr: 'pipe' } },
  ])
    expect(() => spawnSubprocess(bad as SubprocessSpawnSpec, { spawn })).toThrow(/SUBPROCESS_/);
  expect(spawn).not.toHaveBeenCalled();
});
it('releases private storage after synchronous native launch rejection', async () => {
  const before = (await readdir(tmpdir()))
    .filter((name) => name.startsWith('axterm-subprocess-'))
    .sort();
  expect(() =>
    spawnSubprocess(spec(), {
      spawn: () => {
        throw new Error('native rejected');
      },
    }),
  ).toThrow('native rejected');
  const after = (await readdir(tmpdir()))
    .filter((name) => name.startsWith('axterm-subprocess-'))
    .sort();
  expect(after).toEqual(before);
});
it('cancellation terminates a TERM-resistant actual process and closes raw piped streams', async () => {
  const controller = new AbortController();
  const handle = spawnSubprocess({
    ...spec(
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    ),
    signal: controller.signal,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  });
  handles.push(handle);
  await new Promise<void>((resolve) => handle.stdout!.once('data', () => resolve()));
  controller.abort();
  expect((await handle.done).signal).toBe('SIGKILL');
  await handle.dispose();
  expect(handle.stdin!.destroyed).toBe(true);
  expect(handle.stdout!.closed).toBe(true);
  expect(handle.stderr!.closed).toBe(true);
});
it('pairs a real subprocess to caller disposal and rejects a cached service after provider unload', async () => {
  const root = await boot();
  let handle!: SubprocessHandle;
  const caller = root.plugin({
    inject: ['subprocess'],
    apply(ctx) {
      handle = ctx.subprocess.spawn(
        spec('process.stdout.write("ready"); setInterval(() => {}, 1000);'),
      );
    },
  });
  await caller;
  await vi.waitFor(() => expect(handle.collected.stdout!.readFrom(0).nextOffset).toBe(5));
  await caller.dispose();
  expect(await handle.waitForExit()).toBe(true);
  expect(() => handle.collected.stdout!.readFrom(0)).toThrow('CLOSED');
  const cached = root.subprocess;
  await root.fiber.dispose();
  expect(() => cached.spawn(spec())).toThrow();
});
it('retains failed range-drain ownership and never turns a failed join into a later success', async () => {
  const signal = vi.fn();
  const dispose = vi.fn();
  const handle = bindManagedProcess(
    spec(),
    {
      stdin: null,
      stdout: null,
      stderr: null,
      direct: Promise.resolve({ exitCode: 0, signal: null }),
      owner: {
        signal,
        waitForExit: async () => {
          throw new Error('observation failed');
        },
        terminateForHostExit: vi.fn(),
      },
    },
    { spillDir: '/', dispose } as Parameters<typeof bindManagedProcess>[2],
  );
  await expect(handle.dispose()).rejects.toThrow('RANGE_DRAIN_FAILED');
  await expect(handle.dispose()).rejects.toThrow('RANGE_DRAIN_FAILED');
  expect(dispose).not.toHaveBeenCalled();
  expect(signal).toHaveBeenCalled();
});
it('scrubs ambient credentials and runtime bootstrap variables while keeping explicit opt-ins', async () => {
  vi.stubEnv('AXTERM_BOOTSTRAP', 'private');
  vi.stubEnv('PRIVATE_API_KEY', 'private');
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
  vi.stubEnv('NODE_OPTIONS', '--no-warnings');
  const env = scrubbedParentEnv();
  for (const key of ['AXTERM_BOOTSTRAP', 'PRIVATE_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'])
    expect(env[key]).toBeUndefined();
  const handle = spawnSubprocess({
    ...spec('process.stdout.write(process.env.EXPLICIT_SECRET ?? "missing");'),
    env: { EXPLICIT_SECRET: 'caller-value' },
    stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } },
  });
  handles.push(handle);
  await handle.done;
  expect(handle.collected.stdout!.readFrom(0).text).toBe('caller-value');
});
it.runIf(process.platform !== 'win32')(
  'preserves real POSIX binary terminal bytes and drains the terminal before releasing its owner',
  async () => {
    const root = await boot();
    const terminal = await root.subprocess.spawnTerminal({
      argv: ['/bin/sh', '-c', 'printf "\\377\\376\\001"'],
      cwd: process.cwd(),
      rows: 24,
      cols: 80,
      terminalType: 'xterm-256color',
      graceMs: 100,
      binary: true,
    });
    const chunks: Buffer[] = [];
    terminal.output.on('data', (bytes) => chunks.push(Buffer.from(bytes)));
    await terminal.done;
    await terminal.terminate();
    expect(Buffer.concat(chunks).equals(Buffer.from([255, 254, 1]))).toBe(true);
    await expect(terminal.write('late')).rejects.toThrow();
  },
);

it('joins late terminal allocation and actual cleanup when its caller unloads during opening', async () => {
  const { PassThrough } = await import('node:stream');
  const root = await boot();
  const acquired = Promise.withResolvers<SubprocessTerminalHandle>();
  const release = Promise.withResolvers<void>();
  const terminal = {
    pid: 123,
    output: new PassThrough(),
    done: new Promise<never>(() => {}),
    write: async () => {},
    resize: async () => {},
    inspectForeground: async () => undefined,
    inspectActivity: async () => ({ state: 'unknown' as const, revision: 0 }),
    signalForeground: async () => 123,
    terminate: vi.fn(() => release.promise),
  };
  const runtime = root.subprocess as unknown as {
    spawnTerminalOwned: () => typeof acquired.promise;
  };
  vi.spyOn(runtime, 'spawnTerminalOwned').mockReturnValue(acquired.promise);
  let opening!: Promise<unknown>;
  const caller = root.plugin({
    inject: ['subprocess'],
    apply(ctx) {
      opening = ctx.subprocess.spawnTerminal({
        argv: ['/fixture'],
        cwd: process.cwd(),
        rows: 24,
        cols: 80,
        terminalType: 'xterm',
        graceMs: 100,
      });
      void opening.catch(() => {});
    },
  });
  await caller;
  let drained = false;
  const closing = caller.dispose().then(() => {
    drained = true;
  });
  acquired.resolve(terminal);
  await vi.waitFor(() => expect(terminal.terminate).toHaveBeenCalledOnce());
  expect(drained).toBe(false);
  release.resolve();
  await closing;
  await expect(opening).rejects.toThrow('CANCELLED');
  expect(terminal.terminate).toHaveBeenCalledOnce();
  terminal.output.destroy();
});

it('fences asynchronous executable inspection to its caller lifetime and preserves public miss identities', async () => {
  const root = await boot();
  const pending = Promise.withResolvers<string>();
  const implementation = root.subprocess as unknown as {
    resolveExecutableOwned: (command: string, env: unknown, signal: AbortSignal) => Promise<string>;
  };
  const original = implementation.resolveExecutableOwned.bind(implementation);
  const resolve = vi
    .spyOn(implementation, 'resolveExecutableOwned')
    .mockImplementation((_command, _env, signal) => {
      expect(signal.aborted).toBe(false);
      return pending.promise;
    });
  let operation!: Promise<string>;
  const caller = root.plugin({
    inject: ['subprocess'],
    apply(ctx) {
      operation = ctx.subprocess.resolveExecutable('fixture');
      void operation.catch(() => {});
    },
  });
  await caller;
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  let stopped = false;
  const closing = caller.dispose().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  pending.resolve('/fixture');
  await closing;
  await expect(operation).rejects.toThrow('CANCELLED');
  resolve.mockImplementation(original);
  const { SubprocessExecutableNotFoundError } = await import('@axterm/plugin-api/subprocess');
  await expect(
    root.subprocess.resolveExecutable('/does-not-exist-axterm-subprocess'),
  ).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError);
  expect(await root.subprocess.resolveExecutable(process.execPath)).toBe(process.execPath);
});

it('retains rejected native ownership cleanup after a proven exit instead of releasing output ownership', async () => {
  const dispose = vi.fn();
  const cleanup = vi.fn(() => {
    throw new Error('PRIVATE_CLEANUP_FAILURE');
  });
  const handle = bindManagedProcess(
    spec(),
    {
      stdin: null,
      stdout: null,
      stderr: null,
      direct: Promise.resolve({ exitCode: 0, signal: null }),
      owner: {
        signal: () => {},
        waitForExit: async () => {},
        terminateForHostExit: () => {},
        cleanup,
      },
    },
    { spillDir: '/', dispose } as Parameters<typeof bindManagedProcess>[2],
  );
  await expect(handle.dispose()).rejects.toThrow('PRIVATE_CLEANUP_FAILURE');
  await expect(handle.dispose()).rejects.toThrow('PRIVATE_CLEANUP_FAILURE');
  expect(cleanup).toHaveBeenCalledOnce();
  expect(dispose).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')(
  'keeps a real surviving descendant owned after its leader exits and escalates its termination',
  async () => {
    const descendant =
      'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000);';
    const leader = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>{process.stdout.write(String(child.pid));process.exit(0);});`;
    const handle = spawnSubprocess({
      ...spec(leader),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 128 }, stderr: { maxBytes: 128 } },
    });
    handles.push(handle);
    expect((await handle.done).exitCode).toBe(0);
    const pid = Number(handle.collected.stdout!.readFrom(0).text);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(await handle.waitForExit(AbortSignal.timeout(30))).toBe(false);
    await handle.dispose();
    expect(await handle.waitForExit()).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  },
);
