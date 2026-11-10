/** Chromium cancels an in-flight document load when a refresh replaces it. */
export function reportWorkspaceLoadFailure(error: unknown, report: () => void): void {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_ABORTED' &&
    'errno' in error &&
    error.errno === -3
  )
    return;
  report();
}
