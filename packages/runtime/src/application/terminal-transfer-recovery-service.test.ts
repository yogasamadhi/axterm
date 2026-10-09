import { afterEach, describe, expect, it } from 'vitest';
import { closeSync, mkdtempSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedStageJournal } from '../adapters/terminal-transfer/owned-stage-journal';
import { TerminalTransferRecoveryService } from './terminal-transfer-recovery-service';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('TerminalTransferRecoveryService', () => {
  it('requires a fresh writable directory grant and returns path-free metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'axterm-recovery-service-'));
    roots.push(root);
    const directory = join(root, 'downloads');
    mkdirSync(directory);
    const journal = new OwnedStageJournal(join(root, 'private'));
    const id = journal.prepare(directory, '.axterm-test.part', 'payload.bin', 'xmodem');
    const descriptor = openSync(join(directory, '.axterm-test.part'), 'wx', 0o600);
    writeSync(descriptor, 'partial');
    journal.seal(id, descriptor);
    closeSync(descriptor);
    const service = new TerminalTransferRecoveryService(journal);
    const grant = {
      path: directory,
      name: 'downloads',
      kind: 'directory' as const,
      permissions: ['write' as const],
    };
    expect(() => service.review({ ...grant, permissions: ['read'] })).toThrow();
    const records = service.review(grant);
    expect(records).toMatchObject([{ id, state: 'verified', name: 'payload.bin', bytes: 7 }]);
    expect(JSON.stringify(records)).not.toContain(root);
    service.remove(id, grant);
    expect(service.review(grant)).toEqual([]);
    journal.close();
  });
});
