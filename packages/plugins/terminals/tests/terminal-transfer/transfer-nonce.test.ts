import { basename } from 'node:path';
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { privateTerminalStagingFixture } from '../../../../../tests/fixtures/level3-terminal-private-staging.ts';

describe('transfer staging nonce', () => {
  it('produces independent random identities for actual private staging directories', async () => {
    const cleanups: (() => Promise<unknown>)[] = [];
    try {
      const f = await privateTerminalStagingFixture(cleanups);
      const values: string[] = [];
      for (let i = 0; i < 256; i++) {
        const stage = await f.staging.prepare(f.grant.grantId, 'download', 'xmodem', f.signal);
        values.push(basename(stage.path));
        expect(stage.path.startsWith(f.base + '/')).toBe(true);
        await stage.close();
        await f.staging.remove(values.at(-1)!, f.grant.grantId, f.signal);
      }
      expect(
        values.every((value) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value),
        ),
      ).toBe(true);
      expect(new Set(values).size).toBe(values.length);
      expect(f.staging.resourceCount()).toBe(0);
      expect(await readdir(f.base)).toEqual([]);
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
});
