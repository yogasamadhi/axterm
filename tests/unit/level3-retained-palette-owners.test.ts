import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import { terminalSessionSchema } from '@axterm/plugin-api/terminals';
import type { ShortcutCommandId, ShortcutRevision } from '@axterm/plugin-api/shortcuts';
import type { Shortcuts } from '@axterm/ui/shortcuts';
import type { WorkspacePaletteItem } from '@axterm/ui/workspace';
import { ShortcutRegistry } from '../../packages/infra/shortcuts/src/client/registry.ts';
import { localizedShortcut } from '../../packages/infra/shortcuts/src/client/labels.ts';
import { dictionaries } from '../../packages/infra/shortcuts/src/client/locales.ts';
import { LocaleRuntime } from '../../packages/infra/locale/src/client/index.ts';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
import { installTerminalShortcuts } from '../../packages/plugins/terminals/src/client/shortcuts.ts';
import type { TerminalsState } from '../../packages/plugins/terminals/src/client/index.ts';
import { TerminalViewOwner } from '../../packages/plugins/terminals/src/client/interactions/owner.ts';
import {
  paletteResults,
  rememberPaletteUsage,
  MAX_PALETTE_RESULTS,
  MAX_PALETTE_USAGE,
  PaletteSources,
} from '../../packages/plugins/workspace/src/client/palette-model.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const id = (value: string) => value as ShortcutCommandId;
const context = { region: 'terminal', modal: null, target: null } as const;
const session = terminalSessionSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'local',
  title: 'Existing terminal',
  state: 'ready',
  createdAt: '2026-09-12T00:00:00.000Z',
});
function fixture(language = 'en') {
  const ctx = new Context(),
    locale = new LocaleRuntime(ctx, { languages: [language] }),
    registry = new ShortcutRegistry('desktop', 'macos'),
    workspace = new WorkspaceStore(),
    views = new TerminalViewOwner();
  cleanups.push(
    () => ctx.fiber.dispose(),
    () => locale.dispose(),
    () => workspace.dispose(),
    () => views.dispose(),
  );
  for (const [lang, dict] of Object.entries(dictionaries)) locale.register('shortcuts', lang, dict);
  ctx.provide('locale', locale);
  ctx.provide('shortcuts', registry as unknown as Shortcuts);
  ctx.provide('workspaceUi', workspace);
  ctx.provide('terminalViewUi', views);
  const palette = new PaletteSources();
  ctx.provide('workspacePaletteUi', palette);
  cleanups.push(async () => palette.close());
  let state: TerminalsState = { status: 'error', message: 'PRIVATE_HOST_FAILURE' };
  installTerminalShortcuts(ctx, { getSnapshot: () => state });
  const capture = (): WorkspacePaletteItem[] =>
    registry.catalog
      .getSnapshot()
      .filter((r) => !r.id.endsWith('.alternate'))
      .map((row) => {
        const result = registry.resolveCommand(row.id, context);
        return {
          id: 'shortcut:' + row.id,
          label: row.label,
          aliases: row.aliases,
          group: 'actions',
          shortcuts: row.keys.length ? [row.keys.join('+')] : [],
          unavailableReason: result.status === 'handled' ? undefined : 'unavailable',
          execute: () => {
            if (result.status !== 'handled') throw Error('UNAVAILABLE');
            result.run();
          },
        };
      });
  return {
    ctx,
    locale,
    registry,
    workspace,
    views,
    capture,
    palette,
    setState: (next: TerminalsState) => {
      state = next;
    },
  };
}
it('uses unique owner command identities, accepted overrides and fixed clipboard reservations without reviving the central intent table', () => {
  const f = fixture();
  const items = f.capture();
  expect(new Set(items.map((r) => r.id)).size).toBe(items.length);
  expect(items.find((r) => r.id === 'shortcut:app.newTab')).toMatchObject({
    label: dictionaries.en['shortcuts.action.newLocalTerminal'],
    shortcuts: ['⌥+Q'],
  });
  f.registry.configure({
    ...f.registry.config.getSnapshot(),
    status: 'ready',
    revision: crypto.randomUUID() as ShortcutRevision,
    document: {
      schemaVersion: 2,
      profiles: {
        'desktop:macos': { 'app.newTab': { code: 'KeyN', modifiers: ['meta', 'shift'] } },
      },
    },
  });
  expect(f.capture().find((r) => r.id === 'shortcut:app.newTab')?.shortcuts).toEqual(['⇧+⌘+N']);
  expect(
    f.registry.fixedCatalog
      .getSnapshot()
      .filter((r) => r.group === 'input')
      .map((r) => r.id),
  ).toEqual(['terminal.copy', 'terminal.paste']);
  expect(f.capture().some((r) => r.id === 'shortcut:terminal.copy')).toBe(false);
});
it.each(['en', 'zh-CN', 'zh-TW', 'ja'] as const)(
  'retains all four language aliases while displaying the %s owner label',
  (language) => {
    const f = fixture(language),
      items = f.capture();
    for (const search of ['en', 'zh-CN', 'zh-TW', 'ja'] as const) {
      const result = paletteResults(
        items,
        dictionaries[search]['shortcuts.action.newLocalTerminal'],
        [],
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe('shortcut:app.newTab');
      expect(result.items[0]?.label).toBe(
        dictionaries[language]['shortcuts.action.newLocalTerminal'],
      );
    }
  },
);
it('retains full-width whitespace search, empty results and all200 searchable hosts under the original50 visible ceiling', () => {
  const f = fixture();
  const hosts = Array.from({ length: 200 }, (_, index): WorkspacePaletteItem => ({
    id: `host:host-${index}`,
    label: `Lab ${index}`,
    aliases: ['127.0.0.1'],
    group: 'hosts',
    shortcuts: [],
    execute: vi.fn(),
  }));
  const items = [...f.capture(), ...hosts];
  expect(paletteResults(items, 'Ｎｅｗ　local terminal', []).items[0]?.id).toBe(
    'shortcut:app.newTab',
  );
  expect(paletteResults(items, 'no-such-action', []).total).toBe(0);
  expect(paletteResults(items, '', []).items).toHaveLength(MAX_PALETTE_RESULTS);
  expect(paletteResults(items, 'Lab 199', []).items[0]?.id).toBe('host:host-199');
});
it('retains original201 usage inputs, frequency before recency, no duplicates and only opaque metadata', () => {
  let usage: ReturnType<typeof rememberPaletteUsage> = [];
  for (let index = 0; index < 201; index++) usage = rememberPaletteUsage(usage, `host:${index}`);
  expect(usage).toHaveLength(MAX_PALETTE_USAGE);
  expect(usage[0]?.id).toBe('host:151');
  expect(usage.every((e) => Object.keys(e).sort().join(',') === 'count,id,lastUsed')).toBe(true);
  usage = rememberPaletteUsage([], 'section:files');
  usage = rememberPaletteUsage(usage, 'section:files');
  usage = rememberPaletteUsage(usage, 'transfer-center');
  const rows: WorkspacePaletteItem[] = ['section:files', 'transfer-center'].map((id) => ({
    id,
    label: id === 'section:files' ? 'Lab server' : '127.0.0.1',
    aliases: [],
    group: 'sections',
    shortcuts: [],
    execute: vi.fn(),
  }));
  const result = paletteResults(rows, '', usage);
  expect(result.items.map((r) => r.id)).toEqual(['section:files', 'transfer-center']);
  expect(result.items[0]?.group).toBe('recent');
  expect(result.items.filter((r) => r.id === 'section:files')).toHaveLength(1);
  expect(JSON.stringify(usage)).not.toContain('Lab server');
  expect(JSON.stringify(usage)).not.toContain('127.0.0.1');
});
it('keeps actual local buffer actions available while disconnected, blocks network input and captures the original owned tab', async () => {
  const f = fixture();
  expect(f.registry.resolveCommand(id('terminal.search'), context).status).toBe('blocked');
  const tab = f.workspace.registerTab(
    { id: '11111111-1111-4111-8111-111111111111', title: 'Existing terminal', kind: 'terminal' },
    async () => {},
  );
  tab.activate();
  const run = vi.fn();
  f.views.register('11111111-1111-4111-8111-111111111111', {
    selectionAvailable: () => false,
    run,
  });
  for (const action of ['terminal.search', 'terminal.clear', 'terminal.showNormalBuffer']) {
    run.mockClear();
    const result = f.registry.resolveCommand(id(action), context);
    expect(result.status).toBe('handled');
    if (result.status === 'handled') result.run();
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
  }
  expect(f.registry.resolveCommand(id('terminal.pasteSelected'), context)).toMatchObject({
    status: 'blocked',
    reason: 'not-ready',
  });
  expect(f.registry.resolveCommand(id('app.newTab'), context)).toMatchObject({
    status: 'blocked',
    reason: 'not-ready',
  });
  expect(JSON.stringify(f.capture())).not.toContain('PRIVATE_HOST_FAILURE');
  const captured = f.registry.resolveCommand(id('terminal.search'), context);
  const other = f.workspace.registerTab(
    { id: 'terminal-b', title: 'Other terminal', kind: 'terminal' },
    async () => {},
  );
  other.activate();
  run.mockClear();
  if (captured.status === 'handled') captured.run();
  await vi.waitFor(() =>
    expect(run).toHaveBeenCalledWith('search', expect.any(AbortSignal), undefined),
  );
});
it('requires selection for sending selected text and refuses a captured network action after generation replacement', () => {
  const f = fixture(),
    generation = crypto.randomUUID();
  f.workspace
    .registerTab(
      { id: '11111111-1111-4111-8111-111111111111', title: 'Existing terminal', kind: 'terminal' },
      async () => {},
    )
    .activate();
  f.setState({
    status: 'ready',
    baseline: { type: 'baseline', revision: 1, generation, sessions: [session] },
  });
  const off = f.views.register('11111111-1111-4111-8111-111111111111', {
    selectionAvailable: () => false,
    run: vi.fn(),
  });
  expect(f.registry.resolveCommand(id('terminal.pasteSelected'), context)).toMatchObject({
    status: 'blocked',
    reason: 'no-selection',
  });
  off();
  const run = vi.fn();
  f.views.register('11111111-1111-4111-8111-111111111111', { selectionAvailable: () => true, run });
  const result = f.registry.resolveCommand(id('terminal.pasteSelected'), context);
  expect(result.status).toBe('handled');
  f.setState({
    status: 'ready',
    baseline: {
      type: 'baseline',
      revision: 1,
      generation: crypto.randomUUID(),
      sessions: [session],
    },
  });
  if (result.status === 'handled') result.run();
  expect(run).not.toHaveBeenCalled();
});
it('leaves external explicit aliases unchanged without a shared key and deduplicates explicit translations', () => {
  const command = {
    id: id('external.test'),
    label: () => 'Custom',
    aliases: ['external alias'],
    defaults: {},
    regions: ['page'] as const,
    modals: [],
    resolve: () => ({ status: 'pass' }) as const,
  };
  expect(localizedShortcut(command)).toBe(command);
  const enriched = localizedShortcut({
    ...command,
    messageKey: 'shortcuts.action.newLocalTerminal',
    aliases: [dictionaries.en['shortcuts.action.newLocalTerminal']],
  });
  expect(enriched.aliases).toHaveLength(4);
  expect(command.aliases).toEqual(['external alias']);
});
it('retains actual terminal platform defaults and sparse clear/reset overrides with the fixed copy input unchanged', () => {
  const f = fixture();
  const definitions = f.registry.definitions(),
    clear = definitions.find((r) => r.id === 'terminal.clear')!,
    alternate = definitions.find((r) => r.id === 'terminal.clear.alternate')!;
  expect(clear.defaults['desktop:macos']).toEqual({ code: 'KeyL', modifiers: ['meta'] });
  expect(clear.defaults['desktop:windows']).toEqual({ code: 'KeyL', modifiers: ['control'] });
  expect(clear.defaults['desktop:linux']).toEqual({ code: 'KeyL', modifiers: ['control'] });
  expect(alternate.defaults['desktop:linux']).toEqual({
    code: 'KeyL',
    modifiers: ['control', 'shift'],
  });
  const fixed = f.registry.fixedCatalog.getSnapshot().find((r) => r.id === 'terminal.copy');
  expect(fixed?.bindings).toEqual([{ code: 'KeyC', modifiers: ['meta'] }]);
  for (const binding of [{ code: 'KeyJ', modifiers: ['alt'] as const }, null]) {
    f.registry.configure({
      ...f.registry.config.getSnapshot(),
      revision: crypto.randomUUID() as ShortcutRevision,
      document: { schemaVersion: 2, profiles: { 'desktop:macos': { 'terminal.clear': binding } } },
    });
    expect(
      f.registry.catalog.getSnapshot().find((r) => r.id === 'terminal.clear')?.binding,
    ).toEqual(binding);
    expect(
      f.registry.fixedCatalog.getSnapshot().find((r) => r.id === 'terminal.copy')?.bindings,
    ).toEqual(fixed?.bindings);
  }
  f.registry.configure({
    ...f.registry.config.getSnapshot(),
    revision: crypto.randomUUID() as ShortcutRevision,
    document: { schemaVersion: 2, profiles: {} },
  });
  expect(f.registry.catalog.getSnapshot().find((r) => r.id === 'terminal.clear')?.binding).toEqual({
    code: 'KeyL',
    modifiers: ['meta'],
  });
});

it('retains read-only clipboard palette actions and live selection availability while offline without admitting paste', async () => {
  const f = fixture();
  const registration = f.workspace.registerTab(
    { id: session.id, title: 'Existing terminal', kind: 'terminal' },
    async () => {},
  );
  registration.activate();
  const run = vi.fn(),
    off = f.views.register(session.id, { selectionAvailable: () => false, run });
  await vi.waitFor(() => expect(f.palette.capture()).toHaveLength(2));
  let rows = f.palette.capture();
  expect(rows.find((row) => row.id.endsWith(':copy'))?.unavailableReason).toBeDefined();
  expect(rows.find((row) => row.id.endsWith(':paste'))?.unavailableReason).toBeDefined();
  off();
  f.views.register(session.id, { selectionAvailable: () => true, run });
  rows = f.palette.capture();
  const copy = rows.find((row) => row.id.endsWith(':copy'))!;
  expect(copy.unavailableReason).toBeUndefined();
  for (const language of ['en', 'zh-CN', 'zh-TW', 'ja'] as const)
    expect(
      paletteResults(rows, dictionaries[language]['shortcuts.action.copySelection'], []).items[0]
        ?.id,
    ).toBe(copy.id);
  await copy.execute();
  expect(run).toHaveBeenCalledWith('copy', expect.any(AbortSignal), undefined);
  expect(rows.find((row) => row.id.endsWith(':paste'))?.unavailableReason).toBeDefined();
  f.setState({
    status: 'ready',
    baseline: {
      type: 'baseline',
      generation: crypto.randomUUID(),
      revision: 1,
      sessions: [session],
    },
  });
  rows = f.palette.capture();
  const paste = rows.find((row) => row.id.endsWith(':paste'))!;
  expect(paste.unavailableReason).toBeUndefined();
  f.setState({ status: 'error', message: 'PRIVATE_HOST_FAILURE' });
  await expect(paste.execute()).rejects.toThrow('RETIRED');
  expect(run).toHaveBeenCalledOnce();
});
