import { mkdtemp, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { ShellFileGrantCapabilities } from '@axterm/infra-desktop-native';
import { DroppedDirectories } from '../../apps/desktop/src/shell/directory-drop.ts';
import { inspectSource } from '../../scripts/architecture-policy.mjs';
it('issues one-use generation-local native directory tickets and rejects root replacement and symlinks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-drop-')),
    cap = new ShellFileGrantCapabilities(crypto.randomUUID());
  try {
    const path = join(home, 'directory');
    await mkdir(path);
    const ticket = await cap.issueDirectoryDrop(path),
      handlers = cap.handlers();
    const grant = await handlers['fileGrant.create'](
      { kind: 'dropped-directory', ticket },
      new AbortController().signal,
    );
    expect(grant).toMatchObject({ kind: 'directory', rootPath: path });
    await expect(
      handlers['fileGrant.create'](
        { kind: 'dropped-directory', ticket },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const changed = await cap.issueDirectoryDrop(path);
    await rename(path, path + '-old');
    await mkdir(path);
    await expect(
      handlers['fileGrant.create'](
        { kind: 'dropped-directory', ticket: changed },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'STALE' });
    await symlink(path, join(home, 'link'));
    await expect(cap.issueDirectoryDrop(join(home, 'link'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const retired = await cap.issueDirectoryDrop(path);
    await cap.close();
    await expect(
      handlers['fileGrant.create'](
        { kind: 'dropped-directory', ticket: retired },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CLOSED' });
  } finally {
    await cap.close();
    await rm(home, { recursive: true, force: true });
  }
});
it('bounds and expires unclaimed native tickets', async () => {
  const path = await mkdtemp(join(tmpdir(), 'axterm-drop-cap-')),
    cap = new ShellFileGrantCapabilities(crypto.randomUUID());
  try {
    for (let i = 0; i < 64; i++) await cap.issueDirectoryDrop(path);
    await expect(cap.issueDirectoryDrop(path)).rejects.toMatchObject({ code: 'LIMIT' });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    try {
      expect(await cap.issueDirectoryDrop(path)).toMatch(/^[0-9a-f-]+$/u);
    } finally {
      clock.mockRestore();
    }
  } finally {
    await cap.close();
    await rm(path, { recursive: true, force: true });
  }
});
it('allows the reviewed drop metadata collector and rejects raw path, arbitrary channel and alias escapes', async () => {
  const preload = await readFile('apps/desktop/src/shell/preload.ts', 'utf8');
  expect(inspectSource('apps/desktop/src/shell/preload.ts', preload)).toEqual([]);
  for (const source of [
    "import{ipcRenderer}from'electron';ipcRenderer.invoke('desktop:directory-drop',['/forged']);",
    "import{webUtils}from'electron';webUtils.getPathForFile(file);",
    "import{ipcRenderer}from'electron';ipcRenderer.invoke('files.create');",
    "import{ipcRenderer}from'electron';const send=ipcRenderer.invoke;",
    "import{ipcRenderer}from'electron';import{DroppedDirectories}from'./directory-drop.ts';const collector=new DroppedDirectories(()=>'/forged');ipcRenderer.invoke('desktop:directory-drop',collector.takePaths());",
    "import{ipcRenderer,webUtils}from'electron';import{DroppedDirectories}from'./directory-drop.ts';const collector=new DroppedDirectories(file=>webUtils.getPathForFile(file));const paths=collector.takePaths();paths[0]='/forged';ipcRenderer.invoke('desktop:directory-drop',paths);",
  ]) {
    expect(inspectSource('apps/desktop/src/shell/preload.ts', source).length).toBeGreaterThan(0);
  }
  expect(
    inspectSource(
      'apps/desktop/src/preload/index.ts',
      "import{ipcRenderer}from'electron';ipcRenderer.invoke('desktop:directory-drop',paths);",
    ).length,
  ).toBeGreaterThan(0);
});
it('collects metadata only from one genuine directory and consumes the private path once', () => {
  const collector = new DroppedDirectories((file) => file.name),
    drop = (trusted: boolean, directory: boolean) =>
      ({
        isTrusted: trusted,
        dataTransfer: {
          items: [
            {
              kind: 'file',
              webkitGetAsEntry: () => ({ isDirectory: directory }),
              getAsFile: () => ({ name: '/controlled/目录 with spaces' }),
            },
          ],
        },
      }) as unknown as DragEvent;
  collector.capture(drop(false, true));
  expect(collector.takePaths()).toEqual([]);
  collector.capture(drop(true, false));
  expect(collector.takePaths()).toEqual([]);
  collector.capture(drop(true, true));
  expect(collector.takePaths()).toEqual(['/controlled/目录 with spaces']);
  expect(collector.takePaths()).toEqual([]);
});

it('admits a bounded multi-directory collector only for an explicitly selected terminal target', () => {
  const collector = new DroppedDirectories((file) => file.name);
  const drop = (count: number) =>
    ({
      isTrusted: true,
      dataTransfer: {
        items: Array.from({ length: count }, (_, index) => ({
          kind: 'file',
          webkitGetAsEntry: () => ({ isDirectory: true }),
          getAsFile: () => ({ name: '/controlled/' + index }),
        })),
      },
    }) as unknown as DragEvent;
  collector.capture(drop(32));
  expect(collector.takePaths()).toEqual([]);
  collector.capture(drop(32), 32);
  expect(collector.takePaths()).toHaveLength(32);
  collector.capture(drop(33), 32);
  expect(collector.takePaths()).toEqual([]);
  collector.capture(drop(1), 33);
  expect(collector.takePaths()).toEqual([]);
});
