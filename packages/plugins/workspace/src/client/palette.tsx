import { useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { WorkspacePaletteItem, WorkspaceUi } from '@axterm/ui/workspace';
import type { ShortcutCommandId } from '@axterm/plugin-api/shortcuts';
import type { ShortcutContext } from '@axterm/ui/shortcuts';
import { presentBinding } from '@axterm/plugin-api/shortcuts';
import { CommandPalette } from './command-palette.tsx';
import { paletteDictionaries } from './palette-locales.ts';
import { PaletteSources, rememberPaletteUsage, type PaletteUsage } from './palette-model.ts';
import { cssText } from './palette.module.css';

export function installPalette(ctx: Context, workspace: WorkspaceUi): void {
  const sources = new PaletteSources(),
    listeners = new Set<() => void>();
  let items: readonly WorkspacePaletteItem[] | undefined,
    usage: PaletteUsage[] = [],
    closed = false;
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const dismiss = () => {
    items = undefined;
    publish();
  };
  ctx.provide('workspacePaletteUi', sources);
  ctx.effect(() => ctx.locale.register('palette', paletteDictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-workspace/palette';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  const text = ctx.locale.bind('palette');
  const capture = (context: ShortcutContext) => {
    const snapshot = workspace.getSnapshot();
    const commands: WorkspacePaletteItem[] = ctx.shortcuts.catalog
      .getSnapshot()
      .filter((row) => !row.id.endsWith('.alternate'))
      .map((row) => {
        const resolution = ctx.shortcuts.resolveCommand(row.id, context);
        return {
          id: `shortcut:${row.id}`,
          label: row.label,
          aliases: row.aliases,
          group: row.id.startsWith('terminal.') ? 'terminal' : 'actions',
          shortcuts: row.keys.length ? [row.keys.join('+')] : [],
          unavailableReason:
            resolution.status === 'handled' ? undefined : text('palette.actionUnavailable'),
          execute: () => {
            if (resolution.status !== 'handled') throw Error('PALETTE_UNAVAILABLE');
            resolution.run();
          },
        };
      });
    return [
      ...commands,
      ...snapshot.navigation.map((item) => ({
        id: `section:${item.id}`,
        label: text('app.openNamedWorkspace', { name: ctx.locale.resolveText(item.label) }),
        aliases: typeof item.label === 'string' ? [item.label] : Object.values(item.label),
        group: 'sections' as const,
        shortcuts: [],
        execute: () => {
          if (!workspace.getSnapshot().navigation.some((current) => current.id === item.id))
            throw Error('PALETTE_TARGET_RETIRED');
          workspace.selectSection(item.id);
          if (item.action) return workspace.invokeAction(item.action);
        },
      })),
      ...snapshot.tabs.map((tab) => ({
        id: `session:${tab.id}`,
        label: text('palette.switchSession', { name: tab.title }),
        aliases: [tab.title],
        group: 'sessions' as const,
        shortcuts: [],
        execute: () => {
          if (!workspace.getSnapshot().tabs.some((current) => current.id === tab.id))
            throw Error('PALETTE_TARGET_RETIRED');
          workspace.selectTab(tab.id);
        },
      })),
      ...sources.capture(),
    ];
  };
  const primary = ctx.shortcuts.platform === 'macos' ? 'meta' : 'control';
  for (const [code, key] of [
    ['KeyK', 'shortcuts.commandPalette'],
    ['KeyB', 'shortcuts.toggleSidebar'],
  ] as const) {
    const binding = { code, modifiers: [primary] } as const;
    ctx.effect(() =>
      ctx.shortcuts.registerFixed({
        id: `workspace.${code}` as ShortcutCommandId,
        label: () => text(key),
        keys: presentBinding(binding, ctx.shortcuts.platform).keys,
        bindings: [binding],
        group: 'application',
      }),
    );
  }
  ctx.effect(() =>
    ctx.shortcuts.observeFixedInput((input) => {
      if (input.type !== 'keydown') return;
      const g = input.gesture;
      if (
        g.defaultPrevented ||
        g.composing ||
        g.repeat ||
        g.secondCode ||
        g.alt ||
        g.shift ||
        g.control !== (primary === 'control') ||
        g.meta !== (primary === 'meta') ||
        !['KeyK', 'KeyB'].includes(g.code)
      )
        return;
      if (input.context.modal !== null && !items) return;
      input.consume();
      if (g.code === 'KeyB') {
        if (!items) workspace.toggleSidebar();
        return;
      }
      if (items) dismiss();
      else {
        items = capture(input.context);
        publish();
      }
    }),
  );
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      { name: 'workspace.overlay', id: 'workspace.palette', order: 90, locale: 'palette' },
      function Palette({ t }: PropsLocale<'palette'>) {
        const current = useSyncExternalStore(
          (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          () => items,
        );
        return current ? (
          <CommandPalette
            items={current}
            usage={usage}
            x={t}
            onClose={dismiss}
            onExecute={async (item) => {
              if (closed || item.unavailableReason) return false;
              try {
                await item.execute();
                usage = rememberPaletteUsage(usage, item.id);
                return true;
              } catch {
                return false;
              }
            }}
          />
        ) : null;
      },
    );
  });
  ctx.effect(() => () => {
    closed = true;
    items = undefined;
    usage = [];
    sources.close();
    listeners.clear();
  });
}
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    palette: keyof typeof paletteDictionaries.en;
  }
}
