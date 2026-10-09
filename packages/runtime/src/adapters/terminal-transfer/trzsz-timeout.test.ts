import { randomBytes, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TrzszBuffer, TrzszTransfer } from 'trzsz2';

describe('TRZSZ library receive bounds and deadline', () => {
  // The published library marks these methods private in its declarations, but
  // the timer leak lives inside recvData rather than the public file workflow.
  const protocolData = (transfer: TrzszTransfer) =>
    transfer as unknown as {
      recvData: (
        binary: boolean,
        escapeCodes: number[],
        timeoutInMilliseconds: number,
      ) => Promise<Uint8Array>;
      sendData: (data: Uint8Array, binary: boolean, escapeCodes: number[]) => Promise<void>;
    };

  it('releases the receive timer as soon as data arrives', async () => {
    vi.useFakeTimers();
    const receiver = new TrzszTransfer(() => {});
    const sender = new TrzszTransfer((data) => receiver.addReceivedData(data));
    try {
      const data = Buffer.from([0, 1, 255]);
      const received = protocolData(receiver).recvData(false, [], 100_000);
      await protocolData(sender).sendData(data, false, []);
      expect(Buffer.from(await received)).toEqual(data);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      sender.cleanup();
      receiver.cleanup();
      vi.useRealTimers();
    }
  });

  it('still reports a genuinely idle peer at the deadline', async () => {
    vi.useFakeTimers();
    const receiver = new TrzszTransfer(() => {});
    try {
      const failure = expect(protocolData(receiver).recvData(false, [], 100)).rejects.toThrow(
        'Receive data timeout',
      );
      await vi.advanceTimersByTimeAsync(100);
      await failure;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      receiver.cleanup();
      vi.useRealTimers();
    }
  });

  it('rejects a binary chunk length above the bounded receive limit before allocating it', async () => {
    const receiver = new TrzszTransfer(() => {});
    try {
      const failure = expect(protocolData(receiver).recvData(true, [], 30)).rejects.toThrow(
        'TRZSZ binary chunk exceeds limit',
      );
      receiver.addReceivedData(Buffer.from('#DATA:16777217\n'));
      await failure;
    } finally {
      receiver.cleanup();
    }
  });

  it.each([
    {
      name: 'POSIX newline',
      terminator: 0x0a,
      receive: (buffer: TrzszBuffer) => buffer.readLine(),
    },
    {
      name: 'Windows terminal line',
      terminator: 0x21,
      receive: (buffer: TrzszBuffer) => buffer.readLineOnWindows(),
    },
  ])(
    'rejects an oversized $name before growing the decoded line',
    async ({ terminator, receive }) => {
      const buffer = new TrzszBuffer();
      const result = receive(buffer).then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      const input = Buffer.alloc(32 * 1024 * 1024 + 2, 0x41);
      input[input.length - 1] = terminator;
      buffer.addBuffer(input);
      expect(await result).toBe('TRZSZ protocol line exceeds limit');
    },
  );

  it('accepts a default-sized incompressible text-mode DATA frame below the limit', async () => {
    const receiver = new TrzszTransfer(() => {});
    const sender = new TrzszTransfer((data) => receiver.addReceivedData(data));
    try {
      const bytes = randomBytes(10 * 1024 * 1024);
      const received = protocolData(receiver).recvData(false, [], 30_000);
      await protocolData(sender).sendData(bytes, false, []);
      const result = Buffer.from(await received);
      expect(result.byteLength).toBe(bytes.byteLength);
      expect(createHash('sha256').update(result).digest('hex')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
    } finally {
      sender.cleanup();
      receiver.cleanup();
    }
  });

  it('keeps short Windows terminal lines with VT100 decoration readable', async () => {
    const buffer = new TrzszBuffer();
    const line = buffer.readLineOnWindows();
    buffer.addBuffer(Buffer.from('\u001b[0m#DATA:QQ==!'));
    expect(await line).toBe('#DATA:QQ==');
  });

  it('rejects queued peer bytes above 64 MiB without retaining the rejected chunk', () => {
    const buffer = new TrzszBuffer();
    buffer.addBuffer(Buffer.alloc(64 * 1024 * 1024));
    expect(() => buffer.addBuffer(Buffer.from([0x41]))).toThrow(
      'TRZSZ receive buffer exceeds limit',
    );
    expect((buffer as unknown as { bufArray: Uint8Array[] }).bufArray).toHaveLength(1);
  });

  it('reclaims queue slots after each consumed chunk', async () => {
    const buffer = new TrzszBuffer();
    for (let index = 0; index < 2048; index += 1) {
      buffer.addBuffer(Buffer.from([index & 0xff]));
      expect(Buffer.from(await buffer.readBinary(1))).toEqual(Buffer.from([index & 0xff]));
    }
    expect((buffer as unknown as { bufArray: unknown[] }).bufArray).toHaveLength(0);
  });

  it('includes unread bytes of the active chunk and clears the quota when drained', async () => {
    const buffer = new TrzszBuffer();
    buffer.addBuffer(Buffer.alloc(1024 * 1024, 0x41));
    await buffer.readBinary(1);
    expect(() => buffer.addBuffer(Buffer.alloc(64 * 1024 * 1024))).toThrow(
      'TRZSZ receive buffer exceeds limit',
    );
    buffer.drainBuffer();
    expect(() => buffer.addBuffer(Buffer.alloc(64 * 1024 * 1024))).not.toThrow();
  });

  it('bounds queued zero-byte chunks as well as total queued bytes', () => {
    const buffer = new TrzszBuffer();
    for (let index = 0; index < 4096; index += 1) buffer.addBuffer(new Uint8Array());
    expect(() => buffer.addBuffer(new Uint8Array())).toThrow('TRZSZ receive buffer exceeds limit');
  });

  it('does not resume a Blob conversion after its queue is drained', async () => {
    const buffer = new TrzszBuffer();
    buffer.addBuffer(new Blob([Buffer.from([0x41])]));
    const pending = buffer.readBinary(1);
    buffer.drainBuffer();
    await expect(pending).rejects.toThrow('Stopped');
  });
});
