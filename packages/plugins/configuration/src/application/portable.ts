// Axterm first-party workflow migrated from the frozen generation-2 implementation (ADR-068).
import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_GLOBAL_PROXY,
  DEFAULT_HOST_PROXY,
  tunnelProfileInputSchema,
} from '@axterm/plugin-api/connections';
import {
  DEFAULT_TERMINAL_BACKGROUND,
  terminalThemeInputSchema,
} from '@axterm/plugin-api/terminals';
import {
  connectionProfileInputSchema,
  createBookmarkGroupSchema,
  createBookmarkSchema,
  createHostSchema,
} from '@axterm/plugin-api/catalog';
import {
  quickCommandGroupInputSchema,
  quickCommandInputSchema,
  triggerRuleInputSchema,
} from '@axterm/plugin-api/automation';
import type { Settings, UpdateSettingsInput } from '@axterm/plugin-api/configuration';
import {
  axtermConfigurationDocumentSchema,
  axtermConfigurationExportResultSchema,
  axtermConfigurationImportResultSchema,
  axtermConfigurationInspectResultSchema,
  axtermConfigurationPreviewSchema,
  type AxtermConfigurationDocument,
  type AxtermConfigurationExportResult,
  type AxtermConfigurationImportResult,
  type AxtermConfigurationInspectResult,
  type AxtermConfigurationPreview,
} from '@axterm/plugin-api/configuration-portable';
import type {
  PortableStore,
  PortableFacts,
  PortableBookmarks,
  PortableProfiles,
  PortableQuickCommands,
  PortableThemes,
  PortableTriggers,
  PortableFiles,
} from '../ports/portable.ts';
import { PortableApplicationError as ApplicationError } from './portable-errors.ts';
import { inspectConfigurationGraph } from './portable-inspection.ts';
const etagFor = (version: number) => '"v' + version + '"';
const maximumExportBytes = 16 * 1024 * 1024;
const maximumPendingPreviews = 4;
const previewLifetimeMs = 10 * 60 * 1_000;
const excludedCollections = [
  'vault-secret-values',
  'terminal-output-history',
  'connection-history',
  'command-history',
  'known-host-trust',
  'ai-history',
  'sync-profiles',
  'background-image-bytes',
] as const;

const importCollectionNames = [
  'hostGroups',
  'hosts',
  'bookmarkGroups',
  'bookmarks',
  'connectionProfiles',
  'terminalProfiles',
  'tunnelProfiles',
  'quickCommandGroups',
  'quickCommands',
  'terminalThemes',
  'triggers',
] as const;

type ImportCollection = (typeof importCollectionNames)[number];
type ImportAction = 'create' | 'unchanged' | 'conflict';
type ImportCounts = AxtermConfigurationPreview['counts'];
type PendingPreview = {
  id: string;
  document: AxtermConfigurationDocument;
  sha256: string;
  applySettings: boolean;
  targetFingerprint: string;
  expiresAt: string;
  actions: Map<string, ImportAction>;
  targets: Map<string, string>;
  result: AxtermConfigurationPreview;
};
type ImportRow = { id: string };

export class ConfigurationPortableApplication {
  private readonly pendingPreviews = new Map<string, PendingPreview>();

  private open = true;
  constructor(
    private readonly work: PortableStore,
    private readonly products: PortableFacts,
    private readonly bookmarks: PortableBookmarks,
    private readonly profiles: PortableProfiles,
    private readonly quickCommands: PortableQuickCommands,
    private readonly themes: PortableThemes,
    private readonly triggers: PortableTriggers,
    private readonly files: PortableFiles | undefined,
    private readonly appVersion: string,
  ) {}
  listPreviews(): AxtermConfigurationPreview[] {
    this.assertOpen();
    this.prunePreviews();
    return [...this.pendingPreviews.values()].map((value) => structuredClone(value.result));
  }
  close(): void {
    this.open = false;
    this.pendingPreviews.clear();
  }
  private assertOpen(): void {
    if (!this.open) throw new ApplicationError('CLOSED', 'Configuration import is closed');
  }

  snapshot(): AxtermConfigurationDocument {
    this.assertOpen();
    const omissions: string[] = [];
    const bookmarks = this.bookmarks.snapshot();
    const commands = this.quickCommands.snapshot();
    const data = {
      hostGroups: this.products.listHostGroups(),
      hosts: this.products.listHosts().map((host, index) => {
        const portable = redactCredentialRefs(host, `data.hosts[${index}]`, omissions);
        if (host.proxy.mode === 'custom' && host.proxy.endpoint.credentialRef) {
          omissions.push(`data.hosts[${index}].proxy`);
          portable.proxy = DEFAULT_HOST_PROXY;
        }
        return portable;
      }),
      bookmarkGroups: bookmarks.groups,
      bookmarks: bookmarks.bookmarks.map((bookmark, index) =>
        redactCredentialRefs(bookmark, `data.bookmarks[${index}]`, omissions),
      ),
      connectionProfiles: this.profiles
        .list()
        .map((profile, index) =>
          redactCredentialRefs(profile, `data.connectionProfiles[${index}]`, omissions),
        ),
      terminalProfiles: this.products.listTerminalProfiles(),
      tunnelProfiles: this.products.listTunnelProfiles(),
      quickCommandGroups: commands.groups,
      quickCommands: commands.commands,
      terminalThemes: this.themes.list().filter(({ builtIn }) => !builtIn),
      triggers: this.triggers.snapshot().triggers,
      settings: (() => {
        const source = this.products.getSettings();
        const settings = redactCredentialRefs(source, 'data.settings', omissions);
        if (source.network.proxy.mode === 'custom' && source.network.proxy.endpoint.credentialRef) {
          omissions.push('data.settings.network.proxy');
          settings.network.proxy = DEFAULT_GLOBAL_PROXY;
        }
        const {
          importRevision: _importRevision,
          presentations: _presentations,
          ...workspace
        } = settings.workspace;
        return removeImageBackgrounds({ ...settings, workspace }, 'data.settings', omissions);
      })(),
    };
    return axtermConfigurationDocumentSchema.parse({
      format: 'axterm-configuration',
      formatVersion: 1,
      appVersion: this.appVersion,
      exportedAt: new Date().toISOString(),
      vaultSecretValues: 'omitted',
      data,
      omissions: {
        fields: omissions,
        excludedCollections: [...excludedCollections],
      },
    });
  }

  async export(grantId: string, signal?: AbortSignal): Promise<AxtermConfigurationExportResult> {
    this.assertOpen();
    if (!this.files)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File capability is unavailable', 503);
    const document = this.snapshot();
    const contents = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    if (contents.length > maximumExportBytes)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Axterm configuration exceeds 16 MiB', 413);
    try {
      await this.files.write(grantId, contents, signal);
    } catch {
      throw new ApplicationError(
        'AXTERM_CONFIGURATION_WRITE_FAILED',
        'Could not save Axterm configuration',
        409,
      );
    }
    const { settings: _settings, ...collections } = document.data;
    return axtermConfigurationExportResultSchema.parse({
      bytes: contents.length,
      sha256: createHash('sha256').update(contents).digest('hex'),
      entityCount: Object.values(collections).reduce(
        (count, collection) => count + collection.length,
        0,
      ),
      omittedFieldCount: document.omissions.fields.length,
    });
  }

  exportContents(): Uint8Array {
    this.assertOpen();
    const bytes = Buffer.from(JSON.stringify(this.snapshot()) + '\n');
    if (bytes.length > maximumExportBytes)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Configuration exceeds 16 MiB', 413);
    return bytes;
  }
  inspectContents(contents: Uint8Array): AxtermConfigurationInspectResult {
    const { source, bytes, sha256 } = this.decodeContents(contents);
    return axtermConfigurationInspectResultSchema.parse({
      appVersion: source.appVersion,
      exportedAt: source.exportedAt,
      bytes,
      sha256,
      ...inspectConfigurationGraph(source, this.snapshot()),
    });
  }
  previewContents(contents: Uint8Array, applySettings: boolean): AxtermConfigurationPreview {
    const { source, bytes, sha256 } = this.decodeContents(contents);
    return this.previewDocumentSource(source, bytes, sha256, applySettings);
  }
  async inspect(grantId: string, signal?: AbortSignal): Promise<AxtermConfigurationInspectResult> {
    const { source, bytes, sha256 } = await this.readConfiguration(grantId, signal);
    const report = inspectConfigurationGraph(source, this.snapshot());
    return axtermConfigurationInspectResultSchema.parse({
      appVersion: source.appVersion,
      exportedAt: source.exportedAt,
      bytes,
      sha256,
      ...report,
    });
  }

  async preview(
    grantId: string,
    applySettings = false,
    signal?: AbortSignal,
  ): Promise<AxtermConfigurationPreview> {
    const { source, bytes, sha256 } = await this.readConfiguration(grantId, signal);
    return this.previewDocumentSource(source, bytes, sha256, applySettings);
  }

  previewDocument(
    document: AxtermConfigurationDocument,
    applySettings = false,
  ): AxtermConfigurationPreview {
    let source: AxtermConfigurationDocument;
    try {
      source = axtermConfigurationDocumentSchema.parse(document);
    } catch {
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid Axterm configuration document', 400);
    }
    const contents = Buffer.from(JSON.stringify(source), 'utf8');
    if (!contents.length || contents.length > maximumExportBytes)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Axterm configuration exceeds 16 MiB', 413);
    return this.previewDocumentSource(
      source,
      contents.length,
      createHash('sha256').update(contents).digest('hex'),
      applySettings,
    );
  }

  private previewDocumentSource(
    source: AxtermConfigurationDocument,
    bytes: number,
    sha256: string,
    applySettings: boolean,
  ): AxtermConfigurationPreview {
    this.assertOpen();
    this.prunePreviews();
    if (this.pendingPreviews.size >= maximumPendingPreviews)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'At most four Axterm configuration previews may be pending',
        409,
      );
    const target = this.snapshot();
    const report = inspectConfigurationGraph(source, target);
    const actions = new Map<string, ImportAction>();
    const targets = new Map<string, string>();
    const issues = [...report.issues];
    let issueCount = report.issueCount;
    const addIssue = (path: string): void => {
      issueCount += 1;
      if (issues.length < 256) issues.push({ kind: 'target-conflict', path });
    };
    const mappings = new Map(
      this.work.mappings().map((entry) => [entryKey(entry.kind, entry.source_id), entry]),
    );
    for (const collection of importCollectionNames) {
      const targetById = new Map(rowsFor(target, collection).map((row) => [row.id, row]));
      for (const [index, row] of rowsFor(source, collection).entries()) {
        const key = entryKey(collection, row.id);
        const fingerprint = fingerprintFor(row);
        const mapping = mappings.get(key);
        const existing = targetById.get(mapping?.target_id ?? row.id);
        if (mapping && existing && mapping.fingerprint === fingerprint) {
          actions.set(key, 'unchanged');
          targets.set(key, mapping.target_id);
        } else if (mapping && existing) {
          actions.set(key, 'conflict');
          addIssue(`data.${collection}[${index}].id`);
        } else if (!mapping && existing && fingerprintFor(existing) === fingerprint) {
          actions.set(key, 'unchanged');
          targets.set(key, existing.id);
        } else if (existing) {
          actions.set(key, 'conflict');
        } else actions.set(key, 'create');
      }
    }
    const counts = countActions(actions, applySettings);
    const canCommit =
      counts.conflict === 0 &&
      !issues.some((issue) => applySettings || !issue.path.startsWith('data.settings.'));
    const result = axtermConfigurationPreviewSchema.parse({
      previewId: randomUUID(),
      expiresAt: new Date(Date.now() + previewLifetimeMs).toISOString(),
      appVersion: source.appVersion,
      exportedAt: source.exportedAt,
      bytes,
      sha256,
      entityCount: report.entityCount,
      counts,
      settings: applySettings ? 'will-apply' : 'preserved',
      canCommit,
      issues,
      issueCount,
      issuesTruncated: issueCount > issues.length,
    });
    this.pendingPreviews.set(result.previewId, {
      id: result.previewId,
      document: source,
      sha256,
      applySettings,
      targetFingerprint: targetFingerprint(target, applySettings),
      expiresAt: result.expiresAt,
      actions,
      targets,
      result,
    });
    return structuredClone(result);
  }

  cancelPreview(previewId: string): void {
    this.assertOpen();
    this.pendingPreviews.delete(previewId);
  }

  getPreview(previewId: string): AxtermConfigurationPreview | null {
    this.prunePreviews();
    this.assertOpen();
    const result = this.pendingPreviews.get(previewId)?.result;
    return result ? structuredClone(result) : null;
  }

  commit(previewId: string, commandId = previewId): AxtermConfigurationImportResult {
    return this.commitOwned(previewId, (importPreview) =>
      this.work.command(commandId, previewId, importPreview),
    );
  }

  /** A same-owner workflow supplies its receipt and finalization inside the shared transaction. */
  commitOwned<T>(
    previewId: string,
    operation: (importPreview: () => AxtermConfigurationImportResult) => T,
  ): T {
    this.assertOpen();
    const result = this.work.transaction(() =>
      operation(() => {
        this.prunePreviews();
        const preview = this.pendingPreviews.get(previewId);
        if (!preview)
          throw new ApplicationError('ATTACHMENT_EXPIRED', 'Configuration preview expired', 409);
        if (!preview.result.canCommit)
          throw new ApplicationError(
            'CONFLICT',
            'Configuration must be corrected before import',
            409,
          );
        const counts = this.importPreview(preview);
        return axtermConfigurationImportResultSchema.parse({
          previewId,
          entityCount: preview.result.entityCount,
          counts,
          settings: preview.applySettings ? 'applied' : 'preserved',
        });
      }),
    );
    // Retain the preview if facts, receipts or any collaborating owner rolls back.
    this.pendingPreviews.delete(previewId);
    return result;
  }

  private async readConfiguration(
    grantId: string,
    signal?: AbortSignal,
  ): Promise<{
    source: AxtermConfigurationDocument;
    bytes: number;
    sha256: string;
  }> {
    this.assertOpen();
    if (!this.files)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File capability is unavailable', 503);
    const contents = await this.files.read(grantId, signal);
    return this.decodeContents(contents);
  }
  private decodeContents(contents: Uint8Array): {
    source: AxtermConfigurationDocument;
    bytes: number;
    sha256: string;
  } {
    this.assertOpen();
    if (!contents.length || contents.length > maximumExportBytes)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Configuration exceeds 16 MiB', 413);
    let source: AxtermConfigurationDocument;
    try {
      source = axtermConfigurationDocumentSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)) as unknown,
      );
    } catch {
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid Axterm configuration file', 400);
    }
    return {
      source,
      bytes: contents.length,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  }

  private importPreview(preview: PendingPreview): ImportCounts {
    if (this.currentTargetFingerprint(preview.applySettings) !== preview.targetFingerprint)
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Configuration changed; create a new preview before importing',
        412,
      );
    const targets = new Map(preview.targets);
    let created = 0;
    const register = (collection: ImportCollection, source: ImportRow, targetId: string): void => {
      const key = entryKey(collection, source.id);
      targets.set(key, targetId);
      this.work.remember({
        kind: collection,
        source_id: source.id,
        fingerprint: fingerprintFor(source),
        target_id: targetId,
      });
      created += 1;
    };
    const shouldCreate = (collection: ImportCollection, source: ImportRow): boolean =>
      preview.actions.get(entryKey(collection, source.id)) === 'create';
    const targetId = (
      collection: ImportCollection,
      sourceId: string | null | undefined,
    ): string | null => {
      if (!sourceId) return null;
      const target = targets.get(entryKey(collection, sourceId));
      if (!target)
        throw new ApplicationError(
          'INVALID_STATE',
          'Configuration import reference was not resolved during preview',
          409,
        );
      return target;
    };

    for (const group of rowsFor(preview.document, 'hostGroups')) {
      if (!shouldCreate('hostGroups', group)) continue;
      const createdGroup = this.products.createHostGroup({
        name: group.name,
        sortOrder: group.sortOrder,
      });
      register('hostGroups', group, createdGroup.id);
    }
    for (const profile of rowsFor(preview.document, 'connectionProfiles')) {
      if (!shouldCreate('connectionProfiles', profile)) continue;
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        version: _version,
        isDefault: _isDefault,
        ...input
      } = profile;
      const createdProfile = this.profiles.create(
        connectionProfileInputSchema.parse({ ...input, isDefault: false }),
      );
      register('connectionProfiles', profile, createdProfile.id);
    }
    for (const profile of rowsFor(preview.document, 'terminalProfiles')) {
      if (!shouldCreate('terminalProfiles', profile)) continue;
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        version: _version,
        ...input
      } = profile;
      const createdProfile = this.products.createTerminalProfile(input);
      register('terminalProfiles', profile, createdProfile.id);
    }
    const pendingHosts = rowsFor(preview.document, 'hosts').filter((host) =>
      shouldCreate('hosts', host),
    );
    while (pendingHosts.length) {
      let progressed = false;
      for (let index = pendingHosts.length - 1; index >= 0; index -= 1) {
        const host = pendingHosts[index]!;
        const dependencies = [host.jumpHostId, ...host.jumpHostIds].filter(
          (id): id is string => !!id,
        );
        if (dependencies.some((id) => !targets.has(entryKey('hosts', id)))) continue;
        const {
          id: _id,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          version: _version,
          ...input
        } = host;
        const createdHost = this.products.createHost(
          createHostSchema.parse({
            ...input,
            groupId: targetId('hostGroups', host.groupId),
            jumpHostId: targetId('hosts', host.jumpHostId),
            jumpHostIds: host.jumpHostIds.map((id) => targetId('hosts', id)!),
          }),
        );
        register('hosts', host, createdHost.id);
        pendingHosts.splice(index, 1);
        progressed = true;
      }
      if (!progressed)
        throw new ApplicationError('INVALID_STATE', 'Host jump references are cyclic', 409);
    }
    let bookmarkTree = this.bookmarks.snapshot();
    const pendingBookmarkGroups = rowsFor(preview.document, 'bookmarkGroups')
      .filter((group) => shouldCreate('bookmarkGroups', group))
      .sort((left, right) => left.position - right.position);
    while (pendingBookmarkGroups.length) {
      let progressed = false;
      for (let index = pendingBookmarkGroups.length - 1; index >= 0; index -= 1) {
        const group = pendingBookmarkGroups[index]!;
        if (group.parentId && !targets.has(entryKey('bookmarkGroups', group.parentId))) continue;
        const before = new Set(bookmarkTree.groups.map(({ id }) => id));
        bookmarkTree = this.bookmarks.createGroup(
          createBookmarkGroupSchema.parse({
            parentId: targetId('bookmarkGroups', group.parentId),
            name: group.name,
            color: group.color,
            description: group.description,
          }),
          bookmarkTree.etag,
        );
        const createdGroup = bookmarkTree.groups.find(({ id }) => !before.has(id));
        if (!createdGroup)
          throw new ApplicationError('INVALID_STATE', 'Bookmark group was not created', 409);
        register('bookmarkGroups', group, createdGroup.id);
        pendingBookmarkGroups.splice(index, 1);
        progressed = true;
      }
      if (!progressed)
        throw new ApplicationError('INVALID_STATE', 'Bookmark group references are cyclic', 409);
    }
    for (const bookmark of rowsFor(preview.document, 'bookmarks').sort(
      (left, right) => left.position - right.position,
    )) {
      if (!shouldCreate('bookmarks', bookmark)) continue;
      const before = new Set(bookmarkTree.bookmarks.map(({ id }) => id));
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        version: _version,
        position: _position,
        connectionDisplay: _connectionDisplay,
        ...input
      } = bookmark;
      bookmarkTree = this.bookmarks.createBookmark(
        createBookmarkSchema.parse({
          ...input,
          groupId: targetId('bookmarkGroups', bookmark.groupId),
          hostId: targetId('hosts', bookmark.hostId),
          profileId: targetId('terminalProfiles', bookmark.profileId),
          connectionProfileId: targetId('connectionProfiles', bookmark.connectionProfileId),
          rdp: bookmark.rdp && {
            ...bookmark.rdp,
            jumpHostId: targetId('hosts', bookmark.rdp.jumpHostId),
          },
          vnc: bookmark.vnc && {
            ...bookmark.vnc,
            jumpHostId: targetId('hosts', bookmark.vnc.jumpHostId),
          },
          spice: bookmark.spice && {
            ...bookmark.spice,
            jumpHostId: targetId('hosts', bookmark.spice.jumpHostId),
          },
        }),
        bookmarkTree.etag,
      );
      const createdBookmark = bookmarkTree.bookmarks.find(({ id }) => !before.has(id));
      if (!createdBookmark)
        throw new ApplicationError('INVALID_STATE', 'Bookmark was not created', 409);
      register('bookmarks', bookmark, createdBookmark.id);
    }
    for (const tunnel of rowsFor(preview.document, 'tunnelProfiles')) {
      if (!shouldCreate('tunnelProfiles', tunnel)) continue;
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        version: _version,
        ...input
      } = tunnel;
      const createdTunnel = this.products.createTunnelProfile(
        tunnelProfileInputSchema.parse({ ...input, hostId: targetId('hosts', tunnel.hostId)! }),
      );
      register('tunnelProfiles', tunnel, createdTunnel.id);
    }
    let commandTree = this.quickCommands.snapshot();
    const pendingCommandGroups = rowsFor(preview.document, 'quickCommandGroups')
      .filter((group) => shouldCreate('quickCommandGroups', group))
      .sort((left, right) => left.position - right.position);
    while (pendingCommandGroups.length) {
      let progressed = false;
      for (let index = pendingCommandGroups.length - 1; index >= 0; index -= 1) {
        const group = pendingCommandGroups[index]!;
        if (group.parentId && !targets.has(entryKey('quickCommandGroups', group.parentId)))
          continue;
        const before = new Set(commandTree.groups.map(({ id }) => id));
        commandTree = this.quickCommands.createGroup(
          quickCommandGroupInputSchema.parse({
            parentId: targetId('quickCommandGroups', group.parentId),
            name: group.name,
          }),
          commandTree.etag,
        );
        const createdGroup = commandTree.groups.find(({ id }) => !before.has(id));
        if (!createdGroup)
          throw new ApplicationError('INVALID_STATE', 'Quick Command group was not created', 409);
        register('quickCommandGroups', group, createdGroup.id);
        pendingCommandGroups.splice(index, 1);
        progressed = true;
      }
      if (!progressed)
        throw new ApplicationError(
          'INVALID_STATE',
          'Quick Command group references are cyclic',
          409,
        );
    }
    for (const command of rowsFor(preview.document, 'quickCommands').sort(
      (left, right) => left.position - right.position,
    )) {
      if (!shouldCreate('quickCommands', command)) continue;
      const before = new Set(commandTree.commands.map(({ id }) => id));
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        version: _version,
        position: _position,
        ...input
      } = command;
      commandTree = this.quickCommands.createCommand(
        quickCommandInputSchema.parse({
          ...input,
          groupId: targetId('quickCommandGroups', command.groupId),
        }),
        commandTree.etag,
      );
      const createdCommand = commandTree.commands.find(({ id }) => !before.has(id));
      if (!createdCommand)
        throw new ApplicationError('INVALID_STATE', 'Quick Command was not created', 409);
      register('quickCommands', command, createdCommand.id);
    }
    for (const theme of rowsFor(preview.document, 'terminalThemes')) {
      if (!shouldCreate('terminalThemes', theme)) continue;
      const {
        id: _id,
        builtIn: _builtIn,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        version: _version,
        ...input
      } = theme;
      const createdTheme = this.themes.create(terminalThemeInputSchema.parse(input));
      register('terminalThemes', theme, createdTheme.id);
    }
    if (preview.applySettings) {
      const currentSettings = this.products.getSettings();
      this.products.updateSettings(
        remapPortableSettings(
          preview.document.data.settings,
          (collection, sourceId) => targetId(collection, sourceId),
          (sourceId) =>
            targets.get(entryKey('terminalThemes', sourceId)) ??
            (this.themes.list().some((theme) => theme.id === sourceId)
              ? sourceId
              : currentSettings.terminal.visual.themeId),
          (sourceId) =>
            preview.document.data.bookmarks.some((bookmark) => bookmark.id === sourceId),
          preview.document.omissions.fields,
        ),
        etagFor(currentSettings.version),
      );
    }
    // TriggerService keeps a small in-memory rule cache, so import triggers last. Every earlier
    // operation has completed before this cache is refreshed, while the outer transaction keeps
    // all persisted collections atomic.
    let triggerCollection = this.triggers.snapshot();
    for (const trigger of rowsFor(preview.document, 'triggers')) {
      if (!shouldCreate('triggers', trigger)) continue;
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        version: _version,
        ...input
      } = trigger;
      const before = new Set(triggerCollection.triggers.map(({ id }) => id));
      triggerCollection = this.triggers.create(
        triggerRuleInputSchema.parse(input),
        triggerCollection.etag,
      );
      const createdTrigger = triggerCollection.triggers.find(({ id }) => !before.has(id));
      if (!createdTrigger)
        throw new ApplicationError('INVALID_STATE', 'Trigger was not created', 409);
      register('triggers', trigger, createdTrigger.id);
    }
    this.work.imported(preview.id, {
      sha256: preview.sha256,
      created,
      settings: preview.applySettings ? 'applied' : 'preserved',
    });
    return {
      create: created,
      unchanged: preview.result.counts.unchanged,
      conflict: 0,
      skipped: preview.applySettings ? 0 : 1,
    };
  }

  private currentTargetFingerprint(includeSettings: boolean): string {
    return targetFingerprint(this.snapshot(), includeSettings);
  }

  private prunePreviews(): void {
    const now = Date.now();
    for (const [id, preview] of this.pendingPreviews)
      if (Date.parse(preview.expiresAt) <= now) this.pendingPreviews.delete(id);
  }
}

function rowsFor<C extends ImportCollection>(
  document: AxtermConfigurationDocument,
  collection: C,
): Array<AxtermConfigurationDocument['data'][C] extends readonly (infer Row)[] ? Row : never> {
  return document.data[collection] as Array<
    AxtermConfigurationDocument['data'][C] extends readonly (infer Row)[] ? Row : never
  >;
}

function entryKey(collection: ImportCollection, sourceId: string): string {
  return `${collection}:${sourceId}`;
}

function fingerprintFor(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function targetFingerprint(
  document: AxtermConfigurationDocument,
  includeSettings: boolean,
): string {
  if (includeSettings) return fingerprintFor(document.data);
  const { settings: _settings, ...collections } = document.data;
  return fingerprintFor(collections);
}

function countActions(
  actions: ReadonlyMap<string, ImportAction>,
  applySettings: boolean,
): ImportCounts {
  let create = 0;
  let unchanged = 0;
  let conflict = 0;
  for (const action of actions.values()) {
    if (action === 'create') create += 1;
    else if (action === 'unchanged') unchanged += 1;
    else conflict += 1;
  }
  return { create, unchanged, conflict, skipped: applySettings ? 0 : 1 };
}

function remapPortableSettings(
  source: AxtermConfigurationDocument['data']['settings'],
  reference: (collection: ImportCollection, sourceId: string | null | undefined) => string | null,
  themeId: (sourceId: string) => string,
  isSourceBookmark: (sourceId: string) => boolean,
  omissions: readonly string[],
): UpdateSettingsInput {
  const remapLayout = (layout: NonNullable<Settings['workspace']['layout']>) => ({
    ...layout,
    tabs: layout.tabs.map((tab) => ({
      ...tab,
      ...(tab.hostId ? { hostId: reference('hosts', tab.hostId)! } : {}),
      ...(tab.bookmarkId ? { bookmarkId: reference('bookmarks', tab.bookmarkId)! } : {}),
      ...(tab.profileId ? { profileId: reference('terminalProfiles', tab.profileId)! } : {}),
      ...(tab.visual ? { visual: { ...tab.visual, themeId: themeId(tab.visual.themeId) } } : {}),
    })),
  });
  const remapStartupId = (sourceId: string): string =>
    isSourceBookmark(sourceId) ? reference('bookmarks', sourceId)! : sourceId;
  const startupSessions = Array.isArray(source.workspace.startupSessions)
    ? source.workspace.startupSessions.map(remapStartupId)
    : remapStartupId(source.workspace.startupSessions);
  const network = omissions.includes('data.settings.network.proxy') ? undefined : source.network;
  return {
    appearance: source.appearance,
    workspace: {
      restoreLayout: source.workspace.restoreLayout,
      aiInspectorOpen: source.workspace.aiInspectorOpen,
      ...(source.workspace.layout ? { layout: remapLayout(source.workspace.layout) } : {}),
      namedWorkspaces: source.workspace.namedWorkspaces.map((workspace) => ({
        ...workspace,
        layout: remapLayout(workspace.layout),
        ...(workspace.presentation
          ? {
              presentation: {
                ...workspace.presentation,
                tabs: workspace.presentation.tabs.map((tab) => ({
                  ...tab,
                  ...(tab.terminalVisual
                    ? {
                        terminalVisual: {
                          ...tab.terminalVisual,
                          themeId: themeId(tab.terminalVisual.themeId),
                        },
                      }
                    : {}),
                })),
              },
            }
          : {}),
      })),
      activeWorkspaceId: source.workspace.activeWorkspaceId,
      startupSessions,
      showTabNumber: source.workspace.showTabNumber,
      switchTabOnHover: source.workspace.switchTabOnHover,
      activityRailItems: source.workspace.activityRailItems,
    },
    ...(network ? { network } : {}),
    shortcuts: source.shortcuts,
    terminal: {
      ...source.terminal,
      defaultProfileId: reference('terminalProfiles', source.terminal.defaultProfileId),
      visual: {
        ...source.terminal.visual,
        themeId: themeId(source.terminal.visual.themeId),
      },
    },
    fileManager: {
      ...source.fileManager,
      remoteAddressBookmarks: source.fileManager.remoteAddressBookmarks.map((bookmark) => ({
        ...bookmark,
        hostId: reference('hosts', bookmark.hostId),
      })),
    },
    monitor: source.monitor,
  };
}

function redactCredentialRefs<T>(value: T, path: string, omissions: string[]): T {
  if (Array.isArray(value))
    return value.map((item, index) =>
      redactCredentialRefs(item, `${path}[${index}]`, omissions),
    ) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const childPath = `${path}.${key}`;
      if (/credentialRef$/iu.test(key) && typeof item === 'string') {
        omissions.push(childPath);
        return [key, null];
      }
      return [key, redactCredentialRefs(item, childPath, omissions)];
    }),
  ) as T;
}

function removeImageBackgrounds<T>(value: T, path: string, omissions: string[]): T {
  if (Array.isArray(value))
    return value.map((item, index) =>
      removeImageBackgrounds(item, `${path}[${index}]`, omissions),
    ) as T;
  if (!value || typeof value !== 'object') return value;
  if ('kind' in value && value.kind === 'image' && 'assetId' in value) {
    omissions.push(`${path}.assetId`);
    return { ...DEFAULT_TERMINAL_BACKGROUND } as T;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      removeImageBackgrounds(item, `${path}.${key}`, omissions),
    ]),
  ) as T;
}
