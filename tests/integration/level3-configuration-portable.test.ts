import {
  terminalVisualSettingsSchema,
  DEFAULT_TERMINAL_THEME_ID,
} from '@axterm/plugin-api/terminals';
import { workspaceLayoutSchema, namedWorkspaceSchema } from '@axterm/plugin-api/configuration';
import { configurationFixture as boot } from '../fixtures/level3-configuration.ts';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { quickCommandInputSchema, triggerRuleInputSchema } from '@axterm/plugin-api/automation';
import { terminalProfileInputSchema } from '@axterm/plugin-api/terminals';
import { connectionProfileInputSchema, createHostSchema } from '@axterm/plugin-api/catalog';

async function document() {
  const f = await boot();
  const catalog = f.ctx.catalog.configurationImport!;
  const group = catalog.hosts.createHostGroup({ name: 'Production', sortOrder: 0 });
  const host = catalog.hosts.createHost(
    createHostSchema.parse({
      name: 'Owned SSH',
      hostname: 'ssh.example.test',
      username: 'operator',
      groupId: group.id,
      credentialRef: 'PRIVATE_LOCAL_REFERENCE',
    }),
  );
  const profile = f.ctx.terminalFacts.createProfile(
    randomUUID(),
    terminalProfileInputSchema.parse({ name: 'Portable shell', shell: '/bin/sh' }),
  );
  const credentials = catalog.profiles.create(
    connectionProfileInputSchema.parse({ name: 'Portable connection' }),
  );
  let tree = catalog.bookmarks.createGroup({ name: 'Services' }, catalog.bookmarks.snapshot().etag);
  tree = catalog.bookmarks.createBookmark(
    {
      protocol: 'ssh',
      title: 'Portable shell',
      hostId: host.id,
      groupId: tree.groups[0]!.id,
      profileId: profile.ids[0]!,
      connectionProfileId: credentials.id,
    },
    tree.etag,
  );
  expect(tree.bookmarks[0]?.hostId).toBe(host.id);
  const quick = f.ctx.automation.configurationImport!.quickCommands;
  let commands = quick.createGroup({ name: 'Review', parentId: null }, quick.snapshot().etag);
  commands = quick.createCommand(
    quickCommandInputSchema.parse({
      groupId: commands.groups[0]!.id,
      name: 'Inspect',
      command: 'pwd',
      commands: [{ id: randomUUID(), name: '', command: 'pwd', delayMs: 100 }],
      description: '',
      tags: [],
      shortcut: null,
      inputOnly: false,
      clickCount: 0,
    }),
    commands.etag,
  );
  expect(commands.commands[0]?.command).toBe('pwd');
  f.ctx.connections.createTunnelProfile(randomUUID(), {
    name: 'Portable tunnel',
    hostId: host.id,
    type: 'local',
    bindHost: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: 22,
    allowNonLoopback: false,
  });
  const triggers = f.ctx.automation.configurationImport!.triggers;
  triggers.create(
    triggerRuleInputSchema.parse({
      name: 'Portable rule',
      enabled: true,
      sendEnter: true,
      mode: 'repeat',
      cooldownMs: 1000,
      match: { type: 'text', value: 'READY', caseSensitive: true },
      action: { type: 'send', value: 'SHOULD_NOT_EXECUTE_ON_IMPORT' },
    }),
    triggers.snapshot().etag,
  );
  const settings = f.ctx.configuration.getSettings();
  f.ctx.configurationController.updateSettings(
    randomUUID(),
    {
      appearance: { language: 'ja' },
      terminal: { defaultProfileId: profile.ids[0]! },
      workspace: {
        layout: {
          section: 'hosts',
          sidebarOpen: true,
          tabs: [{ id: randomUUID(), kind: 'local', title: 'Saved', profileId: profile.ids[0]! }],
          activeTerminalId: null,
        },
      },
    },
    '"v' + settings.version + '"',
  );
  const custom = f.ctx.terminalFacts.cloneTheme(
      randomUUID(),
      DEFAULT_TERMINAL_THEME_ID,
      'Portable theme',
    ),
    visual = terminalVisualSettingsSchema.parse({ themeId: custom.ids[0]! });
  const latest = f.ctx.configuration.getSettings(),
    layout = {
      ...latest.workspace.layout!,
      tabs: latest.workspace.layout!.tabs.map((tab) => ({ ...tab, visual })),
    };
  const named = namedWorkspaceSchema.parse({
    id: randomUUID(),
    name: 'Portable named layout',
    layout,
    presentation: {
      section: 'sessions',
      sidebarOpen: false,
      activeTabId: layout.tabs[0]!.id,
      tabs: layout.tabs.map((tab) => ({
        id: tab.id,
        kind: 'terminal',
        caption: tab.title,
        terminalVisual: visual,
      })),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  f.ctx.configurationController.updateSettings(
    randomUUID(),
    { terminal: { visual }, workspace: { layout, namedWorkspaces: [named] } },
    '"v' + latest.version + '"',
  );
  const value = f.app.snapshot();
  expect(JSON.stringify(value)).not.toContain('PRIVATE_LOCAL_REFERENCE');
  expect(value.omissions.fields).toContain('data.hosts[0].credentialRef');
  expect(f.execute).not.toHaveBeenCalled();
  return value;
}
it('imports through actual owners in one transaction, remaps references and recovers a committed receipt without replay', async () => {
  const source = await document();
  const f = await boot();
  const old = f.ctx.configurationController.bindWorkspacePresentation('desktop_0');
  const input = { section: 'sessions', sidebarOpen: false, activeTabId: null, tabs: [] };
  const oldCommand = randomUUID();
  const oldReceipt = await f.ctx.configurationController.saveWorkspacePresentation(
    oldCommand,
    'desktop_0',
    input,
    0,
    old.generation,
    old.importRevision,
  );
  const preview = f.app.previewDocument(source, true);
  expect(preview.canCommit).toBe(true);
  const commandId = randomUUID();
  const result = await f.ctx.configurationController.importConfiguration(
    commandId,
    preview.previewId,
  );
  expect(result.settings).toBe('applied');
  expect(f.ctx.configuration.getSettings().workspace.importRevision).toBe(old.importRevision + 1);
  expect(f.ctx.configuration.getSettings().workspace.presentations).toEqual({});
  await expect(
    f.ctx.configurationController.saveWorkspacePresentation(
      randomUUID(),
      'desktop_0',
      input,
      0,
      old.generation,
      old.importRevision,
    ),
  ).rejects.toMatchObject({
    code: 'configuration/failure',
    details: { reason: 'precondition-failed' },
  });
  expect(
    await f.ctx.configurationController.saveWorkspacePresentation(
      oldCommand,
      'desktop_0',
      input,
      0,
      old.generation,
      old.importRevision,
    ),
  ).toEqual(oldReceipt);
  expect(f.app.snapshot().data.settings.workspace).not.toHaveProperty('importRevision');
  expect(f.app.snapshot().data.settings.workspace).not.toHaveProperty('presentations');

  expect(result.counts.create).toBeGreaterThan(5);
  expect(
    await f.ctx.configurationController.importConfiguration(commandId, preview.previewId),
  ).toEqual(result);
  expect(f.ctx.configuration.getSettings().workspace.importRevision).toBe(old.importRevision + 1);
  const target = f.app.snapshot();
  const mappedTheme = target.data.terminalThemes[0]!.id;
  expect(mappedTheme).not.toBe(source.data.terminalThemes[0]!.id);
  expect(target.data.settings.workspace.namedWorkspaces[0]!.layout.tabs[0]!.visual!.themeId).toBe(
    mappedTheme,
  );
  expect(
    target.data.settings.workspace.namedWorkspaces[0]!.presentation!.tabs[0]!.terminalVisual!
      .themeId,
  ).toBe(mappedTheme);

  expect(target.data.hosts).toHaveLength(1);
  expect(target.data.hosts[0]!.id).not.toBe(source.data.hosts[0]!.id);
  expect(target.data.bookmarks[0]!.hostId).toBe(target.data.hosts[0]!.id);
  expect(target.data.tunnelProfiles[0]!.hostId).toBe(target.data.hosts[0]!.id);
  expect(target.data.bookmarks[0]!.profileId).toBe(target.data.terminalProfiles[0]!.id);
  expect(target.data.settings.terminal.defaultProfileId).toBe(target.data.terminalProfiles[0]!.id);
  expect(target.data.settings.appearance.language).toBe('ja');
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.ctx.connections.listTunnels()).toEqual([]);
  const again = f.app.previewDocument(source, true);
  expect(again.counts.create).toBe(0);
  expect(again.canCommit).toBe(true);
  expect(() => f.handles.get('configuration')!.run('DELETE FROM hosts')).toThrow();
});
it('rolls back every owner, command receipt, mapping and outbox when the final owner fails, preserving the preview for retry', async () => {
  const source = await document();
  const f = await boot();
  const preview = f.app.previewDocument(source, true);
  const cursors = new Map([...f.handles].map(([name, value]) => [name, value.cursor()]));
  const notices = vi.fn();
  for (const value of f.handles.values()) value.subscribe(notices);
  const triggers = f.ctx.automation.configurationImport!.triggers;
  const create = vi.spyOn(triggers, 'create').mockImplementation(() => {
    throw new Error('PRIVATE_IMPORT_FAILURE');
  });
  const commandId = randomUUID();
  await expect(f.runtime.commit(commandId, preview.previewId)).rejects.toMatchObject({
    code: 'configuration/portable-failure',
    details: { reason: 'unavailable' },
  });
  expect(f.ctx.catalog.listHosts()).toEqual([]);
  expect(f.ctx.terminalFacts.listProfiles()).toEqual([]);
  expect(f.ctx.connections.listTunnelProfiles()).toEqual([]);
  expect(f.ctx.automation.getQuickCommands().commands).toEqual([]);
  expect(f.ctx.configuration.getSettings().appearance.language).toBe('zh-CN');
  expect(f.app.getPreview(preview.previewId)).not.toBeNull();
  expect(
    f.handles.get('configuration')!.all('SELECT * FROM axterm_configuration_import_entries'),
  ).toEqual([]);
  expect(
    f.handles
      .get('configuration')!
      .get('SELECT * FROM axterm_configuration_command_receipts WHERE command_id=?', commandId),
  ).toBeUndefined();
  for (const [name, value] of f.handles) expect(value.cursor()).toBe(cursors.get(name));
  expect(notices).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  create.mockRestore();
  expect((await f.runtime.commit(commandId, preview.previewId)).counts.create).toBeGreaterThan(5);
});
it('invalidates stale previews, isolates returned metadata and stops cached workflow access on unload', async () => {
  const source = await document();
  const f = await boot();
  const preview = f.app.previewDocument(source);
  preview.canCommit = false;
  expect(f.app.getPreview(preview.previewId)?.canCommit).toBe(true);
  f.ctx.catalogController.createHost(
    randomUUID(),
    createHostSchema.parse({
      name: 'Concurrent',
      hostname: 'other.example.test',
      username: 'operator',
    }),
  );
  await expect(f.runtime.commit(randomUUID(), preview.previewId)).rejects.toMatchObject({
    details: { reason: 'stale' },
  });
  await f.owner.dispose();
  await expect(f.runtime.commit(randomUUID(), preview.previewId)).rejects.toMatchObject({
    details: { reason: 'closed' },
  });
  expect(() => f.app.snapshot()).toThrow('closed');
});

it('rejects dangling visual references without settings, receipt or outbox writes and protects referenced themes', async () => {
  const f = await boot(),
    controller = f.ctx.configurationController,
    domain = f.handles.get('configuration')!,
    generation = f.ctx.runtimeIdentity.generation;
  const invalid = terminalVisualSettingsSchema.parse({ themeId: randomUUID() }),
    id = randomUUID(),
    layout = workspaceLayoutSchema.parse({
      section: 'hosts',
      sidebarOpen: true,
      tabs: [{ id, kind: 'local', title: 'Saved', visual: invalid }],
      activeTerminalId: id,
    });
  const named = namedWorkspaceSchema.parse({
    id: randomUUID(),
    name: 'Saved',
    layout,
    presentation: {
      section: 'sessions',
      sidebarOpen: false,
      tabs: [{ id, kind: 'terminal', caption: 'Saved', terminalVisual: invalid }],
      activeTabId: id,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const binding = controller.bindWorkspacePresentation('desktop_0');
  const before = controller.getSettings(),
    cursor = domain.cursor();
  for (const patch of [
    { terminal: { visual: invalid } },
    { workspace: { layout } },
    { workspace: { namedWorkspaces: [named] } },
    {
      workspace: {
        presentations: {
          [binding.key]: {
            version: 1,
            generation,
            lastCommandId: randomUUID(),
            presentation: named.presentation!,
          },
        },
      },
    },
  ]) {
    expect(() =>
      controller.updateSettings(randomUUID(), patch, '"v' + before.version + '"'),
    ).toThrowError(
      expect.objectContaining({
        code: 'configuration/failure',
        details: { reason: 'invalid-input' },
      }),
    );
    expect(controller.getSettings()).toEqual(before);
    expect(domain.cursor()).toBe(cursor);
  }
  const clone = f.ctx.terminalFacts.cloneTheme(
      randomUUID(),
      DEFAULT_TERMINAL_THEME_ID,
      'Referenced theme',
    ),
    theme = clone.ids[0]!;
  const visual = terminalVisualSettingsSchema.parse({ themeId: theme });
  const applied = controller.updateSettings(
    randomUUID(),
    { terminal: { visual }, privacy: { commandHistoryEnabled: false } },
    '"v' + before.version + '"',
  );
  expect(() => f.ctx.terminalFacts.deleteTheme(randomUUID(), theme, '"v1"')).toThrowError(
    expect.objectContaining({ code: 'terminals/failure', details: { reason: 'conflict' } }),
  );
  controller.updateSettings(
    randomUUID(),
    { terminal: { visual: terminalVisualSettingsSchema.parse({}) } },
    '"v' + applied.version + '"',
  );
  let version = controller.getSettings().version;
  const validNamed = {
    ...named,
    layout: { ...named.layout, tabs: named.layout.tabs.map((tab) => ({ ...tab, visual })) },
    presentation: {
      ...named.presentation!,
      tabs: named.presentation!.tabs.map((tab) => ({ ...tab, terminalVisual: visual })),
    },
  };
  controller.updateSettings(
    randomUUID(),
    { workspace: { namedWorkspaces: [validNamed] } },
    '"v' + version + '"',
  );
  expect(() => f.ctx.terminalFacts.deleteTheme(randomUUID(), theme, '"v1"')).toThrowError(
    expect.objectContaining({ details: { reason: 'conflict' } }),
  );
  version = controller.getSettings().version;
  controller.updateSettings(
    randomUUID(),
    { workspace: { namedWorkspaces: [] } },
    '"v' + version + '"',
  );
  f.ctx.terminalFacts.deleteTheme(randomUUID(), theme, '"v1"');
  expect(f.ctx.terminalFacts.listThemes().some((value) => value.id === theme)).toBe(false);
});
