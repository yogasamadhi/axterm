import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectSourceBoundary } from '../../scripts/source-boundaries.mjs';

describe('Desktop standalone source boundary', () => {
  const root = resolve('/fixture/axterm');
  const filename = resolve(root, 'apps/web/index.ts');
  it('rejects static, re-export, dynamic and require imports of private platform code', () => {
    for (const source of [
      "import x from '../../../platform/server/owner'",
      "export * from '@axterm/platform-client'",
      "const x = import('@axterm/portal')",
      "const x = require('../../../platform/client')",
    ])
      expect(inspectSourceBoundary(root, filename, source)).not.toEqual([]);
  });
  it('permits owned sources and public Desktop package imports', () => {
    expect(
      inspectSourceBoundary(
        root,
        filename,
        "import x from '../../cli/src/index'; export * from '@axterm/plugin-api'",
      ),
    ).toEqual([]);
  });
});
