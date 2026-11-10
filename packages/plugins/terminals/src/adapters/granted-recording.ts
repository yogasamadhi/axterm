import { PassThrough } from 'node:stream';
import type { LocalFileLease } from '@axterm/plugin-api/host';
import type { TerminalRecorderFactory } from '../ports/terminal-recording.ts';
import { TerminalRecordingWriter } from './terminal-recording.ts';
/** The Files owner pins authority and the file; Terminals owns only its parser and bounded stream. */
export function grantedRecording(
  lease: LocalFileLease,
  revoke: () => Promise<void>,
): TerminalRecorderFactory {
  let opened = false;
  return {
    async open(options) {
      if (opened) throw Error('TERMINAL_RECORDING_ALREADY_OPENED');
      options.signal?.throwIfAborted();
      opened = true;
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      const writer = TerminalRecordingWriter.fromStream(stream, options);
      const writing = lease.append(lease.path, stream).catch((error) => {
        stream.destroy(error instanceof Error ? error : new Error('TERMINAL_RECORDING_IO_FAILED'));
        throw error;
      });
      void writing.catch(() => {});
      let closing: Promise<void> | undefined;
      return {
        get bytesWritten() {
          return writer.bytesWritten;
        },
        write: (data) => writer.write(data),
        close: () =>
          (closing ??= (async () => {
            const results = await Promise.allSettled([writer.close(), writing]);
            const cleanup = await Promise.allSettled([lease.close(), revoke()]);
            if ([...results, ...cleanup].some((result) => result.status === 'rejected'))
              throw Error('TERMINAL_RECORDING_DRAIN_FAILED');
          })()),
      };
    },
  };
}
