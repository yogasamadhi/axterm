import { once } from 'node:events';
import { createServer, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { NodeTelnetAdapter } from './node-telnet-adapter';

const IAC = 255;
const DO = 253;
const WILL = 251;
const SB = 250;
const SE = 240;
const TERMINAL_TYPE = 24;
const NAWS = 31;

describe('NodeTelnetAdapter', () => {
  it('times out a connection attempt and destroys its socket deterministically', async () => {
    const socket = new Socket();
    const adapter = new NodeTelnetAdapter(() => socket);
    await expect(
      adapter.connect({
        host: 'unresolved.example.test',
        port: 23,
        username: '',
        loginPrompt: /login:/i,
        passwordPrompt: /password:/i,
        encoding: 'utf-8',
        cols: 80,
        rows: 24,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('Telnet connection timeout');
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('error')).toBe(0);
  });

  it('negotiates a real Telnet socket, logs in, streams bytes and reports resize', async () => {
    const serverSockets = new Set<Socket>();
    let received = Buffer.alloc(0);
    let peer: Socket | undefined;
    const server = createServer((socket) => {
      peer = socket;
      serverSockets.add(socket);
      socket.on('close', () => serverSockets.delete(socket));
      socket.on('data', (data) => {
        received = Buffer.concat([received, data]);
      });
      socket.write(Buffer.from([IAC, DO, TERMINAL_TYPE, IAC, DO, NAWS]));
      socket.write('login: ');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Telnet fixture did not listen');

    try {
      const channel = await new NodeTelnetAdapter().connect({
        host: '127.0.0.1',
        port: address.port,
        username: 'operator',
        password: 'fixture-password',
        loginPrompt: /login[: ]*$/i,
        passwordPrompt: /password[: ]*$/i,
        encoding: 'utf-8',
        cols: 80,
        rows: 24,
        timeoutMs: 2_000,
      });
      const visible: Buffer[] = [];
      channel.onData((data) => visible.push(Buffer.from(data)));

      await waitFor(() => received.includes(Buffer.from('operator\r\n')));
      peer!.write('Password: ');
      await waitFor(() => received.includes(Buffer.from('fixture-password\r\n')));
      peer!.write('欢迎使用 Axterm\r\n$ ');
      await waitFor(() => Buffer.concat(visible).includes(Buffer.from('Axterm')));

      expect(received.indexOf(Buffer.from([IAC, WILL, TERMINAL_TYPE]))).toBeGreaterThanOrEqual(0);
      expect(received.indexOf(Buffer.from([IAC, WILL, NAWS]))).toBeGreaterThanOrEqual(0);
      channel.resize(120, 40);
      await waitFor(
        () => received.indexOf(Buffer.from([IAC, SB, NAWS, 0, 120, 0, 40, IAC, SE])) >= 0,
      );

      channel.write(Buffer.from([65, IAC, 66]));
      await waitFor(() => received.indexOf(Buffer.from([65, IAC, IAC, 66])) >= 0);
      expect(Buffer.concat(visible).toString('utf8')).toContain('欢迎使用 Axterm');
      await channel.close();
    } finally {
      for (const socket of serverSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Telnet fixture');
}
