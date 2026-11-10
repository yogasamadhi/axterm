import * as owner0 from '../../packages/plugins/ai/src/client/ui/locales.ts';
import * as owner1 from '../../packages/plugins/automation/src/client/ui/locales.ts';
import * as owner2 from '../../packages/plugins/automation/src/client/ui/widget-locales.json' with { type: 'json' };
import * as owner3 from '../../packages/plugins/catalog/src/client/ui/editor/locales.ts';
import * as owner4 from '../../packages/plugins/catalog/src/client/ui/editor/ssh-error-locales.json' with { type: 'json' };
import * as owner5 from '../../packages/plugins/catalog/src/client/ui/locales.ts';
import * as owner6 from '../../packages/plugins/catalog/src/client/ui/manager/locales.ts';
import * as owner7 from '../../packages/plugins/catalog/src/client/ui/profiles/locales.ts';
import * as owner8 from '../../packages/plugins/catalog/src/client/ui/session/locales.ts';
import * as owner9 from '../../packages/plugins/catalog/src/client/ui/tree/locales.ts';
import * as owner10 from '../../packages/plugins/configuration/src/client/behavior-locales.json' with { type: 'json' };
import * as owner11 from '../../packages/plugins/configuration/src/client/legal-locales.json' with { type: 'json' };
import * as owner12 from '../../packages/plugins/configuration/src/client/locales.ts';
import * as owner13 from '../../packages/plugins/configuration/src/client/navigation-locales.ts';
import * as owner14 from '../../packages/plugins/configuration/src/client/portable-locales.json' with { type: 'json' };
import * as owner15 from '../../packages/plugins/configuration/src/client/rail-locales.json' with { type: 'json' };
import * as owner16 from '../../packages/plugins/configuration/src/client/settings-presentation-locales.json' with { type: 'json' };
import * as owner17 from '../../packages/plugins/configuration/src/client/sync-locales.ts';
import * as owner18 from '../../packages/plugins/configuration/src/client/sync-presentation-locales.json' with { type: 'json' };
import * as owner19 from '../../packages/plugins/connections/src/client/ui/locales.ts';
import * as owner20 from '../../packages/plugins/connections/src/client/ui/tools/locales.ts';
import * as owner21 from '../../packages/plugins/desktop/src/client/diagnostics-locales.ts';
import * as owner22 from '../../packages/plugins/desktop/src/client/power-locales.json' with { type: 'json' };
import * as owner23 from '../../packages/plugins/desktop/src/client/preferences-locales.ts';
import * as owner24 from '../../packages/plugins/desktop/src/client/runtime-status-locales.ts';
import * as owner25 from '../../packages/plugins/desktop/src/client/updater-locales.ts';
import * as owner26 from '../../packages/plugins/desktop/src/client/window-control-locales.ts';
import * as owner27 from '../../packages/plugins/files/src/client/ui/locales.ts';
import * as owner28 from '../../packages/plugins/market/src/client/locales.ts';
import * as owner29 from '../../packages/plugins/plugins/src/client/locales.ts';
import * as owner30 from '../../packages/plugins/remote-desktop/src/client/ui/locales.ts';
import * as owner31 from '../../packages/plugins/terminals/src/client/drop/locales.ts';
import * as owner32 from '../../packages/plugins/terminals/src/client/history/locales.ts';
import * as owner33 from '../../packages/plugins/terminals/src/client/interactions/locales.ts';
import * as owner34 from '../../packages/plugins/terminals/src/client/keybar/locales.ts';
import * as owner35 from '../../packages/plugins/terminals/src/client/locales.ts';
import * as owner36 from '../../packages/plugins/terminals/src/client/profiles/locales.ts';
import * as owner37 from '../../packages/plugins/terminals/src/client/session/locales.ts';
import * as owner38 from '../../packages/plugins/terminals/src/client/suggestions/locales.ts';
import * as owner39 from '../../packages/plugins/terminals/src/client/themes/locales.ts';
import * as owner40 from '../../packages/plugins/terminals/src/client/tools/locales.ts';
import * as owner41 from '../../packages/plugins/terminals/src/client/transfer-locales.ts';
import * as owner42 from '../../packages/plugins/transfers/src/client/ui/locales.ts';
import * as owner43 from '../../packages/plugins/workspace/src/client/locales.ts';
import * as owner44 from '../../packages/plugins/workspace/src/client/named-locales.json' with { type: 'json' };
import * as owner45 from '../../packages/plugins/workspace/src/client/palette-locales.ts';
import * as owner46 from '../../packages/plugins/workspace/src/client/rail-locales.json' with { type: 'json' };
import * as owner47 from '../../packages/plugins/workspace/src/client/startup-locales.json' with { type: 'json' };
import { ownedTranslations } from './level3-owner-translations.ts';
export const productLocales = ['en', 'ja', 'zh-CN', 'zh-TW'] as const;
type Catalog = Readonly<Record<string, Readonly<Record<string, string>>>>;
const modules: readonly (readonly [string, unknown])[] = [
  ['packages/plugins/ai/src/client/ui/locales.ts', owner0],
  ['packages/plugins/automation/src/client/ui/locales.ts', owner1],
  ['packages/plugins/automation/src/client/ui/widget-locales.json', owner2],
  ['packages/plugins/catalog/src/client/ui/editor/locales.ts', owner3],
  ['packages/plugins/catalog/src/client/ui/editor/ssh-error-locales.json', owner4],
  ['packages/plugins/catalog/src/client/ui/locales.ts', owner5],
  ['packages/plugins/catalog/src/client/ui/manager/locales.ts', owner6],
  ['packages/plugins/catalog/src/client/ui/profiles/locales.ts', owner7],
  ['packages/plugins/catalog/src/client/ui/session/locales.ts', owner8],
  ['packages/plugins/catalog/src/client/ui/tree/locales.ts', owner9],
  ['packages/plugins/configuration/src/client/behavior-locales.json', owner10],
  ['packages/plugins/configuration/src/client/legal-locales.json', owner11],
  ['packages/plugins/configuration/src/client/locales.ts', owner12],
  ['packages/plugins/configuration/src/client/navigation-locales.ts', owner13],
  ['packages/plugins/configuration/src/client/portable-locales.json', owner14],
  ['packages/plugins/configuration/src/client/rail-locales.json', owner15],
  ['packages/plugins/configuration/src/client/settings-presentation-locales.json', owner16],
  ['packages/plugins/configuration/src/client/sync-locales.ts', owner17],
  ['packages/plugins/configuration/src/client/sync-presentation-locales.json', owner18],
  ['packages/plugins/connections/src/client/ui/locales.ts', owner19],
  ['packages/plugins/connections/src/client/ui/tools/locales.ts', owner20],
  ['packages/plugins/desktop/src/client/diagnostics-locales.ts', owner21],
  ['packages/plugins/desktop/src/client/power-locales.json', owner22],
  ['packages/plugins/desktop/src/client/preferences-locales.ts', owner23],
  ['packages/plugins/desktop/src/client/runtime-status-locales.ts', owner24],
  ['packages/plugins/desktop/src/client/updater-locales.ts', owner25],
  ['packages/plugins/desktop/src/client/window-control-locales.ts', owner26],
  ['packages/plugins/files/src/client/ui/locales.ts', owner27],
  ['packages/plugins/market/src/client/locales.ts', owner28],
  ['packages/plugins/plugins/src/client/locales.ts', owner29],
  ['packages/plugins/remote-desktop/src/client/ui/locales.ts', owner30],
  ['packages/plugins/terminals/src/client/drop/locales.ts', owner31],
  ['packages/plugins/terminals/src/client/history/locales.ts', owner32],
  ['packages/plugins/terminals/src/client/interactions/locales.ts', owner33],
  ['packages/plugins/terminals/src/client/keybar/locales.ts', owner34],
  ['packages/plugins/terminals/src/client/locales.ts', owner35],
  ['packages/plugins/terminals/src/client/profiles/locales.ts', owner36],
  ['packages/plugins/terminals/src/client/session/locales.ts', owner37],
  ['packages/plugins/terminals/src/client/suggestions/locales.ts', owner38],
  ['packages/plugins/terminals/src/client/themes/locales.ts', owner39],
  ['packages/plugins/terminals/src/client/tools/locales.ts', owner40],
  ['packages/plugins/terminals/src/client/transfer-locales.ts', owner41],
  ['packages/plugins/transfers/src/client/ui/locales.ts', owner42],
  ['packages/plugins/workspace/src/client/locales.ts', owner43],
  ['packages/plugins/workspace/src/client/named-locales.json', owner44],
  ['packages/plugins/workspace/src/client/palette-locales.ts', owner45],
  ['packages/plugins/workspace/src/client/rail-locales.json', owner46],
  ['packages/plugins/workspace/src/client/startup-locales.json', owner47],
];
export const ownerCatalogs: {
  path: string;
  dictionaries: Catalog;
  translate: ReturnType<typeof ownedTranslations>;
}[] = [];
for (const [path, module] of modules) {
  if (!module || typeof module !== 'object') throw Error('Invalid owner module');
  const seen = new Set<unknown>();
  for (const value of Object.values(module)) {
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    const dictionaries = value as Record<string, unknown>;
    if (
      !productLocales.every(
        (locale) => dictionaries[locale] && typeof dictionaries[locale] === 'object',
      )
    )
      continue;
    if (!Object.values(dictionaries.en as object).every((value) => typeof value === 'string'))
      continue;
    seen.add(value);
    const catalog = dictionaries as Catalog;
    ownerCatalogs.push({
      path,
      dictionaries: catalog,
      translate: ownedTranslations('retained-owner-' + ownerCatalogs.length, catalog),
    });
  }
}
export function dictionaryCandidates(key: string) {
  return ownerCatalogs.filter((owner) => Object.hasOwn(owner.dictionaries.en!, key));
}
export function translateProduct(
  language: string,
  key: string,
  variables?: Record<string, unknown>,
) {
  const matches = dictionaryCandidates(key);
  if (!matches.length) throw Error('Actual owner key absent: ' + key);
  const values = new Set(
    matches.map((owner) =>
      JSON.stringify(productLocales.map((locale) => owner.dictionaries[locale]?.[key])),
    ),
  );
  if (values.size !== 1)
    throw Error(
      'Actual owner key ambiguous: ' + key + ' ' + matches.map((owner) => owner.path).join(','),
    );
  return matches[0]!.translate(language, key, variables);
}

export function translateNavigation(
  language: string,
  key: string,
  variables?: Record<string, unknown>,
) {
  const owner = ownerCatalogs.find(
    (owner) => owner.path === 'packages/plugins/workspace/src/client/rail-locales.json',
  );
  if (!owner || !Object.hasOwn(owner.dictionaries.en!, key))
    throw Error('Navigation owner key absent: ' + key);
  return owner.translate(language, key, variables);
}
