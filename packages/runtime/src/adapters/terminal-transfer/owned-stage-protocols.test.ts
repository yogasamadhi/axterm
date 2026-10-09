import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedStageJournal } from './owned-stage-journal';
import { XmodemSession } from './xmodem';
import { ZmodemReceiveFile } from './zmodem';
import { StagedTrzszWriter } from './trzsz';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'axterm-stage-protocols-'));
  roots.push(root);
  const directory = join(root, 'downloads');
  mkdirSync(directory);
  return { directory, journal: new OwnedStageJournal(join(root, 'private')) };
}

function crcFrame(data: Buffer): Buffer {
  const payload = Buffer.alloc(128, 0x1a);
  data.copy(payload);
  let crc = 0;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc <<= 1;
      if (crc & 0x1_0000) crc ^= 0x1021;
      crc &= 0xffff;
    }
  }
  const frame = Buffer.alloc(133);
  frame.set([0x01, 0x01, 0xfe]);
  payload.copy(frame, 3);
  frame.writeUInt16BE(crc, 131);
  return frame;
}

describe('terminal receive stage ownership across protocols', () => {
  it('journals XMODEM before a partial receive and clears it on cancellation', () => {
    const { directory, journal } = fixture();
    const session = new XmodemSession(
      { write: () => {} },
      { s: () => {} },
      undefined,
      undefined,
      undefined,
      undefined,
      journal,
    );
    session.startReceive();
    session.setSavePath(directory, 'x.bin');
    session.handleData(crcFrame(Buffer.from('partial')));
    expect(journal.review(directory)).toMatchObject([
      { protocol: 'xmodem', name: 'x.bin', state: 'verified' },
    ]);
    session.cancel();
    expect(journal.review(directory)).toEqual([]);
    journal.close();
  });

  it('journals ZMODEM before a partial receive and clears it after publication', async () => {
    const { directory, journal } = fixture();
    const file = new ZmodemReceiveFile(
      join(directory, 'z.bin'),
      'z.bin',
      4,
      undefined,
      undefined,
      journal,
    );
    await file.write(Buffer.from('DATA'));
    expect(journal.review(directory)).toMatchObject([
      { protocol: 'zmodem', name: 'z.bin', bytes: 4, state: 'verified' },
    ]);
    await file.commit();
    expect(journal.review(directory)).toEqual([]);
    journal.close();
  });

  it('journals TRZSZ before a partial receive and clears it on deletion', async () => {
    const { directory, journal } = fixture();
    const writer = new StagedTrzszWriter(
      join(directory, 't.bin'),
      't.bin',
      undefined,
      undefined,
      journal,
    );
    await writer.writeFile(Buffer.from('partial'));
    expect(journal.review(directory)).toMatchObject([
      { protocol: 'trzsz', name: 't.bin', bytes: 7, state: 'verified' },
    ]);
    await writer.deleteFile();
    expect(journal.review(directory)).toEqual([]);
    journal.close();
  });

  it('retains all three ownership records when normal stage removal is denied', async () => {
    const { directory, journal } = fixture();
    const denial = () => {
      throw Object.assign(new Error('Synthetic cleanup refusal'), { code: 'EACCES' });
    };
    const xmodem = new XmodemSession(
      { write: () => {} },
      { s: () => {} },
      undefined,
      undefined,
      undefined,
      denial,
      journal,
    );
    xmodem.startReceive();
    xmodem.setSavePath(directory, 'x.bin');
    xmodem.handleData(crcFrame(Buffer.from('partial')));
    xmodem.cancel();
    const zmodem = new ZmodemReceiveFile(
      join(directory, 'z.bin'),
      'z.bin',
      7,
      undefined,
      async () => denial(),
      journal,
    );
    await zmodem.write(Buffer.from('partial'));
    await expect(zmodem.cleanup()).rejects.toMatchObject({ code: 'EACCES' });
    const trzsz = new StagedTrzszWriter(
      join(directory, 't.bin'),
      't.bin',
      undefined,
      async () => denial(),
      journal,
    );
    await trzsz.writeFile(Buffer.from('partial'));
    await expect(trzsz.deleteFile()).rejects.toMatchObject({ code: 'EACCES' });
    const records = journal.review(directory);
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.state === 'verified')).toBe(true);
    for (const record of records) journal.removeVerified(record.id, directory);
    expect(journal.review(directory)).toEqual([]);
    journal.close();
  });
});
