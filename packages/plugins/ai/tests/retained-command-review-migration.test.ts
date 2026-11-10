import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { ownedStorage } from '../../../../tests/fixtures/level3-owned-storage.ts';
import { readMigrationMarker } from '../../../../tests/fixtures/level3-catalog-storage.ts';
import { applyHistoricalSql } from '../../../../tests/fixtures/migration/historical-sql.ts';
import { productDomains } from '@axterm/data-schema';
import { AiStorage } from '../src/adapters/storage.ts';
import { AiRepository } from '../src/adapters/repository.ts';

async function fixture(path: string) {
  const storage = await ownedStorage(path);
  const sql = new AiStorage(await storage.open(productDomains.ai));
  return { ...storage, sql };
}

it('upgrades a v41 database and preserves legacy tool semantics without invented review metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-review-migration-'));
  const path = join(root, 'product.sqlite');
  let database = await fixture(path);
  try {
    const repository = new AiRepository(database.sql);
    const run = repository.createAiRun({ engineId: 'pi', useCase: 'diagnose', request: {} });
    const call = repository.createToolCall({
      runId: run.id,
      toolName: 'terminal.exec',
      args: { command: 'echo old' },
      target: randomUUID(),
      risk: 'mutating',
      argsHash: 'legacy-digest',
      state: 'waiting_approval',
    });
    await database.close();
    const old = new DatabaseSync(path);
    try {
      old.exec(
        'ALTER TABLE ai_tool_calls DROP COLUMN review_json; ALTER TABLE ai_tool_calls DROP COLUMN step; ALTER TABLE ai_tool_calls DROP COLUMN approval_source;',
      );
      old.prepare("DELETE FROM app_meta WHERE key='migration:42'").run();
      applyHistoricalSql(old, 42);
    } finally {
      old.close();
    }
    database = await fixture(path);
    const upgraded = new AiRepository(database.sql).getToolCall(call.id);
    expect(upgraded).toMatchObject({
      toolName: 'terminal.exec',
      risk: 'mutating',
      argsHash: 'legacy-digest',
      args: { command: 'echo old' },
    });
    expect(upgraded.review).toBeUndefined();
    expect(upgraded.step).toBeUndefined();
    expect(upgraded.approvalSource).toBeUndefined();
    expect((await readMigrationMarker(path, 42))?.value).toBeTruthy();
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
