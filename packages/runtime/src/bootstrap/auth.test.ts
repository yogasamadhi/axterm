import { describe, expect, it } from 'vitest';
import { RuntimeAuth } from './auth';

describe('generation authentication', () => {
  it('consumes and rotates a bootstrap token, revokes prior sessions on reattachment', () => {
    const auth = new RuntimeAuth();
    const first = auth.currentBootstrap();
    const session = auth.exchange(first);
    expect(session).toBeTruthy();
    expect(auth.currentBootstrap()).not.toBe(first);
    expect(auth.exchange(first)).toBeUndefined();
    expect(auth.authorize(`Bearer ${session}`)).toBe(true);
    auth.exchange(auth.currentBootstrap());
    expect(auth.authorize(`Bearer ${session}`)).toBe(false);
    auth.dispose();
    expect(auth.exchange(auth.currentBootstrap())).toBeUndefined();
  });
  it('expires discovery tickets and rate limits without unbounded per-client maps', () => {
    let now = 0;
    const auth = new RuntimeAuth(() => now);
    const expired = auth.currentBootstrap();
    now = 30_000;
    expect(auth.exchange(expired)).toBeUndefined();
    for (let i = 0; i < 20; i++) expect(auth.allowAttempt()).toBe(true);
    expect(auth.allowAttempt()).toBe(false);
    now = 60_000;
    expect(auth.allowAttempt()).toBe(true);
    auth.rotateBootstrap();
    expect(auth.exchange(auth.currentBootstrap())).toBeTruthy();
    auth.dispose();
  });
  it('rejects another generation and malformed authorization', () => {
    const first = new RuntimeAuth();
    const second = new RuntimeAuth();
    const token = first.exchange(first.currentBootstrap());
    for (const header of [undefined, '', `Basic ${token}`, `Bearer ${token}`])
      expect(second.authorize(header)).toBe(false);
    expect(first.authorize(`Bearer ${token} `)).toBe(false);
    first.dispose();
    second.dispose();
  });
});
