import type { TerminalTransferRecoveryRecord } from '@workspace/contracts';
import type { ResolvedTerminalTransferGrant } from './terminal-transfer-service';
import { ApplicationError } from './errors';

interface OwnershipStore {
  review(directory: string): TerminalTransferRecoveryRecord[];
  removeVerified(id: string, directory: string): void;
  forget(id: string): void;
}

/** User-driven review only; a persisted ownership record is never a File Grant. */
export class TerminalTransferRecoveryService {
  constructor(private readonly journal: OwnershipStore) {}

  review(grant: ResolvedTerminalTransferGrant): TerminalTransferRecoveryRecord[] {
    this.assertGrant(grant);
    try {
      return this.journal.review(grant.path);
    } catch {
      throw new ApplicationError('INVALID_STATE', 'Unable to review the selected directory', 409);
    }
  }

  remove(id: string, grant: ResolvedTerminalTransferGrant): TerminalTransferRecoveryRecord[] {
    this.assertGrant(grant);
    try {
      this.journal.removeVerified(id, grant.path);
      return this.journal.review(grant.path);
    } catch {
      // Filesystem errors frequently contain absolute paths; never forward them.
      throw new ApplicationError(
        'INVALID_STATE',
        'The partial file could not be verified and removed; inspect it manually',
        409,
      );
    }
  }

  forget(id: string, grant: ResolvedTerminalTransferGrant): TerminalTransferRecoveryRecord[] {
    this.assertGrant(grant);
    // A fresh matching directory selection is needed before forgetting even
    // though this operation does not touch any destination file.
    try {
      if (!this.journal.review(grant.path).some((record) => record.id === id))
        throw new Error('No matching ownership record');
      this.journal.forget(id);
      return this.journal.review(grant.path);
    } catch {
      throw new ApplicationError('INVALID_STATE', 'Unable to forget the selected record', 409);
    }
  }

  private assertGrant(grant: ResolvedTerminalTransferGrant): void {
    if (grant.kind !== 'directory' || !grant.permissions.includes('write'))
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'A fresh writable directory grant is required',
        400,
      );
  }
}
