import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { TerminalOutputObserver } from '@axterm/plugin-api/host';
import type { TriggerRuleInput } from '@axterm/plugin-api/automation';
import { AutomationStorage } from '../../packages/plugins/automation/src/adapters/storage.ts';
import { QuickCommandRepository } from '../../packages/plugins/automation/src/adapters/quick-command-repository.ts';
import { TriggerRepository } from '../../packages/plugins/automation/src/adapters/trigger-repository.ts';
import { QuickCommandService } from '../../packages/plugins/automation/src/application/quick-commands.ts';
import { TriggerService } from '../../packages/plugins/automation/src/application/triggers.ts';
import { AutomationFacts } from '../../packages/plugins/automation/src/adapters/facts.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.automation);
  cleanups.push(() => domain.close());
  const sql = new AutomationStorage(domain);
  sql.assertBounds();
  const quick = new QuickCommandService(new QuickCommandRepository(sql));
  const observers = new Set<TerminalOutputObserver>();
  const inserted = vi.fn();
  const notified = vi.fn();
  const triggers = new TriggerService(
    new TriggerRepository(sql),
    {
      addOutputObserver: (observer) => {
        observers.add(observer);
        return () => {
          observers.delete(observer);
        };
      },
      insertText: inserted,
      get: () => {
        throw new Error('No bookmark required');
      },
    },
    { publish: notified },
  );
  cleanups.push(async () => triggers.close());
  const facts = new AutomationFacts(domain, sql, quick, triggers);
  const emit = (text: string) => {
    for (const observer of observers)
      observer.receive('controlled-terminal', Buffer.from(text), 'utf8');
  };
  return { ctx, domain, sql, quick, triggers, facts, emit, inserted, notified, observers };
}
it('commits owned Quick Command tree facts and compact replay receipts, keeps hierarchy and refuses cross-domain SQL', async () => {
  const f = await fixture();
  const key = randomUUID();
  const input = { name: 'Folder', parentId: null };
  const original = f.quick.snapshot();
  const first = f.facts.createGroup(key, input, original.etag);
  expect(f.facts.createGroup(key, input, original.etag)).toEqual(first);
  expect(f.quick.snapshot().groups).toHaveLength(1);
  expect(() => f.facts.createGroup(key, { ...input, name: 'changed' }, original.etag)).toThrow();
  const payload = {
    groupId: first.ids[0]!,
    name: 'Inspect',
    command: 'pwd',
    commands: [{ id: randomUUID(), name: '', command: 'pwd', delayMs: 100 }],
    description: '',
    tags: [],
    shortcut: null,
    inputOnly: false,
    clickCount: 0,
  };
  const created = f.facts.createCommand(randomUUID(), payload, f.quick.snapshot().etag);
  expect(f.quick.snapshot().commands[0]).toMatchObject({ id: created.ids[0], command: 'pwd' });
  expect(() => f.facts.deleteCommand(randomUUID(), created.ids[0]!, undefined)).toThrow();
  f.facts.deleteCommand(randomUUID(), created.ids[0]!, f.quick.snapshot().etag);
  expect(f.facts.createGroup(key, input, original.etag)).toEqual(first);
  const receipt = f.domain.get<{ result_json: string }>(
    'SELECT result_json FROM axterm_automation_command_receipts WHERE command_id=?',
    key,
  )!;
  expect(receipt.result_json).not.toContain('Folder');
  expect(receipt.result_json.length).toBeLessThan(512);
  expect(() =>
    f.domain.run("UPDATE app_meta SET value='9' WHERE key='quick-command-tree:revision'"),
  ).toThrow();
  expect(() => f.domain.all('SELECT * FROM hosts')).toThrow();
});
const rule = (): TriggerRuleInput => ({
  name: 'Controlled prompt',
  enabled: true,
  match: { type: 'text', value: 'READY', caseSensitive: true },
  action: { type: 'send', value: 'pwd' },
  sendEnter: true,
  mode: 'once',
  cooldownMs: 0,
});
it('activates committed trigger rules only after fact commit and never replays old terminal output', async () => {
  const f = await fixture();
  f.emit('READY');
  expect(f.inserted).not.toHaveBeenCalled();
  const created = f.facts.createTrigger(randomUUID(), rule(), f.triggers.snapshot().etag);
  f.emit('nothing');
  expect(f.inserted).not.toHaveBeenCalled();
  f.emit('READY');
  expect(f.inserted).toHaveBeenCalledWith('controlled-terminal', 'pwd\r');
  expect(f.inserted).toHaveBeenCalledOnce();
  f.emit('READY');
  expect(f.inserted).toHaveBeenCalledOnce();
  f.facts.updateTrigger(
    randomUUID(),
    created.ids[0]!,
    { mode: 'repeat' },
    f.triggers.snapshot().etag,
  );
  f.emit('READY');
  expect(f.inserted).toHaveBeenCalledTimes(2);
  const cursor = f.domain.cursor();
  expect(() =>
    f.domain.transaction(() => {
      f.triggers.update(created.ids[0]!, { enabled: false }, f.triggers.snapshot().etag);
      throw new Error('Controlled rollback');
    }),
  ).toThrow();
  expect(f.domain.cursor()).toBe(cursor);
  expect(f.triggers.snapshot().triggers[0]?.enabled).toBe(true);
  f.emit('READY');
  expect(f.inserted).toHaveBeenCalledTimes(3);
  f.facts.deleteTrigger(randomUUID(), created.ids[0]!, f.triggers.snapshot().etag);
  f.emit('READY');
  expect(f.inserted).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(f.notified.mock.calls)).not.toContain('pwd');
  f.triggers.close();
  expect(f.observers.size).toBe(0);
  expect(f.triggers.resourceCount()).toBe(0);
});
it('rolls oversized persisted records back before snapshot materialization and keeps the original bytes', async () => {
  const f = await fixture();
  const etag = f.quick.snapshot().etag;
  const id = randomUUID();
  const payload = JSON.stringify({ command: 'x'.repeat(600000) });
  const now = new Date().toISOString();
  f.domain.run(
    'INSERT INTO quick_commands(id,group_id,name,payload,position,created_at,updated_at,version) VALUES (?,NULL,?,?,0,?,?,1)',
    id,
    'Huge',
    payload,
    now,
    now,
  );
  expect(() => f.sql.assertBounds()).toThrow();
  expect(() => f.facts.createGroup(randomUUID(), { name: 'New', parentId: null }, etag)).toThrow();
  expect(
    f.domain.get<{ bytes: number }>(
      'SELECT length(payload) AS bytes FROM quick_commands WHERE id=?',
      id,
    )?.bytes,
  ).toBe(payload.length);
});

it('keeps hierarchy, sibling order and cycle rejection in the owned command tree', async () => {
  const f = await fixture();
  let tree = f.quick.snapshot();
  tree = f.quick.createGroup({ parentId: null, name: 'Production' }, tree.etag);
  const parent = tree.groups[0]!;
  tree = f.quick.createGroup({ parentId: parent.id, name: 'Database' }, tree.etag);
  const child = tree.groups.find((group) => group.parentId === parent.id)!;
  expect(() =>
    f.quick.move(
      {
        source: { kind: 'group', id: parent.id },
        target: { kind: 'group', id: child.id },
        position: 'inside',
      },
      tree.etag,
    ),
  ).toThrow(/cycle/i);
  expect(f.quick.snapshot().groups).toEqual(tree.groups);
  tree = f.quick.deleteGroup(child.id, tree.etag);
  expect(tree.groups).toHaveLength(1);
  expect(tree.groups[0]?.id).toBe(parent.id);
});
