import { Readable } from 'node:stream';
import type { HostFiles } from '@axterm/plugin-api/host';
import type { SyncBackupWriter } from '../application/sync.ts';
import { SyncWorkflowError } from '../application/sync-errors.ts';
/** Files owns pinned authority and atomic staging. Configuration never receives a raw path. */
export class SyncBackupFiles implements SyncBackupWriter {
  constructor(private readonly files: () => HostFiles | undefined) {}
  async write(grantId: string, contents: Uint8Array, signal: AbortSignal): Promise<void> {
    if (contents.length > 24 * 1024 * 1024) throw new SyncWorkflowError('capacity');
    const files = this.files();
    if (!files) throw new SyncWorkflowError('unavailable');
    const lease = await files.open(grantId, 'write', signal);
    try {
      lease.signal.throwIfAborted();
      await lease.write(lease.path, Readable.from([contents]), { overwrite: true, mode: 0o600 });
    } finally {
      await lease.close();
    }
  }
}
