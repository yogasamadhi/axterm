import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { ProductDatabase } from './database';
import { ProductRepository } from './product-repository';

it('upgrades a v41 database and preserves legacy tool semantics without invented review metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-review-migration-'));
  const path = join(root, 'product.sqlite');
  let database = await ProductDatabase.open(path);
  try {
    const repository = new ProductRepository(database);
    const run = repository.createAiRun({ useCase: 'diagnose', request: {} });
    const call = repository.createToolCall({
      runId: run.id,
      toolName: 'terminal.exec',
      args: { command: 'echo old' },
      target: randomUUID(),
      risk: 'mutating',
      argsHash: 'legacy-digest',
      state: 'waiting_approval',
    });
    database.close();
    const old = new DatabaseSync(path);
    try {
      old.exec(
        'ALTER TABLE ai_tool_calls DROP COLUMN review_json; ALTER TABLE ai_tool_calls DROP COLUMN step; ALTER TABLE ai_tool_calls DROP COLUMN approval_source;',
      );
      old.prepare("DELETE FROM app_meta WHERE key='migration:42'").run();
    } finally {
      old.close();
    }
    database = await ProductDatabase.open(path);
    const upgraded = new ProductRepository(database).getToolCall(call.id);
    expect(upgraded).toMatchObject({
      toolName: 'terminal.exec',
      risk: 'mutating',
      argsHash: 'legacy-digest',
      args: { command: 'echo old' },
    });
    expect(upgraded.review).toBeUndefined();
    expect(upgraded.step).toBeUndefined();
    expect(upgraded.approvalSource).toBeUndefined();
    expect(
      database.get<{ value: string }>("SELECT value FROM app_meta WHERE key='migration:42'")?.value,
    ).toBeTruthy();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
