import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLocalX11Display, resolveLocalX11 } from './x11-forwarding';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('local X11 resolution', () => {
  it('maps bounded local display forms without accepting arbitrary network hosts', () => {
    expect(parseLocalX11Display(':7.2', 'linux')).toEqual({
      screen: 2,
      endpoints: [{ path: '/tmp/.X11-unix/X7' }, { host: '127.0.0.1', port: 6007 }],
    });
    expect(parseLocalX11Display('localhost:3', 'win32')).toEqual({
      screen: 0,
      endpoints: [{ host: '127.0.0.1', port: 6003 }],
    });
    expect(parseLocalX11Display('/private/tmp/xquartz:0', 'darwin')).toEqual({
      screen: 0,
      endpoints: [{ path: '/private/tmp/xquartz:0' }],
    });
    expect(() => parseLocalX11Display('example.com:0', 'linux')).toThrow('must be local');
    expect(() => parseLocalX11Display(':100', 'linux')).toThrow('at most 99');
  });

  it('probes the selected local display and fails clearly when no X server is reachable', async () => {
    const display = await listenOnAvailableDisplay();
    await expect(resolveLocalX11(`localhost:${display}`, 'win32')).resolves.toMatchObject({
      display: `localhost:${display}`,
      screen: 0,
      endpoint: { host: '127.0.0.1', port: 6_000 + display },
    });
    await expect(resolveLocalX11('localhost:99', 'win32')).rejects.toThrow(
      'No local X server is reachable',
    );
  });
});

async function listenOnAvailableDisplay(): Promise<number> {
  for (let display = 70; display < 99; display += 1) {
    const server = createServer((socket) => socket.end());
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(6_000 + display, '127.0.0.1', () => resolve(true));
    });
    if (listening) {
      servers.push(server);
      return display;
    }
    server.close();
  }
  throw new Error('No test X11 display port is available');
}
