import type {} from '@axterm/infra-web-startup';
import { Context } from '@deepseek-ai/cordis';
import { PassThrough, Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import {
  NativeClient,
  NativeServer,
  NativeError,
  ShellFileGrantCapabilities,
  nativeCapabilities,
  type NativeWire,
  type NativeFrame,
  type NativeHandlers,
} from '@axterm/infra-desktop-native';
import DesktopFileGrants from '@axterm/infra-desktop-native/files';
import DesktopFileApplications from '@axterm/infra-desktop-native/applications';
import {
  installConnection,
  type ConnectionWebSocket,
  type ConnectionHandle,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Files from '../../packages/plugins/files/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
class Wire implements NativeWire {
  readonly identity = {};
  connected = true;
  peer!: Wire;
  readonly messages = new Set<(value: unknown) => void>();
  send(frame: NativeFrame): Promise<void> {
    const value = structuredClone(frame);
    queueMicrotask(() => {
      for (const listener of this.peer.messages) listener(value);
    });
    return Promise.resolve();
  }
  onMessage(listener: (value: unknown) => void): () => void {
    this.messages.add(listener);
    return () => {
      this.messages.delete(listener);
    };
  }
  onDisconnect(): () => void {
    return () => {};
  }
}
it('runs authenticated generated file grants, atomic model replacement, local PTY cwd and cancellation in an isolated Profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-files-profile-'));
  let app: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  let server: NativeServer | undefined;
  let native: NativeClient | undefined;
  let channel: Terminals.TerminalStream | undefined;
  const sockets = new Set<WebSocket>();
  let opens = 0;
  const applicationCalls: { action: string; path: string }[] = [];
  let selected: Promise<string | undefined> = Promise.resolve(join(home, 'key.txt'));
  let shellFiles: ShellFileGrantCapabilities | undefined;
  try {
    await writeFile(join(home, 'key.txt'), 'CONTROLLED_KEY_FIXTURE');
    await mkdir(join(home, 'workspace'));
    const profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'isolated-files-profile',
        private: true,
        axterm: {
          profile: {
            bundles: [
              '@axterm/bundle-base',
              '@axterm/bundle-web',
              '@axterm/bundle-files',
              '@axterm/bundle-terminals',
            ],
          },
        },
      }),
    );
    const windows = process.platform === 'win32';
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        { id: 'local-file-grants', disabled: true },
        {
          id: 'terminals',
          config: {
            shell: windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
            shellArgs: windows ? ['/d', '/q'] : ['-f'],
            cwd: home,
            env: { HOME: home, HISTFILE: windows ? 'NUL' : '/dev/null', ENV: '' },
            maxSessions: 2,
          },
        },
      ]),
    );
    app = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: {},
      patchFiles: [],
      args: [],
      requiredServices: ['filesController', 'terminalController', 'webStartup'],
      prepare(ctx) {
        const host = new Wire();
        const shell = new Wire();
        host.peer = shell;
        shell.peer = host;
        shellFiles = new ShellFileGrantCapabilities(
          ctx.runtimeIdentity.generation,
          {
            choose: () => selected,
            defaultDirectory: () => home,
            retire: () => {},
          },
          undefined,
          {
            open: async (path) => {
              applicationCalls.push({ action: 'open', path });
            },
            reveal: async (path) => {
              applicationCalls.push({ action: 'reveal', path });
            },
          },
        );
        const handlers = {
          ...Object.fromEntries(
            Object.keys(nativeCapabilities).map((key) => [
              key,
              () => {
                throw new NativeError('NOT_FOUND');
              },
            ]),
          ),
          ...shellFiles.handlers(),
        } as NativeHandlers;
        const owned = shellFiles;
        server = new NativeServer(shell, ctx.runtimeIdentity.generation, handlers, () =>
          owned.close(),
        );
        native = new NativeClient(host, ctx.runtimeIdentity.generation);
        ctx.provide('desktopNative', native);
        ctx.plugin(DesktopFileGrants);
        ctx.plugin(DesktopFileApplications);
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const origin = new URL(app.ctx.webStartup.url).origin;
    const token = (await readFile(app.ctx.webStartup.tokenFile!, 'utf8')).trim();
    const auth = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(auth.status).toBe(200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    client = new Context();
    await client.plugin(Registry);
    installConnection(client, {
      interactions: 'answer',
      recovery: { backoffBaseMs: 10 },
      transport: {
        streamBaseUrl: origin + '/',
        fetch: (input, init) =>
          fetch(new URL(input, origin + '/'), {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          }),
        createWebSocket: (url) => {
          opens++;
          const socket = new WebSocket(url, { headers: { cookie, origin } });
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(Gateway);
    const owner = client.plugin(Files);
    await owner;
    await client.plugin(Terminals);
    const model = client.fileGrantsModel;
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    await expect(
      model.createInGeneration({ kind: 'save-file' }, randomUUID()),
    ).rejects.toMatchObject({ code: 'files/failure', details: { reason: 'stale' } });
    const directory = (await model.create({ kind: 'directory-path', path: home }))!;
    const directoryModel = model.openDirectory(directory.grantId, 'workspace');
    await vi.waitFor(() => expect(directoryModel.getSnapshot().status).toBe('ready'));
    const creationKey = randomUUID();
    const created = await model.createEntry(creationKey, directory.grantId, {
      path: 'workspace',
      name: 'created.txt',
      type: 'file',
    });
    expect(
      await model.createEntry(creationKey, directory.grantId, {
        path: 'workspace',
        name: 'created.txt',
        type: 'file',
      }),
    ).toEqual(created);
    await vi.waitFor(() => {
      const state = directoryModel.getSnapshot();
      expect(state.status === 'ready' && state.baseline.entries.map((entry) => entry.name)).toEqual(
        ['created.txt'],
      );
    });
    expect(await model.getFileOperationOutcome(creationKey)).toMatchObject({
      status: 'completed',
      receipt: created,
    });
    expect(await model.getFileOperationOutcome(randomUUID())).toMatchObject({ status: 'missing' });
    const staleOutcome = await client.remote.files.getFileOperationOutcome(
      randomUUID(),
      creationKey,
    );
    expect(staleOutcome).toMatchObject({
      ok: false,
      error: { code: 'files/failure', details: { reason: 'stale' } },
    });
    await model.renameEntry(randomUUID(), directory.grantId, {
      path: 'workspace/created.txt',
      name: 'renamed.txt',
    });
    await vi.waitFor(() => {
      const state = directoryModel.getSnapshot();
      expect(state.status === 'ready' && state.baseline.entries[0]?.name).toBe('renamed.txt');
    });
    expect(
      await model.compareFiles({
        left: { scope: 'local', grantId: directory.grantId, path: 'workspace/renamed.txt' },
        right: { scope: 'local', grantId: directory.grantId, path: 'workspace/renamed.txt' },
      }),
    ).toMatchObject({ status: 'equal', left: { name: 'renamed.txt', lineCount: 0 } });
    const nativeKey = randomUUID();
    const nativeOperation = {
      grantId: directory.grantId,
      path: 'workspace/renamed.txt',
      action: 'open' as const,
    };
    const nativeReceipt = await model.performNativeFileOperation(nativeKey, nativeOperation);
    expect(await model.performNativeFileOperation(nativeKey, nativeOperation)).toEqual(
      nativeReceipt,
    );
    expect(await model.getFileOperationOutcome(nativeKey)).toMatchObject({
      status: 'completed',
      receipt: nativeReceipt,
    });
    await model.performNativeFileOperation(randomUUID(), { ...nativeOperation, action: 'reveal' });
    expect(applicationCalls).toEqual([
      { action: 'open', path: join(await realpath(home), 'workspace/renamed.txt') },
      { action: 'reveal', path: join(await realpath(home), 'workspace/renamed.txt') },
    ]);
    expect(JSON.stringify(nativeReceipt)).not.toContain(home);
    await model.deleteEntry(randomUUID(), directory.grantId, 'workspace/renamed.txt');
    await vi.waitFor(() => {
      const state = directoryModel.getSnapshot();
      expect(state.status === 'ready' && state.baseline.entries.length).toBe(0);
    });
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.grants.some((value) => value.grantId === directory.grantId),
      ).toBe(true);
    });
    const terminal = await client.terminalsModel.create({
      kind: 'local',
      cols: 80,
      rows: 24,
      workingDirectory: { scope: 'local', grantId: directory.grantId, path: 'workspace' },
    });
    const awaitedDirectory = await realpath(join(home, 'workspace'));
    let output = '';
    let ready = false;
    const decoder = new TextDecoder();
    channel = new Terminals.TerminalStream(
      client.get('connection') as unknown as ConnectionHandle,
      {
        terminalId: terminal.id,
        writer: {
          write(bytes, done) {
            output = (
              output + (typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true }))
            ).slice(-16384);
            done();
          },
        },
        control: (value) => {
          if (value.type === 'ready') ready = true;
        },
      },
    );
    await vi.waitFor(() => expect(ready).toBe(true));
    expect(channel.sendInput(windows ? 'cd\r' : 'pwd\n')).toBe(true);
    await vi.waitFor(() => expect(output).toContain(awaitedDirectory));
    await client.terminalsModel.close(terminal.id);
    channel.dispose();
    channel = undefined;
    const streamPayload = Buffer.alloc(3 * 1024 * 1024, 0x6b);
    const checksum = createHash('sha256').update(streamPayload).digest('hex');
    const streamQuery = new URLSearchParams({
      grantId: directory.grantId,
      path: 'workspace/http-stream.bin',
    });
    const streamKey = randomUUID();
    const uploadHeaders = {
      'idempotency-key': streamKey,
      'x-axterm-file-bytes': String(streamPayload.length),
      'x-axterm-file-sha256': checksum,
      cookie,
    };
    const unauthenticated = await fetch(origin + '/api/files/read?' + streamQuery);
    expect(unauthenticated.status).toBe(401);
    const streamedUpload = await fetch(origin + '/api/files/write?' + streamQuery, {
      method: 'POST',
      headers: uploadHeaders,
      body: streamPayload,
    });
    expect(streamedUpload.status).toBe(200);
    const streamReceipt = await streamedUpload.json();
    const repeatedUpload = await fetch(origin + '/api/files/write?' + streamQuery, {
      method: 'POST',
      headers: uploadHeaders,
      body: streamPayload,
    });
    expect(repeatedUpload.status).toBe(200);
    expect(await repeatedUpload.json()).toEqual(streamReceipt);
    const download = await fetch(origin + '/api/files/read?' + streamQuery, {
      headers: { cookie },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-length')).toBe(String(streamPayload.length));
    const actualBytes = Buffer.from(await download.arrayBuffer());
    expect(actualBytes.length).toBe(streamPayload.length);
    expect(createHash('sha256').update(actualBytes).digest('hex')).toBe(checksum);
    const range = await fetch(origin + '/api/files/read?' + streamQuery + '&start=7&end=19', {
      headers: { cookie },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 7-19/${streamPayload.length}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(streamPayload.subarray(7, 20));
    const refused = await fetch(origin + '/api/files/write?' + streamQuery + '&overwrite=true', {
      method: 'POST',
      headers: {
        ...uploadHeaders,
        'idempotency-key': randomUUID(),
        'x-axterm-file-sha256': '0'.repeat(64),
      },
      body: streamPayload,
    });
    expect(refused.status).toBe(400);
    expect(
      createHash('sha256')
        .update(await readFile(join(home, 'workspace/http-stream.bin')))
        .digest('hex'),
    ).toBe(checksum);
    const invalidRange = await fetch(
      origin + '/api/files/read?' + streamQuery + '&start=' + streamPayload.length,
      { headers: { cookie } },
    );
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get('content-range')).toBe(`bytes */${streamPayload.length}`);
    const ambiguous = await fetch(
      origin + '/api/files/read?' + streamQuery + '&grantId=duplicate',
      { headers: { cookie } },
    );
    expect(ambiguous.status).toBe(400);
    const interruptedBody = new PassThrough();
    interruptedBody.on('error', () => {});
    const interruptedSignal = new AbortController();
    const interruptedUpload = fetch(
      origin + '/api/files/write?' + streamQuery + '&overwrite=true',
      {
        method: 'POST',
        headers: { ...uploadHeaders, 'idempotency-key': randomUUID() },
        body: Readable.toWeb(interruptedBody),
        signal: interruptedSignal.signal,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
    );
    const interrupted = expect(interruptedUpload).rejects.toThrow();
    interruptedBody.write(Buffer.alloc(64 * 1024, 0x6b));
    await vi.waitFor(async () =>
      expect(
        (await readdir(join(home, 'workspace'))).some((name) => name !== 'http-stream.bin'),
      ).toBe(true),
    );
    interruptedSignal.abort();
    await interrupted;
    interruptedBody.destroy();
    await vi.waitFor(async () =>
      expect(await readdir(join(home, 'workspace'))).toEqual(['http-stream.bin']),
    );
    expect(
      createHash('sha256')
        .update(await readFile(join(home, 'workspace/http-stream.bin')))
        .digest('hex'),
    ).toBe(checksum);
    const removeStreamed = await app.ctx.files.open(directory.grantId, 'write');
    await removeStreamed.remove('workspace/http-stream.bin');
    await removeStreamed.close();
    const writing = await app.ctx.files.open(directory.grantId, 'write');
    await writing.write('workspace/streamed.txt', Readable.from('OWNED_STREAM_BYTES'));
    expect(await app.ctx.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: true,
    });
    await writing.close();
    const reading = await app.ctx.files.open(directory.grantId, 'read');
    const stream = await reading.read('workspace/streamed.txt');
    let streamed = '';
    for await (const chunk of stream) streamed += chunk.toString();
    expect(streamed).toBe('OWNED_STREAM_BYTES');
    await reading.close();
    const cleanup = await app.ctx.files.open(directory.grantId, 'write');
    await cleanup.remove('workspace/streamed.txt');
    await cleanup.close();
    const file = (await model.create({ kind: 'open-file' }))!;
    expect(await model.readText(file.grantId, 1024)).toEqual({
      name: 'key.txt',
      content: 'CONTROLLED_KEY_FIXTURE',
    });
    const previous = model.getSnapshot();
    const before = opens;
    for (const socket of sockets) socket.terminate();
    await vi.waitFor(() => {
      expect(opens).toBeGreaterThan(before);
      expect(model.getSnapshot()).not.toBe(previous);
      expect(model.getSnapshot().status).toBe('ready');
      expect(directoryModel.getSnapshot().status).toBe('ready');
    });
    const revoked = await app.ctx.files.open(file.grantId, 'read');
    const paused = await revoked.read(revoked.path);
    await model.revoke(file.grantId);
    await revoked.close();
    expect(paused.closed).toBe(true);
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.grants.some((value) => value.grantId === file.grantId),
      ).toBe(false);
    });
    await expect(model.readText(file.grantId, 1024)).rejects.toMatchObject({
      details: { reason: 'not-found' },
    });
    const selection = Promise.withResolvers<string | undefined>();
    selected = selection.promise;
    const abort = new AbortController();
    const pending = model.create({ kind: 'open-file' }, abort.signal);
    const cancelled = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(shellFiles!.resourceCount()).toBe(1));
    abort.abort();
    await cancelled;
    selection.resolve(join(home, 'key.txt'));
    await vi.waitFor(() => expect(shellFiles!.resourceCount()).toBe(0));
    expect(shellFiles!.registry.resourceCount()).toBe(1);
    await model.retry();
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    await owner.dispose();
    expect(() => directoryModel.subscribe(() => {})).toThrow('FILE_DIRECTORY_MODEL_CLOSED');
    await expect(model.create({ kind: 'open-file' })).rejects.toThrow('FILE_GRANTS_MODEL_CLOSED');
    expect(app.ctx.terminals.resourceCount()).toBe(0);
  } finally {
    channel?.dispose();
    await client?.fiber.dispose();
    for (const socket of sockets) {
      socket.on('error', () => {});
      socket.terminate();
    }
    await app?.shutdown.shutdown(0);
    native?.close();
    await server?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
