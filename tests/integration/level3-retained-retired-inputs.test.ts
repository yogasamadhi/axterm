import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createHostSchema } from '@axterm/plugin-api/catalog';
import { configurationFixture } from '../fixtures/level3-configuration.ts';

it.each([
  [
    'historical-axterm-portable-v2-657b3cc.json',
    '250a533d009e2b62ccc3723425584f9fad90efe9849b60ea41e2dcb583f3c0dc',
  ],
  [
    'legacy-prototype-v1.101.16-custom-terminal-theme-ui-export-v1.json',
    'c366a2a2462cf6c795d867aac7c1942a4895b6a9ab6246c9adfcd5cb47908067',
  ],
  ['legacy-legacy-prototype-data-v1.json', null],
] as const)(
  'refuses retired %s through actual file authority without changing source bytes or owned facts',
  async (filename, frozenHash) => {
    const f = await configurationFixture(true),
      managed = f.managed!;
    const raw = await readFile(resolve('tests/fixtures/migration', filename));
    if (frozenHash) expect(createHash('sha256').update(raw).digest('hex')).toBe(frozenHash);
    const catalog = f.ctx.catalog.configurationImport!;
    const host = catalog.hosts.createHost(
      createHostSchema.parse({
        name: 'Preserve existing destination',
        hostname: 'preserved.example.test',
        username: 'operator',
      }),
    );
    const facts = () => ({
      data: f.app.snapshot().data,
      settings: f.ctx.configuration.getSettings(),
      bookmarks: catalog.bookmarks.snapshot(),
    });
    const before = facts(),
      source = join(managed.home, randomUUID() + '.json');
    await writeFile(source, raw, { mode: 0o600 });
    const grant = await managed.capabilities.registry.createTrustedPath(source, 'file', ['read']);
    try {
      await expect(f.app.preview(grant.grantId, true)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      });
      expect(facts()).toEqual(before);
      expect(f.app.snapshot().data.hosts.find((value) => value.id === host.id)?.name).toBe(
        'Preserve existing destination',
      );
      expect(await readFile(source)).toEqual(raw);
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      await managed.capabilities.registry.revoke(grant.grantId);
    }
  },
);
