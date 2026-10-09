import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  linkSync,
  symlinkSync,
  unlinkSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { OwnedStageJournal } from './owned-stage-journal';
import { DatabaseSync } from 'node:sqlite';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'axterm-owned-stage-'));
  temporary.push(root);
  const directory = join(root, 'downloads');
  const other = join(root, 'other');
  mkdirSync(directory);
  mkdirSync(other);
  const journal = new OwnedStageJournal(join(root, 'private'));
  return { root, directory, other, journal };
}

function stage(journal: OwnedStageJournal, directory: string, name = '.axterm-test.part') {
  const id = journal.prepare(directory, name, 'payload.bin', 'xmodem');
  const path = join(directory, name);
  const descriptor = openSync(path, 'wx', 0o600);
  writeSync(descriptor, Buffer.from('partial data'));
  journal.seal(id, descriptor);
  closeSync(descriptor);
  return { id, path };
}

describe('OwnedStageJournal', () => {
  it('opens a newly created store and rejects a second hard link to that store', () => {
    const { root, journal } = fixture();
    journal.close();
    const path = join(root, 'private', 'terminal-stage-ownership.sqlite');
    linkSync(path, join(root, 'store-link.sqlite'));
    expect(() => new OwnedStageJournal(join(root, 'private'))).toThrow(
      'not a private regular file',
    );
  });

  it.skipIf(process.platform === 'win32')('rejects POSIX group-readable stores', () => {
    const { root, journal } = fixture();
    journal.close();
    chmodSync(join(root, 'private', 'terminal-stage-ownership.sqlite'), 0o640);
    expect(() => new OwnedStageJournal(join(root, 'private'))).toThrow(
      'not a private regular file',
    );
  });

  it('commits ownership before stage creation and keeps a prepared-only record unverified', () => {
    const { directory, journal } = fixture();
    const id = journal.prepare(directory, '.axterm-a.part', 'payload.bin', 'zmodem');
    expect(journal.review(directory)).toMatchObject([{ id, state: 'absent' }]);
    const descriptor = openSync(join(directory, '.axterm-a.part'), 'wx', 0o600);
    closeSync(descriptor);
    expect(journal.review(directory)).toMatchObject([{ id, state: 'unverified' }]);
    expect(() => journal.removeVerified(id, directory)).toThrow();
    journal.close();
  });

  it('survives restart but only reviews a reselected matching directory', () => {
    const { root, directory, other, journal } = fixture();
    const { id, path } = stage(journal, directory);
    journal.close();
    const reopened = new OwnedStageJournal(join(root, 'private'));
    expect(reopened.review(other)).toEqual([]);
    expect(() => reopened.removeVerified(id, other)).toThrow();
    expect(reopened.review(directory)).toMatchObject([
      { id, name: 'payload.bin', protocol: 'xmodem', bytes: 12, state: 'verified' },
    ]);
    expect(readFileSync(path, 'utf8')).toBe('partial data');
    reopened.removeVerified(id, directory);
    expect(existsSync(path)).toBe(false);
    expect(reopened.review(directory)).toEqual([]);
    reopened.close();
  });

  it('refuses a replaced inode, symlink, or multiple hard links without deleting data', () => {
    const { directory, journal } = fixture();
    const first = stage(journal, directory, '.axterm-first.part');
    unlinkSync(first.path);
    const replacement = openSync(first.path, 'wx', 0o600);
    closeSync(replacement);
    expect(() => journal.removeVerified(first.id, directory)).toThrow();
    expect(existsSync(first.path)).toBe(true);
    const second = stage(journal, directory, '.axterm-second.part');
    linkSync(second.path, join(directory, 'another-link'));
    expect(() => journal.removeVerified(second.id, directory)).toThrow();
    expect(existsSync(second.path)).toBe(true);
    const third = stage(journal, directory, '.axterm-third.part');
    unlinkSync(third.path);
    symlinkSync(first.path, third.path);
    expect(() => journal.removeVerified(third.id, directory)).toThrow();
    expect(existsSync(third.path)).toBe(true);
    journal.close();
  });

  it('forgets only the record, and clears a normally removed stage only after absence', () => {
    const { directory, journal } = fixture();
    const first = stage(journal, directory, '.axterm-first.part');
    journal.clearIfAbsent(first.id, directory);
    expect(journal.review(directory)).toHaveLength(1);
    journal.forget(first.id);
    expect(existsSync(first.path)).toBe(true);
    expect(journal.review(directory)).toEqual([]);
    const second = stage(journal, directory, '.axterm-second.part');
    unlinkSync(second.path);
    journal.clearIfAbsent(second.id, directory);
    expect(journal.review(directory)).toEqual([]);
    journal.close();
  });

  it('rejects unsafe names and does not store a destination path in private SQLite', () => {
    const { root, directory, journal } = fixture();
    expect(() => journal.prepare(directory, '../escape.part', 'payload.bin', 'trzsz')).toThrow();
    expect(() => journal.prepare(directory, '.axterm-safe.part', '../escape', 'trzsz')).toThrow();
    stage(journal, directory);
    journal.close();
    const bytes = readFileSync(join(root, 'private', 'terminal-stage-ownership.sqlite'));
    expect(bytes.includes(Buffer.from(directory))).toBe(false);
  });

  it('never treats a post-publication stale record as permission to delete the final file', () => {
    const { root, directory, journal } = fixture();
    const { id, path } = stage(journal, directory);
    const finalPath = join(directory, 'payload.bin');
    linkSync(path, finalPath);
    unlinkSync(path);
    journal.close();
    const reopened = new OwnedStageJournal(join(root, 'private'));
    expect(reopened.review(directory)).toMatchObject([{ id, state: 'absent' }]);
    expect(() => reopened.removeVerified(id, directory)).toThrow();
    expect(readFileSync(finalPath, 'utf8')).toBe('partial data');
    reopened.clearIfAbsent(id, directory);
    expect(reopened.review(directory)).toEqual([]);
    reopened.close();
  });

  it('expires records after 30 days without deleting their files', () => {
    const { root, directory, journal } = fixture();
    const { id, path } = stage(journal, directory);
    journal.close();
    const db = new DatabaseSync(join(root, 'private', 'terminal-stage-ownership.sqlite'));
    db.prepare('UPDATE owned_stage SET created_at = ? WHERE id = ?').run(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
      id,
    );
    db.close();
    const reopened = new OwnedStageJournal(join(root, 'private'));
    expect(reopened.review(directory)).toMatchObject([{ id, state: 'expired' }]);
    expect(() => reopened.removeVerified(id, directory)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('partial data');
    reopened.close();
  });

  it('rejects an unsafe pre-existing ownership-store symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'axterm-owned-stage-store-'));
    temporary.push(root);
    const privateDirectory = join(root, 'private');
    mkdirSync(privateDirectory);
    const destination = join(root, 'untrusted');
    const descriptor = openSync(destination, 'wx', 0o600);
    closeSync(descriptor);
    symlinkSync(destination, join(privateDirectory, 'terminal-stage-ownership.sqlite'));
    expect(() => new OwnedStageJournal(privateDirectory)).toThrow('not a private regular file');
    expect(readFileSync(destination)).toHaveLength(0);
  });

  it('enforces the 4096-record cap across two Runtime instances', () => {
    const { root, directory, journal } = fixture();
    const second = new OwnedStageJournal(join(root, 'private'));
    for (let index = 0; index < 4_096; index++)
      (index % 2 === 0 ? journal : second).prepare(
        directory,
        `.axterm-${index}.part`,
        'payload.bin',
        'zmodem',
      );
    expect(() =>
      journal.prepare(directory, '.axterm-overflow.part', 'payload.bin', 'zmodem'),
    ).toThrow('journal is full');
    expect(second.review(directory)).toHaveLength(4_096);
    second.close();
    journal.close();
  });
});
