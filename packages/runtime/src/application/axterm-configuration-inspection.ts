import type {
  AxtermConfigurationDocument,
  AxtermConfigurationInspectResult,
} from '@workspace/contracts';

type Issue = AxtermConfigurationInspectResult['issues'][number];
type CollectionName = Exclude<keyof AxtermConfigurationDocument['data'], 'settings'>;

const collectionNames = [
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
] as const satisfies readonly CollectionName[];

export function inspectConfigurationGraph(
  source: AxtermConfigurationDocument,
  target: AxtermConfigurationDocument,
): Pick<
  AxtermConfigurationInspectResult,
  'entityCount' | 'issues' | 'issueCount' | 'issuesTruncated'
> {
  const issues: Issue[] = [];
  let issueCount = 0;
  const add = (kind: Issue['kind'], path: string): void => {
    issueCount += 1;
    if (issues.length < 256) issues.push({ kind, path });
  };
  const ids = {} as Record<CollectionName, Set<string>>;
  let entityCount = 0;
  for (const name of collectionNames) {
    const sourceRows = source.data[name];
    const targetRows = target.data[name];
    entityCount += sourceRows.length;
    const seen = new Set<string>();
    const current = new Map(targetRows.map((row) => [row.id, row]));
    for (const [index, row] of sourceRows.entries()) {
      const path = `data.${name}[${index}]`;
      if (seen.has(row.id)) add('duplicate-id', `${path}.id`);
      seen.add(row.id);
      const existing = current.get(row.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(row))
        add('target-conflict', `${path}.id`);
    }
    ids[name] = seen;
  }

  const reference = (id: string | null | undefined, name: CollectionName, path: string): void => {
    if (id && !ids[name].has(id)) add('missing-reference', path);
  };
  const acyclic = (
    rows: readonly { id: string; parentId: string | null }[],
    name: CollectionName,
  ): void => {
    const parents = new Map(rows.map((row) => [row.id, row.parentId]));
    const visited = new Set<string>();
    const active = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (active.has(id)) return;
      active.add(id);
      const parent = parents.get(id);
      if (parent) {
        if (active.has(parent)) add('reference-cycle', `data.${name}.${id}.parentId`);
        else if (parents.has(parent)) visit(parent);
      }
      active.delete(id);
      visited.add(id);
    };
    for (const id of parents.keys()) visit(id);
  };

  source.data.hosts.forEach((host, index) => {
    const path = `data.hosts[${index}]`;
    reference(host.groupId, 'hostGroups', `${path}.groupId`);
    reference(host.jumpHostId, 'hosts', `${path}.jumpHostId`);
    host.jumpHostIds.forEach((id, jumpIndex) =>
      reference(id, 'hosts', `${path}.jumpHostIds[${jumpIndex}]`),
    );
  });
  const hostEdges = new Map<string, Array<{ id: string; path: string }>>();
  source.data.hosts.forEach((host, index) => {
    if (hostEdges.has(host.id)) return;
    hostEdges.set(host.id, [
      ...(host.jumpHostId
        ? [{ id: host.jumpHostId, path: `data.hosts[${index}].jumpHostId` }]
        : []),
      ...host.jumpHostIds.map((id, jumpIndex) => ({
        id,
        path: `data.hosts[${index}].jumpHostIds[${jumpIndex}]`,
      })),
    ]);
  });
  const visitedHosts = new Set<string>();
  const activeHosts = new Set<string>();
  const visitHost = (id: string): void => {
    if (visitedHosts.has(id) || activeHosts.has(id)) return;
    activeHosts.add(id);
    for (const edge of hostEdges.get(id) ?? []) {
      if (activeHosts.has(edge.id)) add('reference-cycle', edge.path);
      else if (hostEdges.has(edge.id)) visitHost(edge.id);
    }
    activeHosts.delete(id);
    visitedHosts.add(id);
  };
  for (const id of hostEdges.keys()) visitHost(id);
  source.data.bookmarkGroups.forEach((group, index) =>
    reference(group.parentId, 'bookmarkGroups', `data.bookmarkGroups[${index}].parentId`),
  );
  acyclic(source.data.bookmarkGroups, 'bookmarkGroups');
  source.data.bookmarks.forEach((bookmark, index) => {
    const path = `data.bookmarks[${index}]`;
    reference(bookmark.groupId, 'bookmarkGroups', `${path}.groupId`);
    reference(bookmark.hostId, 'hosts', `${path}.hostId`);
    reference(bookmark.profileId, 'terminalProfiles', `${path}.profileId`);
    reference(bookmark.connectionProfileId, 'connectionProfiles', `${path}.connectionProfileId`);
    for (const protocol of ['rdp', 'vnc', 'spice'] as const)
      reference(bookmark[protocol]?.jumpHostId, 'hosts', `${path}.${protocol}.jumpHostId`);
  });
  source.data.tunnelProfiles.forEach((tunnel, index) =>
    reference(tunnel.hostId, 'hosts', `data.tunnelProfiles[${index}].hostId`),
  );
  source.data.quickCommandGroups.forEach((group, index) =>
    reference(group.parentId, 'quickCommandGroups', `data.quickCommandGroups[${index}].parentId`),
  );
  acyclic(source.data.quickCommandGroups, 'quickCommandGroups');
  source.data.quickCommands.forEach((command, index) =>
    reference(command.groupId, 'quickCommandGroups', `data.quickCommands[${index}].groupId`),
  );
  reference(
    source.data.settings.terminal.defaultProfileId,
    'terminalProfiles',
    'data.settings.terminal.defaultProfileId',
  );
  source.data.settings.fileManager.remoteAddressBookmarks.forEach((bookmark, index) =>
    reference(
      bookmark.hostId,
      'hosts',
      `data.settings.fileManager.remoteAddressBookmarks[${index}].hostId`,
    ),
  );
  const namedIds = new Set<string>();
  source.data.settings.workspace.namedWorkspaces.forEach((workspace, index) => {
    if (namedIds.has(workspace.id))
      add('duplicate-id', `data.settings.workspace.namedWorkspaces[${index}].id`);
    namedIds.add(workspace.id);
    inspectLayout(workspace.layout, `data.settings.workspace.namedWorkspaces[${index}].layout`);
  });
  const activeWorkspace = source.data.settings.workspace.activeWorkspaceId;
  if (activeWorkspace && !namedIds.has(activeWorkspace))
    add('missing-reference', 'data.settings.workspace.activeWorkspaceId');
  if (source.data.settings.workspace.layout)
    inspectLayout(source.data.settings.workspace.layout, 'data.settings.workspace.layout');

  return { entityCount, issues, issueCount, issuesTruncated: issueCount > issues.length };

  function inspectLayout(
    layout: NonNullable<AxtermConfigurationDocument['data']['settings']['workspace']['layout']>,
    path: string,
  ): void {
    const tabIds = new Set<string>();
    layout.tabs.forEach((tab, index) => {
      const tabPath = `${path}.tabs[${index}]`;
      if (tabIds.has(tab.id)) add('duplicate-id', `${tabPath}.id`);
      tabIds.add(tab.id);
      reference(tab.hostId, 'hosts', `${tabPath}.hostId`);
      reference(tab.bookmarkId, 'bookmarks', `${tabPath}.bookmarkId`);
      reference(tab.profileId, 'terminalProfiles', `${tabPath}.profileId`);
    });
    for (const [name, id] of [
      ['activeTerminalId', layout.activeTerminalId],
      ['secondaryTerminalId', layout.secondaryTerminalId],
    ] as const)
      if (id && !tabIds.has(id)) add('missing-reference', `${path}.${name}`);
    layout.paneTerminalIds.forEach((id, index) => {
      if (id && !tabIds.has(id)) add('missing-reference', `${path}.paneTerminalIds[${index}]`);
    });
  }
}
