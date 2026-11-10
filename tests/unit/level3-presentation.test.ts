import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleRuntime } from '../../packages/infra/locale/src/client/index.ts';
import { ThemeRuntime } from '../../packages/infra/ui-theme/src/client/index.ts';
import { PresentationPreference } from '@axterm/ui/preference';
import type { PresentationPreferencePort } from '@axterm/ui/presentation';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});
function preference(value: string | undefined) {
  let state = { available: true, value };
  const listeners = new Set<() => void>();
  const write = vi.fn(async (_value: string) => {});
  const port: PresentationPreferencePort<string> = {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    write,
  };
  return {
    port,
    write,
    accept(next: string | undefined) {
      state = { available: true, value: next };
      for (const fn of [...listeners]) fn();
    },
    unavailable() {
      state = { available: false, value: undefined };
      for (const fn of [...listeners]) fn();
    },
    listeners,
  };
}
it('adopts accepted locale facts without optimistic writes and detaches/drains the only preference owner', async () => {
  const ctx = new Context();
  const locale = new LocaleRuntime(ctx, { languages: ['zh_HK'] });
  cleanup.push(() => locale.dispose());
  expect(locale.getLocale().active).toBe('zh-TW');
  expect(locale.resolveText({ en: 'Sessions', 'zh-TW': '工作階段' })).toBe('工作階段');
  const owner = preference('en');
  const stop = locale.attachPreference(owner.port);
  expect(locale.getLocale().active).toBe('en');
  expect(() => locale.attachPreference(owner.port)).toThrow('OWNER_EXISTS');
  let release!: () => void;
  owner.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = locale.setLocale('ja');
  await vi.waitFor(() => expect(owner.write).toHaveBeenCalledWith('ja'));
  expect(locale.getLocale().active).toBe('en');
  let drained = false;
  const stopped = stop().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(owner.listeners.size).toBe(0);
  await expect(locale.setLocale('zh-CN')).rejects.toThrow('UNAVAILABLE');
  release();
  await pending;
  await stopped;
  expect(drained).toBe(true);
  const replacement = preference('ja');
  const detach = locale.attachPreference(replacement.port);
  expect(locale.getLocale().active).toBe('ja');
  replacement.write.mockRejectedValueOnce(new Error('CONFLICT'));
  await expect(locale.setLocale('en')).rejects.toThrow('CONFLICT');
  expect(locale.getLocale().active).toBe('ja');
  replacement.unavailable();
  await expect(locale.setLocale('en')).rejects.toThrow('UNAVAILABLE');
  await detach();
});
it('keeps typed namespace fallback, immutable dictionaries, late registration and stale disposers safe', async () => {
  const ctx = new Context();
  const locale = new LocaleRuntime(ctx, { languages: ['ja-JP'] });
  cleanup.push(() => locale.dispose());
  const read = locale.getSnapshot;
  const subscribe = locale.subscribe;
  expect(read().active).toBe('ja');
  let notifications = 0;
  const off = subscribe(() => notifications++);
  const dictionary = { hello: 'Hello {name}', empty: '' };
  const remove = locale.register('fixture', 'en', dictionary);
  dictionary.hello = 'mutated';
  const t = locale.bind('fixture');
  expect(t('hello', { name: 'world' })).toBe('Hello world');
  expect(t('empty')).toBe('');
  expect(t('toString')).toBe('toString');
  expect(() => locale.register('fixture', 'EN', {})).toThrow('already');
  const japanese = locale.register('fixture', 'ja', { hello: 'こんにちは {name}' });
  expect(t('hello', { name: '世界' })).toBe('こんにちは 世界');
  expect(notifications).toBeGreaterThan(0);
  japanese();
  expect(t('hello', { name: 'world' })).toBe('Hello world');
  remove();
  const next = locale.register('fixture', 'en', { hello: 'Replacement' });
  remove();
  expect(t('hello')).toBe('Replacement');
  const removeLanguage = locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' });
  expect(() => locale.addLanguage({ id: 'fr', label: 'duplicate', fallback: 'en' })).toThrow(
    'already',
  );
  expect(() => locale.addLanguage({ id: 'xx', label: 'Invalid', fallback: 'missing' })).toThrow(
    'not registered',
  );
  removeLanguage();
  removeLanguage();
  next();
  off();
});
it('refuses invalid or oversized dictionaries and leaves the registry reusable', async () => {
  const locale = new LocaleRuntime(new Context());
  cleanup.push(() => locale.dispose());
  expect(() => locale.register('fixture', 'en', { bad: 'x'.repeat(16385) })).toThrow('INVALID');
  expect(() => locale.register('bad namespace', 'en', {})).toThrow('INVALID');
  expect(() =>
    locale.addLanguage({ id: 'aa-' + 'bb-'.repeat(100) + 'cc', label: 'Too long', fallback: 'en' }),
  ).toThrow('INVALID');
  expect(() => locale.resolveText({ en: 'one', EN: 'two' })).toThrow('INVALID');
  expect(() => locale.register('fixture', 'en', { valid: 'ready' })).not.toThrow();
  await locale.dispose();
  await expect(locale.setLocale('en')).rejects.toThrow('CLOSED');
  expect(() => locale.register('after', 'en', {})).toThrow('CLOSED');
});
it('resolves system media, preserves accepted preference on failure, stacks theme layers and removes actual listeners', async () => {
  const listeners = new Set<() => void>();
  let matches = false;
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return matches;
    },
    addEventListener(_event: string, fn: () => void) {
      listeners.add(fn);
    },
    removeEventListener(_event: string, fn: () => void) {
      listeners.delete(fn);
    },
  }));
  const theme = new ThemeRuntime(new Context());
  cleanup.push(() => theme.dispose());
  const owner = preference('system');
  theme.attachPreference(owner.port);
  expect(theme.getTheme().active.colorScheme).toBe('light');
  matches = true;
  for (const fn of listeners) fn();
  expect(theme.getTheme().active.colorScheme).toBe('dark');
  owner.write.mockRejectedValueOnce(new Error('CONFLICT'));
  await expect(theme.setTheme('light')).rejects.toThrow('CONFLICT');
  expect(theme.getTheme().preference).toBe('system');
  const original = { '--ax-color-primary': '#112233' };
  const remove = theme.register({ id: 'external', colorScheme: 'dark', tokens: original });
  original['--ax-color-primary'] = '#000000';
  await theme.setTheme('external');
  expect(theme.getTheme().active.tokens['--ax-color-primary']).toBe('#112233');
  const stale = theme.overrideTokens('fixture', {
    '--ax-color-primary': { light: '#eeeeee', dark: '#111111' },
  });
  const latest = theme.overrideTokens('fixture', {
    '--ax-color-primary': { light: '#dddddd', dark: '#222222' },
  });
  stale();
  expect(theme.getTheme().active.tokens['--ax-color-primary']).toBe('#222222');
  latest();
  expect(theme.getTheme().active.tokens['--ax-color-primary']).toBe('#112233');
  remove();
  expect(theme.getTheme().preference).toBe('system');
  expect(() => theme.overrideTokens('bad', { '--ax-color-primary': 'white' } as never)).toThrow(
    'BOTH_MODES',
  );
  expect(() =>
    theme.register({
      id: 'unsafe',
      colorScheme: 'light',
      tokens: { '--ax-color-primary': 'url(https://invalid.test)' },
    }),
  ).toThrow('INVALID');
  await theme.dispose();
  expect(listeners.size).toBe(0);
  await expect(theme.setTheme('dark')).rejects.toThrow('CLOSED');
});
it('drains a rejected preference operation during disposal without losing its caller error', async () => {
  const owner = preference('en');
  let reject!: (error: Error) => void;
  owner.write.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const binding = new PresentationPreference<string>(() => {});
  binding.attach(owner.port);
  const pending = binding.write('ja');
  const observed = expect(pending).rejects.toThrow('FAILED');
  await vi.waitFor(() => expect(owner.write).toHaveBeenCalled());
  const done = binding.dispose();
  await expect(binding.write('en')).rejects.toThrow('CLOSED');
  reject(new Error('FAILED'));
  await observed;
  await done;
  expect(owner.listeners.size).toBe(0);
});
