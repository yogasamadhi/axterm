import { describe, expect, it, vi } from 'vitest';
import type { AiAttachmentPreview } from '../../packages/contracts/src';
import { AttachmentDraftOwner } from '../../apps/desktop/src/renderer/src/app/ai/attachment-draft-owner';

const preview = (id: string, size = 10): AiAttachmentPreview => ({
  id,
  name: `${id}.txt`,
  size,
  includedBytes: Math.min(size, 50 * 1024),
  truncated: size > 50 * 1024,
  redacted: false,
  preview: 'bounded preview',
  expiresAt: '2026-10-03T01:00:00.000Z',
});
function fixture() {
  const discardAiAttachment = vi.fn(async (_id: string) => {});
  const owner = new AttachmentDraftOwner({ discardAiAttachment });
  return { owner, discardAiAttachment };
}

describe('composer attachment lifetime', () => {
  it('locks a native/import operation synchronously and releases late previews after disposal', async () => {
    const f = fixture(),
      operation = f.owner.begin()!;
    expect(f.owner.begin()).toBeUndefined();
    await f.owner.dispose();
    expect(operation.signal.aborted).toBe(true);
    expect(f.owner.begin()).toBeUndefined();
    expect(await f.owner.admit(operation, preview('late'))).toBe('stale');
    expect(f.owner.finish(operation)).toBe(false);
    expect(f.owner.list()).toEqual([]);
    expect(f.discardAiAttachment).toHaveBeenCalledExactlyOnceWith('late');
  });
  it('cancels preparation without dropping an already accepted draft or reviving a late result', async () => {
    const f = fixture(),
      operation = f.owner.begin()!;
    expect(await f.owner.admit(operation, preview('keep'))).toBe('accepted');
    f.owner.cancel();
    const replacement = f.owner.begin()!;
    expect(replacement).not.toBe(operation);
    expect(await f.owner.admit(operation, preview('late'))).toBe('stale');
    expect(f.owner.finish(operation)).toBe(false);
    expect(f.owner.finish(replacement)).toBe(true);
    expect(f.owner.list().map((x) => x.id)).toEqual(['keep']);
    await f.owner.dispose();
    expect(f.discardAiAttachment.mock.calls.map(([id]) => id)).toEqual(['late', 'keep']);
  });
  it('bounds the draft count and rejects duplicate file metadata', async () => {
    const f = fixture(),
      operation = f.owner.begin()!;
    await f.owner.admit(operation, preview('first'));
    expect(await f.owner.admit(operation, { ...preview('duplicate'), name: 'first.txt' })).toBe(
      'duplicate',
    );
    for (let i = 1; i < 8; i++)
      expect(await f.owner.admit(operation, preview(`item${i}`))).toBe('accepted');
    expect(await f.owner.admit(operation, preview('ninth'))).toBe('limit');
    const snapshot = f.owner.list();
    snapshot.pop();
    expect(f.owner.list()).toHaveLength(8);
    await f.owner.dispose();
    expect(f.discardAiAttachment).toHaveBeenCalledTimes(10);
  });
  it('enforces the existing 100 KiB total and removes only the submitted Runtime IDs', async () => {
    const f = fixture(),
      operation = f.owner.begin()!;
    await f.owner.admit(operation, preview('one', 50 * 1024));
    await f.owner.admit(operation, preview('two', 50 * 1024));
    expect(await f.owner.admit(operation, preview('overflow', 1))).toBe('limit');
    f.owner.consume(['one']);
    expect(f.owner.list().map((x) => x.id)).toEqual(['two']);
    await f.owner.remove('two');
    await f.owner.remove('two');
    await f.owner.dispose();
    expect(f.discardAiAttachment.mock.calls.map(([id]) => id)).toEqual(['overflow', 'two']);
  });
  it('invalidates an old operation immediately on reset and permits a fresh composer operation', async () => {
    let release!: () => void;
    const discardAiAttachment = vi.fn(
      (_id: string) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const owner = new AttachmentDraftOwner({ discardAiAttachment });
    const old = owner.begin()!;
    await owner.admit(old, preview('old'));
    const clearing = owner.clear();
    expect(old.signal.aborted).toBe(true);
    expect(owner.list()).toEqual([]);
    const fresh = owner.begin()!;
    await owner.admit(fresh, preview('fresh'));
    release();
    await clearing;
    expect(owner.list().map((x) => x.id)).toEqual(['fresh']);
    const disposing = owner.dispose();
    release();
    await disposing;
  });
  it('completes local cleanup even when an expired Runtime preview rejects discard', async () => {
    const discardAiAttachment = vi.fn(async (_id: string) => {
      throw new Error('expired');
    });
    const owner = new AttachmentDraftOwner({ discardAiAttachment });
    await owner.admit(owner.begin()!, preview('expired'));
    await owner.dispose();
    await owner.dispose();
    expect(owner.list()).toEqual([]);
    expect(discardAiAttachment).toHaveBeenCalledExactlyOnceWith('expired');
  });
});
