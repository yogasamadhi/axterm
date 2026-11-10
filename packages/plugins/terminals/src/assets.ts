import { StoredTerminalAssets } from './adapters/background-assets.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/infra-web-server';
import type {} from '@axterm/infra-connection';
import { pipeline } from 'node:stream/promises';
import { productDomains } from '@axterm/data-schema';
import { remoteErrorOf, RemoteError, StorageCommandError } from '@axterm/plugin-api';
import { ZodError } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { idSchema } from '@axterm/plugin-api/terminals';
import { TerminalBackgroundAssets } from './application/background-assets.ts';
import { TerminalAssetsObservation } from './application/assets-observation.ts';
export interface OwnedTerminalAssets {
  readonly application: TerminalBackgroundAssets;
  readonly observation: TerminalAssetsObservation;
}
export async function createTerminalAssets(ctx: Context): Promise<OwnedTerminalAssets> {
  const opening = ctx.storage.domain.open(productDomains.terminalAssets);
  ctx.effect(() => async () => {
    await (await opening.catch(() => undefined))?.close();
  });
  const domain = await opening;
  const storage = new StoredTerminalAssets(domain, (operation) =>
    ctx.storage.domain.transaction([domain.participant, ctx.configuration.participant], operation),
  );
  const application = new TerminalBackgroundAssets(
    storage,
    ctx.files,
    ctx.configuration,
    ctx.runtimeIdentity.generation,
  );
  ctx.effect(() => () => application.close());
  ctx.provide('terminalAssetReferences', {
    participant: domain.participant,
    get: (id) => application.get(id),
  });
  const observation = new TerminalAssetsObservation(domain, ctx.runtimeIdentity.generation, () => ({
    assets: application.list(),
  }));
  ctx.effect(() => () => observation.dispose());
  ctx.inject(['webServer', 'connection', 'remoteAccess'], (web) => {
    web.effect(() => {
      const active = new Set<ServerResponse>(),
        tasks = new Set<Promise<void>>();
      let open = true;
      const serve = async (request: IncomingMessage, response: ServerResponse) => {
        if (!open || response.destroyed) return;
        const admission = web.connection.admit(request);
        if ('rejection' in admission) {
          response.writeHead(admission.rejection, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
          response.end();
          return;
        }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1'),
          parts = url.pathname.split('/'),
          id = idSchema.safeParse(parts[3]);
        if (parts.length !== 4 || !id.success || url.search) {
          response.writeHead(404, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        if (
          web.remoteAccess.decide({
            principal: admission.peer.principal,
            action: 'terminals/background-asset',
            resources: [{ kind: 'terminalBackgroundAsset', id: id.data }],
          }).kind !== 'allow'
        ) {
          response.writeHead(403, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        try {
          const opened = application.openStream(id.data);
          const { asset, stream } = opened;
          try {
            response.writeHead(200, {
              'content-type': asset.mimeType,
              'content-length': asset.bytes,
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'; sandbox",
            });
            await pipeline(stream, response);
          } finally {
            await opened.close();
          }
        } catch (error) {
          if (response.headersSent) {
            response.destroy();
            return;
          }
          const marked = remoteErrorOf(error);
          response.writeHead(
            marked?.code === 'terminals/failure' && marked.details.reason === 'not-found'
              ? 404
              : 503,
            { 'cache-control': 'no-store' },
          );
          response.end();
        }
      };
      const unregister = web.webServer.register({
        kind: 'prefix',
        path: '/terminals/background-assets',
        handler: (request, response) => {
          const task = Promise.resolve().then(() => serve(request, response));
          active.add(response);
          tasks.add(task);
          const release = () => {
            tasks.delete(task);
            active.delete(response);
          };
          void task.then(release, release);
          return task;
        },
      });
      return async () => {
        open = false;
        unregister();
        for (const response of active) response.destroy();
        await Promise.allSettled([...tasks]);
      };
    });
  });
  return { application, observation };
}

export function terminalAssetFailure(error: unknown): RemoteError<'terminals/failure'> {
  const marked = remoteErrorOf(error);
  if (marked?.code === 'terminals/failure') return marked as RemoteError<'terminals/failure'>;
  const reason =
    error instanceof ZodError
      ? 'invalid-input'
      : error instanceof StorageCommandError
        ? error.code === 'conflict'
          ? 'conflict'
          : error.code === 'receipt-expired'
            ? 'receipt-expired'
            : 'invalid-input'
        : 'unavailable';
  return new RemoteError('terminals/failure', 'The background asset operation failed', { reason });
}
