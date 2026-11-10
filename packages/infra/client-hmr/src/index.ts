// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/hmr/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
// Axterm additions: authenticated, coalesced, bounded delivery and joined disposal.
/**
 * Host transport for Web client graph changes and rebuilt bundles. One interval
 * stat-polls every graph row's client bundle (polling by design: network mounts
 * deliver no inotify events), reports changes through
 * `clientModules.rebuilt(id)`, and serves the `/plugins/events` SSE channel
 * broadcasting graph/rebuilt frames to the browser half (src/client/).
 * The Web composition mounts this transport for live graph updates;
 * a development rebuild watcher also supplies bundle changes.
 */
import { statSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type {} from '@axterm/infra-connection';
// Type imports carry the clientModules/webServer Context merges.
import type { ClientArtifactBaseline } from '@axterm/infra-client-modules';
import type {} from '@axterm/infra-web-server';
import { GraphChannels } from './channels.ts';
import { EVENTS_ENDPOINT } from './events.ts';

export type { PluginsEventFrame } from './events.ts';
export { EVENTS_ENDPOINT } from './events.ts';

/** Cordis plugin name. */
export const name = 'client-hmr';

/** Required services: the client graph and Web route registry. */
export const inject = ['clientModules', 'webServer', 'connection'];

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number;
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(100).max(60000).default(500),
});

type WatchedBundleStat = Omit<ClientArtifactBaseline, 'path'>;

type WatchedBundle = {
  -readonly [K in keyof ClientArtifactBaseline]: ClientArtifactBaseline[K];
} & { dirty: boolean };

/** Snapshot the executable bundle metadata that drives reloads. */
function bundleStat(path: string): WatchedBundleStat {
  const bundle = statSync(path);
  return { mtimeMs: bundle.mtimeMs, ctimeMs: bundle.ctimeMs, size: bundle.size };
}

/** Whether the executable bundle metadata is unchanged since its last publication. */
function sameBundleStat(left: WatchedBundleStat, right: WatchedBundleStat): boolean {
  return (
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.size === right.size
  );
}

/**
 * Mount bundle watches and graph/rebuilt SSE delivery.
 * @param ctx - host plugin context carrying clientModules and webServer.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // schemastery's .default() guarantees the field is set after validation.
  const pollIntervalMs = config.pollIntervalMs ?? 500;

  // --- bundle watch: one HMR-owned stat poll ------------------------------
  const watched = new Map<string, WatchedBundle>();

  const publish = (id: string, watch: WatchedBundle, current: WatchedBundleStat): void => {
    try {
      ctx.clientModules.rebuilt(id);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        watch.dirty = true;
        return;
      }
      ctx.logger.warn('CLIENT_GRAPH_BUNDLE_UNAVAILABLE');
    }
    watch.mtimeMs = current.mtimeMs;
    watch.ctimeMs = current.ctimeMs;
    watch.size = current.size;
    watch.dirty = false;
  };

  const watchRow = (id: string, baseline: ClientArtifactBaseline): void => {
    const watch: WatchedBundle = { ...baseline, dirty: false };
    if (watched.size >= 1024) throw new Error('CLIENT_GRAPH_CAPACITY');
    watched.set(id, watch);
    let current: WatchedBundleStat;
    try {
      current = bundleStat(baseline.path);
    } catch (error) {
      watch.dirty = true;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        ctx.logger.warn('CLIENT_GRAPH_BUNDLE_UNAVAILABLE');
      return;
    }
    // The module host captured its baseline before reading the bytes in the
    // startup batch. Only a mismatch crosses into generation publication.
    if (!sameBundleStat(current, watch)) publish(id, watch, current);
  };

  const pollWatches = (): void => {
    for (const [id, watch] of watched) {
      let current: WatchedBundleStat;
      try {
        current = bundleStat(watch.path);
      } catch (error) {
        watch.dirty = true;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          ctx.logger.warn('CLIENT_GRAPH_BUNDLE_UNAVAILABLE');
        continue;
      }
      if (!watch.dirty && sameBundleStat(current, watch)) continue;
      // Stat-before-publication preserves a detectable older baseline for
      // writes that land during the read. The preset stamps the entry after
      // sibling chunks, so a completed build supplies the final stat change.
      publish(id, watch, current);
    }
  };

  // Diff the watch set against the current graph: drop watches for removed
  // rows (or rows whose bundle path moved), add watches for new rows.
  const syncWatches = (): void => {
    const rows = new Map<string, ClientArtifactBaseline>();
    for (const row of ctx.clientModules.graph().entries) {
      const watch = ctx.clientModules.artifactBaseline(row.id);
      if (watch !== undefined) rows.set(row.id, watch);
    }
    for (const [id, watch] of watched) {
      if (rows.get(id)?.path === watch.path) continue;
      watched.delete(id);
    }
    for (const [id, watch] of rows) {
      if (!watched.has(id)) watchRow(id, watch);
    }
  };

  ctx.effect(() => {
    // Initial sync covers rows already in the graph; the subscription covers
    // rows arriving later (boot-window activations, including this plugin's
    // own row; bootstrap revisions also reach page diagnostics).
    syncWatches();
    const unsubscribe = ctx.clientModules.onGraphChanged(syncWatches);
    const timer = setInterval(pollWatches, pollIntervalMs);
    timer.unref();
    return () => {
      unsubscribe();
      clearInterval(timer);
      watched.clear();
    };
  }, 'client-hmr: bundle watches');

  const channels = new GraphChannels(() => ctx.clientModules.graph());
  ctx.effect(() => {
    const unsubscribe = ctx.clientModules.onGraphChanged(() => channels.publish());
    const heartbeat = setInterval(() => channels.heartbeat(), 15000);
    heartbeat.unref();
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_ENDPOINT,
      handler: (request, response) => {
        const admission = ctx.connection.admit(request);
        if ('rejection' in admission) {
          response.writeHead(admission.rejection, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405);
          response.end();
          return;
        }
        if (request.method === 'HEAD') {
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
          });
          response.end();
          return;
        }
        channels.connect(response, admission.peer.signal);
      },
    });
    return async () => {
      unregister();
      unsubscribe();
      clearInterval(heartbeat);
      await channels.close();
    };
  }, 'client-hmr: authenticated graph stream');
}
