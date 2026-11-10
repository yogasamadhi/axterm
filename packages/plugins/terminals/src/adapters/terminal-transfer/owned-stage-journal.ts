/** Protocol-stage persistence port; the owning application supplies ctx.storage. */
export type OwnedStageProtocol = 'xmodem' | 'zmodem' | 'trzsz';

export interface OwnedStageRecord {
  id: string;
  protocol: OwnedStageProtocol;
  name: string;
  createdAt: number;
  bytes: number;
  state: 'verified' | 'absent' | 'unverified' | 'expired';
}

export interface StageOwnershipWriter {
  prepare(
    directory: string,
    stageName: string,
    finalName: string,
    protocol: OwnedStageProtocol,
    transferId?: string,
  ): string;
  seal(id: string, descriptor: number): void;
  clearIfAbsent(id: string, directory: string): void;
}
