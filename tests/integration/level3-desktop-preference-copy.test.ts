import { expect, it } from 'vitest';
import { productDomains } from '@axterm/data-schema';
import { DEFAULT_DESKTOP_WINDOW_PREFERENCES } from '@axterm/plugin-api/desktop';
import { ownedStorage } from '../fixtures/level3-owned-storage.ts';
import { migrateCopiedData } from '../../packages/plugins/desktop/src/copy.ts';
import { DesktopPreferencesStore } from '../../packages/plugins/desktop/src/preferences-store.ts';
it('copies legacy missing opt-in and future fields without modifying the input or dropping valid presentation', async () => {
  const storage = await ownedStorage();
  const input = {
    version: 1,
    preferences: {
      ...DEFAULT_DESKTOP_WINDOW_PREFERENCES,
      rememberWindowSize: undefined,
      opacity: 0.8,
      bounds: { x: 40_000, y: -40_000, width: 1180, height: 780 },
      futureField: { added: 'by a later build' },
    },
  };
  const original = structuredClone(input);
  await migrateCopiedData(storage.ctx, input);
  const domain = await storage.open(productDomains.desktop);
  const store = new DesktopPreferencesStore(domain);
  expect(store.read()).toMatchObject({
    version: 1,
    preferences: {
      rememberWindowSize: false,
      opacity: 0.8,
      bounds: input.preferences.bounds,
    },
  });
  expect(store.read().preferences).not.toHaveProperty('futureField');
  expect(input).toEqual(original);
  expect(domain.events(0).map((event) => event.type)).toEqual(['desktop/home-copied']);
});
it('refuses corrupt copied preferences without replacing source data or publishing default facts', async () => {
  const storage = await ownedStorage();
  for (const input of [
    null,
    { version: 2, preferences: DEFAULT_DESKTOP_WINDOW_PREFERENCES },
    { version: 1, preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, opacity: 4 } },
  ]) {
    const original = structuredClone(input);
    await expect(migrateCopiedData(storage.ctx, input)).rejects.toThrow();
    expect(input).toEqual(original);
  }
  const domain = await storage.open(productDomains.desktop);
  expect(domain.all('SELECT * FROM axterm_desktop_preferences')).toEqual([]);
  expect(domain.events(0)).toEqual([]);
});
