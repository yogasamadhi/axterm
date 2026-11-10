import type { Duplex } from 'node:stream';
import type { Relay, RelayHandle } from '../ports/relay.ts';
import { waitStreamClosed } from './stream-lifetime.ts';
const PENDING = 4 * 1024 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
export class BinaryRelay implements Relay {
  constructor(private readonly protocol: 'VNC' | 'SPICE') {}
  async attach(input: Parameters<Relay['attach']>[0]): Promise<RelayHandle> {
    const lifetime = new AbortController();
    const abort = () => finish();
    let target: Duplex | undefined;
    let closed = false;
    let pendingBytes = 0;
    const pending: Buffer[] = [];
    const finish = (error?: string) => {
      if (closed) return;
      closed = true;
      lifetime.abort();
      input.signal.removeEventListener('abort', abort);
      input.socket.off('message', message);
      input.socket.off('close', abort);
      input.socket.off('error', failed);
      pending.length = 0;
      pendingBytes = 0;
      target?.destroy();
      if (input.socket.readyState === 1)
        input.socket.close(error ? 1011 : 1000, 'remote desktop closed');
      input.onClose(error);
    };
    const failed = () => finish(`${this.protocol}_CONNECTION_FAILED`);
    const message = (data: Buffer, binary: boolean) => {
      if (!binary || !data.length || data.length > PENDING)
        return finish(`${this.protocol}_PROTOCOL_ERROR`);
      if (!target) {
        if (pendingBytes + data.length > PENDING)
          return finish(`${this.protocol}_BACKPRESSURE_LIMIT`);
        pending.push(Buffer.from(data));
        pendingBytes += data.length;
        return;
      }
      if (target.writableLength + data.length > HIGH_WATER)
        return finish(`${this.protocol}_BACKPRESSURE_LIMIT`);
      target.write(data);
    };
    input.socket.on('message', message);
    input.socket.on('close', abort);
    input.socket.on('error', failed);
    input.signal.addEventListener('abort', abort, { once: true });
    const opening = Promise.resolve().then(async () => {
      if (input.signal.aborted || closed) {
        finish();
        return;
      }
      try {
        target = await input.openTarget(lifetime.signal);
        target.on('error', failed);
        if (closed) {
          target.destroy();
          return;
        }
        target.on('data', (data: Buffer | string) => {
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (input.socket.bufferedAmount + bytes.length > HIGH_WATER)
            return finish(`${this.protocol}_BACKPRESSURE_LIMIT`);
          if (input.socket.readyState === 1) input.socket.send(bytes, { binary: true });
        });
        target.once('end', () => finish());
        target.once('close', () => finish());
        for (const data of pending) target.write(data);
        pending.length = 0;
        pendingBytes = 0;
        input.onReady();
      } catch {
        failed();
      }
    });
    let closing: Promise<void> | undefined;
    return {
      close: () =>
        (closing ??= (async () => {
          finish();
          await opening;
          if (target) {
            const done = waitStreamClosed(target);
            target.destroy();
            await done;
          }
        })()),
    };
  }
}
