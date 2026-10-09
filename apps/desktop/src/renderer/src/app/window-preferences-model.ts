import type {
  DesktopWindowPreferences,
  DesktopWindowPreferencesPatch,
} from '@workspace/contracts/desktop';

export interface WindowPreferencesDraft {
  titleBarStyle: 'custom' | 'system';
  opacity: string;
  zoomFactor: string;
  allowMultiInstance: boolean;
  confirmBeforeExit: boolean;
}

export type WindowPreferencesDraftResult =
  | { ok: true; value: DesktopWindowPreferencesPatch }
  | {
      ok: false;
      code: 'invalidTitleBarStyle' | 'invalidOpacity' | 'invalidZoomFactor';
    };

export function toWindowPreferencesDraft(
  preferences: DesktopWindowPreferences,
): WindowPreferencesDraft {
  return {
    titleBarStyle: preferences.titleBarStyle,
    opacity: String(preferences.opacity),
    zoomFactor: String(preferences.zoomFactor),
    allowMultiInstance: preferences.allowMultiInstance,
    confirmBeforeExit: preferences.confirmBeforeExit,
  };
}

export function parseWindowPreferencesDraft(
  draft: WindowPreferencesDraft,
): WindowPreferencesDraftResult {
  if (draft.titleBarStyle !== 'custom' && draft.titleBarStyle !== 'system')
    return { ok: false, code: 'invalidTitleBarStyle' };
  const opacity = Number(draft.opacity);
  if (!draft.opacity.trim() || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    return { ok: false, code: 'invalidOpacity' };
  const zoomFactor = Number(draft.zoomFactor);
  if (
    !draft.zoomFactor.trim() ||
    !Number.isFinite(zoomFactor) ||
    zoomFactor < 0.5 ||
    zoomFactor > 8
  )
    return { ok: false, code: 'invalidZoomFactor' };
  return {
    ok: true,
    value: {
      titleBarStyle: draft.titleBarStyle,
      opacity,
      zoomFactor,
      allowMultiInstance: draft.allowMultiInstance,
      confirmBeforeExit: draft.confirmBeforeExit,
    },
  };
}
