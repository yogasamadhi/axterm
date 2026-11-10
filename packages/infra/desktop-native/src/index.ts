export * from './protocol.ts';
export * from './bridge.ts';
export * from './vault.ts';
export * from './grants.ts';
export * from './file-capabilities.ts';
export {
  desktopWindowBoundsSchema,
  desktopWindowPreferencesSchema,
  desktopWindowPreferenceRecordSchema,
  nativeDesktopWindowStateSchema,
  DEFAULT_DESKTOP_WINDOW_PREFERENCES,
} from '@axterm/plugin-api/desktop';
export type {
  DesktopWindowBounds,
  DesktopWindowPreferenceRecord,
  DesktopWindowPreferences,
  NativeDesktopWindowState,
  NativeDesktopWindows,
} from '@axterm/plugin-api/desktop';

/** Strict, platform-neutral native view DTOs; no application service is exposed to the shell. */
export {
  nativeWebViewActionSchema,
  nativeWebViewAuthResponseSchema,
  nativeWebViewCreateSchema,
  nativeWebViewPresentationSchema,
  nativeWebViewStateSchema,
  nativeWebUrlSchema,
} from '@axterm/plugin-api/remote-desktop';
export type {
  NativeWebViewAction,
  NativeWebViewAuthResponse,
  NativeWebViewCreate,
  NativeWebViewPresentation,
  NativeWebViewState,
  NativeWebViews,
} from '@axterm/plugin-api/remote-desktop';

export {
  signedUpdateManifestSchema,
  semverVersionSchema,
  updaterStatusSchema,
  updaterActionSchema,
} from '@axterm/plugin-api/desktop';
export type {
  SignedUpdateManifest,
  UpdaterStatus,
  UpdaterAction,
  DesktopUpdaterPort,
} from '@axterm/plugin-api/desktop';

export { desktopLifecycleStateSchema } from '@axterm/plugin-api/desktop';
export type { DesktopLifecycleState, NativeDesktopLifecycle } from '@axterm/plugin-api/desktop';
