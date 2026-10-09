import type { ShortcutActionId, ShortcutBindings } from '@workspace/contracts';
import type { WorkspaceSection } from '../../stores/workspace';
import { translateAxterm, type AxtermMessageKey, type Variables } from '../../i18n/core';
import {
  SHORTCUT_ACTIONS,
  effectiveShortcutBindings,
  type ShortcutPlatform,
} from '../shortcuts/shortcut-registry';

export const MAX_PALETTE_RESULTS = 50;
export const MAX_PALETTE_USAGE = 50;

export interface ShortcutContext {
  runtimeReady: boolean;
  activeTabKind?: string | undefined;
  tabCount: number;
  hasTerminalView: boolean;
  terminalConnected: boolean;
  hasSelection: boolean;
  sshConnected: boolean;
  hasSftpPath: boolean;
}

export type PaletteIntent =
  | { kind: 'shortcut'; action: ShortcutActionId }
  | { kind: 'section'; section: WorkspaceSection }
  | { kind: 'transfer-center' }
  | { kind: 'host'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'workspace'; id: string };

export type PaletteGroup =
  'recent' | 'actions' | 'terminal' | 'sections' | 'sessions' | 'hosts' | 'workspaces';
export interface PaletteItem {
  id: string;
  label: string;
  aliases: readonly string[];
  group: PaletteGroup;
  shortcuts: readonly string[];
  unavailableReason?: AxtermMessageKey | undefined;
  intent: PaletteIntent;
}
export interface PaletteUsage {
  id: string;
  count: number;
  lastUsed: number;
}

type Translate = (key: AxtermMessageKey, variables?: Variables) => string;
export interface PaletteInput {
  x: Translate;
  platform: ShortcutPlatform;
  bindings?: ShortcutBindings | undefined;
  context: ShortcutContext;
  sections: readonly { id: WorkspaceSection; messageKey: AxtermMessageKey }[];
  hosts: readonly { id: string; name: string; hostname: string }[];
  sessions: readonly { id: string; title: string }[];
  workspaces: readonly { id: string; name: string }[];
}

/** Shared by palette availability and keyboard dispatch; no Runtime objects cross this model. */
export function shortcutUnavailableReason(
  action: ShortcutActionId,
  context: ShortcutContext,
): AxtermMessageKey | undefined {
  if (action === 'app_mouseWheelDownCloseTab') return 'palette.actionUnavailable';
  if (action === 'app_prevTab' || action === 'app_nextTab')
    return context.tabCount > 1 ? undefined : 'palette.requiresSession';
  if (action === 'app_newBookmark' || action === 'app_toggleAddBtn') return undefined;
  if (action.startsWith('terminal_') && action !== 'terminal_syncSftpPath') {
    if (!context.hasTerminalView) return 'palette.requiresSession';
    if (
      (action === 'terminal_copy' || action === 'terminal_pasteSelected') &&
      !context.hasSelection
    )
      return 'palette.requiresSelection';
    if (action === 'terminal_paste' || action === 'terminal_pasteSelected') {
      if (!context.runtimeReady) return 'palette.runtimeUnavailable';
      if (!context.terminalConnected) return 'palette.requiresSession';
    }
    return undefined;
  }
  if (!context.runtimeReady) return 'palette.runtimeUnavailable';
  if (action === 'app_reloadAll') return context.tabCount ? undefined : 'palette.requiresSession';
  if (
    [
      'app_closeCurrentTab',
      'app_reloadCurrentTab',
      'app_cloneToNextLayout',
      'app_duplicateTab',
    ].includes(action)
  )
    return context.activeTabKind ? undefined : 'palette.requiresSession';
  if (action === 'terminal_syncSftpPath') {
    if (context.activeTabKind !== 'ssh' || !context.sshConnected) return 'palette.requiresSsh';
    return context.hasSftpPath ? undefined : 'app.sftpPathUnavailable';
  }
  return undefined;
}

const SEARCH_LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ja'] as const;
function aliases(key: AxtermMessageKey): string[] {
  return SEARCH_LANGUAGES.map((language) => translateAxterm(language, key));
}

export function buildPaletteItems(input: PaletteInput): PaletteItem[] {
  const { x, context } = input;
  const items: PaletteItem[] = SHORTCUT_ACTIONS
    // The fixed middle-click gesture has no executable command; keep its binding in Settings.
    .filter(({ id }) => id !== 'app_mouseWheelDownCloseTab')
    .map((definition): PaletteItem => ({
      id: `shortcut:${definition.id}`,
      label: x(definition.labelKey),
      aliases: aliases(definition.labelKey),
      group: definition.scope === 'terminal' ? 'terminal' : 'actions',
      shortcuts: effectiveShortcutBindings(definition, input.bindings, input.platform),
      unavailableReason: shortcutUnavailableReason(definition.id, context),
      intent: { kind: 'shortcut', action: definition.id },
    }));
  items.push(
    ...input.sections.map(({ id, messageKey }): PaletteItem => ({
      id: `section:${id}`,
      label: x('app.openNamedWorkspace', { name: x(messageKey) }),
      aliases: aliases(messageKey),
      group: 'sections',
      shortcuts: [],
      ...(id === 'files' && !context.runtimeReady
        ? { unavailableReason: 'palette.runtimeUnavailable' as const }
        : {}),
      intent: { kind: 'section', section: id },
    })),
    {
      id: 'transfer-center',
      label: x('app.transferCenter'),
      aliases: aliases('app.transferCenter'),
      group: 'sections',
      shortcuts: [],
      intent: { kind: 'transfer-center' },
    },
    ...input.sessions.map((session): PaletteItem => ({
      id: `session:${session.id}`,
      label: x('palette.switchSession', { name: session.title }),
      aliases: [session.title],
      group: 'sessions',
      shortcuts: [],
      intent: { kind: 'session', id: session.id },
    })),
    ...input.hosts.map((host): PaletteItem => ({
      id: `host:${host.id}`,
      label: x('palette.connectHost', { name: host.name, hostname: host.hostname }),
      aliases: [host.name, host.hostname],
      group: 'hosts',
      shortcuts: [],
      ...(!context.runtimeReady
        ? { unavailableReason: 'palette.runtimeUnavailable' as const }
        : {}),
      intent: { kind: 'host', id: host.id },
    })),
    ...input.workspaces.map((workspace): PaletteItem => ({
      id: `workspace:${workspace.id}`,
      label: x('palette.switchWorkspace', { name: workspace.name }),
      aliases: [workspace.name],
      group: 'workspaces',
      shortcuts: [],
      ...(!context.runtimeReady
        ? { unavailableReason: 'palette.runtimeUnavailable' as const }
        : {}),
      intent: { kind: 'workspace', id: workspace.id },
    })),
  );
  return items;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}
const GROUP_ORDER: readonly PaletteGroup[] = [
  'recent',
  'actions',
  'terminal',
  'sections',
  'sessions',
  'hosts',
  'workspaces',
];

export function paletteResults(
  items: readonly PaletteItem[],
  query: string,
  usage: readonly PaletteUsage[],
) {
  const terms = normalize(query).split(/\s+/u).filter(Boolean);
  const usageById = new Map(usage.map((item) => [item.id, item]));
  const matches = items
    .filter((item) => {
      const searchable = normalize([item.label, ...item.aliases].join(' '));
      return terms.every((term) => searchable.includes(term));
    })
    .map((item, index) => ({
      item: !terms.length && usageById.has(item.id) ? { ...item, group: 'recent' as const } : item,
      index,
    }))
    .sort((a, b) => {
      const group = GROUP_ORDER.indexOf(a.item.group) - GROUP_ORDER.indexOf(b.item.group);
      if (group) return group;
      const aUsage = usageById.get(a.item.id);
      const bUsage = usageById.get(b.item.id);
      return (
        (bUsage?.count ?? 0) - (aUsage?.count ?? 0) ||
        (bUsage?.lastUsed ?? 0) - (aUsage?.lastUsed ?? 0) ||
        a.index - b.index
      );
    });
  return {
    total: matches.length,
    items: matches.slice(0, MAX_PALETTE_RESULTS).map(({ item }) => item),
  };
}

/** Keeps only opaque action IDs and bounded usage metadata, never labels, addresses or commands. */
export function rememberPaletteUsage(usage: readonly PaletteUsage[], id: string): PaletteUsage[] {
  const previous = usage.find((item) => item.id === id);
  const lastUsed = Math.max(0, ...usage.map((item) => item.lastUsed)) + 1;
  return [
    ...usage.filter((item) => item.id !== id),
    { id, count: Math.min(1_000_000, (previous?.count ?? 0) + 1), lastUsed },
  ]
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(-MAX_PALETTE_USAGE);
}
