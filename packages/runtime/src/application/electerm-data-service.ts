import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import {
  ACTIVITY_RAIL_ITEM_IDS,
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_TERMINAL_BACKGROUND,
  DEFAULT_TERMINAL_THEME_ID,
  bookmarkTriggerSchema,
  electermDataExportResultSchema,
  electermDataImportResultSchema,
  electermDataPreviewSchema,
  updateSettingsSchema,
  type ConnectionProfileInput,
  type ElectermDataExportResult,
  type ElectermDataImportResult,
  type ElectermDataPreview,
  type ElectermMigrationAction,
  type ElectermMigrationCounts,
  type ElectermMigrationEntry,
  type HostProxyConfig,
  type Settings,
  type UpdateSettingsInput,
} from '@workspace/contracts';
import {
  desktopWindowPreferencesPatchSchema,
  type DesktopWindowPreferences,
  type DesktopWindowPreferencesPatch,
} from '@workspace/contracts/desktop';
import type { ProductDatabase } from '../adapters/sqlite/database';
import { etagFor, stableHash, type ProductRepository } from '../adapters/sqlite/product-repository';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { BookmarkTreeService } from './bookmark-tree-service';
import type { SshBookmarkService } from './ssh-bookmark-service';
import type { QuickCommandService } from './quick-command-service';
import {
  connectionProfileCredentialRefs,
  type ConnectionProfileService,
} from './connection-profile-service';
import { ApplicationError } from './errors';
import { validateTriggerPattern } from './trigger-engine';

const importMaxBytes = 8 * 1024 * 1024;
const exportMaxBytes = 16 * 1024 * 1024;
const previewTtlMs = 10 * 60_000;
const entityLimit = 5_000;
const reportLimit = 6_000;

type RecordValue = Record<string, unknown>;
type MappingKind = 'group' | 'profile' | 'sshBookmark' | 'quickCommand';

interface ImportMapping {
  kind: MappingKind;
  source_id: string;
  fingerprint: string;
  target_id: string;
}

interface SourceGroup {
  sourceId: string;
  name: string;
  color: string | null;
  description: string;
  bookmarkIds: string[];
  childIds: string[];
  parentSourceId: string | null;
  position: number;
  source: RecordValue;
  fingerprint: string;
  action: ElectermMigrationAction;
  targetName: string;
  reasons: string[];
}

interface SourceProfile {
  sourceId: string;
  name: string;
  source: RecordValue;
  fingerprint: string;
  action: ElectermMigrationAction;
  targetName: string;
  reasons: string[];
}

interface SourceBookmark {
  sourceId: string;
  name: string;
  protocol: string;
  groupSourceId: string | null;
  profileSourceId: string | null;
  source: RecordValue;
  fingerprint: string;
  action: ElectermMigrationAction;
  targetName: string;
  mappedFields: string[];
  omittedFields: string[];
  reasons: string[];
}

interface SourceQuickCommand {
  sourceId: string;
  name: string;
  source: RecordValue;
  fingerprint: string;
  action: ElectermMigrationAction;
  targetName: string;
  reasons: string[];
}

interface StoredPreview {
  public: ElectermDataPreview;
  groups: SourceGroup[];
  profiles: SourceProfile[];
  bookmarks: SourceBookmark[];
  quickCommands: SourceQuickCommand[];
  settings: SourceSettings | null;
  credentialMetadataCount: number;
  expiresAtMs: number;
  consumed: boolean;
}

interface SourceSettings {
  patch: UpdateSettingsInput;
  startupBookmarkSourceIds: string[] | null;
  version: number;
  desktopPatch: DesktopWindowPreferencesPatch;
  desktopPrevious: DesktopWindowPreferences;
  action: ElectermMigrationAction;
  mappedFields: string[];
  omittedFields: string[];
}

export class ElectermDataService {
  private readonly previews = new Map<string, StoredPreview>();

  constructor(
    private readonly database: ProductDatabase,
    private readonly repository: ProductRepository,
    private readonly bookmarks: BookmarkTreeService,
    private readonly sshBookmarks: SshBookmarkService,
    private readonly profiles: ConnectionProfileService,
    private readonly quickCommands: QuickCommandService,
    private readonly hostCapabilities?: HostCapabilityClient,
  ) {}

  async preview(grantId: string): Promise<ElectermDataPreview> {
    this.sweepPreviews();
    const grant = await this.requireHostCapabilities().resolveGrant(grantId);
    if (grant.kind !== 'file' || !grant.permissions.includes('read'))
      throw new ApplicationError('INVALID_STATE', 'A readable file grant is required', 409);
    const source = parseRoot(await readBoundedRegularFile(grant.path));
    const desktopPreferences = await this.requireHostCapabilities().windowPreferences();
    const stored = this.buildPreview(source, basename(grant.path), desktopPreferences.preferences);
    this.previews.set(stored.public.previewId, stored);
    return stored.public;
  }

  cancel(previewId: string): void {
    this.previews.delete(previewId);
  }

  async commit(
    previewId: string,
    treeIfMatch: string | undefined,
  ): Promise<ElectermDataImportResult> {
    this.sweepPreviews();
    const preview = this.previews.get(previewId);
    if (!preview)
      throw new ApplicationError('NOT_FOUND', 'Electerm data preview expired or was canceled', 404);
    if (preview.consumed)
      throw new ApplicationError('CONFLICT', 'Electerm data preview was already consumed', 409);
    if (!treeIfMatch)
      throw new ApplicationError(
        'PRECONDITION_REQUIRED',
        'Bookmark tree If-Match is required',
        428,
      );
    if (treeIfMatch !== preview.public.treeEtag || treeIfMatch !== this.bookmarks.snapshot().etag)
      throw new ApplicationError('PRECONDITION_FAILED', 'Bookmark tree changed', 412);

    const createdCredentialRefs: string[] = [];
    let desktopPreferencesApplied = false;
    try {
      const preparedProfiles = new Map<string, ConnectionProfileInput>();
      for (const profile of preview.profiles.filter(({ action }) => action === 'create'))
        preparedProfiles.set(
          profile.sourceId,
          await this.prepareProfile(profile, createdCredentialRefs),
        );
      const preparedBookmarks = new Map<
        string,
        Awaited<ReturnType<ElectermDataService['prepareBookmark']>>
      >();
      for (const bookmark of preview.bookmarks.filter(({ action }) => action === 'create'))
        preparedBookmarks.set(
          bookmark.sourceId,
          await this.prepareBookmark(bookmark, createdCredentialRefs),
        );

      if (
        preview.settings?.action === 'create' &&
        Object.keys(preview.settings.desktopPatch).length
      ) {
        const current = await this.requireHostCapabilities().windowPreferences();
        if (!sameValue(current.preferences, preview.settings.desktopPrevious))
          throw new ApplicationError(
            'PRECONDITION_FAILED',
            'Desktop preferences changed after preview',
            412,
          );
        await this.requireHostCapabilities().updateWindowPreferences(preview.settings.desktopPatch);
        desktopPreferencesApplied = true;
      }

      const targets = this.currentTargets();
      let tree = this.bookmarks.snapshot();
      this.database.transaction(() => {
        for (const group of topologicalGroups(preview.groups)) {
          if (group.action !== 'create') continue;
          const created = this.bookmarks.createGroup(
            {
              parentId: group.parentSourceId
                ? (targets.get(mappingKey('group', group.parentSourceId)) ?? null)
                : null,
              name: group.targetName,
              color: group.color,
              description: group.description,
            },
            tree.etag,
          );
          tree = created;
          const entity = created.groups.find(
            ({ name, parentId }) =>
              name === group.targetName &&
              parentId ===
                (group.parentSourceId
                  ? (targets.get(mappingKey('group', group.parentSourceId)) ?? null)
                  : null),
          );
          if (!entity) throw new Error('Imported group was not created');
          targets.set(mappingKey('group', group.sourceId), entity.id);
          this.saveMapping('group', group.sourceId, group.fingerprint, entity.id);
        }

        for (const profile of preview.profiles) {
          if (profile.action !== 'create') continue;
          const created = this.profiles.create(preparedProfiles.get(profile.sourceId)!);
          targets.set(mappingKey('profile', profile.sourceId), created.id);
          this.saveMapping('profile', profile.sourceId, profile.fingerprint, created.id);
        }

        let quickCommandTree = this.quickCommands.snapshot();
        for (const command of preview.quickCommands) {
          if (command.action !== 'create') continue;
          const previousIds = new Set(quickCommandTree.commands.map(({ id }) => id));
          quickCommandTree = this.quickCommands.createCommand(
            quickCommandInput(command),
            quickCommandTree.etag,
          );
          const created = quickCommandTree.commands.find(({ id }) => !previousIds.has(id));
          if (!created) throw new Error('Imported Quick Command was not created');
          targets.set(mappingKey('quickCommand', command.sourceId), created.id);
          this.saveMapping('quickCommand', command.sourceId, command.fingerprint, created.id);
        }

        for (const bookmark of preview.bookmarks) {
          if (bookmark.action !== 'create') continue;
          const prepared = preparedBookmarks.get(bookmark.sourceId)!;
          const result = this.sshBookmarks.create(
            {
              host: prepared.host,
              bookmark: {
                groupId: bookmark.groupSourceId
                  ? (targets.get(mappingKey('group', bookmark.groupSourceId)) ?? null)
                  : null,
                title: bookmark.name,
                color: prepared.color,
                description: prepared.description,
                profileId: null,
                connectionProfileId: bookmark.profileSourceId
                  ? (targets.get(mappingKey('profile', bookmark.profileSourceId)) ?? null)
                  : null,
                quickCommands: prepared.quickCommands,
                triggers: prepared.triggers,
              },
            },
            tree.etag,
          );
          tree = result.tree;
          targets.set(mappingKey('sshBookmark', bookmark.sourceId), result.bookmark.id);
          this.saveMapping(
            'sshBookmark',
            bookmark.sourceId,
            bookmark.fingerprint,
            result.bookmark.id,
          );
        }

        if (preview.settings?.action === 'create')
          this.repository.updateSettings(
            settingsPatchWithImportedStartupBookmarks(preview.settings, targets, tree),
            etagFor(preview.settings.version),
          );

        this.database.appendEvent('electerm-data.imported', previewId, {
          previewId,
          counts: preview.public.counts,
          createdCredentialCount: createdCredentialRefs.length,
          settingsApplied: preview.settings?.action === 'create',
          credentialMetadataReported: preview.credentialMetadataCount,
        });
      });
      preview.consumed = true;
      this.previews.delete(previewId);
      return electermDataImportResultSchema.parse({
        previewId,
        counts: preview.public.counts,
        createdCredentialCount: createdCredentialRefs.length,
        settingsApplied: preview.settings?.action === 'create',
        credentialMetadataReported: preview.credentialMetadataCount,
        tree,
      });
    } catch (error) {
      if (desktopPreferencesApplied && preview.settings)
        await this.requireHostCapabilities()
          .updateWindowPreferences(portableDesktopPreferences(preview.settings.desktopPrevious))
          .catch(() => undefined);
      await Promise.allSettled(
        createdCredentialRefs.map((ref) => this.requireHostCapabilities().deleteCredential(ref)),
      );
      throw error;
    }
  }

  async export(grantId: string): Promise<ElectermDataExportResult> {
    const grant = await this.requireHostCapabilities().resolveGrant(grantId);
    if (grant.kind !== 'save-target' || !grant.permissions.includes('write'))
      throw new ApplicationError('INVALID_STATE', 'A writable save grant is required', 409);
    const portable = await this.buildPortableExport();
    await writeAtomic(grant.path, portable.contents);
    return portable.result;
  }

  async portableDocument(): Promise<RecordValue> {
    return parseRoot((await this.buildPortableExport()).contents);
  }

  async previewPortableDocument(
    source: RecordValue,
    sourceName: string,
  ): Promise<ElectermDataPreview> {
    this.sweepPreviews();
    const desktopPreferences = await this.requireHostCapabilities().windowPreferences();
    const stored = this.buildPreview(source, sourceName, desktopPreferences.preferences);
    this.previews.set(stored.public.previewId, stored);
    return stored.public;
  }

  private async buildPortableExport(): Promise<{
    contents: string;
    result: ElectermDataExportResult;
  }> {
    const tree = this.bookmarks.snapshot();
    const hosts = this.repository.listHosts();
    const profiles = this.profiles.list();
    const quickCommands = this.quickCommands.snapshot().commands;
    const hostById = new Map(hosts.map((host) => [host.id, host]));
    const settings = this.repository.getSettings();
    const [credentialMetadata, desktopPreferences] = await Promise.all([
      this.requireHostCapabilities().listCredentials(),
      this.requireHostCapabilities().windowPreferences(),
    ]);
    const rootBookmarks = tree.bookmarks.filter(({ groupId }) => groupId === null);
    const rootGroups = tree.groups.filter(({ parentId }) => parentId === null);
    const bookmarkGroups = [
      {
        id: 'default',
        title: 'default',
        color: '#0088cc',
        level: 1,
        bookmarkIds: rootBookmarks.map(({ id }) => id),
        bookmarkGroupIds: rootGroups.map(({ id }) => id),
      },
      ...tree.groups.map((group) => ({
        id: group.id,
        title: group.name,
        color: group.color ?? undefined,
        description: group.description || undefined,
        level: groupDepth(group.id, tree.groups),
        bookmarkIds: tree.bookmarks
          .filter(({ groupId }) => groupId === group.id)
          .map(({ id }) => id),
        bookmarkGroupIds: tree.groups
          .filter(({ parentId }) => parentId === group.id)
          .map(({ id }) => id),
      })),
    ];
    const exportedBookmarks = tree.bookmarks.flatMap((bookmark) => {
      if (bookmark.protocol !== 'ssh' || !bookmark.hostId) return [];
      const host = hostById.get(bookmark.hostId);
      if (!host) return [];
      return [
        {
          id: bookmark.id,
          type: 'ssh',
          title: bookmark.title,
          host: host.hostname,
          port: host.port,
          username: host.username,
          authType: bookmark.connectionProfileId ? 'profiles' : host.authType,
          ...(bookmark.connectionProfileId ? { profile: bookmark.connectionProfileId } : {}),
          quickCommands: bookmark.quickCommands,
          triggers: bookmark.triggers,
          description: bookmark.description || undefined,
          color: bookmark.color ?? undefined,
          useSshAgent: host.authType === 'agent',
          compress: host.connectionOptions.compression ? ['zlib@openssh.com', 'zlib'] : [],
        },
      ];
    });
    const payload = {
      bookmarks: exportedBookmarks,
      bookmarkGroups,
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        isDefault: profile.isDefault,
        username: profile.ssh.username ?? undefined,
        telnet: { username: profile.telnet.username ?? undefined },
        vnc: { username: profile.vnc.username ?? undefined },
        rdp: { username: profile.rdp.username ?? undefined },
        ftp: { user: profile.ftp.username ?? undefined },
      })),
      quickCommands: quickCommands.map((command) => ({
        id: command.id,
        name: command.name,
        command: command.command,
        commands: command.commands.map((step) => ({
          id: step.id,
          name: step.name,
          command: step.command,
          delay: step.delayMs,
        })),
        description: command.description,
        labels: command.tags,
        shortcut: command.shortcut ?? undefined,
        inputOnly: command.inputOnly,
        clickCount: command.clickCount,
      })),
      config: {
        theme: settings.appearance.theme === 'system' ? 'dark' : settings.appearance.theme,
        language: settings.appearance.language,
        hideIP: settings.privacy.hideAddresses,
        disableConnectionHistory: !settings.privacy.connectionHistoryEnabled,
        switchTabOnHover: settings.workspace.switchTabOnHover,
        onStartSessions: settings.workspace.startupSessions,
        leftSideBarIcons: settings.workspace.activityRailItems,
        enableGlobalProxy: settings.network.proxy.mode === 'custom',
        defaultEditor: settings.fileManager.externalEditor,
        screenReaderMode: settings.terminal.screenReaderMode,
        autoRefreshWhenSwitchToSftp: settings.fileManager.refreshOnFocus,
        sftpPathFollowSsh: settings.fileManager.followTerminalCwd,
        sshSftpSplitView: settings.fileManager.sshSplitView,
        autoReconnectTerminal: settings.terminal.autoReconnectTerminal,
        restoreTerminalSessionOnReload: settings.terminal.restoreTerminalSessionOnReload,
        showCmdSuggestions: settings.terminal.commandSuggestionsEnabled,
        dragDropBehavior: settings.terminal.dragDropBehavior,
        disableShortcutBar: !settings.terminal.shortcutBarEnabled,
        showHiddenFilesOnSftpStart: settings.fileManager.showHiddenFiles,
        terminalInfos: settings.monitor.terminalInformationItems,
        remoteMonitorBarEnabled: settings.monitor.remoteMonitorBarEnabled,
        remoteMonitorBarItems: settings.monitor.remoteMonitorBarItems,
      },
      _axterm: {
        formatVersion: 2,
        exportedAt: new Date().toISOString(),
        credentials: 'omitted',
        settings: portableSettings(settings),
        desktopPreferences: portableDesktopPreferences(desktopPreferences.preferences),
        credentialMetadata: credentialMetadata.map(({ kind, label, createdAt, updatedAt }) => ({
          kind,
          label,
          createdAt,
          updatedAt,
        })),
        note: 'Credential values are intentionally excluded from this portable data file.',
      },
    };
    const output = `${JSON.stringify(payload, null, 2)}\n`;
    const bytes = Buffer.byteLength(output);
    if (bytes > exportMaxBytes)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Electerm export exceeds 16 MiB', 413);
    const omittedCredentialCount =
      hosts
        .flatMap((host) => [
          host.credentialRef,
          host.passphraseCredentialRef,
          host.certificateCredentialRef,
          ...(host.proxy.mode === 'custom' ? [host.proxy.endpoint.credentialRef] : []),
        ])
        .filter(Boolean).length + profiles.flatMap(connectionProfileCredentialRefs).length;
    const result = electermDataExportResultSchema.parse({
      bytes,
      groups: tree.groups.length,
      profiles: profiles.length,
      sshBookmarks: exportedBookmarks.length,
      quickCommands: quickCommands.length,
      omittedCredentialCount,
      credentialMetadataCount: credentialMetadata.length,
      settingsIncluded: true,
      createdAt: new Date().toISOString(),
    });
    return { contents: output, result };
  }

  close(): void {
    this.previews.clear();
  }

  private buildPreview(
    source: RecordValue,
    sourceName: string,
    desktopPreferences: DesktopWindowPreferences,
  ): StoredPreview {
    const mappings = this.database.all<ImportMapping>('SELECT * FROM electerm_import_entries');
    const mappingByKey = new Map(
      mappings.map((mapping) => [mappingKey(mapping.kind, mapping.source_id), mapping]),
    );
    const targetIds = this.existingTargetIds();
    const acceptsTargetIdentity = Number(asRecord(source._axterm)?.formatVersion) >= 2;
    const profileNames = new Set(this.profiles.list().map(({ name }) => name.toLocaleLowerCase()));
    const hostNames = new Set(
      this.repository.listHosts().map(({ name }) => name.toLocaleLowerCase()),
    );
    const commandNames = new Set(
      this.quickCommands.snapshot().commands.map(({ name }) => name.toLocaleLowerCase()),
    );
    const rawGroups = records(source.bookmarkGroups, 'bookmarkGroups');
    const parentByGroup = groupParents(rawGroups);
    const groups = rawGroups
      .filter((group) => sourceId(group) !== 'default')
      .map((group, index): SourceGroup => {
        const id = sourceId(group, `group-${index + 1}`);
        const fingerprint = sourceFingerprint(group);
        const name = text(group.title ?? group.name, `Group ${index + 1}`, 80);
        return {
          sourceId: id,
          name,
          color: color(group.color),
          description: text(group.description, '', 1_024),
          bookmarkIds: stringArray(group.bookmarkIds),
          childIds: stringArray(group.bookmarkGroupIds),
          parentSourceId: normalizeGroupId(parentByGroup.get(id)),
          position: index,
          source: group,
          fingerprint,
          action: mappingAction(
            'group',
            id,
            fingerprint,
            mappingByKey,
            targetIds,
            acceptsTargetIdentity,
          ),
          targetName: name,
          reasons: [],
        };
      });
    validateGroupGraph(groups, mappingByKey, targetIds);
    const groupNames = new Set(
      this.bookmarks.snapshot().groups.map(({ name }) => name.toLocaleLowerCase()),
    );
    for (const group of groups) {
      if (group.action === 'create') group.targetName = uniqueName(group.name, groupNames, 80);
    }

    const profiles = records(source.profiles, 'profiles').map((profile, index): SourceProfile => {
      const id = sourceId(profile, `profile-${index + 1}`);
      const fingerprint = sourceFingerprint(profile);
      const name = text(profile.name, `Profile ${index + 1}`, 60);
      return {
        sourceId: id,
        name,
        source: profile,
        fingerprint,
        action: mappingAction(
          'profile',
          id,
          fingerprint,
          mappingByKey,
          targetIds,
          acceptsTargetIdentity,
        ),
        targetName: uniqueName(name, profileNames, 60),
        reasons: [],
      };
    });

    const groupForBookmark = bookmarkParents(rawGroups);
    const bookmarks = records(source.bookmarks, 'bookmarks').map(
      (bookmark, index): SourceBookmark => {
        const id = sourceId(bookmark, `bookmark-${index + 1}`);
        const protocol = text(bookmark.type, 'ssh', 20).toLowerCase();
        const fingerprint = sourceFingerprint(bookmark);
        const name = text(bookmark.title ?? bookmark.name, `Bookmark ${index + 1}`, 100);
        const omittedFields = omittedBookmarkFields(bookmark, protocol);
        const mappedFields = mappedBookmarkFields(bookmark, protocol);
        const supported = protocol === 'ssh' && !!optionalText(bookmark.host, 253);
        const usesProfile = text(bookmark.authType, '', 20) === 'profiles';
        return {
          sourceId: id,
          name,
          protocol,
          groupSourceId: normalizeGroupId(groupForBookmark.get(id)),
          profileSourceId: usesProfile ? optionalText(bookmark.profile, 160) : null,
          source: bookmark,
          fingerprint,
          action: supported
            ? mappingAction(
                'sshBookmark',
                id,
                fingerprint,
                mappingByKey,
                targetIds,
                acceptsTargetIdentity,
              )
            : 'skip',
          targetName: uniqueName(name, hostNames, 100),
          mappedFields,
          omittedFields,
          reasons: [],
        };
      },
    );

    const quickCommands = records(source.quickCommands, 'quickCommands').map(
      (command, index): SourceQuickCommand => {
        const id = sourceId(command, `quick-command-${index + 1}`);
        const fingerprint = sourceFingerprint(command);
        const name = text(command.name, `Command ${index + 1}`, 100);
        const valid =
          !!optionalText(command.command, 16_384) ||
          records(command.commands, 'commands').some((step) =>
            Boolean(optionalText(step.command, 16_384)),
          );
        return {
          sourceId: id,
          name,
          source: command,
          fingerprint,
          action: valid
            ? mappingAction(
                'quickCommand',
                id,
                fingerprint,
                mappingByKey,
                targetIds,
                acceptsTargetIdentity,
              )
            : 'skip',
          targetName: uniqueName(name, commandNames, 100),
          reasons: [],
        };
      },
    );

    markDuplicateIds(profiles, 'Connection Profile');
    markDuplicateIds(bookmarks, 'Bookmark');
    markDuplicateIds(quickCommands, 'Quick Command');
    validateBookmarkReferences(bookmarks, groups, profiles, mappingByKey, targetIds);

    const currentSettings = this.repository.getSettings();
    const settings = sourceSettings(source, currentSettings, desktopPreferences);
    if (
      settings?.startupBookmarkSourceIds &&
      !settings.startupBookmarkSourceIds.some((sourceId) =>
        bookmarks.some(
          (bookmark) => bookmark.sourceId === sourceId && bookmark.action === 'create',
        ),
      )
    ) {
      const resolvedPatch = settingsPatchWithImportedStartupBookmarks(
        settings,
        this.currentTargets(),
        this.bookmarks.snapshot(),
      );
      settings.action =
        matchesPatch(currentSettings, resolvedPatch) &&
        matchesPatch(desktopPreferences, settings.desktopPatch)
          ? 'unchanged'
          : 'create';
    }
    const credentialMetadataCount = sourceCredentialMetadataCount(source);

    const entries: ElectermMigrationEntry[] = [
      ...groups.map((group) => entryForGroup(group, mappingByKey)),
      ...profiles.map((profile) => entryForProfile(profile, mappingByKey)),
      ...bookmarks.map((bookmark) => entryForBookmark(bookmark, mappingByKey)),
      ...quickCommands.map((command) => entryForQuickCommand(command, mappingByKey)),
      ...(settings ? [entryForSettings(settings)] : []),
      ...(credentialMetadataCount ? [entryForCredentialMetadata(credentialMetadataCount)] : []),
      ...unsupportedDatasetEntries(source),
    ];
    if (entries.length > reportLimit)
      throw new ApplicationError(
        'PAYLOAD_TOO_LARGE',
        `Electerm migration report exceeds ${reportLimit} items`,
        413,
      );
    makeEntryKeysUnique(entries);
    const counts = countEntries(entries, credentialMetadataCount);
    const previewId = randomUUID();
    const expiresAtMs = Date.now() + previewTtlMs;
    const publicPreview = electermDataPreviewSchema.parse({
      previewId,
      sourceName: text(sourceName, 'electerm-data.json', 255),
      sourceVersion: sourceVersion(source),
      treeEtag: this.bookmarks.snapshot().etag,
      expiresAt: new Date(expiresAtMs).toISOString(),
      counts,
      entries,
    });
    return {
      public: publicPreview,
      groups,
      profiles,
      bookmarks,
      quickCommands,
      settings,
      credentialMetadataCount,
      expiresAtMs,
      consumed: false,
    };
  }

  private async prepareProfile(profile: SourceProfile, created: string[]) {
    const source = profile.source;
    const protocolSection = (name: string) => asRecord(source[name]) ?? {};
    const create = (kind: string, label: string, value: unknown) =>
      this.createCredential(kind, `${profile.targetName} ${label}`, value, created);
    const passwordCredentialRef = await create('sshPassword', 'SSH password', source.password);
    const privateKeyCredentialRef = await create(
      'privateKey',
      'SSH private key',
      privateKeyContents(source.privateKey),
    );
    const passphraseCredentialRef = privateKeyCredentialRef
      ? await create('privateKeyPassphrase', 'SSH key passphrase', source.passphrase)
      : null;
    const certificateCredentialRef = await create(
      'sshCertificate',
      'SSH certificate',
      source.certificate,
    );
    return {
      name: profile.targetName,
      isDefault: source.isDefault === true,
      ssh: {
        username: optionalText(source.username, 128),
        passwordCredentialRef,
        privateKeyCredentialRef,
        passphraseCredentialRef,
        certificateCredentialRef,
      },
      telnet: await this.preparePasswordSection(
        protocolSection('telnet'),
        'telnet',
        profile.targetName,
        created,
      ),
      vnc: await this.preparePasswordSection(
        protocolSection('vnc'),
        'vnc',
        profile.targetName,
        created,
      ),
      rdp: await this.preparePasswordSection(
        protocolSection('rdp'),
        'rdp',
        profile.targetName,
        created,
      ),
      ftp: await this.preparePasswordSection(
        protocolSection('ftp'),
        'ftp',
        profile.targetName,
        created,
      ),
    } satisfies ConnectionProfileInput;
  }

  private async preparePasswordSection(
    section: RecordValue,
    protocol: string,
    profileName: string,
    created: string[],
  ) {
    return {
      username: optionalText(section.username ?? section.user, 128),
      passwordCredentialRef: await this.createCredential(
        'protocolPassword',
        `${profileName} ${protocol.toUpperCase()} password`,
        section.password,
        created,
      ),
    };
  }

  private async prepareBookmark(bookmark: SourceBookmark, created: string[]) {
    const source = bookmark.source;
    const usesProfile = text(source.authType, '', 20) === 'profiles' && !!bookmark.profileSourceId;
    const password = usesProfile
      ? null
      : await this.createCredential(
          'sshPassword',
          `${bookmark.targetName} SSH password`,
          source.password,
          created,
        );
    const privateKeyValue = usesProfile ? null : privateKeyContents(source.privateKey);
    const privateKey =
      privateKeyValue && /PRIVATE KEY/u.test(privateKeyValue)
        ? await this.createCredential(
            'privateKey',
            `${bookmark.targetName} SSH private key`,
            privateKeyValue,
            created,
          )
        : null;
    const passphrase = privateKey
      ? await this.createCredential(
          'privateKeyPassphrase',
          `${bookmark.targetName} SSH key passphrase`,
          source.passphrase,
          created,
        )
      : null;
    const certificate = privateKey
      ? await this.createCredential(
          'sshCertificate',
          `${bookmark.targetName} SSH certificate`,
          source.certificate,
          created,
        )
      : null;
    const proxy = await this.prepareProxy(source.proxy, bookmark.targetName, created);
    const authType = privateKey ? 'privateKey' : password ? 'password' : 'agent';
    return {
      host: {
        name: bookmark.targetName,
        hostname: text(source.host, '', 253),
        port: integer(source.port, 22, 1, 65_535),
        username: text(source.username, 'root', 128),
        authType,
        credentialRef: privateKey ?? password,
        passphraseCredentialRef: passphrase,
        certificateCredentialRef: certificate,
        jumpHostId: null,
        favorite: source.favorite === true,
        proxy,
        connectionOptions: {
          ...DEFAULT_SSH_CONNECTION_OPTIONS,
          compression: Array.isArray(source.compress)
            ? source.compress.length > 0
            : source.compression === true,
        },
        sshAgent: {
          enabled: source.useSshAgent !== false,
          path: optionalText(source.sshAgent, 4_096),
        },
      },
      color: color(source.color),
      description: text(source.description, '', 2_000),
      quickCommands: bookmarkQuickCommands(source.quickCommands),
      triggers: bookmarkTriggers(source.triggers),
    } as const;
  }

  private async prepareProxy(value: unknown, name: string, created: string[]) {
    const raw = optionalText(value, 2_048);
    if (!raw) return { mode: 'inherit' } as HostProxyConfig;
    try {
      const url = new URL(raw);
      if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(url.protocol))
        return { mode: 'inherit' } as HostProxyConfig;
      const username = decodeURIComponent(url.username) || null;
      const password = decodeURIComponent(url.password);
      url.username = '';
      url.password = '';
      const credentialRef = username
        ? await this.createCredential('proxyPassword', `${name} proxy password`, password, created)
        : null;
      if (!!username !== !!credentialRef) return { mode: 'inherit' } as HostProxyConfig;
      return {
        mode: 'custom',
        endpoint: { url: url.toString(), username, credentialRef },
      } as HostProxyConfig;
    } catch {
      return { mode: 'inherit' } as HostProxyConfig;
    }
  }

  private async createCredential(
    kind: string,
    label: string,
    value: unknown,
    created: string[],
  ): Promise<string | null> {
    const secret = secretText(value, 131_072);
    if (!secret) return null;
    const metadata = await this.requireHostCapabilities().createCredential({ kind, label, secret });
    created.push(metadata.ref);
    return metadata.ref;
  }

  private saveMapping(kind: MappingKind, sourceId: string, fingerprint: string, targetId: string) {
    this.database.run(
      `INSERT INTO electerm_import_entries(kind, source_id, fingerprint, target_id, imported_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, source_id) DO UPDATE SET
         fingerprint=excluded.fingerprint,
         target_id=excluded.target_id,
         imported_at=excluded.imported_at`,
      kind,
      sourceId,
      fingerprint,
      targetId,
      new Date().toISOString(),
    );
  }

  private existingTargetIds(): Map<MappingKind, Set<string>> {
    return new Map([
      ['group', new Set(this.bookmarks.snapshot().groups.map(({ id }) => id))],
      ['profile', new Set(this.profiles.list().map(({ id }) => id))],
      ['sshBookmark', new Set(this.bookmarks.snapshot().bookmarks.map(({ id }) => id))],
      ['quickCommand', new Set(this.quickCommands.snapshot().commands.map(({ id }) => id))],
    ]);
  }

  private currentTargets(): Map<string, string> {
    const existing = this.existingTargetIds();
    return new Map(
      this.database
        .all<ImportMapping>('SELECT * FROM electerm_import_entries')
        .flatMap((mapping) =>
          existing.get(mapping.kind)?.has(mapping.target_id)
            ? [[mappingKey(mapping.kind, mapping.source_id), mapping.target_id] as const]
            : [],
        ),
    );
  }

  private requireHostCapabilities() {
    if (!this.hostCapabilities)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Desktop file access is unavailable',
        503,
      );
    return this.hostCapabilities;
  }

  private sweepPreviews() {
    const now = Date.now();
    for (const [id, preview] of this.previews)
      if (preview.expiresAtMs <= now || preview.consumed) this.previews.delete(id);
    while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!);
  }
}

function parseRoot(source: string): RecordValue {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new ApplicationError('VALIDATION_ERROR', 'Electerm data file is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApplicationError('VALIDATION_ERROR', 'Electerm data root must be an object');
  return value as RecordValue;
}

function records(value: unknown, label: string): RecordValue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ApplicationError('VALIDATION_ERROR', `${label} must be an array`);
  if (value.length > entityLimit)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', `${label} exceeds ${entityLimit} items`, 413);
  if (value.some((item) => !asRecord(item)))
    throw new ApplicationError('VALIDATION_ERROR', `${label} contains a non-object item`, 400);
  return value as RecordValue[];
}

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function sourceId(value: RecordValue, fallback = ''): string {
  return optionalText(value.id, 160) ?? fallback;
}

function text(value: unknown, fallback: string, max: number): string {
  return optionalText(value, max) ?? fallback;
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) return null;
  return normalized;
}

function secretText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0'))
    return null;
  return value;
}

function privateKeyContents(value: unknown): string | null {
  const key = secretText(value, 131_072);
  return key && /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(key) ? key : null;
}

function sourceVersion(source: RecordValue): string | null {
  const marker = asRecord(source._axterm)?.formatVersion ?? asRecord(source._axterm)?.version;
  if (typeof marker === 'number' && Number.isFinite(marker)) return String(marker);
  return optionalText(marker, 80);
}

function portableSettings(settings: Settings): UpdateSettingsInput {
  const background =
    settings.terminal.visual.background.kind === 'image'
      ? { ...DEFAULT_TERMINAL_BACKGROUND }
      : { ...settings.terminal.visual.background, assetId: null };
  return updateSettingsSchema.parse({
    appearance: settings.appearance,
    workspace: {
      restoreLayout: settings.workspace.restoreLayout,
      aiInspectorOpen: settings.workspace.aiInspectorOpen,
      showTabNumber: settings.workspace.showTabNumber,
      switchTabOnHover: settings.workspace.switchTabOnHover,
      startupSessions: Array.isArray(settings.workspace.startupSessions)
        ? settings.workspace.startupSessions
        : [],
      activityRailItems: settings.workspace.activityRailItems,
    },
    privacy: settings.privacy,
    shortcuts: settings.shortcuts,
    terminal: {
      autoReconnectTerminal: settings.terminal.autoReconnectTerminal,
      screenReaderMode: settings.terminal.screenReaderMode,
      restoreTerminalSessionOnReload: settings.terminal.restoreTerminalSessionOnReload,
      commandSuggestionsEnabled: settings.terminal.commandSuggestionsEnabled,
      dragDropBehavior: settings.terminal.dragDropBehavior,
      shortcutBarEnabled: settings.terminal.shortcutBarEnabled,
      shortcutBarButtons: settings.terminal.shortcutBarButtons,
      visual: {
        themeId:
          settings.terminal.visual.themeId === DEFAULT_TERMINAL_THEME_ID
            ? settings.terminal.visual.themeId
            : DEFAULT_TERMINAL_THEME_ID,
        background,
      },
    },
    fileManager: {
      showHiddenFiles: settings.fileManager.showHiddenFiles,
      externalEditor: settings.fileManager.externalEditor,
      refreshOnFocus: settings.fileManager.refreshOnFocus,
      followTerminalCwd: settings.fileManager.followTerminalCwd,
      sshSplitView: settings.fileManager.sshSplitView,
      columns: settings.fileManager.columns,
      localSort: settings.fileManager.localSort,
      remoteSort: settings.fileManager.remoteSort,
    },
    monitor: settings.monitor,
  });
}

function portableDesktopPreferences(
  preferences: DesktopWindowPreferences,
): DesktopWindowPreferencesPatch {
  return desktopWindowPreferencesPatchSchema.parse({
    titleBarStyle: preferences.titleBarStyle,
    opacity: preferences.opacity,
    zoomFactor: preferences.zoomFactor,
    globalHotkey: preferences.globalHotkey,
    allowMultiInstance: preferences.allowMultiInstance,
    confirmBeforeExit: preferences.confirmBeforeExit,
  });
}

function sourceSettings(
  source: RecordValue,
  current: Settings,
  desktopCurrent: DesktopWindowPreferences,
): SourceSettings | null {
  const axterm = asRecord(source._axterm);
  const hasPortableSettings = !!axterm && Object.hasOwn(axterm, 'settings');
  const hasPortableDesktop = !!axterm && Object.hasOwn(axterm, 'desktopPreferences');
  const patch = hasPortableSettings
    ? sanitizePortableSettings(axterm?.settings)
    : settingsFromElectermConfig(source.config);
  const portableStartupSessions = patch.workspace?.startupSessions;
  const startupBookmarkSourceIds = hasPortableSettings
    ? Array.isArray(portableStartupSessions)
      ? portableStartupSessions
      : null
    : electermStartupBookmarkSourceIds(source.config);
  const desktopPatch = hasPortableDesktop
    ? sanitizePortableDesktopPreferences(axterm?.desktopPreferences)
    : desktopPreferencesFromElectermConfig(source.config);
  const mappedFields = [
    ...leafPaths(patch),
    ...(startupBookmarkSourceIds ? ['workspace.startupSessions'] : []),
    ...leafPaths(desktopPatch).map((path) => `desktop.${path}`),
  ];
  if (!mappedFields.length && !source.config && !hasPortableSettings && !hasPortableDesktop)
    return null;

  const omittedFields = hasPortableSettings
    ? [
        'workspace.layout',
        'terminal.defaultProfileId',
        'terminal.visual.background.assetId',
        'network.proxy',
        'desktop.bounds',
      ]
    : omittedElectermConfigFields(source.config, mappedFields);
  const action: ElectermMigrationAction = !mappedFields.length
    ? 'skip'
    : !startupBookmarkSourceIds &&
        matchesPatch(current, patch) &&
        matchesPatch(desktopCurrent, desktopPatch)
      ? 'unchanged'
      : 'create';
  return {
    patch,
    startupBookmarkSourceIds,
    version: current.version,
    desktopPatch,
    desktopPrevious: desktopCurrent,
    action,
    mappedFields,
    omittedFields,
  };
}

function sanitizePortableSettings(value: unknown): UpdateSettingsInput {
  const source = asRecord(value);
  if (!source)
    throw new ApplicationError('VALIDATION_ERROR', 'Portable settings must be an object', 400);
  const appearance = asRecord(source.appearance);
  const workspace = asRecord(source.workspace);
  const privacy = asRecord(source.privacy);
  const shortcuts = asRecord(source.shortcuts);
  const terminal = asRecord(source.terminal);
  const visual = asRecord(terminal?.visual);
  const background = asRecord(visual?.background);
  const fileManager = asRecord(source.fileManager);
  const monitor = asRecord(source.monitor);
  const candidate: RecordValue = {};

  copySection(candidate, 'appearance', appearance, ['theme', 'language']);
  copySection(candidate, 'workspace', workspace, [
    'restoreLayout',
    'aiInspectorOpen',
    'namedWorkspaces',
    'activeWorkspaceId',
    'showTabNumber',
    'switchTabOnHover',
    'activityRailItems',
  ]);
  copySection(candidate, 'privacy', privacy, [
    'connectionHistoryEnabled',
    'commandHistoryEnabled',
    'hideAddresses',
  ]);
  copySection(candidate, 'shortcuts', shortcuts, ['bindings']);
  copySection(candidate, 'terminal', terminal, [
    'autoReconnectTerminal',
    'restoreTerminalSessionOnReload',
    'commandSuggestionsEnabled',
    'dragDropBehavior',
    'shortcutBarEnabled',
    'shortcutBarButtons',
  ]);
  if (visual) {
    const portableVisual: RecordValue = {};
    if (typeof visual.themeId === 'string') portableVisual.themeId = visual.themeId;
    if (background && background.kind !== 'image' && !background.assetId)
      portableVisual.background = background;
    if (Object.keys(portableVisual).length) {
      const terminalSection = asRecord(candidate.terminal) ?? {};
      terminalSection.visual = portableVisual;
      candidate.terminal = terminalSection;
    }
  }
  copySection(candidate, 'fileManager', fileManager, [
    'showHiddenFiles',
    'columns',
    'localSort',
    'remoteSort',
    'remoteAddressBookmarks',
  ]);
  copySection(candidate, 'monitor', monitor, [
    'terminalInformationItems',
    'remoteMonitorBarEnabled',
    'remoteMonitorBarItems',
  ]);

  const parsed = updateSettingsSchema.safeParse(candidate);
  if (!parsed.success)
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `Portable settings are invalid: ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
      400,
    );
  return parsed.data;
}

function settingsFromElectermConfig(value: unknown): UpdateSettingsInput {
  const config = asRecord(value);
  if (!config) return {};
  const candidate: RecordValue = {};
  const set = (path: string, next: unknown) => {
    if (next === undefined) return;
    setPath(candidate, path, next);
  };
  const theme = config.theme;
  if (theme === 'dark' || theme === 'light' || theme === 'system') set('appearance.theme', theme);
  const language = electermLanguage(config.language);
  if (language) set('appearance.language', language);
  if (typeof config.hideIP === 'boolean') set('privacy.hideAddresses', config.hideIP);
  if (typeof config.disableConnectionHistory === 'boolean')
    set('privacy.connectionHistoryEnabled', !config.disableConnectionHistory);
  if (typeof config.switchTabOnHover === 'boolean')
    set('workspace.switchTabOnHover', config.switchTabOnHover);
  const activityRailItems = normalizeActivityRailItems(config.leftSideBarIcons);
  if (activityRailItems) set('workspace.activityRailItems', activityRailItems);
  if (typeof config.disableTabIndex === 'boolean')
    set('workspace.showTabNumber', !config.disableTabIndex);
  if (typeof config.autoReconnectTerminal === 'boolean')
    set('terminal.autoReconnectTerminal', config.autoReconnectTerminal);
  if (typeof config.screenReaderMode === 'boolean')
    set('terminal.screenReaderMode', config.screenReaderMode);
  if (typeof config.restoreTerminalSessionOnReload === 'boolean')
    set('terminal.restoreTerminalSessionOnReload', config.restoreTerminalSessionOnReload);
  if (typeof config.showCmdSuggestions === 'boolean')
    set('terminal.commandSuggestionsEnabled', config.showCmdSuggestions);
  if (['ask', 'upload', 'path-insert'].includes(String(config.dragDropBehavior)))
    set('terminal.dragDropBehavior', config.dragDropBehavior);
  if (typeof config.disableShortcutBar === 'boolean')
    set('terminal.shortcutBarEnabled', !config.disableShortcutBar);
  if (typeof config.showHiddenFilesOnSftpStart === 'boolean')
    set('fileManager.showHiddenFiles', config.showHiddenFilesOnSftpStart);
  if (typeof config.defaultEditor === 'string')
    set('fileManager.externalEditor', config.defaultEditor);
  if (typeof config.autoRefreshWhenSwitchToSftp === 'boolean')
    set('fileManager.refreshOnFocus', config.autoRefreshWhenSwitchToSftp);
  if (typeof config.sftpPathFollowSsh === 'boolean')
    set('fileManager.followTerminalCwd', config.sftpPathFollowSsh);
  if (typeof config.sshSftpSplitView === 'boolean')
    set('fileManager.sshSplitView', config.sshSftpSplitView);

  const terminalItems = normalizeTerminalInformationItems(config.terminalInfos);
  if (terminalItems) set('monitor.terminalInformationItems', terminalItems);
  if (typeof config.remoteMonitorBarEnabled === 'boolean')
    set('monitor.remoteMonitorBarEnabled', config.remoteMonitorBarEnabled);
  const monitorItems = normalizeRemoteMonitorItems(config.remoteMonitorBarItems);
  if (monitorItems) set('monitor.remoteMonitorBarItems', monitorItems);
  const columns = normalizeFileColumns(config.filePropsEnabled);
  if (columns) set('fileManager.columns', columns);

  const parsed = updateSettingsSchema.safeParse(candidate);
  if (!parsed.success)
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `Electerm settings are invalid: ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
      400,
    );
  return parsed.data;
}

function electermStartupBookmarkSourceIds(value: unknown): string[] | null {
  const config = asRecord(value);
  if (!config || !Array.isArray(config.onStartSessions)) return null;
  return stringArray(config.onStartSessions).slice(0, 20);
}

function settingsPatchWithImportedStartupBookmarks(
  settings: SourceSettings,
  targets: Map<string, string>,
  tree: ReturnType<BookmarkTreeService['snapshot']>,
): UpdateSettingsInput {
  if (!settings.startupBookmarkSourceIds) return settings.patch;
  const existingBookmarkIds = new Set(tree.bookmarks.map(({ id }) => id));
  const startupSessions = [
    ...new Set(
      settings.startupBookmarkSourceIds.flatMap((sourceId) => {
        const mapped = targets.get(mappingKey('sshBookmark', sourceId));
        if (mapped) return [mapped];
        return existingBookmarkIds.has(sourceId) ? [sourceId] : [];
      }),
    ),
  ];
  return updateSettingsSchema.parse({
    ...settings.patch,
    workspace: { ...settings.patch.workspace, startupSessions },
  });
}

function desktopPreferencesFromElectermConfig(value: unknown): DesktopWindowPreferencesPatch {
  const config = asRecord(value);
  if (!config) return {} as DesktopWindowPreferencesPatch;
  const candidate: RecordValue = {};
  if (typeof config.hotkey === 'string') candidate.globalHotkey = config.hotkey;
  if (typeof config.useSystemTitleBar === 'boolean')
    candidate.titleBarStyle = config.useSystemTitleBar ? 'system' : 'custom';
  if (typeof config.opacity === 'number') candidate.opacity = config.opacity;
  if (typeof config.zoomFactor === 'number') candidate.zoomFactor = config.zoomFactor;
  if (typeof config.allowMultiInstance === 'boolean')
    candidate.allowMultiInstance = config.allowMultiInstance;
  if (typeof config.confirmBeforeExit === 'boolean')
    candidate.confirmBeforeExit = config.confirmBeforeExit;
  return parseDesktopPatch(candidate, 'Electerm desktop settings');
}

function sanitizePortableDesktopPreferences(value: unknown): DesktopWindowPreferencesPatch {
  const source = asRecord(value);
  if (!source)
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'Portable desktop preferences must be an object',
      400,
    );
  const candidate: RecordValue = {};
  for (const key of [
    'titleBarStyle',
    'opacity',
    'zoomFactor',
    'globalHotkey',
    'allowMultiInstance',
    'confirmBeforeExit',
  ])
    if (Object.hasOwn(source, key)) candidate[key] = source[key];
  return parseDesktopPatch(candidate, 'Portable desktop preferences');
}

function parseDesktopPatch(value: RecordValue, label: string): DesktopWindowPreferencesPatch {
  if (!Object.keys(value).length) return {} as DesktopWindowPreferencesPatch;
  const parsed = desktopWindowPreferencesPatchSchema.safeParse(value);
  if (!parsed.success)
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `${label} are invalid: ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
      400,
    );
  return parsed.data;
}

function sourceCredentialMetadataCount(source: RecordValue): number {
  const value = asRecord(source._axterm)?.credentialMetadata;
  if (value === undefined) return 0;
  const metadata = records(value, 'credentialMetadata');
  for (const [index, record] of metadata.entries()) {
    const sensitiveKey = Object.keys(record).find((key) =>
      /secret|password|passphrase|private.?key|certificate|token|credentialref|\bvalue\b/iu.test(
        key,
      ),
    );
    if (sensitiveKey)
      throw new ApplicationError(
        'VALIDATION_ERROR',
        `credentialMetadata[${index}] contains forbidden field ${sensitiveKey}`,
        400,
      );
    const kind = optionalText(record.kind, 64);
    const label = optionalText(record.label, 100);
    const createdAt = optionalText(record.createdAt, 64);
    const updatedAt = optionalText(record.updatedAt, 64);
    if (
      !kind ||
      !label ||
      !createdAt ||
      !updatedAt ||
      !Number.isFinite(Date.parse(createdAt)) ||
      !Number.isFinite(Date.parse(updatedAt))
    )
      throw new ApplicationError(
        'VALIDATION_ERROR',
        `credentialMetadata[${index}] is invalid`,
        400,
      );
  }
  return metadata.length;
}

function copySection(
  target: RecordValue,
  name: string,
  source: RecordValue | undefined,
  keys: string[],
) {
  if (!source) return;
  const section = Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  );
  if (Object.keys(section).length) target[name] = section;
}

function setPath(target: RecordValue, path: string, value: unknown) {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const child = asRecord(cursor[part]) ?? {};
    cursor[part] = child;
    cursor = child;
  }
  cursor[parts.at(-1)!] = value;
}

function electermLanguage(value: unknown): Settings['appearance']['language'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLocaleLowerCase().replaceAll('_', '-');
  if (normalized === 'zh-cn' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  return undefined;
}

function normalizeTerminalInformationItems(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set([
    'sysinfo',
    'cpu',
    'memory',
    'uptime',
    'users',
    'network',
    'disks',
    'activities',
  ]);
  return [
    ...new Set(
      value.flatMap((item) => {
        const mapped = item === 'mem' ? 'memory' : item;
        return typeof mapped === 'string' && allowed.has(mapped) ? [mapped] : [];
      }),
    ),
  ];
}

function normalizeRemoteMonitorItems(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set([
    'hostname',
    'cpu',
    'cpuHistory',
    'memory',
    'upload',
    'download',
    'uptime',
    'users',
    'disks',
  ]);
  return [
    ...new Set(
      value.flatMap((item) => (typeof item === 'string' && allowed.has(item) ? [item] : [])),
    ),
  ];
}

function normalizeActivityRailItems(
  value: unknown,
): Settings['workspace']['activityRailItems'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<string>(ACTIVITY_RAIL_ITEM_IDS);
  const normalized = [
    ...new Set(
      value.flatMap((item) => (typeof item === 'string' && allowed.has(item) ? [item] : [])),
    ),
  ];
  return normalized.length ? (normalized as Settings['workspace']['activityRailItems']) : undefined;
}

function normalizeFileColumns(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const map: Record<string, string> = {
    name: 'name',
    size: 'size',
    modifyTime: 'modifiedAt',
    accessTime: 'accessedAt',
    owner: 'owner',
    group: 'group',
    mode: 'mode',
    path: 'path',
    extension: 'extension',
  };
  const columns = [
    ...new Set(value.flatMap((item) => (typeof item === 'string' && map[item] ? [map[item]] : []))),
  ];
  if (!columns.includes('name')) columns.unshift('name');
  else if (columns[0] !== 'name') {
    columns.splice(columns.indexOf('name'), 1);
    columns.unshift('name');
  }
  return columns.slice(0, 9);
}

function omittedElectermConfigFields(value: unknown, mappedFields: string[]): string[] {
  const config = asRecord(value);
  if (!config) return [];
  const mappedRoots = new Set(
    mappedFields.map((path) => {
      const value = path.startsWith('desktop.') ? path.slice('desktop.'.length) : path;
      const mapping: Record<string, string> = {
        theme: 'theme',
        language: 'language',
        hideAddresses: 'hideIP',
        connectionHistoryEnabled: 'disableConnectionHistory',
        switchTabOnHover: 'switchTabOnHover',
        startupSessions: 'onStartSessions',
        activityRailItems: 'leftSideBarIcons',
        showTabNumber: 'disableTabIndex',
        autoReconnectTerminal: 'autoReconnectTerminal',
        screenReaderMode: 'screenReaderMode',
        restoreTerminalSessionOnReload: 'restoreTerminalSessionOnReload',
        commandSuggestionsEnabled: 'showCmdSuggestions',
        dragDropBehavior: 'dragDropBehavior',
        shortcutBarEnabled: 'disableShortcutBar',
        showHiddenFiles: 'showHiddenFilesOnSftpStart',
        externalEditor: 'defaultEditor',
        refreshOnFocus: 'autoRefreshWhenSwitchToSftp',
        followTerminalCwd: 'sftpPathFollowSsh',
        sshSplitView: 'sshSftpSplitView',
        terminalInformationItems: 'terminalInfos',
        remoteMonitorBarEnabled: 'remoteMonitorBarEnabled',
        remoteMonitorBarItems: 'remoteMonitorBarItems',
        columns: 'filePropsEnabled',
        globalHotkey: 'hotkey',
        titleBarStyle: 'useSystemTitleBar',
        opacity: 'opacity',
        zoomFactor: 'zoomFactor',
        allowMultiInstance: 'allowMultiInstance',
        confirmBeforeExit: 'confirmBeforeExit',
      };
      return mapping[value.split('.').at(-1)!];
    }),
  );
  return Object.entries(config)
    .filter(
      ([key, item]) => !mappedRoots.has(key) && item !== undefined && item !== null && item !== '',
    )
    .map(([key]) => `config.${key}`)
    .slice(0, 64);
}

function leafPaths(value: unknown, prefix = ''): string[] {
  const record = asRecord(value);
  if (!record) return prefix ? [prefix] : [];
  return Object.entries(record).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return asRecord(child) ? leafPaths(child, path) : [path];
  });
}

function matchesPatch(current: unknown, patch: unknown): boolean {
  const patchRecord = asRecord(patch);
  if (!patchRecord) return sameValue(current, patch);
  const currentRecord = asRecord(current);
  if (!currentRecord) return false;
  return Object.entries(patchRecord).every(([key, value]) =>
    matchesPatch(currentRecord[key], value),
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableHash(left) === stableHash(right);
}

function sourceFingerprint(value: RecordValue) {
  return stableHash(redactFingerprintValue(value));
}

function redactFingerprintValue(value: unknown, key = ''): unknown {
  if (/password|passphrase|private.?key|certificate|secret|token/iu.test(key))
    return value === undefined || value === null || value === '' ? null : '[present]';
  if (key.toLocaleLowerCase() === 'proxy' && typeof value === 'string') {
    try {
      const proxy = new URL(value);
      proxy.password = '';
      return proxy.toString();
    } catch {
      return value ? '[configured]' : null;
    }
  }
  if (Array.isArray(value)) return value.map((item) => redactFingerprintValue(item));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([childKey, childValue]) => [
      childKey,
      redactFingerprintValue(childValue, childKey),
    ]),
  );
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : fallback;
}

function color(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.flatMap((item) => (optionalText(item, 160) ? [String(item)] : []))),
  ].slice(0, entityLimit);
}

function groupParents(groups: RecordValue[]): Map<string, string> {
  const parents = new Map<string, string>();
  for (const group of groups) {
    const parentId = sourceId(group);
    if (!parentId) continue;
    for (const childId of stringArray(group.bookmarkGroupIds))
      if (childId !== parentId && !parents.has(childId)) parents.set(childId, parentId);
  }
  return parents;
}

function bookmarkParents(groups: RecordValue[]): Map<string, string> {
  const parents = new Map<string, string>();
  for (const group of groups) {
    const groupId = sourceId(group);
    if (!groupId) continue;
    for (const bookmarkId of stringArray(group.bookmarkIds))
      if (!parents.has(bookmarkId)) parents.set(bookmarkId, groupId);
  }
  return parents;
}

function normalizeGroupId(value: string | undefined): string | null {
  return !value || value === 'default' ? null : value;
}

function mappingKey(kind: MappingKind, sourceId: string) {
  return `${kind}:${sourceId}`;
}

function mappingAction(
  kind: MappingKind,
  sourceId: string,
  fingerprint: string,
  mappings: Map<string, ImportMapping>,
  targetIds: Map<MappingKind, Set<string>>,
  acceptsTargetIdentity = false,
): ElectermMigrationAction {
  const mapping = mappings.get(mappingKey(kind, sourceId));
  if (!mapping || !targetIds.get(kind)?.has(mapping.target_id))
    return acceptsTargetIdentity && targetIds.get(kind)?.has(sourceId) ? 'unchanged' : 'create';
  return mapping.fingerprint === fingerprint ? 'unchanged' : 'skip';
}

function mappingReason(
  kind: MappingKind,
  sourceId: string,
  action: ElectermMigrationAction,
  mappings: Map<string, ImportMapping>,
) {
  return action === 'skip' && mappings.has(mappingKey(kind, sourceId))
    ? ['Source item changed after an earlier import; existing Axterm data was retained.']
    : [];
}

function entryForGroup(
  group: SourceGroup,
  mappings: Map<string, ImportMapping>,
): ElectermMigrationEntry {
  return {
    key: mappingKey('group', group.sourceId),
    kind: 'group',
    sourceId: group.sourceId,
    name: group.name,
    action: group.action,
    reasons: [
      ...mappingReason('group', group.sourceId, group.action, mappings),
      ...group.reasons,
    ].slice(0, 16),
    mappedFields: ['title', 'color', 'description', 'bookmarkGroupIds', 'bookmarkIds'],
    omittedFields: [],
  };
}

function entryForProfile(
  profile: SourceProfile,
  mappings: Map<string, ImportMapping>,
): ElectermMigrationEntry {
  const invalidPrivateKey =
    secretText(profile.source.privateKey, 131_072) &&
    !privateKeyContents(profile.source.privateKey);
  return {
    key: mappingKey('profile', profile.sourceId),
    kind: 'profile',
    sourceId: profile.sourceId,
    name: profile.name,
    action: profile.action,
    reasons: [
      ...mappingReason('profile', profile.sourceId, profile.action, mappings),
      ...profile.reasons,
    ].slice(0, 16),
    mappedFields: [
      'name',
      'isDefault',
      'username',
      'password',
      ...(invalidPrivateKey ? [] : ['privateKey']),
      ...(invalidPrivateKey && secretText(profile.source.passphrase, 131_072)
        ? []
        : ['passphrase']),
      'certificate',
      'telnet',
      'vnc',
      'rdp',
      'ftp',
    ],
    omittedFields: invalidPrivateKey
      ? ['privateKey', ...(secretText(profile.source.passphrase, 131_072) ? ['passphrase'] : [])]
      : [],
  };
}

function entryForBookmark(
  bookmark: SourceBookmark,
  mappings: Map<string, ImportMapping>,
): ElectermMigrationEntry {
  const supported = bookmark.protocol === 'ssh' && !!optionalText(bookmark.source.host, 253);
  return {
    key: `${bookmark.protocol === 'ssh' ? 'sshBookmark' : 'bookmark'}:${bookmark.sourceId}`,
    kind: bookmark.protocol === 'ssh' ? 'sshBookmark' : 'bookmark',
    sourceId: bookmark.sourceId,
    name: bookmark.name,
    action: bookmark.action,
    reasons: supported
      ? [
          ...mappingReason('sshBookmark', bookmark.sourceId, bookmark.action, mappings),
          ...bookmark.reasons,
        ].slice(0, 16)
      : [
          bookmark.protocol === 'ssh'
            ? 'SSH bookmark has no valid host.'
            : `${bookmark.protocol.toUpperCase()} connection details wait for Phase 17 and were not imported.`,
        ],
    mappedFields: bookmark.mappedFields,
    omittedFields: bookmark.omittedFields,
  };
}

function entryForQuickCommand(
  command: SourceQuickCommand,
  mappings: Map<string, ImportMapping>,
): ElectermMigrationEntry {
  return {
    key: mappingKey('quickCommand', command.sourceId),
    kind: 'quickCommand',
    sourceId: command.sourceId,
    name: command.name,
    action: command.action,
    reasons:
      command.action === 'skip' &&
      !optionalText(command.source.command, 16_384) &&
      !records(command.source.commands, 'commands').some((step) =>
        Boolean(optionalText(step.command, 16_384)),
      )
        ? ['Quick Command has no bounded command text.']
        : [
            ...mappingReason('quickCommand', command.sourceId, command.action, mappings),
            ...command.reasons,
          ].slice(0, 16),
    mappedFields: [
      'name',
      'command',
      'commands',
      'description',
      'labels',
      'shortcut',
      'inputOnly',
      'clickCount',
    ],
    omittedFields: [],
  };
}

function entryForSettings(settings: SourceSettings): ElectermMigrationEntry {
  return {
    key: 'dataset:settings',
    kind: 'settings',
    sourceId: 'settings',
    name: 'Application settings',
    action: settings.action,
    reasons:
      settings.action === 'skip'
        ? ['The file contains no supported portable setting fields.']
        : settings.omittedFields.length
          ? ['Device-bound and entity-reference settings remain on the current installation.']
          : [],
    mappedFields: settings.mappedFields.slice(0, 64),
    omittedFields: settings.omittedFields.slice(0, 64),
  };
}

function entryForCredentialMetadata(count: number): ElectermMigrationEntry {
  return {
    key: 'dataset:credentialMetadata',
    kind: 'settings',
    sourceId: 'credentialMetadata',
    name: `${count} credential metadata record${count === 1 ? '' : 's'}`,
    action: 'skip',
    reasons: [
      'Credential values are intentionally absent; current application-local Vault entries remain unchanged.',
    ],
    mappedFields: ['kind', 'label', 'createdAt', 'updatedAt'],
    omittedFields: ['secret'],
  };
}

function unsupportedDatasetEntries(source: RecordValue): ElectermMigrationEntry[] {
  const names = ['terminalThemes', 'addressBookmarks', 'workspaces', 'triggers', 'widgets'];
  const entries = names.flatMap((name) => {
    const value = source[name];
    if (!Array.isArray(value) || !value.length) return [];
    return [
      {
        key: `dataset:${name}`,
        kind: 'settings' as const,
        sourceId: name,
        name,
        action: 'skip' as const,
        reasons: [`${name} import is assigned to its later parity phase.`],
        mappedFields: [],
        omittedFields: [name],
      },
    ];
  });
  return entries;
}

function countEntries(
  entries: ElectermMigrationEntry[],
  credentialMetadata = 0,
): ElectermMigrationCounts {
  return {
    create: entries.filter(({ action }) => action === 'create').length,
    unchanged: entries.filter(({ action }) => action === 'unchanged').length,
    skip: entries.filter(({ action }) => action === 'skip').length,
    groups: entries.filter(({ kind, action }) => kind === 'group' && action !== 'skip').length,
    profiles: entries.filter(({ kind, action }) => kind === 'profile' && action !== 'skip').length,
    sshBookmarks: entries.filter(({ kind, action }) => kind === 'sshBookmark' && action !== 'skip')
      .length,
    quickCommands: entries.filter(
      ({ kind, action }) => kind === 'quickCommand' && action !== 'skip',
    ).length,
    settings: entries.filter(({ sourceId, action }) => sourceId === 'settings' && action !== 'skip')
      .length,
    credentialMetadata,
  };
}

function makeEntryKeysUnique(entries: ElectermMigrationEntry[]) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const count = (counts.get(entry.key) ?? 0) + 1;
    counts.set(entry.key, count);
    if (count > 1) entry.key = `${entry.key.slice(0, 288)}#${count}`;
  }
}

function mappedBookmarkFields(source: RecordValue, protocol: string): string[] {
  if (protocol !== 'ssh') return ['title', 'description', 'color'];
  const supported = new Set([
    'id',
    'type',
    'title',
    'name',
    'host',
    'port',
    'username',
    'authType',
    'profile',
    'description',
    'color',
    'favorite',
    'proxy',
    'compress',
    'compression',
    'useSshAgent',
    'quickCommands',
    'triggers',
  ]);
  const usesProfile = text(source.authType, '', 20) === 'profiles';
  if (!usesProfile && secretText(source.password, 131_072)) supported.add('password');
  if (!usesProfile && privateKeyContents(source.privateKey)) {
    supported.add('privateKey');
    if (secretText(source.passphrase, 131_072)) supported.add('passphrase');
  }
  return Object.keys(source)
    .filter((key) => supported.has(key))
    .slice(0, 64);
}

function bookmarkQuickCommands(value: unknown): Array<{ name: string; command: string }> {
  return records(value, 'bookmark quickCommands')
    .slice(0, 64)
    .flatMap((item) => {
      const name = optionalText(item.name, 60);
      const command = optionalText(item.command, 16_384);
      return name && command ? [{ name, command }] : [];
    });
}

function bookmarkTriggers(value: unknown) {
  return records(value, 'bookmark triggers')
    .slice(0, 32)
    .flatMap((item) => {
      const match = asRecord(item.match);
      const action = asRecord(item.action);
      const candidate = bookmarkTriggerSchema.safeParse({
        id: randomUUID(),
        name: optionalText(item.name, 100),
        enabled: item.enabled !== false,
        match: {
          type: match?.type === 'regex' ? 'regex' : 'text',
          value: optionalText(match?.value, 512),
          caseSensitive: match?.caseSensitive === true,
        },
        action: {
          type: action?.type === 'notify' ? 'notify' : 'send',
          value: action?.type === 'notify' ? '' : (secretText(action?.value, 16_384) ?? ''),
        },
        sendEnter: item.sendEnter !== false,
        mode: ['repeat', 'once', 'cooldown'].includes(String(item.mode)) ? item.mode : 'cooldown',
        cooldownMs: integer(item.cooldownMs, 500, 0, 600_000),
      });
      if (!candidate.success) return [];
      try {
        validateTriggerPattern({ match: candidate.data.match });
        return [candidate.data];
      } catch {
        return [];
      }
    });
}

function omittedBookmarkFields(source: RecordValue, protocol: string): string[] {
  if (protocol !== 'ssh')
    return Object.keys(source)
      .filter((key) => key !== 'id')
      .slice(0, 64);
  const mapped = new Set(mappedBookmarkFields(source, protocol));
  return Object.entries(source)
    .filter(
      ([key, value]) => !mapped.has(key) && value !== undefined && value !== null && value !== '',
    )
    .map(([key]) => key)
    .slice(0, 64);
}

function quickCommandInput(command: SourceQuickCommand) {
  const legacyCommand = optionalText(command.source.command, 16_384);
  const commands = records(command.source.commands, 'commands')
    .slice(0, 32)
    .flatMap((step) => {
      const textValue = optionalText(step.command, 16_384);
      if (!textValue) return [];
      const delay = Number(step.delay ?? step.delayMs ?? 100);
      return [
        {
          id: randomUUID(),
          name: text(step.name, '', 100),
          command: textValue,
          delayMs: Number.isSafeInteger(delay) && delay >= 1 && delay <= 65_535 ? delay : 100,
        },
      ];
    });
  if (!commands.length && legacyCommand)
    commands.push({ id: randomUUID(), name: '', command: legacyCommand, delayMs: 100 });
  return {
    groupId: null,
    name: command.targetName,
    command: commands[0]?.command ?? '',
    commands,
    description: text(command.source.description, '', 2_000),
    tags: stringArray(command.source.labels ?? command.source.tags).slice(0, 32),
    shortcut: optionalText(command.source.shortcut, 100),
    inputOnly: command.source.inputOnly === true,
    clickCount: Math.max(0, Math.floor(Number(command.source.clickCount) || 0)),
  };
}

function uniqueName(source: string, used: Set<string>, max: number): string {
  const base = source.slice(0, max);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const tail = ` (${suffix})`;
    candidate = `${base.slice(0, Math.max(1, max - tail.length))}${tail}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function validateGroupGraph(
  groups: SourceGroup[],
  mappings: Map<string, ImportMapping>,
  targetIds: Map<MappingKind, Set<string>>,
) {
  const addReason = (group: SourceGroup, reason: string) => {
    group.action = 'skip';
    if (!group.reasons.includes(reason)) group.reasons.push(reason);
  };
  const counts = new Map<string, number>();
  for (const group of groups) counts.set(group.sourceId, (counts.get(group.sourceId) ?? 0) + 1);
  for (const group of groups)
    if ((counts.get(group.sourceId) ?? 0) > 1)
      addReason(group, 'Duplicate Electerm group id; this group was not imported.');

  const byId = new Map(
    groups
      .filter((group) => counts.get(group.sourceId) === 1)
      .map((group) => [group.sourceId, group]),
  );
  const state = new Map<string, 'visiting' | 'visited'>();
  const stack: SourceGroup[] = [];
  const visit = (group: SourceGroup) => {
    const current = state.get(group.sourceId);
    if (current === 'visited') return;
    if (current === 'visiting') {
      const start = stack.findIndex(({ sourceId }) => sourceId === group.sourceId);
      for (const member of stack.slice(Math.max(0, start)))
        addReason(member, 'Electerm group hierarchy contains a cycle.');
      return;
    }
    state.set(group.sourceId, 'visiting');
    stack.push(group);
    if (group.parentSourceId) {
      const parent = byId.get(group.parentSourceId);
      if (parent) visit(parent);
      else if (!hasMappedTarget('group', group.parentSourceId, mappings, targetIds))
        addReason(group, 'Electerm parent group is missing.');
    }
    stack.pop();
    state.set(group.sourceId, 'visited');
  };
  for (const group of groups) visit(group);

  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (group.action !== 'create' || !group.parentSourceId) continue;
      const parent = byId.get(group.parentSourceId);
      if (
        parent?.action === 'skip' &&
        !hasMappedTarget('group', parent.sourceId, mappings, targetIds)
      ) {
        addReason(group, 'Parent group cannot be imported safely.');
        changed = true;
      }
    }
  }
}

function markDuplicateIds<
  T extends {
    sourceId: string;
    action: ElectermMigrationAction;
    reasons: string[];
  },
>(items: T[], label: string) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
  for (const item of items) {
    if ((counts.get(item.sourceId) ?? 0) < 2) continue;
    item.action = 'skip';
    item.reasons.push(`Duplicate Electerm ${label} id; this item was not imported.`);
  }
}

function validateBookmarkReferences(
  bookmarks: SourceBookmark[],
  groups: SourceGroup[],
  profiles: SourceProfile[],
  mappings: Map<string, ImportMapping>,
  targetIds: Map<MappingKind, Set<string>>,
) {
  const groupById = new Map(groups.map((group) => [group.sourceId, group]));
  const profileById = new Map(profiles.map((profile) => [profile.sourceId, profile]));
  const available = (
    kind: 'group' | 'profile',
    sourceId: string,
    source: SourceGroup | SourceProfile | undefined,
  ) =>
    hasMappedTarget(kind, sourceId, mappings, targetIds) ||
    source?.action === 'create' ||
    source?.action === 'unchanged';

  for (const bookmark of bookmarks) {
    if (bookmark.action === 'skip') continue;
    if (
      bookmark.groupSourceId &&
      !available('group', bookmark.groupSourceId, groupById.get(bookmark.groupSourceId))
    ) {
      bookmark.action = 'skip';
      bookmark.reasons.push('Referenced Electerm bookmark group cannot be imported safely.');
    }
    if (
      bookmark.profileSourceId &&
      !available('profile', bookmark.profileSourceId, profileById.get(bookmark.profileSourceId))
    ) {
      bookmark.action = 'skip';
      bookmark.reasons.push('Referenced Electerm Connection Profile is unavailable.');
    }
  }
}

function hasMappedTarget(
  kind: MappingKind,
  sourceId: string,
  mappings: Map<string, ImportMapping>,
  targetIds: Map<MappingKind, Set<string>>,
) {
  const mapping = mappings.get(mappingKey(kind, sourceId));
  return !!mapping && !!targetIds.get(kind)?.has(mapping.target_id);
}

function topologicalGroups(groups: SourceGroup[]): SourceGroup[] {
  const byId = new Map(groups.map((group) => [group.sourceId, group]));
  const result: SourceGroup[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (group: SourceGroup) => {
    if (visited.has(group.sourceId)) return;
    if (visiting.has(group.sourceId)) return;
    visiting.add(group.sourceId);
    const parent = group.parentSourceId ? byId.get(group.parentSourceId) : undefined;
    if (parent) visit(parent);
    visiting.delete(group.sourceId);
    visited.add(group.sourceId);
    result.push(group);
  };
  for (const group of groups) visit(group);
  return result;
}

function groupDepth(id: string, groups: Array<{ id: string; parentId: string | null }>) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  let depth = 1;
  let current = byId.get(id)?.parentId ?? null;
  const seen = new Set([id]);
  while (current && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = byId.get(current)?.parentId ?? null;
  }
  return depth;
}

async function writeAtomic(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readBoundedRegularFile(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ApplicationError('INVALID_STATE', 'Electerm data source must be a regular file');
  if (before.size > importMaxBytes)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Electerm data file exceeds 8 MiB', 413);
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new ApplicationError('CONFLICT', 'Electerm data source changed during authorization');
    const bytes = Buffer.allocUnsafe(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new ApplicationError('CONFLICT', 'Electerm data source changed while being read');
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}
