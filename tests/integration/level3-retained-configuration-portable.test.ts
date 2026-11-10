import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { remoteErrorOf } from '@axterm/plugin-api';
import { axtermConfigurationDocumentSchema } from '@axterm/plugin-api/configuration-portable';
import {
  namedWorkspaceSchema,
  updateSettingsSchema,
  type UpdateSettingsInput,
} from '@axterm/plugin-api/configuration';
import {
  connectionProfileInputSchema,
  createHostSchema,
  ftpBookmarkSettingsSchema,
  rdpBookmarkSettingsSchema,
  serialBookmarkSettingsSchema,
  spiceBookmarkSettingsSchema,
  telnetBookmarkSettingsSchema,
  vncBookmarkSettingsSchema,
  webBookmarkSettingsSchema,
} from '@axterm/plugin-api/catalog';
import {
  DEFAULT_TERMINAL_BACKGROUND,
  terminalProfileInputSchema,
  terminalThemeInputSchema,
} from '@axterm/plugin-api/terminals';
import { tunnelProfileInputSchema } from '@axterm/plugin-api/connections';
import { triggerRuleInputSchema } from '@axterm/plugin-api/automation';
import { AXTERM_TERMINAL_THEMES } from '../../packages/plugins/terminals/src/application/theme-presets.ts';
import { AxtermConfigurationSyncDataSource } from '../../packages/plugins/configuration/src/application/sync-source.ts';
import { stableHash } from '../../packages/plugins/configuration/src/application/sync-hash.ts';
import { configurationFixture } from '../fixtures/level3-configuration.ts';
const etagFor = (version: number) => '"v' + version + '"';
const fileAddressBookmarkSchema = updateSettingsSchema.shape.fileManager
  .unwrap()
  .shape.remoteAddressBookmarks.unwrap().element;
async function fixture(configurationPath?: string) {
  const f = await configurationFixture(true);
  const managed = f.managed!;
  const directory = join(managed.home, 'configuration');
  await mkdir(directory, { mode: 0o700 });
  const target = configurationPath ?? join(directory, 'configuration.json');
  const saveGrant = await managed.capabilities.registry.createTrustedPath(target, 'save-target', [
    'write',
  ]);
  const catalog = f.ctx.catalog.configurationImport!;
  return {
    ...f,
    directory,
    target,
    saveGrantId: saveGrant.grantId,
    service: f.app,
    bookmarks: catalog.bookmarks,
    profiles: catalog.profiles,
    commands: f.ctx.automation.configurationImport!.quickCommands,
    triggers: f.ctx.automation.configurationImport!.triggers,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function readGrant(f: Fixture) {
  return (await f.managed!.capabilities.registry.createTrustedPath(f.target, 'file', ['read']))
    .grantId;
}
function updateSettings(f: Fixture, input: UpdateSettingsInput, etag: string) {
  f.ctx.configurationController.updateSettings(
    randomUUID(),
    updateSettingsSchema.parse(input),
    etag,
  );
  return f.ctx.configuration.getSettings();
}
function createProfile(f: Fixture, input: Parameters<typeof f.ctx.terminalFacts.createProfile>[1]) {
  const receipt = f.ctx.terminalFacts.createProfile(randomUUID(), input);
  return f.ctx.terminalFacts.getProfile(receipt.ids[0]!);
}
function createTheme(f: Fixture, input: Parameters<typeof f.ctx.terminalFacts.createTheme>[1]) {
  const receipt = f.ctx.terminalFacts.createTheme(randomUUID(), input);
  return f.ctx.terminalFacts.listThemes().find((theme) => theme.id === receipt.ids[0])!;
}
describe('Configuration owned portable retained behaviors', () => {
  it('previews a validated in-memory configuration without a File Grant', async () => {
    const context = await fixture();
    const source = context.service.snapshot();
    const preview = context.service.previewDocument(source);

    expect(preview).toMatchObject({
      appVersion: source.appVersion,
      settings: 'preserved',
      canCommit: true,
    });
    expect(preview.bytes).toBeGreaterThan(0);
    expect(preview.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      context.service.previewDocument({ ...source, format: 'untrusted' } as never),
    ).toThrowError(/Invalid Axterm configuration document/u);
  });

  it('uses only selected Axterm sync categories in the same preview/commit transaction', async () => {
    const context = await fixture();
    const source = new AxtermConfigurationSyncDataSource(context.service, 'sync-fixture');
    const remote = source.snapshot(['settings']);
    const settings = remote.categories.settings!;
    const value = structuredClone(settings.value) as {
      settings: ReturnType<typeof context.ctx.configuration.getSettings>;
    };
    value.settings.appearance.theme = 'light';
    settings.value = value;
    settings.hash = stableHash(value);

    const preview = source.preview(remote, ['settings']);
    expect(preview).toMatchObject({ settings: 'will-apply', canCommit: true });
    const result = source.commit(preview.previewId, (apply) => apply());

    expect(result).toMatchObject({ settings: 'applied' });
    expect(context.ctx.configuration.getSettings().appearance.theme).toBe('light');
    let caught: unknown;
    try {
      source.preview(remote, ['bookmarks']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'SYNC_REMOTE_INVALID',
    });
  });

  it('gives dedicated address-bookmark data precedence over settings regardless of selection order', async () => {
    const sourceContext = await fixture();
    const source = new AxtermConfigurationSyncDataSource(sourceContext.service, 'sync-fixture');
    const remote = source.snapshot(['settings', 'addressBookmarks', 'workspaces']);
    const settings = remote.categories.settings!;
    const settingsValue = structuredClone(settings.value) as {
      settings: ReturnType<typeof sourceContext.ctx.configuration.getSettings>;
    };
    settingsValue.settings.fileManager.remoteAddressBookmarks = [];
    settingsValue.settings.workspace.namedWorkspaces = [];
    settingsValue.settings.workspace.activeWorkspaceId = null;
    settings.value = settingsValue;
    settings.hash = stableHash(settingsValue);

    const address = fileAddressBookmarkSchema.parse({
      id: randomUUID(),
      hostId: null,
      path: '/migration/recovered',
    });
    const addressCategory = remote.categories.addressBookmarks!;
    addressCategory.value = { addressBookmarks: [address] };
    addressCategory.count = 1;
    addressCategory.hash = stableHash(addressCategory.value);
    const now = new Date().toISOString();
    const workspace = namedWorkspaceSchema.parse({
      id: randomUUID(),
      name: 'Recovered workspace',
      layout: { section: 'hosts', sidebarOpen: true, tabs: [], activeTerminalId: null },
      createdAt: now,
      updatedAt: now,
    });
    const workspaceSettings = structuredClone(settingsValue.settings.workspace);
    workspaceSettings.namedWorkspaces = [workspace];
    workspaceSettings.activeWorkspaceId = workspace.id;
    const workspaceCategory = remote.categories.workspaces!;
    workspaceCategory.value = { workspace: workspaceSettings };
    workspaceCategory.count = 1;
    workspaceCategory.hash = stableHash(workspaceCategory.value);
    expect(settings.count).toBe(1);
    expect(settings.hash).toBe(stableHash(settings.value));

    for (const categories of [
      ['settings', 'addressBookmarks', 'workspaces'],
      ['workspaces', 'addressBookmarks', 'settings'],
    ] as const) {
      const targetContext = await fixture();
      const target = new AxtermConfigurationSyncDataSource(targetContext.service, 'sync-target');
      const preview = target.preview(structuredClone(remote), categories);
      target.commit(preview.previewId, (apply) => apply());

      expect(
        targetContext.ctx.configuration.getSettings().fileManager.remoteAddressBookmarks,
      ).toEqual([address]);
      expect(targetContext.ctx.configuration.getSettings().workspace).toMatchObject({
        namedWorkspaces: [expect.objectContaining({ id: workspace.id })],
        activeWorkspaceId: workspace.id,
      });
    }
  });

  it('exports an independent structured configuration with all bookmark protocols and no Vault references', async () => {
    const context = await fixture();
    const host = context.ctx.catalog.configurationImport!.hosts.createHost(
      createHostSchema.parse({
        name: 'Production SSH',
        hostname: 'ssh.example.test',
        username: 'operator',
        credentialRef: 'HOST_PASSWORD_REF',
        proxy: {
          mode: 'custom',
          endpoint: {
            url: 'socks5://proxy.example.test',
            username: 'proxy-user',
            credentialRef: 'PROXY_PASSWORD_REF',
          },
        },
      }),
    );
    const groupTree = context.bookmarks.createGroup(
      { name: 'Production' },
      context.bookmarks.snapshot().etag,
    );
    const groupId = groupTree.groups[0]!.id;
    let tree = context.bookmarks.createBookmark(
      { protocol: 'ssh', title: 'Shell', hostId: host.id, groupId },
      groupTree.etag,
    );
    tree = context.bookmarks.createBookmark(
      {
        protocol: 'web',
        title: 'Dashboard',
        hostId: null,
        groupId,
        web: webBookmarkSettingsSchema.parse({ url: 'https://example.test/dashboard' }),
      },
      tree.etag,
    );
    context.bookmarks.createBookmark(
      {
        protocol: 'telnet',
        title: 'Switch console',
        hostId: null,
        groupId,
        telnet: telnetBookmarkSettingsSchema.parse({
          hostname: 'switch.example.test',
          credentialRef: 'TELNET_PASSWORD_REF',
        }),
      },
      tree.etag,
    );
    context.profiles.create(
      connectionProfileInputSchema.parse({
        name: 'Operator profile',
        ssh: { username: 'operator', passwordCredentialRef: 'PROFILE_PASSWORD_REF' },
      }),
    );
    const image = join(context.managed!.home, 'background.png');
    await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
    const imageGrant = await context.managed!.capabilities.registry.createTrustedPath(
      image,
      'file',
      ['read'],
    );
    const importedAsset = await context.assets!.application.import(
      randomUUID(),
      imageGrant.grantId,
      context.ctx.runtimeIdentity.generation,
      new AbortController().signal,
    );
    const settings = context.ctx.configuration.getSettings();
    updateSettings(
      context,
      {
        network: {
          proxy: {
            mode: 'custom',
            endpoint: {
              url: 'http://proxy.example.test',
              username: 'global-user',
              credentialRef: 'GLOBAL_PROXY_REF',
            },
          },
        },
        terminal: {
          visual: {
            background: {
              ...DEFAULT_TERMINAL_BACKGROUND,
              kind: 'image',
              assetId: importedAsset.asset.id,
            },
          },
        },
      },
      etagFor(settings.version),
    );

    const result = await context.service.export(context.saveGrantId);
    const bytes = await readFile(context.target);
    const document = axtermConfigurationDocumentSchema.parse(JSON.parse(bytes.toString('utf8')));
    expect(document.format).toBe('axterm-configuration');
    expect(document).not.toHaveProperty('_axterm');
    expect(document.data.bookmarks.map(({ protocol }) => protocol)).toEqual([
      'ssh',
      'web',
      'telnet',
    ]);
    expect(document.data.bookmarks[2]!.telnet?.credentialRef).toBeNull();
    expect(document.data.hosts[0]).toMatchObject({
      credentialRef: null,
      proxy: { mode: 'inherit' },
    });
    expect(document.data.connectionProfiles[0]!.ssh.passwordCredentialRef).toBeNull();
    const unsafe = structuredClone(document);
    unsafe.data.connectionProfiles[0]!.ssh.passwordCredentialRef = 'FORGED_VAULT_REF';
    expect(axtermConfigurationDocumentSchema.safeParse(unsafe).success).toBe(false);
    expect(document.data.settings.network.proxy).toEqual({ mode: 'direct' });
    expect(document.data.settings.terminal.visual.background.kind).not.toBe('image');
    expect(document.omissions.fields).toEqual(
      expect.arrayContaining([
        'data.hosts[0].credentialRef',
        'data.hosts[0].proxy.endpoint.credentialRef',
        'data.connectionProfiles[0].ssh.passwordCredentialRef',
        'data.bookmarks[2].telnet.credentialRef',
        'data.settings.network.proxy.endpoint.credentialRef',
        'data.settings.terminal.visual.background.assetId',
      ]),
    );
    const text = bytes.toString('utf8');
    for (const reference of [
      'HOST_PASSWORD_REF',
      'PROXY_PASSWORD_REF',
      'PROFILE_PASSWORD_REF',
      'GLOBAL_PROXY_REF',
      'TELNET_PASSWORD_REF',
    ])
      expect(text).not.toContain(reference);
    expect(result).toMatchObject({
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      entityCount: 6,
      omittedFieldCount: document.omissions.fields.length,
    });
    if (process.platform !== 'win32') expect((await stat(context.target)).mode & 0o777).toBe(0o600);
    expect(await readdir(context.directory)).toEqual(['configuration.json']);
  });

  it('round-trips all nine bookmark protocols with mapped jump hosts and no portable credential references', async () => {
    const source = await fixture();
    const host = source.ctx.catalog.configurationImport!.hosts.createHost(
      createHostSchema.parse({
        name: 'Migration jump host',
        hostname: 'jump.example.test',
        username: 'operator',
        credentialRef: 'SSH_SECRET_REF',
      }),
    );
    let tree = source.bookmarks.createGroup(
      { name: 'All protocols' },
      source.bookmarks.snapshot().etag,
    );
    const groupId = tree.groups[0]!.id;
    const inputs: Array<Parameters<typeof source.bookmarks.createBookmark>[0]> = [
      { protocol: 'ssh', title: 'SSH', hostId: host.id },
      { protocol: 'local', title: 'Local', hostId: null },
      {
        protocol: 'telnet',
        title: 'Telnet',
        hostId: null,
        telnet: telnetBookmarkSettingsSchema.parse({
          hostname: 'telnet.example.test',
          port: 2323,
          credentialRef: 'TELNET_SECRET_REF',
        }),
      },
      {
        protocol: 'serial',
        title: 'Serial',
        hostId: null,
        serial: serialBookmarkSettingsSchema.parse({
          path: '/dev/tty.axterm-test',
          baudRate: 115_200,
        }),
      },
      {
        protocol: 'rdp',
        title: 'RDP',
        hostId: null,
        rdp: rdpBookmarkSettingsSchema.parse({
          hostname: 'rdp.example.test',
          username: 'desktop-user',
          desktopWidth: 1_440,
          jumpHostId: host.id,
          credentialRef: 'RDP_SECRET_REF',
        }),
      },
      {
        protocol: 'vnc',
        title: 'VNC',
        hostId: null,
        vnc: vncBookmarkSettingsSchema.parse({
          hostname: 'vnc.example.test',
          viewOnly: true,
          jumpHostId: host.id,
          credentialRef: 'VNC_SECRET_REF',
        }),
      },
      {
        protocol: 'ftp',
        title: 'FTP',
        hostId: null,
        ftp: ftpBookmarkSettingsSchema.parse({
          hostname: 'ftp.example.test',
          port: 2121,
          username: 'file-user',
          credentialRef: 'FTP_SECRET_REF',
        }),
      },
      {
        protocol: 'spice',
        title: 'SPICE',
        hostId: null,
        spice: spiceBookmarkSettingsSchema.parse({
          hostname: 'spice.example.test',
          viewOnly: true,
          jumpHostId: host.id,
          credentialRef: 'SPICE_SECRET_REF',
        }),
      },
      {
        protocol: 'web',
        title: 'Web',
        hostId: null,
        web: webBookmarkSettingsSchema.parse({
          url: 'https://dashboard.example.test/',
          hideAddressBar: true,
        }),
      },
    ];
    for (const input of inputs)
      tree = source.bookmarks.createBookmark({ ...input, groupId }, tree.etag);

    await source.service.export(source.saveGrantId);
    const exported = await readFile(source.target, 'utf8');
    const document = axtermConfigurationDocumentSchema.parse(JSON.parse(exported));
    expect(document.data.bookmarks.map(({ protocol }) => protocol).sort()).toEqual(
      ['ssh', 'local', 'telnet', 'serial', 'rdp', 'vnc', 'ftp', 'spice', 'web'].sort(),
    );
    for (const secret of [
      'SSH_SECRET_REF',
      'TELNET_SECRET_REF',
      'RDP_SECRET_REF',
      'VNC_SECRET_REF',
      'FTP_SECRET_REF',
      'SPICE_SECRET_REF',
    ])
      expect(exported).not.toContain(secret);
    expect(document.data.bookmarks.find(({ protocol }) => protocol === 'rdp')?.rdp).toMatchObject({
      desktopWidth: 1_440,
      jumpHostId: host.id,
      credentialRef: null,
    });

    const target = await fixture(source.target);
    const preview = await target.service.preview(await readGrant(target));
    expect(preview).toMatchObject({
      entityCount: 11,
      counts: { create: 11, conflict: 0 },
      canCommit: true,
    });
    expect(target.service.commit(preview.previewId).counts.create).toBe(11);
    const importedHost = target.ctx.catalog.listHosts()[0]!;
    expect(importedHost.id).not.toBe(host.id);
    expect(importedHost.credentialRef).toBeNull();
    const importedTree = target.bookmarks.snapshot();
    expect(importedTree.groups).toMatchObject([{ name: 'All protocols' }]);
    expect(importedTree.bookmarks.map(({ protocol }) => protocol).sort()).toEqual(
      ['ssh', 'local', 'telnet', 'serial', 'rdp', 'vnc', 'ftp', 'spice', 'web'].sort(),
    );
    expect(
      importedTree.bookmarks.every(({ groupId: id }) => id === importedTree.groups[0]!.id),
    ).toBe(true);
    const byProtocol = new Map(
      importedTree.bookmarks.map((bookmark) => [bookmark.protocol, bookmark]),
    );
    expect(byProtocol.get('ssh')?.hostId).toBe(importedHost.id);
    expect(byProtocol.get('telnet')?.telnet).toMatchObject({ port: 2323, credentialRef: null });
    expect(byProtocol.get('serial')?.serial).toMatchObject({ baudRate: 115_200 });
    expect(byProtocol.get('rdp')?.rdp).toMatchObject({
      desktopWidth: 1_440,
      jumpHostId: importedHost.id,
      credentialRef: null,
    });
    expect(byProtocol.get('vnc')?.vnc).toMatchObject({
      viewOnly: true,
      jumpHostId: importedHost.id,
      credentialRef: null,
    });
    expect(byProtocol.get('ftp')?.ftp).toMatchObject({ port: 2121, credentialRef: null });
    expect(byProtocol.get('spice')?.spice).toMatchObject({
      viewOnly: true,
      jumpHostId: importedHost.id,
      credentialRef: null,
    });
    expect(byProtocol.get('web')?.web).toMatchObject({ hideAddressBar: true });
    const repeated = await target.service.preview(await readGrant(target));
    expect(repeated.counts).toMatchObject({ create: 0, unchanged: 11, conflict: 0 });
  });

  it('round-trips an independent configuration between 8 and 16 MiB', async () => {
    const source = await fixture();
    const command = 'x'.repeat(16_384);
    const now = new Date().toISOString();
    // Seed through the production batch path so this test measures large-file
    // roundtrip, not repeated snapshots of a growing setup tree.
    source.ctx.automation.importQuickCommands(
      {
        groups: [],
        commands: Array.from({ length: 60 }, (_, index) => ({
          id: randomUUID(),
          groupId: null,
          position: index,
          name: `Large command ${index}`,
          command,
          commands: Array.from({ length: 8 }, (_, stepIndex) => ({
            id: randomUUID(),
            name: `Step ${stepIndex}`,
            command,
            delayMs: 100,
          })),
          description: '',
          tags: [],
          shortcut: null,
          inputOnly: false,
          clickCount: 0,
          createdAt: now,
          updatedAt: now,
          version: 1,
        })),
      },
      source.commands.snapshot().etag,
    );

    const exported = await source.service.export(source.saveGrantId);
    expect(exported.bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(exported.bytes).toBeLessThan(16 * 1024 * 1024);

    const target = await fixture(source.target);
    const preview = await target.service.preview(await readGrant(target));
    expect(preview).toMatchObject({
      entityCount: 60,
      counts: { create: 60, conflict: 0 },
      canCommit: true,
    });
    expect(target.service.commit(preview.previewId).counts.create).toBe(60);
    const imported = target.commands.snapshot().commands;
    expect(imported).toHaveLength(60);
    expect(imported[0]?.commands).toHaveLength(8);
    expect(imported[0]?.commands[0]?.command).toBe(command);
  });

  it('rejects non-save grants without creating a file', async () => {
    const context = await fixture();
    const input = join(context.managed!.home, 'read-only.json');
    await writeFile(input, '{}');
    const grant = await context.managed!.capabilities.registry.createTrustedPath(input, 'file', [
      'read',
    ]);
    await expect(context.service.export(grant.grantId)).rejects.toMatchObject({
      code: 'AXTERM_CONFIGURATION_WRITE_FAILED',
    });
    expect(await readdir(context.directory)).toEqual([]);
  });

  it('inspects an independent file without mutating the target and reports graph and ID conflicts', async () => {
    const context = await fixture();
    const host = context.ctx.catalog.configurationImport!.hosts.createHost(
      createHostSchema.parse({
        name: 'Source host',
        hostname: 'source.example.test',
        username: 'operator',
      }),
    );
    const tree = context.bookmarks.createGroup(
      { name: 'Source group' },
      context.bookmarks.snapshot().etag,
    );
    context.bookmarks.createBookmark(
      { protocol: 'ssh', title: 'Source bookmark', hostId: host.id, groupId: tree.groups[0]!.id },
      tree.etag,
    );
    await context.service.export(context.saveGrantId);
    const original = await readFile(context.target);
    const valid = await context.service.inspect(await readGrant(context));
    expect(valid).toMatchObject({
      bytes: original.length,
      sha256: createHash('sha256').update(original).digest('hex'),
      entityCount: 3,
      issueCount: 0,
      issues: [],
      issuesTruncated: false,
    });
    const document = axtermConfigurationDocumentSchema.parse(JSON.parse(original.toString('utf8')));
    document.data.hosts[0]!.name = 'Colliding host';
    document.data.hosts[0]!.groupId = randomUUID();
    document.data.hosts[0]!.jumpHostId = document.data.hosts[0]!.id;
    document.data.hosts.push({ ...document.data.hosts[0]! });
    document.data.bookmarkGroups[0]!.parentId = document.data.bookmarkGroups[0]!.id;
    await writeFile(context.target, JSON.stringify(document));
    const report = await context.service.inspect(await readGrant(context));
    expect(report.issues).toEqual(
      expect.arrayContaining([
        { kind: 'target-conflict', path: 'data.hosts[0].id' },
        { kind: 'duplicate-id', path: 'data.hosts[1].id' },
        { kind: 'missing-reference', path: 'data.hosts[0].groupId' },
        { kind: 'reference-cycle', path: 'data.hosts[0].jumpHostId' },
        {
          kind: 'reference-cycle',
          path: `data.bookmarkGroups.${document.data.bookmarkGroups[0]!.id}.parentId`,
        },
      ]),
    );
    expect(context.ctx.catalog.getHost(host.id).name).toBe('Source host');
    expect(context.bookmarks.snapshot().groups[0]!.parentId).toBeNull();
  });

  it('rejects invalid UTF-8, oversized files and save-only grants on inspection', async () => {
    const context = await fixture();
    await writeFile(context.target, Buffer.from([0xff]));
    await expect(context.service.inspect(await readGrant(context))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const refusal = await context.service
      .inspect(context.saveGrantId)
      .catch((error) => remoteErrorOf(error));
    expect(refusal).toMatchObject({ code: 'files/failure', details: { reason: 'forbidden' } });
    await writeFile(context.target, Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(context.service.inspect(await readGrant(context))).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('requires a fresh preview only when an importable target collection changes', async () => {
    const source = await fixture();
    source.ctx.catalog.configurationImport!.hosts.createHost(
      createHostSchema.parse({
        name: 'Preview source',
        hostname: 'preview-source.example.test',
        username: 'operator',
      }),
    );
    await source.service.export(source.saveGrantId);

    const target = await fixture(source.target);
    const preview = await target.service.preview(await readGrant(target));
    target.ctx.emit('desktop/runtime-state', { ...target.ctx.runtimeIdentity, state: 'ready' });
    const targetSettings = target.ctx.configuration.getSettings();
    updateSettings(target, { appearance: { theme: 'light' } }, etagFor(targetSettings.version));
    expect(target.service.commit(preview.previewId).counts.create).toBe(1);

    const settingsPreview = await source.service.preview(await readGrant(source), true);
    const sourceSettings = source.ctx.configuration.getSettings();
    updateSettings(source, { appearance: { theme: 'light' } }, etagFor(sourceSettings.version));
    expect(() => source.service.commit(settingsPreview.previewId)).toThrow(/create a new preview/u);

    const changedPreview = await source.service.preview(await readGrant(source));
    source.ctx.catalog.configurationImport!.hosts.createHost(
      createHostSchema.parse({
        name: 'Preview target change',
        hostname: 'preview-target.example.test',
        username: 'operator',
      }),
    );
    expect(() => source.service.commit(changedPreview.previewId)).toThrow(/create a new preview/u);
  });

  it('previews and atomically imports an independent configuration while preserving local settings', async () => {
    const source = await fixture();
    const hostGroup = source.ctx.catalog.configurationImport!.hosts.createHostGroup({
      name: 'Migration hosts',
      sortOrder: 4,
    });
    const host = source.ctx.catalog.configurationImport!.hosts.createHost(
      createHostSchema.parse({
        name: 'Migration SSH',
        hostname: 'migration.example.test',
        username: 'operator',
        groupId: hostGroup.id,
      }),
    );
    const connectionProfile = source.profiles.create(
      connectionProfileInputSchema.parse({ name: 'Migration profile', isDefault: false }),
    );
    const terminalProfile = createProfile(
      source,
      terminalProfileInputSchema.parse({ name: 'Migration terminal' }),
    );
    const group = source.bookmarks.createGroup(
      { name: 'Migration group' },
      source.bookmarks.snapshot().etag,
    );
    source.bookmarks.createBookmark(
      {
        protocol: 'ssh',
        title: 'Migration bookmark',
        hostId: host.id,
        groupId: group.groups[0]!.id,
        profileId: terminalProfile.id,
        connectionProfileId: connectionProfile.id,
      },
      group.etag,
    );
    source.ctx.connections.createTunnelProfile(
      randomUUID(),
      tunnelProfileInputSchema.parse({
        name: 'Migration tunnel',
        hostId: host.id,
        type: 'local',
        bindHost: '127.0.0.1',
        bindPort: 40123,
        targetHost: '127.0.0.1',
        targetPort: 22,
        allowNonLoopback: false,
      }),
    );
    const commandGroup = source.commands.createGroup(
      { parentId: null, name: 'Migration commands' },
      source.commands.snapshot().etag,
    );
    source.commands.createCommand(
      {
        groupId: commandGroup.groups[0]!.id,
        name: 'Migration command',
        command: 'echo migration',
        commands: [{ id: randomUUID(), name: 'Echo', command: 'echo migration', delayMs: 1 }],
        description: '',
        tags: [],
        shortcut: null,
        inputOnly: false,
        clickCount: 0,
      },
      commandGroup.etag,
    );
    createTheme(
      source,
      terminalThemeInputSchema.parse({ ...AXTERM_TERMINAL_THEMES[0], name: 'Migration theme' }),
    );
    source.triggers.create(
      triggerRuleInputSchema.parse({
        name: 'Migration trigger',
        enabled: true,
        match: { type: 'text', value: 'migration', caseSensitive: false },
        action: { type: 'notify', value: '' },
        sendEnter: false,
        mode: 'once',
        cooldownMs: 0,
      }),
      source.triggers.snapshot().etag,
    );
    await source.service.export(source.saveGrantId);

    const target = await fixture(source.target);
    const beforeSettings = target.ctx.configuration.getSettings();
    const preview = await target.service.preview(await readGrant(target));
    expect(preview).toMatchObject({
      entityCount: 11,
      counts: { create: 11, unchanged: 0, conflict: 0, skipped: 1 },
      settings: 'preserved',
      canCommit: true,
      issueCount: 0,
    });
    expect(target.ctx.catalog.listHosts()).toEqual([]);

    const imported = target.service.commit(preview.previewId);
    expect(imported).toMatchObject({
      previewId: preview.previewId,
      entityCount: 11,
      counts: { create: 11, unchanged: 0, conflict: 0, skipped: 1 },
      settings: 'preserved',
    });
    expect(target.ctx.catalog.listHosts()).toMatchObject([
      { name: 'Migration SSH', hostname: 'migration.example.test' },
    ]);
    expect(target.bookmarks.snapshot()).toMatchObject({
      groups: [{ name: 'Migration group' }],
      bookmarks: [{ title: 'Migration bookmark', protocol: 'ssh' }],
    });
    expect(target.profiles.list()).toMatchObject([{ name: 'Migration profile' }]);
    expect(target.ctx.catalog.listHostGroups()).toMatchObject([{ name: 'Migration hosts' }]);
    expect(target.ctx.terminalFacts.listProfiles()).toMatchObject([{ name: 'Migration terminal' }]);
    expect(target.ctx.connections.listTunnelProfiles()).toMatchObject([
      { name: 'Migration tunnel' },
    ]);
    expect(target.commands.snapshot()).toMatchObject({
      groups: [{ name: 'Migration commands' }],
      commands: [{ name: 'Migration command' }],
    });
    expect(target.ctx.terminalFacts.listThemes().filter((theme) => !theme.builtIn)).toMatchObject([
      { name: 'Migration theme', builtIn: false },
    ]);
    expect(target.triggers.snapshot()).toMatchObject({
      triggers: [{ name: 'Migration trigger' }],
    });
    expect(target.ctx.configuration.getSettings()).toEqual(beforeSettings);

    const repeatedPreview = await target.service.preview(await readGrant(target));
    expect(repeatedPreview.counts).toEqual({
      create: 0,
      unchanged: 11,
      conflict: 0,
      skipped: 1,
    });
    expect(target.service.commit(repeatedPreview.previewId).counts).toEqual({
      create: 0,
      unchanged: 11,
      conflict: 0,
      skipped: 1,
    });
  });

  it('restores selected portable settings while preserving privacy and credential-dependent proxy choices', async () => {
    const source = await fixture();
    const host = source.ctx.catalog.configurationImport!.hosts.createHost(
      createHostSchema.parse({
        name: 'Settings SSH',
        hostname: 'settings.example.test',
        username: 'operator',
      }),
    );
    const terminalProfile = createProfile(
      source,
      terminalProfileInputSchema.parse({ name: 'Settings terminal profile' }),
    );
    const bookmarkTree = source.bookmarks.createBookmark(
      {
        protocol: 'ssh',
        title: 'Settings bookmark',
        hostId: host.id,
        profileId: terminalProfile.id,
      },
      source.bookmarks.snapshot().etag,
    );
    const bookmark = bookmarkTree.bookmarks[0]!;
    const theme = createTheme(
      source,
      terminalThemeInputSchema.parse({ ...AXTERM_TERMINAL_THEMES[0], name: 'Settings theme' }),
    );
    const now = new Date().toISOString();
    const tabId = randomUUID();
    const workspaceId = randomUUID();
    const layout = {
      section: 'hosts' as const,
      contentSurface: 'terminal' as const,
      sidebarOpen: true,
      split: false,
      tabs: [
        {
          id: tabId,
          title: 'Settings tab',
          kind: 'ssh' as const,
          hostId: host.id,
          bookmarkId: bookmark.id,
          profileId: terminalProfile.id,
          visual: { themeId: theme.id, background: { ...DEFAULT_TERMINAL_BACKGROUND } },
          pinned: false,
          paneIndex: 0,
        },
      ],
      activeTerminalId: tabId,
      secondaryTerminalId: null,
      layoutMode: 'c1' as const,
      paneTerminalIds: [tabId],
      focusedPane: 0,
    };
    const sourceSettings = source.ctx.configuration.getSettings();
    const { importRevision: _readOnlyImportRevision, ...editableWorkspace } =
      sourceSettings.workspace;
    updateSettings(
      source,
      {
        appearance: { ...sourceSettings.appearance, theme: 'light' },
        workspace: {
          ...editableWorkspace,
          restoreLayout: true,
          aiInspectorOpen: true,
          layout,
          namedWorkspaces: [
            {
              id: workspaceId,
              name: 'Settings workspace',
              layout,
              createdAt: now,
              updatedAt: now,
            },
          ],
          activeWorkspaceId: workspaceId,
          startupSessions: [bookmark.id],
          showTabNumber: false,
          switchTabOnHover: true,
        },
        privacy: {
          connectionHistoryEnabled: false,
          commandHistoryEnabled: true,
          hideAddresses: true,
        },
        network: {
          proxy: {
            mode: 'custom',
            endpoint: {
              url: 'https://source-proxy.example.test',
              username: 'source-user',
              credentialRef: 'SOURCE_PROXY_CREDENTIAL',
            },
          },
        },
        shortcuts: { bindings: { app_newTab: ['ctrl+alt+n'] } },
        terminal: {
          ...sourceSettings.terminal,
          defaultProfileId: terminalProfile.id,
          visual: { ...sourceSettings.terminal.visual, themeId: theme.id },
        },
        fileManager: {
          ...sourceSettings.fileManager,
          remoteAddressBookmarks: [{ id: randomUUID(), hostId: host.id, path: '/srv/settings' }],
        },
        monitor: {
          ...sourceSettings.monitor,
          remoteMonitorBarEnabled: true,
        },
      },
      etagFor(sourceSettings.version),
    );
    await source.service.export(source.saveGrantId);

    const target = await fixture(source.target);
    const targetSettings = target.ctx.configuration.getSettings();
    const localSettings = updateSettings(
      target,
      {
        privacy: {
          connectionHistoryEnabled: true,
          commandHistoryEnabled: false,
          hideAddresses: false,
        },
        network: {
          proxy: {
            mode: 'custom',
            endpoint: {
              url: 'https://target-proxy.example.test',
              username: 'target-user',
              credentialRef: 'TARGET_PROXY_CREDENTIAL',
            },
          },
        },
      },
      etagFor(targetSettings.version),
    );
    const preview = await target.service.preview(await readGrant(target), true);
    expect(preview).toMatchObject({
      counts: { create: 4, unchanged: 0, conflict: 0, skipped: 0 },
      settings: 'will-apply',
      canCommit: true,
    });

    const result = target.service.commit(preview.previewId);
    expect(result).toMatchObject({
      counts: { create: 4, unchanged: 0, conflict: 0, skipped: 0 },
      settings: 'applied',
    });
    const importedHost = target.ctx.catalog.listHosts()[0]!;
    const importedBookmark = target.bookmarks.snapshot().bookmarks[0]!;
    const importedProfile = target.ctx.terminalFacts.listProfiles()[0]!;
    const importedTheme = target.ctx.terminalFacts
      .listThemes()
      .filter((theme) => !theme.builtIn)[0]!;
    const restored = target.ctx.configuration.getSettings();
    expect(restored.appearance.theme).toBe('light');
    expect(restored.privacy).toEqual(localSettings.privacy);
    expect(restored.network).toEqual(localSettings.network);
    expect(restored.shortcuts.bindings).toEqual({ app_newTab: ['ctrl+alt+n'] });
    expect(restored.terminal).toMatchObject({
      defaultProfileId: importedProfile.id,
      visual: { themeId: importedTheme.id },
    });
    expect(restored.fileManager.remoteAddressBookmarks).toEqual([
      expect.objectContaining({ hostId: importedHost.id, path: '/srv/settings' }),
    ]);
    expect(restored.monitor.remoteMonitorBarEnabled).toBe(true);
    expect(restored.workspace).toMatchObject({
      restoreLayout: true,
      aiInspectorOpen: true,
      activeWorkspaceId: workspaceId,
      startupSessions: [importedBookmark.id],
      showTabNumber: false,
      switchTabOnHover: true,
    });
    expect(restored.workspace.layout?.tabs[0]).toMatchObject({
      hostId: importedHost.id,
      bookmarkId: importedBookmark.id,
      profileId: importedProfile.id,
      visual: { themeId: importedTheme.id },
    });
    expect(restored.workspace.namedWorkspaces[0]).toMatchObject({
      id: workspaceId,
    });
    expect(restored.workspace.namedWorkspaces[0]?.layout.tabs[0]).toMatchObject({
      hostId: importedHost.id,
      bookmarkId: importedBookmark.id,
      profileId: importedProfile.id,
      visual: { themeId: importedTheme.id },
    });
  });

  it('rolls back every prior write if a configuration commit later hits a target constraint', async () => {
    const source = await fixture();
    source.ctx.catalog.configurationImport!.hosts.createHostGroup({
      name: 'Source group',
      sortOrder: 0,
    });
    source.profiles.create(connectionProfileInputSchema.parse({ name: 'Duplicate profile' }));
    await source.service.export(source.saveGrantId);

    const target = await fixture(source.target);
    target.handles.get('catalog')!.run(
      `INSERT INTO connection_profiles(id, name, payload, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, 1)`,
      randomUUID(),
      'Duplicate profile',
      JSON.stringify({
        isDefault: true,
        ssh: {
          username: null,
          passwordCredentialRef: null,
          privateKeyCredentialRef: null,
          passphraseCredentialRef: null,
          certificateCredentialRef: null,
        },
        telnet: { username: null, passwordCredentialRef: null },
        vnc: { username: null, passwordCredentialRef: null },
        rdp: { username: null, passwordCredentialRef: null },
        ftp: { username: null, passwordCredentialRef: null },
        spice: { username: null, passwordCredentialRef: null },
      }),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const preview = await target.service.preview(await readGrant(target));
    expect(preview.canCommit).toBe(true);
    let refusal: unknown;
    try {
      target.service.commit(preview.previewId);
    } catch (error) {
      refusal = remoteErrorOf(error);
    }
    expect(refusal).toMatchObject({ code: 'catalog/failure', details: { reason: 'conflict' } });
    expect(target.ctx.catalog.listHostGroups()).toEqual([]);
    expect(target.profiles.list()).toMatchObject([{ name: 'Duplicate profile' }]);
  });
});
