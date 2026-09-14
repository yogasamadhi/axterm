import { createServer, type Server, type Socket } from 'node:net';

export type ProtocolFixtureName =
  | 'ssh'
  | 'sftp'
  | 'ftp'
  | 'ftps'
  | 'telnet'
  | 'serial'
  | 'rdp'
  | 'vnc'
  | 'spice'
  | 'web'
  | 'zmodem'
  | 'xmodem'
  | 'trzsz'
  | 'ai'
  | 'sync'
  | 'mcp';

export type FixtureMode = 'in-process' | 'docker' | 'native' | 'external';

export interface ProtocolFixtureDescriptor {
  readonly name: ProtocolFixtureName;
  readonly phase: 11 | 15 | 16 | 17 | 18 | 19 | 20;
  readonly mode: FixtureMode;
  readonly capabilities: readonly string[];
  readonly requiredEnvironment: readonly string[];
}

export interface RunningProtocolFixture {
  readonly name: ProtocolFixtureName;
  readonly endpoints: Readonly<Record<string, string | number>>;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  stop(): Promise<void>;
}

export interface ProtocolFixture {
  readonly descriptor: ProtocolFixtureDescriptor;
  start(signal?: AbortSignal): Promise<RunningProtocolFixture>;
}

export const protocolFixtureCatalog = [
  {
    name: 'ssh',
    phase: 15,
    mode: 'docker',
    capabilities: ['password', 'key', 'host-key', 'tunnel'],
    requiredEnvironment: ['docker'],
  },
  {
    name: 'sftp',
    phase: 16,
    mode: 'docker',
    capabilities: ['browse', 'stream', 'permission'],
    requiredEnvironment: ['docker'],
  },
  {
    name: 'ftp',
    phase: 17,
    mode: 'in-process',
    capabilities: ['browse', 'transfer'],
    requiredEnvironment: [],
  },
  {
    name: 'ftps',
    phase: 17,
    mode: 'in-process',
    capabilities: ['explicit-tls', 'transfer'],
    requiredEnvironment: ['fixture-certificate'],
  },
  {
    name: 'telnet',
    phase: 17,
    mode: 'in-process',
    capabilities: ['prompt-auth', 'terminal'],
    requiredEnvironment: [],
  },
  {
    name: 'serial',
    phase: 17,
    mode: 'native',
    capabilities: ['loopback', 'line-ending'],
    requiredEnvironment: ['serial-mock-binding'],
  },
  {
    name: 'rdp',
    phase: 17,
    mode: 'external',
    capabilities: ['display', 'input', 'resize'],
    requiredEnvironment: ['rdp-server'],
  },
  {
    name: 'vnc',
    phase: 17,
    mode: 'external',
    capabilities: ['display', 'input', 'clipboard'],
    requiredEnvironment: ['vnc-server'],
  },
  {
    name: 'spice',
    phase: 17,
    mode: 'external',
    capabilities: ['display', 'input', 'resize'],
    requiredEnvironment: ['spice-server'],
  },
  {
    name: 'web',
    phase: 17,
    mode: 'in-process',
    capabilities: ['navigation', 'popup', 'download'],
    requiredEnvironment: [],
  },
  {
    name: 'zmodem',
    phase: 17,
    mode: 'in-process',
    capabilities: ['send', 'receive', 'cancel'],
    requiredEnvironment: [],
  },
  {
    name: 'xmodem',
    phase: 17,
    mode: 'in-process',
    capabilities: ['send', 'receive', 'cancel'],
    requiredEnvironment: [],
  },
  {
    name: 'trzsz',
    phase: 17,
    mode: 'in-process',
    capabilities: ['send', 'receive', 'cancel'],
    requiredEnvironment: [],
  },
  {
    name: 'ai',
    phase: 20,
    mode: 'in-process',
    capabilities: ['openai-chat', 'openai-responses', 'anthropic', 'stream'],
    requiredEnvironment: [],
  },
  {
    name: 'sync',
    phase: 19,
    mode: 'in-process',
    capabilities: ['webdav', 'gist', 'custom'],
    requiredEnvironment: [],
  },
  {
    name: 'mcp',
    phase: 20,
    mode: 'in-process',
    capabilities: ['tools', 'approval', 'cancel'],
    requiredEnvironment: [],
  },
] as const satisfies readonly ProtocolFixtureDescriptor[];

export class ProtocolFixtureRegistry {
  readonly #definitions = new Map<ProtocolFixtureName, ProtocolFixture>();
  readonly #running = new Map<ProtocolFixtureName, RunningProtocolFixture>();

  register(fixture: ProtocolFixture): void {
    if (this.#definitions.has(fixture.descriptor.name))
      throw new Error(`Fixture already registered: ${fixture.descriptor.name}`);
    this.#definitions.set(fixture.descriptor.name, fixture);
  }

  async start(name: ProtocolFixtureName, signal?: AbortSignal): Promise<RunningProtocolFixture> {
    if (signal?.aborted) throw signal.reason;
    const existing = this.#running.get(name);
    if (existing) return existing;
    const fixture = this.#definitions.get(name);
    if (!fixture) throw new Error(`Fixture is not registered: ${name}`);
    const running = await fixture.start(signal);
    if (signal?.aborted) {
      await running.stop();
      throw signal.reason;
    }
    this.#running.set(name, running);
    return running;
  }

  async stop(name: ProtocolFixtureName): Promise<void> {
    const running = this.#running.get(name);
    if (!running) return;
    this.#running.delete(name);
    await running.stop();
  }

  async stopAll(): Promise<void> {
    const running = [...this.#running.values()].reverse();
    this.#running.clear();
    const results = await Promise.allSettled(running.map((fixture) => fixture.stop()));
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, 'One or more protocol fixtures failed to stop');
  }

  get running(): readonly ProtocolFixtureName[] {
    return [...this.#running.keys()];
  }
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export function createLineEchoFixture(
  name: Extract<ProtocolFixtureName, 'telnet' | 'ftp' | 'web'>,
): ProtocolFixture {
  const descriptor = protocolFixtureCatalog.find((item) => item.name === name);
  if (!descriptor) throw new Error(`No fixture descriptor for ${name}`);
  return {
    descriptor,
    async start(signal) {
      if (signal?.aborted) throw signal.reason;
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('data', (data) => socket.write(data));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        await closeServer(server, sockets);
        throw new Error(`${name} fixture did not bind a TCP port`);
      }
      let stopped = false;
      return {
        name,
        endpoints: { host: '127.0.0.1', port: address.port },
        metadata: { bounded: true, owner: 'ProtocolFixtureRegistry' },
        async stop() {
          if (stopped) return;
          stopped = true;
          await closeServer(server, sockets);
        },
      };
    },
  };
}
