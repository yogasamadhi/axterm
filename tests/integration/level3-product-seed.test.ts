import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { terminalProfileInputSchema } from '@axterm/plugin-api/terminals';
import { withLevel3ProductSeed, withLevel3CatalogSeed } from '../fixtures/level3-product-seed.ts';

it('prepares the current product storage through owned facets and reopens it after deterministic cleanup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-current-product-seed-'));
  const group = randomUUID();
  try {
    const profileId = await withLevel3ProductSeed(home, (ctx) => {
      const profile = ctx.terminalFacts.createProfile(
        randomUUID(),
        terminalProfileInputSchema.parse({
          name: 'Fixed shell',
          shell: '/bin/sh',
          cwd: home,
          loginShell: false,
        }),
      );
      const settings = ctx.configurationController.getSettings();
      ctx.configurationController.updateSettings(
        randomUUID(),
        { terminal: { defaultProfileId: profile.ids[0]! } },
        `"v${settings.version}"`,
      );
      return profile.ids[0]!;
    });
    await withLevel3CatalogSeed(home, (domain) =>
      domain.transaction(() => {
        domain.run(
          'INSERT INTO bookmark_groups(id,parent_id,name,color,description,position,created_at,updated_at,version) VALUES (?,NULL,?,NULL,?,0,?,?,1)',
          group,
          'Owned fixture',
          '',
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }),
    );
    await withLevel3ProductSeed(home, (ctx) => {
      expect(ctx.configurationController.getSettings().terminal.defaultProfileId).toBe(profileId);
      expect(ctx.terminalFacts.getProfile(profileId).shell).toBe('/bin/sh');
    });
    await withLevel3CatalogSeed(home, (domain) => {
      expect(
        domain.get<{ name: string }>('SELECT name FROM bookmark_groups WHERE id=?', group)?.name,
      ).toBe('Owned fixture');
      expect(() => domain.run('DELETE FROM settings')).toThrow();
    });
    await expect(
      withLevel3ProductSeed(process.cwd(), () => {
        throw Error('Must not run');
      }),
    ).rejects.toThrow('isolated temporary descendant');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
