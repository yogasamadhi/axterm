import { expect, it } from 'vitest';
import { inspectLevel3Source } from '../../scripts/level3-architecture.mjs';
const manifest = { name: '@axterm/desktop', dependencies: { '@axterm/plugin-api': '*' } };
it('allows only named native input grammar/types at the exact shell owners', () => {
  for (const [file, source] of [
    ['command-line.ts', "import {parseQuickConnect} from '@axterm/plugin-api/session-intents'"],
    [
      'launch-queue.ts',
      "import {parseQuickConnect,type DesktopLaunch} from '@axterm/plugin-api/session-intents'",
    ],
    ['host-process.ts', "import type {DesktopLaunch} from '@axterm/plugin-api/session-intents'"],
  ])
    expect(
      inspectLevel3Source('/repo/apps/desktop/src/shell/' + file, source!, manifest, 'shell'),
    ).toEqual([]);
});
it('rejects business APIs, arbitrary symbols, namespaces, default/side-effect/dynamic imports and wrong shell owners', () => {
  for (const [file, source] of [
    ['application.ts', "import {parseQuickConnect} from '@axterm/plugin-api/session-intents'"],
    ['command-line.ts', "import {createConnection} from '@axterm/plugin-api/session-intents'"],
    ['command-line.ts', "import * as api from '@axterm/plugin-api/session-intents'"],
    ['command-line.ts', "import api from '@axterm/plugin-api/session-intents'"],
    ['command-line.ts', "import '@axterm/plugin-api/session-intents'"],
    ['command-line.ts', "import('@axterm/plugin-api/session-intents')"],
    ['host-process.ts', "import {DesktopLaunch} from '@axterm/plugin-api/session-intents'"],
    ['command-line.ts', "import {createConnectionSchema} from '@axterm/plugin-api/connections'"],
  ])
    expect(
      inspectLevel3Source('/repo/apps/desktop/src/shell/' + file, source!, manifest, 'shell').join(
        ' ',
      ),
    ).toContain('Desktop shell cannot load');
});
