import type { FileGrant } from '@workspace/contracts/desktop';

interface DirectoryGrantClient {
  revokeFileGrant(id: string): Promise<unknown>;
}

/** One directory scope and one current selection; no pending grants or paths are queued here. */
export class LocalDirectoryGrantOwner {
  private active = true;
  private selection: symbol | undefined;
  private grant: FileGrant | undefined;

  constructor(
    private readonly client: DirectoryGrantClient,
    initial?: FileGrant,
  ) {
    this.grant = initial;
  }

  beginSelection(): symbol {
    const ticket = Symbol('directory-selection');
    this.selection = ticket;
    return ticket;
  }

  async adopt(ticket: symbol, grant: FileGrant): Promise<boolean> {
    if (!this.active || ticket !== this.selection) {
      if (this.grant?.grantId !== grant.grantId) await this.release(grant);
      return false;
    }
    const previous = this.grant;
    this.grant = grant;
    if (previous && previous.grantId !== grant.grantId) await this.release(previous);
    return this.active && ticket === this.selection && this.grant?.grantId === grant.grantId;
  }

  current(): FileGrant | undefined {
    return this.grant;
  }

  isCurrent(ticket: symbol): boolean {
    return this.active && ticket === this.selection;
  }

  async dispose(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.selection = undefined;
    const previous = this.grant;
    this.grant = undefined;
    if (previous) await this.release(previous);
  }

  private async release(grant: FileGrant): Promise<void> {
    await this.client.revokeFileGrant(grant.grantId).catch(() => undefined);
  }
}
