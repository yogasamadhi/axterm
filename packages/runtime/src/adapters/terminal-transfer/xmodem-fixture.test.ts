/* eslint-disable prefer-const */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import xmodemImport from './electerm/xmodem.cjs';

interface XmodemSessionLike {
  startReceive(): void;
  setSavePath(path: string, name: string): void;
  startSend(): void;
  setSendFiles(files: Array<{ path: string; name: string; size: number }>): void;
  handleData(data: Buffer): boolean;
  cancel(): void;
  destroy(): void;
}

type XmodemSessionConstructor = new (
  terminal: { write(data: Uint8Array): void; writeRaw(data: Uint8Array): void },
  socket: { s(event: unknown): void },
) => XmodemSessionLike;

function constructor(): XmodemSessionConstructor {
  const module = xmodemImport as Record<string, unknown> & { default?: Record<string, unknown> };
  return (module.default?.XmodemSession ?? module.XmodemSession) as XmodemSessionConstructor;
}

async function waitFor(predicate: () => Promise<boolean>, timeout = 2_000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeout) throw new Error('XMODEM fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Electerm XMODEM adapter fixture', () => {
  it('moves binary data bidirectionally between sender and receiver with bounded packets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-'));
    const destination = join(root, 'destination');
    await mkdir(destination);
    const source = join(root, 'source.bin');
    const payload = Buffer.concat([Buffer.from('Axterm XMODEM\0'), Buffer.alloc(1_777, 0xa5)]);
    await writeFile(source, payload);
    const events: Array<{ side: 'sender' | 'receiver'; event: string }> = [];
    const Session = constructor();
    let sender!: XmodemSessionLike;
    let receiver!: XmodemSessionLike;
    const forward = (target: () => XmodemSessionLike, data: Uint8Array) => {
      const packet = Buffer.from(data);
      expect(packet.byteLength).toBeLessThanOrEqual(1_029);
      setImmediate(() => target().handleData(packet));
    };
    sender = new Session(
      {
        write: (data) => forward(() => receiver, data),
        writeRaw: (data) => forward(() => receiver, data),
      },
      {
        s: (value) =>
          events.push({ side: 'sender', event: String((value as { event?: string }).event) }),
      },
    );
    receiver = new Session(
      {
        write: (data) => forward(() => sender, data),
        writeRaw: (data) => forward(() => sender, data),
      },
      {
        s: (value) =>
          events.push({ side: 'receiver', event: String((value as { event?: string }).event) }),
      },
    );
    try {
      receiver.startReceive();
      receiver.setSavePath(destination, 'received.bin');
      sender.startSend();
      sender.setSendFiles([{ path: source, name: 'source.bin', size: payload.length }]);
      sender.handleData(Buffer.from([0x43]));
      await waitFor(async () =>
        readFile(join(destination, 'received.bin'))
          .then((value) => value.byteLength >= payload.byteLength)
          .catch(() => false),
      );
      const received = await readFile(join(destination, 'received.bin'));
      expect(received.subarray(0, payload.length)).toEqual(payload);
      expect(events).toEqual(
        expect.arrayContaining([
          { side: 'sender', event: 'file-complete' },
          { side: 'receiver', event: 'file-complete' },
        ]),
      );
    } finally {
      sender.cancel();
      receiver.cancel();
      sender.destroy();
      receiver.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });
});
