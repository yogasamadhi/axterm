import type { Duplex } from 'node:stream';
import type { SpiceRelay, SpiceRelayHandle } from '../../ports/spice-relay';

const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const HIGH_WATER_BYTES = 8 * 1024 * 1024;

export class NodeSpiceRelay implements SpiceRelay {
  async attach(input: Parameters<SpiceRelay['attach']>[0]): Promise<SpiceRelayHandle> {
    const owner = new AbortController();
    const abortFromOwner = () => owner.abort(input.signal.reason);
    input.signal.addEventListener('abort', abortFromOwner, { once: true });
    let target: Duplex | undefined;
    let closed = false;
    let pendingBytes = 0;
    const pending: Buffer[] = [];

    const finish = (errorCode?: string) => {
      if (closed) return;
      closed = true;
      owner.abort();
      input.signal.removeEventListener('abort', abortFromOwner);
      input.socket.off('message', onMessage);
      input.socket.off('close', onSocketClose);
      input.socket.off('error', onSocketError);
      target?.removeAllListeners();
      if (target && !target.destroyed) target.destroy();
      if (input.socket.readyState === 1)
        input.socket.close(errorCode ? 1011 : 1000, 'spice closed');
      input.onClose(errorCode);
    };
    const onSocketClose = () => finish();
    const onSocketError = () => finish('SPICE_WEBSOCKET_FAILED');
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (!isBinary || !data.length) {
        finish('SPICE_PROTOCOL_ERROR');
        return;
      }
      if (!target) {
        pendingBytes += data.length;
        if (pendingBytes > MAX_PENDING_BYTES) finish('SPICE_BACKPRESSURE_LIMIT');
        else pending.push(Buffer.from(data));
        return;
      }
      if (target.writableLength + data.length > HIGH_WATER_BYTES) {
        finish('SPICE_BACKPRESSURE_LIMIT');
        return;
      }
      target.write(data);
    };

    input.socket.on('message', onMessage);
    input.socket.on('close', onSocketClose);
    input.socket.on('error', onSocketError);
    const start = async () => {
      try {
        target = await input.openTarget(owner.signal);
        if (closed) target.destroy();
        else {
          target.on('data', (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (input.socket.bufferedAmount + bytes.length > HIGH_WATER_BYTES) {
              finish('SPICE_BACKPRESSURE_LIMIT');
              return;
            }
            if (input.socket.readyState === 1) input.socket.send(bytes, { binary: true });
          });
          target.on('end', () => finish());
          target.on('close', () => finish());
          target.on('error', () => finish('SPICE_CONNECTION_FAILED'));
          for (const chunk of pending) target.write(chunk);
          pending.length = 0;
          pendingBytes = 0;
          input.onReady();
        }
      } catch {
        finish('SPICE_CONNECTION_FAILED');
      }
    };
    if (input.signal.aborted) finish();
    else void start();
    return { close: finish };
  }
}
