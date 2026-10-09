import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { HostCapabilityServer } from '../../apps/desktop/src/main/host-capabilities/server';
import type { DesktopUpdaterPort } from '../../apps/desktop/src/main/host-capabilities/signed-release-updater';

const servers: HostCapabilityServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.clearAllMocks();
});

function createWindow() {
  let minimized = false;
  let maximized = false;
  let fullScreen = false;
  let destroyed = false;
  let opacity = 1;
  let zoomFactor = 1;
  let bounds = { x: 0, y: 0, width: 1180, height: 780 };
  const close = vi.fn(() => {
    destroyed = true;
  });
  return {
    close,
    isClosable: () => true,
    isDestroyed: () => destroyed,
    isFocused: () => true,
    isFullScreen: () => fullScreen,
    isMaximizable: () => true,
    isMaximized: () => maximized,
    isMinimizable: () => true,
    isMinimized: () => minimized,
    isVisible: () => !destroyed,
    maximize: () => {
      maximized = true;
      minimized = false;
    },
    minimize: () => {
      minimized = true;
    },
    setFullScreen: (value: boolean) => {
      fullScreen = value;
    },
    setBounds: (value: typeof bounds) => {
      bounds = value;
    },
    setOpacity: (value: number) => {
      opacity = value;
    },
    webContents: {
      setZoomFactor: (value: number) => {
        zoomFactor = value;
      },
    },
    unmaximize: () => {
      maximized = false;
    },
    preferenceState: () => ({ opacity, zoomFactor, bounds }),
  };
}

describe('Desktop Host window capability', () => {
  it('grants the system home and an explicitly entered absolute directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-home-directory-grant-'));
    directories.push(directory);
    const home = join(directory, 'home');
    const other = join(directory, 'other');
    await mkdir(home);
    await mkdir(other);
    await writeFile(join(home, 'home.txt'), 'home');
    const server = new HostCapabilityServer(join(directory, 'host'), () => undefined, {
      getHomeDirectory: () => home,
    });
    servers.push(server);
    await server.start();
    const active = server.activate(randomUUID());
    const headers = {
      Authorization: `Bearer ${active.hostCapabilityToken}`,
      'Content-Type': 'application/json',
    };

    const homeResponse = await fetch(`${active.hostCapabilityUrl}/host/v1/grants/directory`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(homeResponse.status).toBe(201);
    const homeGrant = (await homeResponse.json()) as {
      grantId: string;
      rootPath: string;
      permissions: string[];
    };
    expect(homeGrant).toMatchObject({
      rootPath: await realpath(home),
      permissions: ['read', 'write'],
    });
    expect(homeGrant).not.toHaveProperty('path');
    const homeListing = await fetch(
      `${active.hostCapabilityUrl}/host/v1/grants/${homeGrant.grantId}/list`,
      { method: 'POST', headers, body: JSON.stringify({ path: '' }) },
    );
    expect(await homeListing.json()).toMatchObject({
      entries: [{ name: 'home.txt', path: 'home.txt' }],
    });

    const otherResponse = await fetch(`${active.hostCapabilityUrl}/host/v1/grants/directory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: other }),
    });
    expect(otherResponse.status).toBe(201);
    expect(await otherResponse.json()).toMatchObject({ rootPath: await realpath(other) });
  });

  it('lists bounded relative metadata inside an authorized local directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-directory-grant-'));
    directories.push(directory);
    const selected = join(directory, 'selected');
    await mkdir(join(selected, 'folder'), { recursive: true });
    await writeFile(join(selected, 'notes.txt'), 'local file');
    await writeFile(join(selected, 'folder', 'nested.txt'), 'nested local file');
    const opened: string[] = [];
    const revealed: string[] = [];
    const copied: string[][] = [];
    const server = new HostCapabilityServer(join(directory, 'host'), () => undefined, {
      selectFileGrantPath: async () => selected,
      openGrantedPath: async (path) => {
        opened.push(path);
      },
      revealGrantedPath: async (path) => {
        revealed.push(path);
      },
      copyGrantedPaths: async (paths) => {
        copied.push(paths);
      },
    });
    servers.push(server);
    await server.start();
    const active = server.activate(randomUUID());
    const headers = {
      Authorization: `Bearer ${active.hostCapabilityToken}`,
      'Content-Type': 'application/json',
    };
    const granted = await fetch(`${active.hostCapabilityUrl}/host/v1/dialogs/open-directory`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(granted.status).toBe(201);
    const grant = (await granted.json()) as { grantId: string; name: string; rootPath: string };
    expect(grant).toMatchObject({ name: 'selected', rootPath: selected });
    expect(grant).not.toHaveProperty('path');

    const root = await fetch(`${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}/list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '' }),
    });
    expect(root.status).toBe(200);
    const rootListing = (await root.json()) as {
      rootName: string;
      path: string;
      entries: Array<{
        name: string;
        path: string;
        type: string;
        size: number;
        accessedAt: string;
        owner: string;
        group: string;
      }>;
    };
    expect(rootListing).toMatchObject({ rootName: 'selected', path: '' });
    expect(rootListing.entries).toMatchObject([
      { name: 'folder', path: 'folder', type: 'directory' },
      { name: 'notes.txt', path: 'notes.txt', type: 'file', size: 10 },
    ]);
    expect(rootListing.entries[1]).toMatchObject({
      accessedAt: expect.any(String),
      owner: expect.any(String),
      group: expect.any(String),
    });
    expect(JSON.stringify(rootListing)).not.toContain(selected);

    const nested = await fetch(`${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}/list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'folder' }),
    });
    expect(nested.status).toBe(200);
    expect(await nested.json()).toMatchObject({
      path: 'folder',
      entries: [{ name: 'nested.txt', path: 'folder/nested.txt', type: 'file' }],
    });

    expect(
      (
        await fetch(`${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}/list`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: '../outside' }),
        })
      ).status,
    ).toBe(400);

    const action = (name: string, body: unknown) =>
      fetch(`${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    const sourceTransferPath = await action('transfer-path', {
      path: 'notes.txt',
      intent: 'read',
    });
    expect(sourceTransferPath.status).toBe(200);
    expect(await sourceTransferPath.json()).toMatchObject({
      kind: 'file',
      name: 'notes.txt',
      permissions: ['read'],
      path: join(await realpath(selected), 'notes.txt'),
    });
    const rootTransferPath = await action('transfer-path', { path: '', intent: 'read' });
    expect(rootTransferPath.status).toBe(200);
    expect(await rootTransferPath.json()).toMatchObject({
      kind: 'directory',
      name: 'selected',
      permissions: ['read'],
      path: await realpath(selected),
    });
    const targetTransferPath = await action('transfer-path', {
      path: 'folder/download.txt',
      intent: 'write-target',
    });
    expect(targetTransferPath.status).toBe(200);
    expect(await targetTransferPath.json()).toMatchObject({
      kind: 'save-target',
      name: 'download.txt',
      permissions: ['write'],
      path: join(await realpath(selected), 'folder', 'download.txt'),
    });
    expect(
      (
        await action('entries', {
          path: 'folder',
          name: 'created.txt',
          type: 'file',
        })
      ).status,
    ).toBe(204);
    expect(await readFile(join(selected, 'folder', 'created.txt'), 'utf8')).toBe('');
    expect(
      (await action('entries', { path: '', name: 'created-dir', type: 'directory' })).status,
    ).toBe(204);
    expect((await action('entries', { path: '', name: 'notes.txt', type: 'file' })).status).toBe(
      409,
    );
    expect((await action('rename', { path: 'notes.txt', name: 'renamed.txt' })).status).toBe(204);
    expect(await readFile(join(selected, 'renamed.txt'), 'utf8')).toBe('local file');
    expect((await action('chmod', { path: 'renamed.txt', mode: 0o640 })).status).toBe(204);
    expect((await stat(join(selected, 'renamed.txt'))).mode & 0o7777).toBe(0o640);
    if (process.platform !== 'win32') {
      await symlink(join(selected, 'renamed.txt'), join(selected, 'renamed-link'));
      expect((await action('chmod', { path: 'renamed-link', mode: 0o777 })).status).toBe(400);
      expect((await stat(join(selected, 'renamed.txt'))).mode & 0o7777).toBe(0o640);
    }
    expect((await action('copy-path', { paths: ['renamed.txt', 'folder'] })).status).toBe(204);
    const canonicalSelected = await realpath(selected);
    expect(copied).toEqual([
      [join(canonicalSelected, 'renamed.txt'), join(canonicalSelected, 'folder')],
    ]);
    expect((await action('open', { path: 'renamed.txt' })).status).toBe(204);
    expect(opened).toEqual([join(canonicalSelected, 'renamed.txt')]);
    expect((await action('reveal', { path: 'folder' })).status).toBe(204);
    expect(revealed).toEqual([join(canonicalSelected, 'folder')]);
    expect(
      (
        await action('operate', {
          paths: ['renamed.txt'],
          destination: '',
          operation: 'copy',
          conflict: 'rename',
        })
      ).status,
    ).toBe(204);
    expect(await readFile(join(selected, 'renamed(copy-1).txt'), 'utf8')).toBe('local file');
    expect(
      (
        await action('operate', {
          paths: ['folder'],
          destination: 'created-dir',
          operation: 'copy',
          conflict: 'rename',
        })
      ).status,
    ).toBe(204);
    expect(await readFile(join(selected, 'created-dir', 'folder', 'nested.txt'), 'utf8')).toBe(
      'nested local file',
    );
    expect(
      (
        await action('operate', {
          paths: ['folder/created.txt'],
          destination: 'created-dir',
          operation: 'move',
          conflict: 'rename',
        })
      ).status,
    ).toBe(204);
    expect(await readFile(join(selected, 'created-dir', 'created.txt'), 'utf8')).toBe('');
    await expect(access(join(selected, 'folder', 'created.txt'))).rejects.toThrow();
    expect(
      (
        await action('operate', {
          paths: ['folder'],
          destination: 'folder',
          operation: 'move',
          conflict: 'rename',
        })
      ).status,
    ).toBe(400);
    expect((await action('delete', { path: 'created-dir' })).status).toBe(204);
    await expect(access(join(selected, 'created-dir'))).rejects.toThrow();
    expect((await action('delete', { path: '../outside' })).status).toBe(400);
  });

  it('streams dropped files into expiring generation-bound grants and deletes them on revoke', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-drop-grant-'));
    directories.push(directory);
    const server = new HostCapabilityServer(directory, () => undefined);
    servers.push(server);
    await server.start();
    const active = server.activate(randomUUID());
    const headers = {
      Authorization: `Bearer ${active.hostCapabilityToken}`,
      'Content-Type': 'application/octet-stream',
      'X-Axterm-File-Name': encodeURIComponent('中文 file.txt'),
      'X-Axterm-File-Size': '12',
    };
    const imported = await fetch(`${active.hostCapabilityUrl}/host/v1/grants/import`, {
      method: 'POST',
      headers,
      body: 'hello world!',
    });
    expect(imported.status).toBe(201);
    const grant = (await imported.json()) as { grantId: string; name: string; expiresAt: string };
    expect(grant).toMatchObject({ name: '中文 file.txt' });
    expect(grant).not.toHaveProperty('path');
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());

    const resolved = await fetch(
      `${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}/resolve`,
      {
        method: 'POST',
        headers: { Authorization: headers.Authorization, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    const privateGrant = (await resolved.json()) as { path: string };
    expect(await readFile(privateGrant.path, 'utf8')).toBe('hello world!');

    expect(
      (
        await fetch(`${active.hostCapabilityUrl}/host/v1/grants/import`, {
          method: 'POST',
          headers: { ...headers, 'X-Axterm-File-Name': encodeURIComponent('bad"name') },
          body: 'hello world!',
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await fetch(`${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}`, {
          method: 'DELETE',
          headers: { Authorization: headers.Authorization },
        })
      ).status,
    ).toBe(204);
    await expect(access(privateGrant.path)).rejects.toThrow();
  });

  it('reports monotonic native suspend and resume state through the authenticated Host API', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-lifecycle-'));
    directories.push(directory);
    const server = new HostCapabilityServer(directory, () => undefined);
    servers.push(server);
    await server.start();
    const active = server.activate(randomUUID());
    const request = () =>
      fetch(`${active.hostCapabilityUrl}/host/v1/desktop/lifecycle`, {
        headers: { Authorization: `Bearer ${active.hostCapabilityToken}` },
      });

    await expect(request().then((response) => response.json())).resolves.toMatchObject({
      revision: 0,
      state: 'active',
      lastEvent: 'started',
    });
    server.recordLifecycle('suspend');
    await expect(request().then((response) => response.json())).resolves.toMatchObject({
      revision: 1,
      state: 'suspended',
      lastEvent: 'suspend',
    });
    server.recordLifecycle('resume');
    await expect(request().then((response) => response.json())).resolves.toMatchObject({
      revision: 2,
      state: 'active',
      lastEvent: 'resume',
    });
  });

  it('opens an expiring editable copy without exposing its path and removes its private directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-editable-grant-'));
    directories.push(directory);
    const editorExecutable = join(directory, 'editor');
    await writeFile(editorExecutable, '#!/bin/sh\n');
    await chmod(editorExecutable, 0o755);
    const opened: Array<{ path: string; editorExecutable?: string }> = [];
    const server = new HostCapabilityServer(directory, () => undefined, {
      openGrantedPath: async (path, configuredEditor) => {
        opened.push({
          path,
          ...(configuredEditor ? { editorExecutable: configuredEditor } : {}),
        });
      },
    });
    servers.push(server);
    await server.start();
    const active = server.activate(randomUUID());
    const authorization = `Bearer ${active.hostCapabilityToken}`;
    const created = await fetch(`${active.hostCapabilityUrl}/host/v1/grants/editable`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/octet-stream',
        'X-Axterm-File-Name': encodeURIComponent('remote notes.txt'),
        'X-Axterm-File-Size': '5',
      },
      body: 'draft',
    });
    expect(created.status).toBe(201);
    const grant = (await created.json()) as {
      grantId: string;
      permissions: string[];
      expiresAt: string;
    };
    expect(grant).toMatchObject({ permissions: ['read', 'write'] });
    expect(grant).not.toHaveProperty('path');
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());

    const resolved = await fetch(
      `${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}/resolve`,
      {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    const privateGrant = (await resolved.json()) as { path: string };
    expect(await readFile(privateGrant.path, 'utf8')).toBe('draft');
    expect(
      (
        await fetch(`${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}/open-self`, {
          method: 'POST',
          headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(204);
    const editablePath = await realpath(privateGrant.path);
    expect(opened).toEqual([{ path: editablePath }]);

    const customEditorResponse = await fetch(
      `${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}/open-self`,
      {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ editorExecutable }),
      },
    );
    expect(customEditorResponse.status).toBe(204);
    expect(opened).toEqual([
      { path: editablePath },
      { path: editablePath, editorExecutable: await realpath(editorExecutable) },
    ]);

    const relativeEditorResponse = await fetch(
      `${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}/open-self`,
      {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ editorExecutable: 'relative/editor' }),
      },
    );
    expect(relativeEditorResponse.status).toBe(400);
    await expect(relativeEditorResponse.json()).resolves.toEqual({
      code: 'INVALID_GRANTED_PATH_OPERATION',
    });

    const privateRoot = join(privateGrant.path, '..');
    expect(
      (
        await fetch(`${active.hostCapabilityUrl}/host/v1/grants/${grant.grantId}`, {
          method: 'DELETE',
          headers: { Authorization: authorization },
        })
      ).status,
    ).toBe(204);
    await expect(access(privateRoot)).rejects.toThrow();
  });

  it('requires the generation Host token and controls only the bound window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-window-host-'));
    directories.push(directory);
    const target = createWindow();
    const server = new HostCapabilityServer(directory, () => target as never);
    servers.push(server);
    await server.start();
    const first = server.activate(randomUUID());

    expect((await fetch(`${first.hostCapabilityUrl}/host/v1/desktop/window`)).status).toBe(401);
    const authorized = { Authorization: `Bearer ${first.hostCapabilityToken}` };
    const stateResponse = await fetch(`${first.hostCapabilityUrl}/host/v1/desktop/window`, {
      headers: authorized,
    });
    expect(stateResponse.status).toBe(200);
    expect(await stateResponse.json()).toMatchObject({
      minimized: false,
      maximized: false,
      canClose: true,
    });

    const minimized = await fetch(`${first.hostCapabilityUrl}/host/v1/desktop/window/actions`, {
      method: 'POST',
      headers: { ...authorized, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'minimize' }),
    });
    expect(minimized.status).toBe(202);
    expect(await minimized.json()).toMatchObject({ accepted: true, state: { minimized: true } });

    const invalid = await fetch(`${first.hostCapabilityUrl}/host/v1/desktop/window/actions`, {
      method: 'POST',
      headers: { ...authorized, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'destroy', secret: 'must-not-be-reflected' }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: 'INVALID_REQUEST' });

    server.markTitleBarStyleApplied('custom');
    const preferences = await fetch(
      `${first.hostCapabilityUrl}/host/v1/desktop/window/preferences`,
      {
        method: 'PATCH',
        headers: { ...authorized, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          titleBarStyle: 'system',
          opacity: 0.75,
          zoomFactor: 1.5,
          bounds: { x: 15, y: 25, width: 1000, height: 700 },
        }),
      },
    );
    expect(preferences.status).toBe(200);
    expect(await preferences.json()).toEqual({
      preferences: {
        titleBarStyle: 'system',
        opacity: 0.75,
        zoomFactor: 1.5,
        bounds: { x: 15, y: 25, width: 1000, height: 700 },
        globalHotkey: 'Control+2',
        allowMultiInstance: false,
        confirmBeforeExit: false,
      },
      requiresRestart: true,
      globalHotkeyRegistered: false,
    });
    expect(target.preferenceState()).toEqual({
      opacity: 0.75,
      zoomFactor: 1.5,
      bounds: { x: 15, y: 25, width: 1000, height: 700 },
    });

    const invalidPreferences = await fetch(
      `${first.hostCapabilityUrl}/host/v1/desktop/window/preferences`,
      {
        method: 'PATCH',
        headers: { ...authorized, 'Content-Type': 'application/json' },
        body: JSON.stringify({ opacity: 0.5, unexpected: true }),
      },
    );
    expect(invalidPreferences.status).toBe(400);
    expect(await invalidPreferences.json()).toEqual({ code: 'INVALID_REQUEST' });

    const second = server.activate(randomUUID());
    expect(
      (
        await fetch(`${first.hostCapabilityUrl}/host/v1/desktop/window`, {
          headers: authorized,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${second.hostCapabilityUrl}/host/v1/desktop/window`, {
          headers: { Authorization: `Bearer ${second.hostCapabilityToken}` },
        })
      ).status,
    ).toBe(200);
  });

  it('returns a typed unavailable result when there is no current window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-window-host-'));
    directories.push(directory);
    const server = new HostCapabilityServer(directory, () => undefined);
    servers.push(server);
    await server.start();
    const active = server.activate(randomUUID());
    const response = await fetch(`${active.hostCapabilityUrl}/host/v1/desktop/window`, {
      headers: { Authorization: `Bearer ${active.hostCapabilityToken}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'WINDOW_UNAVAILABLE' });

    const preferences = await fetch(
      `${active.hostCapabilityUrl}/host/v1/desktop/window/preferences`,
      { headers: { Authorization: `Bearer ${active.hostCapabilityToken}` } },
    );
    expect(preferences.status).toBe(200);
    expect(await preferences.json()).toEqual({
      preferences: {
        titleBarStyle: 'custom',
        opacity: 1,
        zoomFactor: 1,
        bounds: null,
        globalHotkey: 'Control+2',
        allowMultiInstance: false,
        confirmBeforeExit: false,
      },
      requiresRestart: false,
      globalHotkeyRegistered: false,
    });
  });

  it('registers, replaces, disables and rejects unavailable global visibility hotkeys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-hotkey-host-'));
    directories.push(directory);
    const target = createWindow();
    let registered = '';
    const globalHotkey = {
      update: vi.fn((accelerator: string) => {
        if (accelerator === 'Alt+Shift+F10') return false;
        registered = accelerator;
        return true;
      }),
      isRegistered: vi.fn((accelerator: string) => accelerator === registered && !!accelerator),
      close: vi.fn(),
    };
    const server = new HostCapabilityServer(directory, () => target as never, { globalHotkey });
    servers.push(server);
    await server.start();
    expect(globalHotkey.update).toHaveBeenCalledWith('Control+2');
    const active = server.activate(randomUUID());
    const headers = {
      Authorization: `Bearer ${active.hostCapabilityToken}`,
      'Content-Type': 'application/json',
    };

    const initial = await fetch(`${active.hostCapabilityUrl}/host/v1/desktop/window/preferences`, {
      headers,
    });
    expect(await initial.json()).toMatchObject({
      preferences: { globalHotkey: 'Control+2' },
      globalHotkeyRegistered: true,
    });

    const updated = await fetch(`${active.hostCapabilityUrl}/host/v1/desktop/window/preferences`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ globalHotkey: 'Alt+F10' }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      preferences: { globalHotkey: 'Alt+F10' },
      globalHotkeyRegistered: true,
    });

    const unavailable = await fetch(
      `${active.hostCapabilityUrl}/host/v1/desktop/window/preferences`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ globalHotkey: 'Alt+Shift+F10' }),
      },
    );
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({ code: 'GLOBAL_HOTKEY_UNAVAILABLE' });

    const afterConflict = await fetch(
      `${active.hostCapabilityUrl}/host/v1/desktop/window/preferences`,
      { headers },
    );
    expect(await afterConflict.json()).toMatchObject({
      preferences: { globalHotkey: 'Alt+F10' },
      globalHotkeyRegistered: true,
    });

    const disabled = await fetch(`${active.hostCapabilityUrl}/host/v1/desktop/window/preferences`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ globalHotkey: '' }),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      preferences: { globalHotkey: '' },
      globalHotkeyRegistered: false,
    });
  });

  it('turns an explicit command-line path into a short-lived generation grant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-cli-grant-'));
    directories.push(directory);
    const keyPath = join(directory, 'id_ed25519');
    const workingDirectory = join(directory, 'workspace');
    await writeFile(keyPath, 'PRIVATE KEY');
    await mkdir(workingDirectory);
    const server = new HostCapabilityServer(join(directory, 'host'), () => undefined);
    servers.push(server);
    await server.start();
    const first = server.activate(randomUUID());

    const keyGrant = await server.grantCommandLinePath(keyPath, 'file');
    const directoryGrant = await server.grantCommandLinePath(workingDirectory, 'directory');
    expect(keyGrant).toMatchObject({
      kind: 'file',
      name: 'id_ed25519',
      permissions: ['read'],
    });
    expect(keyGrant).not.toHaveProperty('path');
    expect(directoryGrant).toMatchObject({ kind: 'directory', permissions: ['read'] });

    const resolved = await fetch(
      `${first.hostCapabilityUrl}/host/v1/grants/${keyGrant.grantId}/resolve`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${first.hostCapabilityToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ path: await realpath(keyPath) });

    const second = server.activate(randomUUID());
    expect(
      (
        await fetch(`${second.hostCapabilityUrl}/host/v1/grants/${keyGrant.grantId}/resolve`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${second.hostCapabilityToken}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(404);
  });

  it('keeps updater state and actions behind the generation-authenticated Host boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-host-updater-'));
    directories.push(directory);
    const actions: string[] = [];
    const updater: DesktopUpdaterPort = {
      status: () => ({ state: actions.length ? 'available' : 'idle', availableVersion: '1.1.0' }),
      perform: async (action) => {
        actions.push(action);
        return { state: 'available', availableVersion: '1.1.0' };
      },
      close: vi.fn(async () => {}),
    };
    const server = new HostCapabilityServer(join(directory, 'host'), () => undefined, { updater });
    servers.push(server);
    await server.start();
    const active = server.activate(randomUUID());
    const headers = {
      Authorization: `Bearer ${active.hostCapabilityToken}`,
      'Content-Type': 'application/json',
    };

    const status = await fetch(`${active.hostCapabilityUrl}/host/v1/updater/status`, { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      state: 'idle',
      availableVersion: '1.1.0',
    });

    const action = await fetch(`${active.hostCapabilityUrl}/host/v1/updater/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'check' }),
    });
    expect(action.status).toBe(202);
    expect(await action.json()).toEqual({
      state: 'available',
      availableVersion: '1.1.0',
    });
    expect(actions).toEqual(['check']);

    const invalid = await fetch(`${active.hostCapabilityUrl}/host/v1/updater/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'replace-files' }),
    });
    expect(invalid.status).toBe(400);

    const rotated = server.activate(randomUUID());
    expect(
      (
        await fetch(`${rotated.hostCapabilityUrl}/host/v1/updater/status`, {
          headers,
        })
      ).status,
    ).toBe(401);
  });
});
