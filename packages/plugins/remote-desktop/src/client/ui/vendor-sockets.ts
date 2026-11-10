import type { ConnectionHandle, ConnectionWebSocket } from '@axterm/infra-connection/client';
import { REMOTE_DESKTOP_STREAM_PATH } from '@axterm/plugin-api/remote-desktop';
import { idSchema } from '@axterm/plugin-api/catalog';
const MAX_FRAME = 4 * 1024 * 1024,
  MAX_BUFFER = 8 * 1024 * 1024;
const SYNTHETIC = 'ws://axterm-remote-desktop.invalid/';
export interface VendorSocketBinding {
  readonly url: string;
  close(): Promise<void>;
}
/** Protocol-private constructor adaptation. Authentication stays in the selected Connection carrier. */
export class VendorSocketRoutes {
  private readonly routes = new Map<
    string,
    {
      remaining: number;
      id: string;
      generation: ReturnType<ConnectionHandle['generation']['getSnapshot']>;
      sockets: Set<BoundSocket>;
      binding: VendorSocketBinding;
    }
  >();
  private readonly original: typeof WebSocket;
  private readonly proxy: typeof WebSocket;
  private readonly unsubscribe: () => void;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly connection: Pick<ConnectionHandle, 'generation' | 'openWebSocket'>,
    private readonly surface: { WebSocket: typeof WebSocket } = window,
  ) {
    this.original = surface.WebSocket;
    this.proxy = new Proxy(this.original, {
      construct: (target, args, newTarget) => {
        const url = String(args[0]),
          route = this.routes.get(url);
        if (!route) {
          if (url.startsWith(SYNTHETIC)) throw Error('REMOTE_DESKTOP_SOCKET_RETIRED');
          return Reflect.construct(target, args, newTarget);
        }
        if (
          this.closing ||
          route.remaining < 1 ||
          connection.generation.getSnapshot() !== route.generation
        )
          throw Error('REMOTE_DESKTOP_SOCKET_UNAVAILABLE');
        route.remaining--;
        const physical = connection.openWebSocket(
          REMOTE_DESKTOP_STREAM_PATH + '?' + new URLSearchParams({ id: route.id }),
        );
        const socket = new BoundSocket(physical, url, () => route.sockets.delete(socket));
        route.sockets.add(socket);
        return socket;
      },
    });
    surface.WebSocket = this.proxy;
    this.unsubscribe = connection.generation.subscribe(() => {
      for (const route of this.routes.values())
        if (connection.generation.getSnapshot() !== route.generation)
          void route.binding.close().catch(() => {});
    });
  }
  bind(id: string, maxUses = 1): VendorSocketBinding {
    idSchema.parse(id);
    const generation = this.connection.generation.getSnapshot();
    if (
      this.closing ||
      !generation ||
      this.routes.size >= 24 ||
      !Number.isInteger(maxUses) ||
      maxUses < 1 ||
      maxUses > 16
    )
      throw Error('REMOTE_DESKTOP_SOCKET_CAPACITY');
    const url = SYNTHETIC + crypto.randomUUID();
    let closing: Promise<void> | undefined;
    const sockets = new Set<BoundSocket>();
    const binding: VendorSocketBinding = {
      url,
      close: () =>
        (closing ??= (async () => {
          const route = this.routes.get(url);
          if (route) route.remaining = 0;
          const results = await Promise.allSettled([...sockets].map((socket) => socket.shutdown()));
          if (results.some((result) => result.status === 'rejected') || sockets.size)
            throw Error('REMOTE_DESKTOP_SOCKET_UNDRAINED');
          this.routes.delete(url);
        })()),
    };
    this.routes.set(url, { remaining: maxUses, id, generation, sockets, binding });
    return binding;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.unsubscribe();
      const result = await Promise.allSettled(
        [...this.routes.values()].map((route) => route.binding.close()),
      );
      if (this.surface.WebSocket === this.proxy) this.surface.WebSocket = this.original;
      if (result.some((value) => value.status === 'rejected') || this.routes.size)
        throw Error('REMOTE_DESKTOP_SOCKETS_UNDRAINED');
    })());
  }
}
/** Standard event facade without queues; all bytes are dispatched directly to the protocol vendor. */
class BoundSocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly extensions = '';
  readonly protocol = '';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private ended = false;
  private readonly drained = Promise.withResolvers<void>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly physical: ConnectionWebSocket,
    readonly url: string,
    private readonly release: () => void,
  ) {
    super();
    physical.binaryType = 'arraybuffer';
    physical.addEventListener('open', this.open);
    physical.addEventListener('message', this.message);
    physical.addEventListener('error', this.error);
    physical.addEventListener('close', this.end);
  }
  get readyState() {
    return this.ended ? 3 : this.physical.readyState;
  }
  get bufferedAmount() {
    return this.physical.bufferedAmount ?? 0;
  }
  get binaryType() {
    return 'arraybuffer';
  }
  set binaryType(_value: string) {
    this.physical.binaryType = 'arraybuffer';
  }
  send(data: ArrayBuffer | ArrayBufferView) {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : undefined;
    if (
      this.ended ||
      this.readyState !== 1 ||
      !bytes?.byteLength ||
      bytes.byteLength > MAX_FRAME ||
      this.bufferedAmount + bytes.byteLength > MAX_BUFFER
    ) {
      this.close(1008, 'protocol bounds');
      throw Error('REMOTE_DESKTOP_SOCKET_BOUNDS');
    }
    this.physical.send(bytes);
  }
  close(code = 1000, reason = 'remote desktop closed') {
    if (!this.ended) this.physical.close(code, reason);
  }
  shutdown(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.ended) return;
      this.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.drained.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('REMOTE_DESKTOP_SOCKET_CLOSE_TIMEOUT')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })());
  }
  private readonly open = () => {
    const event = new Event('open');
    this.dispatchEvent(event);
    this.onopen?.(event);
  };
  private readonly message = (raw: { data: unknown }) => {
    if (this.ended) return;
    if (
      !(raw.data instanceof ArrayBuffer) ||
      !raw.data.byteLength ||
      raw.data.byteLength > MAX_FRAME
    ) {
      this.close(1008, 'protocol bounds');
      return;
    }
    const event = new MessageEvent('message', { data: raw.data });
    this.dispatchEvent(event);
    this.onmessage?.(event);
  };
  private readonly error = () => {
    const event = new Event('error');
    this.dispatchEvent(event);
    this.onerror?.(event);
    this.close(1011, 'remote desktop unavailable');
  };
  private readonly end = (raw: object) => {
    if (this.ended) return;
    this.ended = true;
    this.physical.removeEventListener('open', this.open);
    this.physical.removeEventListener('message', this.message);
    this.physical.removeEventListener('error', this.error);
    this.physical.removeEventListener('close', this.end);
    this.release();
    this.drained.resolve();
    const status = raw as { code?: unknown; wasClean?: unknown };
    const event = new CloseEvent('close', {
      code: typeof status.code === 'number' ? status.code : 0,
      wasClean: status.wasClean === true,
    });
    this.dispatchEvent(event);
    this.onclose?.(event);
  };
}
