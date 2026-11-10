import { expect, it, vi } from 'vitest';
import {
  PaletteSources,
  paletteResults,
  rememberPaletteUsage,
} from '../../packages/plugins/workspace/src/client/palette-model.ts';
import { ShortcutRegistry } from '../../packages/infra/shortcuts/src/client/registry.ts';
import type { WorkspacePaletteItem } from '@axterm/ui/workspace';
import type { ShortcutCommandId } from '@axterm/plugin-api/shortcuts';
const item = (id: string): WorkspacePaletteItem => ({
  id,
  label: `Session ${id}`,
  aliases: ['終端', '终端'],
  group: 'sessions',
  shortcuts: [],
  execute: vi.fn(),
});
it('retains normalized multilingual AND search, stable bounded ranking and opaque usage only', () => {
  const items = Array.from({ length: 70 }, (_, i) => item(String(i)));
  expect(paletteResults(items, '終端 Ｓｅｓｓｉｏｎ', []).total).toBe(70);
  expect(paletteResults(items, '', []).items).toHaveLength(50);
  let usage = [] as ReturnType<typeof rememberPaletteUsage>;
  for (const row of items) usage = rememberPaletteUsage(usage, row.id);
  expect(usage).toHaveLength(50);
  usage = rememberPaletteUsage(usage, '65');
  expect(paletteResults(items, '', usage).items[0]?.id).toBe('65');
  expect(usage.every((row) => Object.keys(row).sort().join() === 'count,id,lastUsed')).toBe(true);
});
it('captures source items once and revokes captured invocations when their owner retires', () => {
  const sources = new PaletteSources(),
    execute = vi.fn();
  const source = vi.fn(() => [{ ...item('target'), execute }]);
  const off = sources.registerSource('catalog', source),
    captured = sources.capture()[0]!;
  captured.execute();
  expect(execute).toHaveBeenCalledOnce();
  expect(source).toHaveBeenCalledOnce();
  expect(() => sources.registerSource('catalog', source)).toThrow();
  off();
  off();
  expect(() => captured.execute()).toThrow('RETIRED');
  sources.registerSource('catalog', source);
  expect(() => captured.execute()).toThrow('RETIRED');
  sources.close();
  expect(() => sources.capture()).toThrow('CLOSED');
});
it('resolves DSH menu targets before opening the dialog and revokes them on command unload', () => {
  const registry = new ShortcutRegistry('desktop', 'macos'),
    id = 'test.capture' as ShortcutCommandId;
  let target = 'a';
  const run = vi.fn();
  const off = registry.register({
    id,
    label: () => 'Capture',
    aliases: [],
    defaults: {},
    regions: ['page'],
    modals: [],
    resolve: () => {
      const captured = target;
      return { status: 'handled', run: () => run(captured) };
    },
  });
  const resolution = registry.resolveCommand(id, { region: 'page', modal: null, target: null });
  target = 'b';
  if (resolution.status !== 'handled') throw Error('not captured');
  resolution.run();
  expect(run).toHaveBeenCalledWith('a');
  expect(registry.resolveCommand(id, { region: 'page', modal: 'other', target: null }).status).toBe(
    'pass',
  );
  off();
  expect(() => resolution.run()).toThrow('RETIRED');
});
