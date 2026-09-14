import type { TerminalProfile } from '@workspace/contracts';

type ProfileReference = string | null | undefined;

/**
 * Resolves a profile using the same order for local, bookmarked and ad-hoc
 * sessions. An undefined collection means profiles are still loading, so a
 * persisted reference is preserved until it can be checked. Once loaded,
 * dangling references fall through to the next candidate or platform defaults.
 */
export function resolveTerminalProfileId(
  profiles: readonly Pick<TerminalProfile, 'id'>[] | undefined,
  ...candidates: readonly ProfileReference[]
): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!profiles || profiles.some((profile) => profile.id === candidate)) return candidate;
  }
  return undefined;
}
