import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { settingsSchema } from '../../packages/contracts/src/index';
import { updateCachedSettings } from '../../apps/desktop/src/renderer/src/app/settings-cache';

type SettingsQueryClient = Parameters<typeof updateCachedSettings>[0];
const desktopRequire = createRequire(resolve('apps/desktop/package.json'));
const { QueryClient } = desktopRequire('@tanstack/react-query') as {
  QueryClient: new () => SettingsQueryClient;
};
const clients: SettingsQueryClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.clear()));

function fixture() {
  const queryClient = new QueryClient();
  clients.push(queryClient);
  const initial = settingsSchema.parse({
    appearance: { theme: 'dark', language: 'en' },
    workspace: { restoreLayout: true, aiInspectorOpen: false },
    terminal: { autoReconnectTerminal: false, restoreTerminalSessionOnReload: false },
    version: 1,
  });
  queryClient.setQueryData(['settings'], initial);
  return { queryClient, initial };
}

describe('settings cache mutation boundary', () => {
  it('serializes layout and preference writes against the revision committed by the previous writer', async () => {
    const { queryClient, initial } = fixture();
    let release!: () => void;
    const layoutSaved = { ...initial, version: 2 };
    const preferenceSaved = {
      ...layoutSaved,
      workspace: { ...layoutSaved.workspace, showTabNumber: false },
      version: 3,
    };
    const client = {
      settings: vi.fn(),
      updateSettings: vi
        .fn()
        .mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return layoutSaved;
        })
        .mockResolvedValueOnce(preferenceSaved),
    };
    const layout = updateCachedSettings(queryClient, client, initial, {
      workspace: { aiInspectorOpen: true },
    });
    await vi.waitFor(() => expect(client.updateSettings).toHaveBeenCalledTimes(1));
    const preference = updateCachedSettings(queryClient, client, initial, {
      workspace: { showTabNumber: false },
    });
    await Promise.resolve();
    expect(client.updateSettings).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([layout, preference]);
    expect(client.updateSettings).toHaveBeenLastCalledWith(layoutSaved, {
      workspace: { showTabNumber: false },
    });
    expect(queryClient.getQueryData(['settings'])).toEqual(preferenceSaved);
  });

  it('cancels a delayed old read and saves against the latest cached revision', async () => {
    const { queryClient, initial } = fixture();
    let release!: (value: typeof initial) => void;
    const oldRead = queryClient
      .fetchQuery({
        queryKey: ['settings'],
        queryFn: () => new Promise<typeof initial>((resolve) => (release = resolve)),
      })
      .catch(() => undefined);
    const current = { ...initial, version: 2 };
    queryClient.setQueryData(['settings'], current);
    const saved = {
      ...current,
      workspace: { ...current.workspace, showTabNumber: false },
      version: 3,
    };
    const client = { settings: vi.fn(), updateSettings: vi.fn().mockResolvedValue(saved) };
    await updateCachedSettings(queryClient, client, initial, {
      workspace: { showTabNumber: false },
    });
    release(initial);
    await oldRead;
    expect(client.updateSettings).toHaveBeenCalledExactlyOnceWith(current, {
      workspace: { showTabNumber: false },
    });
    expect(queryClient.getQueryData(['settings'])).toEqual(saved);
  });

  it('refreshes after a rejected write without silently retrying it', async () => {
    const { queryClient, initial } = fixture();
    const current = { ...initial, version: 2 };
    const conflict = new Error('If-Match rejected');
    const client = {
      settings: vi.fn().mockResolvedValue(current),
      updateSettings: vi.fn().mockRejectedValue(conflict),
    };
    await expect(
      updateCachedSettings(queryClient, client, initial, { workspace: { showTabNumber: false } }),
    ).rejects.toBe(conflict);
    expect(client.updateSettings).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['settings'])).toEqual(current);
    const saved = { ...current, version: 3 };
    client.updateSettings.mockResolvedValue(saved);
    await updateCachedSettings(queryClient, client, initial, {
      workspace: { showTabNumber: false },
    });
    expect(client.updateSettings).toHaveBeenLastCalledWith(current, {
      workspace: { showTabNumber: false },
    });
  });

  it('retains a newer revision delivered while the write was in flight', async () => {
    const { queryClient, initial } = fixture();
    const saved = { ...initial, version: 2 };
    const newer = { ...initial, version: 3 };
    const client = {
      settings: vi.fn(),
      updateSettings: vi.fn().mockImplementation(async () => {
        queryClient.setQueryData(['settings'], newer);
        return saved;
      }),
    };
    await updateCachedSettings(queryClient, client, initial, {
      workspace: { showTabNumber: false },
    });
    expect(queryClient.getQueryData(['settings'])).toEqual(newer);
  });
});
