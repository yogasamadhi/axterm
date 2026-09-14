import {
  DEFAULT_TERMINAL_BEHAVIOR,
  type TerminalBehavior,
  type TerminalProfile,
} from '@workspace/contracts';

export function resolveTerminalBehavior(
  behavior?: Partial<TerminalBehavior> | undefined,
): TerminalBehavior {
  return { ...DEFAULT_TERMINAL_BEHAVIOR, ...behavior };
}

export function terminalBehaviorFromProfile(
  profile?: TerminalProfile | undefined,
): TerminalBehavior {
  if (!profile) return resolveTerminalBehavior();
  return resolveTerminalBehavior({
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
  });
}
