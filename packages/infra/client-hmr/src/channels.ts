import type { ServerResponse } from 'node:http';
import type { WebBootGraph } from '@axterm/infra-client-modules/client';
const MAX_FRAME = 2 * 1024 * 1024;
/** One accepted write plus one latest graph; slow peers never accumulate graph history. */
class GraphChannel {
  private pending: string | undefined;
  private blocked = false;
  private stopped = false;
  private readonly done = Promise.withResolvers<void>();
  constructor(
    private readonly response: ServerResponse,
    private readonly signal: AbortSignal,
    private readonly released: () => void,
  ) {
    response.once('close', this.finish);
    response.once('error', this.stop);
    response.on('drain', this.flush);
    signal.addEventListener('abort', this.stop, { once: true });
  }
  send(line: string): void {
    if (this.stopped) return;
    if (this.blocked) {
      this.pending = line;
      return;
    }
    try {
      this.blocked = !this.response.write(line);
    } catch {
      this.stop();
    }
  }
  heartbeat(): void {
    if (!this.blocked) this.send(': keep-alive\n\n');
  }
  close(): Promise<void> {
    this.stop();
    return this.done.promise;
  }
  private flush = () => {
    this.blocked = false;
    const line = this.pending;
    this.pending = undefined;
    if (line) this.send(line);
  };
  private stop = () => {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = undefined;
    this.response.off('drain', this.flush);
    this.signal.removeEventListener('abort', this.stop);
    this.response.destroy();
    if (this.response.closed) this.finish();
  };
  private finish = () => {
    this.stopped = true;
    this.pending = undefined;
    this.response.off('close', this.finish);
    this.response.off('error', this.stop);
    this.response.off('drain', this.flush);
    this.signal.removeEventListener('abort', this.stop);
    this.released();
    this.done.resolve();
  };
}
export class GraphChannels {
  private readonly peers = new Set<GraphChannel>();
  private closed = false;
  constructor(private readonly graph: () => WebBootGraph) {}
  connect(response: ServerResponse, signal: AbortSignal): void {
    if (this.closed || signal.aborted || this.peers.size >= 16) {
      response.writeHead(503, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    let line: string;
    try {
      line = this.frame();
    } catch {
      response.writeHead(503, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    const peer = new GraphChannel(response, signal, () => this.peers.delete(peer));
    this.peers.add(peer);
    try {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      peer.send(line);
    } catch {
      void peer.close();
    }
  }
  publish(): void {
    if (this.closed) return;
    let line: string;
    try {
      line = this.frame();
    } catch {
      for (const peer of this.peers) void peer.close();
      return;
    }
    for (const peer of this.peers) peer.send(line);
  }
  heartbeat(): void {
    for (const peer of this.peers) peer.heartbeat();
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.peers].map((peer) => peer.close()));
  }
  private frame(): string {
    const line = 'data: ' + JSON.stringify({ type: 'graph', graph: this.graph() }) + '\n\n';
    if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('CLIENT_GRAPH_CAPACITY');
    return line;
  }
}
