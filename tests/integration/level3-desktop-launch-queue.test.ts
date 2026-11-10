import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ShellFileGrantCapabilities } from '@axterm/infra-desktop-native';
import { parseQuickConnect } from '@axterm/plugin-api/session-intents';
import { DesktopLaunchQueue } from '../../apps/desktop/src/shell/launch-queue.ts';
import { parseDesktopCommandLine } from '../../apps/desktop/src/shell/command-line.ts';
it('materializes real CLI paths only as opaque Native grants, consumes once and joins cancellation of another window', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-native-launch-'));
  const files = new ShellFileGrantCapabilities(crypto.randomUUID()),
    queue = new DesktopLaunchQueue(),
    windowId = crypto.randomUUID();
  try {
    await mkdir(join(home, 'directory'));
    await writeFile(join(home, 'key'), 'PRIVATE_KEY_CANARY');
    const request = parseDesktopCommandLine([
      '-i',
      join(home, 'key'),
      '-d',
      join(home, 'directory'),
      'operator@host.test',
    ]);
    if (request.kind !== 'session') throw Error('CLI fixture rejected');
    expect(queue.enqueue(windowId, request)).toBe(true);
    const other = new AbortController(),
      waiting = queue.next(crypto.randomUUID(), files, other.signal);
    const canceled = Promise.allSettled([waiting]);
    other.abort();
    expect((await canceled)[0]!.status).toBe('rejected');
    const event = await queue.next(windowId, files, new AbortController().signal);
    expect(event).not.toBeNull();
    expect(JSON.stringify(event)).not.toContain(home);
    expect(JSON.stringify(event)).not.toContain('PRIVATE_KEY_CANARY');
    const target = parseQuickConnect(event!.source);
    if (target?.protocol !== 'ssh') throw Error('Unexpected intent');
    expect((await files.registry.authorize(target.credentialGrantId!, 'read')).fileName).toBe(
      'key',
    );
    expect(
      (await files.registry.authorize(target.initialDirectoryGrantId!, 'write')).grant.kind,
    ).toBe('directory');
    expect(
      (await files.registry.authorize(target.initialDirectoryGrantId!, 'write')).grant.expiresAt,
    ).toBeUndefined();
    expect(
      (await files.registry.authorize(target.credentialGrantId!, 'read')).grant.expiresAt,
    ).toBeDefined();
    expect(queue.resourceCount()).toBe(0);
  } finally {
    await queue.close();
    await files.close();
    await rm(home, { recursive: true, force: true });
  }
});
it('bounds pending native input without discarding accepted events, and clears an old window without replay', async () => {
  const files = new ShellFileGrantCapabilities(crypto.randomUUID()),
    queue = new DesktopLaunchQueue(),
    windowId = crypto.randomUUID();
  try {
    const request = parseDesktopCommandLine(['ssh://host.test']);
    if (request.kind !== 'session') throw Error('CLI fixture');
    for (let i = 0; i < 32; i++) expect(queue.enqueue(windowId, request)).toBe(true);
    expect(queue.enqueue(windowId, request)).toBe(false);
    expect(queue.resourceCount()).toBe(32);
    queue.retireWindow(windowId);
    expect(queue.resourceCount()).toBe(0);
    const pending = queue.next(windowId, files, new AbortController().signal);
    const outcome = Promise.allSettled([pending]);
    await queue.close();
    expect((await outcome)[0]!.status).toBe('rejected');
    expect(queue.resourceCount()).toBe(0);
  } finally {
    await queue.close();
    await files.close();
  }
});
it('releases every grant from an incomplete materialization and never returns a stale window event', async () => {
  const files = new ShellFileGrantCapabilities(crypto.randomUUID()),
    queue = new DesktopLaunchQueue(),
    windowId = crypto.randomUUID();
  const revoke = vi.spyOn(files.registry, 'revoke');
  const create = vi.spyOn(files.registry, 'createTrustedPath');
  try {
    const request = parseDesktopCommandLine([
      '-i',
      '/fixture/key',
      '-d',
      '/fixture/directory',
      'host.test',
    ]);
    if (request.kind !== 'session') throw Error('CLI fixture');
    create.mockResolvedValueOnce({
      grantId: 'issued-key',
      kind: 'file',
      name: 'key',
      permissions: ['read'],
      createdAt: new Date().toISOString(),
    });
    create.mockRejectedValueOnce(Error('directory unavailable'));
    queue.enqueue(windowId, request);
    await expect(queue.next(windowId, files, new AbortController().signal)).rejects.toThrow(
      'directory unavailable',
    );
    expect(revoke).toHaveBeenCalledExactlyOnceWith('issued-key');
    expect(queue.resourceCount()).toBe(0);
  } finally {
    await queue.close();
    await files.close();
  }
});

it('keeps per-window FIFO and exposes transient credentials only in the single claimed event', async () => {
  const files = new ShellFileGrantCapabilities(crypto.randomUUID()),
    queue = new DesktopLaunchQueue(),
    windowId = crypto.randomUUID();
  try {
    const sources = [
      'axterm://operator:session-secret@first.test?type=telnet',
      'ssh://operator@second.test',
    ];
    for (const source of sources) {
      const request = parseDesktopCommandLine([source]);
      if (request.kind !== 'session') throw Error('Native FIFO fixture rejected');
      expect(queue.enqueue(windowId, request)).toBe(true);
    }
    expect(queue.resourceCount()).toBe(2);
    for (const source of sources) {
      const event = await queue.next(windowId, files, new AbortController().signal);
      expect(event).toMatchObject({ id: expect.any(String), source });
    }
    expect(queue.resourceCount()).toBe(0);
    const pending = queue.next(windowId, files, new AbortController().signal),
      settled = Promise.allSettled([pending]);
    await queue.close();
    expect((await settled)[0]?.status).toBe('rejected');
    expect(queue.resourceCount()).toBe(0);
  } finally {
    await queue.close();
    await files.close();
  }
});
it('rejects malformed Native targets and expires unclaimed input without creating a File Grant', async () => {
  vi.useFakeTimers();
  const files = new ShellFileGrantCapabilities(crypto.randomUUID()),
    queue = new DesktopLaunchQueue(),
    windowId = crypto.randomUUID(),
    grant = vi.spyOn(files.registry, 'createTrustedPath');
  try {
    expect(
      queue.enqueue(windowId, {
        kind: 'session',
        newWindow: false,
        source: 'axterm://host.test?type=unsupported&password=secret',
      }),
    ).toBe(false);
    expect(queue.resourceCount()).toBe(0);
    const request = parseDesktopCommandLine(['ssh://operator@example.test']);
    if (request.kind !== 'session') throw Error('Native expiry fixture rejected');
    expect(queue.enqueue(windowId, request)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_001);
    const pending = queue.next(windowId, files, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeNull();
    expect(grant).not.toHaveBeenCalled();
    expect(queue.resourceCount()).toBe(0);
    await queue.close();
    await files.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await queue.close();
    await files.close();
    vi.useRealTimers();
  }
});
