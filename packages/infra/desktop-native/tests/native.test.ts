import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { EncryptedVault, LocalVaultCredentials } from '@axterm/infra-credential-vault';
import { credentialRef, credentialKey, encodeOpaqueCredentialRef } from '@axterm/infra-credentials';
import {
  NativeClient,
  NativeServer,
  NativeError,
  nativeCapabilities,
  MAX_NATIVE_FRAME_BYTES,
  MAX_NATIVE_REQUESTS,
  parseNativeFrame,
  ShellVaultCapabilities,
  NativeVaultPort,
  DesktopVaultCredentials,
  nodeIpcWire,
  type NativeWire,
  type NativeFrame,
  type NativeHandlers,
} from '../src/index.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
class Wire implements NativeWire {
  readonly identity = {};
  connected = true;
  readonly messages = new Set<(message: unknown) => void>();
  readonly disconnects = new Set<() => void>();
  readonly sent: NativeFrame[] = [];
  peer!: Wire;
  send(frame: NativeFrame): Promise<void> {
    if (!this.connected) return Promise.reject(new Error('wire-private-error'));
    this.sent.push(structuredClone(frame));
    const copy = structuredClone(frame);
    queueMicrotask(() => {
      for (const listener of this.peer.messages) listener(copy);
    });
    return Promise.resolve();
  }
  onMessage(listener: (frame: unknown) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onDisconnect(listener: () => void): () => void {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }
  inject(frame: unknown): void {
    for (const listener of this.messages) listener(frame);
  }
  disconnect(): void {
    this.connected = false;
    this.peer.connected = false;
    for (const listener of [...this.disconnects, ...this.peer.disconnects]) listener();
  }
}
function wires(): [Wire, Wire] {
  const a = new Wire();
  const b = new Wire();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
function handlers(overrides: Partial<NativeHandlers> = {}): NativeHandlers {
  return {
    ...Object.fromEntries(
      Object.keys(nativeCapabilities).map((key) => [
        key,
        () => {
          throw new NativeError('NOT_FOUND');
        },
      ]),
    ),
    ...overrides,
  } as NativeHandlers;
}
function bridge(overrides: Partial<NativeHandlers> = {}) {
  const [host, shell] = wires();
  const generation = randomUUID();
  const server = new NativeServer(shell, generation, handlers(overrides));
  cleanups.push(() => server.close());
  const client = new NativeClient(host, generation);
  cleanups.push(() => client.close());
  return { host, shell, server, client, generation };
}
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'axterm-native-port-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function physical() {
  const path = await directory();
  const vault = new EncryptedVault(path);
  cleanups.push(() => vault.close());
  await vault.open();
  return { path, vault };
}
async function vaultPort(leaseMs?: number) {
  const { path, vault } = await physical();
  const [host, shell] = wires();
  const generation = randomUUID();
  const owner = new ShellVaultCapabilities(vault, shell, generation, leaseMs);
  cleanups.push(() => owner.close());
  const client = new NativeClient(host, generation);
  cleanups.push(() => client.close());
  const port = new NativeVaultPort(client);
  await port.open();
  cleanups.push(() => port.close());
  return { path, vault, host, shell, generation, owner, client, port };
}
it('rejects business dispatch, extra fields, malformed envelopes and oversized native frames', () => {
  const base = {
    kind: 'axterm-native',
    version: 1,
    generation: randomUUID(),
    id: randomUUID(),
    type: 'request',
    method: 'vault.ready',
    input: {},
  };
  expect(parseNativeFrame(base)).toEqual(base);
  for (const invalid of [
    { ...base, method: 'terminals.execute' },
    { ...base, service: 'plugins', args: ['install'] },
    { ...base, generation: 'old' },
    { ...base, input: 'x'.repeat(MAX_NATIVE_FRAME_BYTES) },
  ])
    expect(() => parseNativeFrame(invalid)).toThrow('DESKTOP_NATIVE_PROTOCOL');
});
it('owns each inherited channel once and validates inputs before dispatch', async () => {
  const ready = vi.fn(() => true as const);
  const b = bridge({ 'vault.ready': ready });
  expect(() => new NativeClient(b.host, b.generation)).toThrow('DESKTOP_NATIVE_PROTOCOL');
  expect(() => new NativeServer(b.shell, b.generation, handlers())).toThrow(
    'DESKTOP_NATIVE_PROTOCOL',
  );
  await expect(
    b.client.call('vault.ready', { extra: 'private' } as unknown as Record<string, never>),
  ).rejects.toThrow('DESKTOP_NATIVE_INVALID');
  expect(ready).not.toHaveBeenCalled();
  expect(await b.client.call('vault.ready', {})).toBe(true);
  b.client.close();
  await b.server.close();
  expect(b.host.messages.size).toBe(0);
  expect(b.shell.messages.size).toBe(0);
});
it('validates both handler results and received responses without retaining exception data', async () => {
  const b = bridge({ 'vault.ready': () => 'private-result' as unknown as true });
  await expect(b.client.call('vault.ready', {})).rejects.toThrow('DESKTOP_NATIVE_FAILED');
  expect(JSON.stringify(b.shell.sent)).not.toContain('private-result');
  const c = bridge({
    'vault.ready': async (_, signal) =>
      new Promise<true>((resolve) =>
        signal.addEventListener('abort', () => resolve(true), { once: true }),
      ),
  });
  const pending = c.client.call('vault.ready', {});
  const request = c.host.sent[0]!;
  c.host.inject({
    kind: 'axterm-native',
    version: 1,
    generation: c.generation,
    id: request.id,
    type: 'result',
    value: 'invalid-private',
  });
  await expect(pending).rejects.toThrow('DESKTOP_NATIVE_PROTOCOL');
  await c.server.close();
});
it('bounds client and server pending work and cancels admitted work on disconnect', async () => {
  let cancelled = 0;
  const b = bridge({
    'vault.ready': async (_, signal) =>
      new Promise<true>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled++;
            resolve(true);
          },
          { once: true },
        ),
      ),
  });
  const pending = Array.from({ length: MAX_NATIVE_REQUESTS }, () =>
    b.client.call('vault.ready', {}).catch((error: unknown) => error),
  );
  await vi.waitFor(() =>
    expect(b.host.sent.filter((frame) => frame.type === 'request')).toHaveLength(
      MAX_NATIVE_REQUESTS,
    ),
  );
  await expect(b.client.call('vault.ready', {})).rejects.toThrow('DESKTOP_NATIVE_LIMIT');
  b.host.disconnect();
  expect(
    (await Promise.all(pending)).every(
      (error) => error instanceof NativeError && error.code === 'CLOSED',
    ),
  ).toBe(true);
  await b.server.close();
  expect(cancelled).toBe(MAX_NATIVE_REQUESTS);
  expect(b.host.messages.size).toBe(0);
  expect(b.shell.messages.size).toBe(0);
});
it('ignores other control messages and stale generation replies, and rejects duplicate current request identities', async () => {
  const b = bridge({ 'vault.ready': () => true });
  b.shell.inject({ type: 'shutdown' });
  b.host.inject({
    kind: 'axterm-native',
    version: 1,
    generation: randomUUID(),
    id: randomUUID(),
    type: 'result',
    value: true,
  });
  expect(await b.client.call('vault.ready', {})).toBe(true);
  b.shell.inject(b.host.sent.find((frame) => frame.type === 'request'));
  await vi.waitFor(() => expect(b.shell.messages.size).toBe(0));
  await expect(b.client.call('vault.ready', {})).rejects.toThrow('DESKTOP_NATIVE_CLOSED');
});
it('aborts and times out requests, ignores late results and redacts thrown handler errors', async () => {
  let cancelled = 0;
  const b = bridge({
    'vault.ready': async (_, signal) =>
      new Promise<true>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled++;
            resolve(true);
          },
          { once: true },
        ),
      ),
    'vault.list': () => {
      throw new Error('private-handler-error');
    },
  });
  const abort = new AbortController();
  const first = b.client.call('vault.ready', {}, abort.signal);
  await vi.waitFor(() => expect(b.host.sent.length).toBe(1));
  abort.abort();
  await expect(first).rejects.toThrow('DESKTOP_NATIVE_CANCELLED');
  await expect(b.client.call('vault.ready', {}, undefined, 5)).rejects.toThrow(
    'DESKTOP_NATIVE_TIMEOUT',
  );
  await vi.waitFor(() => expect(cancelled).toBe(2));
  await expect(b.client.call('vault.list', {})).rejects.toThrow('DESKTOP_NATIVE_FAILED');
  expect(JSON.stringify(b.shell.sent)).not.toContain('private-handler-error');
});
it('exposes actual encrypted Vault CRUD and original credential identifiers through the narrow port', async () => {
  const f = await vaultPort();
  const metadata = await f.client.call('vault.put', {
    kind: 'password',
    label: 'SSH',
    secret: 'retained',
  });
  expect(await f.port.get(metadata.ref)).toBe('retained');
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(DesktopVaultCredentials, f.client);
  const ref = encodeOpaqueCredentialRef(metadata.ref);
  await ctx.credentials.set(ref, 'updated');
  expect(await f.vault.get(metadata.ref)).toBe('updated');
  expect(await f.port.list()).toHaveLength(1);
  await ctx.credentials.unset(ref);
  expect(await ctx.credentials.resolve(ref)).toBeUndefined();
  expect(JSON.stringify(f.host.sent)).not.toContain('master.key');
});
it('holds a real cross-Profile record lease across the Host callback and does not lose concurrent updates', async () => {
  const f = await vaultPort();
  const host = new Context();
  const web = new Context();
  cleanups.push(
    () => host.fiber.dispose(),
    () => web.fiber.dispose(),
  );
  await host.plugin(DesktopVaultCredentials, f.client);
  await web.plugin(LocalVaultCredentials, { directory: f.path });
  const key = credentialKey('engine-pi', 'refresh');
  const ref = credentialRef('API_KEY');
  await host.credentials.set(ref, 'reference');
  await host.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: 0 }));
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      (i % 2 ? host : web).credentials.modifyRecord(key, async (current) => {
        expect(await host.credentials.resolve(ref)).toMatchObject({ value: 'reference' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          kind: 'grant',
          payload: (current?.kind === 'grant' ? Number(current.payload) : 0) + 1,
        };
      }),
    ),
  );
  expect(await host.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: 6 });
});
it('expires abandoned leases, rejects their later commit and releases the physical lock', async () => {
  const f = await vaultPort(20);
  const address = { space: 'record' as const, key: 'engine-pi/expired' };
  const lease = await f.client.call('vault.address.acquire', { address });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await expect(
    f.client.call('vault.address.commit', { leaseId: lease.leaseId, value: 'must-not-write' }),
  ).rejects.toThrow('DESKTOP_NATIVE_LEASE_EXPIRED');
  expect(await f.vault.modifyAddress(address, async () => 'after-expiry')).toBe('after-expiry');
});
it('releases leases on disconnect and drains Host credentials before provider unload', async () => {
  const f = await vaultPort();
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  const owner = ctx.plugin(DesktopVaultCredentials, f.client);
  await owner;
  const credentials = ctx.credentials;
  const key = credentialKey('engine-pi', 'drain');
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const mutation = credentials.modifyRecord(key, async () => {
    entered.resolve();
    await proceed.promise;
    return { kind: 'api-key' };
  });
  await entered.promise;
  let closed = false;
  const closing = owner.dispose().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(closed).toBe(false);
  proceed.resolve();
  await mutation;
  await closing;
  await expect(credentials.readRecord(key)).rejects.toThrow('VAULT_CLOSED');
  const address = { space: 'record' as const, key: 'engine-pi/disconnect' };
  await f.client.call('vault.address.acquire', { address });
  f.host.disconnect();
  await f.owner.close();
  expect(await f.vault.modifyAddress(address, async () => 'after-disconnect')).toBe(
    'after-disconnect',
  );
});
it('runs the compiled protocol and credentials provider over real Node IPC with no Electron import', async () => {
  const { path, vault } = await physical();
  const generation = randomUUID();
  const script = join(path, 'host.mjs');
  const module = new URL('../lib/index.js', import.meta.url).href;
  await writeFile(
    script,
    `import {NativeClient,NativeVaultPort,nodeIpcWire} from ${JSON.stringify(module)};\nconst c=new NativeClient(nodeIpcWire(process),process.argv[2]);const p=new NativeVaultPort(c);try{await p.open();await p.modifyAddress({space:'reference',key:'API_KEY'},async()=> 'ipc-test-secret');if(await p.readAddress({space:'reference',key:'API_KEY'})!=='ipc-test-secret')throw new Error('IPC test failed');await p.close();c.close();process.disconnect();}catch{process.exitCode=1;if(process.connected)process.disconnect();}\n`,
  );
  const child = fork(script, [generation], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => {});
  });
  const owner = new ShellVaultCapabilities(vault, nodeIpcWire(child), generation);
  cleanups.push(() => owner.close());
  const code = await exited;
  expect(code).toBe(0);
  await owner.close();
  expect(await vault.readAddress({ space: 'reference', key: 'API_KEY' })).toBe('ipc-test-secret');
  expect(await readFile(join(path, 'metadata.json'), 'utf8')).not.toContain('ipc-test-secret');
});
it('retains the unique server owner until admitted handlers finish draining', async () => {
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const b = bridge({
    'vault.ready': async () => {
      entered.resolve();
      await proceed.promise;
      return true as const;
    },
  });
  const pending = b.client.call('vault.ready', {}).catch((error: unknown) => error);
  await entered.promise;
  const closing = b.server.close();
  expect(() => new NativeServer(b.shell, b.generation, handlers())).toThrow(
    'DESKTOP_NATIVE_PROTOCOL',
  );
  proceed.resolve();
  await closing;
  expect(await pending).toBeInstanceOf(NativeError);
  const replacement = new NativeServer(b.shell, randomUUID(), handlers());
  await replacement.close();
});
it('enforces the server concurrency budget independently of the cooperating client', async () => {
  let entered = 0;
  const b = bridge({
    'vault.ready': async (_, signal) =>
      new Promise<true>((resolve) => {
        entered++;
        signal.addEventListener('abort', () => resolve(true), { once: true });
      }),
  });
  for (let i = 0; i <= MAX_NATIVE_REQUESTS; i++)
    b.shell.inject({
      kind: 'axterm-native',
      version: 1,
      generation: b.generation,
      id: randomUUID(),
      type: 'request',
      method: 'vault.ready',
      input: {},
    });
  await vi.waitFor(() => expect(entered).toBe(MAX_NATIVE_REQUESTS));
  expect(
    b.shell.sent.filter((frame) => frame.type === 'error' && frame.code === 'LIMIT'),
  ).toHaveLength(1);
  await b.server.close();
});
it('cancels a lease acquisition waiting behind another Profile and leaves that owner untouched', async () => {
  const f = await vaultPort();
  const address = { space: 'record' as const, key: 'engine-pi/waiting' };
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const write = f.vault.modifyAddress(address, async () => {
    entered.resolve();
    await proceed.promise;
    return 'owner';
  });
  await entered.promise;
  const abort = new AbortController();
  const waiting = f.client.call('vault.address.acquire', { address }, abort.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  await expect(waiting).rejects.toThrow('DESKTOP_NATIVE_CANCELLED');
  await f.owner.close();
  proceed.resolve();
  await write;
  expect(await f.vault.readAddress(address)).toBe('owner');
});
it('drains direct port mutations before closing and rejects mutation failures without exception data', async () => {
  const f = await vaultPort();
  const address = { space: 'record' as const, key: 'engine-pi/direct' };
  await expect(
    f.port.modifyAddress(address, async () => {
      throw new Error('private-mutation-error');
    }),
  ).rejects.toThrow('VAULT_MUTATION_FAILED');
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const write = f.port.modifyAddress(address, async () => {
    entered.resolve();
    await proceed.promise;
    return 'committed';
  });
  await entered.promise;
  let closed = false;
  const closing = f.port.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(closed).toBe(false);
  await expect(f.port.readAddress(address)).rejects.toThrow('VAULT_CLOSED');
  proceed.resolve();
  await write;
  await closing;
  expect(await f.vault.readAddress(address)).toBe('committed');
});
it('rejects raw extra native arguments at the server without dispatching a handler or echoing inputs', async () => {
  const ready = vi.fn(() => true as const);
  const b = bridge({ 'vault.ready': ready });
  b.shell.inject({
    kind: 'axterm-native',
    version: 1,
    generation: b.generation,
    id: randomUUID(),
    type: 'request',
    method: 'vault.ready',
    input: { secret: 'private-extra-field' },
  });
  await vi.waitFor(() =>
    expect(
      b.shell.sent.filter((frame) => frame.type === 'error' && frame.code === 'INVALID'),
    ).toHaveLength(1),
  );
  expect(ready).not.toHaveBeenCalled();
  expect(JSON.stringify(b.shell.sent)).not.toContain('private-extra-field');
  expect(await b.client.call('vault.ready', {})).toBe(true);
});
it('retains active request identities after the bounded completed-identity window rolls over', async () => {
  let starts = 0;
  const b = bridge({
    'vault.ready': async (_, signal) =>
      new Promise<true>((resolve) => {
        starts++;
        signal.addEventListener('abort', () => resolve(true), { once: true });
      }),
  });
  const pending = b.client.call('vault.ready', {}).catch((error: unknown) => error);
  await vi.waitFor(() => expect(starts).toBe(1));
  const first = b.host.sent[0]!;
  for (let i = 0; i < 260; i++)
    b.shell.inject({ ...first, id: randomUUID(), input: { invalid: true } });
  b.shell.inject(first);
  await b.server.close();
  expect(await pending).toBeInstanceOf(NativeError);
  expect(starts).toBe(1);
});

it('keeps managed saved-credential publication and replacement native, generation-bound and equivalent to the local port', async () => {
  const { port, generation, vault } = await vaultPort();
  const ref = 'cred_' + randomUUID();
  const marker = { generation, commandId: randomUUID() };
  const created = await port.createAt(
    ref,
    { kind: 'aiApiKey', label: 'Native model fixture', secret: 'PRIVATE_NATIVE_SAVED' },
    marker,
  );
  expect(created.mutation).toEqual(marker);
  expect(await vault.get(ref)).toBe('PRIVATE_NATIVE_SAVED');
  await expect(
    port.createAt(
      ref,
      { kind: 'aiApiKey', label: 'collision', secret: 'PRIVATE_COLLISION' },
      marker,
    ),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(
    port.replaceManaged(ref, 'PRIVATE_STALE', {
      generation: randomUUID(),
      commandId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'INVALID' });
  expect(await vault.get(ref)).toBe('PRIVATE_NATIVE_SAVED');
  const next = { generation, commandId: randomUUID() };
  await port.replaceManaged(ref, 'PRIVATE_NATIVE_UPDATED', next);
  expect((await vault.list())[0]!.mutation).toEqual(next);
  await port.replace(ref, 'PRIVATE_NATIVE_UNMANAGED');
  expect((await vault.list())[0]!.mutation).toBeUndefined();
});
