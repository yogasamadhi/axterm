import { Context } from '@deepseek-ai/cordis';
import { beforeEach, afterEach } from 'vitest';
import LocalSubprocessRuntime from '@axterm/infra-subprocess-local';
let subprocessRoot: Context;
beforeEach(async () => {
  subprocessRoot = new Context();
  await subprocessRoot.plugin(LocalSubprocessRuntime);
});
afterEach(async () => {
  await subprocessRoot.fiber.dispose();
});
import process from 'node:process';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { NodePtyAdapter, sanitizeEnvironment } from './node-pty-adapter.ts';

describe('NodePtyAdapter', () => {
  it.skipIf(process.platform === 'win32')(
    'starts an unconfigured local terminal in the operating-system home directory',
    async () => {
      const channel = await new NodePtyAdapter(subprocessRoot.subprocess).open({
        shell: '/bin/sh',
        args: [],
        env: {},
        term: 'xterm-256color',
        loginShell: false,
        cols: 80,
        rows: 24,
      });
      const chunks: Buffer[] = [];
      channel.onData((data) => chunks.push(Buffer.from(data)));
      const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));

      channel.write(Buffer.from('printf \'AXTERM_CWD=%s\\n\' "$PWD"; exit\n', 'utf8'));
      await exited;

      expect(Buffer.concat(chunks).toString('utf8')).toContain(`AXTERM_CWD=${homedir()}`);
      await channel.close();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'supplies a UTF-8 LANG when the desktop process has no locale environment',
    async () => {
      const channel = await new NodePtyAdapter(subprocessRoot.subprocess).open({
        shell: '/bin/sh',
        args: [],
        cwd: process.cwd(),
        env: { LANG: '', LC_ALL: '', LC_CTYPE: '' },
        term: 'xterm-256color',
        loginShell: false,
        cols: 80,
        rows: 24,
      });
      const chunks: Buffer[] = [];
      channel.onData((data) => chunks.push(Buffer.from(data)));
      const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));

      channel.write(Buffer.from('printf \'AXTERM_LANG=%s\\n\' "$LANG"; exit\n', 'utf8'));
      await exited;

      expect(Buffer.concat(chunks).toString('utf8')).toContain('AXTERM_LANG=C.UTF-8');
      await channel.close();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'preserves a terminal profile LANG override',
    async () => {
      const channel = await new NodePtyAdapter(subprocessRoot.subprocess).open({
        shell: '/bin/sh',
        args: [],
        cwd: process.cwd(),
        env: { LANG: 'en_GB.UTF-8' },
        term: 'xterm-256color',
        loginShell: false,
        cols: 80,
        rows: 24,
      });
      const chunks: Buffer[] = [];
      channel.onData((data) => chunks.push(Buffer.from(data)));
      const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));

      channel.write(Buffer.from('printf \'AXTERM_LANG=%s\\n\' "$LANG"; exit\n', 'utf8'));
      await exited;

      expect(Buffer.concat(chunks).toString('utf8')).toContain('AXTERM_LANG=en_GB.UTF-8');
      await channel.close();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not leak an inherited shell integration sentinel into a terminal',
    async () => {
      const previous = process.env.AXTERM_SHELL_INTEGRATION;
      process.env.AXTERM_SHELL_INTEGRATION = '1';
      try {
        const channel = await new NodePtyAdapter(subprocessRoot.subprocess).open({
          shell: '/bin/sh',
          args: [],
          env: {},
          term: 'xterm-256color',
          loginShell: false,
          cols: 80,
          rows: 24,
        });
        const chunks: Buffer[] = [];
        channel.onData((data) => chunks.push(Buffer.from(data)));
        const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));

        channel.write(
          Buffer.from(
            'printf \'AXTERM_SENTINEL=[%s]\\n\' "${AXTERM_SHELL_INTEGRATION:-unset}"; exit\n',
            'utf8',
          ),
        );
        await exited;

        expect(Buffer.concat(chunks).toString('utf8')).toContain('AXTERM_SENTINEL=[unset]');
        await channel.close();
      } finally {
        if (previous === undefined) delete process.env.AXTERM_SHELL_INTEGRATION;
        else process.env.AXTERM_SHELL_INTEGRATION = previous;
      }
    },
  );

  it('removes runtime secrets, Electron internals and the injection sentinel', () => {
    expect(
      sanitizeEnvironment({
        PATH: '/usr/bin',
        AXTERM_SHELL_INTEGRATION: '1',
        AXTERM_RUNTIME_TOKEN: 'token',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        HOME: '/home/axterm',
      }),
    ).toMatchObject({ PATH: '/usr/bin', HOME: '/home/axterm' });
    const sanitized = sanitizeEnvironment({
      PATH: '/usr/bin',
      AXTERM_SHELL_INTEGRATION: '1',
      AXTERM_RUNTIME_TOKEN: 'token',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect',
    });
    expect(sanitized).not.toHaveProperty('AXTERM_SHELL_INTEGRATION');
    expect(sanitized).not.toHaveProperty('AXTERM_RUNTIME_TOKEN');
    expect(sanitized).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(sanitized).not.toHaveProperty('NODE_OPTIONS');
  });

  it.skipIf(process.platform === 'win32')(
    'does not resolve close until the native PTY has emitted its exit event',
    async () => {
      const channel = await new NodePtyAdapter(subprocessRoot.subprocess).open({
        shell: '/bin/sh',
        args: [],
        cwd: process.cwd(),
        env: {},
        term: 'xterm-256color',
        loginShell: false,
        cols: 80,
        rows: 24,
      });
      let exitCount = 0;
      channel.onExit(() => {
        exitCount += 1;
      });

      await channel.close();

      expect(exitCount).toBe(1);
      expect(() => process.kill(channel.pid!, 0)).toThrow();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'preserves invalid UTF-8 bytes when node-pty exposes its POSIX raw-byte mode',
    async () => {
      const channel = await new NodePtyAdapter(subprocessRoot.subprocess).open({
        shell: '/bin/sh',
        args: [],
        cwd: process.cwd(),
        env: {},
        term: 'xterm-256color',
        loginShell: false,
        cols: 80,
        rows: 24,
      });
      const chunks: Buffer[] = [];
      const disposeData = channel.onData((data) => chunks.push(Buffer.from(data)));
      const exited = new Promise<void>((resolve) => {
        channel.onExit(() => resolve());
      });

      channel.write(Buffer.from("printf '\\377\\376AXTERM_RAW\\n'; exit\n", 'utf8'));
      await exited;

      const output = Buffer.concat(chunks);
      expect(
        output.indexOf(Buffer.from([0xff, 0xfe, ...Buffer.from('AXTERM_RAW')])),
      ).toBeGreaterThanOrEqual(0);
      disposeData();
      await channel.close();
    },
  );
});

it('starts provider termination before joining blocked asynchronous IO and still awaits its actual drain', async () => {
  const { PassThrough } = await import('node:stream');
  const { vi } = await import('vitest');
  const write = Promise.withResolvers<void>();
  const drain = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<{ exitCode: number | null; signal: null }>();
  const terminate = vi.fn(() => {
    write.resolve();
    exit.resolve({ exitCode: 0, signal: null });
    return drain.promise;
  });
  const output = new PassThrough();
  const channel = await new NodePtyAdapter({
    resolveExecutable: async (value) => value,
    terminalEnvironment: async () => ({ platform: 'posix' }),
    spawn: () => {
      throw new Error('unused');
    },
    spawnTerminal: async () => ({
      pid: 321,
      output,
      done: exit.promise,
      write: () => write.promise,
      resize: async () => {},
      inspectForeground: async () => undefined,
      inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
      signalForeground: async () => 321,
      terminate,
    }),
  }).open({
    shell: '/fixture',
    args: [],
    env: {},
    term: 'xterm',
    cols: 80,
    rows: 24,
    loginShell: false,
  });
  channel.write(Buffer.from('pending'));
  let stopped = false;
  const close = channel.close().then(() => {
    stopped = true;
  });
  await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
  expect(stopped).toBe(false);
  drain.resolve();
  await close;
  await channel.close();
  expect(terminate).toHaveBeenCalledOnce();
  expect(output.destroyed).toBe(true);
});
