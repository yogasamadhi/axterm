import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
export const selectedElectronLocales = Object.freeze(['en', 'ja', 'zh-CN', 'zh-TW']);
/** Electron's grammatical-gender resources are variants of the same locale. */
export function normalizeElectronLocale(value) {
  return value.replace(/_(?:FEMININE|MASCULINE|NEUTER)$/u, '');
}
function family(value) {
  const normalized = normalizeElectronLocale(value);
  if (/^en(?:[-_](?:[A-Za-z]{2}|[0-9]{3}))?$/u.test(normalized)) return 'en';
  if (normalized === 'ja') return 'ja';
  if (/^zh[-_](?:CN|Hans)$/u.test(normalized)) return 'zh-CN';
  if (/^zh[-_](?:TW|Hant)$/u.test(normalized)) return 'zh-TW';
  return undefined;
}
export function inspectElectronLocaleFamilies(names) {
  const families = names.map(family);
  return [
    ...names
      .filter((_name, index) => families[index] === undefined)
      .map((name) => `Unexpected Electron locale: ${name}`),
    ...selectedElectronLocales
      .filter((name) => !families.includes(name))
      .map((name) => `Missing Electron locale: ${name}`),
  ];
}
export async function assertElectronLocaleFamilies(artifactRoot, platform = process.platform) {
  const mac = platform === 'darwin';
  const directory = join(
    artifactRoot,
    mac ? 'Contents/Frameworks/Electron Framework.framework/Resources' : 'locales',
  );
  const suffix = mac ? '.lproj' : '.pak';
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.slice(0, -suffix.length));
  const errors = inspectElectronLocaleFamilies(names);
  if (errors.length) throw Error(errors.join('\n'));
  return names;
}
