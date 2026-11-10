import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/infra-web-server';
import type {} from '@axterm/infra-connection';
import type {} from '@axterm/infra-remote-access';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { TERMINAL_INPUT_FRAME_MAX_BYTES, TERMINAL_STREAM_PATH } from '@axterm/plugin-api/terminals';
import type { TerminalSocket, TerminalService } from '../application/terminal-service.ts';
const query = z.object({ id: z.uuid(), clientId: z.uuid() }).strict();
function reject(socket: Duplex, status: 400 | 401 | 403 | 404 | 410 | 429 | 503): void {
  socket.end(
    `HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`,
  );
}
/** Plugin-owned binary carrier; admission is shared with generated Remote, framing stays in TerminalService. */
export class TerminalBinaryStream {
  private readonly server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: TERMINAL_INPUT_FRAME_MAX_BYTES,
  });
  private readonly sockets = new Set<WebSocket>();
  private readonly withdraw: () => void;
  private accepting = true;
  private closing: Promise<void> | undefined;
  constructor(ctx: Context, terminals: TerminalService) {
    this.server.on('error', () => {
      console.warn('TERMINAL_STREAM_FAILED');
    });
    this.withdraw = ctx.webServer.registerUpgrade({
      path: TERMINAL_STREAM_PATH,
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
        const { id, clientId } = input.data;
        if (
          ctx.remoteAccess.decide({
            principal: admission.peer.principal,
            action: 'terminals/stream',
            resources: [{ kind: 'terminal', id }],
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
          // Retained exited sessions use the same bounded, domain-enforced read-only replay.
          terminals.get(id);
        } catch {
          reject(socket, 404);
          return;
        }
        this.server.handleUpgrade(req, socket, head, (ws) => {
          this.sockets.add(ws);
          ws.once('close', () => {
            this.sockets.delete(ws);
          });
          ws.on('error', () => ws.terminate());
          const port: TerminalSocket = {
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
            terminals.attach(id, port, clientId, { outputFlow: true });
          } catch {
            ws.close(1011, 'terminal unavailable');
          }
        });
      },
    });
  }
  stopAdmission(): void {
    if (!this.accepting) return;
    this.accepting = false;
    this.withdraw();
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
