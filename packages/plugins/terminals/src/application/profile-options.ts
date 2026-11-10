import type { TerminalProfile } from '@axterm/plugin-api/terminals';
export function optionsForProfile(profile: TerminalProfile) {
  return {
    ...(profile.shell ? { shell: profile.shell } : {}),
    shellArgs: profile.shellArgs,
    ...(profile.cwd ? { cwd: profile.cwd } : {}),
    env: { ...profile.env, ...(profile.lang ? { LANG: profile.lang } : {}) },
    term: profile.term,
    loginShell: profile.loginShell,
    appearance: {
      fontFamily: profile.fontFamily,
      fontSize: profile.fontSize,
      lineHeight: profile.lineHeight,
      cursorStyle: profile.cursorStyle,
      cursorBlink: profile.cursorBlink,
    },
    behavior: {
      scrollback: profile.scrollback,
      rendererPreference: profile.rendererPreference,
      unicodeVersion: profile.unicodeVersion,
      ligaturesEnabled: profile.ligaturesEnabled,
      imageSequencesEnabled: profile.imageSequencesEnabled,
      wordSeparator: profile.wordSeparator,
      backspaceMode: profile.backspaceMode,
      shiftEnterMode: profile.shiftEnterMode,
      encoding: profile.encoding,
      displayRaw: profile.displayRaw,
      logTimestamps: profile.logTimestamps,
      pasteProtection: profile.pasteProtection,
      osc52Enabled: profile.osc52Enabled,
      osc52ReadPolicy: profile.osc52ReadPolicy,
      osc52WritePolicy: profile.osc52WritePolicy,
    },
  };
}

/** Same precedence for every admission; an unloaded collection preserves the requested reference. */
export function resolveTerminalProfileId(
  profiles: readonly Pick<TerminalProfile, 'id'>[] | undefined,
  ...candidates: readonly (string | null | undefined)[]
): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!profiles || profiles.some((profile) => profile.id === candidate)) return candidate;
  }
  return undefined;
}
