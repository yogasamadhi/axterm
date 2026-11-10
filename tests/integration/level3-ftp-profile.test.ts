import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import { FilePaneOwner } from '../../packages/plugins/files/src/client/ui/pane-owner.ts';
import { NativeManagedImports } from '../../packages/infra/desktop-native/src/managed-imports.ts';
import * as Transfers from '../../packages/plugins/transfers/src/client/index.ts';
import { encodeOpaqueCredentialRef } from '@axterm/infra-credentials';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as ClientGateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Catalog from '../../packages/plugins/catalog/src/client/index.ts';
import * as Configuration from '../../packages/plugins/configuration/src/client/index.ts';
import * as Connections from '../../packages/plugins/connections/src/client/index.ts';
import * as Files from '../../packages/plugins/files/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { startFtpFixture } from '../fixtures/ftp-wire.ts';

it('runs real FTP through authenticated generated Remote, credential refs, complete Client metadata and unload', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-owned-ftp-profile-'));
  const password = 'CONTROLLED_FTP_PROFILE_SECRET';
  const vault = new EncryptedVault(join(home, 'vault-v2'));
  await vault.open();
  const saved = await vault.put({
    kind: 'password',
    label: 'Controlled FTP fixture',
    secret: password,
  });
  await vault.close();
  const server = await startFtpFixture({
    username: 'fixture',
    allowReplace: true,
    password,
    initialFiles: { '/uploads/notes.txt': 'private FTP text\r\n' },
  });
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  const sockets = new Set<WebSocket>();
  const wire: string[] = [];
  let grants: NativeFileGrantRegistry | undefined;
  const editedCopies: string[] = [];
  try {
    const profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'owned-ftp-profile',
        private: true,
        axterm: {
          profile: {
            bundles: [
              '@axterm/bundle-base',
              '@axterm/bundle-web',
              '@axterm/bundle-catalog',
              '@axterm/bundle-configuration',
              '@axterm/bundle-terminals',
              '@axterm/bundle-connections',
              '@axterm/bundle-files',
              '@axterm/bundle-transfers',
            ],
          },
        },
      }),
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([{ id: 'local-file-grants', disabled: true }]),
    );
    application = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: {},
      patchFiles: [],
      args: [],
      requiredServices: [
        'catalog',
        'connections',
        'filesController',
        'transfersController',
        'webStartup',
      ],
      prepare(ctx) {
        grants = new NativeFileGrantRegistry(ctx.runtimeIdentity.generation);
        const native = grants;
        ctx.effect(() => () => native.close());
        ctx.provide('fileGrants', {
          create: async () => undefined,
          list: async () => native.list().items,
          revoke: async (id: string) => {
            native.revoke(id);
          },
          authorize: async (id: string, permission: 'read' | 'write', signal?: AbortSignal) => ({
            authority: await native.authorize(id, permission, signal),
            signal: signal ?? new AbortController().signal,
            assert: () => signal?.throwIfAborted(),
            dispose: () => {},
          }),
          resolveDirectory: async () => {
            throw new Error('Unused fixture capability');
          },
          readText: async () => {
            throw new Error('Unused fixture capability');
          },
        });
        const managed = new NativeManagedImports(
          native,
          join(home, 'desktop/external-edit-copies'),
        );
        ctx.effect(() => () => managed.close());
        ctx.provide('fileImports', {
          prepare: (input, signal) => managed.prepare(input, signal),
          commit: (id, signal) => managed.commit(id, signal),
          discard: (id) => managed.discard(id),
        });
        ctx.provide('fileApplications', {
          open: async (id, path, signal) => {
            const authority = await native.authorize(id, 'read', signal);
            editedCopies.push(join(authority.rootPath, path));
          },
          reveal: async () => {},
        });
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const host = application.ctx;
    const ref = saved.ref;
    expect(await host.credentials.describe(encodeOpaqueCredentialRef(ref))).toMatchObject({
      configured: true,
    });
    const origin = new URL(host.webStartup.url).origin;
    const token = (await readFile(host.webStartup.tokenFile!, 'utf8')).trim();
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
          const socket = new WebSocket(url, { headers: { cookie, origin } });
          sockets.add(socket);
          socket.on('message', (bytes) => wire.push(bytes.toString()));
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(ClientGateway);
    await client.plugin(Catalog);
    const connectionOwner = client.plugin(Connections);
    await connectionOwner;
    const transferOwner = client.plugin(Transfers);
    await transferOwner;
    const transfers = client.transferActions;
    await vi.waitFor(() => expect(transfers.getSnapshot().status).toBe('ready'));
    const fileOwner = client.plugin(Files);
    await fileOwner;
    const catalog = client.catalogModel;
    const connections = client.connectionActions;
    const configurationOwner = client.plugin(Configuration);
    await configurationOwner;
    const settings = client.configurationActions;
    await vi.waitFor(() => expect(settings.getSnapshot().status).toBe('ready'));
    const settingState = settings.getSnapshot();
    if (settingState.status !== 'ready') throw Error('SETTINGS_UNAVAILABLE');
    const preferenceKey = randomUUID(),
      preferenceVersion = '"v' + settingState.baseline.settings.version + '"';
    const preferenceReceipt = await settings.setFileManagerPreferences(
      preferenceKey,
      { showHiddenFiles: false },
      preferenceVersion,
    );
    expect(
      await settings.setFileManagerPreferences(
        preferenceKey,
        { showHiddenFiles: false },
        preferenceVersion,
      ),
    ).toEqual(preferenceReceipt);
    await expect(
      settings.setFileManagerPreferences(
        randomUUID(),
        { showHiddenFiles: true },
        preferenceVersion,
      ),
    ).rejects.toMatchObject({ details: { reason: 'precondition-failed' } });
    await vi.waitFor(() => {
      const state = settings.getSnapshot();
      expect(state.status === 'ready' && state.baseline.settings.fileManager.showHiddenFiles).toBe(
        false,
      );
    });
    const files = client.fileGrantsModel;
    await vi.waitFor(() => expect(files.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(catalog.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(connections.getSnapshot().status).toBe('ready'));
    const state = catalog.getSnapshot();
    if (state.status !== 'ready') throw new Error('Catalog not ready');
    const created = await catalog.createBookmark(
      randomUUID(),
      {
        protocol: 'ftp',
        hostId: null,
        title: 'Owned FTP fixture',
        ftp: {
          hostname: '127.0.0.1',
          port: server.port,
          username: 'fixture',
          credentialRef: ref,
          security: 'plain',
          tlsVerify: true,
          encoding: 'utf-8',
          initialDirectory: '/uploads',
        },
      },
      state.baseline.bookmarks.etag,
    );
    const key = randomUUID();
    const metadata = await connections.createFtpConnection(key, { bookmarkId: created.ids[0]! });
    expect(
      await client.connectionActions.getFtpCommandOutcome(
        application.ctx.runtimeIdentity.generation,
        key,
      ),
    ).toEqual({ status: 'accepted', id: metadata.id });
    expect(
      await client.connectionActions.getFtpCommandOutcome(
        application.ctx.runtimeIdentity.generation,
        randomUUID(),
      ),
    ).toEqual({ status: 'missing' });
    await expect(
      client.connectionActions.getFtpCommandOutcome(randomUUID(), key),
    ).rejects.toMatchObject({ details: { reason: 'stale' } });
    expect(metadata).toMatchObject({
      state: 'ready',
      encoding: 'utf-8',
      initialDirectory: '/uploads',
    });
    expect((await connections.createFtpConnection(key, { bookmarkId: created.ids[0]! })).id).toBe(
      metadata.id,
    );
    await vi.waitFor(() => {
      const current = connections.getSnapshot();
      expect(
        current.status === 'ready' &&
          current.baseline.ftpConnections.some(
            (item) => item.id === metadata.id && item.state === 'ready',
          ),
      ).toBe(true);
    });
    const target = { protocol: 'ftp' as const, connectionId: metadata.id };
    const lease = await host.connections.openFiles(target);
    try {
      expect(await lease.filesystem.realpath('.')).toBe('/uploads');
      expect(await lease.filesystem.stat('/uploads')).toMatchObject({ isDirectory: true });
    } finally {
      await lease.close();
    }
    expect(await files.getRemoteHome(target)).toEqual({ path: '/uploads' });
    const selected = await grants!.createTrustedPath(home, 'directory', ['read', 'write']);
    await writeFile(join(home, 'transfer-source.txt'), 'real FTP transfer bytes');
    const transferKey = randomUUID();
    const request = {
      target,
      direction: 'upload' as const,
      grantId: selected.grantId,
      localPath: 'transfer-source.txt',
      remotePath: '/uploads/transferred.txt',
    };
    const upload = await transfers.create(transferKey, request);
    expect((await transfers.create(transferKey, request)).id).toBe(upload.id);
    expect(
      await transfers.getCommandOutcome(host.runtimeIdentity.generation, transferKey),
    ).toMatchObject({ status: 'accepted', transfer: { id: upload.id } });
    expect(
      await transfers.getCommandOutcome(host.runtimeIdentity.generation, randomUUID()),
    ).toEqual({ status: 'missing' });
    await vi.waitFor(async () => expect((await transfers.get(upload.id)).state).toBe('succeeded'));
    await vi.waitFor(() => {
      const state = transfers.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.items.some((item) => item.id === upload.id && item.state === 'succeeded'),
      ).toBe(true);
    });
    const download = await transfers.create(randomUUID(), {
      ...request,
      direction: 'download',
      localPath: 'transfer-download.txt',
    });
    await vi.waitFor(async () =>
      expect((await transfers.get(download.id)).state).toBe('succeeded'),
    );
    expect(await readFile(join(home, 'transfer-download.txt'), 'utf8')).toBe(
      'real FTP transfer bytes',
    );
    const text = await files.readRemoteText(target, '/uploads/notes.txt');
    expect(text).toMatchObject({ content: 'private FTP text\r\n', lineEnding: 'crlf' });
    expect(
      await files.compareFiles({
        left: { scope: 'remote', target, path: '/uploads/notes.txt' },
        right: { scope: 'remote', target, path: '/uploads/notes.txt' },
      }),
    ).toMatchObject({ status: 'equal' });
    const editors = files.openExternalEditors();
    await vi.waitFor(() => expect(editors.getSnapshot().status).toBe('ready'));
    const editorId = randomUUID();
    const editorReceipt = await files.createExternalEditor(editorId, target, '/uploads/notes.txt');
    expect(await files.createExternalEditor(editorId, target, '/uploads/notes.txt')).toEqual(
      editorReceipt,
    );
    expect(editedCopies).toHaveLength(1);
    await writeFile(editedCopies[0]! + '.tmp', 'edited FTP copy\r\n');
    await rename(editedCopies[0]! + '.tmp', editedCopies[0]!);
    await vi.waitFor(() => {
      const state = editors.getSnapshot();
      expect(state.status === 'ready' && state.baseline.sessions[0]?.state).toBe('changed');
    });
    expect((await files.readRemoteText(target, '/uploads/notes.txt')).content).toBe(
      'private FTP text\r\n',
    );
    const pushKey = randomUUID();
    await files.pushExternalEditor(pushKey, editorId);
    const pushedBytes = server.files.get('/uploads/notes.txt');
    await files.pushExternalEditor(pushKey, editorId);
    expect(server.files.get('/uploads/notes.txt')).toBe(pushedBytes);
    expect((await files.readRemoteText(target, '/uploads/notes.txt')).content).toBe(
      'edited FTP copy\r\n',
    );
    server.files.set('/uploads/notes.txt', Buffer.from('changed by remote peer'));
    await writeFile(editedCopies[0]!, 'later local change');
    await expect(files.pushExternalEditor(randomUUID(), editorId)).rejects.toMatchObject({
      details: { reason: 'conflict' },
    });
    expect(server.files.get('/uploads/notes.txt')!.toString()).toBe('changed by remote peer');
    await files.closeExternalEditor(randomUUID(), editorId);
    await vi.waitFor(() => {
      const state = editors.getSnapshot();
      expect(state.status === 'ready' && state.baseline.sessions.length).toBe(0);
    });
    await editors.retry();
    await vi.waitFor(() => expect(editors.getSnapshot().status).toBe('ready'));
    await editors.dispose();
    const pane = new FilePaneOwner(files);
    try {
      await pane.navigate({ kind: 'remote', target, path: '/uploads' });
      await vi.waitFor(() => expect(pane.getSnapshot().status).toBe('ready'));
      const paneState = pane.getSnapshot();
      expect(
        paneState.status === 'ready' &&
          paneState.baseline.entries.some((entry) => entry.name === 'notes.txt'),
      ).toBe(true);
      await pane.navigate({ kind: 'remote', target, path: '/' });
      await vi.waitFor(() => {
        const state = pane.getSnapshot();
        expect(state.status === 'ready' && state.baseline.path).toBe('/');
      });
    } finally {
      await pane.dispose();
    }
    expect(pane.resourceCount()).toBe(0);
    const directory = files.openRemoteDirectory(target, '/uploads');
    await vi.waitFor(() => expect(directory.getSnapshot().status).toBe('ready'));
    expect(JSON.stringify(directory.getSnapshot())).not.toContain('private FTP text');
    await files.createRemoteEntry(randomUUID(), target, {
      path: '/uploads/created.txt',
      type: 'file',
    });
    await files.operateRemoteEntries(randomUUID(), target, {
      paths: ['/uploads/created.txt'],
      destination: '/uploads',
      operation: 'copy',
    });
    expect(
      (await files.listRemoteDirectory(target, '/uploads')).entries.map((item) => item.name),
    ).toContain('created(copy-1).txt');
    const skipped = await files.operateRemoteEntries(randomUUID(), target, {
      paths: ['/uploads/created.txt'],
      destination: '/uploads',
      operation: 'copy',
      conflict: 'skip',
    });
    expect(skipped.changedCount).toBe(0);
    await files.deleteRemoteEntry(randomUUID(), target, '/uploads/created(copy-1).txt');
    for (const socket of sockets) socket.terminate();
    await connections.retry();
    await transfers.retry();
    await vi.waitFor(() => {
      const state = transfers.getSnapshot();
      expect(state.status === 'ready' && state.baseline.items.length).toBe(2);
    });
    await directory.retry();
    await vi.waitFor(() => {
      const current = connections.getSnapshot();
      expect(current.status === 'ready' && current.baseline.ftpConnections.length).toBe(1);
    });
    await directory.dispose();
    expect(JSON.stringify(connections.getSnapshot())).not.toContain(password);
    expect(wire.join('')).not.toContain(password);
    await connections.closeFtpConnection(metadata.id);
    expect((await connections.getFtpConnection(metadata.id)).state).toBe('closed');
    const clearKey = randomUUID();
    expect(await transfers.clearCompleted(clearKey)).toBe(2);
    expect(await transfers.clearCompleted(clearKey)).toBe(2);
    await expect(transfers.create(transferKey, request)).rejects.toMatchObject({
      code: 'transfers/failure',
      details: { reason: 'receipt-expired' },
    });
    await transferOwner.dispose();
    expect(() => transfers.subscribe(() => {})).toThrow('TRANSFERS_MODEL_CLOSED');
    await expect(transfers.create(randomUUID(), request)).rejects.toThrow('TRANSFERS_MODEL_CLOSED');
    await configurationOwner.dispose();
    await expect(
      settings.setFileManagerPreferences(randomUUID(), { showHiddenFiles: true }, '"v1"'),
    ).rejects.toThrow('SETTINGS_MODEL_CLOSED');
    expect(() => transfers.subscribe(() => {})).toThrow('TRANSFERS_MODEL_CLOSED');
    await fileOwner.dispose();
    await connectionOwner.dispose();
    expect(() => connections.subscribe(() => {})).toThrow('CONNECTIONS_MODEL_CLOSED');
    expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: false,
    });
  } finally {
    await client?.fiber.dispose();
    for (const socket of sockets) {
      socket.on('error', () => {});
      socket.terminate();
    }
    await application?.shutdown.shutdown(0);
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
