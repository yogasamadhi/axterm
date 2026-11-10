import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/infra-web-server';
import type {} from '@axterm/infra-connection';
import type {} from '@axterm/infra-remote-access';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  REMOTE_DESKTOP_STREAM_PATH,
  REMOTE_DESKTOP_CREDENTIAL_PATH,
} from '@axterm/plugin-api/remote-desktop';
import type { RemoteDesktopSessions } from '../application/sessions.ts';
import type { RelaySocket } from '../ports/relay.ts';
const query = z.object({ id: z.uuid() }).strict();
function reject(socket: Duplex, status: 400 | 401 | 403 | 404 | 410 | 429 | 503): void {
  socket.end(
    `HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`,
  );
}
/** Plugin-owned binary carrier; admission is shared with generated Remote, protocol bytes and one-time credential bootstrap stay outside Remote. */
export class RemoteDesktopBinaryStream {
  private readonly server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 4 * 1024 * 1024,
  });
  private readonly sockets = new Set<WebSocket>();
  private readonly withdraw: Array<() => void> = [];
  private accepting = true;
  private closing: Promise<void> | undefined;
  constructor(ctx: Context, sessions: RemoteDesktopSessions) {
    this.server.on('error', () => {
      console.warn('REMOTE_DESKTOP_STREAM_FAILED');
    });
    for (const credentials of [false, true])
      this.withdraw.push(
        ctx.webServer.registerUpgrade({
          path: credentials ? REMOTE_DESKTOP_CREDENTIAL_PATH : REMOTE_DESKTOP_STREAM_PATH,
          handler: (req, socket, head) => {
            if (!this.accepting) {
              reject(socket, 503);
              return;
            }
            const admission = ctx.connection.admit(req);
            if ('rejection' in admission) {
              reject(socket, admission.rejection);
              return;
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const fields = Object.fromEntries(url.searchParams);
            const input = query.safeParse(fields);
            if (
              req.method !== 'GET' ||
              !input.success ||
              [...url.searchParams].length !== Object.keys(fields).length
            ) {
              reject(socket, 400);
              return;
            }
            const { id } = input.data;
            if (
              ctx.remoteAccess.decide({
                principal: admission.peer.principal,
                action: credentials ? 'remoteDesktop/credentials' : 'remoteDesktop/stream',
                resources: [{ kind: 'remoteDesktopSession', id }],
              }).kind !== 'allow'
            ) {
              reject(socket, 403);
              return;
            }
            // The domain enforces its viewer limit after replacing an existing
            // client identity, so a reconnect at that limit remains possible.
            if (this.sockets.size >= 128) {
              reject(socket, 429);
              return;
            }
            try {
              if (credentials) sessions.canClaim(id);
              else sessions.canAttach(id);
            } catch {
              reject(socket, 410);
              return;
            }
            this.server.handleUpgrade(req, socket, head, (ws) => {
              this.sockets.add(ws);
              ws.once('close', () => {
                this.sockets.delete(ws);
              });
              ws.on('error', () => ws.terminate());
              if (credentials) {
                const abort = new AbortController();
                ws.once('close', () => abort.abort());
                ws.once('message', () => {
                  abort.abort();
                  ws.terminate();
                });
                void Promise.resolve()
                  .then(() => sessions.claim(id, abort.signal))
                  .then(
                    (value) => {
                      if (ws.readyState !== 1) return;
                      ws.send(Buffer.from(JSON.stringify(value)), { binary: true }, (error) => {
                        if (error) ws.terminate();
                        else ws.close(1000, 'credentials delivered');
                      });
                    },
                    () => ws.close(1008, 'credentials unavailable'),
                  );
                return;
              }

              const port: RelaySocket = {
                get bufferedAmount() {
                  return ws.bufferedAmount;
                },
                get readyState() {
                  return ws.readyState;
                },
                send(data, options) {
                  ws.send(data, options ?? {});
                },
                close: ws.close.bind(ws),
                on: ws.on.bind(ws),
                off: ws.off.bind(ws),
              };
              try {
                void sessions
                  .attach(id, port)
                  .catch(() => ws.close(1011, 'remote desktop unavailable'));
              } catch {
                ws.close(1011, 'remote desktop unavailable');
              }
            });
          },
        }),
      );
  }
  stopAdmission(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const withdraw of this.withdraw) withdraw();
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.stopAdmission();
      for (const socket of this.sockets) socket.terminate();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.sockets.clear();
    })());
  }
}
