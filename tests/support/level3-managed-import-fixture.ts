import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  type NativeFileChooser,
  type NativeFileApplications,
  ShellFileGrantCapabilities,
} from '../../packages/infra/desktop-native/src/file-capabilities.ts';
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
export async function createManagedImportFixture(
  mode: 'desktop' | 'web' = 'web',
  options: { chooser?: NativeFileChooser; applications?: NativeFileApplications } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'axterm-import-owner-'));
  const generation = randomUUID();
  const shell = new Wire(),
    host = new Wire();
  shell.peer = host;
  host.peer = shell;
  const capabilities = new ShellFileGrantCapabilities(
    generation,
    options.chooser,
    join(home, 'imports'),
    options.applications,
  );
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
    mode,
    appVersion: '0.10.0',
  });
  const grantOwner = new DesktopFileGrants(ctx, native);
  const files = new GrantedStreamingFiles(() => ctx.fileGrants);
  let closing: Promise<void> | undefined;
  return {
    ctx,
    native,
    grantOwner,
    home,
    generation,
    capabilities,
    files,
    shell,
    host,
    close: () =>
      (closing ??= (async () => {
        await files.close();
        await ctx.fiber.dispose();
        native.close();
        await server.close();
        await rm(home, { recursive: true, force: true });
      })()),
  };
}
