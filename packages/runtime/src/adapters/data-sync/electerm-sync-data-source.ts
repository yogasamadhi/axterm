import { hostname } from 'node:os';
import {
  DEFAULT_TERMINAL_THEME_ID,
  electermDataImportResultSchema,
  electermDataPreviewSchema,
  fileAddressBookmarkSchema,
  namedWorkspaceSchema,
  quickCommandTreeSchema,
  terminalThemeSchema,
  triggerRuleInputSchema,
  type ElectermDataImportResult,
  type ElectermDataPreview,
  type QuickCommandTree,
  type SyncCategory,
  type TerminalTheme,
  type TriggerRuleInput,
} from '@workspace/contracts';
import { etagFor, stableHash, type ProductRepository } from '../sqlite/product-repository';
import type { ElectermDataService } from '../../application/electerm-data-service';
import { ApplicationError } from '../../application/errors';
import type { QuickCommandService } from '../../application/quick-command-service';
import type { TerminalThemeService } from '../../application/terminal-theme-service';
import type { TriggerService } from '../../application/trigger-service';
import type { SyncDataDocument, SyncDataSource } from '../../ports/data-sync';

type RecordValue = Record<string, unknown>;

interface StagedPreview {
  public: ElectermDataPreview;
  expiresAtMs: number;
  baselineHashes: Partial<Record<SyncCategory, string>>;
  terminalThemes?: TerminalTheme[];
  quickCommands?: Pick<QuickCommandTree, 'groups' | 'commands'>;
  quickCommandEtag?: string;
  triggers?: TriggerRuleInput[];
  triggerEtag?: string;
}

const previewTtlMs = 10 * 60_000;

export class ElectermSyncDataSource implements SyncDataSource {
  private readonly previews = new Map<string, StagedPreview>();

  constructor(
    private readonly electermData: ElectermDataService,
    private readonly products: ProductRepository,
    private readonly terminalThemes: TerminalThemeService,
    private readonly quickCommands: QuickCommandService,
    private readonly triggers: TriggerService,
    private readonly appVersion: string,
    private readonly deviceName = hostname().slice(0, 128) || 'unknown',
  ) {}

  async snapshot(categories: readonly SyncCategory[]): Promise<SyncDataDocument> {
    const portable = await this.electermData.portableDocument();
    const settings = this.products.getSettings();
    const quickCommands = this.quickCommands.snapshot();
    const triggers = this.triggers.snapshot();
    return {
      formatVersion: 1,
      deviceName: this.deviceName,
      appVersion: this.appVersion,
      generatedAt: new Date().toISOString(),
      categories: Object.fromEntries(
        categories.map((category) => {
          const value = categoryValue({
            portable,
            settings,
            terminalThemes: this.terminalThemes.list(),
            quickCommands,
            triggers: triggers.triggers,
            category,
            selectedCategories: categories,
          });
          return [
            category,
            { count: categoryCount(category, value), hash: stableHash(value), value },
          ];
        }),
      ),
    };
  }

  async preview(document: SyncDataDocument, categories: readonly SyncCategory[]) {
    this.sweepPreviews();
    const source: RecordValue = {
      _axterm: { formatVersion: 2, credentials: 'omitted' },
    };
    const staged: Omit<StagedPreview, 'public' | 'expiresAtMs'> = { baselineHashes: {} };
    const extraEntries: ElectermDataPreview['entries'] = [];
    const local = await this.snapshot(categories);

    for (const category of categories) {
      const item = document.categories[category];
      if (!item)
        throw new ApplicationError(
          'SYNC_REMOTE_INVALID',
          `Remote sync document has no ${category} category`,
          409,
        );
      const value = asRecord(item.value);
      if (!value)
        throw new ApplicationError(
          'SYNC_REMOTE_INVALID',
          `Remote ${category} category is invalid`,
          409,
        );

      if (category === 'settings' || category === 'bookmarks' || category === 'profiles')
        mergeCategory(source, value);
      else if (category === 'addressBookmarks')
        mergeSettings(source, {
          fileManager: {
            remoteAddressBookmarks: fileAddressBookmarkSchema
              .array()
              .max(64)
              .parse(value.addressBookmarks),
          },
        });
      else if (category === 'workspaces') {
        const workspaces = namedWorkspaceSchema.array().max(20).parse(value.workspaces);
        const activeWorkspaceId =
          typeof value.activeWorkspaceId === 'string' &&
          workspaces.some(({ id }) => id === value.activeWorkspaceId)
            ? value.activeWorkspaceId
            : null;
        mergeSettings(source, { workspace: { namedWorkspaces: workspaces, activeWorkspaceId } });
      } else if (category === 'terminalThemes') {
        staged.terminalThemes = terminalThemeSchema
          .array()
          .max(256)
          .parse(value.terminalThemes)
          .filter(({ builtIn }) => !builtIn);
      } else if (category === 'quickCommands') {
        const parsed = quickCommandTreeSchema.parse({
          revision: 1,
          etag: '"quick-command-tree-v1"',
          groups: value.groups,
          commands: value.commands,
        });
        staged.quickCommands = { groups: parsed.groups, commands: parsed.commands };
        staged.quickCommandEtag = this.quickCommands.snapshot().etag;
      } else if (category === 'triggers') {
        staged.triggers = triggerRuleInputSchema.array().max(256).parse(value.triggers);
        staged.triggerEtag = this.triggers.snapshot().etag;
      }

      if (['terminalThemes', 'quickCommands', 'triggers'].includes(category)) {
        const localItem = local.categories[category];
        if (!localItem)
          throw new ApplicationError(
            'INVALID_STATE',
            `${categoryLabel(category)} is unavailable`,
            409,
          );
        const unchanged = localItem.hash === item.hash;
        staged.baselineHashes[category] = localItem.hash;
        extraEntries.push({
          key: `dataset:${category}`,
          kind: 'settings',
          sourceId: category,
          name: categoryLabel(category),
          action: unchanged ? 'unchanged' : 'create',
          reasons: unchanged
            ? []
            : ['This selected category will replace its local collection after confirmation.'],
          mappedFields: [category],
          omittedFields: [],
        });
      }
    }

    const base = await this.electermData.previewPortableDocument(
      source,
      `Remote sync · ${document.deviceName}`,
    );
    const publicPreview = electermDataPreviewSchema.parse({
      ...base,
      counts: {
        ...base.counts,
        create:
          base.counts.create + extraEntries.filter(({ action }) => action === 'create').length,
        unchanged:
          base.counts.unchanged +
          extraEntries.filter(({ action }) => action === 'unchanged').length,
        quickCommands: staged.quickCommands?.commands.length ?? base.counts.quickCommands,
      },
      entries: [...base.entries, ...extraEntries],
    });
    this.previews.set(publicPreview.previewId, {
      ...staged,
      public: publicPreview,
      expiresAtMs: Date.now() + previewTtlMs,
    });
    return publicPreview;
  }

  async commit(previewId: string, treeEtag: string): Promise<ElectermDataImportResult> {
    this.sweepPreviews();
    const preview = this.previews.get(previewId);
    if (!preview)
      throw new ApplicationError('NOT_FOUND', 'Sync data preview expired or was canceled', 404);
    await this.assertExtraCategoriesUnchanged(preview);

    const result = await this.electermData.commit(previewId, treeEtag);
    if (preview.terminalThemes) this.terminalThemes.replacePortable(preview.terminalThemes);
    if (preview.quickCommands)
      this.quickCommands.replacePortable(preview.quickCommands, preview.quickCommandEtag);
    if (preview.triggers) this.triggers.replace(preview.triggers, preview.triggerEtag);
    this.ensureSelectedTerminalThemeExists();
    this.previews.delete(previewId);
    return electermDataImportResultSchema.parse({ ...result, counts: preview.public.counts });
  }

  getPreview(previewId: string): ElectermDataPreview | null {
    this.sweepPreviews();
    const preview = this.previews.get(previewId)?.public;
    return preview ? structuredClone(preview) : null;
  }

  cancel(previewId: string): void {
    this.previews.delete(previewId);
    this.electermData.cancel(previewId);
  }

  close(): void {
    for (const previewId of this.previews.keys()) this.electermData.cancel(previewId);
    this.previews.clear();
  }

  private async assertExtraCategoriesUnchanged(preview: StagedPreview): Promise<void> {
    const categories = Object.keys(preview.baselineHashes) as SyncCategory[];
    if (!categories.length) return;
    const current = await this.snapshot(categories);
    for (const category of categories)
      if (current.categories[category]?.hash !== preview.baselineHashes[category])
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          `${categoryLabel(category)} changed after the sync preview`,
          412,
        );
  }

  private ensureSelectedTerminalThemeExists(): void {
    const settings = this.products.getSettings();
    const themeId = settings.terminal.visual.themeId;
    if (this.terminalThemes.list().some(({ id }) => id === themeId)) return;
    this.products.updateSettings(
      { terminal: { visual: { ...settings.terminal.visual, themeId: DEFAULT_TERMINAL_THEME_ID } } },
      etagFor(settings.version),
    );
  }

  private sweepPreviews(): void {
    const now = Date.now();
    for (const [previewId, preview] of this.previews)
      if (preview.expiresAtMs <= now) this.cancel(previewId);
    while (this.previews.size >= 8) this.cancel(this.previews.keys().next().value!);
  }
}

function categoryValue(input: {
  portable: RecordValue;
  settings: ReturnType<ProductRepository['getSettings']>;
  terminalThemes: TerminalTheme[];
  quickCommands: QuickCommandTree;
  triggers: ReturnType<TriggerService['snapshot']>['triggers'];
  category: SyncCategory;
  selectedCategories: readonly SyncCategory[];
}): RecordValue {
  const { portable: source, category } = input;
  if (category === 'settings') {
    const axterm = asRecord(source._axterm) ?? {};
    const settings = structuredClone(asRecord(axterm.settings) ?? {});
    if (input.selectedCategories.includes('terminalThemes')) {
      const terminal = asRecord(settings.terminal) ?? {};
      const visual = asRecord(terminal.visual) ?? {};
      visual.themeId = input.settings.terminal.visual.themeId;
      terminal.visual = visual;
      settings.terminal = terminal;
    }
    return {
      config: source.config ?? {},
      _axterm: {
        formatVersion: axterm.formatVersion ?? 2,
        credentials: 'omitted',
        settings,
        desktopPreferences: axterm.desktopPreferences ?? {},
      },
    };
  }
  if (category === 'bookmarks')
    return { bookmarks: source.bookmarks ?? [], bookmarkGroups: source.bookmarkGroups ?? [] };
  if (category === 'profiles') return { profiles: source.profiles ?? [] };
  if (category === 'terminalThemes')
    return { terminalThemes: input.terminalThemes.filter(({ builtIn }) => !builtIn) };
  if (category === 'quickCommands')
    return { groups: input.quickCommands.groups, commands: input.quickCommands.commands };
  if (category === 'addressBookmarks')
    return { addressBookmarks: input.settings.fileManager.remoteAddressBookmarks };
  if (category === 'workspaces')
    return {
      workspaces: input.settings.workspace.namedWorkspaces,
      activeWorkspaceId: input.settings.workspace.activeWorkspaceId,
    };
  return {
    triggers: input.triggers.map(
      ({ name, enabled, match, action, sendEnter, mode, cooldownMs }) => ({
        name,
        enabled,
        match,
        action,
        sendEnter,
        mode,
        cooldownMs,
      }),
    ),
  };
}

function categoryCount(category: SyncCategory, value: RecordValue): number {
  if (category === 'bookmarks')
    return arrayLength(value.bookmarks) + arrayLength(value.bookmarkGroups);
  if (category === 'quickCommands') return arrayLength(value.groups) + arrayLength(value.commands);
  if (category === 'workspaces') return arrayLength(value.workspaces);
  if (category === 'addressBookmarks') return arrayLength(value.addressBookmarks);
  if (category === 'terminalThemes') return arrayLength(value.terminalThemes);
  if (category === 'triggers') return arrayLength(value.triggers);
  if (category === 'profiles') return arrayLength(value.profiles);
  return Object.keys(value).length ? 1 : 0;
}

function mergeCategory(target: RecordValue, value: RecordValue): void {
  for (const [key, item] of Object.entries(value)) {
    if (key === '_axterm') {
      const destination = asRecord(target._axterm) ?? {};
      deepMerge(destination, asRecord(item) ?? {});
      target._axterm = destination;
    } else target[key] = item;
  }
}

function mergeSettings(target: RecordValue, patch: RecordValue): void {
  const axterm = asRecord(target._axterm) ?? {};
  const settings = asRecord(axterm.settings) ?? {};
  deepMerge(settings, patch);
  axterm.settings = settings;
  target._axterm = axterm;
}

function deepMerge(target: RecordValue, source: RecordValue): void {
  for (const [key, value] of Object.entries(source)) {
    const child = asRecord(value);
    if (child) {
      const destination = asRecord(target[key]) ?? {};
      deepMerge(destination, child);
      target[key] = destination;
    } else target[key] = value;
  }
}

function categoryLabel(category: SyncCategory): string {
  return (
    {
      settings: 'Settings',
      bookmarks: 'Bookmarks',
      terminalThemes: 'Terminal themes',
      quickCommands: 'Quick Commands',
      profiles: 'Connection Profiles',
      addressBookmarks: 'File address bookmarks',
      workspaces: 'Named workspaces',
      triggers: 'Automation triggers',
    } satisfies Record<SyncCategory, string>
  )[category];
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
