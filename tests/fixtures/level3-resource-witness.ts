import type { Context } from '@deepseek-ai/cordis';
import type {} from '../../packages/plugins/terminals/src/index.ts';
import type {} from '../../packages/plugins/connections/src/index.ts';
import type {} from '../../packages/plugins/transfers/src/index.ts';
import type {} from '../../packages/plugins/automation/src/index.ts';
import type {} from '../../packages/plugins/files/src/index.ts';
import type {} from '../../packages/plugins/remote-desktop/src/index.ts';
import type {} from '../../packages/plugins/desktop/src/index.ts';
import type {} from '../../packages/plugins/configuration/src/sync.ts';
/** Test reporting only. Capture actual owner instances while live; never infer a missing owner's zero. */
export function captureOwnedResourceWitness(ctx: Context): () => Readonly<Record<string, number>> {
  const owners = [
    ctx.terminalController,
    ctx.connectionsController,
    ctx.transfersController,
    ctx.automationController,
    ctx.filesController,
    ctx.remoteDesktopController,
    ctx.desktopRuntimeController,
  ];
  if (
    owners.some((owner) => !owner || typeof owner.resourceSnapshot !== 'function') ||
    !ctx.configurationSync
  )
    throw Error('SOAK_RESOURCE_OWNER_UNAVAILABLE');
  const readers = owners.map((owner, index) =>
    index === 0
      ? ctx.terminalController.captureResourceSnapshot()
      : owner.resourceSnapshot.bind(owner),
  );
  const sync = ctx.configurationSync.application;
  readers.push(() => Object.freeze({ syncRuns: sync.resourceCount() }));
  return () => {
    const counts = new Map<string, number>();
    for (const read of readers)
      for (const [key, value] of Object.entries(read())) {
        if (counts.has(key) || !Number.isSafeInteger(value) || value < 0)
          throw Error('SOAK_RESOURCE_OWNER_INVALID');
        counts.set(key, value);
      }
    for (const key of [
      'terminals',
      'terminalStartupSequences',
      'terminalInformationCaches',
      'terminalInformationRequests',
      'widgetInstances',
      'terminalTransfers',
      'connections',
      'batchOperations',
      'triggerSessions',
      'ftpConnections',
      'transfers',
      'externalEditors',
      'tunnels',
      'interactions',
      'rdpSessions',
      'vncSessions',
      'spiceSessions',
      'webSessions',
      'realtimeSubscribers',
      'syncRuns',
      'desktopLifecycle',
    ])
      if (!counts.has(key)) throw Error('SOAK_RESOURCE_OWNER_MISSING:' + key);
    return Object.freeze(Object.fromEntries(counts));
  };
}
