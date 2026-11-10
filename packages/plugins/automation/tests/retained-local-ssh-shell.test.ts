import { localSubprocess } from './fixtures/subprocess.ts';
import { LocalTerminalHandle } from '../../../infra/subprocess-local/src/terminal.ts';
import type { ProcessInspector } from '../../../infra/subprocess-local/src/process-inspector.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import { Client, type ClientChannel } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { NodeLocalSshServer } from '../src/adapters/widgets/node-local-ssh-server.ts';

for (const endBy of ['client', 'pty'] as const) {
  describe('SSH Widget shell ownership', () => {
    it(`cleans both PTY subscriptions when ended by ${endBy}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-widget-shell-'));
      const dataDispose = vi.fn();
      const exitDispose = vi.fn();
      const kill = vi.fn(() => onExit({ exitCode: 0 }));
      const write = vi.fn();
      let onExit!: (event: { exitCode: number; signal?: number }) => void;
      const owned = {
        pid: 424242,
        pause: vi.fn(),
        resume: vi.fn(),
        resize: vi.fn(),
        write: (data: string | Uint8Array) =>
          write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')),
        kill,
        onData: () => ({ dispose: dataDispose }),
        onExit: (handler: typeof onExit) => {
          onExit = handler;
          return { dispose: exitDispose };
        },
      } as unknown as IPty;
      const inspector: ProcessInspector = {
        snapshot: () => ({ complete: true, tree: () => [], session: () => [], alive: () => false }),
        foregroundPgid: () => undefined,
        isStdinWaiting: () => false,
        isAlive: () => false,
        signalGroup: () => {},
        signalProcess: () => {},
      };
      const subprocess = localSubprocess();
      const spawnTerminal = vi
        .spyOn(subprocess, 'spawnTerminal')
        .mockImplementation(async () => new LocalTerminalHandle(owned, inspector, 100));
      const server = await new NodeLocalSshServer(subprocess).start({
        rootPath: root,
        host: '127.0.0.1',
        port: 0,
        username: 'tester',
        password: 'fixture-only',
      });
      const client = new Client();
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('ready', resolve);
          client.once('error', reject);
          client.connect({
            host: '127.0.0.1',
            port: server.port,
            username: 'tester',
            password: 'fixture-only',
            hostVerifier: () => true,
            readyTimeout: 3_000,
          });
        });
        const stream = await new Promise<ClientChannel>((resolve, reject) =>
          client.shell((error, stream) => (error ? reject(error) : resolve(stream))),
        );
        stream.write('owned input');
        await vi.waitFor(() => expect(write).toHaveBeenCalledWith('owned input'));
        if (endBy === 'client') client.end();
        else onExit({ exitCode: 0 });
        await vi.waitFor(() => expect(dataDispose).toHaveBeenCalledOnce());
        expect(exitDispose).toHaveBeenCalledOnce();
        expect(kill).toHaveBeenCalledTimes(endBy === 'client' ? 1 : 0);
        client.end();
        await server.stop();
        expect(dataDispose).toHaveBeenCalledOnce();
        expect(exitDispose).toHaveBeenCalledOnce();
        expect(spawnTerminal).toHaveBeenCalledOnce();
      } finally {
        client.destroy();
        await server.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
