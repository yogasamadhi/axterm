import process from 'node:process';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { NodePtyAdapter } from './node-pty-adapter';

describe('NodePtyAdapter', () => {
  it.skipIf(process.platform === 'win32')(
    'starts an unconfigured local terminal in the operating-system home directory',
    async () => {
      const channel = new NodePtyAdapter().open({
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
      const channel = new NodePtyAdapter().open({
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
      const channel = new NodePtyAdapter().open({
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
    'does not resolve close until the native PTY has emitted its exit event',
    async () => {
      const channel = new NodePtyAdapter().open({
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
      const channel = new NodePtyAdapter().open({
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
