import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditOwnedClients,
  inspectOwnedClientText,
  inspectOwnedDictionary,
} from '../../scripts/localization/audit-owned-client.mjs';

const complete = {
  en: { label: 'Hello {name}' },
  ja: { label: 'こんにちは {name}' },
  'zh-CN': { label: '你好 {name}' },
  'zh-TW': { label: '您好 {name}' },
};
describe('actual owned localization gate', () => {
  it('requires all four languages, identical keys, nonempty text and the exact placeholder set', () => {
    expect(inspectOwnedDictionary('owner', complete)).toEqual([]);
    for (const invalid of [
      { ...complete, ja: undefined },
      { ...complete, ja: {} },
      { ...complete, ja: { label: '' } },
      { ...complete, ja: { label: 'こんにちは {other}' } },
      { ...complete, de: { label: 'Hallo {name}' } },
    ])
      expect(inspectOwnedDictionary('owner', invalid).length).toBeGreaterThan(0);
  });
  it('accepts complete DSH localized text records and rejects bare or incomplete Client text', () => {
    expect(
      inspectOwnedClientText(
        'view.tsx',
        "const title={en:'Files',ja:'ファイル','zh-CN':'文件','zh-TW':'檔案'};",
        new Set(),
      ).errors,
    ).toEqual([]);
    for (const source of [
      "const title='文件';",
      "const title={en:'Files'};",
      "const title={en:'Files',ja:'ファイル','zh-CN':'文件'};",
      "const title={en:'Files {name}',ja:'ファイル {other}','zh-CN':'文件 {name}','zh-TW':'檔案 {name}'};",
    ])
      expect(inspectOwnedClientText('view.tsx', source, new Set()).errors.length).toBeGreaterThan(
        0,
      );
  });
  it('checks literal translation keys against actual catalogs, including qualified props calls', () => {
    expect(
      inspectOwnedClientText('view.tsx', "props.t('label'); t('label');", new Set(['label']))
        .errors,
    ).toEqual([]);
    expect(
      inspectOwnedClientText('view.tsx', "props.t('absent');", new Set(['label'])).errors,
    ).toContain('view.tsx: unknown owned translation key absent');
  });
  it('discovers the actual fixture owner and fails the executable gate when its Client adds silent fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-owned-locale-gate-'));
    const owner = join(root, 'packages/plugins/fixture/src/client');
    try {
      await mkdir(owner, { recursive: true });
      await writeFile(join(owner, 'locales.json'), JSON.stringify(complete));
      await writeFile(join(owner, 'view.tsx'), "props.t('label');");
      await expect(auditOwnedClients(root)).resolves.toMatchObject({
        catalogs: 1,
        sources: 1,
        literalKeys: 1,
      });
      await writeFile(join(owner, 'view.tsx'), "props.t('absent');");
      await expect(auditOwnedClients(root)).rejects.toThrow('unknown owned translation key absent');
      await writeFile(join(owner, 'view.tsx'), "const label='文件';");
      await expect(auditOwnedClients(root)).rejects.toThrow('bare CJK Client text');
      await writeFile(join(owner, 'view.tsx'), "props.t('label');");
      await writeFile(join(owner, 'locales.json'), JSON.stringify({ ...complete, ja: {} }));
      await expect(auditOwnedClients(root)).rejects.toThrow('ja key coverage differs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
