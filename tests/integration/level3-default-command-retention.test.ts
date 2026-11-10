import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { DomainCommands } from '@axterm/infra-storage-domain';
import { productDomains } from '@axterm/data-schema';
import { ownedStorage } from '../fixtures/level3-owned-storage.ts';
it('applies the default2000 outcome ceiling while refusing expired command replay', async () => {
  const f = await ownedStorage(),
    domain = await f.open(productDomains.configuration);
  const commands = new DomainCommands(domain, 'axterm_configuration_command_receipts');
  const limit = 2000,
    ids = Array.from({ length: limit + 5 }, () => randomUUID());
  for (const [index, id] of ids.entries())
    commands.execute(id, 'long-running-workflow', { index }, () => ({ index }));
  expect(
    domain.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM axterm_configuration_command_receipts WHERE operation='long-running-workflow' AND status='completed'",
    )?.count,
  ).toBe(limit);
  expect(commands.lookup(ids[limit + 4]!, 'long-running-workflow', { index: limit + 4 })).toEqual({
    index: limit + 4,
  });
  expect(() => new DomainCommands(domain, 'axterm_configuration_command_receipts', 0)).toThrow(
    expect.objectContaining({ code: 'invalid-input' }),
  );
  expect(
    domain.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM axterm_configuration_command_receipts',
    )?.count,
  ).toBe(limit + 5);
  const apply = vi.fn(() => ({ index: 0 }));
  expect(() => commands.execute(ids[0]!, 'long-running-workflow', { index: 0 }, apply)).toThrow(
    expect.objectContaining({ code: 'receipt-expired' }),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(
    domain.all(
      "SELECT result_json FROM axterm_configuration_command_receipts WHERE status='expired'",
    ),
  ).toEqual(Array.from({ length: 5 }, () => ({ result_json: 'null' })));
});
