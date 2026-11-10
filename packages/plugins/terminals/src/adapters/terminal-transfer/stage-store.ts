import { createHmac, randomBytes } from 'node:crypto';
import type { FileAuthority } from '@axterm/plugin-api/host';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import type { TerminalTransferProtocol } from '../../ports/terminal-transfer.ts';
export interface StageRecord {
  id: string;
  profile_name: string;
  generation: string;
  destination_hash: string;
  protocol: TerminalTransferProtocol;
  name: string;
  device: string;
  inode: string;
  state: 'receiving' | 'ready' | 'publishing' | 'failed' | 'interrupted';
  created_at: number;
}
/** Durable metadata only: no absolute paths, bytes or historical grant authority. */
export class TerminalStageStore {
  private readonly key: Buffer;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly profile: string,
    private readonly generation: string,
  ) {
    domain.transaction(() => {
      domain.run(
        'INSERT OR IGNORE INTO axterm_terminal_stage_keys(profile_name,key) VALUES (?,?)',
        profile,
        randomBytes(32),
      );
      domain.run(
        "UPDATE axterm_terminal_stages SET state='interrupted' WHERE profile_name=? AND generation<>? AND state IN ('receiving','ready','publishing')",
        profile,
        generation,
      );
    });
    const key = domain.get<{ key: Uint8Array }>(
      'SELECT key FROM axterm_terminal_stage_keys WHERE profile_name=?',
      profile,
    )?.key;
    if (!key || key.length !== 32) throw Error('TERMINAL_STAGE_KEY_UNAVAILABLE');
    this.key = Buffer.from(key);
  }
  destination(authority: FileAuthority): string {
    if (authority.grant.kind !== 'directory' || !authority.grant.permissions.includes('write'))
      throw Error('TERMINAL_STAGE_DIRECTORY_REQUIRED');
    return createHmac('sha256', this.key)
      .update(
        JSON.stringify([
          authority.rootPath,
          authority.rootIdentity.device,
          authority.rootIdentity.inode,
        ]),
      )
      .digest('hex');
  }
  create(
    input: Omit<StageRecord, 'profile_name' | 'generation' | 'created_at' | 'state'>,
  ): StageRecord {
    return this.domain.transaction(() => {
      const count = this.domain.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM axterm_terminal_stages WHERE profile_name=?',
        this.profile,
      )!.count;
      if (count >= 64) throw Error('TERMINAL_STAGE_CAPACITY');
      const value: StageRecord = {
        ...input,
        profile_name: this.profile,
        generation: this.generation,
        created_at: Date.now(),
        state: 'receiving',
      };
      this.domain.run(
        'INSERT INTO axterm_terminal_stages(id,profile_name,generation,destination_hash,protocol,name,device,inode,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        value.id,
        this.profile,
        this.generation,
        value.destination_hash,
        value.protocol,
        value.name,
        value.device,
        value.inode,
        value.state,
        value.created_at,
      );
      return value;
    });
  }
  get(id: string) {
    return this.domain.get<StageRecord>(
      'SELECT * FROM axterm_terminal_stages WHERE id=? AND profile_name=?',
      id,
      this.profile,
    );
  }
  list(destination: string) {
    return this.domain.all<StageRecord>(
      'SELECT * FROM axterm_terminal_stages WHERE profile_name=? AND destination_hash=? ORDER BY created_at DESC LIMIT 64',
      this.profile,
      destination,
    );
  }
  update(id: string, state: StageRecord['state'], name?: string) {
    this.domain.run(
      'UPDATE axterm_terminal_stages SET state=?,name=COALESCE(?,name) WHERE id=? AND profile_name=? AND generation=?',
      state,
      name ?? null,
      id,
      this.profile,
      this.generation,
    );
  }
  forget(id: string) {
    this.domain.run(
      'DELETE FROM axterm_terminal_stages WHERE id=? AND profile_name=?',
      id,
      this.profile,
    );
  }
}
