import { idSchema } from '@axterm/plugin-api/catalog';
import type { ConnectionHandle, ConnectionWebSocket } from '@axterm/infra-connection/client';
import { REMOTE_DESKTOP_STREAM_PATH } from '@axterm/plugin-api/remote-desktop';
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
/** One generation-bound byte channel. Protocol clients consume bytes directly; no replay or model state. */
export class RemoteDesktopStream {
  private readonly socket: ConnectionWebSocket;
  private readonly unsubscribe: () => void;
  private closed = false;
  constructor(
    connection: Pick<ConnectionHandle, 'generation' | 'openWebSocket'>,
    id: string,
    private readonly consume: (bytes: Uint8Array) => void,
    private readonly ended: () => void = () => {},
  ) {
    idSchema.parse(id);
    const generation = connection.generation.getSnapshot();
    if (!generation) throw new Error('REMOTE_DESKTOP_GENERATION_UNAVAILABLE');
    this.socket = connection.openWebSocket(
      REMOTE_DESKTOP_STREAM_PATH + '?' + new URLSearchParams({ id }),
    );
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('message', this.message);
    this.socket.addEventListener('close', this.dispose);
    this.socket.addEventListener('error', this.dispose);
    this.unsubscribe = connection.generation.subscribe(() => {
      if (connection.generation.getSnapshot() !== generation) this.dispose();
    });
  }
  send(bytes: Uint8Array): boolean {
    if (
      this.closed ||
      this.socket.readyState !== 1 ||
      !bytes.length ||
      bytes.length > MAX_FRAME ||
      (this.socket.bufferedAmount ?? 0) + bytes.length > MAX_BUFFER
    )
      return false;
    try {
      this.socket.send(bytes);
      return true;
    } catch {
      this.dispose();
      return false;
    }
  }
  private readonly message = (event: { data: unknown }) => {
    if (this.closed) return;
    if (
      !(event.data instanceof ArrayBuffer) ||
      !event.data.byteLength ||
      event.data.byteLength > MAX_FRAME
    ) {
      this.dispose();
      return;
    }
    try {
      this.consume(new Uint8Array(event.data));
    } catch {
      this.dispose();
    }
  };
  dispose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.socket.removeEventListener('message', this.message);
    this.socket.removeEventListener('close', this.dispose);
    this.socket.removeEventListener('error', this.dispose);
    this.socket.close();
    try {
      this.ended();
    } catch {
      console.warn('REMOTE_DESKTOP_STREAM_OBSERVER_FAILED');
    }
  };
}
