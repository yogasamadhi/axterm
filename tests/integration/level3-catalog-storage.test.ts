import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';

it('preserves native bookmark Host foreign keys while isolating terminal-owned facts', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(Storage);
    await ctx.plugin(Schema);
    await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
    await ctx.plugin(Domains, { backend: 'relational' });
    const catalog = await ctx.storage.domain.open(Schema.productDomains.catalog);
    const terminals = await ctx.storage.domain.open(Schema.productDomains.terminals);
    const profileId = randomUUID();
    terminals.run(
      "INSERT INTO terminal_profiles(id,name,payload,created_at,updated_at) VALUES (?,'Profile','{}','2026-11-05','2026-11-05')",
      profileId,
    );
    const id = randomUUID();
    catalog.run(
      "INSERT INTO bookmarks(id,protocol,title,color,description,position,created_at,updated_at) VALUES (?,'local','Local',NULL,'',0,'2026-11-05','2026-11-05')",
      id,
    );
    expect(catalog.get('SELECT title FROM bookmarks WHERE id=?', id)).toEqual({ title: 'Local' });
    catalog.run('UPDATE bookmarks SET profile_id=? WHERE id=?', profileId, id);
    expect(() =>
      catalog.run("UPDATE bookmarks SET protocol='ssh',host_id=? WHERE id=?", randomUUID(), id),
    ).toThrow();
    expect(catalog.get('SELECT protocol,host_id FROM bookmarks WHERE id=?', id)).toEqual({
      protocol: 'local',
      host_id: null,
    });
    expect(catalog.get('SELECT profile_id FROM bookmarks WHERE id=?', id)).toEqual({
      profile_id: profileId,
    });
    expect(() => catalog.get('SELECT * FROM terminal_profiles')).toThrow();
  } finally {
    await ctx.fiber.dispose();
  }
});
