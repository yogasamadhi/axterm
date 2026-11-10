import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/infra-web-server';
import type {} from '@axterm/infra-connection';
import type { RemoteDesktopProtocolAssets } from '@axterm/plugin-api/remote-desktop';
import { z } from 'zod';
const schema = z
  .object({
    version: z.literal(1),
    novnc: z
      .object({
        file: z.string().regex(/^novnc-[a-f0-9]{64}\.js$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .min(1)
          .max(8 * 1024 * 1024),
      })
      .strict(),
  })
  .strict();
/** Exact packaged, immutable protocol code; no user-controlled path resolution or vendor edits. */
export class ProtocolAssets {
  readonly descriptor: RemoteDesktopProtocolAssets;
  constructor(ctx: Context) {
    const root = dirname(createRequire(import.meta.url).resolve('@axterm/plugin-remote-desktop'));
    if (statSync(join(root, 'protocol-assets.json')).size > 16384)
      throw Error('REMOTE_DESKTOP_ASSET_MANIFEST_CAPACITY');
    const text = readFileSync(join(root, 'protocol-assets.json'));
    if (text.length > 16384) throw Error('REMOTE_DESKTOP_ASSET_MANIFEST_CAPACITY');
    const manifest = schema.parse(JSON.parse(text.toString('utf8')));
    if (
      manifest.novnc.file !== 'novnc-' + manifest.novnc.sha256 + '.js' ||
      statSync(join(root, 'protocol-assets', manifest.novnc.file)).size !== manifest.novnc.bytes
    )
      throw Error('REMOTE_DESKTOP_ASSET_CHANGED');
    const bytes = readFileSync(join(root, 'protocol-assets', manifest.novnc.file));
    if (
      bytes.length !== manifest.novnc.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== manifest.novnc.sha256
    )
      throw Error('REMOTE_DESKTOP_ASSET_CHANGED');
    const path = '/remote-desktop/modules/' + manifest.novnc.file;
    this.descriptor = Object.freeze({ novnc: path.slice(1) });
    ctx.inject(['webServer', 'connection'], (web) => {
      web.effect(() =>
        web.webServer.register({
          kind: 'prefix',
          path: '/remote-desktop/modules',
          handler: (request, response) => {
            const admission = web.connection.admit(request);
            if ('rejection' in admission) {
              response.writeHead(admission.rejection, { 'cache-control': 'no-store' });
              response.end();
              return;
            }
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            if (
              url.pathname !== path ||
              url.search ||
              !['GET', 'HEAD'].includes(request.method ?? '')
            ) {
              response.writeHead(404, { 'cache-control': 'no-store' });
              response.end();
              return;
            }
            response.writeHead(200, {
              'content-type': 'text/javascript; charset=utf-8',
              'content-length': bytes.length,
              'cache-control': 'private, max-age=31536000, immutable',
              'x-content-type-options': 'nosniff',
            });
            response.end(request.method === 'HEAD' ? undefined : bytes);
          },
        }),
      );
    });
  }
}
