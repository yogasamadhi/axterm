import { expect, it } from 'vitest';
import { LocalTerminalTitles } from './local-titles.ts';
import { dictionaries } from './locales.ts';
const defaults = Object.values(dictionaries).map((value) => value.localTerminal);
const templates = Object.values(dictionaries).map((value) => value.localTab);
it('numbers all local defaults consistently, retains identities across updates and does not renumber after closing', () => {
  const owner = new LocalTerminalTitles((number) => `本地${number}`, defaults, templates);
  expect(owner.title('one', '本地终端')).toBe('本地1');
  expect(owner.title('one', '本地 1')).toBe('本地1');
  expect(owner.title('two', '本地终端')).toBe('本地2');
  expect(owner.title('three', '本地终端')).toBe('本地3');
  expect(owner.title('two', '本地终端')).toBe('本地2');
  owner.remove('two');
  expect(owner.title('three', '本地终端')).toBe('本地3');
  expect(owner.title('four', '本地终端')).toBe('本地4');
  expect(owner.title('four', 'Dev server 2026')).toBe('Dev server 2026');
  owner.reset();
  expect(owner.title('fresh', '本地终端')).toBe('本地1');
});
it('reserves restored default numbers, upgrades old generic names and uses all four locale formats', () => {
  for (const dictionary of Object.values(dictionaries)) {
    const owner = new LocalTerminalTitles(
      (number) => dictionary.localTab.replace('{number}', String(number)),
      defaults,
      templates,
    );
    expect(owner.title('restored', '本地 3')).toBe(dictionary.localTab.replace('{number}', '3'));
    expect(owner.title('new', 'Local terminal')).toBe(dictionary.localTab.replace('{number}', '4'));
    expect(owner.title('custom', '本地9007199254740991')).toBe('本地9007199254740991');
    expect(owner.title('next', dictionary.localTerminal)).toBe(
      dictionary.localTab.replace('{number}', '5'),
    );
  }
});
