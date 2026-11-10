import { privateTerminalStagingFixture } from '../fixtures/level3-terminal-private-staging.ts';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  link,
  symlink,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TerminalStageStore } from '../../packages/plugins/terminals/src/adapters/terminal-transfer/stage-store.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const fixture = () => privateTerminalStagingFixture(cleanups);
it('copies uploads into private bounded files without giving engines user paths or mutable source authority', async () => {
  const f = await fixture(),
    source = join(f.target, 'source.txt');
  await writeFile(source, 'UPLOAD_SOURCE');
  const grant = await f.registry.createTrustedPath(source, 'file', ['read']);
  const stage = await f.staging.prepare(grant.grantId, 'upload', 'xmodem', f.signal);
  expect(stage.path).not.toBe(source);
  expect(stage.size).toBe(13);
  expect(await readFile(stage.path, 'utf8')).toBe('UPLOAD_SOURCE');
  await writeFile(stage.path, 'PRIVATE_MODIFICATION');
  expect(await readFile(source, 'utf8')).toBe('UPLOAD_SOURCE');
  await stage.close();
  expect(f.staging.resourceCount()).toBe(0);
  expect(await readdir(f.base)).toEqual([]);
});
it('receives privately and publishes complete bytes only through a live Files lease', async () => {
  const f = await fixture(),
    stage = await f.staging.prepare(f.grant.grantId, 'download', 'zmodem', f.signal);
  await writeFile(join(stage.path, 'download.txt'), 'COMPLETE_DOWNLOAD');
  expect(await readdir(f.target)).toEqual([]);
  await stage.publish();
  expect(await readFile(join(f.target, 'download.txt'), 'utf8')).toBe('COMPLETE_DOWNLOAD');
  await stage.close();
  expect(await readdir(f.base)).toEqual([]);
  const authority = await f.registry.authorize(f.grant.grantId, 'write');
  expect(f.store.list(f.store.destination(authority))).toEqual([]);
});
it('refuses overwrite and keeps failed private stages for explicit fresh-grant review/removal', async () => {
  const f = await fixture();
  await writeFile(join(f.target, 'existing.txt'), 'KEEP_ORIGINAL');
  const stage = await f.staging.prepare(f.grant.grantId, 'download', 'trzsz', f.signal);
  await writeFile(join(stage.path, 'existing.txt'), 'NEW');
  await expect(stage.publish()).rejects.toThrow();
  await stage.close();
  expect(await readFile(join(f.target, 'existing.txt'), 'utf8')).toBe('KEEP_ORIGINAL');
  const readonlyGrant = await f.registry.createTrustedPath(f.target, 'directory', ['read']);
  await expect(f.staging.review(readonlyGrant.grantId, f.signal)).rejects.toThrow();
  const records = await f.staging.review(f.grant.grantId, f.signal);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ state: 'verified', bytes: 3 });
  expect(JSON.stringify(f.store.get(records[0]!.id))).not.toContain(f.target);
  await f.staging.remove(records[0]!.id, f.grant.grantId, f.signal);
  expect(await readdir(f.base)).toEqual([]);
});
it('cannot publish after grant revocation and never replays an interrupted stage after generation replacement', async () => {
  const f = await fixture(),
    stage = await f.staging.prepare(f.grant.grantId, 'download', 'xmodem', f.signal);
  await writeFile(join(stage.path, 'file'), 'PRIVATE');
  f.revoke(f.grant.grantId);
  expect(stage.signal.aborted).toBe(true);
  await expect(stage.publish()).rejects.toThrow();
  await stage.close();
  expect(await readdir(f.target)).toEqual([]);
  const next = new TerminalStageStore(f.domain, 'desktop', randomUUID()),
    other = new TerminalStageStore(f.domain, 'web', randomUUID());
  const rows = f.domain.all<{ id: string; destination_hash: string; state: string }>(
    'SELECT id,destination_hash,state FROM axterm_terminal_stages',
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('failed');
  expect(next.get(rows[0]!.id)).toBeDefined();
  expect(other.get(rows[0]!.id)).toBeUndefined();
  expect(other.list(rows[0]!.destination_hash)).toEqual([]);
  expect(await readdir(f.target)).toEqual([]);
});
it('rejects foreign directory selection and replaced private-root identity before recovery deletion', async () => {
  const f = await fixture(),
    stage = await f.staging.prepare(f.grant.grantId, 'download', 'xmodem', f.signal);
  await writeFile(join(stage.path, 'partial.part'), 'PENDING');
  await stage.close();
  const records = await f.staging.review(f.grant.grantId, f.signal),
    id = records[0]!.id;
  const other = join(f.directory, 'other');
  await mkdir(other);
  const otherGrant = await f.registry.createTrustedPath(other, 'directory', ['read', 'write']);
  await expect(f.staging.remove(id, otherGrant.grantId, f.signal)).rejects.toThrow();
  await rename(stage.path, join(dirname(stage.path), 'retained-original'));
  await mkdir(stage.path);
  await writeFile(join(stage.path, 'unowned'), 'KEEP');
  await expect(f.staging.remove(id, f.grant.grantId, f.signal)).rejects.toThrow();
  expect(await readFile(join(stage.path, 'unowned'), 'utf8')).toBe('KEEP');
  expect(f.store.get(id)).toBeDefined();
});

it('marks a durably prepared old-generation receive as interrupted without filesystem activity', async () => {
  const f = await fixture(),
    authority = await f.registry.authorize(f.grant.grantId, 'write'),
    id = randomUUID();
  f.store.create({
    id,
    protocol: 'xmodem',
    name: 'Interrupted receive',
    destination_hash: f.store.destination(authority),
    device: '1',
    inode: '1',
  });
  const next = new TerminalStageStore(f.domain, 'desktop', randomUUID());
  expect(next.get(id)?.state).toBe('interrupted');
  expect(await readdir(f.target)).toEqual([]);
  await expect(readdir(f.base)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('expires private stage records without deleting bytes and requires explicit forget to remove metadata', async () => {
  const f = await fixture(),
    stage = await f.staging.prepare(f.grant.grantId, 'download', 'xmodem', f.signal);
  await writeFile(join(stage.path, 'partial'), 'RETAINED_PARTIAL');
  await stage.close();
  const id = (await f.staging.review(f.grant.grantId, f.signal))[0]!.id;
  f.domain.run(
    'UPDATE axterm_terminal_stages SET created_at=? WHERE id=?',
    Date.now() - 31 * 24 * 60 * 60 * 1000,
    id,
  );
  expect(await f.staging.review(f.grant.grantId, f.signal)).toMatchObject([
    { id, state: 'expired' },
  ]);
  await expect(f.staging.remove(id, f.grant.grantId, f.signal)).rejects.toThrow();
  expect(await readFile(join(stage.path, 'partial'), 'utf8')).toBe('RETAINED_PARTIAL');
  await f.staging.remove(id, f.grant.grantId, f.signal, true);
  expect(f.store.get(id)).toBeUndefined();
  expect(await readFile(join(stage.path, 'partial'), 'utf8')).toBe('RETAINED_PARTIAL');
});
it('never treats an absent stale private stage as authority to remove a published destination', async () => {
  const f = await fixture(),
    authority = await f.registry.authorize(f.grant.grantId, 'write'),
    id = randomUUID();
  f.store.create({
    id,
    protocol: 'zmodem',
    name: 'Published',
    destination_hash: f.store.destination(authority),
    device: '1',
    inode: '1',
  });
  await writeFile(join(f.target, 'published.bin'), 'KEEP_PUBLISHED');
  expect(await f.staging.review(f.grant.grantId, f.signal)).toMatchObject([
    { id, state: 'absent' },
  ]);
  await expect(f.staging.remove(id, f.grant.grantId, f.signal)).rejects.toThrow();
  expect(await readFile(join(f.target, 'published.bin'), 'utf8')).toBe('KEEP_PUBLISHED');
  await f.staging.remove(id, f.grant.grantId, f.signal, true);
  expect(f.store.get(id)).toBeUndefined();
  expect(await readFile(join(f.target, 'published.bin'), 'utf8')).toBe('KEEP_PUBLISHED');
});
it('enforces the tighter 64-record profile cap across independent store instances in one transaction owner', async () => {
  const f = await fixture(),
    authority = await f.registry.authorize(f.grant.grantId, 'write'),
    destination = f.store.destination(authority),
    second = new TerminalStageStore(f.domain, 'desktop', f.generation);
  for (let index = 0; index < 64; index++)
    (index % 2 ? second : f.store).create({
      id: randomUUID(),
      protocol: 'trzsz',
      name: 'Interrupted',
      destination_hash: destination,
      device: '1',
      inode: '1',
    });
  for (const store of [f.store, second])
    expect(() =>
      store.create({
        id: randomUUID(),
        protocol: 'trzsz',
        name: 'Overflow',
        destination_hash: destination,
        device: '1',
        inode: '1',
      }),
    ).toThrow('CAPACITY');
  expect(second.list(destination)).toHaveLength(64);
  expect(await readdir(f.target)).toEqual([]);
});
it.skipIf(process.platform === 'win32')(
  'rejects hard-linked or symlinked private contents without deleting aliases or source bytes',
  async () => {
    const f = await fixture(),
      stage = await f.staging.prepare(f.grant.grantId, 'download', 'xmodem', f.signal),
      source = join(f.target, 'unowned.bin'),
      alias = join(stage.path, 'alias.bin');
    await writeFile(source, 'KEEP_UNOWNED');
    await stage.close();
    const id = (await f.staging.review(f.grant.grantId, f.signal))[0]!.id;
    for (const kind of ['hard', 'symbolic']) {
      if (kind === 'hard') await link(source, alias);
      else await symlink(source, alias);
      expect(await f.staging.review(f.grant.grantId, f.signal)).toMatchObject([
        { id, state: 'unverified' },
      ]);
      await expect(f.staging.remove(id, f.grant.grantId, f.signal)).rejects.toThrow();
      expect(await readFile(source, 'utf8')).toBe('KEEP_UNOWNED');
      expect(await readFile(alias, 'utf8')).toBe('KEEP_UNOWNED');
      await unlink(alias);
    }
  },
);

import { XmodemSession } from '../../packages/plugins/terminals/src/adapters/terminal-transfer/xmodem.ts';
import { ZmodemReceiveFile } from '../../packages/plugins/terminals/src/adapters/terminal-transfer/zmodem.ts';
import { StagedTrzszWriter } from '../../packages/plugins/terminals/src/adapters/terminal-transfer/trzsz.ts';
function partialFrame(): Buffer {
  const payload = Buffer.alloc(128, 0x1a);
  Buffer.from('partial').copy(payload);
  let crc = 0;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  const frame = Buffer.alloc(133);
  frame.set([1, 1, 0xfe]);
  payload.copy(frame, 3);
  frame.writeUInt16BE(crc, 131);
  return frame;
}
it.each(['xmodem', 'zmodem', 'trzsz'] as const)(
  'persists private %s ownership before protocol bytes and releases only after actual cleanup or publication',
  async (protocol) => {
    const f = await fixture(),
      stage = await f.staging.prepare(f.grant.grantId, 'download', protocol, f.signal);
    const record = (await f.staging.review(f.grant.grantId, f.signal))[0]!;
    expect(f.store.get(record.id)?.state).toBe('receiving');
    expect(await readdir(stage.path)).toEqual([]);
    if (protocol === 'xmodem') {
      const engine = new XmodemSession({ write: () => {} }, { s: () => {} });
      engine.startReceive();
      engine.setSavePath(stage.path, 'x.bin');
      engine.handleData(partialFrame());
      expect((await f.staging.review(f.grant.grantId, f.signal))[0]?.bytes).toBeGreaterThan(0);
      engine.cancel();
      engine.destroy();
    } else if (protocol === 'zmodem') {
      const engine = new ZmodemReceiveFile(join(stage.path, 'z.bin'), 'z.bin', 7);
      await engine.write(Buffer.from('partial'));
      await engine.commit();
      expect((await f.staging.review(f.grant.grantId, f.signal))[0]?.bytes).toBe(7);
      await stage.publish();
    } else {
      const engine = new StagedTrzszWriter(join(stage.path, 't.bin'), 't.bin');
      await engine.writeFile(Buffer.from('partial'));
      expect((await f.staging.review(f.grant.grantId, f.signal))[0]?.bytes).toBe(7);
      await engine.deleteFile();
    }
    await stage.close();
    expect(f.staging.resourceCount()).toBe(0);
    if (protocol === 'zmodem') {
      expect(f.store.get(record.id)).toBeUndefined();
      expect(await readFile(join(f.target, 'z.bin'), 'utf8')).toBe('partial');
    } else {
      expect(f.store.get(record.id)?.state).toBe('failed');
      const fresh = await f.registry.createTrustedPath(f.target, 'directory', ['read', 'write']);
      await f.staging.remove(record.id, fresh.grantId, f.signal);
      expect(f.store.get(record.id)).toBeUndefined();
      expect(await readdir(f.target)).toEqual([]);
    }
  },
);
it('retains all three private protocol records after denied inner cleanup until explicit fresh-grant removal', async () => {
  const f = await fixture();
  const denial = () => {
    throw Object.assign(new Error('Fixture cleanup refusal'), { code: 'EACCES' });
  };
  for (const protocol of ['xmodem', 'zmodem', 'trzsz'] as const) {
    const stage = await f.staging.prepare(f.grant.grantId, 'download', protocol, f.signal);
    if (protocol === 'xmodem') {
      const engine = new XmodemSession(
        { write: () => {} },
        { s: () => {} },
        undefined,
        undefined,
        undefined,
        denial,
      );
      engine.startReceive();
      engine.setSavePath(stage.path, 'x.bin');
      engine.handleData(partialFrame());
      engine.cancel();
      engine.destroy();
    } else if (protocol === 'zmodem') {
      const engine = new ZmodemReceiveFile(
        join(stage.path, 'z.bin'),
        'z.bin',
        7,
        undefined,
        async () => denial(),
      );
      await engine.write(Buffer.from('partial'));
      await expect(engine.cleanup()).rejects.toMatchObject({ code: 'EACCES' });
    } else {
      const engine = new StagedTrzszWriter(
        join(stage.path, 't.bin'),
        't.bin',
        undefined,
        async () => denial(),
      );
      await engine.writeFile(Buffer.from('partial'));
      await expect(engine.deleteFile()).rejects.toMatchObject({ code: 'EACCES' });
    }
    await stage.close();
  }
  const records = await f.staging.review(f.grant.grantId, f.signal);
  expect(records).toHaveLength(3);
  expect(records.every((r) => r.state === 'verified' && r.bytes > 0)).toBe(true);
  expect(await readdir(f.target)).toEqual([]);
  const fresh = await f.registry.createTrustedPath(f.target, 'directory', ['read', 'write']);
  for (const record of records) await f.staging.remove(record.id, fresh.grantId, f.signal);
  expect(await f.staging.review(fresh.grantId, f.signal)).toEqual([]);
  expect(await readdir(f.base)).toEqual([]);
});

it('retains the first concrete protocol filename for fresh-grant recovery without persisting private paths', async () => {
  const f = await fixture();
  const stage = await f.staging.prepare(f.grant.grantId, 'download', 'trzsz', f.signal);
  stage.recordName?.('source.bin');
  stage.recordName?.('later.bin');
  await writeFile(join(stage.path, '.received.part'), 'PARTIAL_BYTES');
  await stage.close();
  const records = await f.staging.review(f.grant.grantId, f.signal);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ name: 'source.bin', state: 'verified', bytes: 13 });
  const next = new TerminalStageStore(f.domain, 'desktop', randomUUID());
  expect(next.get(records[0]!.id)).toMatchObject({ name: 'source.bin' });
  expect(JSON.stringify(next.get(records[0]!.id))).not.toContain(stage.path);
  await f.staging.remove(records[0]!.id, f.grant.grantId, f.signal);
  expect(await readdir(f.base)).toEqual([]);
});
