import { Context } from '@deepseek-ai/cordis';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import {
  NativeClient,
  NativeServer,
  type NativeWire,
} from '../../packages/infra/desktop-native/src/bridge.ts';
import {
  nativeCapabilities,
  NativeError,
  type NativeFrame,
  type NativeHandlers,
} from '../../packages/infra/desktop-native/src/protocol.ts';
import { ShellFileGrantCapabilities } from '../../packages/infra/desktop-native/src/file-capabilities.ts';
import DesktopFileGrants from '../../packages/infra/desktop-native/src/file-grants.ts';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';

class Wire implements NativeWire {
  readonly identity = {};
  readonly connected = true;
  peer!: Wire;
  readonly frames: NativeFrame[] = [];
  private readonly listeners = new Set<(value: unknown) => void>();
  send(frame: NativeFrame): Promise<void> {
    const value = structuredClone(frame);
    this.frames.push(value);
    queueMicrotask(() => {
      for (const listener of this.peer.listeners) listener(value);
    });
    return Promise.resolve();
  }
  onMessage(listener: (value: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onDisconnect(): () => void {
    return () => {};
  }
}
it('streams real Host file bytes under shell-issued authority while native IPC carries metadata only, then retires the generation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-import-bridge-'));
  const generation = randomUUID();
  const shell = new Wire(),
    host = new Wire();
  shell.peer = host;
  host.peer = shell;
  const capabilities = new ShellFileGrantCapabilities(generation, undefined, join(home, 'imports'));
  const handlers = {
    ...Object.fromEntries(
      Object.keys(nativeCapabilities).map((key) => [
        key,
        () => {
          throw new NativeError('UNAVAILABLE');
        },
      ]),
    ),
    ...capabilities.handlers(),
  } as NativeHandlers;
  const server = new NativeServer(shell, generation, handlers, () => capabilities.close());
  const native = new NativeClient(host, generation);
  const ctx = new Context();
  ctx.provide('runtimeIdentity', {
    generation,
    runtimeId: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'desktop',
    appVersion: '0.10.0',
  });
  new DesktopFileGrants(ctx, native);
  const files = new GrantedStreamingFiles(() => ctx.fileGrants);
  try {
    const bodyCanary = 'BODY_CANARY_' + randomUUID();
    const block = Buffer.alloc(64 * 1024, 0x61);
    block.write(bodyCanary);
    const count = 64;
    const expected = createHash('sha256');
    const grant = await ctx.fileImports.prepare(
      { name: 'uploaded.bin', size: block.length * count, editable: false },
      new AbortController().signal,
    );
    expect(await ctx.fileGrants.list()).toEqual([]);
    const writer = await files.open(grant.grantId, 'write');
    try {
      const source = Readable.from(
        (async function* () {
          for (let index = 0; index < count; index++) {
            expected.update(block);
            yield block;
          }
        })(),
      );
      await writer.write(writer.path, source, { overwrite: true, mode: 0o600 });
    } finally {
      await writer.close();
    }
    const published = await ctx.fileImports.commit(grant.grantId, new AbortController().signal);
    expect(published.permissions).toEqual(['read']);
    expect(await ctx.fileGrants.list()).toEqual([published]);
    const reader = await files.open(published.grantId, 'read');
    const actual = createHash('sha256');
    try {
      for await (const chunk of await reader.read(reader.path)) actual.update(chunk);
    } finally {
      await reader.close();
    }
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
    expect(JSON.stringify([...shell.frames, ...host.frames])).not.toContain(bodyCanary);
    await ctx.fileGrants.revoke(published.grantId);
    expect(await ctx.fileGrants.list()).toEqual([]);
    await files.close();
    expect(files.resourceCount()).toBe(0);
    await ctx.fiber.dispose();
    await native.close();
    await server.close();
    expect(capabilities.resourceCount()).toBe(0);
  } finally {
    await files.close();
    await ctx.fiber.dispose();
    await native.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
