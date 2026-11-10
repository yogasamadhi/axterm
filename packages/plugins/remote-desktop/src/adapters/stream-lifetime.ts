import type { Readable, Writable } from 'node:stream';
/** Some vendor streams suppress close on failed _destroy; closed still records its callback. */
export function waitStreamClosed(stream: Readable | Writable): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.off('close', done);
      stream.off('error', failed);
      resolve();
    };
    const failed = () => {
      queueMicrotask(() => {
        if (stream.closed) done();
      });
    };
    stream.once('close', done);
    stream.on('error', failed);
    if (stream.closed) done();
  });
}
