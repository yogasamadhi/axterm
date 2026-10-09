import { describe, expect, it } from 'vitest';
import { resolveTerminalProfileId } from '../../apps/desktop/src/renderer/src/app/terminal-profile-selection';

const profiles = [{ id: 'explicit' }, { id: 'bookmark' }, { id: 'global' }];

describe('terminal profile selection', () => {
  it('uses explicit, bookmark, global and platform defaults in order', () => {
    expect(resolveTerminalProfileId(profiles, 'explicit', 'bookmark', 'global')).toBe('explicit');
    expect(resolveTerminalProfileId(profiles, undefined, 'bookmark', 'global')).toBe('bookmark');
    expect(resolveTerminalProfileId(profiles, undefined, undefined, 'global')).toBe('global');
    expect(resolveTerminalProfileId(profiles, undefined, null, undefined)).toBeUndefined();
  });

  it('skips dangling references after profiles load', () => {
    expect(resolveTerminalProfileId(profiles, 'deleted', 'bookmark', 'global')).toBe('bookmark');
    expect(resolveTerminalProfileId([], undefined, undefined, 'deleted')).toBeUndefined();
  });

  it('preserves a persisted reference while the profile collection is loading', () => {
    expect(resolveTerminalProfileId(undefined, undefined, undefined, 'global')).toBe('global');
  });
});
