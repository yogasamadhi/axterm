import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import * as Contract from '@axterm/plugin-api/terminals';
import { terminalProfileInputSchema as legacyProfileInput } from '../fixtures/migration/generation2-contracts/schemas/resources.ts';
import * as Configuration from '../../packages/plugins/configuration/src/index.ts';
import * as Facts from '../../packages/plugins/terminals/src/facts.ts';
import { TerminalFactsProjection } from '../../packages/plugins/terminals/src/client/facts-projection.ts';
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
});
async function boot() {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const handles = new Map<string, RelationalDomain>();
  const facility = ctx.storage.domain;
  const open = facility.open.bind(facility);
  vi.spyOn(facility, 'open').mockImplementation(async (spec) => {
    const domain = await open(spec);
    if ('participant' in domain) handles.set(spec.name, domain as unknown as RelationalDomain);
    return domain;
  });
  await ctx.plugin(Configuration);
  const terminal: Contract.TerminalSession = Contract.terminalSessionSchema.parse({
    id: randomUUID(),
    kind: 'local',
    title: 'Controlled terminal',
    state: 'ready',
    createdAt: new Date().toISOString(),
  });
  ctx.provide('terminals', {
    executeCommand: async () => {},
    addOutputObserver: () => () => {},
    insertText: () => {},
    get: (id: string) => {
      if (id !== terminal.id) throw new Error('Fixture terminal is missing');
      return structuredClone(terminal);
    },
    list: () => [structuredClone(terminal)],
    workingDirectory: () => null,
    recentOutput: () => '',
    registerExternal: () => {
      throw new Error('unused');
    },
    enqueueStartupSequence: () => {},
    close: async () => {},
    resourceCount: () => 0,
  });
  const owner = ctx.plugin(Facts);
  await owner;
  return {
    ctx,
    owner,
    facts: ctx.terminalFacts,
    domain: handles.get('terminals')!,
    configuration: handles.get('configuration')!,
    terminal,
  };
}
it('retains profile defaults, stores one owned outcome and rejects stale or conflicting mutations without partial facts', async () => {
  const { facts, domain } = await boot();
  const key = randomUUID();
  const input = { name: 'Profile' };
  const receipt = facts.createProfile(key, input);
  const profile = facts.getProfile(receipt.ids[0]!);
  expect(profile).toMatchObject(legacyProfileInput.parse(input));
  expect(facts.createProfile(key, input)).toEqual(receipt);
  expect(facts.listProfiles()).toHaveLength(1);
  const cursor = domain.cursor();
  expect(() =>
    facts.updateProfile(randomUUID(), profile.id, { fontSize: 18 }, '"v9"'),
  ).toThrowError(expect.objectContaining({ details: { reason: 'precondition-failed' } }));
  expect(domain.cursor()).toBe(cursor);
  expect(facts.getProfile(profile.id)).toEqual(profile);
  expect(() => facts.createProfile(key, { name: 'Changed' })).toThrowError(
    expect.objectContaining({ details: { reason: 'conflict' } }),
  );
  const updated = facts.updateProfile(
    randomUUID(),
    profile.id,
    { fontSize: 18, env: { APP_MODE: 'fixture' } },
    '"v1"',
  );
  expect(updated).toMatchObject({ ids: [profile.id], version: 2 });
  expect(facts.getProfile(profile.id)).toMatchObject({
    fontSize: 18,
    env: { APP_MODE: 'fixture' },
  });
  facts.deleteProfile(randomUUID(), profile.id, '"v2"');
  expect(facts.listProfiles()).toEqual([]);
  expect(() => domain.all('SELECT id FROM hosts')).toThrow();
  expect(() => domain.run('DELETE FROM settings')).toThrow();
});
it('retains immutable built-in theme identities and persists clone, edit and delete with compact receipts', async () => {
  const { facts, domain } = await boot();
  const original = facts.listThemes();
  expect(original.map((theme) => theme.name)).toEqual([
    'Default',
    'Default light',
    'Tidal',
    'Copper',
  ]);
  expect(original[0]?.id).toBe(Contract.DEFAULT_TERMINAL_THEME_ID);
  expect(original[1]?.id).toBe(Contract.LIGHT_TERMINAL_THEME_ID);
  original[0]!.terminal.background = '#ffffff';
  expect(facts.listThemes()[0]!.terminal.background).toBe('#1e1e1e');
  expect(() =>
    facts.updateTheme(
      randomUUID(),
      Contract.DEFAULT_TERMINAL_THEME_ID,
      { name: 'Changed' },
      '"v1"',
    ),
  ).toThrowError(expect.objectContaining({ details: { reason: 'conflict' } }));
  const key = randomUUID();
  const receipt = facts.cloneTheme(key, Contract.DEFAULT_TERMINAL_THEME_ID, 'Owned clone');
  expect(facts.cloneTheme(key, Contract.DEFAULT_TERMINAL_THEME_ID, 'Owned clone')).toEqual(receipt);
  expect(facts.listThemes()).toHaveLength(5);
  expect(
    JSON.stringify(domain.all('SELECT result_json FROM axterm_terminal_command_receipts')),
  ).not.toContain('Owned clone');
  facts.updateTheme(randomUUID(), receipt.ids[0]!, { name: 'Updated clone' }, '"v1"');
  expect(facts.listThemes().find((theme) => theme.id === receipt.ids[0])).toMatchObject({
    name: 'Updated clone',
    version: 2,
  });
  facts.deleteTheme(randomUUID(), receipt.ids[0]!, '"v2"');
  expect(facts.listThemes()).toHaveLength(4);
});
it('records bounded confirmed history only when enabled, drops sensitive lines and keeps bodies out of receipts and outbox', async () => {
  const { ctx, facts, domain, terminal } = await boot();
  const input = {
    terminalId: terminal.id,
    source: 'shellIntegration' as const,
    command: 'printf AXTERM_HISTORY_OWNED',
  };
  expect(facts.recordHistory(randomUUID(), input)).toMatchObject({
    recorded: false,
    reason: 'disabled',
  });
  expect(facts.listHistory().items).toEqual([]);
  ctx.configurationController.updateSettings(
    randomUUID(),
    { privacy: { commandHistoryEnabled: true } },
    '"v1"',
  );
  const key = randomUUID();
  const recorded = facts.recordHistory(key, input);
  expect(recorded).toMatchObject({ recorded: true, count: 1 });
  expect(facts.recordHistory(key, input)).toEqual(recorded);
  expect(facts.listHistory().items).toMatchObject([{ command: input.command, count: 1 }]);
  expect(
    JSON.stringify(domain.all('SELECT result_json FROM axterm_terminal_command_receipts')),
  ).not.toContain(input.command);
  expect(JSON.stringify(domain.events(0))).not.toContain(input.command);
  expect(
    facts.recordHistory(randomUUID(), {
      ...input,
      command: 'export API_TOKEN=controlled-sensitive-value',
    }),
  ).toMatchObject({ recorded: false, reason: 'sensitive' });
  expect(JSON.stringify(domain.all('SELECT * FROM command_history'))).not.toContain(
    'controlled-sensitive-value',
  );
  const before = domain.cursor();
  terminal.state = 'closed';
  expect(() => facts.recordHistory(randomUUID(), input)).toThrowError(
    expect.objectContaining({ details: { reason: 'conflict' } }),
  );
  expect(domain.cursor()).toBe(before);
});
it('commits settings privacy and history removal together, and never replays old command bodies after clear', async () => {
  const { ctx, facts, domain, terminal } = await boot();
  ctx.configurationController.updateSettings(
    randomUUID(),
    { privacy: { commandHistoryEnabled: true } },
    '"v1"',
  );
  const key = randomUUID();
  const input = {
    terminalId: terminal.id,
    source: 'shellIntegration' as const,
    command: 'printf PRIVATE_HISTORY_MARKER',
  };
  const receipt = facts.recordHistory(key, input);
  const state = facts.listHistory();
  const cleared = facts.clearHistory(randomUUID(), state.etag);
  expect(cleared.deletedCount).toBe(1);
  expect(facts.recordHistory(key, input)).toEqual(receipt);
  expect(facts.listHistory().items).toEqual([]);
  facts.recordHistory(randomUUID(), input);
  ctx.configurationController.updateSettings(
    randomUUID(),
    { privacy: { commandHistoryEnabled: false } },
    '"v2"',
  );
  expect(facts.listHistory().items).toEqual([]);
  expect(JSON.stringify(domain.events(0))).not.toContain(input.command);
  expect(domain.events(0).at(-1)).toMatchObject({
    type: 'command-history.cleared',
    payload: { entityId: 'command-history', payload: { reason: 'disabled-by-setting' } },
  });
  expect(ctx.configuration.getSettings().privacy.commandHistoryEnabled).toBe(false);
});
async function commit(
  iterator: AsyncIterator<Contract.TerminalFactsUpdate>,
  projection: TerminalFactsProjection,
) {
  for (let i = 0; i < 1000; i++) {
    const frame = await iterator.next();
    if (frame.done) throw new Error('Fixture stream ended');
    const baseline = projection.accept(frame.value);
    if (baseline) return baseline;
  }
  throw new Error('Fixture commit is missing');
}
it('bounds unread fact watches and concurrent reads, and releases every reservation on cancellation', async () => {
  const { facts, owner } = await boot();
  const signals = Array.from({ length: 64 }, () => new AbortController());
  const streams = signals.map((signal) => facts.watch(signal.signal)[Symbol.asyncIterator]());
  expect(() => facts.watch(new AbortController().signal)).toThrowError(
    expect.objectContaining({ details: { reason: 'capacity' } }),
  );
  const first = streams[0]!.next();
  await expect(streams[0]!.next()).rejects.toMatchObject({ details: { reason: 'conflict' } });
  expect((await first).value).toMatchObject({ type: 'begin', mode: 'baseline' });
  for (const signal of signals) signal.abort();
  for (const stream of streams) expect((await stream.next()).done).toBe(true);
  const replacement = facts.watch(new AbortController().signal)[Symbol.asyncIterator]();
  expect((await replacement.next()).done).toBe(false);
  await owner.dispose();
  expect((await replacement.next()).done).toBe(true);
});

it('publishes complete validated facts atomically, replaces on durable changes and drains watches before domain release', async () => {
  const { facts, owner, ctx } = await boot();
  const abort = new AbortController();
  const stream = facts.watch(abort.signal)[Symbol.asyncIterator]();
  const projection = new TerminalFactsProjection();
  const first = await commit(stream, projection);
  expect(first.profiles).toEqual([]);
  expect(first.themes).toHaveLength(4);
  expect(first.history.items).toEqual([]);
  const receipt = facts.createProfile(randomUUID(), {
    name: '多言語🙂'.repeat(1200).slice(0, 100),
    env: { LONG_TEXT: '設定🙂'.repeat(400) },
  });
  const next = await commit(stream, projection);
  expect(next.cursor).toBeGreaterThan(first.cursor);
  expect(next.profiles[0]?.id).toBe(receipt.ids[0]);
  expect(Object.isFrozen(next.profiles[0]?.env)).toBe(true);
  const pending = stream.next();
  await owner.dispose();
  expect((await pending).done).toBe(true);
  expect(() => facts.listProfiles()).toThrowError(
    expect.objectContaining({ details: { reason: 'closed' } }),
  );
  const reopened = await ctx.storage.domain.open(Schema.productDomains.terminals);
  await reopened.close();
});
it('bounds high-frequency history outcomes and keeps expired-key tombstones from recreating cleared commands', async () => {
  const { ctx, facts, domain, terminal } = await boot();
  ctx.configurationController.updateSettings(
    randomUUID(),
    { privacy: { commandHistoryEnabled: true } },
    '"v1"',
  );
  const first = crypto.randomUUID();
  const input = {
    terminalId: terminal.id,
    source: 'shellIntegration' as const,
    command: 'echo receipt-0',
  };
  facts.recordHistory(first, input);
  for (let index = 1; index < 2008; index++)
    facts.recordHistory(crypto.randomUUID(), { ...input, command: `echo receipt-${index}` });
  expect(
    domain.get<{ count: number }>(
      "SELECT count(*) AS count FROM axterm_terminal_command_receipts WHERE status='completed'",
    )?.count,
  ).toBe(2000);
  expect(
    domain.get<{ count: number }>(
      "SELECT count(*) AS count FROM axterm_terminal_command_receipts WHERE status='expired' AND result_json='null'",
    )?.count,
  ).toBe(8);
  expect(facts.listHistory({ limit: 200 }).total).toBe(200);
  expect(() => facts.recordHistory(first, input)).toThrowError(
    expect.objectContaining({ details: { reason: 'receipt-expired' } }),
  );
  const state = facts.listHistory();
  facts.clearHistory(crypto.randomUUID(), state.etag);
  expect(facts.listHistory().items).toEqual([]);
  expect(() => facts.recordHistory(first, input)).toThrowError(
    expect.objectContaining({ details: { reason: 'receipt-expired' } }),
  );
  expect(facts.listHistory().items).toEqual([]);
  expect(
    JSON.stringify(domain.all('SELECT * FROM axterm_terminal_command_receipts')),
  ).not.toContain('echo receipt-');
});
