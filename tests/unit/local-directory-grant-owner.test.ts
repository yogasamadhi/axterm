import { describe, expect, it, vi } from 'vitest';
import type { FileGrant } from '../../packages/contracts/src/host-capabilities/desktop';
import { LocalDirectoryGrantOwner } from '../../apps/desktop/src/renderer/src/app/files/local-directory-grant-owner';

const grant = (id: string): FileGrant => ({
  grantId: id,
  kind: 'directory',
  name: 'owned fixture',
  permissions: ['read', 'write'],
  createdAt: '2026-10-03T00:00:00.000Z',
});

describe('owned local directory selection', () => {
  it('retains only the most recent selection and releases a superseded late home grant', async () => {
    const revokeFileGrant = vi.fn(async (_id: string) => {});
    const owner = new LocalDirectoryGrantOwner({ revokeFileGrant });
    const home = owner.beginSelection();
    const picked = owner.beginSelection();
    expect(await owner.adopt(picked, grant('picked'))).toBe(true);
    expect(await owner.adopt(home, grant('late-home'))).toBe(false);
    expect(owner.current()?.grantId).toBe('picked');
    expect(revokeFileGrant).toHaveBeenCalledExactlyOnceWith('late-home');
    await owner.dispose();
    expect(revokeFileGrant).toHaveBeenLastCalledWith('picked');
  });
  it('releases the current and late native selection on disposal without reviving a scope', async () => {
    const revokeFileGrant = vi.fn(async (_id: string) => {});
    const owner = new LocalDirectoryGrantOwner({ revokeFileGrant }, grant('initial'));
    const pending = owner.beginSelection();
    await owner.dispose();
    await owner.dispose();
    expect(await owner.adopt(pending, grant('late-picker'))).toBe(false);
    expect(owner.current()).toBeUndefined();
    expect(revokeFileGrant.mock.calls.map(([id]) => id)).toEqual(['initial', 'late-picker']);
  });
  it('does not publish an older selection after replacement cleanup resolves late', async () => {
    let finish!: () => void;
    const client = {
      revokeFileGrant: vi.fn((id: string) =>
        id === 'initial'
          ? new Promise<void>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(),
      ),
    };
    const owner = new LocalDirectoryGrantOwner(client, grant('initial'));
    const old = owner.adopt(owner.beginSelection(), grant('old'));
    expect(await owner.adopt(owner.beginSelection(), grant('new'))).toBe(true);
    finish();
    expect(await old).toBe(false);
    expect(owner.current()?.grantId).toBe('new');
    await owner.dispose();
    expect(client.revokeFileGrant.mock.calls.map(([id]) => id)).toEqual(['initial', 'old', 'new']);
  });
  it('keeps a currently owned identity when a stale response repeats it, including rejected revocations', async () => {
    const revokeFileGrant = vi.fn(async (_id: string) => {
      throw new Error('fixture grant already expired');
    });
    const owner = new LocalDirectoryGrantOwner({ revokeFileGrant });
    const stale = owner.beginSelection();
    const current = owner.beginSelection();
    expect(await owner.adopt(current, grant('same'))).toBe(true);
    expect(await owner.adopt(stale, grant('same'))).toBe(false);
    expect(revokeFileGrant).not.toHaveBeenCalled();
    await owner.dispose();
    expect(revokeFileGrant).toHaveBeenCalledExactlyOnceWith('same');
  });
});
