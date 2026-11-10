import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type {
  ConfigurationClientActions,
  SettingsBaseline,
} from '@axterm/plugin-api/configuration';
import type { WorkspaceSessionDescriptions, DesktopStartupUi } from '@axterm/ui/workspace';
import { DesktopLaunchStreams } from '../../packages/plugins/desktop/src/launches.ts';
import { WorkspaceStartup } from '../../packages/plugins/workspace/src/client/startup.ts';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
import type { NamedWorkspaces } from '../../packages/plugins/workspace/src/client/named-workspaces.ts';
import { PresentationStatusStore } from '../../packages/plugins/workspace/src/client/presentation.ts';
it('claims a Profile startup only after its native queue is polled and retains the same receipt across consumers', async () => {
  let first = true;
  const streams = new DesktopLaunchStreams(() => ({
    next: async (_window, signal) => {
      if (first) {
        first = false;
        return null;
      }
      return new Promise<null>((resolve) => {
        signal.addEventListener('abort', () => resolve(null), { once: true });
        if (signal.aborted) resolve(null);
      });
    },
  }));
  const windowId = randomUUID(),
    key = randomUUID(),
    abort = new AbortController();
  expect(streams.decision(windowId, key)).toBe('waiting');
  const iterator = streams.watch(windowId, abort.signal)[Symbol.asyncIterator](),
    reading = iterator.next().catch(() => undefined);
  try {
    await vi.waitFor(() => expect(streams.decision(windowId, key)).toBe('ready'));
    expect(streams.decision(windowId, key, true)).toBe('configured');
    expect(streams.decision(windowId, key)).toBe('configured');
    expect(streams.decision(windowId, randomUUID(), true)).toBe('claimed');
  } finally {
    abort.abort();
    await reading;
    await iterator.return?.();
    await streams.close();
  }
  expect(streams.resourceCount()).toBe(0);
});
it('gives initial native ingress priority without storing or replaying its source', async () => {
  const source = 'local',
    streams = new DesktopLaunchStreams(() => ({
      next: async () => ({ id: randomUUID(), source }),
    })),
    id = randomUUID(),
    key = randomUUID(),
    abort = new AbortController();
  const iterator = streams.watch(id, abort.signal)[Symbol.asyncIterator]();
  try {
    expect((await iterator.next()).value?.source).toBe(source);
    expect(streams.decision(id, key, true)).toBe('native');
    expect(streams.decision(id, randomUUID(), true)).toBe('native');
  } finally {
    abort.abort();
    await iterator.return?.();
    await streams.close();
  }
});
function fixture(
  nativePhase: 'configured' | 'native' | 'claimed' = 'configured',
  startup: SettingsBaseline['settings']['workspace']['startupSessions'] = [],
) {
  const listeners = new Set<() => void>(),
    generation = randomUUID(),
    workspace = new WorkspaceStore(),
    events = new EventTarget(),
    presentation = new PresentationStatusStore();
  presentation.set('ready');
  let baseline = {
    generation,
    cursor: 0,
    settings: {
      version: 1,
      terminal: { defaultProfileId: null },
      workspace: { startupSessions: startup, namedWorkspaces: [] },
    },
  } as unknown as SettingsBaseline;
  const configuration = {
    getSnapshot: () => ({ status: 'ready', baseline }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as ConfigurationClientActions;
  const restore = vi.fn(async () => randomUUID()),
    waitFor = vi.fn(async () => {}),
    load = vi.fn(async () => {}),
    native = { claim: vi.fn(async () => nativePhase) } satisfies DesktopStartupUi;
  const source = { restore, waitFor } as unknown as WorkspaceSessionDescriptions;
  const owner = new WorkspaceStartup(
    workspace,
    configuration,
    source,
    { load } as unknown as NamedWorkspaces,
    presentation,
    () => undefined,
    () => undefined,
    native,
    events,
  );
  return {
    owner,
    workspace,
    events,
    restore,
    waitFor,
    load,
    native,
    listeners,
    baseline: () => baseline,
    change: (next: Partial<SettingsBaseline>) => {
      baseline = { ...baseline, ...next };
      for (const listener of listeners) listener();
    },
  };
}
it('opens one fresh default local terminal and does not repeat it on settings notifications', async () => {
  const f = fixture();
  try {
    await vi.waitFor(() => expect(f.restore).toHaveBeenCalledOnce());
    f.change({ cursor: 1 });
    f.change({ cursor: 2 });
    expect(f.restore).toHaveBeenCalledOnce();
    expect(f.restore.mock.calls[0]).toEqual([
      {
        id: expect.any(String),
        kind: 'local',
        title: 'Local terminal',
        pinned: false,
        paneIndex: 0,
      },
      f.baseline().generation,
      expect.any(AbortSignal),
    ]);
  } finally {
    await f.owner.close();
    await f.workspace.dispose();
  }
  expect(f.listeners.size).toBe(0);
});
it('does not start configured work after native or already claimed ingress', async () => {
  for (const phase of ['native', 'claimed'] as const) {
    const f = fixture(phase);
    try {
      await vi.waitFor(() => expect(f.owner.getSnapshot().busy).toBe(false));
      expect(f.restore).not.toHaveBeenCalled();
      expect(f.waitFor).not.toHaveBeenCalled();
    } finally {
      await f.owner.close();
      await f.workspace.dispose();
    }
  }
});
it('lets an early user interaction cancel startup metadata waiting before application IO', async () => {
  const f = fixture();
  try {
    f.events.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(f.owner.getSnapshot().busy).toBe(false));
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.owner.getSnapshot().failed).toBe(false);
  } finally {
    await f.owner.close();
    await f.workspace.dispose();
  }
});
it('refuses a missing configured workspace without falling back to a different session', async () => {
  const f = fixture('configured', randomUUID());
  try {
    await vi.waitFor(() => expect(f.owner.getSnapshot().failed).toBe(true));
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
  } finally {
    await f.owner.close();
    await f.workspace.dispose();
  }
});
